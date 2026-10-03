use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{io::Reader as ImageReader, ImageFormat};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use tungstenite::{client, Message};
use url::Url;

const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_SIDE: u32 = 8_192;
const MAX_IMAGE_PIXELS: u64 = 40_000_000;
const FIRST_DEBUG_PORT: u16 = 9_341;
const LAST_DEBUG_PORT: u16 = 9_360;
const MANIFEST_FILE: &str = "manifest.json";
const RUNTIME_FILE: &str = "runtime.json";
const WALLPAPER_STEM: &str = "wallpaper";

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
        if !(10..=100).contains(&self.opacity)
            || self.darkness > 85
            || self.blur > 24
            || !(100..=160).contains(&self.zoom)
            || self.position_x > 100
            || self.position_y > 100
            || !(35..=100).contains(&self.panel_opacity)
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
    #[serde(default)]
    revision: String,
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
    has_session: bool,
    warning: Option<String>,
    saved_settings: WallpaperSettings,
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
    load_runtime_checked(root).unwrap_or_default()
}

fn load_runtime_checked(root: &Path) -> Result<BackgroundRuntime, String> {
    let path = runtime_path(root);
    if !path.exists() {
        return Ok(BackgroundRuntime::default());
    }
    let bytes = fs::read(path).map_err(|e| format!("无法读取背景恢复信息：{e}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "背景恢复信息损坏，请完全退出客户端后清除".to_string())
}

fn save_runtime(root: &Path, runtime: &BackgroundRuntime) -> Result<(), String> {
    write_json(&runtime_path(root), runtime, "背景运行状态")
}

fn wallpaper_path(root: &Path, manifest: &BackgroundManifest) -> Result<PathBuf, String> {
    let extension = match manifest.mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return Err("背景配置中的图片类型不受支持".to_string()),
    };
    let legacy = format!("wallpaper.{extension}");
    let hashed = manifest
        .file_name
        .strip_prefix("wallpaper-")
        .and_then(|name| name.strip_suffix(&format!(".{extension}")))
        .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()));
    if manifest.file_name != legacy && !hashed {
        return Err("背景配置中的图片路径无效".to_string());
    }
    Ok(background_dir(root).join(&manifest.file_name))
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
    if !background_dir(root).exists() {
        return Ok(());
    }
    for entry in fs::read_dir(background_dir(root)).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let owned = ["png", "jpg", "webp"].iter().any(|ext| {
            name == format!("wallpaper.{ext}")
                || name
                    .strip_prefix("wallpaper-")
                    .and_then(|s| s.strip_suffix(&format!(".{ext}")))
                    .is_some_and(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        });
        if !owned {
            continue;
        }
        if keep == Some(name.as_str()) {
            continue;
        }
        let path = entry.path();
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
    // Dimensions alone do not validate compressed pixel data (truncated PNGs
    // used to pass). Decode under an explicit allocation budget before saving.
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::io::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "图片像素数据损坏或解码超出安全上限".to_string())?;

    let stored_name = format!("{WALLPAPER_STEM}-{:x}.{extension}", Sha256::digest(&bytes));
    let image_path = background_dir(root).join(&stored_name);
    write_atomic(&image_path, &bytes, "背景图片")?;
    let previous = load_manifest(root).ok().flatten();
    let manifest = BackgroundManifest {
        settings: previous.map(|item| item.settings).unwrap_or_default(),
        original_name: safe_original_name(file_name),
        file_name: stored_name,
        mime: mime.to_string(),
        width,
        height,
    };
    write_json(&manifest_path(root), &manifest, "背景配置")?;
    // Commit the manifest first. A failed save can never overwrite the old
    // image; orphaned immutable files can be removed on the next successful save.
    let _ = remove_wallpaper_variants(root, Some(&manifest.file_name));
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
        crate::hidden_command("tasklist")
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
        let output = crate::hidden_command("powershell.exe")
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
    let _ = runtime;
    #[cfg(target_os = "windows")]
    {
        // Never execute an arbitrary cached runtime.json path.
        run_powershell("$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($package.InstallLocation) { Join-Path $package.InstallLocation 'app\\ChatGPT.exe' }")
            .map(PathBuf::from).filter(|path| path.is_file())
            .ok_or_else(|| "未找到兼容的 OpenAI.Codex 桌面包。此实验功能不支持普通浏览器和其他同名应用。".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("当前图片背景增强仅在 Windows 的兼容桌面包上启用".to_string())
    }
}

