export interface PhotoItem {
  id: string;
  name: string;
  url: string;
  caption: string;
  cropY: number; // 0..1 vertical crop focus
  lockedCaption?: boolean;
  width?: number;
  height?: number;
}

export type GrainPresetId = "none" | "low" | "medium" | "high" | "extreme";

export interface GrainPreset {
  id: GrainPresetId;
  label: string;
  badge: string;
  value: number; // 0..100 slider scale (25 = GRAIN_LO, 75 = GRAIN_HI)
  description: string;
}

export const GRAIN_PRESETS: GrainPreset[] = [
  {
    id: "none",
    label: "Clean Stock",
    badge: "0%",
    value: 0,
    description: "Zero added film or print grain, keeping only instant-film color grading.",
  },
  {
    id: "low",
    label: "Less Grain",
    badge: "25%",
    value: 25,
    description: "Subtle analog texture (print σ = 0.008, film overlay σ = 3.0).",
  },
  {
    id: "medium",
    label: "Balanced 600 Film",
    badge: "50%",
    value: 50,
    description: "Mid-level analog texture across paper, print, and dark tabletop.",
  },
  {
    id: "high",
    label: "High Grain",
    badge: "75%",
    value: 75,
    description: "Classic gritty instant-film texture (print σ = 0.022, film overlay σ = 9.0).",
  },
  {
    id: "extreme",
    label: "Pushed 3200 ISO",
    badge: "100%",
    value: 100,
    description: "Heavy late-night disposable film grit and pronounced tabletop texture.",
  },
];

export interface StoryPreset {
  id: string;
  label: string;
  prompt: string;
}

export const STORY_PRESETS: StoryPreset[] = [
  {
    id: "hangover-farewell",
    label: "Hangover / Farewell Night",
    prompt:
      "A legendary farewell / night out with best friends: starts dressed sharp in the afternoon, transitions into flash photography, inside jokes, loosening ties, peak dancefloor madness at 2 AM, and ends with a nostalgic 'best night ever' finale.",
  },
  {
    id: "house-party",
    label: "Chaotic Afterhours Party",
    prompt:
      "An escalating late-night house party story: arriving looking composed, first round of drinks, candid kitchen/stairwell moments, unexpected chaos, blurry disposable-camera energy, and surviving till sunrise together.",
  },
  {
    id: "road-trip",
    label: "Weekend Getaway / Trip",
    prompt:
      "An unforgettable road trip & getaway with the crew: packing up, golden hour stops, wrong turns, midnight laughter, iconic poses, and core memories locked in forever.",
  },
  {
    id: "wedding-sangeet",
    label: "Wedding / Gala Afterparty",
    prompt:
      "Dressed to the nines for a grand celebration: starts with classy red-carpet poses and traditional fits, then jackets come off, sunglasses go on indoors, the squad takes over the stairs and dancefloor, ending in pure euphoria.",
  },
];
