use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use toml_edit::{DocumentMut, InlineTable, Item, Table, TableLike, Value};

const MANAGED_KEYS: [&str; 5] = [
    "appearanceTheme",
    "appearanceLightCodeThemeId",
    "appearanceDarkCodeThemeId",
    "appearanceLightChromeTheme",
    "appearanceDarkChromeTheme",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkinTheme {
    id: String,
    name: String,
    english_name: String,
    description: String,
    variant: String,
    accent: String,
    surface: String,
    ink: String,
    diff_added: String,
    diff_removed: String,
    skill: String,
    contrast: i64,
    opaque_windows: bool,
    font_ui: String,
    font_code: String,
    tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentInfo {
    platform: String,
    codex_home: String,
    config_path: String,
    config_exists: bool,
    app_running: bool,
    active_mode: Option<String>,
    managed_light: bool,
    managed_dark: bool,
    has_original_snapshot: bool,
    has_undo_snapshot: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyResult {
    config_path: String,
    backup_path: String,
    variant: String,
    app_running: bool,
    restart_requested: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreResult {
    config_path: String,
    backup_path: String,
    restored_keys: usize,
    app_running: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemFont {
    family: String,
    source: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppearanceSnapshot {
    config_existed: bool,
    values: BTreeMap<String, Option<String>>,
}

#[derive(Debug)]
struct StoragePaths {
    root: PathBuf,
    backups: PathBuf,
    original: PathBuf,
    undo: PathBuf,
}

fn codex_home() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("CODEX_HOME") {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .ok_or_else(|| "无法确定用户目录，也没有设置 CODEX_HOME".to_string())
}

fn storage_paths(app: &AppHandle) -> Result<StoragePaths, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))?;
    Ok(StoragePaths {
        backups: root.join("backups"),
        original: root.join("original-appearance.json"),
        undo: root.join("last-before-apply.json"),
        root,
    })
}

fn load_document(path: &Path) -> Result<DocumentMut, String> {
    if !path.exists() {
        return ""
            .parse::<DocumentMut>()
            .map_err(|error| format!("无法创建空配置：{error}"));
    }
    let source = fs::read_to_string(path)
        .map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    source
        .parse::<DocumentMut>()
        .map_err(|error| format!("{} 不是有效的 TOML：{error}", path.display()))
}

fn write_document(path: &Path, document: &DocumentMut) -> Result<(), String> {
    write_text_atomic(path, &document.to_string(), "配置")
}

fn write_text_atomic(path: &Path, contents: &str, label: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 {}：{error}", parent.display()))?;
        let mut staged = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| format!("无法创建{label}临时文件：{error}"))?;
        staged
            .write_all(contents.as_bytes())
            .map_err(|error| format!("无法写入{label}临时文件：{error}"))?;
        staged
            .as_file_mut()
            .flush()
            .map_err(|error| format!("无法刷新{label}临时文件：{error}"))?;
        staged
            .as_file()
            .sync_all()
            .map_err(|error| format!("无法同步{label}临时文件：{error}"))?;
        let persisted = staged
            .persist(path)
            .map_err(|error| format!("无法原子替换 {}：{}", path.display(), error.error))?;
        persisted
            .sync_all()
            .map_err(|error| format!("无法同步 {}：{error}", path.display()))?;
        return Ok(());
    }
    Err(format!("{} 没有可用的父目录", path.display()))
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn backup_config(config_path: &Path, paths: &StoragePaths, label: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(&paths.backups).map_err(|error| format!("无法创建备份目录：{error}"))?;
    let backup_path = paths
        .backups
        .join(format!("{}-{label}-config.toml", timestamp()));
    if config_path.exists() {
        fs::copy(config_path, &backup_path).map_err(|error| format!("无法备份配置：{error}"))?;
    } else {
        fs::write(
            &backup_path,
            "# config.toml did not exist before this operation.\n",
        )
        .map_err(|error| format!("无法记录空配置备份：{error}"))?;
    }
    Ok(backup_path)
}

fn desktop_table(document: &DocumentMut) -> Option<&dyn TableLike> {
    document.get("desktop").and_then(Item::as_table_like)
}

fn desktop_table_mut(document: &mut DocumentMut) -> Result<&mut dyn TableLike, String> {
    if !document.contains_key("desktop") {
        document["desktop"] = Item::Table(Table::new());
    }
    document
        .get_mut("desktop")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| "配置中的 desktop 不是有效表格，无法安全修改".to_string())
}

fn capture_snapshot(document: &DocumentMut, config_existed: bool) -> AppearanceSnapshot {
    let table = desktop_table(document);
    let values = MANAGED_KEYS
        .iter()
        .map(|key| {
            let value = table
                .and_then(|desktop| desktop.get(key))
                .and_then(Item::as_value)
                .map(ToString::to_string);
            ((*key).to_string(), value)
        })
        .collect();
    AppearanceSnapshot {
        config_existed,
        values,
    }
}

fn save_snapshot(path: &Path, snapshot: &AppearanceSnapshot) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建恢复点目录：{error}"))?;
    }
    let json = serde_json::to_string_pretty(snapshot)
        .map_err(|error| format!("无法序列化恢复点：{error}"))?;
    write_text_atomic(path, &json, "恢复点")
}

