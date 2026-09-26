use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{io::Reader as ImageReader, ImageFormat};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Cursor, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
};
use tungstenite::{connect, Message};
use url::Url;

const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_SIDE: u32 = 8_192;
const MAX_IMAGE_PIXELS: u64 = 40_000_000;
const FIRST_DEBUG_PORT: u16 = 9_341;
const LAST_DEBUG_PORT: u16 = 9_360;
const MANIFEST_FILE: &str = "manifest.json";
const RUNTIME_FILE: &str = "runtime.json";
const WALLPAPER_STEM: &str = "wallpaper";
const STYLE_ID: &str = "codexskin-wallpaper-style";
const LAYER_ID: &str = "codexskin-wallpaper-layer";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WallpaperSettings {
    pub enabled: bool,
    pub opacity: u8,
    pub darkness: u8,
    pub blur: u8,
    pub zoom: u16,
    pub position_x: u8,
    pub position_y: u8,
    pub panel_opacity: u8,
    pub fit: String,
    pub scope: String,
}

impl Default for WallpaperSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            opacity: 88,
            darkness: 34,
            blur: 0,
            zoom: 108,
            position_x: 50,
            position_y: 50,
            panel_opacity: 76,
            fit: "cover".to_string(),
            scope: "main".to_string(),
        }
    }
}

