import {
	ALL_FORMATS,
	type AudioEncodingConfig,
	AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	BlobSource,
	BufferTarget,
	EncodedAudioPacketSource,
	type EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	Mp4OutputFormat,
	Output,
	Quality,
	type VideoEncodingConfig,
	VideoSampleSink,
	VideoSampleSource,
} from "mediabunny";
import { type MixableAudioFrame, mixAudioTrackFrames } from "@/lib/audio/multiTrackMix";
import {
	computeMergePlan,
	isRemuxCompatible,
	type MergeClipInfo,
	type MergePlan,
} from "./mergePlan";

export type MergePhase = "reading" | "analyzing" | "merging" | "finalizing";
export type MergeMode = "remux" | "transcode";

export interface MergeProgress {
	phase: MergePhase;
	/** 0-based index of the clip currently being processed (merging phase). */
	clipIndex: number;
	clipCount: number;
	/** 0..1 progress within the current clip (merging phase). */
	clipProgress: number;
	/** 0..1 progress across the whole merge. */
	overallProgress: number;
	/** Chosen strategy, known once analyzing completes. */
	mode: MergeMode | null;
}

export interface MergeInputFile {
	path: string;
	name: string;
}

/** A clip whose bytes are already in memory (used by tests and the merge core). */
export interface MergeBlobClip {
	name: string;
	path?: string;
	blob: Blob;
}

export interface MergeOptions {
	files: MergeInputFile[];
	onProgress?: (progress: MergeProgress) => void;
	signal?: AbortSignal;
}

export interface MergeBlobsOptions {
	clips: MergeBlobClip[];
	onProgress?: (progress: MergeProgress) => void;
	signal?: AbortSignal;
}

export interface MergeResult {
	success: boolean;
	blob?: Blob;
	mode?: MergeMode;
	/** Human-readable error message. */
	error?: string;
	/** Name of the file that caused the failure, when attributable. */
	failedFile?: string;
	canceled?: boolean;
	/** Fully probed clip metadata, useful for building the UI summary. */
	clipInfos?: MergeClipInfo[];
	mergePlan?: MergePlan;
}

interface PreparedClip {
	file: MergeInputFile;
	blob: Blob;
	input: Input;
	info: MergeClipInfo;
}

class MergeCanceledError extends Error {
	constructor() {
		super("Merge canceled");
		this.name = "MergeCanceledError";
	}
}

