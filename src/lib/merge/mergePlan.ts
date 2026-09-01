/**
 * Pure planning logic for merging multiple videos into one output.
 *
 * Kept free of media APIs so it can be unit-tested in Node without WebCodecs.
 */

export interface MergeClipInfo {
	/** Absolute path of the source file (already approved by the main process). */
	path: string;
	/** Base file name, for display. */
	name: string;
	/** File size in bytes. */
	byteSize: number;
	/** Duration of the clip in seconds. */
	duration: number;
	/** Display width in pixels (rotation applied). */
	width: number;
	/** Display height in pixels (rotation applied). */
	height: number;
	/** Codec of the primary video track, e.g. "avc", or null if unknown. */
	codec: string | null;
	/** Full codec parameter string, e.g. "avc1.640033", or null if unknown. */
	codecParameterString: string | null;
	/** Hex-ish fingerprint of the video decoder config description bytes (SPS/PPS for AVC). */
	decoderDescriptionId: string | null;
	/** Whether the clip has a usable primary audio track. */
	hasAudio: boolean;
	/** Total number of audio tracks (macOS recordings carry system + mic as two). */
	audioTrackCount: number;
	/** Codec of the primary audio track, e.g. "aac", or null. */
	audioCodec: string | null;
	/** Audio sample rate in Hz, or null when the clip has no audio. */
	audioSampleRate: number | null;
	/** Audio channel count, or null when the clip has no audio. */
	audioChannels: number | null;
}

export interface MergeAudioFormat {
	numberOfChannels: number;
	sampleRate: number;
}

export interface MergePlan {
	/** Output width in pixels (always even). */
	width: number;
	/** Output height in pixels (always even). */
	height: number;
	/** Output start timestamp of each clip (same order as clips). */
	offsets: number[];
	/** Total output duration in seconds. */
	totalDuration: number;
	/** Unified audio format, or null when no clip has audio. */
	audio: MergeAudioFormat | null;
}

/** Rounds a dimension down to the nearest even number (H.264 requires macroblock-aligned sizes). */
export function toEvenDimension(value: number): number {
	const rounded = Math.floor(value);
	return rounded - (rounded % 2);
}

/**
 * Chooses the output canvas: the largest width and the largest height across
 * all clips (independently), rounded down to even numbers. Every clip is then
 * scaled with "contain" fit, so no clip is ever cropped — smaller or narrower
 * clips are letterboxed instead.
 */
export function computeOutputDimensions(clips: MergeClipInfo[]): { width: number; height: number } {
	let maxWidth = 0;
	let maxHeight = 0;
	for (const clip of clips) {
		maxWidth = Math.max(maxWidth, clip.width);
		maxHeight = Math.max(maxHeight, clip.height);
	}
	return { width: toEvenDimension(maxWidth), height: toEvenDimension(maxHeight) };
}

/**
 * Picks the unified audio format. When all audio-bearing clips already agree on
 * channel count and sample rate, that format is kept as-is; otherwise the clips
 * are normalized to stereo 48 kHz (the most broadly supported combo for AAC).
 */
export function planAudioFormat(clips: MergeClipInfo[]): MergeAudioFormat | null {
	const withAudio = clips.filter((clip) => clip.hasAudio);
	if (withAudio.length === 0) return null;

	const first = withAudio[0];
	const allSame =
		withAudio.every(
			(clip) =>
				clip.audioChannels === first.audioChannels &&
				clip.audioSampleRate === first.audioSampleRate,
		) &&
		first.audioChannels !== null &&
		first.audioSampleRate !== null;

	if (allSame) {
		return {
			numberOfChannels: first.audioChannels as number,
			sampleRate: first.audioSampleRate as number,
		};
	}
	return { numberOfChannels: 2, sampleRate: 48000 };
}

/** Computes the full merge plan (output dimensions, per-clip offsets, audio format). */
export function computeMergePlan(clips: MergeClipInfo[]): MergePlan {
	const { width, height } = computeOutputDimensions(clips);
	const offsets: number[] = [];
	let cumulative = 0;
	for (const clip of clips) {
		offsets.push(cumulative);
		cumulative += clip.duration;
	}
	return {
		width,
		height,
		offsets,
		totalDuration: cumulative,
		audio: planAudioFormat(clips),
	};
}

/** Checks whether every clip's video stream is byte-for-byte compatible for a stream-copy merge. */
export function isRemuxCompatible(clips: MergeClipInfo[]): boolean {
	if (clips.length === 0) return false;
	const first = clips[0];
	if (!first.codec || !first.codecParameterString || !first.decoderDescriptionId) return false;

	// Stream copy requires identical codec, identical coded dimensions and an
	// identical decoder configuration (e.g. the same SPS/PPS bytes for AVC).
	// Anything else would produce a track whose sample description only matches
	// the first clip, corrupting playback for the others.
	const videoMatches = clips.every(
		(clip) =>
			clip.codec === first.codec &&
			clip.codecParameterString === first.codecParameterString &&
			clip.decoderDescriptionId === first.decoderDescriptionId &&
			clip.width === first.width &&
			clip.height === first.height,
	);
	if (!videoMatches) return false;

	// Audio must be either absent everywhere or consistently parameterized. A
	// clip with multiple audio tracks can never stream-copy: the audible track
	// is only reachable after mixing every track down to one.
	if (clips.some((clip) => clip.hasAudio)) {
		if (!clips.every((clip) => clip.hasAudio)) return false;
		if (clips.some((clip) => clip.audioTrackCount > 1)) return false;
		return clips.every(
			(clip) =>
				clip.audioCodec === first.audioCodec &&
				clip.audioCodec !== null &&
				clip.audioSampleRate === first.audioSampleRate &&
				clip.audioChannels === first.audioChannels,
		);
	}
	return true;
}