impl WallpaperSettings {
    fn validate(&self) -> Result<(), String> {
        if self.opacity > 100
            || self.darkness > 90
            || self.blur > 30
            || !(100..=160).contains(&self.zoom)
            || self.position_x > 100
            || self.position_y > 100
            || !(25..=100).contains(&self.panel_opacity)
        {
            return Err("背景参数超出安全范围".to_string());
        }
        if self.fit != "cover" && self.fit != "contain" {
            return Err("背景适配方式无效".to_string());
        }
        if self.scope != "main" && self.scope != "all" {
            return Err("背景作用范围无效".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundManifest {
    settings: WallpaperSettings,
    original_name: String,
    file_name: String,
    mime: String,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RuntimeRegistration {
    target_id: String,
    script_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BackgroundRuntime {
    active: bool,
    port: Option<u16>,
    executable: Option<String>,
    registrations: Vec<RuntimeRegistration>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundState {
    settings: WallpaperSettings,
    configured: bool,
    active: bool,
    endpoint_ready: bool,
    app_running: bool,
    needs_restart: bool,
    port: Option<u16>,
    file_name: Option<String>,
    mime: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    image_data_url: Option<String>,
    experimental: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundApplyResult {
    active: bool,
    port: u16,
    targets: usize,
    restarted: bool,
    session_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CdpTarget {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default, rename = "type")]
    target_type: String,
    #[serde(default)]
    web_socket_debugger_url: String,
}

fn background_dir(root: &Path) -> PathBuf {
    root.join("background")
}

fn manifest_path(root: &Path) -> PathBuf {
    background_dir(root).join(MANIFEST_FILE)
}

fn runtime_path(root: &Path) -> PathBuf {
    background_dir(root).join(RUNTIME_FILE)
}

fn write_atomic(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label}没有可用的父目录"))?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建背景目录：{error}"))?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法创建{label}临时文件：{error}"))?;
    staged
        .write_all(bytes)
        .map_err(|error| format!("无法写入{label}临时文件：{error}"))?;
    staged
        .as_file_mut()
        .flush()
        .map_err(|error| format!("无法刷新{label}临时文件：{error}"))?;
    staged
        .as_file()
        .sync_all()
        .map_err(|error| format!("无法同步{label}临时文件：{error}"))?;
    staged
        .persist(path)
        .map_err(|error| format!("无法保存{label}：{}", error.error))?;
    Ok(())
}

fn write_json<T: Serialize>(path: &Path, value: &T, label: &str) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| format!("无法序列化{label}：{error}"))?;
    write_atomic(path, &bytes, label)
}

fn load_manifest(root: &Path) -> Result<Option<BackgroundManifest>, String> {
    let path = manifest_path(root);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|error| format!("无法读取背景配置：{error}"))?;
    let manifest: BackgroundManifest =
        serde_json::from_slice(&bytes).map_err(|error| format!("背景配置已损坏：{error}"))?;
    manifest.settings.validate()?;
    Ok(Some(manifest))
}

fn load_runtime(root: &Path) -> BackgroundRuntime {
    fs::read(runtime_path(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_runtime(root: &Path, runtime: &BackgroundRuntime) -> Result<(), String> {
    write_json(&runtime_path(root), runtime, "背景运行状态")
}

fn wallpaper_path(root: &Path, manifest: &BackgroundManifest) -> Result<PathBuf, String> {
    let expected = match manifest.mime.as_str() {
        "image/png" => "wallpaper.png",
        "image/jpeg" => "wallpaper.jpg",
        "image/webp" => "wallpaper.webp",
        _ => return Err("背景配置中的图片类型不受支持".to_string()),
    };
    if manifest.file_name != expected {
        return Err("背景配置中的图片路径无效".to_string());
    }
    Ok(background_dir(root).join(expected))
}

fn parse_image_data_url(
    data_url: &str,
) -> Result<(&'static str, ImageFormat, &'static str, Vec<u8>), String> {
    let formats = [
        (
            "data:image/png;base64,",
            "image/png",
            ImageFormat::Png,
            "png",
        ),
        (
            "data:image/jpeg;base64,",
            "image/jpeg",
            ImageFormat::Jpeg,
            "jpg",
        ),
        (
            "data:image/webp;base64,",
            "image/webp",
            ImageFormat::WebP,
            "webp",
        ),
    ];
    let (encoded, mime, format, extension) = formats
        .iter()
        .find_map(|(prefix, mime, format, extension)| {
            data_url
                .strip_prefix(prefix)
                .map(|encoded| (encoded, *mime, *format, *extension))
        })
        .ok_or_else(|| "只支持 PNG、JPEG 或 WebP 图片".to_string())?;

    if encoded.len() > (MAX_IMAGE_BYTES * 4 / 3) + 8 {
        return Err("背景图片不能超过 8 MiB".to_string());
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "背景图片不是有效的 Base64 数据".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("背景图片必须大于 0 且不能超过 8 MiB".to_string());
    }
    let detected = image::guess_format(&bytes).map_err(|_| "无法识别背景图片格式".to_string())?;
    if detected != format {
        return Err("图片真实格式与声明类型不一致".to_string());
    }
    Ok((mime, format, extension, bytes))
}

fn safe_original_name(file_name: &str) -> String {
    Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(|name| {
            name.chars()
                .filter(|character| !character.is_control())
                .take(160)
                .collect()
        })
        .filter(|name: &String| !name.is_empty())
        .unwrap_or_else(|| "background-image".to_string())
}

fn remove_wallpaper_variants(root: &Path, keep: Option<&str>) -> Result<(), String> {
    for extension in ["png", "jpg", "webp"] {
        let name = format!("{WALLPAPER_STEM}.{extension}");
        if keep == Some(name.as_str()) {
            continue;
        }
        let path = background_dir(root).join(name);
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("无法移除旧背景 {}：{error}", path.display()))?;
        }
    }
    Ok(())
}

pub(crate) fn save_image(
    root: &Path,
    file_name: &str,
    data_url: &str,
) -> Result<BackgroundState, String> {
    let (mime, format, extension, bytes) = parse_image_data_url(data_url)?;
    let reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "图片文件已损坏或无法读取".to_string())?;
    if width == 0
        || height == 0
        || width > MAX_IMAGE_SIDE
        || height > MAX_IMAGE_SIDE
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return Err("图片尺寸必须小于 8192×8192 且不超过 4000 万像素".to_string());
    }

    let stored_name = format!("{WALLPAPER_STEM}.{extension}");
    let image_path = background_dir(root).join(&stored_name);
    write_atomic(&image_path, &bytes, "背景图片")?;
    remove_wallpaper_variants(root, Some(&stored_name))?;

