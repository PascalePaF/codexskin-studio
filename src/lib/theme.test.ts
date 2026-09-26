import { describe, expect, it } from "vitest";
import { PRESET_THEMES, THEME_PAIRS, getPairThemes } from "../data/themes";
import {
  contrastGrade,
  contrastRatio,
  parseThemeString,
  themeToImportString,
} from "./theme";

describe("portable ChatGPT themes", () => {
  it("round-trips a preset through codex-theme-v1", () => {
    const source = PRESET_THEMES[0];
    const encoded = themeToImportString(source);
    expect(encoded.startsWith("codex-theme-v1:")).toBe(true);

    const imported = parseThemeString(encoded);
    expect(imported.variant).toBe(source.variant);
    expect(imported.accent).toBe(source.accent);
    expect(imported.surface).toBe(source.surface);
    expect(imported.ink).toBe(source.ink);
    expect(imported.diffAdded).toBe(source.diffAdded);
  });

  it("rejects data that is not an appearance string", () => {
    expect(() => parseThemeString('{"theme":{}}')).toThrow(/codex-theme-v1/);
  });

  it("calculates the canonical black/white contrast", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 4);
    expect(contrastGrade(21).label).toBe("AAA");
  });

  it("ships only presets with AA body text contrast", () => {
    for (const theme of PRESET_THEMES) {
      expect(
        contrastRatio(theme.surface, theme.ink),
        `${theme.name} should meet WCAG AA`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("ships complete light and dark theme pairs", () => {
    expect(THEME_PAIRS).toHaveLength(4);
    for (const pair of THEME_PAIRS) {
      const themes = getPairThemes(pair);
      expect(themes.light.variant).toBe("light");
      expect(themes.dark.variant).toBe("dark");
      expect(themes.light.id).not.toBe(themes.dark.id);
    }
  });
});
