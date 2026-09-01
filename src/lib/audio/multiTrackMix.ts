/**
 * Pure multi-track PCM mixing primitives.
 *
 * Extracted from `lib/exporter/audioEncoder.ts` so the merge engine (and any
 * future consumer) can mix multiple decoded audio tracks into one timeline
 * without depending on the web-demuxer-based export pipeline.
 *
 * macOS ScreenCaptureKit recordings carry system audio and the microphone as
 * two independent AAC tracks (the first is often silent); players only surface
 * one of them, so anything that re-encodes such a file must first mix every
 * track down to a single audible one.
 */

export interface MixableAudioFrame {
	/** Presentation timestamp on the source timeline, in microseconds. */
	timestampUs: number;
	/** Source sample rate in hertz. */
	sampleRate: number;
	/** Sample count per channel. */
	frameCount: number;
	/** Planar PCM data, one Float32Array per channel. */
	planes: Float32Array[];
}

export interface MixAudioTimelineOptions {
	targetSampleRate: number;
	targetChannels: number;
	/** Trim regions (milliseconds on the source timeline) collapsed by the mix. */
	trimRegions?: Array<{ startMs: number; endMs: number }>;
	/** Maximum sample count per returned frame. */
	chunkFrames?: number;
}

function averageChannels(sourcePlanes: Float32Array[], frame: number) {
	let mixed = 0;
	for (const plane of sourcePlanes) {
		mixed += plane[frame] ?? 0;
	}
	return mixed / Math.max(1, sourcePlanes.length);
}

function weightedSample(
	sourcePlanes: Float32Array[],
	frame: number,
	weights: Array<[channel: number, weight: number]>,
) {
	let mixed = 0;
	let weightSum = 0;
	for (const [channel, weight] of weights) {
		const sample = sourcePlanes[channel]?.[frame];
		if (typeof sample !== "number") {
			continue;
		}
		mixed += sample * weight;
		weightSum += weight;
	}
	return weightSum > 0 ? mixed / weightSum : averageChannels(sourcePlanes, frame);
}

function getStereoDownmixWeights(sourceChannels: number) {
	const centerWeight = Math.SQRT1_2;
	const surroundWeight = Math.SQRT1_2;
	const lfeWeight = 0.5;

	if (sourceChannels >= 8) {
		// Windows 7.1 order: FL, FR, FC, LFE, BL, BR, SL, SR.
		return {
			left: [
				[0, 1],
				[2, centerWeight],
				[3, lfeWeight],
				[4, surroundWeight],
				[6, surroundWeight],
			] satisfies Array<[number, number]>,
			right: [
				[1, 1],
				[2, centerWeight],
				[3, lfeWeight],
				[5, surroundWeight],
				[7, surroundWeight],
			] satisfies Array<[number, number]>,
		};
	}

	if (sourceChannels >= 6) {
		// Windows 5.1 order: FL, FR, FC, LFE, BL, BR.
		return {
			left: [
				[0, 1],
				[2, centerWeight],
				[3, lfeWeight],
				[4, surroundWeight],
			] satisfies Array<[number, number]>,
			right: [
				[1, 1],
				[2, centerWeight],
				[3, lfeWeight],
				[5, surroundWeight],
			] satisfies Array<[number, number]>,
		};
	}

	if (sourceChannels >= 4) {
		return {
			left: [
				[0, 1],
				[2, surroundWeight],
			] satisfies Array<[number, number]>,
			right: [
				[1, 1],
				[3, surroundWeight],
			] satisfies Array<[number, number]>,
		};
	}

	return {
		left: [
			[0, 1],
			[2, centerWeight],
		] satisfies Array<[number, number]>,
		right: [
			[1, 1],
			[2, centerWeight],
		] satisfies Array<[number, number]>,
	};
}