    let previous = load_manifest(root)?;
    let manifest = BackgroundManifest {
        settings: previous.map(|item| item.settings).unwrap_or_default(),
        original_name: safe_original_name(file_name),
        file_name: stored_name,
        mime: mime.to_string(),
        width,
        height,
    };
    write_json(&manifest_path(root), &manifest, "背景配置")?;
    get_state(root)
}

pub(crate) fn update_settings(
    root: &Path,
    settings: WallpaperSettings,
) -> Result<BackgroundState, String> {
    settings.validate()?;
    let mut manifest = load_manifest(root)?.ok_or_else(|| "请先选择一张背景图片".to_string())?;
    manifest.settings = settings;
    write_json(&manifest_path(root), &manifest, "背景配置")?;
    get_state(root)
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

fn run_powershell(script: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout)
            .trim()
            .trim_start_matches('\u{feff}')
            .to_string();
        (!text.is_empty()).then_some(text)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = script;
        None
    }
}

fn discover_chatgpt_executable(runtime: &BackgroundRuntime) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let running = run_powershell(
            "$process = Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | Select-Object -First 1; if ($process.ExecutablePath) { $process.ExecutablePath }",
        )
        .map(PathBuf::from)
        .filter(|path| path.is_file());
        if let Some(path) = running {
            return Ok(path);
        }
        if let Some(path) = runtime
            .executable
            .as_ref()
            .map(PathBuf::from)
            .filter(|path| path.is_file())
        {
            return Ok(path);
        }
        let packaged = run_powershell(
            "$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($package.InstallLocation) { Join-Path $package.InstallLocation 'app\\ChatGPT.exe' }",
        )
        .map(PathBuf::from)
        .filter(|path| path.is_file());
        packaged.ok_or_else(|| {
            "未找到 ChatGPT 桌面应用，请先从 Microsoft Store 安装或打开一次".to_string()
        })
    }
    #[cfg(target_os = "macos")]
    {
        let _ = runtime;
        let path = PathBuf::from("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT");
        path.is_file()
            .then_some(path)
            .ok_or_else(|| "未找到 ChatGPT.app".to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = runtime;
        Err("当前版本的图片背景增强仅支持 Windows 和 macOS".to_string())
    }
}

fn stop_chatgpt() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let status = Command::new("taskkill")
        .args(["/IM", "ChatGPT.exe", "/T", "/F"])
        .status();
    #[cfg(not(target_os = "windows"))]
    let status = Command::new("pkill").args(["-f", "ChatGPT"]).status();
    let status = status.map_err(|error| format!("无法结束 ChatGPT：{error}"))?;
    if !status.success() && is_chatgpt_running() {
        return Err("ChatGPT 未能退出，请保存工作后手动完全退出再重试".to_string());
    }
    Ok(())
}

fn launch_with_debug(executable: &Path, port: u16) -> Result<(), String> {
    Command::new(executable)
        .args([
            "--remote-debugging-address=127.0.0.1",
            &format!("--remote-debugging-port={port}"),
        ])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法用背景增强模式启动 ChatGPT：{error}"))
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| format!("无法创建本机连接：{error}"))
}

fn valid_loopback_ws(value: &str, expected_port: u16) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() != "ws" || url.port_or_known_default() != Some(expected_port) {
        return false;
    }
    url.host_str() == Some("127.0.0.1")
}

fn list_targets(port: u16) -> Result<Vec<CdpTarget>, String> {
    let endpoint = format!("http://127.0.0.1:{port}/json/list");
    let targets = http_client()?
        .get(endpoint)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("无法连接 ChatGPT 的本机调试端点：{error}"))?
        .json::<Vec<CdpTarget>>()
        .map_err(|error| format!("本机调试端点返回了无效数据：{error}"))?;
    Ok(targets
        .into_iter()
        .filter(|target| {
            if target.target_type != "page"
                || !valid_loopback_ws(&target.web_socket_debugger_url, port)
            {
                return false;
            }
            let title = target.title.to_ascii_lowercase();
            target.url.starts_with("app://") || title.contains("chatgpt") || title.contains("codex")
        })
        .collect())
}

