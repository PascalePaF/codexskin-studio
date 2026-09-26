import type { WallpaperSettings } from "../types";

export const MAX_WALLPAPER_BYTES = 8 * 1024 * 1024;
export const ACCEPTED_WALLPAPER_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = {
  enabled: true,
  opacity: 88,
  darkness: 34,
  blur: 0,
  zoom: 108,
  positionX: 50,
  positionY: 50,
  panelOpacity: 76,
  fit: "cover",
  scope: "main",
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function sanitizeWallpaperSettings(value: Partial<WallpaperSettings>): WallpaperSettings {
  return {
    enabled: value.enabled !== false,
    opacity: clamp(value.opacity ?? DEFAULT_WALLPAPER_SETTINGS.opacity, 10, 100),
    darkness: clamp(value.darkness ?? DEFAULT_WALLPAPER_SETTINGS.darkness, 0, 85),
    blur: clamp(value.blur ?? DEFAULT_WALLPAPER_SETTINGS.blur, 0, 24),
    zoom: clamp(value.zoom ?? DEFAULT_WALLPAPER_SETTINGS.zoom, 100, 160),
    positionX: clamp(value.positionX ?? DEFAULT_WALLPAPER_SETTINGS.positionX, 0, 100),
    positionY: clamp(value.positionY ?? DEFAULT_WALLPAPER_SETTINGS.positionY, 0, 100),
    panelOpacity: clamp(value.panelOpacity ?? DEFAULT_WALLPAPER_SETTINGS.panelOpacity, 35, 100),
    fit: value.fit === "contain" ? "contain" : "cover",
    scope: value.scope === "all" ? "all" : "main",
  };
}

export function validateWallpaperFile(file: Pick<File, "size" | "type" | "name">): void {
  if (!ACCEPTED_WALLPAPER_TYPES.includes(file.type as (typeof ACCEPTED_WALLPAPER_TYPES)[number])) {
    throw new Error("请选择 PNG、JPEG 或 WebP 图片");
  }
  if (file.size <= 0 || file.size > MAX_WALLPAPER_BYTES) {
    throw new Error("背景图片必须小于 8 MiB");
  }
  if (!file.name.trim()) throw new Error("图片文件名无效");
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取所选图片"));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("图片读取结果无效"));
    reader.readAsDataURL(file);
  });
}
