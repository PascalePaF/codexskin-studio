export const PREFERENCES_KEY = "codexskin.preferences.v1";
const MAX_RECENT = 6;

export interface UserPreferences {
  version: 1;
  favoriteThemeIds: string[];
  favoritePairIds: string[];
  recentThemeIds: string[];
  recentPairIds: string[];
  selectedThemeId: string | null;
  selectedTheme: SkinTheme | null;
  wallpaperDraft: WallpaperSettings | null;
}

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  version: 1,
  favoriteThemeIds: [],
  favoritePairIds: [],
  recentThemeIds: [],
  recentPairIds: [],
  selectedThemeId: null,
  selectedTheme: null,
  wallpaperDraft: null,
};

function cleanIds(value: unknown, limit = 64): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => (
    typeof item === "string" && item.length > 0 && item.length <= 160
  )))].slice(0, limit);
}

function defaultStorage(): PreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function cleanTheme(value: unknown): SkinTheme | null {
  try {
    const theme = value as SkinTheme;
    validateTheme(theme);
    for (const key of ["id", "name", "englishName", "description"] as const) {
      if (typeof theme[key] !== "string" || theme[key].length > 1000) return null;
    }
    if (!Array.isArray(theme.tags) || theme.tags.some((tag) => typeof tag !== "string")) return null;
    return { ...theme, tags: theme.tags.slice(0, 32) };
  } catch {
    return null;
  }
}

export function loadPreferences(storage: PreferenceStorage | null = defaultStorage()): UserPreferences {
  if (!storage) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = storage.getItem(PREFERENCES_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      version: 1,
      favoriteThemeIds: cleanIds(parsed.favoriteThemeIds),
      favoritePairIds: cleanIds(parsed.favoritePairIds),
      recentThemeIds: cleanIds(parsed.recentThemeIds, MAX_RECENT),
      recentPairIds: cleanIds(parsed.recentPairIds, MAX_RECENT),
      selectedThemeId: typeof parsed.selectedThemeId === "string" && parsed.selectedThemeId.length <= 160
        ? parsed.selectedThemeId
        : null,
      selectedTheme: cleanTheme(parsed.selectedTheme),
      wallpaperDraft: parsed.wallpaperDraft && typeof parsed.wallpaperDraft === "object"
        ? sanitizeWallpaperSettings(parsed.wallpaperDraft as Partial<WallpaperSettings>)
        : null,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(
  preferences: UserPreferences,
  storage: PreferenceStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences are a convenience feature; a blocked or full store must not break the app.
  }
}

export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [id, ...ids];
}

export function recordRecent(ids: string[], id: string): string[] {
  return [id, ...ids.filter((value) => value !== id)].slice(0, MAX_RECENT);
}
import type { SkinTheme, WallpaperSettings } from "../types";
import { validateTheme } from "./theme";
import { sanitizeWallpaperSettings } from "./wallpaper";
