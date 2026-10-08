use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use reqwest::{redirect::Policy, Method};
use serde::Deserialize;
use tauri::{AppHandle, State, WebviewWindow};
use tempfile::NamedTempFile;
use ts_rs::TS;
use url::Url;

use crate::{
    error::AppErrorDto,
    http_policy::{resolve_connection, HttpPolicy},
};

const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadRequest {
    pub url: String,
    pub headers: Option<HashMap<String, String>>,
    pub save_path: String,
    #[ts(optional, type = "number")]
    pub timeout: Option<u64>,
}

async fn stream_to_file(mut response: reqwest::Response, destination: &Path) -> Result<(), String> {
    if !response.status().is_success() {
        return Err("FILE_DOWNLOAD_HTTP_FAILURE".to_string());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_FILE_BYTES)
    {
        return Err("FILE_DOWNLOAD_TOO_LARGE".to_string());
    }
    let parent = destination.parent().ok_or("FILE_DOWNLOAD_INVALID_PATH")?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|_| "FILE_DOWNLOAD_WRITE_FAILED")?;
    let mut total = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "FILE_DOWNLOAD_TRANSPORT_FAILED")?
    {
        total = total.saturating_add(chunk.len() as u64);
        if total > MAX_FILE_BYTES {
            return Err("FILE_DOWNLOAD_TOO_LARGE".to_string());
        }
        temporary
            .write_all(&chunk)
            .map_err(|_| "FILE_DOWNLOAD_WRITE_FAILED")?;
    }
    temporary
        .flush()
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "FILE_DOWNLOAD_WRITE_FAILED")?;
    temporary
        .persist(destination)
        .map_err(|_| "FILE_DOWNLOAD_WRITE_FAILED")?;
    Ok(())
}

async fn download_with_authorization<F>(
    req: &DownloadRequest,
    mut authorize: F,
) -> Result<(), String>
where
    F: FnMut(&str) -> Result<bool, String>,
{
    let first = Url::parse(&req.url).map_err(|_| "HTTP_POLICY_REJECTED:invalid_url")?;
    let mut current = first.clone();
    for hop in 0..=10 {
        let require_public = authorize(current.as_str())?;
        let addresses = resolve_connection(current.as_str(), require_public).await?;
        let host = current
            .host_str()
            .ok_or("HTTP_POLICY_REJECTED:invalid_url")?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .resolve_to_addrs(host, &addresses)
            .timeout(Duration::from_millis(
                req.timeout.filter(|value| *value > 0).unwrap_or(30_000),
            ))
            .build()
            .map_err(|_| "FILE_DOWNLOAD_TRANSPORT_FAILED")?;
        let mut builder = client.get(current.clone());
        if let Some(headers) = &req.headers {
            for (key, value) in headers {
                builder = builder.header(key, value);
            }
        }
        let response = builder
            .send()
            .await
            .map_err(|_| "FILE_DOWNLOAD_TRANSPORT_FAILED")?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            let Some(location) = response.headers().get(reqwest::header::LOCATION) else {
                return Err("FILE_DOWNLOAD_HTTP_FAILURE".to_string());
            };
            if hop == 10 {
                return Err("HTTP_POLICY_REJECTED:redirect_limit".to_string());
            }
            let next = current
                .join(
                    location
                        .to_str()
                        .map_err(|_| "HTTP_POLICY_REJECTED:invalid_redirect")?,
                )
                .map_err(|_| "HTTP_POLICY_REJECTED:invalid_redirect")?;
            if next.origin() != first.origin() {
                return Err("HTTP_POLICY_REJECTED:cross_origin_redirect".to_string());
            }
            current = next;
            continue;
        }
        return stream_to_file(response, Path::new(&req.save_path)).await;
    }
    Err("HTTP_POLICY_REJECTED:redirect_limit".to_string())
}

#[tauri::command]
pub async fn download_to_local(
    req: DownloadRequest,
    app: AppHandle,
    window: WebviewWindow,
    policy: State<'_, HttpPolicy>,
) -> Result<String, AppErrorDto> {
    download_to_local_inner(req, app, window, policy)
        .await
        .map_err(|error| AppErrorDto::ipc(&error, "download_to_local".to_string(), None))
}

async fn download_to_local_inner(
    req: DownloadRequest,
    app: AppHandle,
    window: WebviewWindow,
    policy: State<'_, HttpPolicy>,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("FILE_DOWNLOAD_WINDOW_REJECTED".to_string());
    }
    download_with_authorization(&req, |url| {
        let metadata = crate::storage::read_key(&app, "metadata")
            .map_err(|_| "FILE_DOWNLOAD_STORAGE_UNAVAILABLE")?;
        policy.validate(&metadata, "site:legacy", &Method::GET, url)?;
        Ok(true)
    })
    .await?;
    Ok(req.save_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    fn serve(header: &'static str, body: &'static [u8]) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(body);
        });
        format!("http://{address}/file")
    }

    #[tokio::test]
    async fn ap_05_streams_complete_file_and_preserves_old_file_on_limit_failure() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("download.torrent");
        std::fs::write(&target, b"old").unwrap();

        let url = serve("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n", b"new!");
        let response = reqwest::Client::new().get(url).send().await.unwrap();
        stream_to_file(response, &target).await.unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new!");

        let url = serve("HTTP/1.1 200 OK\r\nContent-Length: 536870913\r\n\r\n", b"");
        let response = reqwest::Client::new().get(url).send().await.unwrap();
        assert_eq!(
            stream_to_file(response, &target).await.unwrap_err(),
            "FILE_DOWNLOAD_TOO_LARGE"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"new!");
    }

    #[tokio::test]
    async fn ap_05_rechecks_authorization_before_following_file_redirect() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("download.torrent");
        std::fs::write(&target, b"old").unwrap();
        let url = serve(
            "HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n",
            b"",
        );
        let req = DownloadRequest {
            url,
            headers: None,
            save_path: target.to_string_lossy().into_owned(),
            timeout: None,
        };
        let mut checks = 0;
        let error = download_with_authorization(&req, |_| {
            checks += 1;
            if checks == 2 {
                Err("HTTP_POLICY_REJECTED:resource_not_configured".to_string())
            } else {
                Ok(false)
            }
        })
        .await
        .unwrap_err();
        assert_eq!(error, "HTTP_POLICY_REJECTED:resource_not_configured");
        assert_eq!(checks, 2);
        assert_eq!(std::fs::read(target).unwrap(), b"old");
    }
}