pub(crate) fn stop_chatgpt() -> Result<(), String> {
    let executable = discover_chatgpt_executable(&BackgroundRuntime::default())?;
    #[cfg(target_os = "windows")]
    {
        let escaped = executable.to_string_lossy().replace('\'', "''");
        let script = format!("$target = '{escaped}'; Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -eq $target -and $_.MainWindowHandle -ne 0 }} | ForEach-Object {{ [void]$_.CloseMainWindow() }}; 'requested'");
        run_powershell(&script)
            .ok_or_else(|| "无法请求客户端正常退出，请手动完全退出后重试".to_string())?;
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            let check = format!("$target = '{escaped}'; @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -eq $target }}).Count");
            if run_powershell(&check).as_deref() == Some("0") {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(250));
        }
        Err(
            "客户端尚未正常退出（可能有任务或托盘进程），不会强制结束；请手动完全退出后重试"
                .to_string(),
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = executable;
        Err("请手动退出客户端后重试".to_string())
    }
}

fn verify_endpoint_owner(port: u16) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let executable = discover_chatgpt_executable(&BackgroundRuntime::default())?;
        let escaped = executable.to_string_lossy().replace('\'', "''");
        let script = format!("$ErrorActionPreference='Stop'; $listeners = @(Get-NetTCPConnection -LocalPort {port} -State Listen); if ($listeners.Count -eq 0) {{ exit 1 }}; foreach ($listener in $listeners) {{ if ($listener.LocalAddress -ne '127.0.0.1') {{ exit 1 }}; $p = Get-Process -Id $listener.OwningProcess; if ($p.Path -ne '{escaped}') {{ exit 1 }} }}; 'verified'");
        if run_powershell(&script).as_deref() != Some("verified") {
            return Err(
                "端口不属于兼容客户端，或监听地址并非仅本机；已拒绝注入。请关闭增强会话后重试"
                    .to_string(),
            );
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = port;
        Err("此平台尚未验证背景增强".to_string())
    }
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
        .redirect(reqwest::redirect::Policy::none())
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
        && url.username().is_empty()
        && url.password().is_none()
        && url.path().starts_with("/devtools/page/")
}

fn list_targets(port: u16) -> Result<Vec<CdpTarget>, String> {
    let endpoint = format!("http://127.0.0.1:{port}/json/list");
    let response = http_client()?
        .get(endpoint)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("无法连接 ChatGPT 的本机调试端点：{error}"))?;
    if !response.status().is_success() {
        return Err("本机调试端点拒绝连接（不跟随重定向）".to_string());
    }
    let mut bytes = Vec::new();
    response
        .take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 1_048_576 {
        return Err("本机调试端点数据过大".to_string());
    }
    let targets: Vec<CdpTarget> =
        serde_json::from_slice(&bytes).map_err(|error| format!("本机端点数据无效：{error}"))?;
    if targets.len() > 32 {
        return Err("页面数量超过安全上限".to_string());
    }
    Ok(targets
        .into_iter()
        .filter(|target| {
            if target.target_type != "page"
                || !valid_loopback_ws(&target.web_socket_debugger_url, port)
            {
                return false;
            }
            target.url.starts_with("app://")
        })
        .collect())
}

fn endpoint_ready(port: u16) -> bool {
    list_targets(port).is_ok_and(|targets| !targets.is_empty())
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
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
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
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(1))
        .map_err(|error| format!("无法连接页面：{error}"))?;
    let timeout = Duration::from_secs(4);
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    let (mut socket, _) = client(url, stream).map_err(|error| format!("页面握手失败：{error}"))?;
    let deadline = Instant::now() + timeout;
    let request_id = 1_u64;
    socket
        .send(Message::Text(
            json!({ "id": request_id, "method": method, "params": params }).to_string(),
        ))
        .map_err(|error| format!("无法发送页面设置：{error}"))?;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| "页面响应超时，请刷新状态后重试".to_string())?;
        socket
            .get_mut()
            .set_read_timeout(Some(remaining))
            .map_err(|e| e.to_string())?;
        let message = socket
            .read()
            .map_err(|error| format!("无法读取页面响应：{error}"))?;
        if message.is_close() {
            return Err("页面连接已关闭，请重试".to_string());
        }
        let Message::Text(text) = message else {
            continue;
        };
        if text.len() > 1_048_576 {
            return Err("页面响应超过安全上限".to_string());
        }
        let response: Value = serde_json::from_str(&text)
            .map_err(|error| format!("页面响应不是有效 JSON：{error}"))?;
        if response.get("id").and_then(Value::as_u64) != Some(request_id) {
            continue;
        }
        if let Some(error) = response.get("error") {
            return Err(format!("页面拒绝了设置：{error}"));
        }
        if let Some(exception) = response.pointer("/result/exceptionDetails") {
            let description = exception
                .pointer("/exception/description")
                .and_then(Value::as_str)
                .unwrap_or("脚本执行失败");
            return Err(format!(
                "页面未接受背景：{}",
                description.chars().take(300).collect::<String>()
            ));
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

fn manifest_revision(manifest: &BackgroundManifest) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(manifest).unwrap_or_default())
    )
}

