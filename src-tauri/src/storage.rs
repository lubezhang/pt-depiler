#[cfg(test)]
use std::fs::{self, File};
#[cfg(test)]
use std::io::Write;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{error::AppErrorDto, repository::Repository, state::AppState};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State, WebviewWindow};
#[cfg(test)]
use tempfile::NamedTempFile;

#[cfg(test)]
const STORE_FILE: &str = "storage.json";
static REPOSITORY: OnceLock<Mutex<Repository>> = OnceLock::new();

fn data_directory(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(directory) = std::env::var_os("PTD_E2E_DATA_DIR") {
        let path = PathBuf::from(directory);
        if !path.is_absolute() {
            return Err("STORAGE_INVALID_DATA_DIR:storage_path".to_string());
        }
        return Ok(path);
    }
    app.path()
        .app_data_dir()
        .map_err(|_| "STORAGE_UNAVAILABLE:storage_path".to_string())
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let repository = Repository::open(&data_directory(app)?)?;
    REPOSITORY
        .set(Mutex::new(repository))
        .map_err(|_| "STORAGE_UNAVAILABLE:already_initialized".to_string())
}

fn now_ms() -> Result<u64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "STORAGE_UNAVAILABLE:clock")?;
    u64::try_from(elapsed.as_millis()).map_err(|_| "STORAGE_UNAVAILABLE:clock".into())
}

fn repository() -> Result<&'static Mutex<Repository>, String> {
    REPOSITORY
        .get()
        .ok_or_else(|| "STORAGE_UNAVAILABLE:not_initialized".to_string())
}

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

#[cfg(test)]
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

#[cfg(test)]
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
#[cfg(test)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "STORAGE_UNAVAILABLE:sync".to_string())
}

#[cfg(not(unix))]
#[cfg(test)]
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
    let _ = app;
    let guard = repository()?
        .lock()
        .map_err(|_| "STORAGE_UNAVAILABLE:lock".to_string())?;
    guard.ensure_recovery_ready()?;
    if guard.status()["commitUncertain"] == true {
        return Err("STORAGE_COMMIT_UNCERTAIN:read".into());
    }
    Ok(guard.read(key))
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

#[cfg(test)]
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
        let mut repository = repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?;
        let _ = app;
        let document = repository.records().clone();
        let base = base.as_object().ok_or("STORAGE_INVALID_INPUT:base")?;
        let value = value.as_object().ok_or("STORAGE_INVALID_INPUT:value")?;
        let merged = merged_batch(&document, base, value)?;
        state.commit_with_cookie_cleanup(
            &site_hosts(document.get("metadata")),
            &site_hosts(merged.get("metadata")),
            || repository.commit(merged.clone()),
        )?;
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
        let mut repository = repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock".to_string())?;
        let _ = app;
        let mut document = repository.records().clone();
        document.insert(key, value);
        repository.commit(document)
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
        let mut repository = repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock".to_string())?;
        let _ = app;
        let document = repository.records().clone();
        let merged = merged_batch(
            &document,
            &Map::from_iter([(key.clone(), base)]),
            &Map::from_iter([(key.clone(), value)]),
        )?;
        state.commit_with_cookie_cleanup(
            &site_hosts(document.get("metadata")),
            &site_hosts(merged.get("metadata")),
            || repository.commit(merged.clone()),
        )?;
        Ok(merged[&key].clone())
    })();
    result.map_err(|error| AppErrorDto::command(&error, "merge_ext_storage"))
}

#[tauri::command]
pub async fn get_storage_status(window: WebviewWindow) -> Result<Value, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        let repository = repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?;
        Ok(repository.status())
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "get_storage_status"))
}

pub fn recover_at_startup(state: &AppState) -> Result<(), String> {
    let mut repository = repository()?
        .lock()
        .map_err(|_| "STORAGE_UNAVAILABLE:lock")?;
    recover_repository(&mut repository, state)?;
    repository.initialize_tasks()
}

fn recover_repository(repository: &mut Repository, state: &AppState) -> Result<(), String> {
    repository.reconcile()?;
    let journal = repository.restore_journal();
    let stage = journal["stage"].as_str();
    if stage == Some("manualRecovery") {
        return Err("STORAGE_RECOVERY_REQUIRED:manual".into());
    }
    let pending = matches!(stage, Some("prepared" | "jsonCommitted"));
    if pending && journal["hasCookies"] == true {
        let id = journal["id"].as_str().ok_or("STORAGE_CORRUPT:restore_id")?;
        if let Err(error) =
            state.recover_cookies(Some(id), true, stage == Some("jsonCommitted"), || {
                repository.finish_restore(id, stage == Some("prepared"))
            })
        {
            if error.starts_with("STORAGE_CONFLICT") {
                repository.mark_restore_manual()?;
            }
            return Err(error);
        }
    } else {
        // Orphan mirrors precede the prepared marker, or follow the completed one.
        let mirror_id = state.cookie_recovery_id()?;
        let same_restore = mirror_id.as_deref() == journal["id"].as_str();
        state.recover_cookies(
            None,
            false,
            same_restore && stage == Some("completed"),
            || Ok(()),
        )?;
        repository.ensure_recovery_ready()?;
    }
    Ok(())
}

