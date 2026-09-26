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
  applyTheme,
  applyThemePair,
  getEnvironment,
  getSystemFonts,
  openChatGpt,
  restoreOriginal,
  revealConfig,
  undoLast,
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
import type {
  AppPage,
  EnvironmentInfo,
  SkinTheme,
  SystemFont,
  ThemePair,
} from "./types";

type Toast = { id: number; kind: "success" | "error" | "info"; message: string };
type ThemeFilter = "all" | "dark" | "light" | "favorites";

const NAV_ITEMS: Array<{ id: AppPage; label: string; hint: string; icon: IconName }> = [
  { id: "themes", label: "主题库", hint: "8 套 · 4 组昼夜", icon: "palette" },
  { id: "studio", label: "主题工坊", hint: "预览与自定义", icon: "sliders" },
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

  useEffect(() => {
    void refreshEnvironment();
    void refreshFonts();
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
            <small>STUDIO · 1.1.0</small>
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
            <p>不登录 · 不上传 · 不注入</p>
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

function ThemePreview({ theme, compact = false }: { theme: SkinTheme; compact?: boolean }) {
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
  } as CSSProperties;

  return (
    <div className={compact ? "theme-preview compact" : "theme-preview"} style={variables}>
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
    { number: "01", title: "官方能力已经足够做稳定 V1", text: "当前桌面端原生支持背景、前景、强调色、字体、主题复制与导入。首版不需要碰安装包。", tone: "blue" },
    { number: "02", title: "用户真正痛的是可读性与恢复", text: "社区反复抱怨纯黑刺眼、脚本更新后失效、不会恢复；这比“再多几张壁纸”更值得优先解决。", tone: "pink" },
    { number: "03", title: "Windows 安全主题工坊仍有空位", text: "强视觉项目多依赖 CDP 且偏 macOS。Windows 优先、官方格式、键级恢复形成清晰差异化。", tone: "green" },
  ];

  const sources = [
    ["OpenAI Docs", "桌面 Settings 与 Appearance", "learn.chatgpt.com/docs/reference/settings"],
    ["GitHub", "agent-paint · 官方字符串生成", "github.com/jzlosman/agent-paint"],
    ["GitHub", "ReTheme · Tauri 兼容层", "github.com/duxweb/ReTheme"],
    ["GitHub", "OpenChatGPTSkin · 数据契约", "github.com/u2bo/OpenChatGPTSkin"],
    ["Reddit", "暗色过黑与脚本失效反馈", "reddit.com/r/ChatGPT/comments/1t0w3or"],
    ["X", "开发者个性化与生产力信号", "x.com/TFWNicholson/status/2103415720625496365"],
  ];

  return (
    <section className="page research-page">
      <div className="research-hero">
        <div className="eyebrow"><span /> RESEARCH SNAPSHOT · 2026.09.26</div>
        <h1>不是再造一个注入器，<br /><em>而是把安全换肤做完整。</em></h1>
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
              ["希望图片背景、图标、布局深度定制", "后续"],
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