fn build_injection_script(
    data_url: &str,
    settings: &WallpaperSettings,
    surface: &str,
    ink: &str,
    accent: &str,
    revision: &str,
) -> Result<String, String> {
    settings.validate()?;
    hex_rgb(surface)?;
    hex_rgb(ink)?;
    hex_rgb(accent)?;
    parse_image_data_url(data_url)?;
    let options = json!({
        "image": data_url, "settings": settings, "surface": surface,
        "ink": ink, "accent": accent, "revision": revision
    });
    Ok(include_str!("wallpaper.js").replacen("__CODEXSKIN_OPTIONS__", &options.to_string(), 1))
}

const CLEANUP_EXPRESSION: &str = r#"(() => {
  const current = window.__CODEXSKIN_WALLPAPER__;
  if (current && typeof current.cleanup === 'function') current.cleanup();
  document.getElementById('codexskin-wallpaper-style')?.remove();
  document.getElementById('codexskin-wallpaper-layer')?.remove();
  document.documentElement.classList.remove('codexskin-wallpaper-active');
  return true;
})()"#;

const HEALTH_EXPRESSION: &str =
    "window.__CODEXSKIN_WALLPAPER__?.check?.() ?? {active:false,revision:''}";

fn target_health(port: u16, target: &CdpTarget, revision: &str) -> Result<bool, String> {
    let health = cdp_call(
        &target.web_socket_debugger_url,
        port,
        "Runtime.evaluate",
        json!({ "expression": HEALTH_EXPRESSION, "returnByValue": true }),
    )?;
    Ok(health
        .pointer("/result/value/active")
        .and_then(Value::as_bool)
        == Some(true)
        && health
            .pointer("/result/value/revision")
            .and_then(Value::as_str)
            == Some(revision))
}

fn remove_from_target(port: u16, target: &CdpTarget) -> Result<(), String> {
    let result = cdp_call(
        &target.web_socket_debugger_url,
        port,
        "Runtime.evaluate",
        json!({ "expression": CLEANUP_EXPRESSION, "returnByValue": true }),
    )?;
    if result.pointer("/result/value").and_then(Value::as_bool) != Some(true) {
        return Err("页面没有确认移除背景".to_string());
    }
    Ok(())
}

fn cleanup_targets(
    root: &Path,
    runtime: &mut BackgroundRuntime,
    targets: &[CdpTarget],
) -> Result<(), String> {
    let mut failed = Vec::new();
    let port = runtime
        .port
        .ok_or_else(|| "恢复信息缺少本机端口".to_string())?;
    for registration in &runtime.registrations {
        // A closed target is already clean. An existing target must acknowledge
        // cleanup before its recovery journal can be discarded.
        if let Some(target) = targets
            .iter()
            .find(|target| target.id == registration.target_id)
        {
            if let Err(error) = remove_from_target(port, target) {
                failed.push((registration.clone(), error));
            }
        }
    }
    runtime.registrations = failed
        .iter()
        .map(|(registration, _)| registration.clone())
        .collect();
    runtime.active = !failed.is_empty();
    if !runtime.active {
        runtime.revision.clear();
    }
    save_runtime(root, runtime)?;
    if let Some((_, error)) = failed.first() {
        return Err(format!(
            "部分窗口未能恢复，已保留图片和恢复信息，请重试或完全退出客户端：{error}"
        ));
    }
    Ok(())
}

