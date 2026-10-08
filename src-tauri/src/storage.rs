use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::{error::AppErrorDto, state::AppState};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tempfile::NamedTempFile;

const STORE_FILE: &str = "storage.json";
static STORAGE_LOCK: Mutex<()> = Mutex::new(());

fn ensure_storage_window(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if window.label() == "stage-a-peer" && crate::stage_a_acceptance::enabled() {
        return Ok(());
    }
    crate::http::ensure_business_window(window)
}

fn valid_key(key: &str) -> bool {
    matches!(
        key,
        "config" | "metadata" | "userInfo" | "searchResultSnapshot" | "keepUploadTask"
    )
}

fn root_key(key: &str) -> bool {
    matches!(key, "config" | "metadata")
}

fn storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(directory) = std::env::var_os("PTD_E2E_DATA_DIR") {
        let path = PathBuf::from(directory);
        if !path.is_absolute() {
            return Err("STORAGE_INVALID_DATA_DIR:storage_path".to_string());
        }
        return Ok(path.join(STORE_FILE));
    }
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(STORE_FILE))
        .map_err(|_| "STORAGE_UNAVAILABLE:storage_path".to_string())
}

fn read_document(path: &Path) -> Result<Map<String, Value>, String> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(_) => return Err("STORAGE_UNAVAILABLE:read".to_string()),
    };
    let value: Value =
        serde_json::from_slice(&contents).map_err(|_| "STORAGE_CORRUPT:read".to_string())?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "STORAGE_CORRUPT:read".to_string())
}

fn write_document(path: &Path, document: &Map<String, Value>) -> Result<(), String> {
    let parent = path.parent().ok_or("STORAGE_UNAVAILABLE:write")?;
    fs::create_dir_all(parent).map_err(|_| "STORAGE_UNAVAILABLE:write".to_string())?;
    let mut temporary =
        NamedTempFile::new_in(parent).map_err(|_| "STORAGE_UNAVAILABLE:write".to_string())?;
    serde_json::to_writer(&mut temporary, document)
        .map_err(|_| "STORAGE_UNAVAILABLE:write".to_string())?;
    temporary
        .flush()
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "STORAGE_UNAVAILABLE:write".to_string())?;
    temporary
        .persist(path)
        .map_err(|_| "STORAGE_UNAVAILABLE:replace".to_string())?;
    sync_directory(parent)?;
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "STORAGE_UNAVAILABLE:sync".to_string())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn merge_value(
    base: Option<&Value>,
    proposed: Option<&Value>,
    current: Option<&Value>,
) -> Result<Option<Value>, String> {
    if base == proposed {
        return Ok(current.cloned());
    }
    if base == current {
        return Ok(proposed.cloned());
    }
    if proposed == current {
        return Ok(current.cloned());
    }
    if let (
        Some(Value::Object(base)),
        Some(Value::Object(proposed)),
        Some(Value::Object(current)),
    ) = (base, proposed, current)
    {
        let mut merged = current.clone();
        for key in base.keys().chain(proposed.keys()) {
            if merged.contains_key(key) && base.get(key) == proposed.get(key) {
                continue;
            }
            match merge_value(base.get(key), proposed.get(key), current.get(key))? {
                Some(value) => {
                    merged.insert(key.clone(), value);
                }
                None => {
                    merged.remove(key);
                }
            }
        }
        return Ok(Some(Value::Object(merged)));
    }
    Err("STORAGE_CONFLICT:merge_ext_storage".to_string())
}

#[cfg(test)]
fn merge_document(path: &Path, key: &str, base: &Value, value: &Value) -> Result<Value, String> {
    let mut document = read_document(path)?;
    let base = if base.is_null() { None } else { Some(base) };
    let merged = merge_value(base, Some(value), document.get(key))?
        .ok_or("STORAGE_INVALID_INPUT:merge_ext_storage")?;
    document.insert(key.to_string(), merged.clone());
    write_document(path, &document)?;
    Ok(merged)
}

