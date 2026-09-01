import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AudioProcessor,
	downmixPlanarChannelsForExport,
	type MixableAudioFrame,
	mixAudioTrackFrames,
} from "./audioEncoder";

describe("AudioProcessor.selectSupportedExportCodec", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("falls back to stereo when the source channel count cannot be encoded", async () => {
		const isConfigSupported = vi.fn(async (config: AudioEncoderConfig) => ({
			config,
			supported:
				config.codec === "mp4a.40.2" &&
				config.sampleRate === 44100 &&
				config.numberOfChannels === 2,
		}));
		vi.stubGlobal("AudioEncoder", { isConfigSupported });

		const codec = await AudioProcessor.selectSupportedExportCodec(44100, 8);

		expect(codec).toMatchObject({
			encoderCodec: "mp4a.40.2",
			muxerCodec: "aac",
			sampleRate: 44100,
			numberOfChannels: 2,
		});
		expect(isConfigSupported).toHaveBeenCalledWith({
			codec: "mp4a.40.2",
			sampleRate: 44100,
			numberOfChannels: 8,
			bitrate: 128000,
		});
		expect(isConfigSupported).toHaveBeenCalledWith({
			codec: "mp4a.40.2",
			sampleRate: 44100,
			numberOfChannels: 2,
			bitrate: 128000,
		});
	});
});

describe("downmixPlanarChannelsForExport", () => {
	it("preserves non-front Windows system audio channels when exporting stereo", () => {
		const sourcePlanes = Array.from({ length: 8 }, (_, channel) => {
			const plane = new Float32Array(2);
			if (channel === 2) {
				plane[0] = 0.8;
				plane[1] = 0.4;
			}
			if (channel === 6) {
				plane[0] = 0.2;
				plane[1] = 0.1;
			}
			return plane;
		});

		const stereo = downmixPlanarChannelsForExport(sourcePlanes, 2);

		expect(stereo[0]).toBeGreaterThan(0);
		expect(stereo[1]).toBeGreaterThan(0);
		expect(stereo[2]).toBeGreaterThan(0);
		expect(stereo[3]).toBeGreaterThan(0);
	});

	it("duplicates mono microphone audio when exporting stereo", () => {
		const mono = new Float32Array([0.25, -0.5]);

		const stereo = downmixPlanarChannelsForExport([mono], 2);

		expect(Array.from(stereo)).toEqual([0.25, -0.5, 0.25, -0.5]);
	});
});

describe("mixAudioTrackFrames", () => {
	const RATE = 48_000;

	function constantFrame(
		timestampUs: number,
		frameCount: number,
		value: number,
		options?: { sampleRate?: number; channels?: number },
	): MixableAudioFrame {
		const channels = options?.channels ?? 1;
		return {
			timestampUs,
			sampleRate: options?.sampleRate ?? RATE,
			frameCount,
			planes: Array.from({ length: channels }, () => new Float32Array(frameCount).fill(value)),
		};
	}

	function flattened(frames: MixableAudioFrame[]): Float32Array {
		return frames[0].planes[0];
	}

	it("sums overlapping tracks so a silent first track cannot mask the audible one", () => {
		const mixed = mixAudioTrackFrames(
			[
				[constantFrame(0, 1024, 0)], // silent system audio track
				[constantFrame(0, 1024, 0.25)], // audible microphone track
			],
			{ targetSampleRate: RATE, targetChannels: 2, chunkFrames: 512 },
		);

		expect(mixed.length).toBe(2);
		expect(mixed[0].frameCount).toBe(512);
		expect(mixed[0].planes.length).toBe(2);
		expect(mixed[0].planes[0][0]).toBeCloseTo(0.25);
		expect(mixed[0].planes[1][511]).toBeCloseTo(0.25);
		expect(mixed[1].timestampUs).toBe(Math.round((512 / RATE) * 1_000_000));
	});

	it("collapses trimmed regions into a contiguous timeline", () => {
		const frameMs = (1024 / RATE) * 1000;
		const first = constantFrame(0, 1024, 0.1);
		const second = constantFrame(Math.round(2 * 1024 * (1_000_000 / RATE)), 1024, 0.2);

		const mixed = mixAudioTrackFrames([[first, second]], {
			targetSampleRate: RATE,
			targetChannels: 1,
			// Trim exactly the 1024-sample gap between both frames.
			trimRegions: [{ startMs: frameMs, endMs: frameMs * 2 }],
			chunkFrames: 4096,
		});

		expect(mixed.length).toBe(1);
		expect(mixed[0].frameCount).toBe(2048);
		const output = flattened(mixed);
		expect(output[0]).toBeCloseTo(0.1);
		expect(output[1023]).toBeCloseTo(0.1);
		expect(output[1024]).toBeCloseTo(0.2);
		expect(output[2047]).toBeCloseTo(0.2);
	});

	it("keeps track start offsets as leading silence instead of shifting audio earlier", () => {
		const offsetUs = 100_000; // 0.1s
		const mixed = mixAudioTrackFrames([[constantFrame(offsetUs, 480, 0.5)]], {
			targetSampleRate: RATE,
			targetChannels: 1,
			chunkFrames: RATE,
		});

		const output = flattened(mixed);
		expect(output.length).toBe(RATE / 10 + 480);
		expect(output[0]).toBe(0);
		expect(output[4799]).toBe(0);
		expect(output[4800]).toBeCloseTo(0.5);
	});

	it("resamples tracks recorded at another sample rate onto the target timeline", () => {
		const mixed = mixAudioTrackFrames([[constantFrame(0, 512, 0.5, { sampleRate: 24_000 })]], {
			targetSampleRate: RATE,
			targetChannels: 1,
			chunkFrames: 4096,
		});

		expect(mixed[0].frameCount).toBe(1024);
		expect(flattened(mixed)[1023]).toBeCloseTo(0.5);
	});

	it("duplicates a mono track into both target stereo channels", () => {
		const mixed = mixAudioTrackFrames([[constantFrame(0, 16, 0.75)]], {
			targetSampleRate: RATE,
			targetChannels: 2,
			chunkFrames: 4096,
		});

		expect(mixed[0].planes.length).toBe(2);
		expect(mixed[0].planes[1][15]).toBeCloseTo(0.75);
	});

	it("clamps summed samples to the valid float PCM range", () => {
		const mixed = mixAudioTrackFrames([[constantFrame(0, 8, 0.9)], [constantFrame(0, 8, 0.9)]], {
			targetSampleRate: RATE,
			targetChannels: 1,
			chunkFrames: 4096,
		});

		expect(flattened(mixed)[0]).toBe(1);
	});
});