fn endpoint_ready(port: u16) -> bool {
    list_targets(port).is_ok()
}

fn choose_port(runtime: &BackgroundRuntime) -> Result<u16, String> {
    if let Some(port) = runtime.port {
        if endpoint_ready(port) || TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    (FIRST_DEBUG_PORT..=LAST_DEBUG_PORT)
        .find(|port| TcpListener::bind(("127.0.0.1", *port)).is_ok())
        .ok_or_else(|| "9341–9360 端口均被占用，无法启动本机背景增强".to_string())
}

fn wait_for_targets(port: u16) -> Result<Vec<CdpTarget>, String> {
    let mut last_error = String::new();
    for _ in 0..30 {
        match list_targets(port) {
            Ok(targets) if !targets.is_empty() => return Ok(targets),
            Ok(_) => last_error = "尚未发现 ChatGPT 页面".to_string(),
            Err(error) => last_error = error,
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err(format!("ChatGPT 已启动，但背景连接未就绪：{last_error}"))
}

fn cdp_call(websocket_url: &str, port: u16, method: &str, params: Value) -> Result<Value, String> {
    if !valid_loopback_ws(websocket_url, port) {
        return Err("拒绝连接非本机调试地址".to_string());
    }
    let url = Url::parse(websocket_url).map_err(|error| format!("调试地址无效：{error}"))?;
    let (mut socket, _) = connect(url).map_err(|error| format!("无法连接页面：{error}"))?;
    let request_id = 1_u64;
    socket
        .send(Message::Text(
            json!({ "id": request_id, "method": method, "params": params }).to_string(),
        ))
        .map_err(|error| format!("无法发送页面设置：{error}"))?;
    loop {
        let message = socket
            .read()
            .map_err(|error| format!("无法读取页面响应：{error}"))?;
        let Message::Text(text) = message else {
            continue;
        };
        let response: Value = serde_json::from_str(&text)
            .map_err(|error| format!("页面响应不是有效 JSON：{error}"))?;
        if response.get("id").and_then(Value::as_u64) != Some(request_id) {
            continue;
        }
        if let Some(error) = response.get("error") {
            return Err(format!("页面拒绝了设置：{error}"));
        }
        return Ok(response.get("result").cloned().unwrap_or(Value::Null));
    }
}

fn hex_rgb(value: &str) -> Result<(u8, u8, u8), String> {
    if value.len() != 7
        || !value.starts_with('#')
        || !value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    {
        return Err("主题颜色必须是 #RRGGBB".to_string());
    }
    let parse =
        |range| u8::from_str_radix(&value[range], 16).map_err(|_| "主题颜色无效".to_string());
    Ok((parse(1..3)?, parse(3..5)?, parse(5..7)?))
}

fn build_injection_script(
    data_url: &str,
    settings: &WallpaperSettings,
    surface: &str,
    ink: &str,
    accent: &str,
) -> Result<String, String> {
    settings.validate()?;
    let (surface_r, surface_g, surface_b) = hex_rgb(surface)?;
    let _ = hex_rgb(ink)?;
    let _ = hex_rgb(accent)?;
    if !data_url.starts_with("data:image/") || data_url.len() > 12_000_000 {
        return Err("背景图片数据无效".to_string());
    }
    let image =
        serde_json::to_string(data_url).map_err(|error| format!("无法编码背景图片：{error}"))?;
    let background_size = if settings.fit == "contain" {
        "contain".to_string()
    } else {
        format!("{}%", settings.zoom)
    };
    let panel_alpha = f32::from(settings.panel_opacity) / 100.0;
    let sidebar_alpha = if settings.scope == "all" {
        panel_alpha
    } else {
        0.97
    };
    let enabled = settings.enabled;

    Ok(format!(
        r#"(() => {{
  const STYLE_ID = '{STYLE_ID}';
  const LAYER_ID = '{LAYER_ID}';
  const previous = window.__CODEXSKIN_WALLPAPER__;
  if (previous && typeof previous.cleanup === 'function') previous.cleanup();
  const cleanup = () => {{
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(LAYER_ID)?.remove();
    document.documentElement.classList.remove('codexskin-wallpaper-active');
  }};
  const mount = () => {{
    if (!document.head || !document.body) return false;
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(LAYER_ID)?.remove();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html.codexskin-wallpaper-active, html.codexskin-wallpaper-active body {{ background: rgb({surface_r} {surface_g} {surface_b}) !important; }}
      html.codexskin-wallpaper-active body > *:not(#{LAYER_ID}) {{ position: relative; z-index: 1; }}
      html.codexskin-wallpaper-active body > div:not(#{LAYER_ID}), html.codexskin-wallpaper-active #root {{ background-color: transparent !important; }}
      html.codexskin-wallpaper-active main {{ background-color: rgba({surface_r}, {surface_g}, {surface_b}, {panel_alpha:.2}) !important; backdrop-filter: blur(1px); }}
      html.codexskin-wallpaper-active aside, html.codexskin-wallpaper-active nav {{ background-color: rgba({surface_r}, {surface_g}, {surface_b}, {sidebar_alpha:.2}) !important; backdrop-filter: blur(18px) saturate(120%); }}
      html.codexskin-wallpaper-active [role='dialog'], html.codexskin-wallpaper-active [role='menu'], html.codexskin-wallpaper-active [data-radix-popper-content-wrapper] > * {{ background-color: rgba({surface_r}, {surface_g}, {surface_b}, .96) !important; }}
      html.codexskin-wallpaper-active ::selection {{ background: {accent}55; color: {ink}; }}
    `;
    const layer = document.createElement('div');
    layer.id = LAYER_ID;
    layer.setAttribute('aria-hidden', 'true');
    Object.assign(layer.style, {{
      position: 'fixed', inset: '-{blur}px', zIndex: '0', pointerEvents: 'none',
      opacity: '{opacity}', filter: 'blur({blur}px)', transform: 'scale({scale})',
      transformOrigin: '{position_x}% {position_y}%',
      backgroundImage: `linear-gradient(rgba(0,0,0,{darkness}),rgba(0,0,0,{darkness})),url(${{{image}}})`,
      backgroundSize: '{background_size}', backgroundRepeat: 'no-repeat',
      backgroundPosition: '{position_x}% {position_y}%', backgroundColor: '{surface}'
    }});
    document.head.appendChild(style);
    document.body.prepend(layer);
    document.documentElement.classList.toggle('codexskin-wallpaper-active', {enabled});
    layer.hidden = !{enabled};
    return true;
  }};
  const observer = new MutationObserver(() => {{ if (!document.getElementById(LAYER_ID)) mount(); }});
  if (!mount()) document.addEventListener('DOMContentLoaded', mount, {{ once: true }});
  observer.observe(document.documentElement, {{ childList: true, subtree: true }});
  window.__CODEXSKIN_WALLPAPER__ = {{ cleanup: () => {{ observer.disconnect(); cleanup(); delete window.__CODEXSKIN_WALLPAPER__; }}, mount }};
  return {{ ok: true, mounted: Boolean(document.getElementById(LAYER_ID)) }};
}})()"#,
        opacity = f32::from(settings.opacity) / 100.0,
        darkness = f32::from(settings.darkness) / 100.0,
        blur = settings.blur,
        scale = f32::from(settings.zoom) / 100.0,
        position_x = settings.position_x,
        position_y = settings.position_y,
    ))
}

const CLEANUP_EXPRESSION: &str = r#"(() => {
  const current = window.__CODEXSKIN_WALLPAPER__;
  if (current && typeof current.cleanup === 'function') current.cleanup();
  document.getElementById('codexskin-wallpaper-style')?.remove();
  document.getElementById('codexskin-wallpaper-layer')?.remove();
  document.documentElement.classList.remove('codexskin-wallpaper-active');
  return true;
})()"#;

fn remove_from_target(port: u16, target: &CdpTarget, script_id: Option<&str>) {
    if let Some(identifier) = script_id {
        let _ = cdp_call(
            &target.web_socket_debugger_url,
            port,
            "Page.removeScriptToEvaluateOnNewDocument",
            json!({ "identifier": identifier }),
        );
    }
    let _ = cdp_call(
        &target.web_socket_debugger_url,
        port,
        "Runtime.evaluate",
        json!({ "expression": CLEANUP_EXPRESSION, "returnByValue": true }),
    );
}

pub(crate) fn restore_session(root: &Path) -> Result<BackgroundState, String> {
    let mut runtime = load_runtime(root);
    if let Some(port) = runtime.port {
        if let Ok(targets) = list_targets(port) {
            for target in &targets {
                let script_id = runtime
                    .registrations
                    .iter()
                    .find(|registration| registration.target_id == target.id)
                    .map(|registration| registration.script_id.as_str());
                remove_from_target(port, target, script_id);
            }
        }
    }
    runtime.active = false;
    runtime.registrations.clear();
    save_runtime(root, &runtime)?;
    get_state(root)
}

pub(crate) fn apply(
    root: &Path,
    restart: bool,
    surface: &str,
    ink: &str,
    accent: &str,
) -> Result<BackgroundApplyResult, String> {
    let manifest = load_manifest(root)?.ok_or_else(|| "请先选择一张背景图片".to_string())?;
    let image_path = wallpaper_path(root, &manifest)?;
    let image_bytes =
        fs::read(&image_path).map_err(|error| format!("无法读取背景图片：{error}"))?;
    if image_bytes.len() > MAX_IMAGE_BYTES {
        return Err("保存的背景图片超过安全上限".to_string());
    }
    let data_url = format!(
        "data:{};base64,{}",
        manifest.mime,
        BASE64.encode(image_bytes)
    );
    let script = build_injection_script(&data_url, &manifest.settings, surface, ink, accent)?;
    let mut runtime = load_runtime(root);
    let port = choose_port(&runtime)?;
    let running = is_chatgpt_running();
    let ready = endpoint_ready(port);
    let mut restarted = false;

    if !ready {
        if running && !restart {
            return Err("RESTART_REQUIRED:ChatGPT 正在运行。图片背景需要以本机增强模式重开一次；这会关闭当前窗口，请先保存未完成内容。".to_string());
        }
        let executable = discover_chatgpt_executable(&runtime)?;
        if running {
            stop_chatgpt()?;
            thread::sleep(Duration::from_millis(1_200));
            restarted = true;
        }
        launch_with_debug(&executable, port)?;
        runtime.executable = Some(executable.to_string_lossy().into_owned());
    }

    if runtime.active {
        let _ = restore_session(root);
        runtime = load_runtime(root);
    }
    let targets = wait_for_targets(port)?;
    let mut registrations: Vec<RuntimeRegistration> = Vec::new();
    for target in &targets {
        let result = cdp_call(
            &target.web_socket_debugger_url,
            port,
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": script }),
        )?;
        let script_id = result
            .get("identifier")
            .and_then(Value::as_str)
            .ok_or_else(|| "页面没有返回背景注册编号".to_string())?
            .to_string();
        if let Err(error) = cdp_call(
            &target.web_socket_debugger_url,
            port,
            "Runtime.evaluate",
            json!({ "expression": script, "returnByValue": true, "awaitPromise": true }),
        ) {
            remove_from_target(port, target, Some(&script_id));
            for registered in &registrations {
                if let Some(previous) = targets.iter().find(|item| item.id == registered.target_id)
                {
                    remove_from_target(port, previous, Some(&registered.script_id));
                }
            }
            return Err(error);
        }
        let health = cdp_call(
            &target.web_socket_debugger_url,
            port,
            "Runtime.evaluate",
            json!({
                "expression": "Boolean(window.__CODEXSKIN_WALLPAPER__ && document.getElementById('codexskin-wallpaper-layer'))",
                "returnByValue": true
            }),
        )?;
        let healthy = health
            .pointer("/result/value")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !healthy {
            remove_from_target(port, target, Some(&script_id));
            return Err("背景注入后健康检查未通过，已自动回退".to_string());
        }
        registrations.push(RuntimeRegistration {
            target_id: target.id.clone(),
            script_id,
        });
    }

    runtime.active = true;
    runtime.port = Some(port);
    runtime.registrations = registrations;
    save_runtime(root, &runtime)?;
    Ok(BackgroundApplyResult {
        active: true,
        port,
        targets: targets.len(),
        restarted,
        session_only: true,
    })
}

pub(crate) fn clear(root: &Path) -> Result<BackgroundState, String> {
    let _ = restore_session(root);
    remove_wallpaper_variants(root, None)?;
    for path in [manifest_path(root), runtime_path(root)] {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("无法清除 {}：{error}", path.display()))?;
        }
    }
    get_state(root)
}

pub(crate) fn get_state(root: &Path) -> Result<BackgroundState, String> {
    let manifest = load_manifest(root)?;
    let runtime = load_runtime(root);
    let port = runtime.port;
    let ready = port.map(endpoint_ready).unwrap_or(false);
    let running = is_chatgpt_running();
    let (settings, file_name, mime, width, height, image_data_url, configured) = match manifest {
        Some(manifest) => {
            let path = wallpaper_path(root, &manifest)?;
            let bytes = fs::read(&path).map_err(|error| format!("无法读取背景图片：{error}"))?;
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err("保存的背景图片超过安全上限".to_string());
            }
            let data_url = format!("data:{};base64,{}", manifest.mime, BASE64.encode(bytes));
            (
                manifest.settings,
                Some(manifest.original_name),
                Some(manifest.mime),
                Some(manifest.width),
                Some(manifest.height),
                Some(data_url),
                true,
            )
        }
        None => (
            WallpaperSettings::default(),
            None,
            None,
            None,
            None,
            None,
            false,
        ),
    };
    Ok(BackgroundState {
        settings,
        configured,
        active: runtime.active && ready,
        endpoint_ready: ready,
        app_running: running,
        needs_restart: configured && running && !ready,
        port,
        file_name,
        mime,
        width,
        height,
        image_data_url,
        experimental: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE_PIXEL_PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    #[test]
    fn validates_wallpaper_setting_ranges() {
        assert!(WallpaperSettings::default().validate().is_ok());
        let invalid = WallpaperSettings {
            zoom: 99,
            ..WallpaperSettings::default()
        };
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn rejects_mime_mismatch_and_unsupported_data() {
        let mismatch = ONE_PIXEL_PNG.replacen("image/png", "image/jpeg", 1);
        assert!(parse_image_data_url(&mismatch).is_err());
        assert!(parse_image_data_url("data:image/svg+xml;base64,PHN2Zy8+").is_err());
    }

    #[test]
    fn accepts_only_loopback_websocket_on_expected_port() {
        assert!(valid_loopback_ws(
            "ws://127.0.0.1:9341/devtools/page/1",
            9341
        ));
        assert!(!valid_loopback_ws(
            "ws://localhost:9341/devtools/page/1",
            9341
        ));
        assert!(!valid_loopback_ws(
            "ws://example.com:9341/devtools/page/1",
            9341
        ));
        assert!(!valid_loopback_ws(
            "ws://127.0.0.1:9999/devtools/page/1",
            9341
        ));
    }

    #[test]
    fn script_contains_fixed_owned_nodes_and_sanitized_values() {
        let script = build_injection_script(
            ONE_PIXEL_PNG,
            &WallpaperSettings::default(),
            "#101820",
            "#F7F7F7",
            "#5B7CFA",
        )
        .unwrap();
        assert!(script.contains(STYLE_ID));
        assert!(script.contains(LAYER_ID));
        assert!(script.contains("data:image/png;base64"));
        assert!(script.contains("rgba(16, 24, 32"));
        assert!(!script.contains("example.com"));
    }

    #[test]
    fn saves_and_reads_valid_image_in_app_owned_directory() {
        let temp = tempfile::tempdir().unwrap();
        let state = save_image(temp.path(), "../我的背景.png", ONE_PIXEL_PNG).unwrap();
        assert!(state.configured);
        assert_eq!(state.width, Some(1));
        assert_eq!(state.height, Some(1));
        assert_eq!(state.file_name.as_deref(), Some("我的背景.png"));
        assert!(background_dir(temp.path()).join("wallpaper.png").is_file());
    }

    #[test]
    fn optional_cdp_smoke_test() {
        let Ok(raw_port) = std::env::var("CODEXSKIN_CDP_SMOKE_PORT") else {
            return;
        };
        let port: u16 = raw_port.parse().expect("valid smoke port");
        let targets = wait_for_targets(port).expect("smoke target");
        let target = targets.first().expect("at least one target");
        let script = build_injection_script(
            ONE_PIXEL_PNG,
            &WallpaperSettings::default(),
            "#101820",
            "#F7F7F7",
            "#5B7CFA",
        )
        .unwrap();
        cdp_call(
            &target.web_socket_debugger_url,
            port,
            "Runtime.evaluate",
            json!({ "expression": script, "returnByValue": true }),
        )
        .expect("inject wallpaper");
        let health = cdp_call(
            &target.web_socket_debugger_url,
            port,
            "Runtime.evaluate",
            json!({
                "expression": "Boolean(document.getElementById('codexskin-wallpaper-layer'))",
                "returnByValue": true
            }),
        )
        .expect("health check");
        assert_eq!(
            health.pointer("/result/value").and_then(Value::as_bool),
            Some(true)
        );
        cdp_call(
            &target.web_socket_debugger_url,
            port,
            "Runtime.evaluate",
            json!({ "expression": CLEANUP_EXPRESSION, "returnByValue": true }),
        )
        .expect("cleanup wallpaper");

        if let Ok(screenshot_path) = std::env::var("CODEXSKIN_CDP_SMOKE_SCREENSHOT") {
            cdp_call(
                &target.web_socket_debugger_url,
                port,
                "Runtime.evaluate",
                json!({
                    "expression": "[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('图片背景'))?.click()",
                    "returnByValue": true
                }),
            )
            .expect("open background page");
            thread::sleep(Duration::from_millis(250));
            if let Ok(image_path) = std::env::var("CODEXSKIN_CDP_SMOKE_IMAGE") {
                let image_bytes = fs::read(image_path).expect("read smoke image");
                let encoded_image = BASE64.encode(image_bytes);
                let choose_file = format!(
                    r#"(() => {{
  const input = document.querySelector('input[type=file]');
  if (!input) return false;
  const binary = atob('{encoded_image}');
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], 'smoke-background.png', {{ type: 'image/png' }}));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', {{ bubbles: true }}));
  return true;
}})()"#
                );
                cdp_call(
                    &target.web_socket_debugger_url,
                    port,
                    "Runtime.evaluate",
                    json!({ "expression": choose_file, "returnByValue": true }),
                )
                .expect("choose smoke background image");
                thread::sleep(Duration::from_millis(500));
                cdp_call(
                    &target.web_socket_debugger_url,
                    port,
                    "Runtime.evaluate",
                    json!({
                        "expression": "[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('应用图片与主题色'))?.click()",
                        "returnByValue": true
                    }),
                )
                .expect("apply smoke background");
                thread::sleep(Duration::from_millis(1_600));
                let ui_health = cdp_call(
                    &target.web_socket_debugger_url,
                    port,
                    "Runtime.evaluate",
                    json!({
                        "expression": "document.body.textContent?.includes('正在生效') === true",
                        "returnByValue": true
                    }),
                )
                .expect("check background UI state");
                assert_eq!(
                    ui_health.pointer("/result/value").and_then(Value::as_bool),
                    Some(true)
                );
            }
            thread::sleep(Duration::from_millis(250));
            let capture = cdp_call(
                &target.web_socket_debugger_url,
                port,
                "Page.captureScreenshot",
                json!({ "format": "png", "fromSurface": true }),
            )
            .expect("capture background page");
            let encoded = capture
                .get("data")
                .and_then(Value::as_str)
                .expect("screenshot data");
            let bytes = BASE64.decode(encoded).expect("decode screenshot");
            fs::write(screenshot_path, bytes).expect("write smoke screenshot");
        }
    }
}