fn load_snapshot(path: &Path) -> Result<AppearanceSnapshot, String> {
    let json = fs::read_to_string(path)
        .map_err(|error| format!("无法读取恢复点 {}：{error}", path.display()))?;
    serde_json::from_str(&json).map_err(|error| format!("恢复点已损坏：{error}"))
}

fn parse_saved_value(value: &str) -> Result<Item, String> {
    let temporary = format!("saved = {value}\n")
        .parse::<DocumentMut>()
        .map_err(|error| format!("恢复点中的 TOML 值无效：{error}"))?;
    temporary
        .get("saved")
        .cloned()
        .ok_or_else(|| "恢复点缺少已保存值".to_string())
}

fn restore_snapshot(
    document: &mut DocumentMut,
    snapshot: &AppearanceSnapshot,
) -> Result<usize, String> {
    let desktop = desktop_table_mut(document)?;
    let mut restored = 0;
    for key in MANAGED_KEYS {
        let saved = snapshot.values.get(key).cloned().flatten();
        match saved {
            Some(serialized) => {
                let item = parse_saved_value(&serialized)?;
                let changed = desktop
                    .get(key)
                    .and_then(Item::as_value)
                    .map(ToString::to_string)
                    .as_deref()
                    != Some(serialized.as_str());
                if changed {
                    desktop.insert(key, item);
                    restored += 1;
                }
            }
            None => {
                if desktop.remove(key).is_some() {
                    restored += 1;
                }
            }
        }
    }
    Ok(restored)
}

