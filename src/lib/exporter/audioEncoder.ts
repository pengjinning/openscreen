import { AVMediaType, type WebAVStream, WebDemuxer } from "web-demuxer";
import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import {
	downmixPlanarChannelsForExport,
	type MixAudioTimelineOptions,
	type MixableAudioFrame,
	mixAudioTrackFrames,
} from "@/lib/audio/multiTrackMix";
import type { ExportAudioMuxerCodec, VideoMuxer } from "./muxer";

// Re-exported for backwards compatibility with existing consumers/tests.
export {
	downmixPlanarChannelsForExport,
	type MixAudioTimelineOptions,
	type MixableAudioFrame,
	mixAudioTrackFrames,
};

const AUDIO_BITRATE = 128_000;
const DECODE_BACKPRESSURE_LIMIT = 20;
const MIN_SPEED_REGION_DELTA_MS = 0.0001;
const SEEK_TIMEOUT_MS = 5_000;

export interface ExportAudioCodec {
	encoderCodec: string;
	muxerCodec: ExportAudioMuxerCodec;
	label: string;
	sampleRate: number;
	numberOfChannels: number;
}

type ExportAudioCodecCandidate = Omit<ExportAudioCodec, "sampleRate" | "numberOfChannels">;

const EXPORT_AUDIO_CODECS: ExportAudioCodecCandidate[] = [
	{ encoderCodec: "mp4a.40.2", muxerCodec: "aac", label: "AAC" },
	{ encoderCodec: "opus", muxerCodec: "opus", label: "Opus" },
];

/** Lists every audio stream in the source, in file order. */
async function listAudioStreams(demuxer: WebDemuxer): Promise<WebAVStream[]> {
	const streams = await demuxer.getAVStreams();
	return streams.filter((stream) => stream.codec_type_string === "audio");
}

/** Extracts one decoded AudioData frame as planar f32 PCM. */
function audioDataToMixableFrame(data: AudioData): MixableAudioFrame {
	const frameCount = data.numberOfFrames;
	const planes: Float32Array[] = [];
	for (let channel = 0; channel < data.numberOfChannels; channel++) {
		const plane = new Float32Array(frameCount);
		data.copyTo(plane, { format: "f32-planar", planeIndex: channel });
		planes.push(plane);
	}
	return {
		timestampUs: data.timestamp,
		sampleRate: data.sampleRate,
		frameCount,
		planes,
	};
}

/** Packs a mixed frame into an AudioData the encoder accepts (planar f32). */
function mixableFrameToAudioData(frame: MixableAudioFrame): AudioData {
	const buffer = new Float32Array(frame.frameCount * frame.planes.length);
	for (let channel = 0; channel < frame.planes.length; channel++) {
		buffer.set(frame.planes[channel], channel * frame.frameCount);
	}
	return new AudioData({
		format: "f32-planar",
		sampleRate: frame.sampleRate,
		numberOfFrames: frame.frameCount,
		numberOfChannels: frame.planes.length,
		timestamp: frame.timestampUs,
		data: buffer.buffer,
	});
}

type ElementAudioTrackListLike = {
	length: number;
	[index: number]: { enabled: boolean };
};

type ElementWithAudioTracks = HTMLMediaElement & {
	audioTracks?: ElementAudioTrackListLike;
};

/**
 * Multi-track recordings (macOS ScreenCaptureKit writes system audio and the
 * microphone as separate tracks) only expose their first track through a media
 * element unless every track is enabled explicitly. Mirrors the editor preview
 * so timeline-rendered audio keeps every source.
 */
function enableAllElementAudioTracks(media: HTMLMediaElement): void {
	const audioTracks = (media as ElementWithAudioTracks).audioTracks;
	if (!audioTracks) return;
	for (let index = 0; index < audioTracks.length; index += 1) {
		audioTracks[index].enabled = true;
	}
}

export class AudioProcessor {
	private cancelled = false;

	static async selectSupportedExportCodec(
		sampleRate: number,
		numberOfChannels: number,
	): Promise<ExportAudioCodec | null> {
		const channelOptions = [numberOfChannels];
		if (numberOfChannels > 2) {
			channelOptions.push(2);
		}

		if (!channelOptions.includes(1)) {
			channelOptions.push(1);
		}

		for (const codec of EXPORT_AUDIO_CODECS) {
			for (const channels of channelOptions) {
				const support = await AudioEncoder.isConfigSupported({
					codec: codec.encoderCodec,
					sampleRate,
					numberOfChannels: channels,
					bitrate: AUDIO_BITRATE,
				});
				if (support.supported) {
					return { ...codec, sampleRate, numberOfChannels: channels };
				}
			}
		}

		return null;
	}

