(async () => {
  // This fixed script is bundled with the app. No user CSS or code is accepted.
  const options = __CODEXSKIN_OPTIONS__;
  const { settings, surface, revision, image } = options;
  const KEY = "__CODEXSKIN_WALLPAPER__";
  const LAYER = "codexskin-wallpaper-layer";
  const STYLE = "codexskin-wallpaper-style";
  window[KEY]?.cleanup?.();
  if (!settings.enabled) return { ok: true, active: false };

  let stopped = false;
  const session = { cleanup: () => { stopped = true; if (window[KEY] === session) delete window[KEY]; }, check: () => ({ active: false, revision }) };
  window[KEY] = session;

  const picture = new Image();
  try { await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("背景图片解码超时")), 2500);
    picture.onload = () => { clearTimeout(timer); resolve(); };
    picture.onerror = () => { clearTimeout(timer); reject(new Error("背景图片无法显示")); };
    picture.src = image;
  }); } catch (error) { session.cleanup(); throw error; }
  if (stopped) return { ok: false, active: false };
  const mainSelector = "[data-app-shell-main-surface], [data-app-shell-main-content-layout], main";
  const findHost = () => settings.scope === "main"
    ? document.querySelector(mainSelector)
    : document.querySelector("[data-app-shell-feature-navigation], #root");
  let host, layer, style, previousPosition, previousIsolation, previousMarker;
  let observer;
  const unmount = () => {
    layer?.remove(); style?.remove();
    if (host) {
      host.style.position = previousPosition;
      host.style.isolation = previousIsolation;
      if (previousMarker === null) host.removeAttribute("data-codexskin-host");
      else host.setAttribute("data-codexskin-host", previousMarker);
    }
  };
  const mount = () => {
    const next = findHost();
    if (!next || stopped) return false;
    unmount();
    host = next;
    previousPosition = host.style.position;
    previousIsolation = host.style.isolation;
    previousMarker = host.getAttribute("data-codexskin-host");
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.style.isolation = "isolate";
    host.setAttribute("data-codexskin-host", "true");
    style = document.createElement("style");
    style.id = STYLE;
    // Do not change positioning/z-index of application children, menus or
    // dialogs. Only known shell surfaces become transparent above our layer.
    style.textContent = `
      [data-codexskin-host] { background-color: ${surface} !important; }
      [data-codexskin-host] :is([data-app-shell-main-surface], [data-app-shell-main-content-layout], [class*="_MainContentFrame_"]) {
        background-color: transparent !important;
      }
      ${settings.scope === "all" ? `[data-codexskin-host] :is(aside, .sidebar-navigation, [data-slate-sidebar-content], [class*="_LeftPanel_"], [class*="_Workspace_"]):not([role="dialog"]):not([role="dialog"] *) { background-color: transparent !important; }` : ""}
    `;
    layer = document.createElement("div");
    layer.id = LAYER;
    layer.setAttribute("aria-hidden", "true");
    Object.assign(layer.style, { position: "absolute", inset: "0", zIndex: "-1", overflow: "hidden", pointerEvents: "none", borderRadius: "inherit" });
    Object.assign(picture.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%", maxWidth: "none",
      objectFit: settings.fit, objectPosition: `${settings.positionX}% ${settings.positionY}%`,
      opacity: String(settings.opacity / 100),
      filter: `brightness(${1 - settings.darkness / 100}) blur(${settings.blur}px)`,
      transform: `scale(${settings.fit === "contain" ? 1 : settings.zoom / 100})`,
      transformOrigin: `${settings.positionX}% ${settings.positionY}%`,
    });
    const tint = document.createElement("div");
    Object.assign(tint.style, { position: "absolute", inset: "0", backgroundColor: surface, opacity: String(settings.panelOpacity / 100) });
    layer.append(picture, tint);
    document.head.append(style);
    host.prepend(layer);
    return true;
  };
  const cleanup = () => {
    stopped = true;
    observer?.disconnect();
    unmount();
    if (window[KEY] === session) delete window[KEY];
  };
  const check = () => ({
    revision,
    active: Boolean(!stopped && host?.isConnected && layer?.isConnected && style?.isConnected &&
      picture.complete && picture.naturalWidth > 0 && host.getBoundingClientRect().width > 0 && host.getBoundingClientRect().height > 0),
  });
  if (!mount() || !check().active) {
    cleanup();
    throw new Error("未找到兼容的内容区；当前客户端页面暂不支持图片背景");
  }
  observer = new MutationObserver(() => {
    if (!host.isConnected || !layer.isConnected || !style.isConnected) mount();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  Object.assign(session, { cleanup, check });
  return { ok: true, ...check() };
})()