fn valid_hex(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

fn validate_font(value: &str, label: &str) -> Result<(), String> {
    if value.len() > 160 {
        return Err(format!("{label}名称过长"));
    }
    let lowered = value.to_ascii_lowercase();
    if lowered.contains("url(")
        || value.contains(['{', '}', ';'])
        || value.chars().any(char::is_control)
    {
        return Err(format!("{label}包含不允许的内容"));
    }
    Ok(())
}

fn validate_theme(theme: &SkinTheme) -> Result<(), String> {
    if theme.variant != "light" && theme.variant != "dark" {
        return Err("主题模式只能是 light 或 dark".to_string());
    }
    for (label, color) in [
        ("accent", &theme.accent),
        ("surface", &theme.surface),
        ("ink", &theme.ink),
        ("diffAdded", &theme.diff_added),
        ("diffRemoved", &theme.diff_removed),
        ("skill", &theme.skill),
    ] {
        if !valid_hex(color) {
            return Err(format!("{label} 必须是 #RRGGBB 颜色"));
        }
    }
    if !(0..=100).contains(&theme.contrast) {
        return Err("对比度必须是 0–100 的整数".to_string());
    }
    validate_font(&theme.font_ui, "界面字体")?;
    validate_font(&theme.font_code, "代码字体")?;
    if theme.id.len() > 160
        || theme.name.len() > 160
        || theme.english_name.len() > 160
        || theme.description.len() > 1_000
        || theme.tags.len() > 32
    {
        return Err("主题元数据过大".to_string());
    }
    Ok(())
}

fn chrome_theme_value(theme: &SkinTheme) -> Item {
    let mut fonts = InlineTable::new();
    if !theme.font_code.trim().is_empty() {
        fonts.insert("code", Value::from(theme.font_code.trim()));
    }
    if !theme.font_ui.trim().is_empty() {
        fonts.insert("ui", Value::from(theme.font_ui.trim()));
    }

    let mut semantic = InlineTable::new();
    semantic.insert("diffAdded", Value::from(theme.diff_added.to_uppercase()));
    semantic.insert(
        "diffRemoved",
        Value::from(theme.diff_removed.to_uppercase()),
    );
    semantic.insert("skill", Value::from(theme.skill.to_uppercase()));

    let mut chrome = InlineTable::new();
    chrome.insert("accent", Value::from(theme.accent.to_uppercase()));
    chrome.insert("contrast", Value::from(theme.contrast));
    chrome.insert("fonts", Value::InlineTable(fonts));
    chrome.insert("ink", Value::from(theme.ink.to_uppercase()));
    chrome.insert("opaqueWindows", Value::from(theme.opaque_windows));
    chrome.insert("semanticColors", Value::InlineTable(semantic));
    chrome.insert("surface", Value::from(theme.surface.to_uppercase()));
    Item::Value(Value::InlineTable(chrome))
}

fn write_theme_slot(document: &mut DocumentMut, theme: &SkinTheme) -> Result<(), String> {
    validate_theme(theme)?;
    let variant = theme.variant.as_str();
    let code_key = format!("appearance{}CodeThemeId", capitalize(variant));
    let chrome_key = format!("appearance{}ChromeTheme", capitalize(variant));
    let desktop = desktop_table_mut(document)?;
    desktop.insert(&code_key, Item::Value(Value::from("codex")));
    desktop.insert(&chrome_key, chrome_theme_value(theme));
    Ok(())
}

fn apply_theme_to_document(document: &mut DocumentMut, theme: &SkinTheme) -> Result<(), String> {
    write_theme_slot(document, theme)?;
    desktop_table_mut(document)?.insert(
        "appearanceTheme",
        Item::Value(Value::from(theme.variant.as_str())),
    );
    Ok(())
}

fn apply_pair_to_document(
    document: &mut DocumentMut,
    light_theme: &SkinTheme,
    dark_theme: &SkinTheme,
) -> Result<(), String> {
    if light_theme.variant != "light" || dark_theme.variant != "dark" {
        return Err("主题组合必须包含一套浅色主题和一套深色主题".to_string());
    }
    write_theme_slot(document, light_theme)?;
    write_theme_slot(document, dark_theme)?;
    desktop_table_mut(document)?.insert("appearanceTheme", Item::Value(Value::from("system")));
    Ok(())
}

fn capitalize(value: &str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}

fn normalize_font_family(raw: &str) -> Option<String> {
    let mut name = raw.split(',').next()?.trim().to_string();
    if name.starts_with('@') || name.is_empty() || name.len() > 160 {
        return None;
    }
    if let Some(index) = name.rfind(" (") {
        if name.ends_with(')') {
            name.truncate(index);
        }
    }
    name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    const STYLE_SUFFIXES: [&str; 15] = [
        " Bold Italic",
        " Bold Oblique",
        " Extra Bold",
        " Extra Light",
        " Semi Bold",
        " Semibold",
        " Demi Bold",
        " Regular",
        " Medium",
        " Italic",
        " Oblique",
        " Bold",
        " Light",
        " Black",
        " Thin",
    ];
    loop {
        let lowered = name.to_ascii_lowercase();
        let suffix = STYLE_SUFFIXES
            .iter()
            .find(|suffix| lowered.ends_with(&suffix.to_ascii_lowercase()));
        match suffix {
            Some(suffix) => name.truncate(name.len() - suffix.len()),
            None => break,
        }
    }
    let name = name.trim().to_string();
    (!name.is_empty() && !name.chars().any(char::is_control)).then_some(name)
}

fn discover_platform_fonts() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $paths = @('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts', 'HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts'); $names = foreach ($path in $paths) { if (Test-Path $path) { (Get-ItemProperty $path).PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { $_.Name -replace '\s*\([^)]*\)\s*$', '' } } }; ConvertTo-Json -InputObject @($names | Sort-Object -Unique) -Compress"#;
        if let Ok(output) = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(
                    text.trim().trim_start_matches('\u{feff}'),
                ) {
                    return match value {
                        serde_json::Value::Array(values) => values
                            .into_iter()
                            .filter_map(|value| value.as_str().map(str::to_string))
                            .collect(),
                        serde_json::Value::String(value) => vec![value],
                        _ => Vec::new(),
                    };
                }
            }
        }
        Vec::new()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("fc-list")
            .args(["--format", "%{family}\n"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn collect_system_fonts() -> Vec<SystemFont> {
    let mut fonts = BTreeMap::<String, SystemFont>::new();
    let fallbacks = [
        "system-ui",
        "Segoe UI",
        "Microsoft YaHei UI",
        "Arial",
        "Georgia",
        "Cascadia Code",
        "Consolas",
        "Courier New",
        "SF Pro Text",
        "Menlo",
        "Noto Sans",
        "Noto Sans CJK SC",
    ];
    for raw in discover_platform_fonts() {
        if let Some(family) = normalize_font_family(&raw) {
            fonts.entry(family.to_lowercase()).or_insert(SystemFont {
                family,
                source: "本机字体".to_string(),
            });
        }
    }
    for raw in fallbacks {
        if let Some(family) = normalize_font_family(raw) {
            fonts.entry(family.to_lowercase()).or_insert(SystemFont {
                family,
                source: "通用候选".to_string(),
            });
        }
    }
    fonts.into_values().take(320).collect()
}

fn is_chatgpt_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq ChatGPT.exe", "/NH"])
            .output()
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .to_ascii_lowercase()
                    .contains("chatgpt.exe")
            })
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("pgrep")
            .args(["-f", "ChatGPT"])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn launch_chatgpt() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer.exe")
        .arg("codex://threads/new")
        .spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("codex://threads/new").spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg("codex://threads/new").spawn();
    result
        .map(|_| ())
        .map_err(|error| format!("无法打开 ChatGPT：{error}"))
}

