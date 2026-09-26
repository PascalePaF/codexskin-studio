import { describe, expect, it } from "vitest";
import {
  DEFAULT_WALLPAPER_SETTINGS,
  MAX_WALLPAPER_BYTES,
  sanitizeWallpaperSettings,
  validateWallpaperFile,
} from "./wallpaper";

describe("wallpaper settings", () => {
  it("fills defaults and normalizes enum values", () => {
    expect(sanitizeWallpaperSettings({})).toEqual(DEFAULT_WALLPAPER_SETTINGS);
    expect(sanitizeWallpaperSettings({ fit: "contain", scope: "all" })).toMatchObject({
      fit: "contain",
      scope: "all",
    });
  });

  it("clamps numeric controls to the safe UI contract", () => {
    expect(sanitizeWallpaperSettings({
      opacity: -1,
      darkness: 200,
      blur: 99,
      zoom: 1,
      positionX: 120,
      positionY: -10,
      panelOpacity: 0,
    })).toMatchObject({
      opacity: 10,
      darkness: 85,
      blur: 24,
      zoom: 100,
      positionX: 100,
      positionY: 0,
      panelOpacity: 35,
    });
  });

  it("accepts supported local image metadata", () => {
    expect(() => validateWallpaperFile({
      name: "wallpaper.webp",
      type: "image/webp",
      size: MAX_WALLPAPER_BYTES,
    })).not.toThrow();
  });

  it("rejects unsupported and oversized inputs", () => {
    expect(() => validateWallpaperFile({ name: "theme.svg", type: "image/svg+xml", size: 100 }))
      .toThrow(/PNG/);
    expect(() => validateWallpaperFile({
      name: "huge.png",
      type: "image/png",
      size: MAX_WALLPAPER_BYTES + 1,
    })).toThrow(/8 MiB/);
  });
});
