use std::sync::Mutex;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};

const SERVICE_NAME: &str = "com.ptplugins.pt-depiler";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRef {
    category: String,
    entity_id: String,
    field: String,
}

impl SecretRef {
    fn account_name(&self) -> Result<String, String> {
        for value in [&self.category, &self.entity_id, &self.field] {
            if value.is_empty()
                || value.len() > 128
                || !value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
                })
            {
                return Err("Secret 引用格式无效".to_string());
            }
        }
        Ok(format!(
            "{}/{}/{}",
            self.category, self.entity_id, self.field
        ))
    }

    fn entry(&self) -> Result<Entry, String> {
        Entry::new(SERVICE_NAME, &self.account_name()?).map_err(|_| unavailable_error())
    }
}

#[derive(Default)]
pub struct SecretStore {
    cleanup_queue: Mutex<Vec<SecretRef>>,
}

fn unavailable_error() -> String {
    "系统凭据存储不可用；凭据不会回退保存为明文".to_string()
}

fn queue_cleanup(store: &SecretStore, secret_ref: SecretRef) {
    if let Ok(mut queue) = store.cleanup_queue.lock() {
        if !queue.iter().any(|item| {
            item.category == secret_ref.category
                && item.entity_id == secret_ref.entity_id
                && item.field == secret_ref.field
        }) {
            queue.push(secret_ref);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStoreStatus {
    available: bool,
    pending_cleanup: usize,
}

#[tauri::command]
pub fn secret_store_status(store: State<'_, SecretStore>) -> SecretStoreStatus {
    // Constructing an entry is the only portable, non-mutating capability probe.
    let available = Entry::new(SERVICE_NAME, "probe").is_ok();
    let pending_cleanup = store
        .cleanup_queue
        .lock()
        .map(|queue| queue.len())
        .unwrap_or(0);
    SecretStoreStatus {
        available,
        pending_cleanup,
    }
}

fn ensure_business_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "site-login" {
        Err("登录窗口无权调用凭据命令".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn secret_is_configured(secret_ref: SecretRef, window: WebviewWindow) -> Result<bool, String> {
    ensure_business_window(&window)?;
    match secret_ref.entry()?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err(unavailable_error()),
    }
}

#[tauri::command]
pub fn secret_set(
    secret_ref: SecretRef,
    value: String,
    window: WebviewWindow,
) -> Result<(), String> {
    ensure_business_window(&window)?;
    if value.is_empty() {
        return Err("Secret 值不能为空".to_string());
    }
    secret_ref
        .entry()?
        .set_password(&value)
        .map_err(|_| unavailable_error())
}

#[tauri::command]
pub fn secret_remove(
    secret_ref: SecretRef,
    store: State<'_, SecretStore>,
    window: WebviewWindow,
) -> Result<bool, String> {
    ensure_business_window(&window)?;
    match secret_ref.entry()?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => {
            queue_cleanup(&store, secret_ref);
            Err(unavailable_error())
        }
    }
}

#[tauri::command]
pub fn retry_secret_cleanup(store: State<'_, SecretStore>) -> Result<usize, String> {
    let queued = {
        let mut queue = store
            .cleanup_queue
            .lock()
            .map_err(|_| unavailable_error())?;
        std::mem::take(&mut *queue)
    };
    let mut remaining = Vec::new();
    let queued_count = queued.len();
    for secret_ref in queued {
        if secret_ref
            .entry()
            .and_then(|entry| entry.delete_credential().map_err(|_| unavailable_error()))
            .is_err()
        {
            remaining.push(secret_ref);
        }
    }
    let cleaned = queued_count.saturating_sub(remaining.len());
    if !remaining.is_empty() {
        let mut queue = store
            .cleanup_queue
            .lock()
            .map_err(|_| unavailable_error())?;
        queue.extend(remaining);
    }
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::SecretRef;

    #[test]
    fn key_uses_category_entity_and_field_without_secret_value() {
        let reference = SecretRef {
            category: "downloader".to_string(),
            entity_id: "qbit-1".to_string(),
            field: "password".to_string(),
        };
        assert_eq!(
            reference.account_name().unwrap(),
            "downloader/qbit-1/password"
        );
    }

    #[test]
    fn rejects_path_injection_in_secret_reference() {
        let reference = SecretRef {
            category: "downloader".to_string(),
            entity_id: "../other".to_string(),
            field: "password".to_string(),
        };
        assert!(reference.account_name().is_err());
    }
}
