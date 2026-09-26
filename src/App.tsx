import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Icon, type IconName } from "./components/Icon";
import {
  PRESET_THEMES,
  THEME_PAIRS,
  getPairThemes,
  getThemeById,
} from "./data/themes";
import {
  applyBackground,
  applyTheme,
  applyThemePair,
  clearBackground,
  getBackgroundState,
  getEnvironment,
  getSystemFonts,
  openChatGpt,
  restoreBackground,
  restoreOriginal,
  revealConfig,
  saveBackgroundImage,
  undoLast,
  updateBackgroundSettings,
} from "./lib/bridge";
import {
  colorWithAlpha,
  contrastGrade,
  contrastRatio,
  fileSafeThemeName,
  parseThemeString,
  themeToImportString,
  validateTheme,
} from "./lib/theme";
import {
  loadPreferences,
  recordRecent,
  savePreferences,
  toggleId,
} from "./lib/preferences";
import {
  DEFAULT_WALLPAPER_SETTINGS,
  readFileAsDataUrl,
  sanitizeWallpaperSettings,
  validateWallpaperFile,
} from "./lib/wallpaper";
import type {
  AppPage,
  BackgroundState,
  EnvironmentInfo,
  SkinTheme,
  SystemFont,
  ThemePair,
  WallpaperSettings,
} from "./types";

type Toast = { id: number; kind: "success" | "error" | "info"; message: string };
type ThemeFilter = "all" | "dark" | "light" | "favorites";

const NAV_ITEMS: Array<{ id: AppPage; label: string; hint: string; icon: IconName }> = [
  { id: "themes", label: "主题库", hint: "8 套 · 4 组昼夜", icon: "palette" },
  { id: "studio", label: "主题工坊", hint: "预览与自定义", icon: "sliders" },
  { id: "background", label: "图片背景", hint: "壁纸与玻璃效果", icon: "image" },
  { id: "recovery", label: "备份与恢复", hint: "撤销每次改动", icon: "shield" },
  { id: "research", label: "调研结论", hint: "证据与路线图", icon: "info" },
];

const INITIAL_ENVIRONMENT: EnvironmentInfo = {
  platform: "unknown",
  codexHome: "检测中…",
  configPath: "检测中…",
  configExists: false,
  appRunning: false,
  activeMode: null,
  managedLight: false,
  managedDark: false,
  hasOriginalSnapshot: false,
  hasUndoSnapshot: false,
};

const INITIAL_BACKGROUND: BackgroundState = {
  settings: { ...DEFAULT_WALLPAPER_SETTINGS },
  configured: false,
  active: false,
  endpointReady: false,
  appRunning: false,
  needsRestart: false,
  port: null,
  fileName: null,
  mime: null,
  width: null,
  height: null,
  imageDataUrl: null,
  experimental: true,
};

function cloneTheme(theme: SkinTheme): SkinTheme {
  return { ...theme, tags: [...theme.tags] };
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "发生未知错误";
}

