import { PhotoItem } from "./defaultData";

const DEFAULT_STORY_CAPTIONS = [
  "suited up, day one",
  "flash said hi",
  "selfie o'clock",
  "the whole crew",
  "details matter",
  "shy era",
  "My Copium",
  "it got loud",
  "that smile tho",
  "pose game strong",
  "stairway squad",
  "blazer off, vibe on",
  "the fab four",
  "main character",
  "boys being boys",
  "chaos mode: on",
  "partners in crime",
  "sunglasses at night?",
  "stacked",
  "fixing the tie... again",
  "cutest chaos",
  "lost? maybe.",
  "brothers",
  "what time is it?",
  "best night ever",
];

function canBrowserDecodeImage(url: string): Promise<{ ok: boolean; w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ ok: false, w: 0, h: 0 });
    img.src = url;
  });
}

export async function processUploadedFiles(
  files: File[],
  existingCaptions: Set<string>,
  startIndex: number,
  onProgress?: (current: number, total: number, name: string) => void
): Promise<PhotoItem[]> {
  const results: PhotoItem[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length, file.name);

    const isHeic =
      file.name.toLowerCase().endsWith(".heic") ||
      file.name.toLowerCase().endsWith(".heif") ||
      file.type === "image/heic" ||
      file.type === "image/heif";

    let finalUrl = URL.createObjectURL(file);
    let dims = await canBrowserDecodeImage(finalUrl);

    if (!dims.ok && isHeic) {
      URL.revokeObjectURL(finalUrl);
      try {
        const heic2anyMod = await import("heic2any");
        const heic2any = heic2anyMod.default || heic2anyMod;
        const converted = await heic2any({
          blob: file,
          toType: "image/jpeg",
          quality: 0.9,
        });
        const jpgBlob = Array.isArray(converted) ? converted[0] : converted;
        finalUrl = URL.createObjectURL(jpgBlob);
        dims = await canBrowserDecodeImage(finalUrl);
      } catch (err) {
        console.error("Failed to convert HEIC:", file.name, err);
        continue;
      }
    }

    if (!dims.ok) {
      URL.revokeObjectURL(finalUrl);
      continue;
    }

    // Pick a distinct default caption
    let chosenCaption = "";
    for (let k = 0; k < DEFAULT_STORY_CAPTIONS.length; k++) {
      const candidate =
        DEFAULT_STORY_CAPTIONS[(startIndex + i + k) % DEFAULT_STORY_CAPTIONS.length];
      if (!existingCaptions.has(candidate.toLowerCase())) {
        chosenCaption = candidate;
        existingCaptions.add(candidate.toLowerCase());
        break;
      }
    }
    if (!chosenCaption) {
      chosenCaption = `frame #${startIndex + i + 1}`;
      existingCaptions.add(chosenCaption.toLowerCase());
    }

    results.push({
      id: `upload-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      url: finalUrl,
      caption: chosenCaption,
      cropY: 0.3,
      lockedCaption: false,
      width: dims.w,
      height: dims.h,
    });
  }

  return results;
}
