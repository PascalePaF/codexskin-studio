import type { SkinTheme, ThemeVariant } from "../types";

const PREFIX = "codex-theme-v1:";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

interface PortableThemePayload {
  codeThemeId: string;
  theme: {
    accent: string;
    contrast: number;
    fonts: {
      code: string | null;
      ui: string | null;
    };
    ink: string;
    opaqueWindows: boolean;
    semanticColors: {
      diffAdded: string;
      diffRemoved: string;
      skill: string;
    };
    surface: string;
  };
  variant: ThemeVariant;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 不是有效对象`);
  }
  return value as Record<string, unknown>;
}

function requireHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX_COLOR.test(value)) {
    throw new Error(`${label} 必须是 #RRGGBB 颜色`);
  }
  return value.toUpperCase();
}

function optionalFont(value: unknown, label: string): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > 160) {
    throw new Error(`${label} 不是有效字体名称`);
  }
  if (/url\s*\(|[{};\x00-\x1f\x7f]/i.test(value)) {
    throw new Error(`${label} 包含不允许的内容`);
  }
  return value.trim();
}

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

export function hexToRgb(hex: string): [number, number, number] {
  if (!HEX_COLOR.test(hex)) throw new Error(`无效颜色：${hex}`);
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function luminance(hex: string): number {
  const channels = hexToRgb(hex).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function contrastGrade(ratio: number): {
  label: string;
  tone: "good" | "warn" | "bad";
  detail: string;
} {
  if (ratio >= 7) return { label: "AAA", tone: "good", detail: "适合正文与小字号" };
  if (ratio >= 4.5) return { label: "AA", tone: "good", detail: "满足普通正文建议" };
  if (ratio >= 3) return { label: "大字可用", tone: "warn", detail: "正文对比度不足" };
  return { label: "需调整", tone: "bad", detail: "文字可能难以辨认" };
}

export function themeToImportString(theme: SkinTheme): string {
  validateTheme(theme);
  const payload: PortableThemePayload = {
    codeThemeId: "codex",
    theme: {
      accent: theme.accent.toUpperCase(),
      contrast: Math.round(theme.contrast),
      fonts: {
        code: theme.fontCode.trim() || null,
        ui: theme.fontUi.trim() || null,
      },
      ink: theme.ink.toUpperCase(),
      opaqueWindows: theme.opaqueWindows,
      semanticColors: {
        diffAdded: theme.diffAdded.toUpperCase(),
        diffRemoved: theme.diffRemoved.toUpperCase(),
        skill: theme.skill.toUpperCase(),
      },
      surface: theme.surface.toUpperCase(),
    },
    variant: theme.variant,
  };
  return `${PREFIX}${JSON.stringify(payload)}`;
}

export function parseThemeString(input: string): SkinTheme {
  const value = input.trim();
  if (value.length > 64_000) throw new Error("主题字符串过大");
  if (!value.startsWith(PREFIX)) throw new Error(`主题必须以 ${PREFIX} 开头`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(PREFIX.length));
  } catch {
    throw new Error("主题 JSON 无法解析");
  }

  const root = requireRecord(parsed, "主题");
  const theme = requireRecord(root.theme, "theme");
  const semantic = requireRecord(theme.semanticColors, "semanticColors");
  const fonts = requireRecord(theme.fonts ?? {}, "fonts");
  const variant = root.variant;
  if (variant !== "light" && variant !== "dark") {
    throw new Error("variant 只能是 light 或 dark");
  }
  if (root.codeThemeId !== "codex") {
    throw new Error("V1 仅接受可移植的 codex 代码主题");
  }
  if (
    typeof theme.contrast !== "number" ||
    !Number.isInteger(theme.contrast) ||
    theme.contrast < 0 ||
    theme.contrast > 100
  ) {
    throw new Error("contrast 必须是 0–100 的整数");
  }
  if (typeof theme.opaqueWindows !== "boolean") {
    throw new Error("opaqueWindows 必须是布尔值");
  }

  const imported: SkinTheme = {
    id: `imported-${Date.now()}`,
    name: "导入主题",
    englishName: "Imported Theme",
    description: "从 ChatGPT 桌面外观字符串导入，可继续编辑后再应用。",
    variant,
    accent: requireHex(theme.accent, "accent"),
    surface: requireHex(theme.surface, "surface"),
    ink: requireHex(theme.ink, "ink"),
    diffAdded: requireHex(semantic.diffAdded, "diffAdded"),
    diffRemoved: requireHex(semantic.diffRemoved, "diffRemoved"),
    skill: requireHex(semantic.skill, "skill"),
    contrast: theme.contrast,
    opaqueWindows: theme.opaqueWindows,
    fontUi: optionalFont(fonts.ui, "UI 字体"),
    fontCode: optionalFont(fonts.code, "代码字体"),
    tags: ["导入", "自定义"],
  };
  validateTheme(imported);
  return imported;
}

export function validateTheme(theme: SkinTheme): void {
  if (!theme || typeof theme !== "object" || typeof theme.opaqueWindows !== "boolean") {
    throw new Error("主题数据无效");
  }
  const colors: Array<[string, string]> = [
    ["accent", theme.accent],
    ["surface", theme.surface],
    ["ink", theme.ink],
    ["diffAdded", theme.diffAdded],
    ["diffRemoved", theme.diffRemoved],
    ["skill", theme.skill],
  ];
  for (const [name, color] of colors) requireHex(color, name);
  if (theme.variant !== "light" && theme.variant !== "dark") {
    throw new Error("主题模式无效");
  }
  if (!Number.isInteger(theme.contrast) || theme.contrast < 0 || theme.contrast > 100) {
    throw new Error("对比度必须是 0–100 的整数");
  }
  optionalFont(theme.fontUi, "UI 字体");
  optionalFont(theme.fontCode, "代码字体");
}

export function fileSafeThemeName(theme: SkinTheme): string {
  const candidate = theme.englishName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return candidate || "codexskin-theme";
}

export function colorWithAlpha(hex: string, alpha: number): string {
  const [red, green, blue] = hexToRgb(hex);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