#[tauri::command]
pub async fn import_legacy_restore_journals(
    journals: Vec<Value>,
    histories: Vec<Value>,
    window: WebviewWindow,
) -> Result<(), AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        if window.label() != "main" {
            return Err("STORAGE_INVALID_INPUT:legacy_restore_owner".into());
        }
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .import_legacy_restore_journals(journals, histories)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "import_legacy_restore_journals"))
}

#[tauri::command]
pub async fn recover_backup_restore(
    state: State<'_, AppState>,
    window: WebviewWindow,
) -> Result<(), AppErrorDto> {
    let result = ensure_storage_window(&window).and_then(|_| recover_at_startup(state.inner()));
    result.map_err(|error| AppErrorDto::command(&error, "recover_backup_restore"))
}

#[tauri::command]
pub async fn get_backup_snapshot(
    include_cookies: bool,
    state: State<'_, AppState>,
    window: WebviewWindow,
) -> Result<Value, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        let repository = repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?;
        state.ensure_recovery_ready()?;
        let mut snapshot = repository.backup_snapshot()?;
        if include_cookies {
            let hosts = site_hosts(Some(&snapshot["data"]["metadata"]));
            let cookies = state.cookie_snapshot()?;
            snapshot["data"]["cookies"] = Value::Array(
                cookies
                    .as_array()
                    .ok_or("STORAGE_UNAVAILABLE:cookies")?
                    .iter()
                    .filter(|cookie| {
                        serde_json::from_value::<crate::http::CookieInfo>((*cookie).clone())
                            .is_ok_and(|cookie| crate::http::cookie_owned_by_sites(&cookie, &hosts))
                    })
                    .cloned()
                    .collect(),
            );
        }
        Ok(snapshot)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "get_backup_snapshot"))
}

#[tauri::command]
pub async fn restore_backup_snapshot(
    expected_revision: u64,
    data: Value,
    cookies: Option<Vec<crate::http::CookieInfo>>,
    state: State<'_, AppState>,
    window: WebviewWindow,
) -> Result<String, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        let mut repository = repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?;
        let values = data
            .as_object()
            .ok_or("STORAGE_INVALID_INPUT:restore")?
            .clone();
        repository.validate_restore_backup(expected_revision, values.clone(), cookies.is_some())?;
        if let Some(cookies) = cookies {
            let id = repository.next_restore_id()?;
            let metadata = values
                .get("metadata")
                .cloned()
                .unwrap_or_else(|| repository.read("metadata"));
            state.restore_with_cookies(&id, cookies, &site_hosts(Some(&metadata)), |finish| {
                if finish {
                    repository.finish_restore(&id, false)
                } else {
                    repository
                        .restore_backup(expected_revision, values.clone(), true)
                        .map(|_| ())
                }
            })?;
            Ok(id)
        } else {
            repository.restore_backup(expected_revision, values, false)
        }
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "restore_backup_snapshot"))
}

#[tauri::command]
pub async fn get_cache_snapshot(window: WebviewWindow) -> Result<Value, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        let repository = repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?;
        Ok(serde_json::json!({
            "revision": repository.revision(),
            "config": repository.read("config"),
            "metadata": repository.read("metadata"),
        }))
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "get_cache_snapshot"))
}

#[tauri::command]
pub async fn reconcile_storage_commit(window: WebviewWindow) -> Result<bool, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        let mut repository = repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?;
        repository.reconcile()
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "reconcile_storage_commit"))
}

#[tauri::command]
pub async fn import_download_history(
    histories: Vec<Value>,
    window: WebviewWindow,
) -> Result<bool, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        #[cfg(debug_assertions)]
        if crate::stage_a_acceptance::enabled()
            && std::env::var("PTD_STAGE_B_MIGRATION_GUI").as_deref() == Ok("retry-fail")
        {
            return Err("STORAGE_UNAVAILABLE:acceptance_import_failure".into());
        }
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .import_download_history(histories)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "import_download_history"))
}

#[tauri::command]
pub async fn list_download_history(window: WebviewWindow) -> Result<Vec<Value>, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .list_download_history()
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "list_download_history"))
}

#[tauri::command]
pub async fn get_download_history(
    id: u64,
    window: WebviewWindow,
) -> Result<Option<Value>, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .get_download_history(id)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "get_download_history"))
}