fn restart_chatgpt() -> Result<(), String> {
    if is_chatgpt_running() {
        #[cfg(target_os = "windows")]
        let status = Command::new("taskkill")
            .args(["/IM", "ChatGPT.exe", "/T", "/F"])
            .status();
        #[cfg(not(target_os = "windows"))]
        let status = Command::new("pkill").args(["-f", "ChatGPT"]).status();
        status
            .map_err(|error| format!("无法结束 ChatGPT：{error}"))?
            .success()
            .then_some(())
            .ok_or_else(|| "ChatGPT 未能正常退出；主题已经写入，可稍后手动重开".to_string())?;
        thread::sleep(Duration::from_millis(900));
    }
    launch_chatgpt()
}

#[tauri::command]
fn get_environment(app: AppHandle) -> Result<EnvironmentInfo, String> {
    let home = codex_home()?;
    let config_path = home.join("config.toml");
    let config_exists = config_path.exists();
    let document = load_document(&config_path)?;
    let desktop = desktop_table(&document);
    let paths = storage_paths(&app)?;
    let _storage_root = &paths.root;
    Ok(EnvironmentInfo {
        platform: env::consts::OS.to_string(),
        codex_home: home.to_string_lossy().into_owned(),
        config_path: config_path.to_string_lossy().into_owned(),
        config_exists,
        app_running: is_chatgpt_running(),
        active_mode: desktop
            .and_then(|table| table.get("appearanceTheme"))
            .and_then(Item::as_str)
            .map(str::to_string),
        managed_light: desktop
            .and_then(|table| table.get("appearanceLightChromeTheme"))
            .is_some(),
        managed_dark: desktop
            .and_then(|table| table.get("appearanceDarkChromeTheme"))
            .is_some(),
        has_original_snapshot: paths.original.exists(),
        has_undo_snapshot: paths.undo.exists(),
    })
}

#[tauri::command]
fn apply_theme(app: AppHandle, theme: SkinTheme, restart: bool) -> Result<ApplyResult, String> {
    validate_theme(&theme)?;
    let config_path = codex_home()?.join("config.toml");
    let config_existed = config_path.exists();
    let paths = storage_paths(&app)?;
    fs::create_dir_all(&paths.root).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    let backup_path = backup_config(&config_path, &paths, "before-apply")?;
    let mut document = load_document(&config_path)?;
    let snapshot = capture_snapshot(&document, config_existed);
    if !paths.original.exists() {
        save_snapshot(&paths.original, &snapshot)?;
    }
    save_snapshot(&paths.undo, &snapshot)?;
    apply_theme_to_document(&mut document, &theme)?;
    write_document(&config_path, &document)?;

    let was_running = is_chatgpt_running();
    if restart {
        restart_chatgpt()?;
    }
    Ok(ApplyResult {
        config_path: config_path.to_string_lossy().into_owned(),
        backup_path: backup_path.to_string_lossy().into_owned(),
        variant: theme.variant,
        app_running: was_running,
        restart_requested: restart,
    })
}

