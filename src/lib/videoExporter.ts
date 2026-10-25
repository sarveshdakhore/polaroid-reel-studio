import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { PhotoItem } from "./defaultData";
import {
  buildPolaroidCard,
  PolaroidCardAsset,
  ReelRenderer,
  VIDEO_FPS,
  VIDEO_H,
  VIDEO_W,
} from "./polaroidEngine";
import { AUDIO_SR, synthesizeReelAudio } from "./audioEngine";

export interface ExportProgress {
  stage: "preparing" | "rendering" | "muxing" | "complete";
  currentFrame: number;
  totalFrames: number;
  percent: number;
  detail: string;
  fps?: number;
}

export function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

/**
 * Prepares all PolaroidCardAssets and initializes a ReelRenderer instance.
 */
export async function prepareReelRenderer(
  photos: PhotoItem[],
  grainSlider: number,
  onProgress?: (loaded: number, total: number) => void
): Promise<{
  cards: PolaroidCardAsset[];
  renderer: ReelRenderer;
}> {
  const cards: PolaroidCardAsset[] = [];
  for (let i = 0; i < photos.length; i++) {
    const item = photos[i];
    const img = await loadImageElement(item.url);
    const card = buildPolaroidCard(
      img,
      item.caption,
      item.cropY ?? 0.3,
      1000 + i,
      grainSlider
    );
    cards.push(card);
    if (onProgress) {
      onProgress(i + 1, photos.length);
    }
    // Yield briefly so UI stays responsive
    await new Promise((r) => setTimeout(r, 0));
  }

  const renderer = new ReelRenderer(cards, grainSlider);
  return { cards, renderer };
}

/**
 * Exports the full 1080x1920 30fps Polaroid Reel to an MP4 Blob (with synced audio)
 * entirely in the browser using WebCodecs + mp4-muxer (with MediaRecorder fallback).
 */
export async function exportPolaroidVideoMp4(options: {
  photos: PhotoItem[];
  grainSlider: number;
  previewCanvas?: HTMLCanvasElement | null;
  onProgress?: (prog: ExportProgress) => void;
  signal?: AbortSignal;
}): Promise<{ blob: Blob; filename: string; duration: number }> {
  const { photos, grainSlider, previewCanvas, onProgress, signal } = options;

  if (photos.length === 0) {
    throw new Error("Please add at least 1 photo to generate the video.");
  }

  onProgress?.({
    stage: "preparing",
    currentFrame: 0,
    totalFrames: 100,
    percent: 2,
    detail: `Developing & grading ${photos.length} Polaroid frames...`,
  });

  const { renderer } = await prepareReelRenderer(
    photos,
    grainSlider,
    (done, total) => {
      if (signal?.aborted) throw new Error("Export cancelled");
      onProgress?.({
        stage: "preparing",
        currentFrame: done,
        totalFrames: total,
        percent: Math.round((done / total) * 15),
        detail: `Grading Polaroid ${done} of ${total}...`,
      });
    }
  );

  if (signal?.aborted) throw new Error("Export cancelled");

  const totalFrames = renderer.totalFrames;
  const { pcm, duration } = synthesizeReelAudio(photos.length);

  // Check if WebCodecs VideoEncoder is supported
  const hasWebCodecs = typeof window !== "undefined" && "VideoEncoder" in window;

  if (hasWebCodecs) {
    return await encodeWithWebCodecs({
      renderer,
      pcm,
      duration,
      totalFrames,
      previewCanvas,
      onProgress,
      signal,
    });
  }

  throw new Error(
    "Your browser does not support WebCodecs VideoEncoder. Please use Chrome, Edge, Safari, Brave, or Arc."
  );
}