#[tauri::command]
pub async fn insert_download_history(
    history: Value,
    window: WebviewWindow,
) -> Result<u64, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .insert_download_history(history)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "insert_download_history"))
}

#[tauri::command]
pub async fn save_download_history_if_unchanged(
    id: u64,
    base: Value,
    history: Value,
    window: WebviewWindow,
) -> Result<bool, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .save_download_history_if_unchanged(id, base, history)
    })();
    result
        .map_err(|error: String| AppErrorDto::command(&error, "save_download_history_if_unchanged"))
}

#[tauri::command]
pub async fn delete_download_history(id: u64, window: WebviewWindow) -> Result<bool, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .delete_download_history(id)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "delete_download_history"))
}

#[tauri::command]
pub async fn clear_download_history(window: WebviewWindow) -> Result<usize, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .clear_download_history()
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "clear_download_history"))
}

#[tauri::command]
pub async fn replace_download_history(
    histories: Vec<Value>,
    window: WebviewWindow,
) -> Result<(), AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .replace_download_history(histories)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "replace_download_history"))
}

#[tauri::command]
pub async fn schedule_redownload(
    download_id: String,
    delay_secs: u64,
    window: WebviewWindow,
) -> Result<(), AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        let id = download_id
            .parse::<u64>()
            .map_err(|_| "STORAGE_INVALID_INPUT:download_id")?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .enqueue_redownload(id, delay_secs, now_ms()?)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "schedule_redownload"))
}

#[tauri::command]
pub async fn ensure_periodic_tasks(window: WebviewWindow) -> Result<(), AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .ensure_periodic_tasks(now_ms()?)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "ensure_periodic_tasks"))
}

#[tauri::command]
pub async fn claim_due_task(
    owner: String,
    window: WebviewWindow,
) -> Result<Option<Value>, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .claim_due(&owner, now_ms()?)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "claim_due_task"))
}

#[tauri::command]
pub async fn renew_task(
    task_id: String,
    owner: String,
    window: WebviewWindow,
) -> Result<bool, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .renew_task(&task_id, &owner, now_ms()?)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "renew_task"))
}

#[tauri::command]
pub async fn finish_task(
    task_id: String,
    owner: String,
    outcome: String,
    window: WebviewWindow,
) -> Result<(), AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .finish_task(&task_id, &owner, &outcome, now_ms()?)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "finish_task"))
}

#[tauri::command]
pub async fn release_tasks(owner: String, window: WebviewWindow) -> Result<(), AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .release_owner(&owner, now_ms()?)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "release_tasks"))
}

#[tauri::command]
pub async fn list_task_status(window: WebviewWindow) -> Result<Vec<Value>, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .task_status()
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "list_task_status"))
}

#[tauri::command]
pub async fn request_task_cancel(
    task_id: String,
    window: WebviewWindow,
) -> Result<bool, AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .request_task_cancel(&task_id, now_ms()?)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "request_task_cancel"))
}

