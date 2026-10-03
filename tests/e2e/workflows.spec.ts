import { test, expect } from "@playwright/test";
import { desktopMock, openBackground, chooseImage } from "./desktop-mock";
import { PRESET_THEMES } from "../../src/data/themes";
import { themeToImportString } from "../../src/lib/theme";
import { readFileSync } from "node:fs";

test("three complete background cycles: upload → tune → apply → remove → clear → reload", async ({ page }) => {
  await desktopMock(page);
  await openBackground(page);
  for (let cycle = 0; cycle < 3; cycle++) {
    await chooseImage(page, `背景-${cycle}.png`);
    await page.getByRole("slider", { name: /暗色遮罩/ }).fill(String(20 + cycle));
    await page.getByRole("button", { name: "应用图片背景", exact: true }).click();
    await expect(page.locator(".background-status")).toHaveText("正在生效");
    await page.getByRole("button", { name: "重新应用效果" }).click();
    await expect(page.locator(".background-status")).toHaveText("正在生效");
    await page.getByRole("button", { name: "移除当前效果" }).click();
    await expect(page.locator(".background-status")).toHaveText("等待应用");
    await page.getByRole("button", { name: "清除图片", exact: true }).click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator(".background-facts")).toContainText(`背景-${cycle}.png`);
    await page.getByRole("button", { name: "清除图片", exact: true }).click();
    await page.getByRole("button", { name: "确认清除" }).click();
    await expect(page.locator(".background-status")).toHaveText("尚未选图");
    await openBackground(page);
    await expect(page.locator(".background-status")).toHaveText("尚未选图");
  }
});

test("draft survives refresh, replacing image, navigating and restarting studio", async ({ page }) => {
  await desktopMock(page); await openBackground(page); await chooseImage(page);
  await page.getByRole("slider", { name: /暗色遮罩/ }).fill("62");
  await page.getByRole("button", { name: "完整显示", exact: true }).click();
  await page.getByTitle("刷新状态", { exact: true }).click();
  await expect(page.getByRole("slider", { name: /暗色遮罩/ })).toHaveValue("62");
  await chooseImage(page, "替换.png");
  await expect(page.getByRole("slider", { name: /暗色遮罩/ })).toHaveValue("62");
  await openBackground(page);
  await expect(page.getByRole("slider", { name: /暗色遮罩/ })).toHaveValue("62");
  await expect(page.getByRole("slider", { name: /缩放/ })).toBeDisabled();
});

test("custom theme name, color and font survive restart", async ({ page }) => {
  await desktopMock(page); await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: /主题工坊/ }).click();
  await page.getByLabel("主题名称", { exact: true }).fill("我的自定义配色");
  await page.getByLabel("强调色取色器", { exact: true }).fill("#123456");
  await page.getByLabel("UI 字体", { exact: true }).fill("Arial");
  await page.reload();
  await page.getByRole("navigation").getByRole("button", { name: /主题工坊/ }).click();
  await expect(page.getByLabel("主题名称", { exact: true })).toHaveValue("我的自定义配色");
  await expect(page.getByLabel("强调色取色器", { exact: true })).toHaveValue("#123456");
  await expect(page.getByLabel("UI 字体", { exact: true })).toHaveValue("Arial");
});

test("theme library apply, system pair and both recovery actions use the correct command", async ({ page }) => {
  await desktopMock(page); await page.emulateMedia({ colorScheme: "light" }); await page.goto("/");
  const card = page.locator(".theme-card").filter({ has: page.getByRole("heading", { name: PRESET_THEMES[1].name, exact: true }) });
  await card.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.locator(".inspector-copy h2")).toHaveText(PRESET_THEMES[1].name);
  await page.reload();
  await expect(page.locator(".inspector-copy h2")).toHaveText(PRESET_THEMES[1].name);
  await page.locator(".pair-card").first().getByRole("button", { name: "跟随系统" }).click();
  await page.getByRole("navigation").getByRole("button", { name: "主题工坊", exact: true }).click();
  await expect(page.locator(".control-panel-header .variant-pill")).toContainText("浅色");
  await page.getByRole("navigation").getByRole("button", { name: "备份与恢复", exact: true }).click();
  await page.getByRole("button", { name: /撤销上次应用/ }).click();
  await page.getByRole("button", { name: /恢复最初外观/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__commands.filter((c: any) => ["undo_last", "restore_original"].includes(c.command)).length)).toBe(2);
});