function bytesToId(bytes: Uint8Array | null | undefined): string | null {
	if (!bytes || bytes.length === 0) return null;
	let hash = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		hash ^= bytes[i];
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${bytes.length.toString(16)}-${hash.toString(16)}`;
}

function clamp01(value: number): number {
	if (Number.isNaN(value) || value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/** Extracts one decoded AudioSample as planar f32 PCM on the source timeline. */
function audioSampleToMixableFrame(sample: AudioSample): MixableAudioFrame {
	const frameCount = sample.numberOfFrames;
	const planes: Float32Array[] = [];
	for (let channel = 0; channel < sample.numberOfChannels; channel++) {
		const plane = new Float32Array(frameCount);
		sample.copyTo(plane, { format: "f32-planar", planeIndex: channel });
		planes.push(plane);
	}
	return {
		timestampUs: sample.microsecondTimestamp,
		sampleRate: sample.sampleRate,
		frameCount,
		planes,
	};
}

/** Packs a mixed planar f32 frame back into an AudioSample at `offset` seconds. */
function mixableFrameToAudioSample(frame: MixableAudioFrame, offset: number): AudioSample {
	const channelCount = frame.planes.length;
	const data = new Float32Array(frame.frameCount * channelCount);
	for (let channel = 0; channel < channelCount; channel++) {
		data.set(frame.planes[channel], channel * frame.frameCount);
	}
	return new AudioSample({
		data,
		format: "f32-planar",
		numberOfChannels: channelCount,
		sampleRate: frame.sampleRate,
		timestamp: frame.timestampUs / 1_000_000 + offset,
	});
}

/**
 * Concatenates multiple video files into a single MP4.
 *
 * Reads every (already approved) file path into memory, then delegates to
 * {@link mergeVideoBlobs}. Progress starts in the "reading" phase.
 */
export async function mergeVideos(options: MergeOptions): Promise<MergeResult> {
	const { files, onProgress, signal } = options;
	if (files.length < 2) {
		return { success: false, error: "At least two videos are required to merge" };
	}

	const emit = (progress: MergeProgress) => onProgress?.(progress);
	emit({
		phase: "reading",
		clipIndex: 0,
		clipCount: files.length,
		clipProgress: 0,
		overallProgress: 0,
		mode: null,
	});

	const clips: MergeBlobClip[] = [];
	for (let i = 0; i < files.length; i++) {
		if (signal?.aborted) {
			return { success: false, canceled: true, error: "Merge canceled" };
		}
		const result = await window.electronAPI.readBinaryFile(files[i].path);
		if (!result.success || !result.data) {
			return {
				success: false,
				error: result.message ?? "Failed to read file",
				failedFile: files[i].name,
			};
		}
		clips.push({ name: files[i].name, path: files[i].path, blob: new Blob([result.data]) });
		emit({
			phase: "reading",
			clipIndex: i,
			clipCount: files.length,
			clipProgress: (i + 1) / files.length,
			overallProgress: 0.1 * ((i + 1) / files.length),
			mode: null,
		});
	}

	// Blob-based progress occupies the remaining 10..100% range.
	const result = await mergeVideoBlobs({
		clips,
		signal,
		onProgress: (progress) => {
			if (progress.phase === "reading") return;
			emit({
				...progress,
				overallProgress: 0.1 + 0.9 * progress.overallProgress,
			});
		},
	});
	return result;
}

/**
 * Concatenates multiple in-memory video clips into a single MP4.
 *
 * Two strategies are used:
 * - `remux`: when every clip shares codec, dimensions and decoder config, encoded
 *   packets are stream-copied (fast, lossless).
 * - `transcode`: otherwise each clip is decoded and re-encoded to AVC/AAC with
 *   frames normalized ("contain" fit) onto a common canvas.
 */
export async function mergeVideoBlobs(options: MergeBlobsOptions): Promise<MergeResult> {
	const { clips, onProgress, signal } = options;
	if (clips.length < 2) {
		return { success: false, error: "At least two videos are required to merge" };
	}

	const emit = (progress: MergeProgress) => onProgress?.(progress);
	const throwIfCanceled = () => {
		if (signal?.aborted) throw new MergeCanceledError();
	};

	let output: Output | null = null;

	try {
		// ---- 1. Probe every clip ----
		emit({
			phase: "analyzing",
			clipIndex: 0,
			clipCount: clips.length,
			clipProgress: 0,
			overallProgress: 0,
			mode: null,
		});
		const prepared: PreparedClip[] = [];
		for (let i = 0; i < clips.length; i++) {
			throwIfCanceled();
			const clipInput = clips[i];
			const blob = clipInput.blob;
			const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });

			const info = await probeInput(clipInput.name, input, blob.size);
			if (!info) {
				return {
					success: false,
					error: "No supported video track found in this file",
					failedFile: clipInput.name,
				};
			}

			prepared.push({
				file: { path: clipInput.path ?? clipInput.name, name: clipInput.name },
				blob,
				input,
				info: { ...info, path: clipInput.path ?? clipInput.name },
			});
		}

		const clipInfos = prepared.map((clip) => clip.info);
		const plan = computeMergePlan(clipInfos);

		// Stream copy additionally requires each clip to start on a key frame;
		// otherwise the decoder would glitch until the next key frame.
		let mode: MergeMode = "transcode";
		if (isRemuxCompatible(clipInfos) && (await everyClipStartsOnKeyPacket(prepared))) {
			mode = "remux";
		}

		emit({
			phase: "merging",
			clipIndex: 0,
			clipCount: prepared.length,
			clipProgress: 0,
			overallProgress: 0,
			mode,
		});

		// ---- 3. Merge ----
		output = new Output({
			format: new Mp4OutputFormat({ fastStart: "in-memory" }),
			target: new BufferTarget(),
		});

		if (mode === "remux") {
			await mergeViaRemux(output, prepared, plan, emit, throwIfCanceled);
		} else {
			await mergeViaTranscode(output, prepared, plan, emit, throwIfCanceled);
		}

		emit({
			phase: "finalizing",
			clipIndex: prepared.length - 1,
			clipCount: prepared.length,
			clipProgress: 1,
			overallProgress: 0.97,
			mode,
		});
		throwIfCanceled();
		await output.finalize();

		const buffer = output.target instanceof BufferTarget ? output.target.buffer : null;
		if (!buffer) {
			return {
				success: false,
				error: "Merge produced no output",
				mode,
				clipInfos,
				mergePlan: plan,
			};
		}

		emit({
			phase: "finalizing",
			clipIndex: prepared.length - 1,
			clipCount: prepared.length,
			clipProgress: 1,
			overallProgress: 1,
			mode,
		});
		return {
			success: true,
			blob: new Blob([buffer], { type: "video/mp4" }),
			mode,
			clipInfos,
			mergePlan: plan,
		};
	} catch (error) {
		await safelyCancelOutput(output);
		if (error instanceof MergeCanceledError) {
			return { success: false, canceled: true, error: "Merge canceled" };
		}
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function safelyCancelOutput(output: Output | null): Promise<void> {
	try {
		await output?.cancel();
	} catch {
		// Cancellation is best-effort cleanup.
	}
}

/**
 * Probes an opened mediabunny input for merge-relevant metadata. Returns null
 * when the input has no supported video track.
 */
async function probeInput(
	name: string,
	input: Input,
	byteSize: number,
): Promise<MergeClipInfo | null> {
	const videoTrack = await input.getPrimaryVideoTrack();
	if (!videoTrack) {
		return null;
	}

	const [width, height, codec, parameterString, decoderConfig, duration, audioTrack, audioTracks] =
		await Promise.all([
			videoTrack.getDisplayWidth(),
			videoTrack.getDisplayHeight(),
			videoTrack.getCodec(),
			videoTrack.getCodecParameterString(),
			videoTrack.getDecoderConfig(),
			// Use the input's overall duration (max across tracks), not just the
			// video track: audio tracks can run slightly longer (e.g. AAC priming),
			// and the next clip must start after *everything* has finished.
			input.computeDuration(),
			input.getPrimaryAudioTrack(),
			// macOS ScreenCaptureKit recordings carry system audio and the
			// microphone as separate tracks; the count decides whether a mixdown
			// (and therefore transcoding) is required.
			input.getAudioTracks(),
		]);

	const audioInfo = audioTrack
		? {
				hasAudio: true,
				audioTrackCount: audioTracks.length,
				audioCodec: await audioTrack.getCodec(),
				audioSampleRate: await audioTrack.getSampleRate(),
				audioChannels: await audioTrack.getNumberOfChannels(),
			}
		: {
				hasAudio: false,
				audioTrackCount: 0,
				audioCodec: null,
				audioSampleRate: null,
				audioChannels: null,
			};

	const descriptionBytes =
		decoderConfig?.description instanceof Uint8Array ? decoderConfig.description : null;

	return {
		path: name,
		name,
		byteSize,
		duration,
		width,
		height,
		codec,
		codecParameterString: parameterString,
		decoderDescriptionId: bytesToId(descriptionBytes),
		...audioInfo,
	};
}

/** Probes an in-memory video blob for merge-relevant metadata. */
export async function probeBlob(name: string, blob: Blob): Promise<MergeClipInfo> {
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	const info = await probeInput(name, input, blob.size);
	if (!info) {
		throw new Error("No supported video track found");
	}
	return info;
}

/**
 * Probes a single video file for merge-relevant metadata (dimensions, duration,
 * codecs). Used by the merge dialog to build its clip summary. The file is read
 * fully into memory; callers should only use this for small probes (metadata is
 * parsed lazily by mediabunny, so this is cheap for MP4).
 */
export async function probeVideoFile(file: MergeInputFile): Promise<MergeClipInfo> {
	const result = await window.electronAPI.readBinaryFile(file.path);
	if (!result.success || !result.data) {
		throw new Error(result.message ?? "Failed to read file");
	}
	return probeBlob(file.name, new Blob([result.data]));
}

async function everyClipStartsOnKeyPacket(prepared: PreparedClip[]): Promise<boolean> {
	for (const clip of prepared) {
		const videoTrack = await clip.input.getPrimaryVideoTrack();
		if (!videoTrack) return false;
		const sink = new EncodedPacketSink(videoTrack);
		const firstPacket = await sink.getFirstPacket();
		if (!firstPacket || firstPacket.type !== "key") return false;
	}
	return true;
}

function makeClipProgressEmitter(
	emit: (progress: MergeProgress) => void,
	clipCount: number,
	index: number,
	mode: MergeMode,
) {
	return (clipProgress: number) => {
		emit({
			phase: "merging",
			clipIndex: index,
			clipCount,
			clipProgress,
			overallProgress: 0.97 * clipProgress,
			mode,
		});
	};
}

function shiftPacket(packet: EncodedPacket, offset: number): EncodedPacket {
	if (offset === 0) return packet.clone();
	return packet.clone({ timestamp: packet.timestamp + offset });
}

/** Fast path: copy encoded packets verbatim, shifting timestamps per clip. */
async function mergeViaRemux(
	output: Output,
	prepared: PreparedClip[],
	plan: MergePlan,
	emit: (progress: MergeProgress) => void,
	throwIfCanceled: () => void,
): Promise<void> {
	const firstVideoTrack = await prepared[0].input.getPrimaryVideoTrack();
	if (!firstVideoTrack) throw new Error("First clip has no video track");
	const videoCodec = (await firstVideoTrack.getCodec()) ?? "avc";
	const videoDecoderConfig = await firstVideoTrack.getDecoderConfig();
	const videoMeta: EncodedVideoChunkMetadata | undefined = videoDecoderConfig
		? { decoderConfig: videoDecoderConfig }
		: undefined;

	const videoSource = new EncodedVideoPacketSource(videoCodec);
	output.addVideoTrack(videoSource);

	let audioSource: EncodedAudioPacketSource | null = null;
	let audioMeta: EncodedAudioChunkMetadata | undefined;
	const firstAudioTrack = await prepared[0].input.getPrimaryAudioTrack();
	if (firstAudioTrack) {
		const audioCodec = (await firstAudioTrack.getCodec()) ?? "aac";
		audioSource = new EncodedAudioPacketSource(audioCodec);
		const audioDecoderConfig = await firstAudioTrack.getDecoderConfig();
		audioMeta = audioDecoderConfig ? { decoderConfig: audioDecoderConfig } : undefined;
		output.addAudioTrack(audioSource);
	}

	await output.start();

	for (let i = 0; i < prepared.length; i++) {
		throwIfCanceled();
		const clip = prepared[i];
		const offset = plan.offsets[i];
		const emitClip = makeClipProgressEmitter(emit, prepared.length, i, "remux");

		const videoTrack = await clip.input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error(`Clip ${clip.file.name} has no video track`);
		const firstVideoTimestamp = await videoTrack.getFirstTimestamp();
		const videoDuration = await videoTrack.computeDuration();
		const videoSink = new EncodedPacketSink(videoTrack);

		let firstVideoPacket = true;
		for await (const packet of videoSink.packets()) {
			throwIfCanceled();
			const shifted = shiftPacket(packet, offset - firstVideoTimestamp);
			await videoSource.add(shifted, firstVideoPacket ? videoMeta : undefined);
			firstVideoPacket = false;
			emitClip(clamp01(packet.timestamp / videoDuration));
		}

		if (audioSource) {
			const audioTrack = await clip.input.getPrimaryAudioTrack();
			if (audioTrack) {
				const audioSink = new EncodedPacketSink(audioTrack);
				const firstAudioTimestamp = await audioTrack.getFirstTimestamp();
				const audioDuration = await audioTrack.computeDuration();
				let firstAudioPacket = true;
				for await (const packet of audioSink.packets()) {
					throwIfCanceled();
					const shifted = shiftPacket(packet, offset - firstAudioTimestamp);
					await audioSource.add(shifted, firstAudioPacket ? audioMeta : undefined);
					firstAudioPacket = false;
					emitClip(clamp01(packet.timestamp / audioDuration));
				}
			}
		}
	}

	videoSource.close();
	audioSource?.close();
}

/** Universal path: decode each clip and re-encode to AVC/AAC on a common canvas. */
async function mergeViaTranscode(
	output: Output,
	prepared: PreparedClip[],
	plan: MergePlan,
	emit: (progress: MergeProgress) => void,
	throwIfCanceled: () => void,
): Promise<void> {
	const videoConfig: VideoEncodingConfig = {
		codec: "avc",
		quality: new Quality("high"),
		// Clips may have different dimensions; they are all normalized onto the
		// common output canvas (max width × max height, letterboxed).
		sizeChangeBehavior: "contain",
		transform: {
			width: plan.width,
			height: plan.height,
			fit: "contain",
		},
	};
	const videoSource = new VideoSampleSource(videoConfig);
	output.addVideoTrack(videoSource);

	const audioConfig: AudioEncodingConfig | null = plan.audio
		? {
				codec: "aac",
				quality: new Quality("high"),
				transform: {
					numberOfChannels: plan.audio.numberOfChannels,
					sampleRate: plan.audio.sampleRate,
				},
			}
		: null;
	let audioSource: AudioSampleSource | null = null;
	if (audioConfig) {
		audioSource = new AudioSampleSource(audioConfig);
		output.addAudioTrack(audioSource);
	}

	await output.start();

	for (let i = 0; i < prepared.length; i++) {
		throwIfCanceled();
		const clip = prepared[i];
		const offset = plan.offsets[i];
		const emitClip = makeClipProgressEmitter(emit, prepared.length, i, "transcode");

		const videoTrack = await clip.input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error(`Clip ${clip.file.name} has no video track`);
		const firstVideoTimestamp = await videoTrack.getFirstTimestamp();
		const videoDuration = await videoTrack.computeDuration();
		const videoSink = new VideoSampleSink(videoTrack);

		let isFirstFrame = true;
		for await (const sample of videoSink.samples()) {
			throwIfCanceled();
			const localTimestamp = sample.timestamp - firstVideoTimestamp;
			sample.setTimestamp(localTimestamp + offset);
			const progress = clamp01(localTimestamp / videoDuration);
			await videoSource.add(sample, isFirstFrame ? { keyFrame: true } : undefined);
			isFirstFrame = false;
			sample.close();
			emitClip(progress);
		}

		if (audioSource) {
			const audioTracks = await clip.input.getAudioTracks();
			if (audioTracks.length === 1) {
				// Single-track clip: pass samples straight through with a new timestamp.
				const audioSink = new AudioSampleSink(audioTracks[0]);
				const firstAudioTimestamp = await audioTracks[0].getFirstTimestamp();
				const audioDuration = await audioTracks[0].computeDuration();
				for await (const sample of audioSink.samples()) {
					throwIfCanceled();
					const localTimestamp = sample.timestamp - firstAudioTimestamp;
					sample.setTimestamp(localTimestamp + offset);
					const progress = clamp01(localTimestamp / audioDuration);
					await audioSource.add(sample);
					sample.close();
					emitClip(progress);
				}
			} else if (audioTracks.length > 1) {
				// Multi-track clip (macOS system audio + microphone): every track is
				// decoded, summed onto one timeline and re-encoded as a single audible
				// track. Without this, players only expose the first (often silent)
				// track and the merged video plays without sound.
				if (!plan.audio) throw new Error("Merge plan has no audio format");
				const tracks: MixableAudioFrame[][] = [];
				for (const audioTrack of audioTracks) {
					throwIfCanceled();
					const trackFrames: MixableAudioFrame[] = [];
					const audioSink = new AudioSampleSink(audioTrack);
					for await (const sample of audioSink.samples()) {
						throwIfCanceled();
						trackFrames.push(audioSampleToMixableFrame(sample));
						sample.close();
					}
					tracks.push(trackFrames);
				}

				const mixed = mixAudioTrackFrames(tracks, {
					targetSampleRate: plan.audio.sampleRate,
					targetChannels: plan.audio.numberOfChannels,
				});
				const lastFrame = mixed[mixed.length - 1];
				const mixedDuration = lastFrame
					? lastFrame.timestampUs / 1e6 + lastFrame.frameCount / plan.audio.sampleRate
					: 0;
				for (const frame of mixed) {
					throwIfCanceled();
					const sample = mixableFrameToAudioSample(frame, offset);
					const progress = clamp01(frame.timestampUs / 1e6 / mixedDuration);
					await audioSource.add(sample);
					sample.close();
					emitClip(progress);
				}
			}
		}
	}

	videoSource.close();
	audioSource?.close();
}