pub fn read_key(app: &AppHandle, key: &str) -> Result<Value, String> {
    if !valid_key(key) {
        return Err("STORAGE_INVALID_KEY:get_ext_storage".to_string());
    }
    let _guard = STORAGE_LOCK
        .lock()
        .map_err(|_| "STORAGE_UNAVAILABLE:lock".to_string())?;
    Ok(read_document(&storage_path(app)?)?
        .remove(key)
        .unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn get_ext_storage(
    key: String,
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Value, AppErrorDto> {
    ensure_storage_window(&window)
        .and_then(|_| read_key(&app, &key))
        .map_err(|error| AppErrorDto::command(&error, "get_ext_storage"))
}

fn merged_batch(
    document: &Map<String, Value>,
    base: &Map<String, Value>,
    proposed: &Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    if proposed.is_empty()
        || base.len() != proposed.len()
        || proposed
            .keys()
            .any(|key| !valid_key(key) || !base.contains_key(key))
    {
        return Err("STORAGE_INVALID_INPUT:merge_ext_storage_batch".to_string());
    }
    let mut merged = document.clone();
    for (key, value) in proposed {
        let baseline = base.get(key).filter(|value| !value.is_null());
        let value = merge_value(baseline, Some(value), document.get(key))?
            .ok_or("STORAGE_INVALID_INPUT:merge_ext_storage_batch")?;
        merged.insert(key.clone(), value);
    }
    Ok(merged)
}

pub(crate) fn site_hosts(metadata: Option<&Value>) -> Vec<String> {
    let Some(metadata) = metadata else {
        return Vec::new();
    };
    let mut hosts: Vec<String> = metadata
        .get("siteHostMap")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|map| map.iter())
        .filter(|(_, id)| {
            id.as_str().is_some_and(|id| {
                metadata
                    .get("sites")
                    .and_then(|sites| sites.get(id))
                    .is_some()
            })
        })
        .map(|(host, _)| host.clone())
        .collect();
    hosts.extend(
        metadata
            .get("sites")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|sites| sites.values())
            .filter_map(|site| {
                site.get("url")
                    .and_then(Value::as_str)
                    .and_then(|url| url::Url::parse(url).ok())
                    .and_then(|url| url.host_str().map(str::to_string))
            }),
    );
    hosts
}

fn commit_document(
    path: &Path,
    previous: &Map<String, Value>,
    next: &Map<String, Value>,
    state: &AppState,
) -> Result<(), String> {
    state.commit_with_cookie_cleanup(
        &site_hosts(previous.get("metadata")),
        &site_hosts(next.get("metadata")),
        || write_document(path, next),
    )
}

#[tauri::command]
pub async fn merge_ext_storage_batch(
    base: Value,
    value: Value,
    app: AppHandle,
    state: State<'_, AppState>,
    window: WebviewWindow,
) -> Result<Value, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        let _guard = STORAGE_LOCK
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?;
        let path = storage_path(&app)?;
        let document = read_document(&path)?;
        let base = base.as_object().ok_or("STORAGE_INVALID_INPUT:base")?;
        let value = value.as_object().ok_or("STORAGE_INVALID_INPUT:value")?;
        let merged = merged_batch(&document, base, value)?;
        commit_document(&path, &document, &merged, state.inner())?;
        Ok(Value::Object(
            value
                .keys()
                .map(|key| (key.clone(), merged[key].clone()))
                .collect(),
        ))
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "merge_ext_storage_batch"))
}

#[tauri::command]
pub async fn set_ext_storage(
    key: String,
    value: Value,
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        if !valid_key(&key) || root_key(&key) {
            return Err("STORAGE_CONDITIONAL_WRITE_REQUIRED:set_ext_storage".to_string());
        }
        let _guard = STORAGE_LOCK
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock".to_string())?;
        let path = storage_path(&app)?;
        let mut document = read_document(&path)?;
        document.insert(key, value);
        write_document(&path, &document)
    })();
    result.map_err(|error| AppErrorDto::command(&error, "set_ext_storage"))
}

