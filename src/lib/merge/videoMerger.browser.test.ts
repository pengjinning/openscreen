import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSource,
	BlobSource,
	BufferTarget,
	Input,
	Mp4OutputFormat,
	Output,
	Quality,
	VideoSample,
	VideoSampleSource,
} from "mediabunny";
import { describe, expect, it } from "vitest";
import dualTrackVideoUrl from "../../../tests/fixtures/dual-audio-track.mp4?url";
import { mergeVideoBlobs } from "./videoMerger";

const FPS = 16;

interface MakeTestVideoOptions {
	width: number;
	height: number;
	seconds?: number;
	fillStyle?: string;
	withAudio?: boolean;
}

/**
 * Generates a small AVC(+AAC) MP4 in the browser using mediabunny itself,
 * drawing numbered color frames onto a canvas so both paths are verifiable.
 */
async function makeTestMp4(options: MakeTestVideoOptions): Promise<Blob> {
	const { width, height, seconds = 1, fillStyle = "#336633", withAudio = false } = options;

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: "in-memory" }),
		target: new BufferTarget(),
	});

	const videoSource = new VideoSampleSource({
		codec: "avc",
		quality: new Quality("low"),
	});
	output.addVideoTrack(videoSource);

	let audioSource: AudioSampleSource | null = null;
	if (withAudio) {
		audioSource = new AudioSampleSource({
			codec: "aac",
			quality: new Quality("low"),
		});
		output.addAudioTrack(audioSource);
	}

	await output.start();

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Could not acquire 2D context");

	const frameCount = Math.round(seconds * FPS);
	for (let i = 0; i < frameCount; i++) {
		ctx.fillStyle = fillStyle;
		ctx.fillRect(0, 0, width, height);
		ctx.fillStyle = "#ffffff";
		ctx.font = "16px monospace";
		ctx.fillText(String(i), 8, 20);
		const sample = new VideoSample(canvas, {
			timestamp: i / FPS,
			duration: 1 / FPS,
		});
		await videoSource.add(sample);
	}
	videoSource.close();

	if (audioSource) {
		// 100 ms chunks of silence (interleaved s16, stereo, 48 kHz).
		const framesPerChunk = 4800;
		const chunkCount = Math.round((seconds * 48000) / framesPerChunk);
		for (let i = 0; i < chunkCount; i++) {
			const data = new Int16Array(framesPerChunk * 2);
			const audioSample = new AudioSample({
				data,
				format: "s16",
				numberOfChannels: 2,
				sampleRate: 48000,
				timestamp: (i * framesPerChunk) / 48000,
			});
			await audioSource.add(audioSample);
		}
		audioSource.close();
	}

	await output.finalize();
	const buffer = output.target.buffer;
	if (!buffer) throw new Error("Test video generation produced no buffer");
	return new Blob([buffer], { type: "video/mp4" });
}

async function probeBlob(blob: Blob) {
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	const videoTrack = await input.getPrimaryVideoTrack();
	if (!videoTrack) throw new Error("Merged output has no video track");
	return {
		duration: await videoTrack.computeDuration(),
		width: await videoTrack.getDisplayWidth(),
		height: await videoTrack.getDisplayHeight(),
	};
}

