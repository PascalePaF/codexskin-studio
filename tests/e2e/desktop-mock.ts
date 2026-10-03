import { expect, type Page } from "@playwright/test";

// Contract mock for UI flows only. Rust/CDP and the bundled injection script
// are verified separately; this must never be called a live client test.
export async function desktopMock(page: Page, options: { restartRequired?: boolean; delay?: number } = {}) {
  await page.addInitScript((options) => {
    const w = window as any;
    const defaults = { enabled: true, opacity: 88, darkness: 34, blur: 0, zoom: 108, positionX: 50, positionY: 50, panelOpacity: 76, fit: "cover", scope: "main" };
    let background = JSON.parse(localStorage.getItem("test.background") ?? "null") ?? {
      settings: defaults, configured: false, active: false, hasSession: false, endpointReady: false, appRunning: true,
      needsRestart: false, port: null, fileName: null, mime: null, width: null, height: null, imageDataUrl: null, experimental: true,
    };
    w.__commands = [];
    w.__faults = {};
    const save = () => localStorage.setItem("test.background", JSON.stringify(background));
    const state = () => JSON.parse(JSON.stringify({ ...background, savedSettings: background.settings }));
    w.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any = {}) => {
        w.__commands.push({ command, args });
        if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
        if (w.__faults[command]) throw w.__faults[command];
        switch (command) {
          case "get_environment": return { platform: "windows", codexHome: "test", configPath: "test/config.toml", configExists: true, appRunning: true, activeMode: "dark", managedLight: false, managedDark: true, hasOriginalSnapshot: true, hasUndoSnapshot: true };
          case "get_system_fonts": return [{ family: "Arial", source: "测试字体" }];
          case "get_background_state": return state();
          case "save_background_image": {
            const image = new Image(); image.src = args.dataUrl;
            await image.decode();
            background = { ...background, configured: true, active: false, fileName: args.fileName, imageDataUrl: args.dataUrl, mime: "image/png", width: image.naturalWidth, height: image.naturalHeight };
            save(); return state();
          }
          case "update_background_settings": background.settings = args.settings; save(); return state();
          case "apply_background": {
            if (options.restartRequired && !args.restart && !background.endpointReady && background.settings.enabled) throw "RESTART_REQUIRED:test";
            background = { ...background, active: background.settings.enabled, hasSession: background.settings.enabled, endpointReady: true, port: 9341 };
            save(); return { active: background.active, targets: background.active ? 1 : 0, port: 9341, restarted: args.restart, sessionOnly: true };
          }
          case "restore_background": background.active = false; background.hasSession = false; save(); return state();
          case "clear_background": background = { ...background, configured: false, active: false, hasSession: false, fileName: null, imageDataUrl: null, settings: defaults }; save(); return state();
          case "apply_theme":
          case "apply_theme_pair": return { configPath: "test/config.toml", backupPath: "test/backup.toml", variant: args.theme?.variant ?? "system", appRunning: true, restartRequested: false };
          case "undo_last":
          case "restore_original": return { configPath: "test/config.toml", backupPath: "test/backup.toml", restoredKeys: 5, appRunning: true };
          default: throw new Error(`Unmocked command: ${command}`);
        }
      },
    };
  }, options);
}

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

export async function openBackground(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /图片背景/ }).click();
  await page.locator("fieldset.interaction-lock").waitFor();
  await expect(page.locator('input[type="file"]')).toBeEnabled();
}

export async function chooseImage(page: Page, name = "我的背景.png") {
  await expect(page.locator('input[type="file"]')).toBeEnabled();
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 900;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 1600, 900);
    gradient.addColorStop(0, "#c15e31"); gradient.addColorStop(.5, "#354a86"); gradient.addColorStop(1, "#76bdad");
    context.fillStyle = gradient; context.fillRect(0, 0, 1600, 900);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "image/png", buffer: Buffer.from(data, "base64") });
  await expect(page.locator(".background-facts")).toContainText(name);
  await expect(page.locator('input[type="file"]')).toBeEnabled();
}
