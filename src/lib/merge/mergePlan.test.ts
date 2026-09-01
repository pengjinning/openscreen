import { describe, expect, it } from "vitest";
import {
	computeMergePlan,
	computeOutputDimensions,
	isRemuxCompatible,
	type MergeClipInfo,
	planAudioFormat,
	toEvenDimension,
} from "./mergePlan";

function makeClip(overrides: Partial<MergeClipInfo> = {}): MergeClipInfo {
	return {
		path: "/tmp/clip.mp4",
		name: "clip.mp4",
		byteSize: 1024,
		duration: 10,
		width: 1920,
		height: 1080,
		codec: "avc",
		codecParameterString: "avc1.640033",
		decoderDescriptionId: "abc-123",
		hasAudio: true,
		audioTrackCount: 1,
		audioCodec: "aac",
		audioSampleRate: 48000,
		audioChannels: 2,
		...overrides,
	};
}

describe("toEvenDimension", () => {
	it("rounds odd values down to the nearest even number", () => {
		expect(toEvenDimension(1919)).toBe(1918);
		expect(toEvenDimension(1081)).toBe(1080);
	});

	it("keeps even values unchanged", () => {
		expect(toEvenDimension(1920)).toBe(1920);
		expect(toEvenDimension(0)).toBe(0);
	});
});

describe("computeOutputDimensions", () => {
	it("picks the largest width and height across clips independently", () => {
		const dims = computeOutputDimensions([
			makeClip({ width: 1920, height: 1080 }),
			makeClip({ width: 1280, height: 1440 }),
		]);
		expect(dims).toEqual({ width: 1920, height: 1440 });
	});

	it("rounds odd maximums down to even values", () => {
		const dims = computeOutputDimensions([
			makeClip({ width: 1919, height: 1079 }),
			makeClip({ width: 640, height: 360 }),
		]);
		expect(dims).toEqual({ width: 1918, height: 1078 });
	});
});

describe("planAudioFormat", () => {
	it("returns null when no clip has audio", () => {
		expect(
			planAudioFormat([
				makeClip({ hasAudio: false, audioCodec: null, audioSampleRate: null, audioChannels: null }),
				makeClip({ hasAudio: false, audioCodec: null, audioSampleRate: null, audioChannels: null }),
			]),
		).toBeNull();
	});

	it("keeps the shared format when all audio clips agree", () => {
		expect(
			planAudioFormat([
				makeClip({ audioSampleRate: 44100, audioChannels: 1 }),
				makeClip({ audioSampleRate: 44100, audioChannels: 1 }),
			]),
		).toEqual({ numberOfChannels: 1, sampleRate: 44100 });
	});

	it("normalizes to stereo 48 kHz when audio formats differ", () => {
		expect(
			planAudioFormat([
				makeClip({ audioSampleRate: 44100, audioChannels: 2 }),
				makeClip({ audioSampleRate: 48000, audioChannels: 1 }),
			]),
		).toEqual({ numberOfChannels: 2, sampleRate: 48000 });
	});

	it("normalizes when some clips have no audio", () => {
		const format = planAudioFormat([
			makeClip({ audioSampleRate: 48000, audioChannels: 2 }),
			makeClip({ hasAudio: false, audioCodec: null, audioSampleRate: null, audioChannels: null }),
		]);
		expect(format).toEqual({ numberOfChannels: 2, sampleRate: 48000 });
	});
});

describe("computeMergePlan", () => {
	it("computes cumulative offsets and total duration", () => {
		const plan = computeMergePlan([
			makeClip({ duration: 5 }),
			makeClip({ duration: 7.5 }),
			makeClip({ duration: 2.5 }),
		]);
		expect(plan.offsets).toEqual([0, 5, 12.5]);
		expect(plan.totalDuration).toBeCloseTo(15, 10);
	});
});

describe("isRemuxCompatible", () => {
	it("accepts clips with identical codec, dimensions and decoder config", () => {
		expect(isRemuxCompatible([makeClip(), makeClip()])).toBe(true);
	});

	it("rejects when any required video metadata is missing", () => {
		expect(isRemuxCompatible([makeClip({ codec: null }), makeClip()])).toBe(false);
		expect(isRemuxCompatible([makeClip({ codecParameterString: null }), makeClip()])).toBe(false);
		expect(isRemuxCompatible([makeClip({ decoderDescriptionId: null }), makeClip()])).toBe(false);
	});

	it("rejects mismatched codec parameter strings", () => {
		expect(isRemuxCompatible([makeClip(), makeClip({ codecParameterString: "avc1.42c01e" })])).toBe(
			false,
		);
	});

	it("rejects mismatched dimensions", () => {
		expect(isRemuxCompatible([makeClip(), makeClip({ width: 1280, height: 720 })])).toBe(false);
	});

	it("rejects mismatched decoder descriptions", () => {
		expect(isRemuxCompatible([makeClip(), makeClip({ decoderDescriptionId: "def-456" })])).toBe(
			false,
		);
	});

	it("rejects mixed audio/no-audio clips", () => {
		expect(
			isRemuxCompatible([
				makeClip(),
				makeClip({ hasAudio: false, audioCodec: null, audioSampleRate: null, audioChannels: null }),
			]),
		).toBe(false);
	});

	it("rejects mismatched audio sample rates", () => {
		expect(isRemuxCompatible([makeClip(), makeClip({ audioSampleRate: 44100 })])).toBe(false);
	});

	it("accepts consistent no-audio clips", () => {
		expect(
			isRemuxCompatible([
				makeClip({
					hasAudio: false,
					audioTrackCount: 0,
					audioCodec: null,
					audioSampleRate: null,
					audioChannels: null,
				}),
				makeClip({
					hasAudio: false,
					audioTrackCount: 0,
					audioCodec: null,
					audioSampleRate: null,
					audioChannels: null,
				}),
			]),
		).toBe(true);
	});

	it("rejects multi-track audio clips (mixdown requires re-encoding)", () => {
		expect(isRemuxCompatible([makeClip({ audioTrackCount: 2 }), makeClip()])).toBe(false);
	});

	it("rejects empty clip lists", () => {
		expect(isRemuxCompatible([])).toBe(false);
	});
});