describe("mergeVideoBlobs (real browser)", () => {
	it("stream-copies identical clips (remux) and preserves total duration", {
		timeout: 90_000,
	}, async () => {
		const clipA = await makeTestMp4({
			width: 320,
			height: 180,
			seconds: 1,
			fillStyle: "#225522",
			withAudio: true,
		});
		const clipB = await makeTestMp4({
			width: 320,
			height: 180,
			seconds: 1.5,
			fillStyle: "#552222",
			withAudio: true,
		});

		const result = await mergeVideoBlobs({
			clips: [
				{ name: "a.mp4", blob: clipA },
				{ name: "b.mp4", blob: clipB },
			],
		});

		expect(result.success, result.error).toBe(true);
		expect(result.mode).toBe("remux");
		expect(result.blob).toBeInstanceOf(Blob);
		expect(result.blob?.size).toBeGreaterThan(1024);

		const bytes = new Uint8Array(await result.blob!.arrayBuffer());
		expect(new TextDecoder().decode(bytes.slice(4, 8))).toBe("ftyp");

		const probed = await probeBlob(result.blob!);
		expect(probed.width).toBe(320);
		expect(probed.height).toBe(180);
		// 1s + 1.5s, allowing a small tolerance for AAC priming samples.
		expect(probed.duration).toBeGreaterThanOrEqual(2.3);
		expect(probed.duration).toBeLessThanOrEqual(2.8);
	});

	it("transcodes mixed-size clips onto a common canvas", { timeout: 180_000 }, async () => {
		const clipA = await makeTestMp4({
			width: 320,
			height: 180,
			seconds: 1,
			fillStyle: "#223355",
		});
		const clipB = await makeTestMp4({
			width: 240,
			height: 240,
			seconds: 1,
			fillStyle: "#553322",
		});

		const result = await mergeVideoBlobs({
			clips: [
				{ name: "wide.mp4", blob: clipA },
				{ name: "square.mp4", blob: clipB },
			],
		});

		expect(result.success, result.error).toBe(true);
		expect(result.mode).toBe("transcode");
		expect(result.blob).toBeInstanceOf(Blob);

		const bytes = new Uint8Array(await result.blob!.arrayBuffer());
		expect(new TextDecoder().decode(bytes.slice(4, 8))).toBe("ftyp");

		const probed = await probeBlob(result.blob!);
		// Output box = max width × max height, letterboxed with "contain" fit.
		expect(probed.width).toBe(320);
		expect(probed.height).toBe(240);
		expect(probed.duration).toBeGreaterThanOrEqual(1.8);
		expect(probed.duration).toBeLessThanOrEqual(2.3);
	});

	it("rejects merges with fewer than two clips", async () => {
		const clip = await makeTestMp4({ width: 320, height: 180 });
		const result = await mergeVideoBlobs({ clips: [{ name: "only.mp4", blob: clip }] });
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it("mixes dual-track audio clips so the merge stays audible", { timeout: 240_000 }, async () => {
		// macOS ScreenCaptureKit fixture: track 1 (system audio) is digital
		// silence, track 2 (microphone) holds the real audio. Without a mixdown
		// the merge would copy only the silent first track.
		const dualTrackBlob = await (await fetch(dualTrackVideoUrl)).blob();
		const generated = await makeTestMp4({ width: 320, height: 180, seconds: 1 });

		const dualTrackInput = new Input({
			source: new BlobSource(dualTrackBlob),
			formats: ALL_FORMATS,
		});
		const audioTrackCount = (await dualTrackInput.getAudioTracks()).length;
		expect(audioTrackCount).toBeGreaterThanOrEqual(2);

		const result = await mergeVideoBlobs({
			clips: [
				{ name: "dual.mp4", blob: dualTrackBlob },
				{ name: "generated.mp4", blob: generated },
			],
		});

		expect(result.success, result.error).toBe(true);
		// Multi-track audio can never stream-copy; it must be transcoded+mixed.
		expect(result.mode).toBe("transcode");
		expect(result.blob).toBeInstanceOf(Blob);

		const buffer = await result.blob!.arrayBuffer();
		const bytes = new Uint8Array(buffer);
		expect(new TextDecoder().decode(bytes.slice(4, 8))).toBe("ftyp");

		const audioContext = new AudioContext();
		try {
			const decoded = await audioContext.decodeAudioData(buffer);

			let peak = 0;
			for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
				const data = decoded.getChannelData(channel);
				for (let index = 0; index < data.length; index++) {
					const magnitude = Math.abs(data[index]);
					if (magnitude > peak) peak = magnitude;
				}
			}

			// The fixture's first track is digital silence (-91 dB); without the
			// multi-track mixdown the merged peak stays below 0.002.
			expect(peak).toBeGreaterThan(0.05);
		} finally {
			await audioContext.close();
		}
	});
});