async function encodeWithWebCodecs(params: {
  renderer: ReelRenderer;
  pcm: Float32Array;
  duration: number;
  totalFrames: number;
  previewCanvas?: HTMLCanvasElement | null;
  onProgress?: (prog: ExportProgress) => void;
  signal?: AbortSignal;
}): Promise<{ blob: Blob; filename: string; duration: number }> {
  const {
    renderer,
    pcm,
    duration,
    totalFrames,
    previewCanvas,
    onProgress,
    signal,
  } = params;

  // Negotiate H.264 codec profile at 1080x1920
  const candidateVideoCodecs = [
    "avc1.640028", // High Profile Level 4.0
    "avc1.4d002a", // Main Profile Level 4.2
    "avc1.420028", // Baseline Profile Level 4.0
    "avc1.42E01E",
  ];

  let chosenVideoCodec = "avc1.640028";
  for (const codec of candidateVideoCodecs) {
    try {
      const sup = await VideoEncoder.isConfigSupported({
        codec,
        width: VIDEO_W,
        height: VIDEO_H,
        bitrate: 14_000_000,
        framerate: VIDEO_FPS,
      });
      if (sup.supported) {
        chosenVideoCodec = codec;
        break;
      }
    } catch {
      // try next
    }
  }

  // Negotiate AudioEncoder support (AAC or Opus)
  let audioCodecType: "aac" | "opus" | null = null;
  let audioEncoderConfig: AudioEncoderConfig | null = null;

  if (typeof window !== "undefined" && "AudioEncoder" in window) {
    try {
      const aacSup = await AudioEncoder.isConfigSupported({
        codec: "mp4a.40.2",
        sampleRate: AUDIO_SR,
        numberOfChannels: 2,
        bitrate: 192_000,
      });
      if (aacSup.supported) {
        audioCodecType = "aac";
        audioEncoderConfig = {
          codec: "mp4a.40.2",
          sampleRate: AUDIO_SR,
          numberOfChannels: 2,
          bitrate: 192_000,
        };
      }
    } catch {
      // ignore
    }

    if (!audioCodecType) {
      try {
        const opusSup = await AudioEncoder.isConfigSupported({
          codec: "opus",
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: 128_000,
        });
        if (opusSup.supported) {
          audioCodecType = "opus";
          audioEncoderConfig = {
            codec: "opus",
            sampleRate: 48000,
            numberOfChannels: 2,
            bitrate: 128_000,
          };
        }
      } catch {
        // ignore
      }
    }
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: "avc",
      width: VIDEO_W,
      height: VIDEO_H,
    },
    ...(audioCodecType && audioEncoderConfig
      ? {
          audio: {
            codec: audioCodecType,
            sampleRate: audioEncoderConfig.sampleRate,
            numberOfChannels: 2,
          },
        }
      : {}),
    fastStart: "in-memory",
  });

  let encoderError: Error | null = null;

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (err) => {
      encoderError = err instanceof Error ? err : new Error(String(err));
    },
  });

  videoEncoder.configure({
    codec: chosenVideoCodec,
    width: VIDEO_W,
    height: VIDEO_H,
    bitrate: 14_000_000,
    framerate: VIDEO_FPS,
  });

  // Encode audio track if supported
  if (audioCodecType && audioEncoderConfig) {
    try {
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          muxer.addAudioChunk(chunk, meta);
        },
        error: (err) => {
          console.warn("AudioEncoder warning:", err);
        },
      });
      audioEncoder.configure(audioEncoderConfig);

      const targetSr = audioEncoderConfig.sampleRate;
      const numSamples =
        targetSr === AUDIO_SR
          ? pcm.length
          : Math.floor((pcm.length * targetSr) / AUDIO_SR);
      const chunkSize = 4096;

      for (let offset = 0; offset < numSamples; offset += chunkSize) {
        const len = Math.min(chunkSize, numSamples - offset);
        // Planar stereo f32-planar buffer
        const planar = new Float32Array(len * 2);
        for (let i = 0; i < len; i++) {
          const srcIdx =
            targetSr === AUDIO_SR
              ? offset + i
              : Math.min(
                  pcm.length - 1,
                  Math.floor(((offset + i) * AUDIO_SR) / targetSr)
                );
          const sample = pcm[srcIdx] ?? 0;
          planar[i] = sample; // Left
          planar[len + i] = sample; // Right
        }

        const timestampUs = Math.round((offset / targetSr) * 1_000_000);
        const audioData = new AudioData({
          format: "f32-planar",
          sampleRate: targetSr,
          numberOfFrames: len,
          numberOfChannels: 2,
          timestamp: timestampUs,
          data: planar,
        });
        audioEncoder.encode(audioData);
        audioData.close();
      }

      await audioEncoder.flush();
      audioEncoder.close();
    } catch (audioErr) {
      console.warn("Skipping audio encoding due to error:", audioErr);
    }
  }

  const renderCanvas = document.createElement("canvas");
  renderCanvas.width = VIDEO_W;
  renderCanvas.height = VIDEO_H;

  renderer.resetPile();
  const startTimeMs = performance.now();

  for (let f = 0; f < totalFrames; f++) {
    if (signal?.aborted) {
      videoEncoder.close();
      throw new Error("Export cancelled");
    }
    if (encoderError) {
      throw encoderError;
    }

    renderer.renderFrame(f, renderCanvas);

    // Mirror onto live preview canvas if provided
    if (previewCanvas && f % 2 === 0) {
      const pCtx = previewCanvas.getContext("2d");
      if (pCtx) {
        pCtx.drawImage(
          renderCanvas,
          0,
          0,
          previewCanvas.width,
          previewCanvas.height
        );
      }
    }

    const timestampUs = Math.round((f / VIDEO_FPS) * 1_000_000);
    const durationUs = Math.round((1 / VIDEO_FPS) * 1_000_000);
    const vf = new VideoFrame(renderCanvas, {
      timestamp: timestampUs,
      duration: durationUs,
    });

    const isKeyFrame = f % 30 === 0;
    videoEncoder.encode(vf, { keyFrame: isKeyFrame });
    vf.close();

    // Respect encoder queue backpressure
    while (videoEncoder.encodeQueueSize > 12) {
      await new Promise((r) => setTimeout(r, 4));
    }

    if (f % 8 === 0 || f === totalFrames - 1) {
      const elapsedSec = Math.max(0.1, (performance.now() - startTimeMs) / 1000);
      const currentFps = Math.round((f + 1) / elapsedSec);
      const pct = 15 + Math.round(((f + 1) / totalFrames) * 82);
      onProgress?.({
        stage: "rendering",
        currentFrame: f + 1,
        totalFrames,
        percent: pct,
        fps: currentFps,
        detail: `Rendering frame ${f + 1} / ${totalFrames} (${currentFps} fps)`,
      });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  onProgress?.({
    stage: "muxing",
    currentFrame: totalFrames,
    totalFrames,
    percent: 98,
    detail: "Finalizing MP4 container (+faststart)...",
  });

  await videoEncoder.flush();
  videoEncoder.close();
  muxer.finalize();

  const buffer = target.buffer;
  const blob = new Blob([buffer], { type: "video/mp4" });

  onProgress?.({
    stage: "complete",
    currentFrame: totalFrames,
    totalFrames,
    percent: 100,
    detail: `Completed! (${(blob.size / (1024 * 1024)).toFixed(1)} MB MP4)`,
  });

  return {
    blob,
    filename: `polaroid_reel_${Date.now()}.mp4`,
    duration,
  };
}