#[tauri::command]
fn apply_theme_pair(
    app: AppHandle,
    light_theme: SkinTheme,
    dark_theme: SkinTheme,
    restart: bool,
) -> Result<ApplyResult, String> {
    validate_theme(&light_theme)?;
    validate_theme(&dark_theme)?;
    let config_path = codex_home()?.join("config.toml");
    let config_existed = config_path.exists();
    let paths = storage_paths(&app)?;
    fs::create_dir_all(&paths.root).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    let backup_path = backup_config(&config_path, &paths, "before-pair-apply")?;
    let mut document = load_document(&config_path)?;
    let snapshot = capture_snapshot(&document, config_existed);
    if !paths.original.exists() {
        save_snapshot(&paths.original, &snapshot)?;
    }
    save_snapshot(&paths.undo, &snapshot)?;
    apply_pair_to_document(&mut document, &light_theme, &dark_theme)?;
    write_document(&config_path, &document)?;

    let was_running = is_chatgpt_running();
    if restart {
        restart_chatgpt()?;
    }
    Ok(ApplyResult {
        config_path: config_path.to_string_lossy().into_owned(),
        backup_path: backup_path.to_string_lossy().into_owned(),
        variant: "system".to_string(),
        app_running: was_running,
        restart_requested: restart,
    })
}

#[tauri::command]
fn get_system_fonts() -> Vec<SystemFont> {
    collect_system_fonts()
}

fn run_restore(
    app: &AppHandle,
    snapshot_path: &Path,
    label: &str,
) -> Result<RestoreResult, String> {
    if !snapshot_path.exists() {
        return Err("没有可用的恢复点".to_string());
    }
    let config_path = codex_home()?.join("config.toml");
    let paths = storage_paths(app)?;
    let backup_path = backup_config(&config_path, &paths, label)?;
    let snapshot = load_snapshot(snapshot_path)?;
    let mut document = load_document(&config_path)?;
    let restored_keys = restore_snapshot(&mut document, &snapshot)?;
    write_document(&config_path, &document)?;
    Ok(RestoreResult {
        config_path: config_path.to_string_lossy().into_owned(),
        backup_path: backup_path.to_string_lossy().into_owned(),
        restored_keys,
        app_running: is_chatgpt_running(),
    })
}

#[tauri::command]
fn undo_last(app: AppHandle) -> Result<RestoreResult, String> {
    let paths = storage_paths(&app)?;
    run_restore(&app, &paths.undo, "before-undo")
}

#[tauri::command]
fn restore_original(app: AppHandle) -> Result<RestoreResult, String> {
    let paths = storage_paths(&app)?;
    run_restore(&app, &paths.original, "before-original-restore")
}

#[tauri::command]
fn open_chatgpt() -> Result<(), String> {
    launch_chatgpt()
}

