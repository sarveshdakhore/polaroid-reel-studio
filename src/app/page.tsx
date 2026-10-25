"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Upload,
  Sparkles,
  Film,
  Play,
  Pause,
  RotateCcw,
  Download,
  Trash2,
  Lock,
  Unlock,
  ArrowLeft,
  ArrowRight,
  Shuffle,
  CheckCircle2,
  AlertTriangle,
  Eye,
  EyeOff,
  Sliders,
  Volume2,
  VolumeX,
  Plus,
  RefreshCw,
  GripVertical,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  PhotoItem,
  GRAIN_PRESETS,
  STORY_PRESETS,
} from "@/lib/defaultData";
import {
  EFFECTS,
  INTRO,
  STEP,
  LIFE,
  OUTRO,
  VIDEO_FPS,
  VIDEO_H,
  VIDEO_W,
  ReelRenderer,
  getGrainParams,
} from "@/lib/polaroidEngine";
import {
  prepareReelRenderer,
  exportPolaroidVideoMp4,
  ExportProgress,
} from "@/lib/videoExporter";
import {
  generatePolaroidStoryWithGemini,
  enforceDistinctStoryCaptions,
} from "@/lib/geminiStory";
import { processUploadedFiles } from "@/lib/fileLoader";
import { synthesizeReelAudio } from "@/lib/audioEngine";

const GEMINI_KEY_STORAGE = "polaroid_reel_gemini_api_key";