#[tauri::command]
pub async fn resolve_task(
    task_id: String,
    action: String,
    window: WebviewWindow,
) -> Result<(), AppErrorDto> {
    let result = (|| {
        ensure_storage_window(&window)?;
        repository()?
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?
            .resolve_task(&task_id, &action, now_ms()?)
    })();
    result.map_err(|error: String| AppErrorDto::command(&error, "resolve_task"))
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

#[cfg(test)]
mod phase_c_tests {
    use super::*;
    use crate::http::CookieInfo;
    use serde_json::json;

    fn cookie(value: &str) -> CookieInfo {
        CookieInfo {
            name: "session".into(),
            value: value.into(),
            domain: "tracker.example".into(),
            host_only: true,
            path: "/".into(),
            secure: true,
            http_only: true,
            expiration_date: None,
            same_site: None,
        }
    }

    #[test]
    fn ap_12_process_interrupt_child() {
        let Some(directory) = std::env::var_os("PTD_C_RESTORE_DATA") else {
            return;
        };
        let boundary = std::env::var("PTD_C_RESTORE_BOUNDARY").unwrap();
        let directory = PathBuf::from(directory);
        let state = AppState::persistent_for_test(directory.join("cookies.v2.json"));
        let mut repo = Repository::open(&directory).unwrap();
        repo.import_download_history(vec![]).unwrap();
        let revision = repo.revision();
        let id = repo.next_restore_id().unwrap();
        let values = json!({"config":{"theme":"dark"},"downloadHistory":[{"id":1,"downloadStatus":"completed"}]}).as_object().unwrap().clone();
        state
            .restore_with_cookies(
                &id,
                vec![cookie("fixture-secret")],
                &["tracker.example".into()],
                |finish| {
                    if !finish {
                        if boundary == "cookiePrepared" {
                            std::process::exit(86);
                        }
                        if boundary == "jsonPrepared" {
                            crate::repository::fail_after_restore_prepare_for_test();
                        }
                        let result = repo.restore_backup(revision, values.clone(), true);
                        if boundary == "jsonPrepared" || boundary == "jsonCommitted" {
                            std::process::exit(86);
                        }
                        result?;
                    } else {
                        if boundary == "cookieCommitted" {
                            std::process::exit(86);
                        }
                        repo.finish_restore(&id, false)?;
                        if boundary == "completed" {
                            std::process::exit(86);
                        }
                    }
                    Ok(())
                },
            )
            .unwrap();
    }

    #[test]
    fn ap_12_real_process_interrupts_recover_without_duplicate_history() {
        for boundary in [
            "cookiePrepared",
            "jsonPrepared",
            "jsonCommitted",
            "cookieCommitted",
            "completed",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "storage::phase_c_tests::ap_12_process_interrupt_child",
                    "--nocapture",
                ])
                .env("PTD_C_RESTORE_DATA", directory.path())
                .env("PTD_C_RESTORE_BOUNDARY", boundary)
                .status()
                .unwrap();
            assert_eq!(status.code(), Some(86), "{boundary}");
            let state = AppState::persistent_for_test(directory.path().join("cookies.v2.json"));
            let mut repo = Repository::open(directory.path()).unwrap();
            recover_repository(&mut repo, &state).unwrap();
            recover_repository(&mut repo, &state).unwrap();
            let committed = !matches!(boundary, "cookiePrepared" | "jsonPrepared");
            assert_eq!(
                repo.list_download_history().unwrap().len(),
                usize::from(committed),
                "{boundary}"
            );
            assert_eq!(
                state.cookie_snapshot().unwrap().as_array().unwrap().len(),
                usize::from(committed),
                "{boundary}"
            );
            assert!(!directory.path().join("cookies.v2.restore.json").exists());
        }
    }

    #[test]
    fn ap_12_restart_converges_at_every_cookie_boundary() {
        for boundary in [
            "cookiePrepared",
            "jsonCommitted",
            "cookieCommitted",
            "completed",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let cookie_path = directory.path().join("cookies.v2.json");
            let state = AppState::persistent_for_test(cookie_path.clone());
            let mut repo = Repository::open(directory.path()).unwrap();
            repo.import_download_history(vec![]).unwrap();
            let revision = repo.revision();
            let id = repo.next_restore_id().unwrap();
            let values = json!({"config":{"theme":"dark"},"downloadHistory":[{"id":1,"downloadStatus":"completed"}]}).as_object().unwrap().clone();
            let result = state.restore_with_cookies(
                &id,
                vec![cookie("secret-cookie")],
                &["tracker.example".into()],
                |finish| {
                    if !finish {
                        if boundary == "cookiePrepared" {
                            return Err("STORAGE_UNAVAILABLE:injected".into());
                        }
                        repo.restore_backup(revision, values.clone(), true)?;
                        if boundary == "jsonCommitted" {
                            return Err("STORAGE_UNAVAILABLE:injected".into());
                        }
                    } else {
                        if boundary == "cookieCommitted" {
                            return Err("STORAGE_UNAVAILABLE:injected".into());
                        }
                        repo.finish_restore(&id, false)?;
                    }
                    Ok(())
                },
            );
            assert_eq!(result.is_ok(), boundary == "completed");
            drop(state);
            drop(repo);
            let state = AppState::persistent_for_test(cookie_path);
            let mut repo = Repository::open(directory.path()).unwrap();
            recover_repository(&mut repo, &state).unwrap();
            recover_repository(&mut repo, &state).unwrap();
            if boundary == "cookiePrepared" {
                assert!(repo.read("config").is_null());
                assert!(repo.list_download_history().unwrap().is_empty());
                assert_eq!(state.cookie_snapshot().unwrap(), json!([]));
            } else {
                assert_eq!(repo.read("config")["theme"], "dark");
                assert_eq!(repo.list_download_history().unwrap().len(), 1);
                assert_eq!(
                    state.cookie_snapshot().unwrap()[0]["value"],
                    "secret-cookie"
                );
                assert_eq!(repo.restore_journal()["stage"], "completed");
            }
            assert!(!directory.path().join("cookies.v2.restore.json").exists());
        }
    }

    #[test]
    fn ap_12_invalid_cookie_does_not_create_journal_or_mirror() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::persistent_for_test(directory.path().join("cookies.v2.json"));
        let result = state.restore_with_cookies(
            "restore-1",
            vec![cookie("secret")],
            &["other.example".into()],
            |_| panic!("must validate first"),
        );
        assert!(result.is_err());
        assert!(!directory.path().join("cookies.v2.restore.json").exists());
    }
}