#[tauri::command]
fn reveal_config() -> Result<(), String> {
    let config_path = codex_home()?.join("config.toml");
    #[cfg(target_os = "windows")]
    let result = if config_path.exists() {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", config_path.display()))
            .spawn()
    } else {
        Command::new("explorer.exe")
            .arg(config_path.parent().unwrap_or_else(|| Path::new(".")))
            .spawn()
    };
    #[cfg(target_os = "macos")]
    let result = if config_path.exists() {
        Command::new("open").arg("-R").arg(&config_path).spawn()
    } else {
        Command::new("open")
            .arg(config_path.parent().unwrap_or_else(|| Path::new(".")))
            .spawn()
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open")
        .arg(config_path.parent().unwrap_or_else(|| Path::new(".")))
        .spawn();
    result
        .map(|_| ())
        .map_err(|error| format!("无法打开配置位置：{error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_environment,
            apply_theme,
            apply_theme_pair,
            get_system_fonts,
            undo_last,
            restore_original,
            open_chatgpt,
            reveal_config
        ])
        .run(tauri::generate_context!())
        .expect("failed to run CodexSkin Studio");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_theme() -> SkinTheme {
        SkinTheme {
            id: "test".into(),
            name: "测试".into(),
            english_name: "Test".into(),
            description: "test theme".into(),
            variant: "dark".into(),
            accent: "#4CC9F0".into(),
            surface: "#0B1220".into(),
            ink: "#E5EDF7".into(),
            diff_added: "#62D6A7".into(),
            diff_removed: "#FF7B8A".into(),
            skill: "#B8A1FF".into(),
            contrast: 62,
            opaque_windows: true,
            font_ui: "system-ui".into(),
            font_code: "ui-monospace".into(),
            tags: vec!["测试".into()],
        }
    }

    #[test]
    fn apply_preserves_unrelated_configuration() {
        let mut document = r#"
model = "gpt-test"

[desktop]
notify = true
appearanceTheme = "light"
"#
        .parse::<DocumentMut>()
        .unwrap();
        apply_theme_to_document(&mut document, &sample_theme()).unwrap();
        assert_eq!(document["model"].as_str(), Some("gpt-test"));
        assert_eq!(document["desktop"]["notify"].as_bool(), Some(true));
        assert_eq!(
            document["desktop"]["appearanceTheme"].as_str(),
            Some("dark")
        );
        assert!(document["desktop"]
            .as_table_like()
            .unwrap()
            .contains_key("appearanceDarkChromeTheme"));
    }

    #[test]
    fn restore_only_managed_values() {
        let mut document = r#"
model = "original-model"

[desktop]
notify = true
appearanceTheme = "light"
"#
        .parse::<DocumentMut>()
        .unwrap();
        let snapshot = capture_snapshot(&document, true);
        apply_theme_to_document(&mut document, &sample_theme()).unwrap();
        document["model"] = toml_edit::value("changed-later");
        let restored = restore_snapshot(&mut document, &snapshot).unwrap();
        assert!(restored >= 2);
        assert_eq!(document["model"].as_str(), Some("changed-later"));
        assert_eq!(document["desktop"]["notify"].as_bool(), Some(true));
        assert_eq!(
            document["desktop"]["appearanceTheme"].as_str(),
            Some("light")
        );
        assert!(!document["desktop"]
            .as_table_like()
            .unwrap()
            .contains_key("appearanceDarkChromeTheme"));
    }

    #[test]
    fn validation_rejects_executable_font_content() {
        let mut theme = sample_theme();
        theme.font_ui = "url(https://example.test/font.woff)".into();
        assert!(validate_theme(&theme).is_err());
    }

    #[test]
    fn pair_apply_writes_both_slots_and_follows_system() {
        let mut document = "model = \"gpt-test\"\n".parse::<DocumentMut>().unwrap();
        let dark = sample_theme();
        let mut light = sample_theme();
        light.id = "light-test".into();
        light.variant = "light".into();
        light.surface = "#F7F7F5".into();
        light.ink = "#20201E".into();
        apply_pair_to_document(&mut document, &light, &dark).unwrap();
        let desktop = document["desktop"].as_table_like().unwrap();
        assert_eq!(
            desktop
                .get("appearanceTheme")
                .and_then(Item::as_value)
                .and_then(Value::as_str),
            Some("system")
        );
        assert!(desktop.contains_key("appearanceLightChromeTheme"));
        assert!(desktop.contains_key("appearanceDarkChromeTheme"));
        assert_eq!(document["model"].as_str(), Some("gpt-test"));
    }

    #[test]
    fn font_normalization_groups_style_variants() {
        assert_eq!(
            normalize_font_family("Cascadia Code Bold (TrueType)"),
            Some("Cascadia Code".into())
        );
        assert_eq!(normalize_font_family("@Vertical Font"), None);
    }

    #[test]
    fn system_font_discovery_returns_safe_candidates() {
        let fonts = collect_system_fonts();
        assert!(!fonts.is_empty());
        assert!(fonts.len() <= 320);
        assert!(fonts.iter().all(|font| {
            !font.family.trim().is_empty()
                && !font.family.chars().any(char::is_control)
                && matches!(font.source.as_str(), "本机字体" | "通用候选")
        }));
    }

    #[test]
    fn atomic_write_replaces_complete_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        fs::write(&path, "model = \"before\"\n").unwrap();
        write_text_atomic(&path, "model = \"after\"\n", "测试配置").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "model = \"after\"\n");
    }
}