fn restore_runtime(root: &Path) -> Result<(), String> {
    let mut runtime = match load_runtime_checked(root) {
        Ok(runtime) => runtime,
        Err(error) if is_chatgpt_running() => return Err(error),
        Err(_) => {
            let runtime = BackgroundRuntime::default();
            save_runtime(root, &runtime)?;
            runtime
        }
    };
    if !runtime.active && runtime.registrations.is_empty() {
        return Ok(());
    }
    if let Some(port) = runtime.port {
        match list_targets(port) {
            Ok(targets) => {
                if !targets.is_empty() {
                    verify_endpoint_owner(port)?;
                }
                return cleanup_targets(root, &mut runtime, &targets);
            }
            Err(error) if is_chatgpt_running() => {
                return Err(format!(
                    "暂时无法确认背景已移除；恢复信息仍保留。请重试或完全退出客户端后清除：{error}"
                ))
            }
            Err(_) => {} // The client has exited; there can be no live DOM layer.
        }
    } else if is_chatgpt_running() {
        return Err("恢复信息缺少端口，请完全退出客户端后再清除".to_string());
    }
    runtime.active = false;
    runtime.registrations.clear();
    runtime.revision.clear();
    save_runtime(root, &runtime)
}

pub(crate) fn restore_session(root: &Path) -> Result<BackgroundState, String> {
    restore_runtime(root)?;
    get_state(root)
}