export function downmixPlanarChannelsForExport(
	sourcePlanes: Float32Array[],
	targetChannels: number,
): Float32Array {
	const frameCount = sourcePlanes[0]?.length ?? 0;
	const output = new Float32Array(frameCount * targetChannels);

	if (targetChannels === 1) {
		for (let frame = 0; frame < frameCount; frame++) {
			output[frame] = averageChannels(sourcePlanes, frame);
		}
		return output;
	}

	if (targetChannels !== 2) {
		throw new Error(`Unsupported target channel count: ${targetChannels}`);
	}

	if (sourcePlanes.length === 1) {
		output.set(sourcePlanes[0], 0);
		output.set(sourcePlanes[0], frameCount);
		return output;
	}

	if (sourcePlanes.length === 2) {
		output.set(sourcePlanes[0], 0);
		output.set(sourcePlanes[1], frameCount);
		return output;
	}

	const weights = getStereoDownmixWeights(sourcePlanes.length);
	for (let frame = 0; frame < frameCount; frame++) {
		output[frame] = weightedSample(sourcePlanes, frame, weights.left);
		output[frameCount + frame] = weightedSample(sourcePlanes, frame, weights.right);
	}
	return output;
}

/** Grows each plane so index `minFrames - 1` is writable, preserving contents. */
function growPlanes(planes: Float32Array[], minFrames: number): void {
	if (planes[0].length >= minFrames) return;
	let nextLength = Math.max(1024, planes[0].length);
	while (nextLength < minFrames) nextLength *= 2;
	for (let channel = 0; channel < planes.length; channel++) {
		const grown = new Float32Array(nextLength);
		grown.set(planes[channel]);
		planes[channel] = grown;
	}
}

/** Adapts planar PCM to the target channel count using the export downmix rules. */
function planesForTargetChannels(
	planes: Float32Array[],
	frameCount: number,
	targetChannels: number,
): Float32Array[] {
	if (planes.length === targetChannels) return planes;
	const buffer = downmixPlanarChannelsForExport(planes, targetChannels);
	return Array.from({ length: targetChannels }, (_, channel) =>
		buffer.subarray(channel * frameCount, (channel + 1) * frameCount),
	);
}

/** Adds resampled planar samples into `mixedPlanes` at `startFrame`, returning frames written. */
function addFrameToTimeline(
	planes: Float32Array[],
	frameCount: number,
	sampleRate: number,
	startFrame: number,
	targetSampleRate: number,
	mixedPlanes: Float32Array[],
): number {
	if (sampleRate === targetSampleRate) {
		growPlanes(mixedPlanes, startFrame + frameCount);
		for (let channel = 0; channel < planes.length; channel++) {
			const target = mixedPlanes[channel];
			const source = planes[channel];
			for (let frame = 0; frame < frameCount; frame++) {
				target[startFrame + frame] += source[frame];
			}
		}
		return frameCount;
	}

	const ratio = sampleRate / targetSampleRate;
	const outputFrames = Math.max(1, Math.round(frameCount / ratio));
	growPlanes(mixedPlanes, startFrame + outputFrames);
	for (let channel = 0; channel < planes.length; channel++) {
		const target = mixedPlanes[channel];
		const source = planes[channel];
		for (let frame = 0; frame < outputFrames; frame++) {
			const position = frame * ratio;
			const left = Math.min(Math.floor(position), frameCount - 1);
			const right = Math.min(left + 1, frameCount - 1);
			const alpha = position - left;
			target[startFrame + frame] += source[left] + (source[right] - source[left]) * alpha;
		}
	}
	return outputFrames;
}

/** Computes the kept [start, end) sample spans after removing trim regions. */
function keptSampleSpans(
	trimRegions: Array<{ startMs: number; endMs: number }>,
	totalFrames: number,
	sampleRate: number,
): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	const sorted = [...trimRegions]
		.filter((region) => region.endMs > region.startMs)
		.sort((a, b) => a.startMs - b.startMs);

	let cursor = 0;
	for (const region of sorted) {
		const start = Math.ceil((region.startMs / 1000) * sampleRate);
		const end = Math.floor((region.endMs / 1000) * sampleRate);
		if (start > cursor) spans.push([cursor, Math.min(start, totalFrames)]);
		cursor = Math.max(cursor, end);
		if (cursor >= totalFrames) break;
	}
	if (cursor < totalFrames) spans.push([cursor, totalFrames]);

	return spans.filter(([start, end]) => end > start);
}