	static async selectSupportedExportCodecForSource(
		demuxer: WebDemuxer,
	): Promise<ExportAudioCodec | null> {
		const audioStreams = await listAudioStreams(demuxer);
		for (const stream of audioStreams) {
			const audioConfig = demuxer.genDecoderConfig("audio", stream);
			const codecCheck = await AudioDecoder.isConfigSupported(audioConfig);
			if (!codecCheck.supported) {
				console.warn("[AudioProcessor] Audio track codec not supported:", audioConfig.codec);
				continue;
			}

			return AudioProcessor.selectSupportedExportCodec(
				audioConfig.sampleRate || 48000,
				audioConfig.numberOfChannels || 2,
			);
		}

		return null;
	}

	/**
	 * Two modes: no speed regions uses the fast WebCodecs trim-only pipeline; speed
	 * regions use the pitch-preserving rendered timeline pipeline.
	 */
	async process(
		demuxer: WebDemuxer,
		muxer: VideoMuxer,
		videoUrl: string,
		trimRegions: TrimRegion[] | undefined,
		speedRegions: SpeedRegion[] | undefined,
		validatedDurationSec: number,
		exportCodec: ExportAudioCodec,
	): Promise<void> {
		const sortedTrims = trimRegions ? [...trimRegions].sort((a, b) => a.startMs - b.startMs) : [];
		const sortedSpeedRegions = speedRegions
			? [...speedRegions]
					.filter((region) => region.endMs - region.startMs > MIN_SPEED_REGION_DELTA_MS)
					.sort((a, b) => a.startMs - b.startMs)
			: [];

		// Speed edits need timeline playback to preserve pitch.
		if (sortedSpeedRegions.length > 0) {
			const renderedAudioBlob = await this.renderPitchPreservedTimelineAudio(
				videoUrl,
				sortedTrims,
				sortedSpeedRegions,
				validatedDurationSec,
			);
			if (!this.cancelled && renderedAudioBlob.size > 0) {
				await this.muxRenderedAudioBlob(renderedAudioBlob, muxer, exportCodec);
				return;
			}
			return;
		}

		// No speed edits: demux/decode/encode with trim timestamp remap. The +0.5s mirrors
		// streamingDecoder.decodeAll's read window so both paths read the same distance past
		// the validated duration boundary.
		const readEndSec = validatedDurationSec + 0.5;
		await this.processTrimOnlyAudio(demuxer, muxer, sortedTrims, readEndSec, exportCodec);
	}

	// Trim-only path, used for projects without speed regions.
	private async processTrimOnlyAudio(
		demuxer: WebDemuxer,
		muxer: VideoMuxer,
		sortedTrims: TrimRegion[],
		readEndSec?: number,
		exportCodec?: ExportAudioCodec,
	): Promise<void> {
		// macOS ScreenCaptureKit recordings store system audio and the microphone
		// as separate audio tracks, and a plain "audio" read only yields the first
		// one. Decode every playable track so they can be mixed, matching the editor
		// preview (which plays every enabled track).
		const audioStreams = await listAudioStreams(demuxer);
		if (audioStreams.length === 0) {
			console.warn("[AudioProcessor] No audio track found, skipping");
			return;
		}

		const safeReadEndSec =
			typeof readEndSec === "number" && Number.isFinite(readEndSec)
				? Math.max(0, readEndSec)
				: undefined;

		const closeAllFrames = (tracks: AudioData[][]) => {
			for (const track of tracks) {
				for (const frame of track) frame.close();
			}
		};

		// Phase 1: decode every track, skipping trimmed regions.
		const trackFrames: AudioData[][] = [];
		let referenceConfig: AudioDecoderConfig | null = null;
		for (const stream of audioStreams) {
			const trackConfig = demuxer.genDecoderConfig("audio", stream);
			const codecCheck = await AudioDecoder.isConfigSupported(trackConfig);
			if (!codecCheck.supported) {
				console.warn(
					`[AudioProcessor] Audio track ${stream.index} codec ${trackConfig.codec} not supported, skipping track`,
				);
				continue;
			}

			const frames = await this.decodeAudioTrack(
				demuxer,
				stream.index,
				trackConfig,
				sortedTrims,
				safeReadEndSec,
			);
			if (frames.length === 0) continue;

			trackFrames.push(frames);
			referenceConfig ??= trackConfig;
		}

		if (this.cancelled) {
			closeAllFrames(trackFrames);
			return;
		}

		if (trackFrames.length === 0) {
			return;
		}

		// Phase 2: re-encode, mixing when the source has multiple audio tracks.
		const encodedChunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];