fn read_wallpaper(root: &Path, manifest: &BackgroundManifest) -> Result<String, String> {
    let path = wallpaper_path(root, manifest)?;
    let file = fs::File::open(&path).map_err(|error| format!("无法读取背景图片：{error}"))?;
    let mut bytes = Vec::new();
    file.take((MAX_IMAGE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("保存的背景图片为空或超过 8 MiB".to_string());
    }
    if manifest.file_name.starts_with("wallpaper-") {
        let expected = manifest
            .file_name
            .strip_prefix("wallpaper-")
            .and_then(|name| name.split('.').next())
            .unwrap_or("");
        if format!("{:x}", Sha256::digest(&bytes)) != expected {
            return Err("保存的图片校验不一致，请重新选择原图".to_string());
        }
    }
    Ok(format!(
        "data:{};base64,{}",
        manifest.mime,
        BASE64.encode(bytes)
    ))
}

fn inject_transaction(
    root: &Path,
    runtime: &mut BackgroundRuntime,
    targets: &[CdpTarget],
    script: &str,
    revision: &str,
) -> Result<(), String> {
    let port = runtime.port.ok_or_else(|| "缺少调试端口".to_string())?;
    // Journal ALL targets before the first write. Even a timeout after sending
    // Runtime.evaluate must retain enough information to retry cleanup.
    runtime.registrations = targets
        .iter()
        .map(|target| RuntimeRegistration {
            target_id: target.id.clone(),
            script_id: String::new(),
        })
        .collect();
    runtime.active = true;
    runtime.revision = revision.to_string();
    save_runtime(root, runtime)?;
    let operation = (|| {
        for target in targets {
            cdp_call(
                &target.web_socket_debugger_url,
                port,
                "Runtime.evaluate",
                json!({ "expression": script, "returnByValue": true, "awaitPromise": true }),
            )?;
            if !target_health(port, target, revision)? {
                return Err("图片或内容区的健康检查未通过".to_string());
            }
        }
        Ok(())
    })();
    if let Err(error) = operation {
        return match cleanup_targets(root, runtime, targets) {
            Ok(()) => Err(format!("{error}；本次全部窗口的背景已回退")),
            Err(cleanup) => Err(format!("{error}；{cleanup}")),
        };
    }
    Ok(())
}

pub(crate) fn apply(
    root: &Path,
    restart: bool,
    surface: &str,
    ink: &str,
    accent: &str,
) -> Result<BackgroundApplyResult, String> {
    let manifest = load_manifest(root)?.ok_or_else(|| "请先选择一张背景图片".to_string())?;
    if !manifest.settings.enabled {
        restore_runtime(root)?;
        return Ok(BackgroundApplyResult {
            active: false,
            port: load_runtime(root).port.unwrap_or(0),
            targets: 0,
            restarted: false,
            session_only: true,
        });
    }
    let data_url = read_wallpaper(root, &manifest)?;
    let revision = manifest_revision(&manifest);
    let script = build_injection_script(
        &data_url,
        &manifest.settings,
        surface,
        ink,
        accent,
        &revision,
    )?;
    let mut runtime = load_runtime_checked(root)?;
    let port = choose_port(&runtime)?;
    let running = is_chatgpt_running();
    let ready = endpoint_ready(port);
    let mut restarted = false;
    if !ready {
        if running && !restart {
            return Err(
                "RESTART_REQUIRED:图片背景需要以本机增强模式重开客户端；请先保存未完成内容。"
                    .to_string(),
            );
        }
        let executable = discover_chatgpt_executable(&runtime)?;
        if running {
            stop_chatgpt()?;
            restarted = true;
        }
        runtime.port = Some(port);
        runtime.executable = Some(executable.to_string_lossy().into_owned());
        runtime.active = false;
        runtime.registrations.clear();
        // Persist the port before launch, so a timeout can be retried without
        // starting another disconnected client or losing the chosen endpoint.
        save_runtime(root, &runtime)?;
        launch_with_debug(&executable, port)?;
    } else {
        verify_endpoint_owner(port)?;
        restore_runtime(root)?;
        runtime = load_runtime(root);
    }
    let targets = wait_for_targets(port)?;
    verify_endpoint_owner(port)?;
    runtime.port = Some(port);
    inject_transaction(root, &mut runtime, &targets, &script, &revision)?;
    Ok(BackgroundApplyResult {
        active: true,
        port,
        targets: targets.len(),
        restarted,
        session_only: true,
    })
}

pub(crate) fn clear(root: &Path) -> Result<BackgroundState, String> {
    restore_runtime(root)?;
    remove_wallpaper_variants(root, None)?;
    let manifest = manifest_path(root);
    if manifest.exists() {
        fs::remove_file(manifest).map_err(|error| format!("无法清除背景配置：{error}"))?;
    }
    // Keep the known local endpoint so a new image can be applied without an
    // unnecessary restart. It contains no image or chat data.
    get_state(root)
}

pub(crate) fn get_state(root: &Path) -> Result<BackgroundState, String> {
    let runtime_result = load_runtime_checked(root);
    let runtime_warning = runtime_result.as_ref().err().cloned();
    let runtime = runtime_result.unwrap_or_default();
    let port = runtime.port;
    let targets = port
        .and_then(|port| list_targets(port).ok())
        .unwrap_or_default();
    let ready = !targets.is_empty();
    let running = is_chatgpt_running();
    let mut warning = runtime_warning;
    let manifest = match load_manifest(root) {
        Ok(value) => value,
        Err(error) => {
            warning = Some(error);
            None
        }
    };
    let mut state = BackgroundState {
        settings: WallpaperSettings::default(),
        saved_settings: WallpaperSettings::default(),
        configured: false,
        active: false,
        endpoint_ready: ready,
        app_running: running,
        needs_restart: false,
        port,
        file_name: None,
        mime: None,
        width: None,
        height: None,
        image_data_url: None,
        experimental: true,
        has_session: runtime.active || !runtime.registrations.is_empty(),
        warning,
    };
    if let Some(manifest) = manifest {
        state.settings = manifest.settings.clone();
        state.saved_settings = manifest.settings.clone();
        state.file_name = Some(manifest.original_name.clone());
        state.mime = Some(manifest.mime.clone());
        state.width = Some(manifest.width);
        state.height = Some(manifest.height);
        match read_wallpaper(root, &manifest) {
            Ok(image) => {
                state.image_data_url = Some(image);
                state.configured = true;
            }
            Err(error) => state.warning = Some(error),
        }
        state.active = runtime.active
            && state.configured
            && manifest.settings.enabled
            && manifest_revision(&manifest) == runtime.revision
            && !runtime.registrations.is_empty()
            && runtime.registrations.iter().all(|registration| {
                targets
                    .iter()
                    .find(|target| target.id == registration.target_id)
                    .is_some_and(|target| {
                        target_health(port.unwrap_or(0), target, &runtime.revision).unwrap_or(false)
                    })
            });
    }
    state.needs_restart = state.configured && state.settings.enabled && running && !ready;
    Ok(state)
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
            "test-revision",
        )
        .unwrap();
        assert!(script.contains("codexskin-wallpaper-style"));
        assert!(script.contains("codexskin-wallpaper-layer"));
        assert!(script.contains("data:image/png;base64"));
        assert!(script.contains("#101820"));
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
        let manifest = load_manifest(temp.path()).unwrap().unwrap();
        assert!(wallpaper_path(temp.path(), &manifest).unwrap().is_file());
    }

    #[test]
    fn rejects_truncated_pixels_even_when_dimensions_are_readable() {
        let temp = tempfile::tempdir().unwrap();
        let (_, _, _, bytes) = parse_image_data_url(ONE_PIXEL_PNG).unwrap();
        let truncated = format!("data:image/png;base64,{}", BASE64.encode(&bytes[..45]));
        assert!(save_image(temp.path(), "broken.png", &truncated).is_err());
        assert!(!manifest_path(temp.path()).exists());
    }

    #[test]
    fn permits_replacing_a_corrupt_manifest() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(background_dir(temp.path())).unwrap();
        fs::write(manifest_path(temp.path()), "{broken").unwrap();
        assert!(save_image(temp.path(), "repaired.png", ONE_PIXEL_PNG).is_ok());
    }

    fn fake_target(port: u16, id: &str) -> CdpTarget {
        CdpTarget {
            id: id.to_string(),
            url: "app://./index.html".into(),
            target_type: "page".into(),
            web_socket_debugger_url: format!("ws://127.0.0.1:{port}/devtools/page/{id}"),
        }
    }

    fn serve_cdp(replies: Vec<Value>) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            for result in replies {
                let deadline = Instant::now() + Duration::from_secs(8);
                let stream = loop {
                    if let Ok((stream, _)) = listener.accept() {
                        break stream;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "CDP test did not receive expected request"
                    );
                    thread::sleep(Duration::from_millis(5));
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut socket = tungstenite::accept(stream).unwrap();
                let request: Value =
                    serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
                socket
                    .send(Message::Text(
                        json!({"id":request["id"], "result":result}).to_string(),
                    ))
                    .unwrap();
            }
        });
        (port, worker)
    }

    #[test]
    fn propagates_javascript_exceptions() {
        let (port, worker) = serve_cdp(vec![
            json!({"exceptionDetails":{"exception":{"description":"image decode failed"}}}),
        ]);
        let error = cdp_call(
            &fake_target(port, "1").web_socket_debugger_url,
            port,
            "Runtime.evaluate",
            json!({}),
        )
        .unwrap_err();
        assert!(error.contains("image decode failed"));
        worker.join().unwrap();
    }

    #[test]
    fn transaction_rolls_back_all_windows_on_failed_health_check() {
        let temp = tempfile::tempdir().unwrap();
        let (port, worker) = serve_cdp(vec![
            json!({}),
            json!({"result":{"value":{"active":true,"revision":"r1"}}}),
            json!({}),
            json!({"result":{"value":{"active":false,"revision":"r1"}}}),
            json!({"result":{"value":true}}),
            json!({"result":{"value":true}}),
        ]);
        let mut runtime = BackgroundRuntime {
            port: Some(port),
            ..Default::default()
        };
        let targets = [fake_target(port, "1"), fake_target(port, "2")];
        assert!(
            inject_transaction(temp.path(), &mut runtime, &targets, "script", "r1")
                .unwrap_err()
                .contains("全部窗口")
        );
        assert!(!load_runtime(temp.path()).active);
        assert!(load_runtime(temp.path()).registrations.is_empty());
        worker.join().unwrap();
    }

    #[test]
    fn failed_cleanup_retains_recovery_journal() {
        let temp = tempfile::tempdir().unwrap();
        let (port, worker) = serve_cdp(vec![
            json!({"exceptionDetails":{"exception":{"description":"disconnected"}}}),
        ]);
        let mut runtime = BackgroundRuntime {
            active: true,
            port: Some(port),
            revision: "r1".into(),
            registrations: vec![RuntimeRegistration {
                target_id: "1".into(),
                script_id: String::new(),
            }],
            ..Default::default()
        };
        assert!(cleanup_targets(temp.path(), &mut runtime, &[fake_target(port, "1")]).is_err());
        assert!(load_runtime(temp.path()).active);
        assert_eq!(load_runtime(temp.path()).registrations.len(), 1);
        worker.join().unwrap();
    }

    #[test]
    fn no_ready_endpoint_for_empty_or_browser_only_target_list() {
        for payload in [
            json!([]),
            json!([{"id":"a","title":"ChatGPT","type":"page","url":"https://chatgpt.com","webSocketDebuggerUrl":"ws://127.0.0.1:1/devtools/page/a"}]),
        ] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = [0; 4096];
                let _ = stream.read(&mut buffer);
                let body = payload.to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            });
            assert!(!endpoint_ready(port));
            server.join().unwrap();
        }
    }

    #[test]
    fn unresponsive_websocket_has_a_deadline() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            socket.read().unwrap();
            thread::sleep(Duration::from_millis(4400));
        });
        let started = Instant::now();
        assert!(cdp_call(
            &fake_target(port, "1").web_socket_debugger_url,
            port,
            "Runtime.evaluate",
            json!({})
        )
        .is_err());
        assert!(started.elapsed() < Duration::from_secs(6));
        worker.join().unwrap();
    }

    #[test]
    fn missing_image_reports_recoverable_state() {
        let temp = tempfile::tempdir().unwrap();
        save_image(temp.path(), "valid.png", ONE_PIXEL_PNG).unwrap();
        let manifest = load_manifest(temp.path()).unwrap().unwrap();
        fs::remove_file(wallpaper_path(temp.path(), &manifest).unwrap()).unwrap();
        let state = get_state(temp.path()).unwrap();
        assert!(!state.configured);
        assert!(state.warning.is_some());
    }

    #[test]
    fn rejects_path_traversal_in_manifest() {
        let manifest = BackgroundManifest {
            file_name: "../config.toml".into(),
            original_name: "x".into(),
            mime: "image/png".into(),
            width: 1,
            height: 1,
            settings: WallpaperSettings::default(),
        };
        assert!(wallpaper_path(Path::new("x"), &manifest).is_err());
    }

    #[test]
    fn three_storage_cycles_preserve_user_original_and_support_disabled_apply() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("user-original.png");
        fs::write(&original, "user-owned").unwrap();
        let root = temp.path().join("app");
        for _ in 0..3 {
            save_image(&root, "测试.png", ONE_PIXEL_PNG).unwrap();
            let settings = WallpaperSettings {
                enabled: false,
                blur: 12,
                fit: "contain".into(),
                ..Default::default()
            };
            update_settings(&root, settings.clone()).unwrap();
            assert_eq!(get_state(&root).unwrap().settings, settings);
            let result = apply(&root, false, "#101820", "#ffffff", "#123456").unwrap();
            assert!(!result.active);
            assert!(!result.restarted);
            assert!(!clear(&root).unwrap().configured);
            assert_eq!(fs::read_to_string(&original).unwrap(), "user-owned");
        }
    }

    #[test]
    fn accepts_fully_decoded_jpeg_and_webp() {
        let temp = tempfile::tempdir().unwrap();
        let mut jpeg = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 3)
            .write_to(&mut jpeg, ImageFormat::Jpeg)
            .unwrap();
        let state = save_image(
            temp.path(),
            "test.jpg",
            &format!(
                "data:image/jpeg;base64,{}",
                BASE64.encode(jpeg.into_inner())
            ),
        )
        .unwrap();
        assert_eq!(state.width, Some(4));
        let mut webp = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
            .encode(&[128, 64, 32], 1, 1, image::ColorType::Rgb8)
            .unwrap();
        let state = save_image(
            temp.path(),
            "test.webp",
            &format!("data:image/webp;base64,{}", BASE64.encode(webp)),
        )
        .unwrap();
        assert_eq!(state.mime.as_deref(), Some("image/webp"));
    }

    #[test]
    fn tampered_image_is_not_reported_as_configured() {
        let temp = tempfile::tempdir().unwrap();
        save_image(temp.path(), "test.png", ONE_PIXEL_PNG).unwrap();
        let manifest = load_manifest(temp.path()).unwrap().unwrap();
        fs::write(wallpaper_path(temp.path(), &manifest).unwrap(), b"tampered").unwrap();
        let state = get_state(temp.path()).unwrap();
        assert!(!state.configured);
        assert!(state.warning.unwrap().contains("校验"));
    }

    #[test]
    fn failed_manifest_commit_keeps_previous_image_intact() {
        let temp = tempfile::tempdir().unwrap();
        save_image(temp.path(), "original.png", ONE_PIXEL_PNG).unwrap();
        let manifest = load_manifest(temp.path()).unwrap().unwrap();
        let original = wallpaper_path(temp.path(), &manifest).unwrap();
        let bytes = fs::read(&original).unwrap();
        fs::remove_file(manifest_path(temp.path())).unwrap();
        fs::create_dir(manifest_path(temp.path())).unwrap();
        assert!(save_image(temp.path(), "new.png", ONE_PIXEL_PNG).is_err());
        assert_eq!(fs::read(original).unwrap(), bytes);
    }
}