/**
 * Mixes decoded audio tracks into one continuous planar timeline.
 *
 * Every track is summed onto a shared source-timeline buffer (silence where a
 * track has no samples), trim regions are collapsed so the output is
 * contiguous, and the result is chunked into encoder-sized frames with
 * cumulative timestamps. Samples are clamped to [-1, 1] so summing loud tracks
 * cannot overshoot the float PCM range.
 */
export function mixAudioTrackFrames(
	tracks: MixableAudioFrame[][],
	options: MixAudioTimelineOptions,
): MixableAudioFrame[] {
	const targetSampleRate = options.targetSampleRate;
	const targetChannels = options.targetChannels;
	const chunkFrames = options.chunkFrames ?? 1024;

	const hasFrames = tracks.some((track) => track.length > 0);
	if (!hasFrames) return [];

	// Pass 1: sum every track onto a shared source-timeline buffer.
	const mixedPlanes = Array.from({ length: targetChannels }, () => new Float32Array(0));
	let timelineFrames = 0;
	for (const track of tracks) {
		for (const frame of track) {
			const start = Math.max(0, Math.round((frame.timestampUs / 1_000_000) * targetSampleRate));
			const planes = planesForTargetChannels(frame.planes, frame.frameCount, targetChannels);
			const written = addFrameToTimeline(
				planes,
				frame.frameCount,
				frame.sampleRate,
				start,
				targetSampleRate,
				mixedPlanes,
			);
			timelineFrames = Math.max(timelineFrames, start + written);
		}
	}

	// Pass 2: collapse trimmed spans into one contiguous output buffer. Without
	// trims the timeline is already contiguous, so clamp in place and hand out
	// zero-copy views instead of duplicating the whole timeline.
	const spans = keptSampleSpans(options.trimRegions ?? [], timelineFrames, targetSampleRate);
	const outputFrames = spans.reduce((total, [start, end]) => total + (end - start), 0);
	if (outputFrames === 0) return [];

	let outputPlanes: Float32Array[];
	if (spans.length === 1 && spans[0][0] === 0 && spans[0][1] === timelineFrames) {
		for (const plane of mixedPlanes) {
			for (let frame = 0; frame < timelineFrames; frame++) {
				const sample = plane[frame];
				if (sample > 1) plane[frame] = 1;
				else if (sample < -1) plane[frame] = -1;
			}
		}
		outputPlanes = mixedPlanes;
	} else {
		outputPlanes = Array.from({ length: targetChannels }, () => new Float32Array(outputFrames));
		let cursor = 0;
		for (const [start, end] of spans) {
			const length = end - start;
			for (let channel = 0; channel < targetChannels; channel++) {
				const source = mixedPlanes[channel];
				const target = outputPlanes[channel];
				for (let frame = 0; frame < length; frame++) {
					const sample = source[start + frame];
					target[cursor + frame] = sample > 1 ? 1 : sample < -1 ? -1 : sample;
				}
			}
			cursor += length;
		}
	}

	// Pass 3: chunk for the encoder.
	const chunks: MixableAudioFrame[] = [];
	for (let offset = 0; offset < outputFrames; offset += chunkFrames) {
		const length = Math.min(chunkFrames, outputFrames - offset);
		const planes = outputPlanes.map((plane) => plane.subarray(offset, offset + length));
		chunks.push({
			timestampUs: Math.round(((chunks.length * chunkFrames) / targetSampleRate) * 1_000_000),
			sampleRate: targetSampleRate,
			frameCount: length,
			planes,
		});
	}
	return chunks;
}
