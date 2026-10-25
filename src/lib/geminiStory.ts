import { PhotoItem } from "./defaultData";

export interface GenerateStoryOptions {
  apiKey: string;
  photos: PhotoItem[];
  storyPrompt?: string;
  previousCaptions?: string[];
}

export interface GenerateStoryResult {
  captions: string[];
  storyTitle: string;
  storyArcSummary: string;
  modelUsed: string;
}

const FALLBACK_STORY_BEATS = [
  "suited up, day one",
  "calm before the storm",
  "flash said hi",
  "selfie o'clock",
  "the whole crew",
  "details matter",
  "shy era",
  "act natural...",
  "pose game strong",
  "that smile tho",
  "stairway squad",
  "blazer off, vibe on",
  "the fab four",
  "main character",
  "boys being boys",
  "it got loud",
  "chaos mode: on",
  "partners in crime",
  "sunglasses at night?",
  "stacked",
  "fixing the tie... again",
  "cutest chaos",
  "no alibis left",
  "lost? maybe.",
  "plot twist at 1 am",
  "who let us in?",
  "unbuttoned era",
  "roof off the place",
  "brothers for life",
  "memory slightly blurry",
  "still standing",
  "what time is it?",
  "zero regrets",
  "roll complete",
  "best night ever",
];

function getNarrativeStage(index: number, total: number): string {
  if (total <= 1) return "Iconic Finale";
  const progress = index / (total - 1);
  if (index === 0) return "Opening Frame (Act I: How It Started / Dressed Up)";
  if (index === total - 1) return "Final Frame (Act IV: Ultimate Core Memory / Roll Complete)";
  if (progress < 0.25) return "Act I: The Arrival & Golden Hour Fits (composed, sharp, early evening)";
  if (progress < 0.55) return "Act II: Flash On & Warming Up (crew assembling, candids, ties loosening)";
  if (progress < 0.85) return "Act III: Peak Party Chaos (loud music, sunglasses at night, unhinged fun)";
  return "Act IV: Late-Night Aftermath & Nostalgia (2 AM laughs, ride or die, winding down)";
}

/**
 * Generates a cohesive, sequential Polaroid story across all photos in ONE single Gemini call.
 * Strictly DOES NOT send individual photos to the AI — crafts a connected narrative arc
 * where every single caption is 100% distinct and reads like a handwritten Polaroid story.
 */
