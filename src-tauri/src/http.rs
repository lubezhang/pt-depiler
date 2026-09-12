use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(target_os = "macos")]
use std::{io::Read, process::Stdio};

use base64::{engine::general_purpose::STANDARD, Engine};
use cookie::{time::OffsetDateTime, Cookie, SameSite};
use cookie_store::{CookieDomain, CookiePath};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tempfile::NamedTempFile;
#[cfg(target_os = "macos")]
use tokio::process::Command;
use url::Url;

use crate::state::AppState;

const HTTP_DEBUG_LOG_FILE: &str = "pt-depiler-http-debug.log";
const HTTP_DEBUG_LOG_MAX_BYTES: u64 = 1_048_576;
const SITE_LOGIN_WINDOW_LABEL: &str = "site-login";
#[cfg(target_os = "macos")]
const CURL_STDERR_MAX_BYTES: u64 = 4_096;

/// 仅供排查桌面端站点请求问题。请求体、Cookie 与请求头值均不记录，避免凭据落盘。
fn write_http_debug_log(message: impl AsRef<str>) {
    if std::env::var("PTD_HTTP_DEBUG").as_deref() != Ok("1") {
        return;
    }
    let path = std::env::temp_dir().join(HTTP_DEBUG_LOG_FILE);
    if path
        .metadata()
        .is_ok_and(|metadata| metadata.len() >= HTTP_DEBUG_LOG_MAX_BYTES)
    {
        let rotated = path.with_extension("log.old");
        let _ = std::fs::remove_file(&rotated);
        let _ = std::fs::rename(&path, rotated);
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{timestamp}] {}", message.as_ref());
    }
}

#[tauri::command]
pub fn write_debug_log(message: String) {
    write_http_debug_log(message);
}

fn redacted_url(value: &str) -> String {
    match Url::parse(value) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        }
        Err(_) => "<invalid-url>".to_string(),
    }
}

fn request_cookie_names(state: &AppState, request_url: &str) -> String {
    let Ok(url) = Url::parse(request_url) else {
        return "<invalid-url>".to_string();
    };
    let Ok(store) = state.cookie_store.lock() else {
        return "<unavailable>".to_string();
    };
    let mut names: Vec<_> = store
        .get_request_values(&url)
        .map(|(name, _)| name.to_string())
        .collect();
    names.sort_unstable();
    names.join(",")
}

/// 前端发起的站点请求统一走此命令。
/// 替代原扩展的 declarativeNetRequest + extends/axios/replaceUnsafeHeader + offscreen fetch：
/// - 全局 cookie store（对齐浏览器全局 cookie jar，cookie 按 domain 隔离）
/// - 可自由设置 referer/UA/origin/cookie（不受浏览器禁设头限制）
/// - Cloudflare 521/522/523/403 拦截重试（迁移自 retryWhenCloudflareBlock.ts）
/// - binary 模式下 body 以 base64 返回，支持种子文件等二进制内容（arraybuffer/blob responseType）
///
/// site_id 字段保留兼容前端的 tauriAdapter，Rust 侧用全局 cookie store 不再按 site_id 隔离。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub request_id: Option<String>,
    pub site_id: String,
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: FetchBody,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub params: Option<HashMap<String, String>>,
    /// 单次请求超时（毫秒），默认 30s
    pub timeout: Option<u64>,
    /// Cloudflare 拦截重试次数，默认 3
    pub max_retries: Option<u32>,
    /// 是否以二进制方式返回 body（base64 编码），用于种子文件等
    pub binary: Option<bool>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum FetchBody {
    None,
    Text(String),
    Base64(String),
}

impl FetchBody {
    fn bytes(&self) -> Result<Option<Vec<u8>>, String> {
        match self {
            Self::None => Ok(None),
            Self::Text(value) => Ok(Some(value.as_bytes().to_vec())),
            Self::Base64(value) => STANDARD
                .decode(value)
                .map(Some)
                .map_err(|error| format!("请求体 base64 无效: {error}")),
        }
    }

