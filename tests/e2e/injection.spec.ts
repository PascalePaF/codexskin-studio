import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { DEFAULT_WALLPAPER_SETTINGS } from "../../src/lib/wallpaper";

const source = readFileSync("src-tauri/src/wallpaper.js", "utf8");
const fixture = `<style>
  html,body{margin:0;height:100%;background:#101820;color:white}
  #root{height:100vh;display:flex;position:relative}
  aside{width:200px;background:#222;flex-shrink:0}
  main{flex:1;background:#101820;position:relative}
  #popup{position:fixed;right:10px;top:10px;z-index:90;background:#333;padding:20px}
  #composer{position:absolute;bottom:10px;left:20px}
  </style><div id="root"><aside>Sidebar</aside><main data-app-shell-main-surface="browser"><h1>Fixture content</h1><input id="composer" value="untouched" /></main></div><div id="popup" role="dialog">Popup</div>`;

test.beforeEach(async ({ page }) => { await page.setContent(fixture); });

async function scriptFor(page: any, settings = {}) {
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 300; canvas.height = 100;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ff6600"; context.fillRect(0, 0, 150, 100);
    context.fillStyle = "#0088ff"; context.fillRect(150, 0, 150, 100);
    return canvas.toDataURL("image/png");
  });
  return source.replace("__CODEXSKIN_OPTIONS__", JSON.stringify({ image, settings: { ...DEFAULT_WALLPAPER_SETTINGS, ...settings }, surface: "#101820", revision: "r1" }));
}

for (const fit of ["cover", "contain"]) {
  for (const scope of ["main", "all"]) {
    test(`bundled injection ${fit}/${scope}: three apply → replace → cleanup cycles keep layout intact`, async ({ page }) => {
      const popupBefore = await page.locator("#popup").boundingBox();
      const composerBefore = await page.locator("#composer").boundingBox();
      const script = await scriptFor(page, { fit, scope, zoom: 160 });
      for (let cycle = 0; cycle < 3; cycle++) {
        expect(await page.evaluate((s) => eval(s), script)).toMatchObject({ active: true, revision: "r1" });
        await page.evaluate((s) => eval(s), script);
        await expect(page.locator("#codexskin-wallpaper-layer")).toHaveCount(1);
        await expect(page.locator("#codexskin-wallpaper-style")).toHaveCount(1);
        await expect(page.locator("#codexskin-wallpaper-layer img")).toHaveCSS("object-fit", fit);
        await expect(page.locator("#codexskin-wallpaper-layer img")).toHaveCSS("transform", fit === "contain" ? "matrix(1, 0, 0, 1, 0, 0)" : "matrix(1.6, 0, 0, 1.6, 0, 0)");
        expect(await page.locator("[data-codexskin-host]").evaluate((e) => e.tagName)).toBe(scope === "main" ? "MAIN" : "DIV");
        expect(await page.locator("#popup").boundingBox()).toEqual(popupBefore);
        await expect(page.locator("aside")).toHaveCSS("background-color", scope === "all" ? "rgba(0, 0, 0, 0)" : "rgb(34, 34, 34)");
        expect(await page.locator("#composer").boundingBox()).toEqual(composerBefore);
        await expect(page.locator("#composer")).toHaveValue("untouched");
        await page.evaluate(() => (window as any).__CODEXSKIN_WALLPAPER__.cleanup());
        await expect(page.locator("[data-codexskin-host]")).toHaveCount(0);
        await expect(page.locator("#codexskin-wallpaper-layer")).toHaveCount(0);
        expect(await page.locator("main").evaluate((e) => (e as HTMLElement).style.isolation)).toBe("");
      }
    });
  }
}

test("SPA content replacement reattaches exactly one layer, full reload does not claim persistence", async ({ page }) => {
  await page.evaluate((s) => eval(s), await scriptFor(page));
  await page.locator("main").evaluate((main) => { const next = document.createElement("main"); next.setAttribute("data-app-shell-main-surface", "browser"); next.textContent = "New route"; main.replaceWith(next); });
  await expect(page.locator("main #codexskin-wallpaper-layer")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__CODEXSKIN_WALLPAPER__.check().active)).toBe(true);
  await page.reload();
  expect(await page.evaluate(() => Boolean((window as any).__CODEXSKIN_WALLPAPER__))).toBe(false);
});

test("unknown client layout fails visibly and leaves no injected nodes", async ({ page }) => {
  await page.setContent("<div>No compatible shell</div>");
  const script = await scriptFor(page);
  await expect(page.evaluate((s) => eval(s), script)).rejects.toThrow("未找到兼容的内容区");
  await expect(page.locator("#codexskin-wallpaper-layer, #codexskin-wallpaper-style")).toHaveCount(0);
});

test("cleanup while decoding cancels pending injection instead of mounting later", async ({ page }) => {
  const script = await scriptFor(page);
  expect(await page.evaluate((s) => {
    const promise = eval(s);
    (window as any).__CODEXSKIN_WALLPAPER__.cleanup();
    return promise;
  }, script)).toMatchObject({ active: false });
  await expect(page.locator("#codexskin-wallpaper-layer")).toHaveCount(0);
});

test("corrupt pixel data is rejected before a layer is mounted", async ({ page }) => {
  const script = source.replace("__CODEXSKIN_OPTIONS__", JSON.stringify({ image: "data:image/png;base64,aW52YWxpZA==", settings: DEFAULT_WALLPAPER_SETTINGS, surface: "#101820", revision: "bad" }));
  await expect(page.evaluate((s) => eval(s), script)).rejects.toThrow("背景图片无法显示");
  expect(await page.evaluate(() => Boolean((window as any).__CODEXSKIN_WALLPAPER__))).toBe(false);
});