export async function generatePolaroidStoryWithGemini(
  options: GenerateStoryOptions
): Promise<GenerateStoryResult> {
  const { apiKey, photos, storyPrompt, previousCaptions = [] } = options;
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    throw new Error("Please enter a valid Gemini API key.");
  }

  const count = photos.length;
  if (count === 0) {
    throw new Error("Add at least one photo before generating story captions.");
  }

  const lockedEntries = photos
    .map((p, idx) => (p.lockedCaption && p.caption.trim() ? `Frame #${idx + 1}: "${p.caption.trim()}" (LOCKED - keep exact)` : null))
    .filter(Boolean);

  const slotDescriptions = photos
    .map((p, idx) => {
      const stage = getNarrativeStage(idx, count);
      const lockInfo = p.lockedCaption && p.caption.trim() ? ` [LOCKED: "${p.caption.trim()}"]` : "";
      return `  - Frame #${idx + 1} of ${count}: ${stage}${lockInfo}`;
    })
    .join("\n");

  const avoidList =
    previousCaptions.length > 0
      ? `\nDO NOT reuse these previous captions (write a fresh story):\n${previousCaptions
          .filter(Boolean)
          .map((c) => `"${c}"`)
          .join(", ")}\n`
      : "";

  const userVibe = storyPrompt?.trim()
    ? storyPrompt.trim()
    : "A legendary Hangover-style night out / farewell celebration with friends: starting suited up & classy in the afternoon, escalating through flash-lit candids and chaotic party energy, and ending as an unforgettable core memory.";

  const systemInstruction = `You are a brilliant creative director and screenwriter crafting the handwritten Sharpie marker captions along the bottom of a sequence of ${count} instant-film Polaroid photos.

CRITICAL RULES:
1. DO NOT write generic single-photo descriptions. Write a COHESIVE, CHRONOLOGICAL STORY from Frame #1 to Frame #${count} with a clear beginning, rising action, peak late-night chaos, and emotional/iconic finale.
2. EVERY SINGLE CAPTION MUST BE 100% DISTINCT. No two frames may share the same caption or repeat the same phrasing.
3. Keep each caption between 2 and 5 words (maximum 25 characters) so it looks authentic handwritten in marker on a Polaroid strip.
4. Style & Tone: Witty, nostalgic, effortless, insider-friend-group energy, mostly lowercase (like "suited up, day one", "flash said hi", "selfie o'clock", "the whole crew", "details matter", "shy era", "it got loud", "blazer off, vibe on", "chaos mode: on", "sunglasses at night?", "fixing the tie... again", "lost? maybe.", "what time is it?", "best night ever").
5. If any frame is marked [LOCKED], preserve its exact text at that frame index and build the story naturally around it.
6. Return valid JSON matching the requested schema.`;

  const promptText = `Story Theme / Vibe:
${userVibe}

Total Polaroids in Sequence: ${count}
Timeline Sequence Structure:
${slotDescriptions}
${lockedEntries.length > 0 ? `\nLocked Captions to Preserve:\n${lockedEntries.join("\n")}\n` : ""}${avoidList}
Return a JSON object with:
- "storyTitle": short 2-5 word title for this story arc
- "storyArcSummary": 1-sentence summary of the narrative progression
- "captions": array of ${count} strings (exact length ${count}, in chronological order from Frame #1 to Frame #${count}, all 100% distinct).`;

  const modelsToTry = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
  ];

  let lastError: Error | null = null;

  for (const model of modelsToTry) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
        cleanKey
      )}`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: promptText }],
            },
          ],
          generationConfig: {
            temperature: 0.95,
            topP: 0.95,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                storyTitle: { type: "STRING" },
                storyArcSummary: { type: "STRING" },
                captions: {
                  type: "ARRAY",
                  items: { type: "STRING" },
                },
              },
              required: ["storyTitle", "storyArcSummary", "captions"],
            },
          },
        }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const errMsg =
          errBody?.error?.message || `Gemini API returned HTTP ${response.status}`;
        // If API key is invalid (400/403), throw immediately rather than trying other models
        if (
          response.status === 400 &&
          errMsg.toLowerCase().includes("api key")
        ) {
          throw new Error(`Invalid Gemini API Key: ${errMsg}`);
        }
        throw new Error(errMsg);
      }

      const data = await response.json();
      const rawText =
        data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!rawText) {
        throw new Error("Gemini returned an empty response.");
      }

      const parsed = JSON.parse(rawText);
      const rawCaptions: string[] = Array.isArray(parsed.captions)
        ? parsed.captions
        : [];

      const uniqueCaptions = enforceDistinctStoryCaptions(
        rawCaptions,
        photos
      );

      return {
        captions: uniqueCaptions,
        storyTitle: parsed.storyTitle || "The Night In Polaroids",
        storyArcSummary:
          parsed.storyArcSummary ||
          `A ${count}-part sequential Polaroid story from arrival to late-night finale.`,
        modelUsed: model,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.message.toLowerCase().includes("invalid gemini api key")) {
        throw lastError;
      }
    }
  }

  throw (
    lastError ||
    new Error("Failed to generate story captions with Gemini API.")
  );
}

/**
 * Guarantees that all N returned captions are non-empty, respect locked captions,
 * and are 100% distinct (zero duplicates).
 */
export function enforceDistinctStoryCaptions(
  candidates: string[],
  photos: PhotoItem[]
): string[] {
  const count = photos.length;
  const used = new Set<string>();
  const result: string[] = new Array(count).fill("");

  // 1. First reserve locked captions
  for (let i = 0; i < count; i++) {
    if (photos[i].lockedCaption && photos[i].caption.trim()) {
      const c = photos[i].caption.trim();
      result[i] = c;
      used.add(c.toLowerCase());
    }
  }

  // 2. Fill from Gemini candidates, ensuring strict uniqueness
  let fallbackIdx = 0;
  for (let i = 0; i < count; i++) {
    if (result[i]) continue;

    let raw = (candidates[i] ?? "")
      .replace(/^["'\d.\-#)\s]+|["'\s]+$/g, "")
      .trim();

    if (raw.length > 28) {
      raw = raw.slice(0, 28).trim();
    }

    if (raw && !used.has(raw.toLowerCase())) {
      result[i] = raw;
      used.add(raw.toLowerCase());
    } else {
      // Pick a distinct fallback beat appropriate for the narrative position
      let chosen = "";
      while (fallbackIdx < FALLBACK_STORY_BEATS.length) {
        const beat = FALLBACK_STORY_BEATS[fallbackIdx++];
        if (!used.has(beat.toLowerCase())) {
          chosen = beat;
          break;
        }
      }
      if (!chosen) {
        chosen = `chapter #${i + 1}`;
      }
      result[i] = chosen;
      used.add(chosen.toLowerCase());
    }
  }

  return result;
}
