use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// 系统通知，替代原 chrome.notifications。
#[tauri::command]
pub async fn show_notification(title: String, body: String, app: AppHandle) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())?;
    Ok(())
}
