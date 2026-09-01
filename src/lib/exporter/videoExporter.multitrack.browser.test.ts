import { describe, expect, it } from "vitest";
import dualTrackVideoUrl from "../../../tests/fixtures/dual-audio-track.mp4?url";
import { VideoExporter } from "./videoExporter";

/**
 * macOS ScreenCaptureKit recordings carry system audio and the microphone as
 * two separate AAC tracks, and the system track can be entirely silent while
 * the microphone track holds the real audio. Exports must mix every track
 * (like the editor preview does) instead of copying only the first one.
 */
describe("VideoExporter multi-track audio (real browser)", () => {
	it("mixes every audio track so exports are audible when the first track is silent", async () => {
		const exporter = new VideoExporter({
			videoUrl: dualTrackVideoUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			bitrate: 1_000_000,
			wallpaper: "#1a1a2e",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		});

		const result = await exporter.export();

		expect(result.success, result.error).toBe(true);
		expect(result.blob).toBeInstanceOf(Blob);

		const buffer = await result.blob!.arrayBuffer();
		const bytes = new Uint8Array(buffer);
		expect(new TextDecoder().decode(bytes.slice(4, 8))).toBe("ftyp");

		const audioContext = new AudioContext();
		try {
			const decoded = await audioContext.decodeAudioData(buffer);

			expect(decoded.duration).toBeGreaterThan(5);

			let peak = 0;
			for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
				const data = decoded.getChannelData(channel);
				for (let index = 0; index < data.length; index++) {
					const magnitude = Math.abs(data[index]);
					if (magnitude > peak) peak = magnitude;
				}
			}

			// The fixture's first track is digital silence (-91 dB); without the
			// multi-track mix the export peak stays below 0.002.
			expect(peak).toBeGreaterThan(0.05);
		} finally {
			await audioContext.close();
		}
	});
});
