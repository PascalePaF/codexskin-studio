import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyResult,
  EnvironmentInfo,
  RestoreResult,
  SkinTheme,
  SystemFont,
} from "../types";

function hasTauriRuntime(): boolean {
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
  if (!hasTauriRuntime()) return demoEnvironment;
  return invoke<EnvironmentInfo>("get_environment");
}

export async function applyTheme(
  theme: SkinTheme,
  restart: boolean,
): Promise<ApplyResult> {
  if (!hasTauriRuntime()) {
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
  if (!hasTauriRuntime()) {
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
  if (!hasTauriRuntime()) return demoFonts;
  return invoke<SystemFont[]>("get_system_fonts");
}

export async function undoLast(): Promise<RestoreResult> {
  if (!hasTauriRuntime()) throw new Error("浏览器演示模式没有可撤销的写入");
  return invoke<RestoreResult>("undo_last");
}

export async function restoreOriginal(): Promise<RestoreResult> {
  if (!hasTauriRuntime()) throw new Error("浏览器演示模式没有原始快照");
  return invoke<RestoreResult>("restore_original");
}

export async function openChatGpt(): Promise<void> {
  if (!hasTauriRuntime()) return;
  await invoke("open_chatgpt");
}

export async function revealConfig(): Promise<void> {
  if (!hasTauriRuntime()) return;
  await invoke("reveal_config");
}
