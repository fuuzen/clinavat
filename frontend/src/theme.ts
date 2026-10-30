import { useSyncExternalStore } from "react";
import { legacyStorageKey, readBrandStorage } from "./brandStorage";

export type ThemeMode = "dark" | "light";

export interface ThemePreferences {
  presetId: string;
  customMode: ThemeMode;
  customBackground: string;
  customAccent: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  mode: ThemeMode;
  background: string;
  accent: string;
}

export const themePresets: ThemePreset[] = [
  { id: "forest", name: "深林", mode: "dark", background: "#111412", accent: "#b6e8b0" },
  { id: "midnight", name: "午夜蓝", mode: "dark", background: "#101827", accent: "#91baff" },
  { id: "violet", name: "暮紫", mode: "dark", background: "#1b1726", accent: "#c9b1f2" },
  { id: "mist", name: "晨雾", mode: "light", background: "#f5f7f4", accent: "#35704b" },
  { id: "paper", name: "暖纸", mode: "light", background: "#fbf7ef", accent: "#96652b" },
  { id: "sky", name: "晴空", mode: "light", background: "#f2f6fc", accent: "#3567ba" },
];

export const defaultThemePreferences: ThemePreferences = {
  presetId: "forest",
  customMode: "dark",
  customBackground: "#111412",
  customAccent: "#b6e8b0",
};

const storageKey = "clinavat-appearance";
const listeners = new Set<() => void>();
let initialized = false;
let siteDefaultPreset = defaultThemePreferences.presetId;
let snapshot = { preferences: defaultThemePreferences, storageAvailable: true };

function parsePreferences(raw: string | null): ThemePreferences {
  try {
    const value: unknown = JSON.parse(raw || "null");
    if (!value || typeof value !== "object") return { ...defaultThemePreferences, presetId: siteDefaultPreset };
    const saved = value as Partial<ThemePreferences>;
    return {
      presetId: saved.presetId === "custom" || themePresets.some((item) => item.id === saved.presetId)
        ? saved.presetId! : siteDefaultPreset,
      customMode: saved.customMode === "light" ? "light" : "dark",
      customBackground: validColor(saved.customBackground)
        ? saved.customBackground : defaultThemePreferences.customBackground,
      customAccent: validColor(saved.customAccent)
        ? saved.customAccent : defaultThemePreferences.customAccent,
    };
  } catch {
    return { ...defaultThemePreferences, presetId: siteDefaultPreset };
  }
}

function validColor(value: unknown): value is string {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
}

function channels(color: string) {
  return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
}

function mix(background: string, foreground: string, amount: number) {
  const target = channels(foreground);
  return `#${channels(background).map((channel, index) =>
    Math.round(channel + (target[index] - channel) * amount).toString(16).padStart(2, "0"),
  ).join("")}`;
}