export default function PolaroidReelStudioPage() {
  // 1. Photo sequence state (starts empty — user uploads their own photos)
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [expandedCropId, setExpandedCropId] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  // 2. Graininess ("gradiness") state (0..100; 25 = Less Grain Reel B, 75 = High Grain Reel A)
  const [grainSlider, setGrainSlider] = useState<number>(25);

  // 3. Gemini AI Story Generator state
  const [geminiKey, setGeminiKey] = useState<string>("");
  const [showKey, setShowKey] = useState<boolean>(false);
  const [storyPrompt, setStoryPrompt] = useState<string>(
    STORY_PRESETS[0].prompt
  );
  const [activePresetId, setActivePresetId] = useState<string>(
    STORY_PRESETS[0].id
  );
  const [isGeneratingStory, setIsGeneratingStory] = useState<boolean>(false);
  const [storyError, setStoryError] = useState<string | null>(null);
  const [storyResultMeta, setStoryResultMeta] = useState<{
    title: string;
    summary: string;
    model: string;
  } | null>(null);

  // 4. Live Preview Player state
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ReelRenderer | null>(null);
  const [isPreparingPreview, setIsPreparingPreview] = useState<boolean>(false);
  const [previewPrepProgress, setPreviewPrepProgress] = useState<string>("");
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentFrame, setCurrentFrame] = useState<number>(
    Math.floor((INTRO + 0.9) * VIDEO_FPS)
  );
  const [isMuted, setIsMuted] = useState<boolean>(false);

  // Web Audio refs for live preview playback
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const playStartWallRef = useRef<number>(0);
  const playStartOffsetSecRef = useRef<number>(0);

  // 5. MP4 Export state
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(
    null
  );
  const [exportedVideoUrl, setExportedVideoUrl] = useState<string | null>(null);
  const [exportedFilename, setExportedFilename] = useState<string>(
    "polaroid_reel.mp4"
  );
  const [exportedSizeMb, setExportedSizeMb] = useState<string>("");
  const [exportError, setExportError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Load saved Gemini key from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(GEMINI_KEY_STORAGE);
      if (saved) setGeminiKey(saved);
    } catch {
      // ignore
    }
  }, []);

  const handleGeminiKeyChange = (val: string) => {
    setGeminiKey(val);
    try {
      if (val.trim()) {
        localStorage.setItem(GEMINI_KEY_STORAGE, val.trim());
      } else {
        localStorage.removeItem(GEMINI_KEY_STORAGE);
      }
    } catch {
      // ignore
    }
  };

  // Timeline calculations matching render.py
  const totalDuration = useMemo(() => {
    const N = Math.max(1, photos.length);
    return INTRO + (N - 1) * STEP + LIFE + OUTRO;
  }, [photos.length]);

  const totalFrames = useMemo(
    () => Math.floor(totalDuration * VIDEO_FPS),
    [totalDuration]
  );

  const grainParams = useMemo(
    () => getGrainParams(grainSlider),
    [grainSlider]
  );

  // Check if all captions are 100% distinct
  const captionStats = useMemo(() => {
    const counts = new Map<string, number>();
    let emptyCount = 0;
    for (const p of photos) {
      const norm = p.caption.trim().toLowerCase();
      if (!norm) {
        emptyCount++;
      } else {
        counts.set(norm, (counts.get(norm) || 0) + 1);
      }
    }
    const duplicateSet = new Set<string>();
    for (const [k, c] of counts.entries()) {
      if (c > 1) duplicateSet.add(k);
    }
    return {
      isAllDistinct: duplicateSet.size === 0 && emptyCount === 0,
      duplicateSet,
      duplicateCount: duplicateSet.size,
      emptyCount,
    };
  }, [photos]);

  // Stop preview audio helper
  const stopPreviewAudio = useCallback(() => {
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
        audioSourceRef.current.disconnect();
      } catch {
        // ignore
      }
      audioSourceRef.current = null;
    }
  }, []);

  // Rebuild live preview renderer whenever photos or grainSlider change (debounced)
  useEffect(() => {
    if (isExporting) return;
    if (photos.length === 0) {
      rendererRef.current = null;
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setIsPreparingPreview(true);
      try {
        const { renderer } = await prepareReelRenderer(
          photos,
          grainSlider,
          (done, tot) => {
            if (!cancelled) {
              setPreviewPrepProgress(`${done}/${tot}`);
            }
          }
        );
        if (cancelled) return;
        rendererRef.current = renderer;

        // Pre-build WebAudio buffer for live preview SFX
        const { pcm, sampleRate } = synthesizeReelAudio(photos.length);
        if (typeof window !== "undefined") {
          const Ctx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext })
              .webkitAudioContext;
          if (Ctx) {
            if (!audioCtxRef.current) {
              audioCtxRef.current = new Ctx();
            }
            const buf = audioCtxRef.current.createBuffer(
              1,
              pcm.length,
              sampleRate
            );
            buf.getChannelData(0).set(pcm);
            audioBufferRef.current = buf;
          }
        }

        // Render current frame immediately onto preview canvas
        if (previewCanvasRef.current) {
          const safeFrame = Math.min(currentFrame, renderer.totalFrames - 1);
          renderer.renderFrame(safeFrame, previewCanvasRef.current);
        }
      } catch (err) {
        console.error("Preview build error:", err);
      } finally {
        if (!cancelled) {
          setIsPreparingPreview(false);
          setPreviewPrepProgress("");
        }
      }
    }, 240);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [photos, grainSlider, isExporting]);

  // Render single frame when scrubbing while paused
  useEffect(() => {
    if (isPlaying || isExporting) return;
    const renderer = rendererRef.current;
    const canvas = previewCanvasRef.current;
    if (renderer && canvas) {
      const safeFrame = Math.max(
        0,
        Math.min(currentFrame, renderer.totalFrames - 1)
      );
      renderer.renderFrame(safeFrame, canvas);
    }
  }, [currentFrame, isPlaying, isExporting]);

  // Handle live preview Play / Pause loop
  const startPlayback = useCallback(
    (startFrameOverride?: number) => {
      const renderer = rendererRef.current;
      if (!renderer) return;

      const startFrame =
        startFrameOverride !== undefined
          ? startFrameOverride
          : currentFrame >= renderer.totalFrames - 2
          ? 0
          : currentFrame;

      const offsetSec = startFrame / VIDEO_FPS;
      playStartOffsetSecRef.current = offsetSec;
      playStartWallRef.current = performance.now();

      stopPreviewAudio();
      if (!isMuted && audioCtxRef.current && audioBufferRef.current) {
        try {
          if (audioCtxRef.current.state === "suspended") {
            audioCtxRef.current.resume();
          }
          const src = audioCtxRef.current.createBufferSource();
          src.buffer = audioBufferRef.current;
          src.connect(audioCtxRef.current.destination);
          src.start(0, offsetSec);
          audioSourceRef.current = src;
        } catch {
          // ignore audio autoplay block
        }
      }

      setIsPlaying(true);
    },
    [currentFrame, isMuted, stopPreviewAudio]
  );

  const pausePlayback = useCallback(() => {
    setIsPlaying(false);
    stopPreviewAudio();
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  }, [stopPreviewAudio]);

  useEffect(() => {
    if (!isPlaying) return;

    const tick = () => {
      const renderer = rendererRef.current;
      const canvas = previewCanvasRef.current;
      if (!renderer || !canvas) {
        setIsPlaying(false);
        return;
      }

      const elapsedSec = (performance.now() - playStartWallRef.current) / 1000;
      const curSec = playStartOffsetSecRef.current + elapsedSec;
      const f = Math.floor(curSec * VIDEO_FPS);

      if (f >= renderer.totalFrames) {
        renderer.renderFrame(renderer.totalFrames - 1, canvas);
        setCurrentFrame(renderer.totalFrames - 1);
        pausePlayback();
        return;
      }

      renderer.renderFrame(f, canvas);
      setCurrentFrame(f);
      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [isPlaying, pausePlayback]);

  // Toggle mute during playback
  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (nextMuted) {
      stopPreviewAudio();
    } else if (isPlaying && audioCtxRef.current && audioBufferRef.current) {
      const offsetSec = currentFrame / VIDEO_FPS;
      const src = audioCtxRef.current.createBufferSource();
      src.buffer = audioBufferRef.current;
      src.connect(audioCtxRef.current.destination);
      src.start(0, offsetSec);
      audioSourceRef.current = src;
    }
  };

  // File upload handler (supports JPG, PNG, WebP, HEIC, HEIF)
  const handleFileUpload = async (
    fileList: FileList | null,
    mode: "append" | "replace"
  ) => {
    if (!fileList || fileList.length === 0) return;
    pausePlayback();
    const files = Array.from(fileList);

    const existingSet = new Set<string>(
      mode === "replace"
        ? []
        : photos.map((p) => p.caption.trim().toLowerCase())
    );
    const startIdx = mode === "replace" ? 0 : photos.length;

    setUploadStatus(`Loading ${files.length} photo(s)...`);
    try {
      const newItems = await processUploadedFiles(
        files,
        existingSet,
        startIdx,
        (cur, tot, name) => {
          setUploadStatus(`Processing ${cur}/${tot}: ${name}`);
        }
      );

      if (newItems.length > 0) {
        setPhotos((prev) =>
          mode === "replace" ? newItems : [...prev, ...newItems]
        );
        setCurrentFrame(Math.floor((INTRO + 0.9) * VIDEO_FPS));
      }
    } finally {
      setUploadStatus(null);
    }
  };

  // Drag and drop reordering handlers
  const handleDragStart = (idx: number) => {
    setDraggedIdx(idx);
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragOverIdx !== idx) {
      setDragOverIdx(idx);
    }
  };

  const handleDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === targetIdx) {
      setDraggedIdx(null);
      setDragOverIdx(null);
      return;
    }
    setPhotos((prev) => {
      const next = [...prev];
      const [moved] = next.splice(draggedIdx, 1);
      next.splice(targetIdx, 0, moved);
      return next;
    });
    setDraggedIdx(null);
    setDragOverIdx(null);
  };

  const movePhoto = (idx: number, delta: number) => {
    const target = idx + delta;
    if (target < 0 || target >= photos.length) return;
    setPhotos((prev) => {
      const next = [...prev];
      const tmp = next[idx];
      next[idx] = next[target];
      next[target] = tmp;
      return next;
    });
  };

  const removePhoto = (id: string) => {
    setPhotos((prev) => prev.filter((p) => p.id !== id));
  };

  const updatePhotoCaption = (id: string, caption: string) => {
    setPhotos((prev) =>
      prev.map((p) => (p.id === id ? { ...p, caption } : p))
    );
  };

  const toggleLockCaption = (id: string) => {
    setPhotos((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, lockedCaption: !p.lockedCaption } : p
      )
    );
  };

  const updatePhotoCropY = (id: string, cropY: number) => {
    setPhotos((prev) =>
      prev.map((p) => (p.id === id ? { ...p, cropY } : p))
    );
  };

  const shufflePhotoOrder = () => {
    pausePlayback();
    setPhotos((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
      }
      return next;
    });
  };

  const reversePhotoOrder = () => {
    pausePlayback();
    setPhotos((prev) => [...prev].reverse());
  };

  const deduplicateAllCaptions = () => {
    setPhotos((prev) => {
      const fixed = enforceDistinctStoryCaptions(
        prev.map((p) => p.caption),
        prev
      );
      return prev.map((p, i) => ({ ...p, caption: fixed[i] }));
    });
  };

  // Gemini AI Story Generation handler
  const handleGenerateStoryWithGemini = async () => {
    setStoryError(null);
    if (!geminiKey.trim()) {
      setStoryError(
        "Enter your Gemini API Key above to generate a connected story across all Polaroids."
      );
      return;
    }
    if (photos.length === 0) {
      setStoryError("Add at least 1 photo first.");
      return;
    }

    setIsGeneratingStory(true);
    pausePlayback();
    try {
      const res = await generatePolaroidStoryWithGemini({
        apiKey: geminiKey,
        photos,
        storyPrompt,
        previousCaptions: photos.map((p) => p.caption),
      });

      setPhotos((prev) =>
        prev.map((p, idx) => ({
          ...p,
          caption: res.captions[idx] ?? p.caption,
        }))
      );
      setStoryResultMeta({
        title: res.storyTitle,
        summary: res.storyArcSummary,
        model: res.modelUsed,
      });
    } catch (err) {
      setStoryError(
        err instanceof Error ? err.message : "Failed to generate story captions."
      );
    } finally {
      setIsGeneratingStory(false);
    }
  };

  // MP4 Video Export handler
  const handleExportMp4 = async () => {
    if (photos.length === 0) return;
    pausePlayback();
    setExportError(null);
    setIsExporting(true);

    if (exportedVideoUrl) {
      URL.revokeObjectURL(exportedVideoUrl);
      setExportedVideoUrl(null);
    }

    const ctrl = new AbortController();
    abortControllerRef.current = ctrl;

    try {
      const { blob, filename } = await exportPolaroidVideoMp4({
        photos,
        grainSlider,
        previewCanvas: previewCanvasRef.current,
        onProgress: (prog) => setExportProgress(prog),
        signal: ctrl.signal,
      });

      const url = URL.createObjectURL(blob);
      setExportedVideoUrl(url);
      setExportedFilename(filename);
      setExportedSizeMb((blob.size / (1024 * 1024)).toFixed(1));

      // Trigger automatic browser download
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "Export cancelled") {
        setExportError(msg);
      }
    } finally {
      setIsExporting(false);
      abortControllerRef.current = null;
    }
  };

  const cancelExport = () => {
    abortControllerRef.current?.abort();
  };

  // Jump preview to a specific photo's hero landing moment
  const jumpToPhotoMoment = (idx: number) => {
    pausePlayback();
    const targetSec = INTRO + idx * STEP + 0.85;
    const f = Math.min(totalFrames - 1, Math.floor(targetSec * VIDEO_FPS));
    setCurrentFrame(f);
  };

  // Which photo is currently center-stage in the preview player?
  const activeHeroIndex = useMemo(() => {
    const t = currentFrame / VIDEO_FPS;
    if (t < INTRO) return -1;
    const idx = Math.floor((t - INTRO) / STEP);
    if (idx >= 0 && idx < photos.length) return idx;
    return -1;
  }, [currentFrame, photos.length]);

  return (
    <div className="min-h-screen bg-[#111110] text-[#f4f0e6] flex flex-col">
      {/* TOP STUDIO HEADER BAR (SOLID FLAT DARKROOM THEME - ZERO GRADIENTS, ZERO PURPLE) */}
      <header className="sticky top-0 z-30 bg-[#191917] border-b border-[#2e2e2a] px-4 lg:px-8 py-3.5">
        <div className="max-w-[1600px] mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-9 h-9 bg-[#e85d04] text-[#111110] flex items-center justify-center font-mono-tech font-bold text-base border border-[#f4f0e6]">
              35
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="font-bold tracking-tight text-base sm:text-lg text-[#f4f0e6]">
                  POLAROID REEL STUDIO
                </h1>
                <span className="font-mono-tech text-[11px] uppercase px-2 py-0.5 bg-[#22221f] text-[#f59e0b] border border-[#43433d]">
                  1080×1920 // 30FPS
                </span>
              </div>
              <p className="text-xs text-[#a8a49b] hidden sm:block">
                Exact Instant-Film Grading, Physics Pile Toss, Story Captions &amp; Grain Control
              </p>
            </div>
          </div>

          {/* Live Status Telemetry & Primary Actions */}
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="font-mono-tech text-xs px-3 py-1.5 bg-[#111110] border border-[#2e2e2a] text-[#f4f0e6] flex items-center gap-2">
              <Film className="w-3.5 h-3.5 text-[#e85d04]" />
              <span>{photos.length} PHOTOS</span>
              <span className="text-[#706d65]">|</span>
              <span>{totalDuration.toFixed(1)}s</span>
            </div>

            {captionStats.isAllDistinct ? (
              <div className="font-mono-tech text-xs px-3 py-1.5 bg-[#111110] border border-[#10b981] text-[#10b981] flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>ALL CAPTIONS DISTINCT</span>
              </div>
            ) : (
              <button
                onClick={deduplicateAllCaptions}
                className="font-mono-tech text-xs px-3 py-1.5 bg-[#22221f] border border-[#f59e0b] text-[#f59e0b] hover:bg-[#f59e0b] hover:text-[#111110] transition-colors flex items-center gap-1.5 cursor-pointer"
                title="Click to automatically make all duplicate or empty captions 100% distinct"
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>
                  {captionStats.duplicateCount > 0
                    ? `${captionStats.duplicateCount} DUPLICATE(S) — FIX NOW`
                    : `${captionStats.emptyCount} EMPTY — AUTO FILL`}
                </span>
              </button>
            )}

            <label className="px-3.5 py-2 bg-[#22221f] hover:bg-[#2e2e2a] text-[#f4f0e6] border border-[#43433d] text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors">
              <Plus className="w-4 h-4 text-[#e85d04]" />
              <span>Add Photos</span>
              <input
                type="file"
                multiple
                accept="image/*,.heic,.heif"
                className="hidden"
                onChange={(e) => handleFileUpload(e.target.files, "append")}
              />
            </label>

            <label className="px-3.5 py-2 bg-[#22221f] hover:bg-[#2e2e2a] text-[#f4f0e6] border border-[#43433d] text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors">
              <Upload className="w-4 h-4 text-[#f59e0b]" />
              <span>Replace All</span>
              <input
                type="file"
                multiple
                accept="image/*,.heic,.heif"
                className="hidden"
                onChange={(e) => handleFileUpload(e.target.files, "replace")}
              />
            </label>

            <button
              onClick={handleExportMp4}
              disabled={isExporting || photos.length === 0}
              className="px-4 py-2 bg-[#e85d04] hover:bg-[#d45200] disabled:bg-[#2e2e2a] disabled:text-[#706d65] text-[#111110] font-bold text-xs uppercase tracking-wider border border-[#f4f0e6] flex items-center gap-2 cursor-pointer transition-colors"
            >
              <Download className="w-4 h-4" />
              <span>{isExporting ? "Rendering MP4..." : "Generate MP4 Video"}</span>
            </button>
          </div>
        </div>
      </header>

      {/* UPLOAD STATUS BANNER */}
      {uploadStatus && (
        <div className="bg-[#e85d04] text-[#111110] px-6 py-2 font-mono-tech text-xs font-bold flex items-center justify-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          <span>{uploadStatus}</span>
        </div>
      )}

      {/* MAIN TWO-COLUMN STUDIO WORKSPACE */}
      <main className="flex-1 max-w-[1600px] w-full mx-auto px-4 lg:px-8 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN (7 COLS): CONTROLS, GEMINI STORY DIRECTOR, GRAININESS, AND PHOTO SEQUENCER */}
        <div className="lg:col-span-7 xl:col-span-8 space-y-6">
          {/* PANEL 1: GEMINI STORY DIRECTOR & FILM GRAININESS */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* GEMINI AI STORY GENERATOR CARD */}
            <section className="bg-[#191917] border border-[#2e2e2a] p-5 flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-[#2e2e2a] pb-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-[#e85d04]" />
                    <h2 className="font-bold text-sm uppercase tracking-wider text-[#f4f0e6]">
                      Gemini Story Caption Director
                    </h2>
                  </div>
                  <span className="font-mono-tech text-[10px] px-2 py-0.5 bg-[#22221f] text-[#10b981] border border-[#10b981]">
                    NO PHOTO UPLOAD TO AI
                  </span>
                </div>

                <p className="text-xs text-[#a8a49b] leading-relaxed">
                  Generates a cohesive, chronological story across all{" "}
                  <strong className="text-[#f4f0e6]">{photos.length} Polaroids</strong>{" "}
                  in one narrative pass. Individual photos are never sent to the AI, and every caption is guaranteed{" "}
                  <strong className="text-[#f4f0e6]">100% distinct</strong>.
                </p>

                {/* API Key Input */}
                <div className="space-y-1.5">
                  <label className="block font-mono-tech text-[11px] uppercase text-[#a8a49b]">
                    Gemini API Key
                  </label>
                  <div className="flex items-center">
                    <input
                      type={showKey ? "text" : "password"}
                      value={geminiKey}
                      onChange={(e) => handleGeminiKeyChange(e.target.value)}
                      placeholder="AIzaSy... (stored locally in browser)"
                      className="w-full bg-[#111110] border border-[#43433d] focus:border-[#e85d04] px-3 py-2 text-xs font-mono-tech text-[#f4f0e6] outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="px-3 py-2 bg-[#22221f] border border-l-0 border-[#43433d] text-[#a8a49b] hover:text-[#f4f0e6] cursor-pointer"
                      title={showKey ? "Hide API Key" : "Show API Key"}
                    >
                      {showKey ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Story Vibe Presets */}
                <div className="space-y-1.5">
                  <label className="block font-mono-tech text-[11px] uppercase text-[#a8a49b]">
                    Story Arc Vibe / Plot
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {STORY_PRESETS.map((preset) => {
                      const active = activePresetId === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            setActivePresetId(preset.id);
                            setStoryPrompt(preset.prompt);
                          }}
                          className={`text-[11px] font-medium px-2.5 py-1 border transition-colors cursor-pointer ${
                            active
                              ? "bg-[#e85d04] text-[#111110] border-[#f4f0e6] font-bold"
                              : "bg-[#111110] text-[#a8a49b] border-[#2e2e2a] hover:border-[#43433d] hover:text-[#f4f0e6]"
                          }`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                  <textarea
                    rows={2}
                    value={storyPrompt}
                    onChange={(e) => {
                      setStoryPrompt(e.target.value);
                      setActivePresetId("custom");
                    }}
                    placeholder="Describe the story arc from Frame #1 to the finale..."
                    className="w-full bg-[#111110] border border-[#43433d] focus:border-[#e85d04] p-2.5 text-xs text-[#f4f0e6] outline-none resize-none"
                  />
                </div>
              </div>

              <div className="space-y-2.5 pt-1">
                {storyError && (
                  <div className="p-2.5 bg-[#111110] border border-[#e85d04] text-[#f59e0b] text-xs font-mono-tech">
                    {storyError}
                  </div>
                )}

                {storyResultMeta && (
                  <div className="p-2.5 bg-[#111110] border border-[#10b981] text-xs space-y-0.5">
                    <div className="flex items-center justify-between font-mono-tech text-[11px] text-[#10b981]">
                      <span>STORY: {storyResultMeta.title.toUpperCase()}</span>
                      <span>{storyResultMeta.model}</span>
                    </div>
                    <p className="text-[#a8a49b] text-[11px]">
                      {storyResultMeta.summary}
                    </p>
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleGenerateStoryWithGemini}
                  disabled={isGeneratingStory || photos.length === 0}
                  className="w-full py-2.5 px-4 bg-[#e85d04] hover:bg-[#d45200] disabled:bg-[#2e2e2a] disabled:text-[#706d65] text-[#111110] font-bold text-xs uppercase tracking-wider border border-[#f4f0e6] flex items-center justify-center gap-2 cursor-pointer transition-colors"
                >
                  {isGeneratingStory ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Writing {photos.length}-Part Polaroid Story...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>
                        Generate Distinct Story Captions ({photos.length} Frames)
                      </span>
                    </>
                  )}
                </button>
              </div>
            </section>

            {/* VIDEO GRAININESS ("GRADINESS") CONTROL CARD */}
            <section className="bg-[#191917] border border-[#2e2e2a] p-5 flex flex-col justify-between space-y-4">
              <div className="space-y-3.5">
                <div className="flex items-center justify-between border-b border-[#2e2e2a] pb-3">
                  <div className="flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-[#f59e0b]" />
                    <h2 className="font-bold text-sm uppercase tracking-wider text-[#f4f0e6]">
                      Film Graininess &amp; Stock Texture
                    </h2>
                  </div>
                  <span className="font-mono-tech text-xs px-2 py-0.5 bg-[#111110] text-[#e85d04] border border-[#43433d] font-bold">
                    {grainSlider}% GRAIN
                  </span>
                </div>

                <p className="text-xs text-[#a8a49b] leading-relaxed">
                  Controls the 3-layer analog grain model from{" "}
                  <code className="font-mono-tech text-[#f4f0e6]">polaroid.py</code>{" "}
                  and{" "}
                  <code className="font-mono-tech text-[#f4f0e6]">render.py</code>:
                  Polaroid print emulsion grain, dark tabletop noise, and 35mm film overlay.
                </p>

                {/* Preset Buttons */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {GRAIN_PRESETS.map((preset) => {
                    const isSelected = Math.abs(grainSlider - preset.value) <= 3;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setGrainSlider(preset.value)}
                        className={`p-2.5 text-left border transition-colors cursor-pointer flex flex-col justify-between ${
                          isSelected
                            ? "bg-[#22221f] border-[#e85d04] text-[#f4f0e6]"
                            : "bg-[#111110] border-[#2e2e2a] text-[#a8a49b] hover:border-[#43433d] hover:text-[#f4f0e6]"
                        }`}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="text-xs font-bold">{preset.label}</span>
                          <span
                            className={`font-mono-tech text-[10px] px-1.5 py-0.5 ${
                              isSelected
                                ? "bg-[#e85d04] text-[#111110] font-bold"
                                : "bg-[#191917] text-[#a8a49b]"
                            }`}
                          >
                            {preset.badge}
                          </span>
                        </div>
                        <span className="text-[11px] text-[#706d65] mt-1 line-clamp-1">
                          {preset.description}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Fine Slider */}
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between font-mono-tech text-[11px] text-[#a8a49b]">
                    <span>FINE GRAIN ADJUSTMENT</span>
                    <span className="text-[#f4f0e6]">{grainSlider}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={grainSlider}
                    onChange={(e) => setGrainSlider(Number(e.target.value))}
                    className="w-full studio-slider"
                  />
                  <div className="flex justify-between font-mono-tech text-[10px] text-[#706d65]">
                    <span>0% (Clean)</span>
                    <span>25% (Less Grain)</span>
                    <span>75% (High Grain)</span>
                    <span>100% (Max)</span>
                  </div>
                </div>
              </div>

              {/* Technical Telemetry Readout */}
              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-[#2e2e2a] font-mono-tech text-[11px]">
                <div className="bg-[#111110] p-2 border border-[#2e2e2a]">
                  <div className="text-[#706d65] text-[10px]">PRINT GRAIN</div>
                  <div className="text-[#f4f0e6] font-bold">
                    σ = {grainParams.printGrain.toFixed(3)}
                  </div>
                </div>
                <div className="bg-[#111110] p-2 border border-[#2e2e2a]">
                  <div className="text-[#706d65] text-[10px]">TABLE TEXTURE</div>
                  <div className="text-[#f4f0e6] font-bold">
                    σ = {grainParams.bgFine.toFixed(3)}
                  </div>
                </div>
                <div className="bg-[#111110] p-2 border border-[#2e2e2a]">
                  <div className="text-[#706d65] text-[10px]">35MM OVERLAY</div>
                  <div className="text-[#f4f0e6] font-bold">
                    σ = {grainParams.filmGrain.toFixed(1)}
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* PANEL 2: PHOTO SEQUENCE & POLAROID CAPTION STORYBOARD */}
          <section className="bg-[#191917] border border-[#2e2e2a] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2e2e2a] pb-4">
              <div>
                <h2 className="font-bold text-sm uppercase tracking-wider text-[#f4f0e6] flex items-center gap-2">
                  <span>Photo Order &amp; Handwritten Captions</span>
                  <span className="font-mono-tech text-xs px-2 py-0.5 bg-[#111110] border border-[#2e2e2a] text-[#f59e0b]">
                    DRAG CARDS TO REORDER
                  </span>
                </h2>
                <p className="text-xs text-[#a8a49b] mt-0.5">
                  Drag Polaroids to change sequence order, edit marker captions below each photo, or click lock to keep specific captions fixed during AI generation.
                </p>
              </div>

              {photos.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={shufflePhotoOrder}
                    className="px-3 py-1.5 bg-[#111110] hover:bg-[#22221f] text-[#f4f0e6] border border-[#43433d] text-xs font-mono-tech flex items-center gap-1.5 cursor-pointer"
                  >
                    <Shuffle className="w-3.5 h-3.5 text-[#f59e0b]" />
                    <span>Shuffle</span>
                  </button>
                  <button
                    type="button"
                    onClick={reversePhotoOrder}
                    className="px-3 py-1.5 bg-[#111110] hover:bg-[#22221f] text-[#f4f0e6] border border-[#43433d] text-xs font-mono-tech flex items-center gap-1.5 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5 text-[#a8a49b]" />
                    <span>Reverse</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      pausePlayback();
                      setPhotos([]);
                    }}
                    className="px-3 py-1.5 bg-[#111110] hover:bg-[#22221f] text-[#a8a49b] hover:text-[#e85d04] border border-[#2e2e2a] text-xs font-mono-tech flex items-center gap-1.5 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear All</span>
                  </button>
                </div>
              )}
            </div>

            {/* EMPTY STATE DROPZONE */}
            {photos.length === 0 ? (
              <label
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  handleFileUpload(e.dataTransfer.files, "replace");
                }}
                className="border-2 border-dashed border-[#43433d] hover:border-[#e85d04] bg-[#111110] p-12 text-center flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors"
              >
                <Upload className="w-10 h-10 text-[#e85d04]" />
                <div className="space-y-1">
                  <div className="font-bold text-sm text-[#f4f0e6]">
                    Drop Photos Here (JPG, PNG, WebP, or iPhone .HEIC)
                  </div>
                  <div className="text-xs text-[#a8a49b]">
                    Or click to browse files from your device to start your Polaroid reel
                  </div>
                </div>
                <input
                  type="file"
                  multiple
                  accept="image/*,.heic,.heif"
                  className="hidden"
                  onChange={(e) => handleFileUpload(e.target.files, "replace")}
                />
              </label>
            ) : (
              /* POLAROID STORYBOARD GRID */
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {photos.map((photo, idx) => {
                  const fx = idx === 0 ? "develop" : EFFECTS[idx % EFFECTS.length];
                  const timestampSec = (INTRO + idx * STEP).toFixed(1);
                  const normCap = photo.caption.trim().toLowerCase();
                  const isDuplicate =
                    normCap.length > 0 &&
                    captionStats.duplicateSet.has(normCap);
                  const isCurrentlyActive = activeHeroIndex === idx;
                  const isDragTarget = dragOverIdx === idx;
                  const showCropSlider = expandedCropId === photo.id;

                  return (
                    <div
                      key={photo.id}
                      draggable
                      onDragStart={() => handleDragStart(idx)}
                      onDragOver={(e) => handleDragOver(e, idx)}
                      onDrop={(e) => handleDrop(e, idx)}
                      onDragEnd={() => {
                        setDraggedIdx(null);
                        setDragOverIdx(null);
                      }}
                      className={`p-3 bg-[#111110] border transition-colors flex flex-col justify-between ${
                        isDragTarget
                          ? "border-[#e85d04] bg-[#22221f]"
                          : isCurrentlyActive
                          ? "border-[#10b981]"
                          : isDuplicate
                          ? "border-[#f59e0b]"
                          : "border-[#2e2e2a] hover:border-[#43433d]"
                      }`}
                    >
                      {/* Card Top Control Bar */}
                      <div className="flex items-center justify-between gap-1 mb-2.5">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="cursor-grab active:cursor-grabbing text-[#706d65] hover:text-[#f4f0e6]"
                            title="Drag to reorder"
                          >
                            <GripVertical className="w-4 h-4" />
                          </span>
                          <span className="font-mono-tech text-xs font-bold px-2 py-0.5 bg-[#e85d04] text-[#111110]">
                            #{String(idx + 1).padStart(2, "0")}
                          </span>
                          <span className="font-mono-tech text-[10px] px-1.5 py-0.5 bg-[#191917] text-[#a8a49b] border border-[#2e2e2a] uppercase">
                            {fx}
                          </span>
                          <span className="font-mono-tech text-[10px] text-[#706d65]">
                            {timestampSec}s
                          </span>
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => movePhoto(idx, -1)}
                            disabled={idx === 0}
                            className="p-1 bg-[#191917] hover:bg-[#22221f] disabled:opacity-30 text-[#a8a49b] hover:text-[#f4f0e6] border border-[#2e2e2a] cursor-pointer"
                            title="Move earlier in order"
                          >
                            <ArrowLeft className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => movePhoto(idx, 1)}
                            disabled={idx === photos.length - 1}
                            className="p-1 bg-[#191917] hover:bg-[#22221f] disabled:opacity-30 text-[#a8a49b] hover:text-[#f4f0e6] border border-[#2e2e2a] cursor-pointer"
                            title="Move later in order"
                          >
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedCropId(showCropSlider ? null : photo.id)
                            }
                            className={`p-1 border cursor-pointer ${
                              showCropSlider
                                ? "bg-[#e85d04] text-[#111110] border-[#f4f0e6]"
                                : "bg-[#191917] text-[#a8a49b] hover:text-[#f4f0e6] border-[#2e2e2a]"
                            }`}
                            title="Adjust vertical crop focus (CROP_Y)"
                          >
                            <SlidersHorizontal className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removePhoto(photo.id)}
                            className="p-1 bg-[#191917] hover:bg-[#e85d04] text-[#a8a49b] hover:text-[#111110] border border-[#2e2e2a] cursor-pointer"
                            title="Remove photo"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Tactile Physical Polaroid Frame Preview */}
                      <div className="bg-[#f3f0e8] p-2.5 pb-4 text-[#292b4d] shadow-md">
                        <div
                          onClick={() => jumpToPhotoMoment(idx)}
                          className="relative w-full aspect-square bg-[#22221f] overflow-hidden border border-[#bdb8ab] cursor-pointer group"
                          title="Click to preview this Polaroid drop in the video player"
                        >
                          <img
                            src={photo.url}
                            alt={photo.name}
                            style={{
                              objectPosition: `50% ${Math.round(
                                (photo.cropY ?? 0.3) * 100
                              )}%`,
                            }}
                            className="w-full h-full object-cover contrast-105 sepia-[0.12] brightness-95"
                          />
                          <div className="absolute inset-0 bg-[#111110]/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <span className="font-mono-tech text-[11px] uppercase px-2.5 py-1 bg-[#e85d04] text-[#111110] font-bold border border-[#f4f0e6]">
                              Preview Frame #{idx + 1}
                            </span>
                          </div>
                        </div>

                        {/* Vertical Crop Y Slider (when toggled open) */}
                        {showCropSlider && (
                          <div className="mt-2 p-2 bg-[#191917] text-[#f4f0e6] border border-[#2e2e2a]">
                            <div className="flex justify-between font-mono-tech text-[10px] text-[#a8a49b] mb-1">
                              <span>VERTICAL CROP (CROP_Y)</span>
                              <span>{Math.round((photo.cropY ?? 0.3) * 100)}%</span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={photo.cropY ?? 0.3}
                              onChange={(e) =>
                                updatePhotoCropY(photo.id, Number(e.target.value))
                              }
                              className="w-full studio-slider"
                            />
                          </div>
                        )}

                        {/* Handwritten Marker Caption Input on the Polaroid Chin */}
                        <div className="mt-2.5 flex items-center gap-1.5 border-b border-[#d8d3c5] pb-1">
                          <input
                            type="text"
                            maxLength={28}
                            value={photo.caption}
                            onChange={(e) =>
                              updatePhotoCaption(photo.id, e.target.value)
                            }
                            placeholder="write marker caption..."
                            className="w-full bg-transparent text-[#292b4d] font-handwriting text-xl font-bold text-center outline-none placeholder:text-[#9c988d]"
                          />
                          <button
                            type="button"
                            onClick={() => toggleLockCaption(photo.id)}
                            className={`p-1 cursor-pointer ${
                              photo.lockedCaption
                                ? "text-[#e85d04]"
                                : "text-[#9c988d] hover:text-[#292b4d]"
                            }`}
                            title={
                              photo.lockedCaption
                                ? "Caption locked (kept during Gemini story generation)"
                                : "Lock caption so AI won't overwrite it"
                            }
                          >
                            {photo.lockedCaption ? (
                              <Lock className="w-3.5 h-3.5" />
                            ) : (
                              <Unlock className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>

                        {/* Filename & Duplicate Warning */}
                        <div className="mt-1.5 flex items-center justify-between font-mono-tech text-[10px] text-[#706d65]">
                          <span className="truncate max-w-[160px]">
                            {photo.name}
                          </span>
                          {isDuplicate ? (
                            <span className="text-[#e85d04] font-bold">
                              DUPLICATE TEXT
                            </span>
                          ) : (
                            <span>{photo.caption.length}/28</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* RIGHT STICKY COLUMN (5 COLS): LIVE 9:16 CANVAS PREVIEW & MP4 VIDEO GENERATOR */}
        <div className="lg:col-span-5 xl:col-span-4 lg:sticky lg:top-20 space-y-5">
          <section className="bg-[#191917] border border-[#2e2e2a] p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[#2e2e2a] pb-3">
              <div className="flex items-center gap-2">
                <Film className="w-4 h-4 text-[#e85d04]" />
                <h2 className="font-bold text-sm uppercase tracking-wider text-[#f4f0e6]">
                  Live 9:16 Polaroid Reel Monitor
                </h2>
              </div>
              <span className="font-mono-tech text-[11px] text-[#a8a49b]">
                {photos.length > 0
                  ? `Frame ${currentFrame} / ${totalFrames}`
                  : "Standby"}
              </span>
            </div>

            {/* 9:16 Portrait Monitor Container */}
            <div className="relative mx-auto w-full max-w-[330px] aspect-[9/16] bg-[#111110] border-2 border-[#43433d] overflow-hidden">
              <canvas
                ref={previewCanvasRef}
                width={VIDEO_W}
                height={VIDEO_H}
                className="w-full h-full object-contain block"
              />

              {/* Empty State Monitor Standby Overlay */}
              {photos.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-[#111110]">
                  <Film className="w-8 h-8 text-[#706d65] mb-2" />
                  <div className="font-mono-tech text-xs text-[#f4f0e6] uppercase">
                    No Photos Loaded
                  </div>
                  <p className="text-[11px] text-[#706d65] mt-1">
                    Add photos on the left to preview the 1080×1920 Polaroid reel
                  </p>
                </div>
              )}

              {/* Preparing Overlay */}
              {isPreparingPreview && !isExporting && (
                <div className="absolute inset-x-0 top-3 mx-3 bg-[#191917] border border-[#e85d04] px-3 py-1.5 flex items-center justify-between font-mono-tech text-[11px] text-[#f4f0e6]">
                  <span className="flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 text-[#e85d04] animate-spin" />
                    Grading Polaroids...
                  </span>
                  <span className="text-[#f59e0b]">{previewPrepProgress}</span>
                </div>
              )}

              {/* Current Active Hero Overlay Badge */}
              {activeHeroIndex >= 0 && photos[activeHeroIndex] && !isExporting && (
                <div className="absolute bottom-3 left-3 right-3 bg-[#111110]/90 border border-[#2e2e2a] px-3 py-1.5 flex items-center justify-between font-mono-tech text-[11px]">
                  <span className="text-[#e85d04] font-bold">
                    #{String(activeHeroIndex + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[#f4f0e6] truncate px-2">
                    &ldquo;{photos[activeHeroIndex].caption}&rdquo;
                  </span>
                  <span className="text-[#a8a49b] uppercase text-[10px]">
                    {activeHeroIndex === 0
                      ? "develop"
                      : EFFECTS[activeHeroIndex % EFFECTS.length]}
                  </span>
                </div>
              )}
            </div>

            {/* Playback & Scrubber Controls */}
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    isPlaying ? pausePlayback() : startPlayback()
                  }
                  disabled={isExporting || photos.length === 0}
                  className="px-3.5 py-2 bg-[#e85d04] hover:bg-[#d45200] disabled:bg-[#2e2e2a] text-[#111110] font-bold text-xs uppercase flex items-center gap-1.5 cursor-pointer"
                >
                  {isPlaying ? (
                    <>
                      <Pause className="w-3.5 h-3.5" />
                      <span>Pause</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5" />
                      <span>Play</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    pausePlayback();
                    setCurrentFrame(0);
                  }}
                  disabled={isExporting}
                  className="p-2 bg-[#111110] hover:bg-[#22221f] text-[#a8a49b] hover:text-[#f4f0e6] border border-[#2e2e2a] cursor-pointer"
                  title="Restart from 0.0s"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={toggleMute}
                  className="p-2 bg-[#111110] hover:bg-[#22221f] text-[#a8a49b] hover:text-[#f4f0e6] border border-[#2e2e2a] cursor-pointer"
                  title={isMuted ? "Unmute shutter & eject SFX" : "Mute SFX"}
                >
                  {isMuted ? (
                    <VolumeX className="w-4 h-4 text-[#e85d04]" />
                  ) : (
                    <Volume2 className="w-4 h-4 text-[#10b981]" />
                  )}
                </button>

                <div className="flex-1 flex flex-col">
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, totalFrames - 1)}
                    value={currentFrame}
                    disabled={isExporting}
                    onChange={(e) => {
                      pausePlayback();
                      setCurrentFrame(Number(e.target.value));
                    }}
                    className="w-full studio-slider"
                  />
                  <div className="flex justify-between font-mono-tech text-[10px] text-[#a8a49b] mt-1">
                    <span>{(currentFrame / VIDEO_FPS).toFixed(1)}s</span>
                    <span>{totalDuration.toFixed(1)}s</span>
                  </div>
                </div>
              </div>

              {/* Quick Timeline Jump Bookmarks */}
              <div className="grid grid-cols-4 gap-1.5 font-mono-tech text-[10px]">
                <button
                  type="button"
                  onClick={() => {
                    pausePlayback();
                    setCurrentFrame(Math.floor((INTRO + 0.85) * VIDEO_FPS));
                  }}
                  className="py-1.5 bg-[#111110] hover:bg-[#22221f] border border-[#2e2e2a] text-[#a8a49b] hover:text-[#f4f0e6] cursor-pointer"
                >
                  Photo #1
                </button>
                <button
                  type="button"
                  onClick={() => {
                    pausePlayback();
                    const midIdx = Math.floor(photos.length / 3);
                    setCurrentFrame(
                      Math.floor((INTRO + midIdx * STEP + 0.85) * VIDEO_FPS)
                    );
                  }}
                  className="py-1.5 bg-[#111110] hover:bg-[#22221f] border border-[#2e2e2a] text-[#a8a49b] hover:text-[#f4f0e6] cursor-pointer"
                >
                  Act II
                </button>
                <button
                  type="button"
                  onClick={() => {
                    pausePlayback();
                    const lateIdx = Math.floor((photos.length * 2) / 3);
                    setCurrentFrame(
                      Math.floor((INTRO + lateIdx * STEP + 0.85) * VIDEO_FPS)
                    );
                  }}
                  className="py-1.5 bg-[#111110] hover:bg-[#22221f] border border-[#2e2e2a] text-[#a8a49b] hover:text-[#f4f0e6] cursor-pointer"
                >
                  Peak Chaos
                </button>
                <button
                  type="button"
                  onClick={() => {
                    pausePlayback();
                    const endPhotos =
                      INTRO + Math.max(0, photos.length - 1) * STEP + LIFE;
                    setCurrentFrame(Math.floor((endPhotos + 2.0) * VIDEO_FPS));
                  }}
                  className="py-1.5 bg-[#111110] hover:bg-[#22221f] border border-[#2e2e2a] text-[#f59e0b] hover:text-[#f4f0e6] cursor-pointer"
                >
                  Finale Pile
                </button>
              </div>
            </div>

            {/* EXPORT MP4 PROGRESS OR ACTION BUTTON */}
            <div className="pt-3 border-t border-[#2e2e2a] space-y-3">
              {isExporting && exportProgress ? (
                <div className="p-3.5 bg-[#111110] border border-[#e85d04] space-y-2.5">
                  <div className="flex items-center justify-between font-mono-tech text-xs">
                    <span className="text-[#e85d04] font-bold uppercase">
                      {exportProgress.stage}...
                    </span>
                    <span className="text-[#f4f0e6] font-bold">
                      {exportProgress.percent}%
                    </span>
                  </div>

                  {/* Flat solid progress bar */}
                  <div className="w-full h-3 bg-[#22221f] border border-[#43433d]">
                    <div
                      className="h-full bg-[#e85d04] transition-all duration-150"
                      style={{ width: `${exportProgress.percent}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between font-mono-tech text-[11px] text-[#a8a49b]">
                    <span>{exportProgress.detail}</span>
                    <button
                      type="button"
                      onClick={cancelExport}
                      className="px-2 py-0.5 bg-[#22221f] hover:bg-[#e85d04] text-[#f4f0e6] hover:text-[#111110] border border-[#43433d] cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleExportMp4}
                  disabled={photos.length === 0}
                  className="w-full py-3 px-4 bg-[#e85d04] hover:bg-[#d45200] disabled:bg-[#2e2e2a] disabled:text-[#706d65] text-[#111110] font-bold text-sm uppercase tracking-wider border-2 border-[#f4f0e6] flex items-center justify-center gap-2 cursor-pointer transition-colors"
                >
                  <Download className="w-4 h-4" />
                  <span>
                    Generate &amp; Download MP4 ({totalDuration.toFixed(1)}s)
                  </span>
                </button>
              )}

              {exportError && (
                <div className="p-3 bg-[#111110] border border-[#e85d04] text-[#f59e0b] font-mono-tech text-xs">
                  {exportError}
                </div>
              )}

              {/* READY MP4 VIDEO DOWNLOAD & PLAYER */}
              {exportedVideoUrl && !isExporting && (
                <div className="p-3.5 bg-[#111110] border border-[#10b981] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono-tech text-xs text-[#10b981] font-bold flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>MP4 READY ({exportedSizeMb} MB)</span>
                    </span>
                    <a
                      href={exportedVideoUrl}
                      download={exportedFilename}
                      className="px-3 py-1 bg-[#10b981] text-[#111110] font-mono-tech font-bold text-xs uppercase hover:opacity-90"
                    >
                      Download .MP4
                    </a>
                  </div>
                  <video
                    src={exportedVideoUrl}
                    controls
                    playsInline
                    className="w-full max-h-[260px] bg-black border border-[#2e2e2a]"
                  />
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
