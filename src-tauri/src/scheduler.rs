use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// 启动周期性定时任务，通过 event 通知前端执行业务逻辑。
/// 替代原扩展 @webext-core/job-scheduler 的 FlushUserInfo（10min）/ AutoBackup（10min 检查）。
pub fn start_scheduler(app: AppHandle) {
    // FlushUserInfo：首次延迟 60s，之后每 10min 通知前端刷新各站点用户信息
    let app1 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            let _ = app1.emit("scheduler://flush-user-info", ());
            tokio::time::sleep(Duration::from_secs(600)).await;
        }
    });

    // AutoBackup：首次延迟 120s，之后每 10min 通知前端检查备份周期
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(120)).await;
        loop {
            let _ = app2.emit("scheduler://auto-backup", ());
            tokio::time::sleep(Duration::from_secs(600)).await;
        }
    });
}

/// 一次性延迟重试种子下载，替代原 alarms ReDownloadTorrent（30s 后重试）。
#[tauri::command]
pub async fn schedule_redownload(
    download_id: String,
    delay_secs: u64,
    app: AppHandle,
) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(delay_secs)).await;
        let _ = app.emit("scheduler://redownload", &download_id);
    });
    Ok(())
}