test("valid import survives restart and exports a portable file", async ({ page }) => {
  await desktopMock(page); await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "主题工坊", exact: true }).click();
  await page.getByRole("button", { name: "导入", exact: true }).click();
  const portable = themeToImportString({ ...PRESET_THEMES[0], accent: "#ABCDEF" });
  await page.locator("textarea").fill(portable);
  await page.getByRole("button", { name: "解析并预览" }).click();
  await expect(page.getByLabel("强调色取色器", { exact: true })).toHaveValue("#abcdef");
  await page.reload();
  await page.getByRole("navigation").getByRole("button", { name: "主题工坊", exact: true }).click();
  await expect(page.getByLabel("强调色取色器", { exact: true })).toHaveValue("#abcdef");
  const downloadPromise = page.waitForEvent("download");
  await page.getByTitle("导出 TXT", { exact: true }).click();
  const download = await downloadPromise;
  expect(readFileSync((await download.path())!, "utf8").trim()).toBe(portable);
});

test("restart needs explicit confirmation and does not silently write official theme", async ({ page }) => {
  await desktopMock(page, { restartRequired: true }); await openBackground(page); await chooseImage(page);
  await page.getByRole("button", { name: "应用图片背景", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("需要重开");
  await page.getByRole("button", { name: "稍后再说" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__commands.filter((c: any) => c.args.restart === true).length)).toBe(0);
  await page.getByRole("button", { name: "应用图片背景", exact: true }).click();
  await page.getByRole("button", { name: "我已保存，重开并应用" }).click();
  await expect(page.locator(".background-status")).toHaveText("正在生效");
  expect(await page.evaluate(() => (window as any).__commands.filter((c: any) => c.command === "apply_theme").length)).toBe(0);
});

test("failed clear is visible, retains image and permits retry", async ({ page }) => {
  await desktopMock(page); await openBackground(page); await chooseImage(page);
  await page.evaluate(() => { (window as any).__faults.clear_background = "连接中断；恢复信息仍保留"; });
  await page.getByRole("button", { name: "清除图片", exact: true }).click();
  await page.getByRole("button", { name: "确认清除" }).click();
  await expect(page.locator(".toast.error")).toContainText("连接中断");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => { delete (window as any).__faults.clear_background; });
  await page.getByRole("button", { name: "确认清除" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".background-status")).toHaveText("尚未选图");
});

test("rapid double apply invokes backend once and disables conflicting operations", async ({ page }) => {
  await desktopMock(page, { delay: 180 }); await openBackground(page); await chooseImage(page);
  const apply = page.getByRole("button", { name: "应用图片背景", exact: true });
  await expect(apply).toBeEnabled();
  await apply.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByRole("button", { name: "清除图片", exact: true })).toBeDisabled();
  await expect(page.getByRole("slider", { name: /暗色遮罩/ })).toBeDisabled();
  await expect(page.locator(".background-status")).toHaveText("正在生效");
  expect(await page.evaluate(() => (window as any).__commands.filter((c: any) => c.command === "apply_background").length)).toBe(1);
});

test("disabled background really removes session without a restart", async ({ page }) => {
  await desktopMock(page, { restartRequired: true }); await openBackground(page); await chooseImage(page);
  await page.getByRole("checkbox", { name: /显示图片背景/ }).uncheck();
  await page.getByRole("button", { name: "应用停用设置" }).click();
  await expect(page.locator(".background-status")).toHaveText("已停用");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("editing active background reports pending changes instead of falsely claiming live settings", async ({ page }) => {
  await desktopMock(page); await openBackground(page); await chooseImage(page);
  await page.getByRole("button", { name: "应用图片背景", exact: true }).click();
  await expect(page.locator(".background-status")).toHaveText("正在生效");
  await page.getByRole("slider", { name: /暗色遮罩/ }).fill("66");
  await expect(page.locator(".background-status")).toHaveText("参数待应用");
  await page.getByTitle("刷新状态", { exact: true }).click();
  await expect(page.locator(".background-status")).toHaveText("参数待应用");
});

test("clear confirmation can be canceled using only keyboard", async ({ page }) => {
  await desktopMock(page); await openBackground(page); await chooseImage(page);
  await page.getByRole("button", { name: "清除图片", exact: true }).click();
  await expect(page.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "确认清除" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".background-facts")).toContainText("我的背景.png");
});

test("unsupported image and malformed theme are rejected, page stays usable", async ({ page }) => {
  await desktopMock(page); await openBackground(page);
  await page.locator('input[type="file"]').setInputFiles({ name: "bad.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(page.locator(".toast.error")).toContainText("PNG");
  await page.getByRole("navigation").getByRole("button", { name: /主题工坊/ }).click();
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.locator("textarea").fill("codex-theme-v1:{broken}");
  await page.getByRole("button", { name: "解析并预览" }).click();
  await expect(page.locator(".dialog-error")).toContainText("JSON");
});

for (const viewport of [{ width: 980, height: 680 }, { width: 1280, height: 840 }]) {
  test(`window ${viewport.width}×${viewport.height} has reachable actions without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize(viewport); await desktopMock(page); await openBackground(page); await chooseImage(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "应用图片背景", exact: true }).click();
    await expect(page.locator(".background-status")).toHaveText("正在生效");
    await page.screenshot({ path: `artifacts/background-${viewport.width}.png` });
  });
}