		const encoder = new AudioEncoder({
			output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
				encodedChunks.push({ chunk, meta });
			},
			error: (e: DOMException) => console.error("[AudioProcessor] Encode error:", e),
		});

		const sampleRate = referenceConfig?.sampleRate || 48000;
		const channels = referenceConfig?.numberOfChannels || 2;
		const selectedCodec =
			exportCodec ?? (await AudioProcessor.selectSupportedExportCodec(sampleRate, channels));
		if (!selectedCodec) {
			console.warn("[AudioProcessor] No supported audio export codec, skipping audio");
			closeAllFrames(trackFrames);
			return;
		}

		const outputSampleRate = selectedCodec.sampleRate || sampleRate;
		const outputChannels = selectedCodec.numberOfChannels || channels;
		const encodeConfig: AudioEncoderConfig = {
			codec: selectedCodec.encoderCodec,
			sampleRate: outputSampleRate,
			numberOfChannels: outputChannels,
			bitrate: AUDIO_BITRATE,
		};

		const encodeSupport = await AudioEncoder.isConfigSupported(encodeConfig);
		if (!encodeSupport.supported) {
			console.warn(
				`[AudioProcessor] ${selectedCodec.label} encoding not supported, skipping audio`,
			);
			closeAllFrames(trackFrames);
			return;
		}

		encoder.configure(encodeConfig);

		if (trackFrames.length === 1) {
			// Single track: remap each frame past the trim gaps like before.
			for (const audioData of trackFrames[0]) {
				if (this.cancelled) {
					audioData.close();
					continue;
				}

				const timestampMs = audioData.timestamp / 1000;
				const trimOffsetMs = this.computeTrimOffset(timestampMs, sortedTrims);
				const adjustedTimestampUs = audioData.timestamp - trimOffsetMs * 1000;

				const adjusted = this.cloneForEncoding(
					audioData,
					Math.max(0, adjustedTimestampUs),
					outputChannels,
				);
				audioData.close();

				encoder.encode(adjusted);
				adjusted.close();
			}
		} else {
			// Multiple tracks: mix onto one timeline. The mixer already collapses
			// trim regions, so its chunk timestamps are final.
			const mixableTracks = trackFrames.map((track) => {
				const mixable = track.map((frame) => audioDataToMixableFrame(frame));
				for (const frame of track) frame.close();
				return mixable;
			});
			const mixedFrames = mixAudioTrackFrames(mixableTracks, {
				targetSampleRate: outputSampleRate,
				targetChannels: outputChannels,
				trimRegions: sortedTrims,
			});

			for (const frame of mixedFrames) {
				if (this.cancelled) break;
				const chunk = mixableFrameToAudioData(frame);
				encoder.encode(chunk);
				chunk.close();
			}
		}

		if (encoder.state === "configured") {
			await encoder.flush();
			encoder.close();
		}

		// Phase 3: flush encoded chunks to muxer.
		for (const { chunk, meta } of encodedChunks) {
			if (this.cancelled) break;
			await muxer.addAudioChunk(chunk, meta);
		}

		const decodedFrameCount = trackFrames.reduce((total, track) => total + track.length, 0);
		console.log(
			`[AudioProcessor] Processed ${decodedFrameCount} audio frames across ${trackFrames.length} track(s), encoded ${encodedChunks.length} chunks`,
		);
	}

	/**
	 * Decodes one audio track start-to-end, dropping packets inside trim regions.
	 * The caller owns (and must close) the returned frames.
	 */
	private async decodeAudioTrack(
		demuxer: WebDemuxer,
		streamIndex: number,
		audioConfig: AudioDecoderConfig,
		sortedTrims: TrimRegion[],
		readEndSec?: number,
	): Promise<AudioData[]> {
		const decodedFrames: AudioData[] = [];
		const decoder = new AudioDecoder({
			output: (data: AudioData) => decodedFrames.push(data),
			error: (e: DOMException) => console.error("[AudioProcessor] Decode error:", e),
		});
		decoder.configure(audioConfig);

		const packets = demuxer.readAVPacket(
			0,
			readEndSec,
			AVMediaType.AVMEDIA_TYPE_AUDIO,
			streamIndex,
		);
		const reader = packets.getReader();

		try {
			while (!this.cancelled) {
				const { done, value: packet } = await reader.read();
				if (done || !packet) break;

				// WebAVPacket timestamps are seconds; trims are milliseconds.
				const timestampMs = packet.timestamp * 1000;
				if (this.isInTrimRegion(timestampMs, sortedTrims)) continue;

				decoder.decode(demuxer.genEncodedChunk("audio", packet));

				while (decoder.decodeQueueSize > DECODE_BACKPRESSURE_LIMIT && !this.cancelled) {
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
			}
		} finally {
			try {
				await reader.cancel();
			} catch {
				/* reader already closed */
			}
		}

		if (decoder.state === "configured") {
			await decoder.flush();
			decoder.close();
		}

		if (this.cancelled) {
			for (const frame of decodedFrames) frame.close();
			return [];
		}

		return decodedFrames;
	}

	// Speed-aware path mirroring preview semantics (trim skipping + playbackRate). Relies on
	// browser media playback to preserve pitch and avoid the chipmunk effect.
	private async renderPitchPreservedTimelineAudio(
		videoUrl: string,
		trimRegions: TrimRegion[],
		speedRegions: SpeedRegion[],
		validatedDurationSec: number,
	): Promise<Blob> {
		const media = document.createElement("audio");
		media.src = videoUrl;
		media.preload = "auto";

		const pitchMedia = media as HTMLMediaElement & {
			preservesPitch?: boolean;
			mozPreservesPitch?: boolean;
			webkitPreservesPitch?: boolean;
		};
		pitchMedia.preservesPitch = true;
		pitchMedia.mozPreservesPitch = true;
		pitchMedia.webkitPreservesPitch = true;

		await this.waitForLoadedMetadata(media);
		if (this.cancelled) {
			throw new Error("Export cancelled");
		}

		// Play every audio track so multi-track sources keep their audio here too.
		enableAllElementAudioTracks(media);

		const audioContext = new AudioContext();
		const sourceNode = audioContext.createMediaElementSource(media);
		const destinationNode = audioContext.createMediaStreamDestination();
		sourceNode.connect(destinationNode);

		let rafId: number | null = null;
		let recorder: MediaRecorder | null = null;
		let recordedBlobPromise: Promise<Blob> | null = null;

		try {
			if (audioContext.state === "suspended") {
				await audioContext.resume();
			}

			// Skip initial trim region(s) before recording so the first rAF frames don't
			// capture trimmed audio. Loops to handle back-to-back/overlapping trims at t=0.
			const effectiveEnd = validatedDurationSec;
			let startPosition = 0;
			for (let i = 0; i <= trimRegions.length; i++) {
				const activeTrim = this.findActiveTrimRegion(startPosition * 1000, trimRegions);
				if (!activeTrim) break;
				startPosition = activeTrim.endMs / 1000;
				if (startPosition >= effectiveEnd) break;
			}

			if (startPosition >= effectiveEnd) {
				// Everything is trimmed; return a silent blob.
				return new Blob([], { type: "audio/webm" });
			}

			await this.seekTo(media, startPosition);

			// Set initial playback rate for the starting position.
			const initialSpeedRegion = this.findActiveSpeedRegion(startPosition * 1000, speedRegions);
			if (initialSpeedRegion) {
				media.playbackRate = initialSpeedRegion.speed;
			}

			// Start recording only after seeking past trims.
			const recording = this.startAudioRecording(destinationNode.stream);
			recorder = recording.recorder;
			recordedBlobPromise = recording.recordedBlobPromise;
			await media.play();

			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					if (rafId !== null) {
						cancelAnimationFrame(rafId);
						rafId = null;
					}
					media.removeEventListener("error", onError);
					media.removeEventListener("ended", onEnded);
				};

				const onError = () => {
					cleanup();
					reject(new Error("Failed while rendering speed-adjusted audio timeline"));
				};

				const onEnded = () => {
					cleanup();
					resolve();
				};

				const tick = () => {
					if (this.cancelled) {
						cleanup();
						resolve();
						return;
					}

					// Stop at validated duration; media.duration can be inflated by bad
					// container metadata.
					if (media.currentTime >= validatedDurationSec) {
						media.pause();
						cleanup();
						resolve();
						return;
					}

					const currentTimeMs = media.currentTime * 1000;
					const activeTrimRegion = this.findActiveTrimRegion(currentTimeMs, trimRegions);

					if (activeTrimRegion && !media.paused && !media.ended) {
						const skipToTime = activeTrimRegion.endMs / 1000;
						if (skipToTime >= media.duration || skipToTime >= validatedDurationSec) {
							media.pause();
							cleanup();
							resolve();
							return;
						}
						// Pause recording during the seek so we don't capture silence/noise.
						media.pause();
						if (recorder?.state === "recording") recorder.pause();
						const onSeeked = () => {
							clearTimeout(seekTimer);
							if (this.cancelled) {
								cleanup();
								resolve();
								return;
							}
							if (recorder?.state === "paused") recorder.resume();
							media
								.play()
								.then(() => {
									if (!this.cancelled) rafId = requestAnimationFrame(tick);
								})
								.catch((err) => {
									cleanup();
									reject(
										new Error(
											`Failed to resume playback after trim seek: ${err instanceof Error ? err.message : String(err)}`,
										),
									);
								});
						};
						const seekTimer = window.setTimeout(() => {
							media.removeEventListener("seeked", onSeeked);
							cleanup();
							reject(new Error("Audio seek timed out while skipping trim region"));
						}, SEEK_TIMEOUT_MS);
						media.addEventListener("seeked", onSeeked, { once: true });
						media.currentTime = skipToTime;
						return;
					}

					const activeSpeedRegion = this.findActiveSpeedRegion(currentTimeMs, speedRegions);
					const playbackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1;
					if (Math.abs(media.playbackRate - playbackRate) > 0.0001) {
						media.playbackRate = playbackRate;
					}

					if (!media.paused && !media.ended) {
						rafId = requestAnimationFrame(tick);
					} else {
						cleanup();
						resolve();
					}
				};

				media.addEventListener("error", onError, { once: true });
				media.addEventListener("ended", onEnded, { once: true });
				rafId = requestAnimationFrame(tick);
			});
		} finally {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
			}
			media.pause();
			if (recorder && recorder.state !== "inactive") {
				recorder.stop();
			}
			destinationNode.stream.getTracks().forEach((track) => track.stop());
			sourceNode.disconnect();
			destinationNode.disconnect();
			await audioContext.close();
			media.src = "";
			media.load();
		}

		if (!recordedBlobPromise) {
			// Either an early return fired or startAudioRecording set this before playback
			// resolved. Reaching here means that broke; fail loud rather than return silence.
			throw new Error("Audio recorder finished without assigning recordedBlobPromise");
		}
		const recordedBlob = await recordedBlobPromise;
		if (this.cancelled) {
			throw new Error("Export cancelled");
		}
		return recordedBlob;
	}

	// Demux the rendered speed-adjusted blob and feed its chunks into the MP4 muxer.
	private async muxRenderedAudioBlob(
		blob: Blob,
		muxer: VideoMuxer,
		exportCodec: ExportAudioCodec,
	): Promise<void> {
		if (this.cancelled) return;

		const file = new File([blob], "speed-audio.webm", { type: blob.type || "audio/webm" });
		const wasmUrl = new URL("./wasm/web-demuxer.wasm", window.location.href).href;
		const demuxer = new WebDemuxer({ wasmFilePath: wasmUrl });

		try {
			await demuxer.load(file);
			await this.processTrimOnlyAudio(demuxer, muxer, [], undefined, exportCodec);
		} finally {
			try {
				demuxer.destroy();
			} catch {
				/* ignore */
			}
		}
	}

	private startAudioRecording(stream: MediaStream): {
		recorder: MediaRecorder;
		recordedBlobPromise: Promise<Blob>;
	} {
		const mimeType = this.getSupportedAudioMimeType();
		const options: MediaRecorderOptions = {
			audioBitsPerSecond: AUDIO_BITRATE,
			...(mimeType ? { mimeType } : {}),
		};

		const recorder = new MediaRecorder(stream, options);
		const chunks: Blob[] = [];

		const recordedBlobPromise = new Promise<Blob>((resolve, reject) => {
			recorder.ondataavailable = (event: BlobEvent) => {
				if (event.data && event.data.size > 0) {
					chunks.push(event.data);
				}
			};
			recorder.onerror = () => {
				reject(new Error("MediaRecorder failed while capturing speed-adjusted audio"));
			};
			recorder.onstop = () => {
				const type = mimeType || chunks[0]?.type || "audio/webm";
				resolve(new Blob(chunks, { type }));
			};
		});

		recorder.start();
		return { recorder, recordedBlobPromise };
	}

	private getSupportedAudioMimeType(): string | undefined {
		const candidates = ["audio/webm;codecs=opus", "audio/webm"];
		for (const candidate of candidates) {
			if (MediaRecorder.isTypeSupported(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	private waitForLoadedMetadata(media: HTMLMediaElement): Promise<void> {
		if (Number.isFinite(media.duration) && media.readyState >= HTMLMediaElement.HAVE_METADATA) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			const onLoaded = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error("Failed to load media metadata for speed-adjusted audio"));
			};
			const cleanup = () => {
				media.removeEventListener("loadedmetadata", onLoaded);
				media.removeEventListener("error", onError);
			};

			media.addEventListener("loadedmetadata", onLoaded);
			media.addEventListener("error", onError, { once: true });
		});
	}

	private seekTo(media: HTMLMediaElement, targetSec: number): Promise<void> {
		if (Math.abs(media.currentTime - targetSec) < 0.0001) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			const onSeeked = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error("Failed to seek media for speed-adjusted audio"));
			};
			const cleanup = () => {
				media.removeEventListener("seeked", onSeeked);
				media.removeEventListener("error", onError);
			};

			media.addEventListener("seeked", onSeeked, { once: true });
			media.addEventListener("error", onError, { once: true });
			media.currentTime = targetSec;
		});
	}

	private findActiveTrimRegion(
		currentTimeMs: number,
		trimRegions: TrimRegion[],
	): TrimRegion | null {
		return (
			trimRegions.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	}

	private findActiveSpeedRegion(
		currentTimeMs: number,
		speedRegions: SpeedRegion[],
	): SpeedRegion | null {
		return (
			speedRegions.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	}

	private cloneForEncoding(
		src: AudioData,
		newTimestamp: number,
		targetChannels: number,
	): AudioData {
		if (targetChannels !== src.numberOfChannels) {
			return this.downmixWithTimestamp(src, newTimestamp, targetChannels);
		}

		if (!src.format) {
			throw new Error("AudioData format is required for cloning");
		}
		const isPlanar = src.format.includes("planar");
		const numPlanes = isPlanar ? src.numberOfChannels : 1;

		let totalSize = 0;
		for (let planeIndex = 0; planeIndex < numPlanes; planeIndex++) {
			totalSize += src.allocationSize({ planeIndex });
		}

		const buffer = new ArrayBuffer(totalSize);
		let offset = 0;
		for (let planeIndex = 0; planeIndex < numPlanes; planeIndex++) {
			const planeSize = src.allocationSize({ planeIndex });
			src.copyTo(new Uint8Array(buffer, offset, planeSize), { planeIndex });
			offset += planeSize;
		}

		return new AudioData({
			format: src.format,
			sampleRate: src.sampleRate,
			numberOfFrames: src.numberOfFrames,
			numberOfChannels: src.numberOfChannels,
			timestamp: newTimestamp,
			data: buffer,
		});
	}

	private downmixWithTimestamp(
		src: AudioData,
		newTimestamp: number,
		targetChannels: number,
	): AudioData {
		const sourceChannels = src.numberOfChannels;
		const frameCount = src.numberOfFrames;
		if (targetChannels < 1 || targetChannels > 2) {
			throw new Error(`Unsupported target channel count: ${targetChannels}`);
		}

		const sourcePlanes = Array.from({ length: sourceChannels }, () => new Float32Array(frameCount));
		for (let channel = 0; channel < sourceChannels; channel++) {
			src.copyTo(sourcePlanes[channel], {
				format: "f32-planar",
				planeIndex: channel,
			});
		}

		const output = downmixPlanarChannelsForExport(sourcePlanes, targetChannels);

		return new AudioData({
			format: "f32-planar",
			sampleRate: src.sampleRate,
			numberOfFrames: frameCount,
			numberOfChannels: targetChannels,
			timestamp: newTimestamp,
			data: output.buffer instanceof ArrayBuffer ? output.buffer : output.slice().buffer,
		});
	}

	private isInTrimRegion(timestampMs: number, trims: TrimRegion[]): boolean {
		return trims.some((trim) => timestampMs >= trim.startMs && timestampMs < trim.endMs);
	}

	private computeTrimOffset(timestampMs: number, trims: TrimRegion[]): number {
		let offset = 0;
		for (const trim of trims) {
			if (trim.endMs <= timestampMs) {
				offset += trim.endMs - trim.startMs;
			}
		}
		return offset;
	}

	cancel(): void {
		this.cancelled = true;
	}
}