    fn len(&self) -> usize {
        match self {
            Self::None => 0,
            Self::Text(value) | Self::Base64(value) => value.len(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub final_url: String,
}

struct RawHttpResponse {
    status: u16,
    http_version: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
    final_url: String,
}

fn format_reqwest_error(mut error: reqwest::Error) -> String {
    if let Some(url) = error.url_mut() {
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
    }
    if error.is_timeout() {
        format!("请求超时: {error}")
    } else {
        error.to_string()
    }
}

async fn send_with_reqwest(
    req: &FetchRequest,
    method: &Method,
    timeout: Duration,
    state: &AppState,
) -> Result<RawHttpResponse, String> {
    let mut builder = state
        .client
        .request(method.clone(), &req.url)
        .timeout(timeout);
    if let Some(headers) = &req.headers {
        for (key, value) in headers {
            builder = builder.header(key, value);
        }
    }
    if let Some(params) = &req.params {
        builder = builder.query(params);
    }
    if let Some(body) = req.body.bytes()? {
        builder = builder.body(body);
    }

    let response = builder.send().await.map_err(format_reqwest_error)?;
    let status = response.status().as_u16();
    let http_version = format!("{:?}", response.version());
    let final_url = response.url().to_string();
    let mut headers = HashMap::new();
    for (key, value) in response.headers() {
        headers.insert(
            key.as_str().to_string(),
            value.to_str().unwrap_or("").to_string(),
        );
    }
    let body = response
        .bytes()
        .await
        .map_err(format_reqwest_error)?
        .to_vec();

    Ok(RawHttpResponse {
        status,
        http_version,
        headers,
        body,
        final_url,
    })
}

#[cfg(target_os = "macos")]
fn curl_cookie_file(state: &AppState) -> Result<NamedTempFile, String> {
    let store = state
        .cookie_store
        .lock()
        .map_err(|error| error.to_string())?;
    let mut file = NamedTempFile::new().map_err(|error| error.to_string())?;
    writeln!(file, "# Netscape HTTP Cookie File").map_err(|error| error.to_string())?;
    for stored_cookie in store.iter_unexpired() {
        let cookie = cookie_to_info(stored_cookie)?;
        let domain = format!(
            "{}{}",
            if cookie.http_only { "#HttpOnly_" } else { "" },
            cookie.domain
        );
        writeln!(
            file,
            "{}\t{}\t{}\t{}\t{}\t{}\t{}",
            domain,
            if cookie.host_only { "FALSE" } else { "TRUE" },
            cookie.path,
            if cookie.secure { "TRUE" } else { "FALSE" },
            cookie.expiration_date.unwrap_or(0.0) as i64,
            cookie.name,
            cookie.value
        )
        .map_err(|error| error.to_string())?;
    }
    file.flush().map_err(|error| error.to_string())?;
    Ok(file)
}

#[cfg(target_os = "macos")]
fn parse_curl_headers(raw_headers: &str) -> Result<(u16, String, HashMap<String, String>), String> {
    let blocks = parse_curl_header_blocks(raw_headers)?;
    let block = blocks.last().ok_or("curl 未返回 HTTP 响应头")?;
    let headers = block.headers.iter().cloned().collect();
    Ok((block.status, block.http_version.clone(), headers))
}

#[cfg(target_os = "macos")]
struct CurlHeaderBlock {
    status: u16,
    http_version: String,
    headers: Vec<(String, String)>,
}

#[cfg(target_os = "macos")]
fn parse_curl_header_blocks(raw_headers: &str) -> Result<Vec<CurlHeaderBlock>, String> {
    let normalized_headers = raw_headers.replace("\r\n", "\n");
    normalized_headers
        .split("\n\n")
        .filter(|block| block.trim_start().starts_with("HTTP/"))
        .map(|block| {
            let mut lines = block.lines();
            let status_line = lines.next().ok_or("curl 响应状态行为空")?.trim();
            let mut status_parts = status_line.split_whitespace();
            let http_version = status_parts.next().unwrap_or_default().to_string();
            let status = status_parts
                .next()
                .ok_or("curl 响应状态行缺少状态码")?
                .parse::<u16>()
                .map_err(|error| error.to_string())?;
            let headers = lines
                .filter_map(|line| {
                    let (key, value) = line.trim().split_once(':')?;
                    Some((key.trim().to_string(), value.trim().to_string()))
                })
                .collect();
            Ok(CurlHeaderBlock {
                status,
                http_version,
                headers,
            })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn parse_curl_cookie_jar(
    cookie_jar: &str,
) -> Result<HashMap<(String, String, String), CookieInfo>, String> {
    let mut cookies = HashMap::new();
    for line in cookie_jar.lines() {
        let http_only = line.starts_with("#HttpOnly_");
        if line.starts_with('#') && !http_only {
            continue;
        }
        let fields: Vec<_> = line.splitn(7, '\t').collect();
        if fields.len() != 7 {
            continue;
        }
        let domain = fields[0].trim_start_matches("#HttpOnly_");
        let host_only = !fields[1].eq_ignore_ascii_case("TRUE");
        let path = fields[2];
        let secure = fields[3].eq_ignore_ascii_case("TRUE");
        let expiration = fields[4].parse::<i64>().unwrap_or(0);
        let cookie = CookieInfo {
            name: fields[5].to_string(),
            value: fields[6].to_string(),
            domain: if host_only {
                domain.to_string()
            } else {
                format!(".{}", domain.trim_start_matches('.'))
            },
            host_only,
            path: path.to_string(),
            secure,
            http_only,
            expiration_date: (expiration > 0).then_some(expiration as f64),
            same_site: None,
        };
        let key = (
            domain.trim_start_matches('.').to_ascii_lowercase(),
            path.to_string(),
            cookie.name.clone(),
        );
        cookies.insert(key, cookie);
    }
    Ok(cookies)
}

#[cfg(target_os = "macos")]
fn store_curl_cookie_jar(
    state: &AppState,
    input_cookie_jar: &str,
    output_cookie_jar: &str,
) -> Result<(), String> {
    let input = parse_curl_cookie_jar(input_cookie_jar)?;
    let output = parse_curl_cookie_jar(output_cookie_jar)?;
    let mut store = state
        .cookie_store
        .lock()
        .map_err(|error| error.to_string())?;

    for (domain, path, name) in input.keys().filter(|key| !output.contains_key(*key)) {
        store.remove(domain, path, name);
    }
    for (key, cookie) in output {
        if input.get(&key) != Some(&cookie) {
            store_cookie_info(&mut store, cookie)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn store_curl_response_cookies(
    state: &AppState,
    raw_headers: &str,
    request_url: &str,
) -> Result<(), String> {
    let mut response_url = Url::parse(request_url).map_err(|error| error.to_string())?;
    let mut store = state
        .cookie_store
        .lock()
        .map_err(|error| error.to_string())?;

    for block in parse_curl_header_blocks(raw_headers)? {
        let cookies = block
            .headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("set-cookie"))
            .filter_map(|(_, value)| Cookie::parse(value.clone()).ok());
        store.store_response_cookies(cookies, &response_url);

        if matches!(block.status, 301 | 302 | 303 | 307 | 308) {
            if let Some((_, location)) = block
                .headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("location"))
            {
                response_url = response_url
                    .join(location)
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
async fn command_output_with_limited_stderr(
    command: &mut Command,
    timeout: Duration,
) -> Result<(std::process::Output, String), String> {
    let mut stdout_file = NamedTempFile::new().map_err(|error| error.to_string())?;
    let mut stderr_file = NamedTempFile::new().map_err(|error| error.to_string())?;
    let stdout_target = stdout_file.reopen().map_err(|error| error.to_string())?;
    let stderr_target = stderr_file.reopen().map_err(|error| error.to_string())?;
    command
        .kill_on_drop(true)
        .stdout(Stdio::from(stdout_target))
        .stderr(Stdio::from(stderr_target));

    let status = tokio::time::timeout(timeout, command.status())
        .await
        .map_err(|_| "curl 子进程超时".to_string())?
        .map_err(|error| error.to_string())?;
    let mut stdout = Vec::new();
    stdout_file
        .as_file_mut()
        .read_to_end(&mut stdout)
        .map_err(|error| error.to_string())?;
    let mut stderr = Vec::new();
    stderr_file
        .as_file_mut()
        .take(CURL_STDERR_MAX_BYTES)
        .read_to_end(&mut stderr)
        .map_err(|error| error.to_string())?;
    Ok((
        std::process::Output {
            status,
            stdout,
            stderr: Vec::new(),
        },
        String::from_utf8_lossy(&stderr).into_owned(),
    ))
}

#[cfg(target_os = "macos")]
async fn send_with_curl(
    req: &FetchRequest,
    method: &Method,
    timeout: Duration,
    state: &AppState,
) -> Result<RawHttpResponse, String> {
    let headers_file = NamedTempFile::new().map_err(|error| error.to_string())?;
    let response_body_file = NamedTempFile::new().map_err(|error| error.to_string())?;
    if !std::path::Path::new("/usr/bin/curl").is_file()
        || !std::path::Path::new("/bin/launchctl").is_file()
    {
        return Err("macOS curl 兼容路径不可用".to_string());
    }
    let cookie_file = curl_cookie_file(state)?;
    let input_cookie_jar =
        std::fs::read_to_string(cookie_file.path()).map_err(|error| error.to_string())?;
    let timeout_seconds = timeout.as_secs_f64().ceil().max(1.0).to_string();
    let request_body = req.body.bytes()?;
    let request_has_body = request_body.as_ref().is_some_and(|body| !body.is_empty());
    let mut request_body_file = if request_has_body {
        Some(NamedTempFile::new().map_err(|error| error.to_string())?)
    } else {
        None
    };
    if let (Some(file), Some(body)) = (&mut request_body_file, request_body.as_deref()) {
        file.write_all(body).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
    }

    // Running curl through the GUI user's launchd domain matches the macOS
    // system networking context. Direct child processes receive Cloudflare 400
    // responses on this machine while the user-domain process succeeds.
    let user_id = unsafe { libc::geteuid() }.to_string();
    let mut command = Command::new("/bin/launchctl");
    command
        .arg("asuser")
        .arg(user_id)
        .arg("/usr/bin/curl")
        .args([
            "--silent",
            "--show-error",
            "--location",
            "--max-redirs",
            "10",
            "--compressed",
            "--max-time",
            &timeout_seconds,
            "--dump-header",
        ])
        .arg(headers_file.path())
        .arg("--output")
        .arg(response_body_file.path())
        .arg("--cookie")
        .arg(cookie_file.path())
        .arg("--cookie-jar")
        .arg(cookie_file.path())
        .arg("--write-out")
        .arg("%{http_code}\n%{url_effective}")
        .arg("--url")
        .arg(&req.url);
    if *method == Method::HEAD {
        command.arg("--head");
    } else if *method != Method::GET && !(request_has_body && *method == Method::POST) {
        command.arg("--request").arg(method.as_str());
    }
    if let Some(headers) = &req.headers {
        for (key, value) in headers {
            command.arg("--header").arg(format!("{key}: {value}"));
        }
    }
    if let Some(file) = &request_body_file {
        command
            .arg("--data-binary")
            .arg(format!("@{}", file.path().display()));
    }

    let process_timeout = timeout
        .checked_add(Duration::from_secs(2))
        .unwrap_or(timeout);
    let (output, stderr) =
        command_output_with_limited_stderr(&mut command, process_timeout).await?;
    if !output.status.success() {
        let stderr = stderr.replace(&req.url, &redacted_url(&req.url));
        return Err(format!(
            "curl 请求失败（退出码 {:?}）：{}",
            output.status.code(),
            stderr.trim()
        ));
    }

    let raw_headers =
        std::fs::read_to_string(headers_file.path()).map_err(|error| error.to_string())?;
    let (status, http_version, headers) = parse_curl_headers(&raw_headers)?;
    let cookie_jar =
        std::fs::read_to_string(cookie_file.path()).map_err(|error| error.to_string())?;
    store_curl_cookie_jar(state, &input_cookie_jar, &cookie_jar)?;
    store_curl_response_cookies(state, &raw_headers, &req.url)?;
    let body = std::fs::read(response_body_file.path()).map_err(|error| error.to_string())?;
    let output = String::from_utf8_lossy(&output.stdout);
    let final_url = output.lines().nth(1).unwrap_or(&req.url).to_string();

    Ok(RawHttpResponse {
        status,
        http_version,
        headers,
        body,
        final_url,
    })
}

fn is_cloudflare_blocked(status: u16, headers: &HashMap<String, String>, body: &str) -> bool {
    if let Some(v) = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("cf-mitigated"))
        .map(|(_, v)| v)
    {
        if v == "challenge" {
            return true;
        }
    }
    if matches!(status, 521..=523) {
        return true;
    }
    if status == 403 && body.contains("Enable JavaScript and cookies to continue") {
        return true;
    }
    false
}

fn is_idempotent(method: &Method) -> bool {
    matches!(
        *method,
        Method::GET | Method::HEAD | Method::OPTIONS | Method::PUT | Method::DELETE
    )
}

#[cfg(target_os = "macos")]
fn should_use_curl_fallback(response: &RawHttpResponse, method: &Method) -> bool {
    if !matches!(*method, Method::GET | Method::HEAD) {
        return false;
    }

    let from_cloudflare = response
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("server"))
        .is_some_and(|(_, value)| value.eq_ignore_ascii_case("cloudflare"));
    from_cloudflare && response.status == 400
}

#[tauri::command]
pub async fn ptd_fetch(
    req: FetchRequest,
    state: State<'_, AppState>,
) -> Result<FetchResponse, String> {
    ptd_fetch_cancellable(req, state.inner()).await
}

#[tauri::command]
pub fn ptd_cancel_fetch(request_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.cancel_http_request(&request_id)
}

async fn with_request_cancellation<T, F>(
    request_id: Option<&str>,
    state: &AppState,
    request: F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let Some(request_id) = request_id else {
        return request.await;
    };
    let cancellation = state.register_http_request(request_id)?;
    let result = tokio::select! {
        result = request => result,
        _ = cancellation => Err("请求已取消".to_string()),
    };
    state.finish_http_request(request_id);
    result
}

async fn ptd_fetch_cancellable(
    req: FetchRequest,
    state: &AppState,
) -> Result<FetchResponse, String> {
    let request_id = req.request_id.clone();
    with_request_cancellation(
        request_id.as_deref(),
        state,
        ptd_fetch_with_state(req, state),
    )
    .await
}

async fn ptd_fetch_with_state(
    req: FetchRequest,
    state: &AppState,
) -> Result<FetchResponse, String> {
    let method_name = req.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let method = Method::from_bytes(method_name.as_bytes()).map_err(|e| e.to_string())?;
    // Axios uses 0 to mean "no client-side timeout". Do not turn that into an
    // immediate Rust timeout; use the application's safe default instead.
    let timeout =
        Duration::from_millis(req.timeout.filter(|timeout| *timeout > 0).unwrap_or(30_000));
    let max_retries = req.max_retries.unwrap_or(3);
    let binary = req.binary.unwrap_or(false);
    let request_url = redacted_url(&req.url);
    let header_names = req
        .headers
        .as_ref()
        .map(|headers| {
            let mut names: Vec<_> = headers.keys().map(|name| name.as_str()).collect();
            names.sort_unstable();
            names.join(",")
        })
        .unwrap_or_default();
    let cookie_names = request_cookie_names(state, &req.url);

    write_http_debug_log(format!(
        "request site_id={} method={} url={} timeout_ms={} body_len={} header_names=[{}] cookie_names=[{}]",
        req.site_id,
        method,
        request_url,
        timeout.as_millis(),
        req.body.len(),
        header_names,
        cookie_names
    ));

    let mut attempt = 0u32;
    loop {
        let response_result = send_with_reqwest(&req, &method, timeout, state).await;

        let mut response = match response_result {
            Ok(response) => response,
            Err(error) => {
                write_http_debug_log(format!(
                    "transport_error site_id={} method={} url={} error={error:#}",
                    req.site_id, method, request_url
                ));
                return Err(format!("请求 {request_url} 失败: {error:#}"));
            }
        };
        #[cfg(target_os = "macos")]
        if should_use_curl_fallback(&response, &method) {
            write_http_debug_log(format!(
                "curl_fallback site_id={} method={} url={} reason=cloudflare_400",
                req.site_id, method, request_url
            ));
            response = send_with_curl(&req, &method, timeout, state)
                .await
                .map_err(|error| format!("请求 {request_url} 的 curl 兼容路径失败: {error:#}"))?;
        }
        let status = response.status;
        let http_version = response.http_version;
        let final_url = response.final_url;
        let headers_map = response.headers;
        // 统一以 bytes 读取，binary 模式 base64 编码返回；text 模式用 lossy utf8（同时供 Cloudflare 判断）
        let body_bytes = response.body;
        let body_text = String::from_utf8_lossy(&body_bytes).to_string();
        let has_set_cookie = headers_map
            .keys()
            .any(|key| key.eq_ignore_ascii_case("set-cookie"));
        write_http_debug_log(format!(
            "response site_id={} method={} url={} status={} http_version={} final_url={} body_len={} content_type={} content_encoding={} server={} cf_ray={} via={} has_set_cookie={} attempt={}",
            req.site_id,
            method,
            request_url,
            status,
            http_version,
            redacted_url(&final_url),
            body_bytes.len(),
            headers_map
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("content-type"))
                .map(|(_, value)| value.as_str())
                .unwrap_or(""),
            headers_map
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("content-encoding"))
                .map(|(_, value)| value.as_str())
                .unwrap_or(""),
            headers_map
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("server"))
                .map(|(_, value)| value.as_str())
                .unwrap_or(""),
            headers_map
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("cf-ray"))
                .map(|(_, value)| value.as_str())
                .unwrap_or(""),
            headers_map
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("via"))
                .map(|(_, value)| value.as_str())
                .unwrap_or(""),
            has_set_cookie,
            attempt
        ));

        state.persist_cookies()?;

        if is_idempotent(&method)
            && is_cloudflare_blocked(status, &headers_map, &body_text)
            && attempt < max_retries
        {
            attempt += 1;
            write_http_debug_log(format!(
                "cloudflare_retry site_id={} url={} next_attempt={}",
                req.site_id, request_url, attempt
            ));
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        }

        let body = if binary {
            STANDARD.encode(&body_bytes)
        } else {
            body_text
        };

        return Ok(FetchResponse {
            status,
            headers: headers_map,
            body,
            final_url,
        });
    }
}

// ===== cookie 读写命令 =====
// 操作全局 cookie_store，替代原 chrome.cookies API。供备份/恢复、checkAndExtendCookies 使用。

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieInfo {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub host_only: bool,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub expiration_date: Option<f64>,
    pub same_site: Option<String>,
}

#[derive(Deserialize)]
struct SerializedCookieScope {
    domain: CookieDomain,
    path: CookiePath,
}

fn cookie_to_info(c: &cookie_store::Cookie) -> Result<CookieInfo, String> {
    let scope: SerializedCookieScope =
        serde_json::from_value(serde_json::to_value(c).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let (domain, host_only) = match scope.domain {
        CookieDomain::HostOnly(domain) => (domain, true),
        CookieDomain::Suffix(domain) => (format!(".{domain}"), false),
        CookieDomain::NotPresent | CookieDomain::Empty => (String::new(), true),
    };

    Ok(CookieInfo {
        name: c.name().to_string(),
        value: c.value().to_string(),
        domain,
        host_only,
        path: String::from(scope.path),
        secure: c.secure().unwrap_or(false),
        http_only: c.http_only().unwrap_or(false),
        expiration_date: c.expires_datetime().map(|dt| dt.unix_timestamp() as f64),
        same_site: c.same_site().map(|s| format!("{:?}", s).to_lowercase()),
    })
}

/// cookie domain 与目标 host 是否匹配（兼容带前导点的 domain）
fn domain_matches(cookie_domain: &str, target: &str) -> bool {
    let cd = cookie_domain.trim_start_matches('.').to_ascii_lowercase();
    let target = target.to_ascii_lowercase();
    if cd.is_empty() {
        return false;
    }
    cd == target || target.ends_with(&format!(".{cd}"))
}

fn raw_cookie_to_info(cookie: Cookie<'static>, target_host: &str) -> Option<CookieInfo> {
    let domain = cookie.domain()?.to_string();
    if !domain_matches(&domain, target_host) {
        return None;
    }
    Some(CookieInfo {
        name: cookie.name().to_string(),
        value: cookie.value().to_string(),
        host_only: !domain.starts_with('.') && domain.eq_ignore_ascii_case(target_host),
        domain,
        path: cookie.path().unwrap_or("/").to_string(),
        secure: cookie.secure().unwrap_or(false),
        http_only: cookie.http_only().unwrap_or(false),
        expiration_date: cookie
            .expires_datetime()
            .map(|datetime| datetime.unix_timestamp() as f64),
        same_site: cookie
            .same_site()
            .map(|same_site| format!("{same_site:?}").to_lowercase()),
    })
}

fn cookie_info_to_raw(cookie: &CookieInfo) -> Result<Cookie<'static>, String> {
    let mut builder = Cookie::build((cookie.name.clone(), cookie.value.clone()))
        .domain(cookie.domain.trim_start_matches('.').to_string())
        .path(cookie.path.clone())
        .secure(cookie.secure)
        .http_only(cookie.http_only);
    if let Some(expiration_date) = cookie.expiration_date {
        builder = builder.expires(
            OffsetDateTime::from_unix_timestamp(expiration_date as i64)
                .map_err(|error| error.to_string())?,
        );
    }
    if let Some(same_site) = cookie.same_site.as_deref() {
        builder = builder.same_site(match same_site {
            "strict" => SameSite::Strict,
            "lax" => SameSite::Lax,
            _ => SameSite::None,
        });
    }
    Ok(builder.build())
}

fn cookies_for_host(state: &AppState, host: &str) -> Result<Vec<CookieInfo>, String> {
    let store = state
        .cookie_store
        .lock()
        .map_err(|error| error.to_string())?;
    store
        .iter_unexpired()
        .map(cookie_to_info)
        .filter_map(|cookie| match cookie {
            Ok(cookie) if domain_matches(&cookie.domain, host) => Some(Ok(cookie)),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn import_webview_cookies(
    cookies: Vec<Cookie<'static>>,
    target_host: &str,
    state: &AppState,
) -> Result<usize, String> {
    let cookies: Vec<_> = cookies
        .into_iter()
        .filter_map(|cookie| raw_cookie_to_info(cookie, target_host))
        .collect();
    let mut store = state
        .cookie_store
        .lock()
        .map_err(|error| error.to_string())?;
    for cookie in &cookies {
        store_cookie_info(&mut store, cookie.clone())?;
    }
    drop(store);
    state.persist_cookies()?;
    Ok(cookies.len())
}

fn prepare_login_window(
    window: &WebviewWindow,
    cookies: &[CookieInfo],
    login_url: Url,
) -> Result<(), String> {
    for cookie in cookies {
        window
            .set_cookie(cookie_info_to_raw(cookie)?)
            .map_err(|error| error.to_string())?;
    }
    window
        .navigate(login_url)
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn open_site_login(
    site_url: String,
    login_url: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let site_url = Url::parse(&site_url).map_err(|error| error.to_string())?;
    let login_url = Url::parse(&login_url).map_err(|error| error.to_string())?;
    if !matches!(site_url.scheme(), "http" | "https")
        || !matches!(login_url.scheme(), "http" | "https")
    {
        return Err("站点登录只支持 HTTP 或 HTTPS 地址".to_string());
    }
    let site_host = site_url.host_str().ok_or("站点地址缺少主机名")?;
    if login_url.host_str() != Some(site_host) {
        return Err("登录页必须与配置的站点地址同源".to_string());
    }
    let cookies = cookies_for_host(state.inner(), site_host)?;

    if let Some(window) = app.get_webview_window(SITE_LOGIN_WINDOW_LABEL) {
        return prepare_login_window(&window, &cookies, login_url);
    }

    let window = WebviewWindowBuilder::new(
        &app,
        SITE_LOGIN_WINDOW_LABEL,
        WebviewUrl::External(Url::parse("about:blank").map_err(|error| error.to_string())?),
    )
    .title(format!("登录 {site_host}"))
    .inner_size(1100.0, 760.0)
    .min_inner_size(720.0, 520.0)
    .center()
    .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"))
    .build()
    .map_err(|error| error.to_string())?;
    prepare_login_window(&window, &cookies, login_url)
}

#[tauri::command]
pub async fn finish_site_login(
    site_url: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let site_url = Url::parse(&site_url).map_err(|error| error.to_string())?;
    let site_host = site_url.host_str().ok_or("站点地址缺少主机名")?;
    let window = app
        .get_webview_window(SITE_LOGIN_WINDOW_LABEL)
        .ok_or("站点登录窗口未打开或已关闭")?;
    let cookies = window.cookies().map_err(|error| error.to_string())?;
    let count = import_webview_cookies(cookies, site_host, state.inner())?;
    window.close().map_err(|error| error.to_string())?;
    Ok(count)
}

#[tauri::command]
pub async fn get_cookies(
    domain: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<CookieInfo>, String> {
    let store = state.cookie_store.lock().map_err(|e| e.to_string())?;
    let mut cookies = Vec::new();
    for stored_cookie in store.iter_unexpired() {
        let cookie = cookie_to_info(stored_cookie)?;
        let matches = match &domain {
            None => true,
            Some(target) if cookie.host_only => cookie.domain == *target,
            Some(target) => domain_matches(&cookie.domain, target),
        };
        if matches {
            cookies.push(cookie);
        }
    }
    Ok(cookies)
}

#[cfg(test)]
fn get_cookie_with_state(
    url: String,
    name: String,
    state: &AppState,
) -> Result<Option<CookieInfo>, String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    let store = state.cookie_store.lock().map_err(|e| e.to_string())?;
    let matches = store
        .iter_unexpired()
        .filter(|cookie| cookie.name() == name && cookie.matches(&url))
        .map(cookie_to_info)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(matches.into_iter().max_by_key(|cookie| cookie.path.len()))
}

fn build_cookie_url(secure: bool, domain: &str, path: &str) -> Result<Url, String> {
    let d = domain.trim_start_matches('.');
    let s = format!("http{}://{}{}", if secure { "s" } else { "" }, d, path);
    Url::parse(&s).map_err(|e| e.to_string())
}

fn store_cookie_info(
    store: &mut cookie_store::CookieStore,
    cookie: CookieInfo,
) -> Result<(), String> {
    let url = build_cookie_url(cookie.secure, &cookie.domain, &cookie.path)?;
    let mut builder = Cookie::build((cookie.name, cookie.value))
        .path(cookie.path)
        .secure(cookie.secure)
        .http_only(cookie.http_only);
    if !cookie.host_only {
        builder = builder.domain(cookie.domain);
    }
    if let Some(expiration_date) = cookie.expiration_date {
        let expiration = OffsetDateTime::from_unix_timestamp(expiration_date as i64)
            .map_err(|error| error.to_string())?;
        builder = builder.expires(expiration);
    }
    if let Some(ss) = &cookie.same_site {
        let same_site = match ss.to_lowercase().as_str() {
            "strict" => SameSite::Strict,
            "lax" => SameSite::Lax,
            _ => SameSite::None,
        };
        builder = builder.same_site(same_site);
    }
    store.store_response_cookies(std::iter::once(builder.build()), &url);
    Ok(())
}

#[tauri::command]
pub async fn set_cookie(cookie: CookieInfo, state: State<'_, AppState>) -> Result<(), String> {
    set_cookie_with_state(cookie, state.inner())
}

fn set_cookie_with_state(cookie: CookieInfo, state: &AppState) -> Result<(), String> {
    let mut store = state.cookie_store.lock().map_err(|e| e.to_string())?;
    store_cookie_info(&mut store, cookie)?;
    drop(store);
    state.persist_cookies()
}

#[cfg(test)]
fn remove_cookie_with_state(url: String, name: String, state: &AppState) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    let mut store = state.cookie_store.lock().map_err(|e| e.to_string())?;
    let to_remove = store
        .iter_any()
        .filter(|cookie| cookie.name() == name && cookie.matches(&url))
        .filter_map(|cookie| cookie_to_info(cookie).ok())
        .max_by_key(|cookie| cookie.path.len())
        .map(|cookie| (cookie.domain, cookie.path));
    if let Some((domain, path)) = to_remove {
        store.remove(domain.trim_start_matches('.'), &path, &name);
    }
    drop(store);
    state.persist_cookies()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    struct TestRequest {
        method: String,
        path: String,
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    struct TestResponse {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl TestResponse {
        fn ok(body: impl Into<Vec<u8>>) -> Self {
            Self {
                status: 200,
                headers: Vec::new(),
                body: body.into(),
            }
        }
    }

    struct TestServer {
        base_url: String,
        stop: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn spawn(handler: impl Fn(TestRequest) -> TestResponse + Send + Sync + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind local test server");
            listener
                .set_nonblocking(true)
                .expect("set test listener nonblocking");
            let address = listener.local_addr().expect("read test listener address");
            let stop = Arc::new(AtomicBool::new(false));
            let worker_stop = Arc::clone(&stop);
            let handler = Arc::new(handler);
            let worker = thread::spawn(move || {
                while !worker_stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => handle_connection(stream, &handler),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(error) => panic!("test server accept failed: {error}"),
                    }
                }
            });

            Self {
                base_url: format!("http://{address}"),
                stop,
                worker: Some(worker),
            }
        }

        fn url(&self, path: &str) -> String {
            format!("{}{path}", self.base_url)
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    fn handle_connection(
        mut stream: TcpStream,
        handler: &Arc<impl Fn(TestRequest) -> TestResponse + Send + Sync + 'static>,
    ) {
        stream
            .set_nonblocking(false)
            .expect("set accepted test stream blocking");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set test stream timeout");
        let request = read_request(&mut stream);
        let response = handler(request);
        let reason = match response.status {
            200 => "OK",
            301 => "Moved Permanently",
            302 => "Found",
            303 => "See Other",
            307 => "Temporary Redirect",
            308 => "Permanent Redirect",
            _ => "Test Response",
        };
        write!(stream, "HTTP/1.1 {} {reason}\r\n", response.status).expect("write status");
        for (name, value) in response.headers {
            write!(stream, "{name}: {value}\r\n").expect("write response header");
        }
        write!(
            stream,
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            response.body.len()
        )
        .expect("write response framing");
        stream
            .write_all(&response.body)
            .expect("write response body");
        let _ = stream.shutdown(Shutdown::Both);
    }

    fn read_request(stream: &mut TcpStream) -> TestRequest {
        let mut bytes = Vec::new();
        let header_end = loop {
            let mut chunk = [0_u8; 4096];
            let read = stream.read(&mut chunk).expect("read test request");
            assert!(read > 0, "client closed before request headers");
            bytes.extend_from_slice(&chunk[..read]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().expect("valid content length"))
            })
            .unwrap_or(0);
        while bytes.len() < header_end + content_length {
            let mut chunk = [0_u8; 4096];
            let read = stream.read(&mut chunk).expect("read test request body");
            assert!(read > 0, "client closed before request body");
            bytes.extend_from_slice(&chunk[..read]);
        }
        let request_line = headers.lines().next().expect("request line");
        let mut request_parts = request_line.split_whitespace();
        let parsed_headers = headers
            .lines()
            .skip(1)
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
            })
            .collect();

        TestRequest {
            method: request_parts.next().expect("request method").to_string(),
            path: request_parts.next().expect("request path").to_string(),
            headers: parsed_headers,
            body: bytes[header_end..header_end + content_length].to_vec(),
        }
    }

    fn fetch_request(url: String) -> FetchRequest {
        FetchRequest {
            request_id: None,
            site_id: "test".to_string(),
            url,
            method: None,
            headers: None,
            body: FetchBody::None,
            params: None,
            timeout: Some(2_000),
            max_retries: Some(0),
            binary: Some(false),
        }
    }

    #[test]
    fn redacts_sensitive_url_components() {
        assert_eq!(
            redacted_url("https://user:pass@tracker.example/path?token=secret#fragment"),
            "https://tracker.example/path"
        );
    }

    #[tokio::test]
    async fn preserves_binary_request_and_response_bytes() {
        let server = TestServer::spawn(|request| TestResponse::ok(request.body));
        let original = b"d4:infod4:name12:sample.txte\x00\xffe";
        let mut request = fetch_request(server.url("/echo"));
        request.method = Some("POST".to_string());
        request.body = FetchBody::Base64(STANDARD.encode(original));
        request.binary = Some(true);

        let response = ptd_fetch_with_state(request, &AppState::new())
            .await
            .expect("binary echo request");

        let returned = STANDARD.decode(response.body).expect("response base64");
        assert_eq!(returned, original);
        assert_eq!(Sha256::digest(&returned), Sha256::digest(original));
    }

    #[tokio::test]
    async fn stores_repeated_set_cookie_headers_with_path_scope() {
        let server = TestServer::spawn(|_| TestResponse {
            status: 200,
            headers: vec![
                ("Set-Cookie".to_string(), "root=one; Path=/".to_string()),
                ("Set-Cookie".to_string(), "deep=two; Path=/deep".to_string()),
            ],
            body: Vec::new(),
        });
        let state = AppState::new();

        ptd_fetch_with_state(fetch_request(server.url("/cookies")), &state)
            .await
            .expect("cookie response");

        let store = state.cookie_store.lock().expect("cookie store lock");
        let root_url = Url::parse(&server.url("/")).expect("root URL");
        let deep_url = Url::parse(&server.url("/deep/page")).expect("deep URL");
        let root_names: Vec<_> = store
            .get_request_values(&root_url)
            .map(|(name, _)| name)
            .collect();
        let deep_names: Vec<_> = store
            .get_request_values(&deep_url)
            .map(|(name, _)| name)
            .collect();
        assert_eq!(root_names, ["root"]);
        assert!(deep_names.contains(&"root"));
        assert!(deep_names.contains(&"deep"));
    }

    #[tokio::test]
    async fn follows_axios_compatible_redirect_method_rules() {
        let server = TestServer::spawn(|request| {
            if let Some(code) = request.path.strip_prefix("/redirect/") {
                return TestResponse {
                    status: code.parse().expect("redirect status"),
                    headers: vec![("Location".to_string(), "/target".to_string())],
                    body: Vec::new(),
                };
            }
            TestResponse::ok(format!(
                "{}:{}",
                request.method,
                String::from_utf8_lossy(&request.body)
            ))
        });

        for (status, expected) in [
            (301, "GET:"),
            (302, "GET:"),
            (303, "GET:"),
            (307, "POST:payload"),
            (308, "POST:payload"),
        ] {
            let mut request = fetch_request(server.url(&format!("/redirect/{status}")));
            request.method = Some("POST".to_string());
            request.body = FetchBody::Text("payload".to_string());
            let response = ptd_fetch_with_state(request, &AppState::new())
                .await
                .expect("redirect request");
            assert_eq!(response.body, expected, "unexpected semantics for {status}");
            assert_eq!(response.final_url, server.url("/target"));
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn curl_follows_axios_compatible_redirect_method_rules() {
        let server = TestServer::spawn(|request| {
            if let Some(code) = request.path.strip_prefix("/curl-redirect/") {
                return TestResponse {
                    status: code.parse().expect("redirect status"),
                    headers: vec![("Location".to_string(), "/curl-target".to_string())],
                    body: Vec::new(),
                };
            }
            TestResponse::ok(format!(
                "{}:{}",
                request.method,
                String::from_utf8_lossy(&request.body)
            ))
        });

        for (status, expected) in [
            (301, "GET:"),
            (302, "GET:"),
            (303, "GET:"),
            (307, "POST:payload"),
            (308, "POST:payload"),
        ] {
            let mut request = fetch_request(server.url(&format!("/curl-redirect/{status}")));
            request.method = Some("POST".to_string());
            request.body = FetchBody::Text("payload".to_string());
            let response = send_with_curl(
                &request,
                &Method::POST,
                Duration::from_secs(2),
                &AppState::new(),
            )
            .await
            .expect("curl redirect request");
            assert_eq!(
                String::from_utf8_lossy(&response.body),
                expected,
                "unexpected curl semantics for {status}"
            );
            assert_eq!(response.final_url, server.url("/curl-target"));
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn curl_preserves_redirect_cookies_and_server_deletions() {
        let server = TestServer::spawn(|request| match request.path.as_str() {
            "/redirect" => TestResponse {
                status: 302,
                headers: vec![
                    ("Location".to_string(), "/target".to_string()),
                    (
                        "Set-Cookie".to_string(),
                        "hop=redirect; Path=/; HttpOnly; SameSite=Strict".to_string(),
                    ),
                ],
                body: Vec::new(),
            },
            "/target" => {
                TestResponse::ok(request.headers.get("cookie").cloned().unwrap_or_default())
            }
            "/delete" => TestResponse {
                status: 200,
                headers: vec![(
                    "Set-Cookie".to_string(),
                    "hop=; Max-Age=0; Path=/".to_string(),
                )],
                body: Vec::new(),
            },
            _ => TestResponse::ok(Vec::new()),
        });
        let state = AppState::new();

        let response = send_with_curl(
            &fetch_request(server.url("/redirect")),
            &Method::GET,
            Duration::from_secs(2),
            &state,
        )
        .await
        .expect("curl redirect request");
        assert_eq!(response.final_url, server.url("/target"));
        assert!(String::from_utf8_lossy(&response.body).contains("hop=redirect"));
        {
            let store = state.cookie_store.lock().expect("cookie store lock");
            let cookie = store
                .iter_any()
                .find(|cookie| cookie.name() == "hop")
                .expect("redirect cookie");
            assert_eq!(cookie.same_site(), Some(SameSite::Strict));
        }

        send_with_curl(
            &fetch_request(server.url("/delete")),
            &Method::GET,
            Duration::from_secs(2),
            &state,
        )
        .await
        .expect("curl delete request");
        assert!(state
            .cookie_store
            .lock()
            .expect("cookie store lock")
            .iter_any()
            .all(|cookie| cookie.name() != "hop"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn curl_process_timeout_kills_child() {
        let directory = tempfile::tempdir().expect("temporary process directory");
        let pid_file = directory.path().join("child.pid");
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("echo $$ > \"$1\"; exec /bin/sleep 30")
            .arg("curl-timeout-test")
            .arg(&pid_file);

        let error = command_output_with_limited_stderr(&mut command, Duration::from_millis(250))
            .await
            .expect_err("long-running command must time out");
        assert_eq!(error, "curl 子进程超时");

        let pid: i32 = std::fs::read_to_string(pid_file)
            .expect("child PID file")
            .trim()
            .parse()
            .expect("child PID");
        for _ in 0..20 {
            if unsafe { libc::kill(pid, 0) } == -1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "timed-out child still exists"
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn limits_curl_stderr_capture() {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("i=0; while [ \"$i\" -lt 5000 ]; do printf x >&2; i=$((i + 1)); done; exit 7");

        let (output, stderr) =
            command_output_with_limited_stderr(&mut command, Duration::from_secs(2))
                .await
                .expect("capture command output");

        assert!(!output.status.success());
        assert_eq!(stderr.len(), CURL_STDERR_MAX_BYTES as usize);
        assert!(stderr.bytes().all(|byte| byte == b'x'));
    }

    #[test]
    fn persists_cookie_scope_attributes_and_deletions() {
        let directory = tempfile::tempdir().expect("temporary cookie directory");
        let cookie_file = directory.path().join("cookies.enc");
        let key = [23_u8; 32];
        let state = AppState::persistent_for_test(cookie_file.clone(), key);
        let cookie = |name: &str, path: &str, value: &str, host_only: bool| CookieInfo {
            name: name.to_string(),
            value: value.to_string(),
            domain: if host_only {
                "tracker.example".to_string()
            } else {
                ".tracker.example".to_string()
            },
            host_only,
            path: path.to_string(),
            secure: true,
            http_only: true,
            expiration_date: Some(4_102_444_800.0),
            same_site: Some("lax".to_string()),
        };
        set_cookie_with_state(cookie("session", "/", "root", true), &state)
            .expect("set root cookie");
        set_cookie_with_state(cookie("session", "/account", "account", true), &state)
            .expect("set path cookie");
        set_cookie_with_state(cookie("shared", "/", "domain", false), &state)
            .expect("set domain cookie");

        let restored = AppState::persistent_for_test(cookie_file.clone(), key);
        let root = Url::parse("https://tracker.example/").expect("root URL");
        let account = Url::parse("https://tracker.example/account/profile").expect("account URL");
        let subdomain = Url::parse("https://sub.tracker.example/").expect("subdomain URL");
        let store = restored.cookie_store.lock().expect("cookie store lock");
        let root_values: Vec<_> = store
            .get_request_values(&root)
            .map(|(_, value)| value)
            .collect();
        let account_values: Vec<_> = store
            .get_request_values(&account)
            .map(|(_, value)| value)
            .collect();
        let subdomain_values: Vec<_> = store
            .get_request_values(&subdomain)
            .map(|(_, value)| value)
            .collect();
        assert!(root_values.contains(&"root"));
        assert!(root_values.contains(&"domain"));
        assert!(account_values.contains(&"root"));
        assert!(account_values.contains(&"account"));
        assert_eq!(subdomain_values, ["domain"]);
        drop(store);

        let account_cookie =
            get_cookie_with_state(account.to_string(), "session".to_string(), &restored)
                .expect("get account cookie")
                .expect("matching account cookie");
        let root_cookie = get_cookie_with_state(root.to_string(), "session".to_string(), &restored)
            .expect("get root cookie")
            .expect("matching root cookie");
        assert_eq!(account_cookie.path, "/account");
        assert_eq!(account_cookie.value, "account");
        assert_eq!(root_cookie.path, "/");
        assert_eq!(root_cookie.value, "root");

        remove_cookie_with_state(
            "https://tracker.example/account/profile".to_string(),
            "session".to_string(),
            &restored,
        )
        .expect("remove longest path cookie");
        let after_delete = AppState::persistent_for_test(cookie_file, key);
        let after_delete_store = after_delete.cookie_store.lock().expect("cookie store lock");
        let remaining: Vec<_> = after_delete_store
            .get_request_values(&account)
            .map(|(_, value)| value)
            .collect();
        assert!(!remaining.contains(&"account"));
        assert!(remaining.contains(&"root"));
    }

    #[tokio::test]
    async fn enforces_request_timeout() {
        let server = TestServer::spawn(|_| {
            thread::sleep(Duration::from_millis(100));
            TestResponse::ok("late")
        });
        let mut request = fetch_request(server.url("/slow"));
        request.timeout = Some(20);
        let started = Instant::now();

        let error = ptd_fetch_with_state(request, &AppState::new())
            .await
            .expect_err("slow request must time out");

        assert!(
            error.contains("请求超时"),
            "unexpected timeout error: {error}"
        );
        assert!(started.elapsed() < Duration::from_millis(90));
    }

    #[tokio::test]
    async fn cancels_active_request() {
        let state = AppState::new();
        let request = with_request_cancellation(
            Some("active-request"),
            &state,
            std::future::pending::<Result<(), String>>(),
        );
        let cancel = async {
            tokio::task::yield_now().await;
            state
                .cancel_http_request("active-request")
                .expect("cancel active request");
        };

        let (result, ()) = tokio::join!(request, cancel);

        assert_eq!(result, Err("请求已取消".to_string()));
    }

    #[tokio::test]
    async fn honors_cancellation_that_arrives_before_registration() {
        let state = AppState::new();
        state
            .cancel_http_request("early-request")
            .expect("record early cancellation");

        let result = with_request_cancellation(
            Some("early-request"),
            &state,
            std::future::pending::<Result<(), String>>(),
        )
        .await;

        assert_eq!(result, Err("请求已取消".to_string()));
    }

    #[test]
    fn imports_only_target_webview_cookies_with_security_attributes() {
        let state = AppState::new();
        let target = Cookie::build(("session", "secret"))
            .domain(".tracker.example")
            .path("/account")
            .secure(true)
            .http_only(true)
            .same_site(SameSite::Lax)
            .build()
            .into_owned();
        let unrelated = Cookie::build(("other", "leak"))
            .domain("unrelated.example")
            .path("/")
            .build()
            .into_owned();

        let count = import_webview_cookies(vec![target, unrelated], "tracker.example", &state)
            .expect("import webview cookies");

        assert_eq!(count, 1);
        let cookie = get_cookie_with_state(
            "https://tracker.example/account/profile".to_string(),
            "session".to_string(),
            &state,
        )
        .expect("read imported cookie")
        .expect("target cookie");
        assert_eq!(cookie.value, "secret");
        assert_eq!(cookie.path, "/account");
        assert!(cookie.secure);
        assert!(cookie.http_only);
        assert_eq!(cookie.same_site.as_deref(), Some("lax"));
    }

    #[tokio::test]
    async fn does_not_retry_cloudflare_response_for_post() {
        let request_count = Arc::new(AtomicUsize::new(0));
        let handler_count = Arc::clone(&request_count);
        let server = TestServer::spawn(move |_| {
            handler_count.fetch_add(1, Ordering::SeqCst);
            TestResponse {
                status: 403,
                headers: vec![("Server".to_string(), "cloudflare".to_string())],
                body: b"Enable JavaScript and cookies to continue".to_vec(),
            }
        });
        let mut request = fetch_request(server.url("/submit"));
        request.method = Some("POST".to_string());
        request.body = FetchBody::Text("non-idempotent".to_string());
        request.max_retries = Some(3);

        let response = ptd_fetch_with_state(request, &AppState::new())
            .await
            .expect("Cloudflare response");

        assert_eq!(response.status, 403);
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn lowercase_get_uses_cloudflare_curl_fallback() {
        let request_count = Arc::new(AtomicUsize::new(0));
        let handler_count = Arc::clone(&request_count);
        let server = TestServer::spawn(move |_| {
            handler_count.fetch_add(1, Ordering::SeqCst);
            TestResponse {
                status: 400,
                headers: vec![("Server".to_string(), "cloudflare".to_string())],
                body: b"temporary".to_vec(),
            }
        });
        let mut request = fetch_request(server.url("/lowercase-get"));
        request.method = Some("get".to_string());

        let response = ptd_fetch_with_state(request, &AppState::new())
            .await
            .expect("Cloudflare fallback response");

        assert_eq!(response.status, 400);
        assert_eq!(request_count.load(Ordering::SeqCst), 2);
    }
}
