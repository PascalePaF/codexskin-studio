export type ThemeVariant = "light" | "dark";
export type AppearanceMode = ThemeVariant | "system";

export interface SkinTheme {
  id: string;
  name: string;
  englishName: string;
  description: string;
  variant: ThemeVariant;
  accent: string;
  surface: string;
  ink: string;
  diffAdded: string;
  diffRemoved: string;
  skill: string;
  contrast: number;
  opaqueWindows: boolean;
  fontUi: string;
  fontCode: string;
  tags: string[];
}

export interface ThemePair {
  id: string;
  name: string;
  englishName: string;
  description: string;
  lightThemeId: string;
  darkThemeId: string;
  tags: string[];
}

export interface SystemFont {
  family: string;
  source: string;
}

export type WallpaperFit = "cover" | "contain";
export type WallpaperScope = "main" | "all";

export interface WallpaperSettings {
  enabled: boolean;
  opacity: number;
  darkness: number;
  blur: number;
  zoom: number;
  positionX: number;
  positionY: number;
  panelOpacity: number;
  fit: WallpaperFit;
  scope: WallpaperScope;
}

export interface BackgroundState {
  settings: WallpaperSettings;
  configured: boolean;
  active: boolean;
  endpointReady: boolean;
  appRunning: boolean;
  needsRestart: boolean;
  port: number | null;
  fileName: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  imageDataUrl: string | null;
  experimental: boolean;
  isDemo?: boolean;
  warning?: string | null;
  hasSession?: boolean;
  savedSettings?: WallpaperSettings;
}

export interface BackgroundApplyResult {
  active: boolean;
  port: number;
  targets: number;
  restarted: boolean;
  sessionOnly: boolean;
}

export interface EnvironmentInfo {
  platform: string;
  codexHome: string;
  configPath: string;
  configExists: boolean;
  appRunning: boolean;
  activeMode: string | null;
  managedLight: boolean;
  managedDark: boolean;
  hasOriginalSnapshot: boolean;
  hasUndoSnapshot: boolean;
  isDemo?: boolean;
}

export interface ApplyResult {
  configPath: string;
  backupPath: string;
  variant: AppearanceMode;
  appRunning: boolean;
  restartRequested: boolean;
}

export interface RestoreResult {
  configPath: string;
  backupPath: string;
  restoredKeys: number;
  appRunning: boolean;
}

export type AppPage = "themes" | "studio" | "background" | "recovery" | "research";