function luminance(color: string) {
  const linear = channels(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(first: string, second: string) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function readableColor(color: string, background: string, minimum = 4.5, anchor?: string) {
  const target = anchor || (contrast("#ffffff", background) > contrast("#000000", background)
    ? "#ffffff" : "#000000");
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(color, target, step / 20);
    const sameDirection = !anchor || (luminance(candidate) > luminance(background))
      === (anchor === "#ffffff");
    if (sameDirection && contrast(candidate, background) >= minimum) return candidate;
  }
  return target;
}

export function resolveTheme(preferences: ThemePreferences) {
  if (preferences.presetId !== "custom") {
    return themePresets.find((item) => item.id === preferences.presetId) || themePresets[0];
  }
  const background = preferences.customBackground;
  // Arbitrary background colors must keep readable text, even across mode boundaries.
  const mode: ThemeMode = contrast("#000000", background) > contrast("#ffffff", background)
    ? "light" : "dark";
  return { name: "自定义", mode, background, accent: preferences.customAccent };
}

export function getThemePalette(preferences: ThemePreferences) {
  const theme = resolveTheme(preferences);
  const dark = theme.mode === "dark";
  const text = readableColor(
    dark ? "#e5e9e4" : "#1c2420", theme.background, 7, dark ? "#ffffff" : "#000000",
  );
  // Midtone backgrounds need layers to move away from the text's brightness.
  const layerTarget = contrast(text, mix(theme.background, text, 0.095)) >= 5
    ? text : dark ? "#000000" : "#ffffff";
  const panel = mix(theme.background, layerTarget, dark ? 0.025 : 0.018);
  const surface = mix(theme.background, layerTarget, dark ? 0.055 : 0.035);
  const hover = mix(theme.background, layerTarget, dark ? 0.095 : 0.065);
  const tint = (color: string, amount = 0.09) => {
    for (let step = 10; step >= 0; step--) {
      const candidate = mix(panel, color, amount * step / 10);
      if (contrast(text, candidate) >= 4.5) return candidate;
    }
    return panel;
  };
  const accentBackground = tint(theme.accent, dark ? 0.12 : 0.09);
  const dangerBackground = tint(dark ? "#ef9b94" : "#ae352f");
  const successBackground = tint(dark ? "#a6d99c" : "#326e3a");
  const warningBackground = tint(dark ? "#e8c787" : "#8a5b18");
  const infoBackground = tint(dark ? "#94bced" : "#3567ae");
  const backgrounds = [theme.background, panel, surface, hover, accentBackground,
    dangerBackground, successBackground, warningBackground, infoBackground];
  const textBackground = backgrounds.reduce((closest, background) =>
    contrast(text, background) < contrast(text, closest) ? background : closest,
  );
  const foreground = (color: string) => readableColor(
    color, textBackground, 4.5, dark ? "#ffffff" : "#000000",
  );
  const accent = foreground(theme.accent);
  const status = foreground;
  const danger = status(dark ? "#ef9b94" : "#ae352f");
  const success = status(dark ? "#a6d99c" : "#326e3a");
  const warning = status(dark ? "#e8c787" : "#8a5b18");
  const info = status(dark ? "#94bced" : "#3567ae");
  return {
    "--bg": theme.background,
    "--panel": panel,
    "--surface": surface,
    "--hover": hover,
    "--line": mix(theme.background, text, dark ? 0.15 : 0.18),
    "--line-strong": mix(theme.background, text, 0.3),
    "--text": text,
    "--text-secondary": foreground(mix(theme.background, text, 0.8)),
    "--muted": foreground(mix(theme.background, text, 0.59)),
    "--accent": accent,
    "--accent-hover": mix(accent, dark ? "#ffffff" : "#000000", 0.12),
    "--accent-dim": accentBackground,
    "--on-accent": readableColor(dark ? "#111714" : "#ffffff", accent),
    "--danger": danger,
    "--danger-bg": dangerBackground,
    "--danger-line": mix(panel, danger, 0.35),
    "--success": success,
    "--success-bg": successBackground,
    "--success-line": mix(panel, success, 0.35),
    "--warning": warning,
    "--warning-bg": warningBackground,
    "--warning-line": mix(panel, warning, 0.35),
    "--info": info,
    "--info-bg": infoBackground,
    "--info-line": mix(panel, info, 0.35),
    "--terminal-magenta": foreground(dark ? "#c3a3e0" : "#8d3da8"),
    "--terminal-cyan": foreground(dark ? "#8bcfc9" : "#247574"),
    "--overlay": dark ? "#050907b8" : "#17231c66",
    "--shadow": dark ? "#00000066" : "#18251c1f",
  };
}

function applyTheme() {
  const { preferences } = snapshot;
  const theme = resolveTheme(preferences);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(getThemePalette(preferences))) {
    root.style.setProperty(name, value);
  }
  root.style.colorScheme = theme.mode;
  root.dataset.theme = preferences.presetId;
  root.dataset.themeMode = theme.mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.background);
}

function publish() {
  applyTheme();
  listeners.forEach((listener) => listener());
}

export function setSiteDefaultTheme(presetId: string) {
  siteDefaultPreset = themePresets.some((preset) => preset.id === presetId) ? presetId : "forest";
  try {
    snapshot = { preferences: parsePreferences(readBrandStorage(localStorage, storageKey)), storageAvailable: true };
  } catch {
    snapshot = { preferences: parsePreferences(null), storageAvailable: false };
  }
  publish();
}

export function initializeTheme() {
  if (initialized) return;
  initialized = true;
  try {
    snapshot = { preferences: parsePreferences(readBrandStorage(localStorage, storageKey)), storageAvailable: true };
  } catch {
    snapshot = { preferences: parsePreferences(null), storageAvailable: false };
  }
  applyTheme();
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== legacyStorageKey(storageKey) && event.key !== null) return;
    try {
      snapshot = { preferences: parsePreferences(readBrandStorage(localStorage, storageKey)), storageAvailable: true };
    } catch {
      snapshot = { ...snapshot, storageAvailable: false };
    }
    publish();
  });
}

function setPreferences(next: ThemePreferences | ((current: ThemePreferences) => ThemePreferences)) {
  const value = typeof next === "function" ? next(snapshot.preferences) : next;
  const preferences = parsePreferences(JSON.stringify(value));
  let storageAvailable = true;
  try {
    localStorage.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    storageAvailable = false;
  }
  snapshot = { preferences, storageAvailable };
  publish();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTheme() {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  return { ...state, setPreferences };
}
