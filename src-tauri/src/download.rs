use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;

/// 本地文件下载写盘。保存路径由前端通过 @tauri-apps/plugin-dialog 的 save() 选好后传入，
/// Rust 仅负责带自定义头下载字节并写盘。替代原 chrome.downloads.download。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    pub headers: Option<HashMap<String, String>>,
    /// 前端选好的完整保存路径
    pub save_path: String,
    pub timeout: Option<u64>,
}

#[tauri::command]
pub async fn download_to_local(req: DownloadRequest) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(req.timeout.unwrap_or(30_000)))
        .build()
        .map_err(|e| e.to_string())?;
    let mut builder = client.get(&req.url);
    if let Some(h) = &req.headers {
        for (k, v) in h {
            builder = builder.header(k, v);
        }
    }
    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    std::fs::write(&req.save_path, &bytes).map_err(|e| e.to_string())?;
    Ok(req.save_path)
}