function App() {
  const [preferences, setPreferences] = useState(() => loadPreferences());
  const [page, setPage] = useState<AppPage>("themes");
  const [environment, setEnvironment] = useState<EnvironmentInfo>(INITIAL_ENVIRONMENT);
  const [environmentLoading, setEnvironmentLoading] = useState(true);
  const [selectedTheme, setSelectedTheme] = useState<SkinTheme>(() => cloneTheme(
    getThemeById(loadPreferences().selectedThemeId ?? "") ?? PRESET_THEMES[0],
  ));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ThemeFilter>("all");
  const [restartAfterApply, setRestartAfterApply] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [systemFonts, setSystemFonts] = useState<SystemFont[]>([]);
  const [fontsLoading, setFontsLoading] = useState(true);
  const [background, setBackground] = useState<BackgroundState>(INITIAL_BACKGROUND);
  const [backgroundLoading, setBackgroundLoading] = useState(true);
  const [backgroundRestartOpen, setBackgroundRestartOpen] = useState(false);

  const refreshEnvironment = async () => {
    setEnvironmentLoading(true);
    try {
      setEnvironment(await getEnvironment());
    } catch (error) {
      pushToast("error", `环境检测失败：${errorMessage(error)}`);
    } finally {
      setEnvironmentLoading(false);
    }
  };

  const refreshFonts = async (notify = false) => {
    setFontsLoading(true);
    try {
      const fonts = await getSystemFonts();
      setSystemFonts(fonts);
      if (notify) pushToast("success", `已扫描 ${fonts.length} 个本机字体系列`);
    } catch (error) {
      pushToast("error", `字体检测失败：${errorMessage(error)}`);
    } finally {
      setFontsLoading(false);
    }
  };

  const refreshBackground = async (notify = false) => {
    setBackgroundLoading(true);
    try {
      const state = await getBackgroundState();
      setBackground(state);
      if (notify) pushToast("success", "背景状态已刷新");
    } catch (error) {
      pushToast("error", `背景检测失败：${errorMessage(error)}`);
    } finally {
      setBackgroundLoading(false);
    }
  };

  useEffect(() => {
    void refreshEnvironment();
    void refreshFonts();
    void refreshBackground();
  }, []);

  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);

  const pushToast = (kind: Toast["kind"], message: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current, { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  };

  const selectTheme = (theme: SkinTheme, openStudio = false) => {
    setSelectedTheme(cloneTheme(theme));
    if (getThemeById(theme.id)) {
      setPreferences((current) => ({ ...current, selectedThemeId: theme.id }));
    }
    if (openStudio) setPage("studio");
  };

  const toggleFavoriteTheme = (themeId: string) => {
    setPreferences((current) => ({
      ...current,
      favoriteThemeIds: toggleId(current.favoriteThemeIds, themeId),
    }));
  };

  const toggleFavoritePair = (pairId: string) => {
    setPreferences((current) => ({
      ...current,
      favoritePairIds: toggleId(current.favoritePairIds, pairId),
    }));
  };

  const runApply = async (theme = selectedTheme) => {
    try {
      validateTheme(theme);
      setBusy(`apply:${theme.id}`);
      const result = await applyTheme(theme, restartAfterApply);
      const runningNote =
        result.appRunning && !result.restartRequested
          ? "；ChatGPT 正在运行，完全退出并重开后可确保生效"
          : "";
      pushToast(
        "success",
        environment.isDemo
          ? "演示应用成功；桌面版会在这里备份并写入真实配置"
          : `已应用「${theme.name}」${runningNote}`,
      );
      if (getThemeById(theme.id)) {
        setPreferences((current) => ({
          ...current,
          recentThemeIds: recordRecent(current.recentThemeIds, theme.id),
          selectedThemeId: theme.id,
        }));
      }
      await refreshEnvironment();
    } catch (error) {
      pushToast("error", `应用失败：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const previewPair = (pair: ThemePair) => {
    const themes = getPairThemes(pair);
    const preview = environment.activeMode === "light" ? themes.light : themes.dark;
    selectTheme(preview);
  };

  const runApplyPair = async (pair: ThemePair) => {
    try {
      const themes = getPairThemes(pair);
      setBusy(`pair:${pair.id}`);
      const result = await applyThemePair(themes.light, themes.dark, restartAfterApply);
      const runningNote = result.appRunning && !result.restartRequested
        ? "；完全退出并重开 ChatGPT 后可确保生效"
        : "";
      pushToast(
        "success",
        environment.isDemo
          ? `已模拟应用「${pair.name}」；桌面版会写入浅色和深色槽位`
          : `已应用「${pair.name}」，现在跟随系统明暗模式${runningNote}`,
      );
      const selectedForCurrentMode = environment.activeMode === "light" ? themes.light : themes.dark;
      setSelectedTheme(cloneTheme(selectedForCurrentMode));
      setPreferences((current) => ({
        ...current,
        recentPairIds: recordRecent(current.recentPairIds, pair.id),
        recentThemeIds: recordRecent(
          recordRecent(current.recentThemeIds, themes.light.id),
          themes.dark.id,
        ),
        selectedThemeId: selectedForCurrentMode.id,
      }));
      await refreshEnvironment();
    } catch (error) {
      pushToast("error", `组合应用失败：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const copyPortableTheme = async () => {
    try {
      const portable = themeToImportString(selectedTheme);
      await navigator.clipboard.writeText(portable);
      pushToast("success", "官方主题字符串已复制，可在 ChatGPT → Settings → Appearance → Import 粘贴");
    } catch (error) {
      pushToast("error", `复制失败：${errorMessage(error)}`);
    }
  };

  const downloadPortableTheme = () => {
    try {
      const portable = `${themeToImportString(selectedTheme)}\n`;
      const url = URL.createObjectURL(new Blob([portable], { type: "text/plain;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${fileSafeThemeName(selectedTheme)}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
      pushToast("success", "主题文件已导出");
    } catch (error) {
      pushToast("error", `导出失败：${errorMessage(error)}`);
    }
  };

  const selectBackgroundFile = async (file: File) => {
    try {
      validateWallpaperFile(file);
      setBusy("background-upload");
      const dataUrl = await readFileAsDataUrl(file);
      const state = await saveBackgroundImage(file.name, dataUrl);
      setBackground(state);
      pushToast(
        "success",
        environment.isDemo
          ? "图片已载入预览；桌面安装版会把副本安全保存在本机"
          : `已载入「${state.fileName}」，确认效果后再应用`,
      );
    } catch (error) {
      pushToast("error", `图片载入失败：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const changeBackgroundSettings = (settings: WallpaperSettings) => {
    setBackground((current) => ({
      ...current,
      settings: sanitizeWallpaperSettings(settings),
    }));
  };

  const runBackgroundApply = async (restart: boolean) => {
    if (!background.configured) {
      pushToast("info", "请先选择一张本机图片");
      return;
    }
    try {
      setBusy("background-apply");
      const saved = await updateBackgroundSettings(background.settings);
      setBackground(saved);
      let officialThemeWritten = false;
      if (restart || (!saved.appRunning && !saved.endpointReady)) {
        await applyTheme(selectedTheme, false);
        officialThemeWritten = true;
      }
      const result = await applyBackground(restart, selectedTheme);
      if (!officialThemeWritten) await applyTheme(selectedTheme, false);
      const state = await getBackgroundState();
      setBackground(state);
      setBackgroundRestartOpen(false);
      pushToast(
        "success",
        environment.isDemo
          ? "图片背景与主题色已在演示预览中应用"
          : `背景已应用到 ${result.targets} 个 ChatGPT 窗口；关闭桌面端后会自动失效`,
      );
      await refreshEnvironment();
    } catch (error) {
      const message = errorMessage(error);
      if (message.startsWith("RESTART_REQUIRED:")) {
        setBackgroundRestartOpen(true);
      } else {
        pushToast("error", `背景应用失败：${message}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const runBackgroundRestore = async () => {
    try {
      setBusy("background-restore");
      setBackground(await restoreBackground());
      pushToast("success", "已移除当前会话的图片背景；保存的图片和参数仍在");
    } catch (error) {
      pushToast("error", `恢复失败：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const runBackgroundClear = async () => {
    if (!window.confirm("移除当前背景，并删除 CodexSkin 保存的本机图片副本？原始图片不会受影响。")) return;
    try {
      setBusy("background-clear");
      setBackground(await clearBackground());
      pushToast("success", "已清除背景设置和 CodexSkin 保存的图片副本");
    } catch (error) {
      pushToast("error", `清除失败：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const runRecovery = async (mode: "undo" | "original") => {
    try {
      setBusy(mode);
      const result = mode === "undo" ? await undoLast() : await restoreOriginal();
      pushToast(
        "success",
        `已恢复 ${result.restoredKeys} 个外观设置；其他 ChatGPT 配置保持不变`,
      );
      await refreshEnvironment();
    } catch (error) {
      pushToast("error", `恢复失败：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const content = (() => {
    switch (page) {
      case "themes":
        return (
          <ThemesPage
            query={query}
            setQuery={setQuery}
            filter={filter}
            setFilter={setFilter}
            selectedTheme={selectedTheme}
            onSelect={selectTheme}
            onApply={(theme) => void runApply(theme)}
            onApplyPair={(pair) => void runApplyPair(pair)}
            onPreviewPair={previewPair}
            favoriteThemeIds={preferences.favoriteThemeIds}
            favoritePairIds={preferences.favoritePairIds}
            recentThemeIds={preferences.recentThemeIds}
            recentPairIds={preferences.recentPairIds}
            onToggleFavoriteTheme={toggleFavoriteTheme}
            onToggleFavoritePair={toggleFavoritePair}
            onImport={() => setImportOpen(true)}
            busy={busy}
          />
        );
      case "studio":
        return (
          <StudioPage
            theme={selectedTheme}
            onChange={setSelectedTheme}
            onApply={() => void runApply()}
            onCopy={() => void copyPortableTheme()}
            onDownload={downloadPortableTheme}
            onImport={() => setImportOpen(true)}
            restartAfterApply={restartAfterApply}
            onRestartChange={setRestartAfterApply}
            busy={busy === `apply:${selectedTheme.id}`}
            isDemo={Boolean(environment.isDemo)}
            systemFonts={systemFonts}
            fontsLoading={fontsLoading}
            onRefreshFonts={() => void refreshFonts(true)}
          />
        );
      case "background":
        return (
          <BackgroundPage
            state={background}
            loading={backgroundLoading}
            theme={selectedTheme}
            busy={busy}
            onFile={(file) => void selectBackgroundFile(file)}
            onSettingsChange={changeBackgroundSettings}
            onApply={() => void runBackgroundApply(false)}
            onRestore={() => void runBackgroundRestore()}
            onClear={() => void runBackgroundClear()}
            onRefresh={() => void refreshBackground(true)}
            onOpenStudio={() => setPage("studio")}
          />
        );
      case "recovery":
        return (
          <RecoveryPage
            environment={environment}
            loading={environmentLoading}
            onRefresh={() => void refreshEnvironment()}
            onUndo={() => void runRecovery("undo")}
            onRestore={() => void runRecovery("original")}
            onReveal={() => void revealConfig()}
            onOpenChatGpt={() => void openChatGpt()}
            busy={busy}
          />
        );
      case "research":
        return <ResearchPage />;
    }
  })();

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>CodexSkin</strong>
            <small>STUDIO · 1.2.0</small>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "nav-item active" : "nav-item"}
              onClick={() => setPage(item.id)}
              type="button"
            >
              <span className="nav-icon"><Icon name={item.icon} /></span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <div className="local-first-card">
          <div className="local-first-icon"><Icon name="shield" size={16} /></div>
          <div>
            <strong>LOCAL FIRST</strong>
            <p>不登录 · 不上传 · 仅本机增强</p>
          </div>
        </div>

        <div className="sidebar-footnote">
          <span className="status-dot" />
          <span>独立社区项目 · 非 OpenAI 官方</span>
        </div>
      </aside>

      <main className="app-main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>CodexSkin</span>
            <span>/</span>
            <strong>{NAV_ITEMS.find((item) => item.id === page)?.label}</strong>
          </div>
          <div className="topbar-actions">
            {environment.isDemo && <span className="demo-badge">浏览器演示</span>}
            <div className={environment.configExists ? "connection-chip ready" : "connection-chip"}>
              <span className="status-dot" />
              {environmentLoading
                ? "正在检测"
                : environment.configExists
                  ? `配置已连接 · ${environment.activeMode ?? "system"}`
                  : "等待 ChatGPT 配置"}
            </div>
            <button className="icon-button" title="重新检测" onClick={() => void refreshEnvironment()} type="button">
              <Icon name="refresh" size={17} />
            </button>
          </div>
        </header>

        <div className="page-scroll">{content}</div>
      </main>

      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImport={(theme) => {
            setSelectedTheme(theme);
            setImportOpen(false);
            setPage("studio");
            pushToast("success", "主题已安全解析并载入工坊，尚未写入 ChatGPT");
          }}
        />
      )}

      {backgroundRestartOpen && (
        <BackgroundRestartDialog
          busy={busy === "background-apply"}
          onClose={() => setBackgroundRestartOpen(false)}
          onConfirm={() => void runBackgroundApply(true)}
        />
      )}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast ${toast.kind}`} key={toast.id}>
            <span className="toast-icon">
              <Icon name={toast.kind === "success" ? "check" : "info"} size={17} />
            </span>
            <span>{toast.message}</span>
            <button
              type="button"
              onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
              aria-label="关闭提示"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ThemesPageProps {
  query: string;
  setQuery: (value: string) => void;
  filter: ThemeFilter;
  setFilter: (value: ThemeFilter) => void;
  selectedTheme: SkinTheme;
  onSelect: (theme: SkinTheme, studio?: boolean) => void;
  onApply: (theme: SkinTheme) => void;
  onApplyPair: (pair: ThemePair) => void;
  onPreviewPair: (pair: ThemePair) => void;
  favoriteThemeIds: string[];
  favoritePairIds: string[];
  recentThemeIds: string[];
  recentPairIds: string[];
  onToggleFavoriteTheme: (themeId: string) => void;
  onToggleFavoritePair: (pairId: string) => void;
  onImport: () => void;
  busy: string | null;
}

function ThemesPage({
  query,
  setQuery,
  filter,
  setFilter,
  selectedTheme,
  onSelect,
  onApply,
  onApplyPair,
  onPreviewPair,
  favoriteThemeIds,
  favoritePairIds,
  recentThemeIds,
  recentPairIds,
  onToggleFavoriteTheme,
  onToggleFavoritePair,
  onImport,
  busy,
}: ThemesPageProps) {
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return PRESET_THEMES.filter((theme) => {
      if (filter === "favorites" && !favoriteThemeIds.includes(theme.id)) return false;
      if (filter !== "all" && filter !== "favorites" && theme.variant !== filter) return false;
      if (!needle) return true;
      return [theme.name, theme.englishName, theme.description, ...theme.tags]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [favoriteThemeIds, filter, query]);

  const visiblePairs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return THEME_PAIRS.filter((pair) => {
      if (filter === "favorites" && !favoritePairIds.includes(pair.id)) return false;
      if (!needle) return true;
      const themes = getPairThemes(pair);
      return [
        pair.name,
        pair.englishName,
        pair.description,
        ...pair.tags,
        themes.light.name,
        themes.dark.name,
      ].join(" ").toLowerCase().includes(needle);
    });
  }, [favoritePairIds, filter, query]);

  const recentThemes = recentThemeIds
    .map((id) => getThemeById(id))
    .filter((theme): theme is SkinTheme => Boolean(theme));

  return (
    <section className="page themes-page">
      <div className="hero-row">
        <div>
          <div className="eyebrow"><span /> CURATED THEMES</div>
          <h1>给工作区换一种<br /><em>更耐看的光。</em></h1>
          <p>
            选择经过可读性检查的原创配色，一键应用到 ChatGPT 桌面端。
            每次更改都有备份，也可以复制成官方主题字符串分享。
          </p>
        </div>
        <div className="hero-stat-grid">
          <div><strong>8</strong><span>原创主题</span></div>
          <div><strong>4</strong><span>昼夜组合</span></div>
          <div><strong>AA+</strong><span>正文对比度</span></div>
        </div>
      </div>

      <section className="pair-showcase" aria-labelledby="pair-heading">
        <div className="section-heading-row">
          <div>
            <span className="section-kicker"><Icon name="layers" size={13} /> SYSTEM PAIRS</span>
            <h2 id="pair-heading">一组配好白天与夜晚</h2>
            <p>一次写入两个外观槽位，ChatGPT 随系统明暗自动切换。</p>
          </div>
          <span className="pair-count">{visiblePairs.length} PAIRS</span>
        </div>
        <div className="pair-grid">
          {visiblePairs.map((pair) => (
            <ThemePairCard
              key={pair.id}
              pair={pair}
              favorite={favoritePairIds.includes(pair.id)}
              recent={recentPairIds.includes(pair.id)}
              applying={busy === `pair:${pair.id}`}
              onPreview={() => onPreviewPair(pair)}
              onApply={() => onApplyPair(pair)}
              onToggleFavorite={() => onToggleFavoritePair(pair.id)}
            />
          ))}
          {visiblePairs.length === 0 && (
            <div className="pair-empty">还没有收藏的昼夜组合</div>
          )}
        </div>
      </section>

      {recentThemes.length > 0 && (
        <div className="recent-strip">
          <span><Icon name="clock" size={13} />最近使用</span>
          <div>
            {recentThemes.map((theme) => (
              <button key={theme.id} type="button" onClick={() => onSelect(theme)}>
                <i style={{ background: theme.accent }} />{theme.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="toolbar-row">
        <div className="search-field">
          <Icon name="search" size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索颜色、氛围或主题名"
            aria-label="搜索主题"
          />
          <kbd>{filtered.length}</kbd>
        </div>
        <div className="segmented" aria-label="筛选主题模式">
          {([
            ["all", "全部"],
            ["dark", "深色"],
            ["light", "浅色"],
            ["favorites", "收藏"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <button className="secondary-button" onClick={onImport} type="button">
          <Icon name="upload" size={16} /> 导入主题
        </button>
      </div>

      <div className="theme-browser-layout">
        <div className="theme-grid">
          {filtered.map((theme, index) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              index={index}
              selected={selectedTheme.id === theme.id}
              onSelect={() => onSelect(theme)}
              onEdit={() => onSelect(theme, true)}
              onApply={() => onApply(theme)}
              favorite={favoriteThemeIds.includes(theme.id)}
              recent={recentThemeIds.includes(theme.id)}
              onToggleFavorite={() => onToggleFavoriteTheme(theme.id)}
              applying={busy === `apply:${theme.id}`}
            />
          ))}
          {filtered.length === 0 && (
            <div className="empty-state">
              <Icon name="search" size={26} />
              <strong>没有匹配的主题</strong>
              <span>换个关键词，或切回“全部”。</span>
            </div>
          )}
        </div>

        <aside className="theme-inspector">
          <div className="inspector-heading">
            <span>LIVE PREVIEW</span>
            <span className={`variant-pill ${selectedTheme.variant}`}>
              <Icon name={selectedTheme.variant === "dark" ? "moon" : "sun"} size={13} />
              {selectedTheme.variant === "dark" ? "深色" : "浅色"}
            </span>
          </div>
          <ThemePreview theme={selectedTheme} compact />
          <div className="inspector-copy">
            <div>
              <span className="theme-index">SELECTED THEME</span>
              <h2>{selectedTheme.name}</h2>
              <p>{selectedTheme.englishName} · {selectedTheme.description}</p>
            </div>
            <ContrastBadge theme={selectedTheme} />
          </div>
          <div className="inspector-actions">
            <button className="primary-button" onClick={() => onApply(selectedTheme)} disabled={Boolean(busy)} type="button">
              {busy === `apply:${selectedTheme.id}` ? <span className="spinner" /> : <Icon name="sparkles" size={17} />}
              一键应用
            </button>
            <button className="secondary-button square" onClick={() => onSelect(selectedTheme, true)} title="打开主题工坊" type="button">
              <Icon name="sliders" size={17} />
            </button>
          </div>
          <p className="inspector-note"><Icon name="shield" size={13} /> 应用前自动备份，只改外观配置</p>
        </aside>
      </div>
    </section>
  );
}

interface ThemePairCardProps {
  pair: ThemePair;
  favorite: boolean;
  recent: boolean;
  applying: boolean;
  onPreview: () => void;
  onApply: () => void;
  onToggleFavorite: () => void;
}

function ThemePairCard({
  pair,
  favorite,
  recent,
  applying,
  onPreview,
  onApply,
  onToggleFavorite,
}: ThemePairCardProps) {
  const { light, dark } = getPairThemes(pair);
  const style = {
    "--pair-light-surface": light.surface,
    "--pair-light-ink": light.ink,
    "--pair-light-accent": light.accent,
    "--pair-dark-surface": dark.surface,
    "--pair-dark-ink": dark.ink,
    "--pair-dark-accent": dark.accent,
  } as CSSProperties;

  return (
    <article className="pair-card" style={style}>
      <button
        className={favorite ? "favorite-button active" : "favorite-button"}
        type="button"
        onClick={onToggleFavorite}
        aria-label={favorite ? `取消收藏 ${pair.name}` : `收藏 ${pair.name}`}
        title={favorite ? "取消收藏" : "收藏"}
      >
        <Icon name="heart" size={14} />
      </button>
      <button className="pair-visual" type="button" onClick={onPreview} aria-label={`预览 ${pair.name}`}>
        <span className="pair-half light-half">
          <i /><b /><small><Icon name="sun" size={10} />{light.name}</small>
        </span>
        <span className="pair-half dark-half">
          <i /><b /><small><Icon name="moon" size={10} />{dark.name}</small>
        </span>
      </button>
      <div className="pair-copy">
        <div>
          <span>{pair.englishName}{recent ? " · RECENT" : ""}</span>
          <h3>{pair.name}</h3>
          <p>{pair.description}</p>
        </div>
        <button className="pair-apply" type="button" onClick={onApply} disabled={applying}>
          {applying ? <span className="spinner dark" /> : <><Icon name="refresh" size={13} />跟随系统</>}
        </button>
      </div>
    </article>
  );
}

interface ThemeCardProps {
  theme: SkinTheme;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onApply: () => void;
  favorite: boolean;
  recent: boolean;
  onToggleFavorite: () => void;
  applying: boolean;
}

function ThemeCard({
  theme,
  index,
  selected,
  onSelect,
  onEdit,
  onApply,
  favorite,
  recent,
  onToggleFavorite,
  applying,
}: ThemeCardProps) {
  const ratio = contrastRatio(theme.surface, theme.ink);
  const style = {
    "--card-surface": theme.surface,
    "--card-ink": theme.ink,
    "--card-accent": theme.accent,
    "--card-soft": colorWithAlpha(theme.accent, 0.16),
  } as CSSProperties;

  return (
    <article
      className={selected ? "theme-card selected" : "theme-card"}
      style={style}
      onClick={onSelect}
    >
      <button
        className={favorite ? "favorite-button theme-favorite active" : "favorite-button theme-favorite"}
        type="button"
        onClick={(event) => { event.stopPropagation(); onToggleFavorite(); }}
        aria-label={favorite ? `取消收藏 ${theme.name}` : `收藏 ${theme.name}`}
        title={favorite ? "取消收藏" : "收藏"}
      >
        <Icon name="heart" size={14} />
      </button>
      <div className="theme-swatch-scene">
        <div className="swatch-sidebar">
          <span className="swatch-logo" />
          <i /><i /><i />
        </div>
        <div className="swatch-content">
          <div className="swatch-topline"><i /><i /></div>
          <div className="swatch-message"><span /><i /><i /></div>
          <div className="swatch-code"><i /><i /><i /></div>
        </div>
        <div className="theme-card-number">{String(index + 1).padStart(2, "0")}</div>
        <span className="card-mode-icon">
          <Icon name={theme.variant === "dark" ? "moon" : "sun"} size={14} />
        </span>
      </div>
      <div className="theme-card-body">
        <div className="theme-card-title">
          <div><h3>{theme.name}</h3><span>{theme.englishName}</span></div>
          <div className="mini-palette">
            {[theme.accent, theme.diffAdded, theme.diffRemoved].map((color) => (
              <i key={color} style={{ background: color }} />
            ))}
          </div>
        </div>
        <p>{theme.description}</p>
        <div className="theme-card-meta">
          <span>对比度 {ratio.toFixed(1)}:1</span>
          <span>{theme.tags[0]}</span>
          {recent && <span className="recent-label"><Icon name="clock" size={9} />最近</span>}
        </div>
      </div>
      <div className="theme-card-actions">
        <button type="button" onClick={(event) => { event.stopPropagation(); onEdit(); }}>编辑</button>
        <button type="button" onClick={(event) => { event.stopPropagation(); onApply(); }} disabled={applying}>
          {applying ? <span className="spinner dark" /> : "应用"}
        </button>
      </div>
    </article>
  );
}

interface StudioPageProps {
  theme: SkinTheme;
  onChange: (theme: SkinTheme) => void;
  onApply: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onImport: () => void;
  restartAfterApply: boolean;
  onRestartChange: (value: boolean) => void;
  busy: boolean;
  isDemo: boolean;
  systemFonts: SystemFont[];
  fontsLoading: boolean;
  onRefreshFonts: () => void;
}

function StudioPage({
  theme,
  onChange,
  onApply,
  onCopy,
  onDownload,
  onImport,
  restartAfterApply,
  onRestartChange,
  busy,
  isDemo,
  systemFonts,
  fontsLoading,
  onRefreshFonts,
}: StudioPageProps) {
  const update = <K extends keyof SkinTheme>(key: K, value: SkinTheme[K]) => {
    onChange({ ...theme, id: theme.id.startsWith("custom-") ? theme.id : `custom-${Date.now()}`, [key]: value });
  };
  const ratio = contrastRatio(theme.surface, theme.ink);
  const grade = contrastGrade(ratio);

  return (
    <section className="page studio-page">
      <div className="page-title-row">
        <div>
          <div className="eyebrow"><span /> THEME WORKBENCH</div>
          <h1>主题工坊</h1>
          <p>调色、检查、预览，再决定是否写入。所有变化先停留在本地草稿。</p>
        </div>
        <div className="page-title-actions">
          <button className="secondary-button" onClick={onImport} type="button"><Icon name="upload" size={16} />导入</button>
          <button className="secondary-button" onClick={onCopy} type="button"><Icon name="copy" size={16} />复制官方格式</button>
          <button className="secondary-button square" onClick={onDownload} title="导出 TXT" type="button"><Icon name="download" size={16} /></button>
        </div>
      </div>

      <div className="studio-layout">
        <div className="studio-preview-column">
          <div className="preview-label-row">
            <div><span className="pulse-dot" />实时预览</div>
            <div>{theme.variant === "dark" ? "DARK" : "LIGHT"} · {Math.round(theme.contrast)} CONTRAST</div>
          </div>
          <ThemePreview theme={theme} />
          <div className="quality-strip">
            <div className="quality-score">
              <span className={`quality-ring ${grade.tone}`}>{grade.label}</span>
              <div><strong>{ratio.toFixed(2)} : 1</strong><span>前景与背景 · {grade.detail}</span></div>
            </div>
            <div className="quality-colors">
              <span><i style={{ background: theme.diffAdded }} />新增</span>
              <span><i style={{ background: theme.diffRemoved }} />删除</span>
              <span><i style={{ background: theme.skill }} />Skill</span>
            </div>
          </div>
        </div>

        <aside className="control-panel">
          <div className="control-panel-header">
            <div><span>EDITING</span><h2>{theme.name}</h2></div>
            <span className={`variant-pill ${theme.variant}`}>
              <Icon name={theme.variant === "dark" ? "moon" : "sun"} size={13} />
              {theme.variant === "dark" ? "深色槽位" : "浅色槽位"}
            </span>
          </div>

          <div className="control-section">
            <div className="control-section-title"><span>基本信息</span><small>01</small></div>
            <label className="text-control">
              <span>主题名称</span>
              <input value={theme.name} maxLength={40} onChange={(event) => update("name", event.target.value)} />
            </label>
            <div className="mode-control">
              <span>目标模式</span>
              <div className="segmented grow">
                <button type="button" className={theme.variant === "dark" ? "active" : ""} onClick={() => update("variant", "dark")}><Icon name="moon" size={14} />深色</button>
                <button type="button" className={theme.variant === "light" ? "active" : ""} onClick={() => update("variant", "light")}><Icon name="sun" size={14} />浅色</button>
              </div>
            </div>
          </div>

          <div className="control-section">
            <div className="control-section-title"><span>颜色系统</span><small>02</small></div>
            <div className="color-control-grid">
              <ColorControl label="强调色" value={theme.accent} onChange={(value) => update("accent", value)} />
              <ColorControl label="背景" value={theme.surface} onChange={(value) => update("surface", value)} />
              <ColorControl label="前景文字" value={theme.ink} onChange={(value) => update("ink", value)} />
              <ColorControl label="Skill" value={theme.skill} onChange={(value) => update("skill", value)} />
              <ColorControl label="Diff 新增" value={theme.diffAdded} onChange={(value) => update("diffAdded", value)} />
              <ColorControl label="Diff 删除" value={theme.diffRemoved} onChange={(value) => update("diffRemoved", value)} />
            </div>
          </div>

          <div className="control-section">
            <div className="control-section-title"><span>细节</span><small>03</small></div>
            <label className="range-control">
              <span><span>界面对比强度</span><strong>{theme.contrast}</strong></span>
              <input type="range" min="0" max="100" value={theme.contrast} onChange={(event) => update("contrast", Number(event.target.value))} />
              <i style={{ width: `${theme.contrast}%` }} />
            </label>
            <label className="text-control">
              <span>UI 字体</span>
              <input list="system-font-options" value={theme.fontUi} maxLength={160} onChange={(event) => update("fontUi", event.target.value)} placeholder="system-ui" />
            </label>
            <label className="text-control">
              <span>代码字体</span>
              <input list="system-font-options" value={theme.fontCode} maxLength={160} onChange={(event) => update("fontCode", event.target.value)} placeholder="ui-monospace" />
            </label>
            <datalist id="system-font-options">
              {systemFonts.map((font) => <option key={font.family} value={font.family}>{font.source}</option>)}
            </datalist>
            <div className="font-discovery">
              <span><Icon name="type" size={13} />{fontsLoading ? "正在扫描字体…" : `已找到 ${systemFonts.length} 个字体候选`}</span>
              <button type="button" onClick={onRefreshFonts} disabled={fontsLoading}>
                <Icon name="refresh" size={12} />重新扫描
              </button>
            </div>
          </div>

          <label className="restart-toggle">
            <input type="checkbox" checked={restartAfterApply} onChange={(event) => onRestartChange(event.target.checked)} />
            <span className="toggle-track"><i /></span>
            <span><strong>应用后重启 ChatGPT</strong><small>会停止正在运行的任务，默认关闭</small></span>
          </label>

          <button className="primary-button apply-large" onClick={onApply} disabled={busy} type="button">
            {busy ? <span className="spinner" /> : <Icon name="sparkles" size={18} />}
            {isDemo ? "模拟一键应用" : "一键应用到 ChatGPT"}
          </button>
          <p className="apply-footnote"><Icon name="shield" size={13} /> 本机快速应用 Beta · 写入前备份，可随时撤销</p>
        </aside>
      </div>
    </section>
  );
}

interface BackgroundPageProps {
  state: BackgroundState;
  loading: boolean;
  theme: SkinTheme;
  busy: string | null;
  onFile: (file: File) => void;
  onSettingsChange: (settings: WallpaperSettings) => void;
  onApply: () => void;
  onRestore: () => void;
  onClear: () => void;
  onRefresh: () => void;
  onOpenStudio: () => void;
}

function BackgroundPage({
  state,
  loading,
  theme,
  busy,
  onFile,
  onSettingsChange,
  onApply,
  onRestore,
  onClear,
  onRefresh,
  onOpenStudio,
}: BackgroundPageProps) {
  const settings = state.settings;
  const update = <K extends keyof WallpaperSettings>(key: K, value: WallpaperSettings[K]) => {
    onSettingsChange({ ...settings, [key]: value });
  };
  const applying = busy === "background-apply";
  const uploading = busy === "background-upload";
  const status = state.active
    ? { label: "正在生效", tone: "active" }
    : state.needsRestart
      ? { label: "需要重开一次", tone: "warn" }
      : state.configured
        ? { label: "等待应用", tone: "ready" }
        : { label: "尚未选图", tone: "idle" };

  return (
    <section className="page background-page">
      <div className="page-title-row">
        <div>
          <div className="eyebrow"><span /> WALLPAPER LAB · EXPERIMENTAL</div>
          <h1>图片背景</h1>
          <p>把本机图片、主题颜色和玻璃层组合成一套皮肤。图片留在设备上，关闭 ChatGPT 后增强层自动失效。</p>
        </div>
        <div className="page-title-actions">
          <button className="secondary-button" onClick={onOpenStudio} type="button"><Icon name="palette" size={16} />调整主题颜色</button>
          <button className="secondary-button square" onClick={onRefresh} disabled={loading} title="刷新状态" type="button">
            {loading ? <span className="spinner dark" /> : <Icon name="refresh" size={16} />}
          </button>
        </div>
      </div>

      <div className="background-layout">
        <div className="background-preview-column">
          <div className="preview-label-row">
            <div><span className={state.active ? "pulse-dot" : "status-dot"} />实时合成预览</div>
            <div className={`background-status ${status.tone}`}>{status.label}</div>
          </div>
          <ThemePreview theme={theme} wallpaper={state} />

          <div className="background-facts">
            <div>
              <span>图片</span>
              <strong>{state.fileName ?? "未选择"}</strong>
            </div>
            <div>
              <span>尺寸</span>
              <strong>{state.width && state.height ? `${state.width} × ${state.height}` : "—"}</strong>
            </div>
            <div>
              <span>作用范围</span>
              <strong>{settings.scope === "main" ? "仅内容区" : "整个窗口"}</strong>
            </div>
            <div>
              <span>运行方式</span>
              <strong>{state.active ? `本机端口 ${state.port}` : "会话级"}</strong>
            </div>
          </div>

          <div className="background-safety-note">
            <span className="background-safety-icon"><Icon name="shield" size={18} /></span>
            <div>
              <strong>本机增强，不修改 ChatGPT 安装文件</strong>
              <p>只连接 <code>127.0.0.1</code>；不读取聊天、不上传图片、不接收自定义 CSS 或脚本。客户端更新后若页面结构变化，可一键恢复。</p>
            </div>
            <span className="experimental-pill">实验功能</span>
          </div>
        </div>

        <aside className="control-panel background-controls">
          <div className="control-panel-header">
            <div><span>BACKGROUND</span><h2>{state.fileName ?? "选择一张背景图"}</h2></div>
            <span className={`health-pill ${state.active ? "healthy" : ""}`}>
              {state.active ? "LIVE" : "LOCAL"}
            </span>
          </div>

          <div className="control-section">
            <div className="control-section-title"><span>本机图片</span><small>01</small></div>
            <label className={`wallpaper-picker ${state.configured ? "configured" : ""}`}>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) onFile(file);
                  event.currentTarget.value = "";
                }}
              />
              <span className="wallpaper-picker-icon">
                {uploading ? <span className="spinner dark" /> : <Icon name="image" size={20} />}
              </span>
              <span>
                <strong>{state.configured ? "更换图片" : "选择背景图片"}</strong>
                <small>PNG · JPEG · WebP · 最大 8 MiB</small>
              </span>
              <Icon name="upload" size={15} />
            </label>
          </div>

          <div className="control-section">
            <div className="control-section-title"><span>画面</span><small>02</small></div>
            <label className="restart-toggle wallpaper-enabled">
              <input type="checkbox" checked={settings.enabled} onChange={(event) => update("enabled", event.target.checked)} />
              <span className="toggle-track"><i /></span>
              <span><strong>显示图片背景</strong><small>关闭后保留图片和全部参数</small></span>
            </label>
            <WallpaperRange label="图片强度" value={settings.opacity} min={10} max={100} unit="%" onChange={(value) => update("opacity", value)} />
            <WallpaperRange label="暗色遮罩" value={settings.darkness} min={0} max={85} unit="%" onChange={(value) => update("darkness", value)} />
            <WallpaperRange label="背景模糊" value={settings.blur} min={0} max={24} unit=" px" onChange={(value) => update("blur", value)} />
            <WallpaperRange label="面板不透明度" value={settings.panelOpacity} min={35} max={100} unit="%" onChange={(value) => update("panelOpacity", value)} />
          </div>

          <div className="control-section">
            <div className="control-section-title"><span>构图</span><small>03</small></div>
            <div className="mode-control wallpaper-mode">
              <span>适配</span>
              <div className="segmented grow">
                <button type="button" className={settings.fit === "cover" ? "active" : ""} onClick={() => update("fit", "cover")}>铺满</button>
                <button type="button" className={settings.fit === "contain" ? "active" : ""} onClick={() => update("fit", "contain")}>完整显示</button>
              </div>
            </div>
            <WallpaperRange label="缩放" value={settings.zoom} min={100} max={160} unit="%" disabled={settings.fit === "contain"} onChange={(value) => update("zoom", value)} />
            <div className="position-grid">
              <WallpaperRange label="水平焦点" value={settings.positionX} min={0} max={100} unit="%" onChange={(value) => update("positionX", value)} />
              <WallpaperRange label="垂直焦点" value={settings.positionY} min={0} max={100} unit="%" onChange={(value) => update("positionY", value)} />
            </div>
            <div className="mode-control wallpaper-mode scope-mode">
              <span>范围</span>
              <div className="segmented grow">
                <button type="button" className={settings.scope === "main" ? "active" : ""} onClick={() => update("scope", "main")}>仅内容区</button>
                <button type="button" className={settings.scope === "all" ? "active" : ""} onClick={() => update("scope", "all")}>整个窗口</button>
              </div>
            </div>
          </div>

          <div className="control-section theme-link-card">
            <div>
              <span>搭配主题</span>
              <strong>{theme.name}</strong>
              <small>{theme.variant === "dark" ? "深色" : "浅色"} · 应用时同步颜色</small>
            </div>
            <div className="background-palette" aria-label="当前主题色">
              {[theme.surface, theme.ink, theme.accent].map((color) => <i key={color} style={{ background: color }} />)}
            </div>
          </div>

          <div className="background-action-area">
            <button className="primary-button apply-large" onClick={onApply} disabled={!state.configured || applying} type="button">
              {applying ? <span className="spinner" /> : <Icon name="sparkles" size={18} />}
              {state.active ? "重新应用效果" : "应用图片与主题色"}
            </button>
            <div className="background-secondary-actions">
              <button type="button" onClick={onRestore} disabled={!state.active || busy === "background-restore"}>
                <Icon name="undo" size={14} />移除当前效果
              </button>
              <button type="button" onClick={onClear} disabled={!state.configured || busy === "background-clear"}>
                <Icon name="trash" size={14} />清除图片
              </button>
            </div>
            <p className="apply-footnote"><Icon name="info" size={13} /> 首次启用需要重开一次 ChatGPT，操作前会再次确认</p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function WallpaperRange({
  label,
  value,
  min,
  max,
  unit,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const percentage = ((value - min) / (max - min)) * 100;
  return (
    <label className={`range-control wallpaper-range ${disabled ? "disabled" : ""}`}>
      <span><span>{label}</span><strong>{value}{unit}</strong></span>
      <input type="range" min={min} max={max} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
      <i style={{ width: `${percentage}%` }} />
    </label>
  );
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="color-control">
      <span>{label}</span>
      <div>
        <span className="color-well" style={{ background: value }}>
          <input type="color" value={value} onChange={(event) => onChange(event.target.value.toUpperCase())} aria-label={`${label}取色器`} />
        </span>
        <code>{value.toUpperCase()}</code>
      </div>
    </label>
  );
}

function ContrastBadge({ theme }: { theme: SkinTheme }) {
  const ratio = contrastRatio(theme.surface, theme.ink);
  const grade = contrastGrade(ratio);
  return (
    <div className={`contrast-badge ${grade.tone}`}>
      <strong>{grade.label}</strong>
      <span>{ratio.toFixed(1)}:1</span>
    </div>
  );
}

function ThemePreview({
  theme,
  compact = false,
  wallpaper,
}: {
  theme: SkinTheme;
  compact?: boolean;
  wallpaper?: BackgroundState;
}) {
  const hasWallpaper = Boolean(
    wallpaper?.configured && wallpaper.imageDataUrl && wallpaper.settings.enabled,
  );
  const wallpaperSettings = wallpaper?.settings ?? DEFAULT_WALLPAPER_SETTINGS;
  const variables = {
    "--preview-surface": theme.surface,
    "--preview-ink": theme.ink,
    "--preview-accent": theme.accent,
    "--preview-accent-soft": colorWithAlpha(theme.accent, theme.variant === "dark" ? 0.16 : 0.11),
    "--preview-panel": colorWithAlpha(theme.ink, theme.variant === "dark" ? 0.055 : 0.045),
    "--preview-line": colorWithAlpha(theme.ink, theme.variant === "dark" ? 0.12 : 0.1),
    "--preview-muted": colorWithAlpha(theme.ink, 0.57),
    "--preview-added": theme.diffAdded,
    "--preview-removed": theme.diffRemoved,
    "--preview-skill": theme.skill,
    "--preview-ui-font": theme.fontUi || "system-ui",
    "--preview-code-font": theme.fontCode || "ui-monospace",
    "--preview-wallpaper-image": wallpaper?.imageDataUrl ? `url("${wallpaper.imageDataUrl}")` : "none",
    "--preview-wallpaper-opacity": wallpaperSettings.opacity / 100,
    "--preview-wallpaper-mask": colorWithAlpha("#000000", wallpaperSettings.darkness / 100),
    "--preview-wallpaper-blur": `${wallpaperSettings.blur}px`,
    "--preview-wallpaper-size": wallpaperSettings.fit === "contain" ? "contain" : `${wallpaperSettings.zoom}%`,
    "--preview-wallpaper-position": `${wallpaperSettings.positionX}% ${wallpaperSettings.positionY}%`,
    "--preview-main-glass": colorWithAlpha(theme.surface, wallpaperSettings.panelOpacity / 100),
    "--preview-sidebar-glass": colorWithAlpha(
      theme.surface,
      wallpaperSettings.scope === "all" ? wallpaperSettings.panelOpacity / 100 : 0.97,
    ),
  } as CSSProperties;

  const previewClass = [
    "theme-preview",
    compact ? "compact" : "",
    hasWallpaper ? "has-wallpaper" : "",
    wallpaperSettings.scope === "all" ? "wallpaper-all" : "wallpaper-main",
  ].filter(Boolean).join(" ");

  return (
    <div className={previewClass} style={variables}>
      {hasWallpaper && <div className="mock-wallpaper-layer" aria-hidden="true" />}
      <div className="mock-titlebar">
        <div className="window-dots"><i /><i /><i /></div>
        <span>ChatGPT · Codex</span>
        <div className="mock-title-actions"><i /><i /></div>
      </div>
      <div className="mock-app-body">
        <aside className="mock-sidebar">
          <div className="mock-brand"><span>◌</span><strong>Codex</strong></div>
          <button className="mock-new"><span>＋</span> 新聊天 <kbd>⌘ N</kbd></button>
          <div className="mock-nav-group">
            <small>工作区</small>
            <div className="active"><span>⌁</span>皮肤工具研究</div>
            <div><span>◇</span>设计系统</div>
            <div><span>↗</span>发布计划</div>
          </div>
          <div className="mock-nav-group recent">
            <small>最近</small>
            <div><i />完善主题预览</div>
            <div><i />检查配置写入</div>
            <div><i />整理社区调研</div>
          </div>
          <div className="mock-profile"><span>CS</span><div><strong>Local workspace</strong><small>仅在此设备</small></div></div>
        </aside>
        <main className="mock-main">
          <div className="mock-chat-header">
            <div><strong>CodexSkin V1</strong><span>本地任务</span></div>
            <div className="mock-header-buttons"><button>Review</button><button>···</button></div>
          </div>
          <div className="mock-conversation">
            <div className="mock-user-message">把主题应用流程做得安全、简单，而且随时可以恢复。</div>
            <div className="mock-assistant-message">
              <div className="assistant-avatar">✦</div>
              <div className="assistant-content">
                <p><strong>主题已经准备好了。</strong> 我先检查了文字对比度，再生成可分享的外观配置。</p>
                <div className="mock-skill-row"><span>✣</span><strong>Appearance audit</strong><i>passed</i></div>
                <div className="mock-code-card">
                  <div className="mock-code-head"><span>config.toml</span><span>Copy</span></div>
                  <code><span className="code-muted">[desktop]</span><br /><span className="code-key">appearanceTheme</span> = <span className="code-value">"{theme.variant}"</span><br /><span className="code-added">+ accent = "{theme.accent}"</span><br /><span className="code-removed">- default appearance</span></code>
                </div>
                <p className="mock-summary"><span>✓</span> 已创建备份 · 只修改外观键 · 可一键撤销</p>
              </div>
            </div>
          </div>
          <div className="mock-composer">
            <span>继续调整这个主题…</span>
            <div><button>＋</button><small>本地</small><button className="send-button">↑</button></div>
          </div>
        </main>
      </div>
    </div>
  );
}

interface RecoveryPageProps {
  environment: EnvironmentInfo;
  loading: boolean;
  onRefresh: () => void;
  onUndo: () => void;
  onRestore: () => void;
  onReveal: () => void;
  onOpenChatGpt: () => void;
  busy: string | null;
}

function RecoveryPage({
  environment,
  loading,
  onRefresh,
  onUndo,
  onRestore,
  onReveal,
  onOpenChatGpt,
  busy,
}: RecoveryPageProps) {
  const statusItems = [
    { label: "配置文件", value: environment.configExists ? "已找到" : "尚未创建", good: environment.configExists },
    { label: "当前模式", value: environment.activeMode ?? "跟随系统 / 默认", good: true },
    { label: "浅色自定义", value: environment.managedLight ? "已配置" : "使用默认", good: true },
    { label: "深色自定义", value: environment.managedDark ? "已配置" : "使用默认", good: true },
    { label: "ChatGPT 进程", value: environment.appRunning ? "正在运行" : "未运行", good: true },
    { label: "恢复点", value: environment.hasOriginalSnapshot ? "可用" : "首次应用时创建", good: true },
  ];

  return (
    <section className="page recovery-page">
      <div className="page-title-row">
        <div>
          <div className="eyebrow"><span /> RECOVERY CENTER</div>
          <h1>备份与恢复</h1>
          <p>恢复只触碰外观键；你的模型、权限、插件、MCP 和其他设置不会被回滚。</p>
        </div>
        <button className="secondary-button" type="button" onClick={onRefresh} disabled={loading}>
          <Icon name="refresh" size={16} />重新检测
        </button>
      </div>

      <div className="recovery-layout">
        <div className="recovery-main-card">
          <div className="recovery-card-header">
            <div className="recovery-shield"><Icon name="shield" size={30} /></div>
            <div><span>CONFIGURATION HEALTH</span><h2>{environment.isDemo ? "演示环境正常" : environment.configExists ? "配置状态正常" : "等待首次配置"}</h2></div>
            <span className={environment.configExists ? "health-pill healthy" : "health-pill"}>{environment.configExists ? "HEALTHY" : "READY"}</span>
          </div>
          <div className="status-grid">
            {statusItems.map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong><i className={item.good ? "good" : ""} />{loading ? "检测中…" : item.value}</strong>
              </div>
            ))}
          </div>
          <div className="path-panel">
            <div><span>ACTIVE CONFIG</span><code>{environment.configPath}</code></div>
            <button type="button" onClick={onReveal} disabled={environment.isDemo}><Icon name="folder" size={17} />打开位置</button>
          </div>
        </div>

        <aside className="recovery-side-card">
          <span className="card-kicker">SAFE ACTIONS</span>
          <h2>需要回到之前吗？</h2>
          <p>每次应用前都会记录当时的外观状态，并额外保存完整配置副本作为应急保障。</p>
          <button className="primary-button recovery-action" type="button" onClick={onUndo} disabled={!environment.hasUndoSnapshot || busy !== null || environment.isDemo}>
            {busy === "undo" ? <span className="spinner" /> : <Icon name="undo" size={18} />}
            <span><strong>撤销上次应用</strong><small>恢复最近一次更改前的外观</small></span>
          </button>
          <button className="secondary-button recovery-action" type="button" onClick={onRestore} disabled={!environment.hasOriginalSnapshot || busy !== null || environment.isDemo}>
            {busy === "original" ? <span className="spinner dark" /> : <Icon name="restore" size={18} />}
            <span><strong>恢复最初外观</strong><small>回到首次使用本工具前</small></span>
          </button>
          <div className="recovery-divider" />
          <button className="text-button" type="button" onClick={onOpenChatGpt}><Icon name="external" size={15} />打开 ChatGPT</button>
        </aside>
      </div>

      <div className="safety-explainer">
        <div className="safety-number">01</div><div><strong>写入前备份</strong><span>完整配置副本带时间戳保存在应用数据目录。</span></div>
        <div className="safety-line" />
        <div className="safety-number">02</div><div><strong>只管外观键</strong><span>恢复时不覆盖后来修改的其他 ChatGPT 设置。</span></div>
        <div className="safety-line" />
        <div className="safety-number">03</div><div><strong>官方路径兜底</strong><span>随时可以复制主题字符串，改用 Appearance → Import。</span></div>
      </div>
    </section>
  );
}

function ResearchPage() {
  const findings = [
    { number: "01", title: "官方稳定层负责颜色，不负责图片", text: "桌面端原生支持背景色、前景色、强调色与字体，但没有公开任意图片背景字段。两层能力必须明确分开。", tone: "blue" },
    { number: "02", title: "社区已验证回环 CDP 路线", text: "CodeFace 等开源项目证明无需修改 app.asar 也能做会话级图片背景；关键是限制地址、输入和恢复范围。", tone: "pink" },
    { number: "03", title: "一键、可读、可恢复才是完整产品", text: "Windows 用户需要安装即用、实时预览、明确重启提示和一键回退，而不只是又一段随版本失效的 CSS。", tone: "green" },
  ];

  const sources = [
    ["OpenAI Docs", "桌面 Settings 与 Appearance", "learn.chatgpt.com/docs/reference/settings"],
    ["GitHub", "agent-paint · 官方字符串生成", "github.com/jzlosman/agent-paint"],
    ["GitHub", "ReTheme · Tauri 兼容层", "github.com/duxweb/ReTheme"],
    ["GitHub", "OpenChatGPTSkin · 数据契约", "github.com/u2bo/OpenChatGPTSkin"],
    ["GitHub", "CodeFace · 回环图片背景", "github.com/sundy-li/CodeFace"],
    ["Reddit", "暗色过黑与脚本失效反馈", "reddit.com/r/ChatGPT/comments/1t0w3or"],
  ];

  return (
    <section className="page research-page">
      <div className="research-hero">
        <div className="eyebrow"><span /> RESEARCH SNAPSHOT · 2026.09.26</div>
        <h1>稳定颜色打底，<br /><em>实验背景也能安全撤销。</em></h1>
        <p>基于 OpenAI 官方资料、GitHub 项目、开发者社区、Reddit、X 与中文生态的产品判断。</p>
      </div>

      <div className="finding-grid">
        {findings.map((finding) => (
          <article className={`finding-card ${finding.tone}`} key={finding.number}>
            <span>{finding.number}</span>
            <h2>{finding.title}</h2>
            <p>{finding.text}</p>
          </article>
        ))}
      </div>

      <div className="research-columns">
        <div className="research-panel">
          <div className="panel-heading"><div><span>USER NEEDS</span><h2>需求优先级</h2></div><strong>7 SIGNALS</strong></div>
          <ol className="need-list">
            {[
              ["默认黑白灰看腻，纯黑背景刺眼", "高"],
              ["想要预览后一次点击完成设置", "高"],
              ["不希望工具读取账号、聊天或上传图片", "高"],
              ["担心客户端更新后主题失效", "高"],
              ["需要可靠备份和看得懂的恢复入口", "高"],
              ["希望主题可以复制、分享和跨端迁移", "中"],
              ["希望图片背景与玻璃面板深度定制", "高"],
            ].map(([need, priority], index) => (
              <li key={need}><span>{String(index + 1).padStart(2, "0")}</span><strong>{need}</strong><i>{priority}</i></li>
            ))}
          </ol>
        </div>

        <div className="research-panel source-panel">
          <div className="panel-heading"><div><span>EVIDENCE</span><h2>核心来源</h2></div><strong>PUBLIC</strong></div>
          <div className="source-list">
            {sources.map(([type, title, url]) => (
              <a href={`https://${url}`} target="_blank" rel="noreferrer" key={url}>
                <span>{type}</span><div><strong>{title}</strong><small>{url}</small></div><Icon name="external" size={15} />
              </a>
            ))}
          </div>
          <div className="research-note"><Icon name="info" size={16} /><p>完整证据、竞品矩阵、明确不做事项和后续路线已写入 <code>docs/RESEARCH.md</code>。</p></div>
        </div>
      </div>
    </section>
  );
}

function BackgroundRestartDialog({
  busy,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <div className="import-dialog restart-dialog" role="dialog" aria-modal="true" aria-labelledby="background-restart-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading">
          <div className="dialog-icon warning"><Icon name="refresh" size={21} /></div>
          <div><span>ONE-TIME RESTART</span><h2 id="background-restart-title">需要重开一次 ChatGPT</h2></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭"><Icon name="close" /></button>
        </div>
        <p>为了让图片背景只通过本机安全通道生效，ChatGPT 需要以增强模式重新打开。<strong>当前窗口和正在运行的任务会被关闭</strong>，但聊天记录不会被删除。</p>
        <div className="restart-checklist">
          <div><span>1</span><p><strong>先保存工作</strong><small>等待正在运行的回复或任务结束。</small></p></div>
          <div><span>2</span><p><strong>自动重开</strong><small>仅增加 127.0.0.1 本机调试端口。</small></p></div>
          <div><span>3</span><p><strong>随时恢复</strong><small>关闭应用或点击移除效果即可失效。</small></p></div>
        </div>
        <div className="dialog-safety"><Icon name="shield" size={14} />不会修改 ChatGPT 安装包、签名、快捷方式或聊天数据</div>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>稍后再说</button>
          <button className="primary-button" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? <span className="spinner" /> : <Icon name="refresh" size={16} />}
            我已保存，重开并应用
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportDialog({ onClose, onImport }: { onClose: () => void; onImport: (theme: SkinTheme) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      onImport(parseThemeString(value));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="import-dialog" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading">
          <div className="dialog-icon"><Icon name="upload" size={21} /></div>
          <div><span>SAFE IMPORT</span><h2>导入 ChatGPT 主题</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </div>
        <p>粘贴完整的 <code>codex-theme-v1:</code> 字符串。工具只解析固定颜色、字体与模式字段，不会执行其中任何内容。</p>
        <textarea
          autoFocus
          value={value}
          onChange={(event) => { setValue(event.target.value); setError(null); }}
          placeholder={'codex-theme-v1:{"codeThemeId":"codex", ...}'}
          spellCheck={false}
        />
        {error && <div className="dialog-error"><Icon name="info" size={15} />{error}</div>}
        <div className="dialog-safety"><Icon name="shield" size={14} />最大 64 KB · 仅 #RRGGBB · 不接受 CSS / URL / 命令</div>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={!value.trim()}><Icon name="check" size={16} />解析并预览</button>
        </div>
      </form>
    </div>
  );
}

export default App;
