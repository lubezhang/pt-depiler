use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// 持久化存储，对齐原扩展 chrome.storage.local 的 5 个 key：
/// config / metadata / userInfo / searchResultSnapshot / keepUploadTask
const STORE_FILE: &str = "storage.json";

#[tauri::command]
pub async fn get_ext_storage(key: String, app: AppHandle) -> Result<Value, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    Ok(store.get(&key).unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn set_ext_storage(key: String, value: Value, app: AppHandle) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(&key, value);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}