#[tauri::command]
pub async fn merge_ext_storage(
    key: String,
    base: Value,
    value: Value,
    app: AppHandle,
    state: State<'_, AppState>,
    window: WebviewWindow,
) -> Result<Value, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        if !root_key(&key) {
            return Err("STORAGE_INVALID_KEY:merge_ext_storage".to_string());
        }
        let _guard = STORAGE_LOCK
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock".to_string())?;
        let path = storage_path(&app)?;
        let document = read_document(&path)?;
        let merged = merged_batch(
            &document,
            &Map::from_iter([(key.clone(), base)]),
            &Map::from_iter([(key.clone(), value)]),
        )?;
        commit_document(&path, &document, &merged, state.inner())?;
        Ok(merged[&key].clone())
    })();
    result.map_err(|error| AppErrorDto::command(&error, "merge_ext_storage"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ap_02_batch_conflict_never_commits_a_partial_restore() {
        let document = json!({"config": {"theme":"remote"}, "metadata": {"sites":{}}});
        let base = json!({"config": {"theme":"light"}, "metadata": {"sites":{}}});
        let value = json!({"config": {"theme":"dark"}, "metadata": {"sites":{"alpha":{"password":"SENSITIVE_SENTINEL"}}}});
        let error = merged_batch(
            document.as_object().unwrap(),
            base.as_object().unwrap(),
            value.as_object().unwrap(),
        )
        .unwrap_err();
        assert!(error.starts_with("STORAGE_CONFLICT"));
        assert_eq!(document["metadata"]["sites"], json!({}));
        let result = merged_batch(
            document.as_object().unwrap(),
            document.as_object().unwrap(),
            value.as_object().unwrap(),
        )
        .unwrap();
        assert_eq!(result["config"]["theme"], "dark");
        assert!(result["metadata"]["sites"].get("alpha").is_some());
    }

    #[test]
    fn ap_04_deletion_removes_config_and_owned_cookies_and_preserves_shared_scope() {
        let directory = tempfile::tempdir().unwrap();
        let cookie_path = directory.path().join("cookies.v2.json");
        let state = AppState::persistent_for_test(cookie_path.clone());
        state
            .cookie_store
            .lock()
            .unwrap()
            .insert_raw(
                &cookie::Cookie::build(("session", "SENSITIVE_COOKIE"))
                    .domain("example.test")
                    .path("/")
                    .build(),
                &url::Url::parse("https://alpha.example.test/").unwrap(),
            )
            .unwrap();
        state.persist_cookies().unwrap();
        let previous = json!({"metadata":{"sites":{"alpha":{"url":"https://alpha.example.test","password":"SENSITIVE_PASSWORD"},"beta":{"url":"https://beta.example.test"}}}});
        let shared = json!({"metadata":{"sites":{"beta":{"url":"https://beta.example.test"}}}});
        let empty = json!({"metadata":{"sites":{}}});
        let path = directory.path().join("storage.json");
        write_document(&path, previous.as_object().unwrap()).unwrap();
        commit_document(
            &path,
            previous.as_object().unwrap(),
            shared.as_object().unwrap(),
            &state,
        )
        .unwrap();
        assert_eq!(state.cookie_store.lock().unwrap().iter_any().count(), 1);
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("SENSITIVE_PASSWORD"));
        commit_document(
            &path,
            shared.as_object().unwrap(),
            empty.as_object().unwrap(),
            &state,
        )
        .unwrap();
        assert_eq!(state.cookie_store.lock().unwrap().iter_any().count(), 0);
        assert!(!fs::read_to_string(cookie_path)
            .unwrap()
            .contains("SENSITIVE_COOKIE"));
    }

    #[test]
    fn ap_04_failed_config_commit_restores_cookie_file_and_memory() {
        let directory = tempfile::tempdir().unwrap();
        let cookie_path = directory.path().join("cookies.v2.json");
        let state = AppState::persistent_for_test(cookie_path.clone());
        state
            .cookie_store
            .lock()
            .unwrap()
            .insert_raw(
                &cookie::Cookie::new("session", "SENSITIVE_COOKIE"),
                &url::Url::parse("https://alpha.example.test/").unwrap(),
            )
            .unwrap();
        state.persist_cookies().unwrap();
        let before = fs::read(&cookie_path).unwrap();
        let previous = json!({"metadata":{"sites":{"alpha":{"url":"https://alpha.example.test"}}}});
        let next = json!({"metadata":{"sites":{}}});
        assert!(commit_document(
            directory.path(),
            previous.as_object().unwrap(),
            next.as_object().unwrap(),
            &state
        )
        .is_err());
        assert_eq!(state.cookie_store.lock().unwrap().iter_any().count(), 1);
        assert_eq!(fs::read(cookie_path).unwrap(), before);
    }

    #[test]
    fn ap_02_merges_distinct_fields_and_rejects_same_field_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STORE_FILE);
        let original = json!({"theme":"light", "lang":"zh", "nested":{"a":1,"b":1}});
        let first = json!({"theme":"dark", "lang":"zh", "nested":{"a":2,"b":1}});
        let second = json!({"theme":"light", "lang":"en", "nested":{"a":1,"b":2}});
        assert_eq!(
            merge_document(&path, "config", &Value::Null, &original).unwrap(),
            original
        );
        merge_document(&path, "config", &original, &first).unwrap();
        let merged = merge_document(&path, "config", &original, &second).unwrap();
        assert_eq!(
            merged,
            json!({"theme":"dark", "lang":"en", "nested":{"a":2,"b":2}})
        );
        assert!(merge_document(
            &path,
            "config",
            &original,
            &json!({"theme":"blue", "lang":"zh", "nested":{"a":1,"b":1}})
        )
        .unwrap_err()
        .starts_with("STORAGE_CONFLICT"));
        assert_eq!(read_document(&path).unwrap()["config"], merged);
    }

    #[test]
    fn ap_02_corrupt_file_never_becomes_empty_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STORE_FILE);
        fs::write(&path, b"{not valid").unwrap();
        assert!(
            merge_document(&path, "config", &Value::Null, &json!({"theme":"dark"}))
                .unwrap_err()
                .starts_with("STORAGE_CORRUPT")
        );
        assert_eq!(fs::read(&path).unwrap(), b"{not valid");
    }
}
