import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyResult,
  BackgroundApplyResult,
  BackgroundState,
  EnvironmentInfo,
  RestoreResult,
  SkinTheme,
  SystemFont,
  WallpaperSettings,
} from "../types";
import { DEFAULT_WALLPAPER_SETTINGS, sanitizeWallpaperSettings } from "./wallpaper";

export function isDesktopRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

const demoEnvironment: EnvironmentInfo = {
  platform: "browser",
  codexHome: "~/.codex",
  configPath: "~/.codex/config.toml",
  configExists: true,
  appRunning: true,
  activeMode: "dark",
  managedLight: false,
  managedDark: false,
  hasOriginalSnapshot: false,
  hasUndoSnapshot: false,
  isDemo: true,
};

export async function getEnvironment(): Promise<EnvironmentInfo> {
  if (!isDesktopRuntime()) return demoEnvironment;
  return invoke<EnvironmentInfo>("get_environment");
}

export async function applyTheme(
  theme: SkinTheme,
  restart: boolean,
): Promise<ApplyResult> {
  if (!isDesktopRuntime()) {
    await new Promise((resolve) => window.setTimeout(resolve, 420));
    return {
      configPath: demoEnvironment.configPath,
      backupPath: "演示模式：未写入磁盘",
      variant: theme.variant,
      appRunning: true,
      restartRequested: false,
    };
  }
  return invoke<ApplyResult>("apply_theme", { theme, restart });
}

export async function applyThemePair(
  lightTheme: SkinTheme,
  darkTheme: SkinTheme,
  restart: boolean,
): Promise<ApplyResult> {
  if (!isDesktopRuntime()) {
    await new Promise((resolve) => window.setTimeout(resolve, 420));
    return {
      configPath: demoEnvironment.configPath,
      backupPath: "演示模式：未写入磁盘",
      variant: "system",
      appRunning: true,
      restartRequested: false,
    };
  }
  return invoke<ApplyResult>("apply_theme_pair", { lightTheme, darkTheme, restart });
}

const demoFonts: SystemFont[] = [
  "Segoe UI",
  "Microsoft YaHei UI",
  "Arial",
  "Georgia",
  "Cascadia Code",
  "Consolas",
  "Courier New",
  "system-ui",
].map((family) => ({ family, source: "演示字体" }));

export async function getSystemFonts(): Promise<SystemFont[]> {
  if (!isDesktopRuntime()) return demoFonts;
  return invoke<SystemFont[]>("get_system_fonts");
}

export async function undoLast(): Promise<RestoreResult> {
  if (!isDesktopRuntime()) throw new Error("浏览器演示模式没有可撤销的写入");
  return invoke<RestoreResult>("undo_last");
}

export async function restoreOriginal(): Promise<RestoreResult> {
  if (!isDesktopRuntime()) throw new Error("浏览器演示模式没有原始快照");
  return invoke<RestoreResult>("restore_original");
}

export async function openChatGpt(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("open_chatgpt");
}

export async function revealConfig(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("reveal_config");
}

let demoBackground: BackgroundState = {
  settings: { ...DEFAULT_WALLPAPER_SETTINGS },
  configured: false,
  active: false,
  endpointReady: false,
  appRunning: true,
  needsRestart: false,
  port: null,
  fileName: null,
  mime: null,
  width: null,
  height: null,
  imageDataUrl: null,
  experimental: true,
  isDemo: true,
};

async function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("图片文件已损坏或无法读取"));
    image.src = dataUrl;
  });
}

export async function getBackgroundState(): Promise<BackgroundState> {
  if (!isDesktopRuntime()) return { ...demoBackground, settings: { ...demoBackground.settings }, savedSettings: { ...demoBackground.settings } };
  return invoke<BackgroundState>("get_background_state");
}

export async function saveBackgroundImage(
  fileName: string,
  dataUrl: string,
): Promise<BackgroundState> {
  if (!isDesktopRuntime()) {
    const dimensions = await imageDimensions(dataUrl);
    demoBackground = {
      ...demoBackground,
      configured: true,
      fileName,
      mime: dataUrl.slice(5, dataUrl.indexOf(";")),
      width: dimensions.width,
      height: dimensions.height,
      imageDataUrl: dataUrl,
    };
    return { ...demoBackground, settings: { ...demoBackground.settings } };
  }
  return invoke<BackgroundState>("save_background_image", { fileName, dataUrl });
}

export async function updateBackgroundSettings(
  settings: WallpaperSettings,
): Promise<BackgroundState> {
  const sanitized = sanitizeWallpaperSettings(settings);
  if (!isDesktopRuntime()) {
    demoBackground = { ...demoBackground, settings: sanitized };
    return { ...demoBackground, settings: { ...demoBackground.settings } };
  }
  return invoke<BackgroundState>("update_background_settings", { settings: sanitized });
}

export async function applyBackground(
  restart: boolean,
  theme: Pick<SkinTheme, "surface" | "ink" | "accent">,
): Promise<BackgroundApplyResult> {
  if (!isDesktopRuntime()) {
    await new Promise((resolve) => window.setTimeout(resolve, 520));
    demoBackground = { ...demoBackground, active: demoBackground.settings.enabled, endpointReady: true, port: 9341 };
    return { active: demoBackground.active, port: 9341, targets: demoBackground.active ? 1 : 0, restarted: false, sessionOnly: true };
  }
  return invoke<BackgroundApplyResult>("apply_background", {
    restart,
    surface: theme.surface,
    ink: theme.ink,
    accent: theme.accent,
  });
}

export async function restoreBackground(): Promise<BackgroundState> {
  if (!isDesktopRuntime()) {
    demoBackground = { ...demoBackground, active: false };
    return { ...demoBackground, settings: { ...demoBackground.settings } };
  }
  return invoke<BackgroundState>("restore_background");
}

export async function clearBackground(): Promise<BackgroundState> {
  if (!isDesktopRuntime()) {
    demoBackground = {
      ...demoBackground,
      settings: { ...DEFAULT_WALLPAPER_SETTINGS },
      configured: false,
      active: false,
      fileName: null,
      mime: null,
      width: null,
      height: null,
      imageDataUrl: null,
    };
    return { ...demoBackground, settings: { ...demoBackground.settings } };
  }
  return invoke<BackgroundState>("clear_background");
}
