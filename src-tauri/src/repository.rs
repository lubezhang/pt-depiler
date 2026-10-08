#[cfg(test)]
use std::cell::Cell;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tempfile::NamedTempFile;

const FORMAT_VERSION: u32 = 1;
const MAX_STATE_BYTES: usize = 32 * 1024 * 1024;
const MAX_DOWNLOAD_HISTORY_RECORDS: usize = 50_000;
const MAX_TASKS: usize = 10_000;
const TASK_LEASE_MS: u64 = 120_000;
const PERIODIC_INTERVAL_MS: u64 = 600_000;

fn backup_filename(run_at: u64) -> String {
    format!("PTD_backup_task_{run_at}.zip")
}
const ROOT_DOMAINS: [&str; 6] = [
    "config",
    "metadata",
    "userInfo",
    "searchResultSnapshot",
    "keepUploadTask",
    "__metadataRevision",
];

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_DIRECTORY_SYNC: Cell<bool> = const { Cell::new(false) };
    static FAIL_NEXT_LEGACY_CLEANUP: Cell<bool> = const { Cell::new(false) };
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportMarker {
    pub source: String,
    pub source_version: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    pub format_version: u32,
    pub revision: u64,
    pub operation_id: u64,
    pub imports: Map<String, Value>,
    pub records: Map<String, Value>,
}

pub struct Repository {
    path: PathBuf,
    _lock: File,
    document: Document,
    uncertain: bool,
}

impl Repository {
    pub fn open(directory: &Path) -> Result<Self, String> {
        fs::create_dir_all(directory).map_err(|_| "STORAGE_UNAVAILABLE:directory")?;
        let lock_path = directory.join("app-state.lock");
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| "STORAGE_UNAVAILABLE:lock")?;
        lock_exclusive(&lock)?;
        let path = directory.join("app-state.json");
        let (document, previously_committed) = match fs::read(&path) {
            Ok(bytes) => (parse_document(&bytes)?, true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let document = import_legacy(directory)?;
                write_document(&path, &document)?;
                (document, false)
            }
            Err(_) => return Err("STORAGE_UNAVAILABLE:read".into()),
        };
        let repository = Self {
            path,
            _lock: lock,
            document,
            uncertain: false,
        };
        if previously_committed {
            repository.cleanup_legacy();
        }
        Ok(repository)
    }

    pub fn read(&self, key: &str) -> Value {
        self.document
            .records
            .get(key)
            .cloned()
            .unwrap_or(Value::Null)
    }

    pub fn records(&self) -> &Map<String, Value> {
        &self.document.records
    }

    pub fn revision(&self) -> u64 {
        self.document.revision
    }

    pub fn status(&self) -> Value {
        serde_json::json!({
            "formatVersion": self.document.format_version,
            "revision": self.document.revision,
            "imports": self.document.imports,
            "cleanupPending": self.legacy_cleanup_pending(),
            "commitUncertain": self.uncertain,
        })
    }

    pub fn commit(&mut self, records: Map<String, Value>) -> Result<(), String> {
        let mut next = self.document.clone();
        next.records = records;
        self.commit_document(next)
    }

    fn commit_document(&mut self, mut next: Document) -> Result<(), String> {
        if self.uncertain {
            return Err("STORAGE_COMMIT_UNCERTAIN:blocked".into());
        }
        next.revision = next
            .revision
            .checked_add(1)
            .ok_or("STORAGE_UNAVAILABLE:revision_overflow")?;
        next.operation_id = next
            .operation_id
            .checked_add(1)
            .ok_or("STORAGE_UNAVAILABLE:operation_overflow")?;
        match write_document(&self.path, &next) {
            Ok(()) => {
                self.document = next;
                Ok(())
            }
            Err(error) if error == "STORAGE_COMMIT_UNCERTAIN:sync" => {
                self.uncertain = true;
                Err(error)
            }
            Err(error) => Err(error),
        }
    }

    pub fn download_history_imported(&self) -> bool {
        self.document.imports.contains_key("downloadHistory")
    }

    pub fn import_download_history(&mut self, histories: Vec<Value>) -> Result<bool, String> {
        if self.download_history_imported() {
            return Ok(false);
        }
        let history = history_map(histories)?;
        let next_id = next_history_id(&history)?;
        let mut next = self.document.clone();
        next.records
            .insert("downloadHistory".into(), Value::Object(history));
        next.records
            .insert("downloadHistoryNextId".into(), Value::from(next_id));
        next.imports.insert(
            "downloadHistory".into(),
            serde_json::json!({"source":"indexeddb","sourceVersion":2}),
        );
        self.commit_document(next)?;
        Ok(true)
    }

    fn history(&self) -> Result<&Map<String, Value>, String> {
        if !self.download_history_imported() {
            return Err("STORAGE_MIGRATION_REQUIRED:download_history".into());
        }
        self.document
            .records
            .get("downloadHistory")
            .and_then(Value::as_object)
            .ok_or_else(|| "STORAGE_CORRUPT:download_history".into())
    }

    pub fn list_download_history(&self) -> Result<Vec<Value>, String> {
        Ok(self.history()?.values().cloned().collect())
    }

    pub fn get_download_history(&self, id: u64) -> Result<Option<Value>, String> {
        Ok(self.history()?.get(&id.to_string()).cloned())
    }

    pub fn insert_download_history(&mut self, mut history: Value) -> Result<u64, String> {
        let _ = self.history()?;
        let object = history
            .as_object_mut()
            .ok_or("STORAGE_INVALID_INPUT:download_history")?;
        if !object.get("downloadStatus").is_some_and(Value::is_string) {
            return Err("STORAGE_INVALID_INPUT:download_history_status".into());
        }
        let id = self.document.records["downloadHistoryNextId"]
            .as_u64()
            .ok_or("STORAGE_CORRUPT:download_history_next_id")?;
        let next_id = id
            .checked_add(1)
            .filter(|next| *next <= 9_007_199_254_740_991)
            .ok_or("STORAGE_CAPACITY_EXCEEDED:ids")?;
        object.insert("id".into(), Value::from(id));
        let mut records = self.document.records.clone();
        let histories = records["downloadHistory"]
            .as_object_mut()
            .ok_or("STORAGE_CORRUPT:download_history")?;
        if histories.len() >= MAX_DOWNLOAD_HISTORY_RECORDS {
            return Err("STORAGE_CAPACITY_EXCEEDED:download_history".into());
        }
        histories.insert(id.to_string(), history);
        records.insert("downloadHistoryNextId".into(), Value::from(next_id));
        self.commit(records)?;
        Ok(id)
    }

    pub fn save_download_history_if_unchanged(
        &mut self,
        id: u64,
        base: Value,
        proposed: Value,
    ) -> Result<bool, String> {
        let current = self.get_download_history(id)?;
        if current.is_none() {
            return Ok(false);
        }
        if current.as_ref() != Some(&base) {
            return Err("STORAGE_CONFLICT:download_history".into());
        }
        validate_history(&proposed, id)?;
        let mut records = self.document.records.clone();
        records["downloadHistory"]
            .as_object_mut()
            .ok_or("STORAGE_CORRUPT:download_history")?
            .insert(id.to_string(), proposed);
        self.commit(records)?;
        Ok(true)
    }

    pub fn delete_download_history(&mut self, id: u64) -> Result<bool, String> {
        if !self.history()?.contains_key(&id.to_string()) {
            return Ok(false);
        }
        let mut records = self.document.records.clone();
        records["downloadHistory"]
            .as_object_mut()
            .ok_or("STORAGE_CORRUPT:download_history")?
            .remove(&id.to_string());
        self.commit(records)?;
        Ok(true)
    }

    pub fn clear_download_history(&mut self) -> Result<usize, String> {
        let count = self.history()?.len();
        if count > 0 {
            let mut records = self.document.records.clone();
            records.insert("downloadHistory".into(), serde_json::json!({}));
            self.commit(records)?;
        }
        Ok(count)
    }

    pub fn replace_download_history(&mut self, histories: Vec<Value>) -> Result<(), String> {
        let history = history_map(histories)?;
        let next_id = next_history_id(&history)?.max(
            self.document.records["downloadHistoryNextId"]
                .as_u64()
                .unwrap_or(1),
        );
        let _ = self.history()?;
        let mut records = self.document.records.clone();
        records.insert("downloadHistory".into(), Value::Object(history));
        records.insert("downloadHistoryNextId".into(), Value::from(next_id));
        self.commit(records)
    }

    pub fn initialize_tasks(&mut self) -> Result<(), String> {
        if self.document.imports.contains_key("tasks") {
            let mut records = self.document.records.clone();
            let tasks = records["tasks"]
                .as_object_mut()
                .ok_or("STORAGE_CORRUPT:tasks")?;
            for task in tasks.values_mut() {
                if task["kind"] != "autoBackup" || task["payload"].get("backupFilename").is_some() {
                    continue;
                }
                if matches!(task["state"].as_str(), Some("queued" | "scheduled"))
                    && task["attempt"] == 0
                {
                    let run_at = task["runAt"].as_u64().ok_or("STORAGE_CORRUPT:task")?;
                    task["payload"]["backupFilename"] = Value::from(backup_filename(run_at));
                } else {
                    task["state"] = Value::from("uncertain");
                    task["lastError"] = Value::from("TASK_BACKUP_IDENTITY_MISSING");
                    task["leaseOwner"] = Value::Null;
                    task["leaseExpiresAt"] = Value::Null;
                }
            }
            if records != self.document.records {
                self.commit(records)?;
            }
            return Ok(());
        }
        let mut next = self.document.clone();
        next.imports.insert(
            "tasks".into(),
            serde_json::json!({"source":"legacy-events","sourceVersion":0}),
        );
        next.records.insert("tasks".into(), serde_json::json!({}));
        self.commit_document(next)
    }

    fn tasks(&self) -> Result<&Map<String, Value>, String> {
        self.document
            .records
            .get("tasks")
            .and_then(Value::as_object)
            .ok_or_else(|| "STORAGE_MIGRATION_REQUIRED:tasks".into())
    }

    fn enqueue_task(
        &mut self,
        id: &str,
        kind: &str,
        resource_id: &str,
        payload: Value,
        run_at: u64,
        now: u64,
    ) -> Result<(), String> {
        let tasks = self.tasks()?;
        if tasks.contains_key(id) {
            return Ok(());
        }
        if tasks.len() >= MAX_TASKS {
            return Err("STORAGE_CAPACITY_EXCEEDED:tasks".into());
        }
        let task = serde_json::json!({
            "id":id,
            "kind":kind,
            "payloadVersion":1,
            "payload":payload,
            "resourceId":resource_id,
            "state":"scheduled",
            "runAt":run_at,
            "attempt":0,
            "maxAttempts":3,
            "leaseOwner":null,
            "leaseExpiresAt":null,
            "idempotencyKey":id,
            "lastError":null,
            "cancelRequested":false,
            "createdAt":now,
            "updatedAt":now,
        });
        let mut records = self.document.records.clone();
        records["tasks"]
            .as_object_mut()
            .ok_or("STORAGE_CORRUPT:tasks")?
            .insert(id.into(), task);
        self.commit(records)
    }

    pub fn enqueue_redownload(
        &mut self,
        download_id: u64,
        delay_secs: u64,
        now: u64,
    ) -> Result<(), String> {
        let history = self
            .get_download_history(download_id)?
            .ok_or("STORAGE_INVALID_INPUT:download_history_missing")?;
        let site_id = history
            .get("siteId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let run_at = now
            .checked_add(delay_secs.saturating_mul(1000))
            .ok_or("STORAGE_INVALID_INPUT:run_at")?;
        self.enqueue_task(
            &format!("redownload:{download_id}"),
            "redownload",
            &format!("site:{site_id}"),
            serde_json::json!({"downloadId":download_id}),
            run_at,
            now,
        )
    }

    pub fn ensure_periodic_tasks(&mut self, now: u64) -> Result<(), String> {
        let config = self.read("config");
        if config.pointer("/userInfo/autoReflush/enabled") == Some(&Value::Bool(true)) {
            self.enqueue_task(
                "periodic:user-info",
                "userInfo",
                "user-info",
                serde_json::json!({}),
                now.saturating_add(60_000),
                now,
            )?;
        }
        let metadata = self.read("metadata");
        if let Some(servers) = metadata.get("backupServers").and_then(Value::as_object) {
            for (id, server) in servers {
                if server.get("enabled") != Some(&Value::Bool(true))
                    || server
                        .get("backupInterval")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        == 0
                {
                    continue;
                }
                self.enqueue_task(
                    &format!("periodic:backup:{id}"),
                    "autoBackup",
                    &format!("backup:{id}"),
                    serde_json::json!({"backupServerId":id,"backupFilename":backup_filename(now.saturating_add(120_000))}),
                    now.saturating_add(120_000),
                    now,
                )?;
            }
        }
        Ok(())
    }

    pub fn claim_due(&mut self, owner: &str, now: u64) -> Result<Option<Value>, String> {
        if owner.is_empty() || owner.len() > 100 {
            return Err("STORAGE_INVALID_INPUT:task_owner".into());
        }
        let tasks = self.tasks()?;
        let expired: Vec<String> = tasks
            .iter()
            .filter(|(_, task)| {
                task["state"] == "running" && task["leaseExpiresAt"].as_u64().unwrap_or(0) <= now
            })
            .map(|(id, _)| id.clone())
            .collect();
        let candidate = tasks
            .iter()
            .filter(|(id, task)| {
                let resource = &task["resourceId"];
                matches!(
                    task["state"].as_str(),
                    Some("queued" | "scheduled" | "retry_wait")
                ) && task["runAt"].as_u64().is_some_and(|run_at| run_at <= now)
                    && !tasks.iter().any(|(other_id, other)| {
                        other_id != *id
                            && other["state"] == "running"
                            && &other["resourceId"] == resource
                            && other["leaseExpiresAt"].as_u64().unwrap_or(0) > now
                    })
            })
            .min_by_key(|(_, task)| task["runAt"].as_u64().unwrap_or(u64::MAX))
            .map(|(id, _)| id.clone());
        let mut records = self.document.records.clone();
        let task_map = records["tasks"]
            .as_object_mut()
            .ok_or("STORAGE_CORRUPT:tasks")?;
        for id in expired {
            let task = task_map.get_mut(&id).ok_or("STORAGE_CORRUPT:tasks")?;
            task["state"] = Value::from("uncertain");
            task["lastError"] = Value::from("TASK_LEASE_EXPIRED");
            task["leaseOwner"] = Value::Null;
            task["leaseExpiresAt"] = Value::Null;
            task["updatedAt"] = Value::from(now);
        }
        let mut claimed = None;
        if let Some(id) = candidate {
            let task = task_map.get_mut(&id).ok_or("STORAGE_CORRUPT:tasks")?;
            if task["payloadVersion"] != 1 {
                task["state"] = Value::from("failed");
                task["lastError"] = Value::from("TASK_PAYLOAD_VERSION_UNSUPPORTED");
            } else {
                task["state"] = Value::from("running");
                task["leaseOwner"] = Value::from(owner);
                task["leaseExpiresAt"] = Value::from(now.saturating_add(TASK_LEASE_MS));
                task["attempt"] = Value::from(task["attempt"].as_u64().unwrap_or(0) + 1);
                claimed = Some(task.clone());
            }
            task["updatedAt"] = Value::from(now);
        }
        if records != self.document.records {
            self.commit(records)?;
        }
        Ok(claimed)
    }

    pub fn renew_task(&mut self, id: &str, owner: &str, now: u64) -> Result<bool, String> {
        let task = self.tasks()?.get(id);
        if task.map_or(true, |task| {
            task["state"] != "running" || task["leaseOwner"] != owner
        }) {
            return Ok(false);
        }
        let mut records = self.document.records.clone();
        let task = &mut records["tasks"][id];
        task["leaseExpiresAt"] = Value::from(now.saturating_add(TASK_LEASE_MS));
        task["updatedAt"] = Value::from(now);
        self.commit(records)?;
        Ok(true)
    }

    pub fn finish_task(
        &mut self,
        id: &str,
        owner: &str,
        outcome: &str,
        now: u64,
    ) -> Result<(), String> {
        let task = self
            .tasks()?
            .get(id)
            .ok_or("STORAGE_INVALID_INPUT:task_missing")?;
        if task["state"] != "running" || task["leaseOwner"] != owner {
            return Err("STORAGE_CONFLICT:task_lease".into());
        }
        if !matches!(
            outcome,
            "succeeded" | "failed" | "retry" | "uncertain" | "cancelled"
        ) {
            return Err("STORAGE_INVALID_INPUT:task_outcome".into());
        }
        let mut records = self.document.records.clone();
        let task = &mut records["tasks"][id];
        let periodic = task["kind"] == "userInfo" || task["kind"] == "autoBackup";
        let cancel_requested = task["cancelRequested"] == true;
        let exhausted =
            task["attempt"].as_u64().unwrap_or(0) >= task["maxAttempts"].as_u64().unwrap_or(3);
        task["state"] = Value::from(match outcome {
            "succeeded" if cancel_requested => "succeeded",
            "retry" if cancel_requested => "uncertain",
            "retry" if exhausted => "failed",
            "retry" => "retry_wait",
            "succeeded" if periodic => "scheduled",
            other => other,
        });
        if outcome == "retry" && !cancel_requested {
            task["runAt"] = Value::from(now.saturating_add(60_000));
        } else if periodic && outcome == "succeeded" && !cancel_requested {
            task["runAt"] = Value::from(now.saturating_add(PERIODIC_INTERVAL_MS));
            task["attempt"] = Value::from(0);
            if task["kind"] == "autoBackup" {
                task["payload"]["backupFilename"] =
                    Value::from(backup_filename(now.saturating_add(PERIODIC_INTERVAL_MS)));
            }
        }
        task["leaseOwner"] = Value::Null;
        task["leaseExpiresAt"] = Value::Null;
        task["updatedAt"] = Value::from(now);
        self.commit(records)
    }

    pub fn release_owner(&mut self, owner: &str, now: u64) -> Result<(), String> {
        let mut records = self.document.records.clone();
        let tasks = records["tasks"]
            .as_object_mut()
            .ok_or("STORAGE_CORRUPT:tasks")?;
        for task in tasks.values_mut() {
            if task["state"] == "running" && task["leaseOwner"] == owner {
                task["state"] = Value::from("uncertain");
                task["leaseOwner"] = Value::Null;
                task["leaseExpiresAt"] = Value::Null;
                task["lastError"] = Value::from("TASK_EXECUTOR_RELEASED");
                task["updatedAt"] = Value::from(now);
            }
        }
        if records != self.document.records {
            self.commit(records)?;
        }
        Ok(())
    }

    pub fn request_task_cancel(&mut self, id: &str, now: u64) -> Result<bool, String> {
        let task = self.tasks()?.get(id);
        let Some(task) = task else { return Ok(false) };
        if matches!(
            task["state"].as_str(),
            Some("succeeded" | "failed" | "cancelled")
        ) {
            return Ok(false);
        }
        let mut records = self.document.records.clone();
        let task = &mut records["tasks"][id];
        if task["state"] == "running" || task["state"] == "uncertain" {
            task["cancelRequested"] = Value::Bool(true);
        } else {
            task["state"] = Value::from("cancelled");
        }
        task["updatedAt"] = Value::from(now);
        self.commit(records)?;
        Ok(true)
    }

    pub fn resolve_task(&mut self, id: &str, action: &str, now: u64) -> Result<(), String> {
        let task = self
            .tasks()?
            .get(id)
            .ok_or("STORAGE_INVALID_INPUT:task_missing")?;
        if !matches!(task["state"].as_str(), Some("uncertain" | "failed")) {
            return Err("STORAGE_CONFLICT:task_state".into());
        }
        if !matches!(action, "retry" | "succeeded" | "cancelled") {
            return Err("STORAGE_INVALID_INPUT:task_action".into());
        }
        let mut records = self.document.records.clone();
        let task = &mut records["tasks"][id];
        let periodic = task["kind"] == "userInfo" || task["kind"] == "autoBackup";
        task["state"] = Value::from(
            if action == "retry" || (action == "succeeded" && periodic) {
                "scheduled"
            } else {
                action
            },
        );
        if action == "retry" {
            task["runAt"] = Value::from(now);
            task["cancelRequested"] = Value::Bool(false);
            task["attempt"] = Value::from(0);
            if task["kind"] == "autoBackup" && task["payload"].get("backupFilename").is_none() {
                task["payload"]["backupFilename"] = Value::from(backup_filename(now));
            }
        } else if action == "succeeded" && periodic {
            task["runAt"] = Value::from(now.saturating_add(PERIODIC_INTERVAL_MS));
            task["attempt"] = Value::from(0);
            task["cancelRequested"] = Value::Bool(false);
            if task["kind"] == "autoBackup" {
                task["payload"]["backupFilename"] =
                    Value::from(backup_filename(now.saturating_add(PERIODIC_INTERVAL_MS)));
            }
        }
        task["lastError"] = Value::Null;
        task["updatedAt"] = Value::from(now);
        self.commit(records)
    }

    pub fn task_status(&self) -> Result<Vec<Value>, String> {
        Ok(self
            .tasks()?
            .values()
            .map(|task| {
                serde_json::json!({
                    "id":task["id"],
                    "kind":task["kind"],
                    "resourceId":task["resourceId"],
                    "state":task["state"],
                    "attempt":task["attempt"],
                    "runAt":task["runAt"],
                    "lastError":safe_task_error(&task["lastError"]),
                    "cancelRequested":task["cancelRequested"],
                    "payloadVersion":task["payloadVersion"],
                    "backupFilename":task["payload"].get("backupFilename"),
                })
            })
            .collect())
    }

    pub fn reconcile(&mut self) -> Result<bool, String> {
        let bytes = fs::read(&self.path).map_err(|_| "STORAGE_UNAVAILABLE:reconcile")?;
        let disk = parse_document(&bytes)?;
        let committed = disk.operation_id > self.document.operation_id;
        self.document = disk;
        self.uncertain = false;
        Ok(committed)
    }

    fn legacy_cleanup_pending(&self) -> bool {
        let path = self.path.with_file_name("storage.json");
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Map<String, Value>>(&bytes)
                .map(|legacy| ROOT_DOMAINS.iter().any(|key| legacy.contains_key(*key)))
                .unwrap_or(true),
            Err(error) => error.kind() != std::io::ErrorKind::NotFound,
        }
    }

    fn cleanup_legacy(&self) {
        let path = self.path.with_file_name("storage.json");
        let Ok(bytes) = fs::read(&path) else { return };
        let Ok(mut legacy) = serde_json::from_slice::<Map<String, Value>>(&bytes) else {
            return;
        };
        if !ROOT_DOMAINS.iter().any(|key| legacy.contains_key(*key)) {
            return;
        }
        for key in ROOT_DOMAINS {
            legacy.remove(key);
        }
        let _ = write_json(&path, &legacy);
    }
}

fn parse_document(bytes: &[u8]) -> Result<Document, String> {
    if bytes.len() > MAX_STATE_BYTES {
        return Err("STORAGE_CAPACITY_EXCEEDED:read".into());
    }
    let raw: Value = serde_json::from_slice(bytes).map_err(|_| "STORAGE_CORRUPT:read")?;
    if raw.get("formatVersion").and_then(Value::as_u64) != Some(u64::from(FORMAT_VERSION)) {
        return Err("STORAGE_UNSUPPORTED_VERSION:read".into());
    }
    let document: Document =
        serde_json::from_value(raw).map_err(|_| "STORAGE_CORRUPT:read".to_string())?;
    if document.revision > 9_007_199_254_740_991 {
        return Err("STORAGE_CORRUPT:revision".into());
    }
    for key in ROOT_DOMAINS {
        if !document.imports.contains_key(key) {
            return Err("STORAGE_CORRUPT:imports".into());
        }
    }
    for (key, value) in &document.records {
        if key == "__metadataRevision" || key == "downloadHistoryNextId" {
            if value
                .as_u64()
                .filter(|id| *id <= 9_007_199_254_740_991)
                .is_none()
            {
                return Err("STORAGE_CORRUPT:records".into());
            }
        } else if !value.is_object() {
            return Err("STORAGE_CORRUPT:records".into());
        }
    }
    if document.imports.contains_key("downloadHistory") {
        let history = document
            .records
            .get("downloadHistory")
            .and_then(Value::as_object)
            .ok_or("STORAGE_CORRUPT:download_history")?;
        if history.len() > MAX_DOWNLOAD_HISTORY_RECORDS || next_history_id(history).is_err() {
            return Err("STORAGE_CORRUPT:download_history".into());
        }
        if document
            .records
            .get("downloadHistoryNextId")
            .and_then(Value::as_u64)
            .is_none()
        {
            return Err("STORAGE_CORRUPT:download_history_next_id".into());
        }
    }
    if document.imports.contains_key("tasks") {
        let tasks = document
            .records
            .get("tasks")
            .and_then(Value::as_object)
            .ok_or("STORAGE_CORRUPT:tasks")?;
        if tasks.len() > MAX_TASKS {
            return Err("STORAGE_CORRUPT:tasks".into());
        }
        for (id, task) in tasks {
            validate_task(id, task)?;
        }
    }
    Ok(document)
}

fn validate_history(history: &Value, id: u64) -> Result<(), String> {
    let object = history
        .as_object()
        .ok_or("STORAGE_INVALID_INPUT:download_history")?;
    if object.get("id").and_then(Value::as_u64) != Some(id)
        || !object.get("downloadStatus").is_some_and(Value::is_string)
    {
        return Err("STORAGE_INVALID_INPUT:download_history".into());
    }
    Ok(())
}

fn history_map(histories: Vec<Value>) -> Result<Map<String, Value>, String> {
    if histories.len() > MAX_DOWNLOAD_HISTORY_RECORDS {
        return Err("STORAGE_CAPACITY_EXCEEDED:download_history".into());
    }
    let mut result = Map::new();
    for history in histories {
        let id = history
            .get("id")
            .and_then(Value::as_u64)
            .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
            .ok_or("STORAGE_INVALID_INPUT:download_history_id")?;
        validate_history(&history, id)?;
        if result.insert(id.to_string(), history).is_some() {
            return Err("STORAGE_INVALID_INPUT:duplicate_download_history".into());
        }
    }
    Ok(result)
}

fn next_history_id(histories: &Map<String, Value>) -> Result<u64, String> {
    histories
        .keys()
        .map(|id| id.parse::<u64>().map_err(|_| "STORAGE_CORRUPT:history_id"))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| "STORAGE_CAPACITY_EXCEEDED:history_id".into())
}

fn import_legacy(directory: &Path) -> Result<Document, String> {
    match fs::metadata(directory.join("storage.sqlite3")) {
        Ok(_) => return Err("STORAGE_MIGRATION_REQUIRED:legacy_sqlite".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("STORAGE_UNAVAILABLE:legacy_sqlite".into()),
    }
    let legacy_path = directory.join("storage.json");
    let legacy = match fs::read(&legacy_path) {
        Ok(bytes) => serde_json::from_slice::<Map<String, Value>>(&bytes)
            .map_err(|_| "STORAGE_CORRUPT:legacy_json")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(_) => return Err("STORAGE_UNAVAILABLE:legacy_json".into()),
    };
    let mut records = Map::new();
    let mut imports = Map::new();
    for key in ROOT_DOMAINS {
        let value = legacy.get(key).cloned().unwrap_or(Value::Null);
        if !value.is_null() {
            if key == "__metadataRevision" {
                if value
                    .as_u64()
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .is_none()
                {
                    return Err("STORAGE_CORRUPT:legacy_revision".into());
                }
            } else if !value.is_object() {
                return Err("STORAGE_CORRUPT:legacy_record".into());
            }
            records.insert(key.into(), value);
        }
        imports.insert(
            key.into(),
            serde_json::to_value(ImportMarker {
                source: "storage.json".into(),
                source_version: 0,
            })
            .map_err(|_| "STORAGE_UNAVAILABLE:serialize")?,
        );
    }
    Ok(Document {
        format_version: FORMAT_VERSION,
        revision: 0,
        operation_id: 0,
        imports,
        records,
    })
}

fn validate_task(id: &str, task: &Value) -> Result<(), String> {
    let object = task.as_object().ok_or("STORAGE_CORRUPT:task")?;
    if object.get("id").and_then(Value::as_str) != Some(id)
        || !object.get("kind").is_some_and(Value::is_string)
        || !object.get("resourceId").is_some_and(Value::is_string)
        || !object.get("idempotencyKey").is_some_and(Value::is_string)
        || !object.get("payloadVersion").is_some_and(Value::is_u64)
        || !object.get("payload").is_some_and(Value::is_object)
        || !object.get("runAt").is_some_and(Value::is_u64)
        || !matches!(
            object.get("state").and_then(Value::as_str),
            Some(
                "queued"
                    | "scheduled"
                    | "running"
                    | "retry_wait"
                    | "succeeded"
                    | "failed"
                    | "uncertain"
                    | "cancelled"
            )
        )
    {
        return Err("STORAGE_CORRUPT:task".into());
    }
    if object.get("state").and_then(Value::as_str) == Some("running")
        && (!object.get("leaseOwner").is_some_and(Value::is_string)
            || !object.get("leaseExpiresAt").is_some_and(Value::is_u64))
    {
        return Err("STORAGE_CORRUPT:task_lease".into());
    }
    if contains_sensitive_key(&task["payload"]) {
        return Err("STORAGE_INVALID_INPUT:task_credentials".into());
    }
    Ok(())
}

fn contains_sensitive_key(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let normalized = key.to_ascii_lowercase();
            [
                "password",
                "token",
                "secret",
                "cookie",
                "authorization",
                "apikey",
            ]
            .iter()
            .any(|sensitive| normalized.contains(sensitive))
                || contains_sensitive_key(value)
        }),
        Value::Array(items) => items.iter().any(contains_sensitive_key),
        _ => false,
    }
}

fn safe_task_error(error: &Value) -> Value {
    match error.as_str() {
        Some(code)
            if code.starts_with("TASK_")
                && code.len() <= 80
                && code
                    .chars()
                    .all(|character| character.is_ascii_uppercase() || character == '_') =>
        {
            Value::from(code)
        }
        Some(_) => Value::from("TASK_ERROR"),
        None => Value::Null,
    }
}

fn write_document(path: &Path, document: &Document) -> Result<(), String> {
    let bytes = serde_json::to_vec(document).map_err(|_| "STORAGE_UNAVAILABLE:serialize")?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err("STORAGE_CAPACITY_EXCEEDED:write".into());
    }
    write_bytes(path, &bytes)
}

fn write_json(path: &Path, value: &Map<String, Value>) -> Result<(), String> {
    #[cfg(test)]
    if FAIL_NEXT_LEGACY_CLEANUP.with(|flag| flag.replace(false)) {
        return Err("STORAGE_UNAVAILABLE:legacy_cleanup".into());
    }
    let bytes = serde_json::to_vec(value).map_err(|_| "STORAGE_UNAVAILABLE:serialize")?;
    write_bytes(path, &bytes)
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("STORAGE_UNAVAILABLE:write")?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|_| "STORAGE_UNAVAILABLE:write")?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "STORAGE_UNAVAILABLE:write")?;
    temporary
        .persist(path)
        .map_err(|_| "STORAGE_UNAVAILABLE:replace")?;
    #[cfg(test)]
    if FAIL_NEXT_DIRECTORY_SYNC.with(|flag| flag.replace(false)) {
        return Err("STORAGE_COMMIT_UNCERTAIN:sync".into());
    }
    sync_directory(parent).map_err(|_| "STORAGE_COMMIT_UNCERTAIN:sync".into())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn lock_exclusive(file: &File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        Ok(())
    } else {
        Err("STORAGE_LOCKED:another_process".into())
    }
}

#[cfg(not(unix))]
fn lock_exclusive(_file: &File) -> Result<(), String> {
    Err("STORAGE_UNAVAILABLE:process_lock_unsupported".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ap_06_imports_json_once_and_never_revives_an_empty_domain() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = directory.path().join("storage.json");
        fs::write(
            &legacy,
            br#"{"config":{"secret":"SENSITIVE_SENTINEL"},"userInfo":{"a":{"id":1}},"other":"keep"}"#,
        )
        .unwrap();
        let mut repository = Repository::open(directory.path()).unwrap();
        assert_eq!(repository.read("config")["secret"], "SENSITIVE_SENTINEL");
        assert_eq!(repository.read("userInfo")["a"]["id"], 1);
        assert!(repository.status().to_string().contains("storage.json"));
        assert!(!repository
            .status()
            .to_string()
            .contains("SENSITIVE_SENTINEL"));
        let mut records = repository.records().clone();
        records.insert("userInfo".into(), json!({}));
        repository.commit(records).unwrap();
        drop(repository);
        fs::write(&legacy, br#"{"userInfo":{"a":{"id":2}},"other":"keep"}"#).unwrap();
        let reopened = Repository::open(directory.path()).unwrap();
        assert_eq!(reopened.read("userInfo"), json!({}));
        assert_eq!(reopened.read("config")["secret"], "SENSITIVE_SENTINEL");
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&legacy).unwrap()).unwrap()["other"],
            "keep"
        );
    }

    #[test]
    fn ap_06_legacy_sqlite_blocks_stale_json_import_without_touching_sources() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("storage.json"),
            br#"{"config":{"old":"must-not-return"},"metadata":{"sites":{"old":{}}}}"#,
        )
        .unwrap();
        let sqlite_path = directory.path().join("storage.sqlite3");
        fs::write(&sqlite_path, b"existing data").unwrap();
        assert_eq!(
            Repository::open(directory.path()).err().unwrap(),
            "STORAGE_MIGRATION_REQUIRED:legacy_sqlite"
        );
        assert_eq!(fs::read(&sqlite_path).unwrap(), b"existing data");
        assert!(!directory.path().join("app-state.json").exists());
        fs::remove_file(&sqlite_path).unwrap();
        let repository = Repository::open(directory.path()).unwrap();
        assert_eq!(repository.read("config")["old"], "must-not-return");
        drop(repository);
        fs::write(&sqlite_path, b"existing data").unwrap();
        let repository = Repository::open(directory.path()).unwrap();
        assert_eq!(repository.read("config")["old"], "must-not-return");
        assert_eq!(fs::read(&sqlite_path).unwrap(), b"existing data");
    }

    #[test]
    fn ap_06_invalid_sources_and_future_files_are_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = directory.path().join("storage.json");
        let target = directory.path().join("app-state.json");
        fs::write(&legacy, b"{invalid").unwrap();
        assert!(Repository::open(directory.path()).is_err());
        assert!(!target.exists());
        fs::write(&target, br#"{"formatVersion":99}"#).unwrap();
        let before = fs::read(&target).unwrap();
        assert!(Repository::open(directory.path()).is_err());
        assert_eq!(fs::read(&target).unwrap(), before);
    }

    #[test]
    fn ap_06_reconciles_commit_after_directory_sync_failure() {
        let directory = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(directory.path()).unwrap();
        let mut records = repository.records().clone();
        records.insert("config".into(), json!({"version":1}));
        FAIL_NEXT_DIRECTORY_SYNC.with(|flag| flag.set(true));
        assert_eq!(
            repository.commit(records.clone()).unwrap_err(),
            "STORAGE_COMMIT_UNCERTAIN:sync"
        );
        assert_eq!(repository.status()["commitUncertain"], true);
        assert_eq!(repository.read("config"), Value::Null);
        assert_eq!(
            repository.commit(records).unwrap_err(),
            "STORAGE_COMMIT_UNCERTAIN:blocked"
        );
        assert!(repository.reconcile().unwrap());
        assert_eq!(repository.read("config")["version"], 1);
        assert_eq!(repository.status()["commitUncertain"], false);
        drop(repository);
        assert_eq!(
            Repository::open(directory.path()).unwrap().read("config")["version"],
            1
        );
    }

    #[test]
    fn ap_06_retries_legacy_cleanup_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = directory.path().join("storage.json");
        fs::write(&legacy, br#"{"config":{"version":1},"other":"keep"}"#).unwrap();
        drop(Repository::open(directory.path()).unwrap());
        FAIL_NEXT_LEGACY_CLEANUP.with(|flag| flag.set(true));
        let repository = Repository::open(directory.path()).unwrap();
        assert_eq!(repository.status()["cleanupPending"], true);
        assert_eq!(repository.read("config")["version"], 1);
        drop(repository);
        let repository = Repository::open(directory.path()).unwrap();
        assert_eq!(repository.status()["cleanupPending"], false);
        let remaining: Value = serde_json::from_slice(&fs::read(&legacy).unwrap()).unwrap();
        assert_eq!(remaining, json!({"other":"keep"}));
    }

    #[cfg(unix)]
    #[test]
    fn ap_06_process_lock_blocks_second_writer() {
        let directory = tempfile::tempdir().unwrap();
        let first = Repository::open(directory.path()).unwrap();
        assert!(Repository::open(directory.path())
            .err()
            .unwrap()
            .starts_with("STORAGE_LOCKED"));
        drop(first);
        assert!(Repository::open(directory.path()).is_ok());
    }

    #[test]
    fn ap_07_history_import_and_conditional_save_survive_restart() {
        let directory = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(directory.path()).unwrap();
        assert!(repository
            .import_download_history(vec![json!({"id":7,"downloadStatus":"pending"})])
            .unwrap());
        assert!(!repository
            .import_download_history(vec![json!({"id":8,"downloadStatus":"failed"})])
            .unwrap());
        let base = repository.get_download_history(7).unwrap().unwrap();
        assert!(repository
            .save_download_history_if_unchanged(
                7,
                base.clone(),
                json!({"id":7,"downloadStatus":"completed"}),
            )
            .unwrap());
        assert!(repository
            .save_download_history_if_unchanged(7, base, json!({"id":7,"downloadStatus":"failed"}),)
            .unwrap_err()
            .starts_with("STORAGE_CONFLICT"));
        assert_eq!(
            repository
                .insert_download_history(json!({"downloadStatus":"pending"}))
                .unwrap(),
            8
        );
        assert_eq!(repository.clear_download_history().unwrap(), 2);
        drop(repository);
        let reopened = Repository::open(directory.path()).unwrap();
        assert!(reopened.download_history_imported());
        assert!(reopened.list_download_history().unwrap().is_empty());
    }

    #[test]
    fn ap_07_invalid_import_does_not_commit_marker_or_change_legacy_source() {
        let directory = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(directory.path()).unwrap();
        let before = fs::read(directory.path().join("app-state.json")).unwrap();
        assert!(repository
            .import_download_history(vec![
                json!({"id":1,"downloadStatus":"pending"}),
                json!({"id":1,"downloadStatus":"failed"}),
            ])
            .is_err());
        assert!(!repository.download_history_imported());
        assert_eq!(
            fs::read(directory.path().join("app-state.json")).unwrap(),
            before
        );
    }

    #[test]
    fn ap_09_claim_respects_resource_limit_and_expired_lease_becomes_uncertain() {
        let directory = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(directory.path()).unwrap();
        repository.initialize_tasks().unwrap();
        repository
            .import_download_history(vec![
                json!({"id":1,"downloadStatus":"pending","siteId":"site-a"}),
                json!({"id":2,"downloadStatus":"pending","siteId":"site-a"}),
            ])
            .unwrap();
        repository.enqueue_redownload(1, 0, 100).unwrap();
        repository.enqueue_redownload(2, 0, 100).unwrap();
        let first = repository.claim_due("owner-a", 100).unwrap().unwrap();
        assert_eq!(first["kind"], "redownload");
        assert!(repository.claim_due("owner-b", 100).unwrap().is_none());
        drop(repository);
        let mut reopened = Repository::open(directory.path()).unwrap();
        let second = reopened.claim_due("owner-b", 120_101).unwrap().unwrap();
        assert_ne!(second["id"], first["id"]);
        let uncertain = reopened
            .task_status()
            .unwrap()
            .into_iter()
            .find(|task| task["id"] == first["id"])
            .unwrap();
        assert_eq!(uncertain["state"], "uncertain");
        assert!(!reopened
            .renew_task(first["id"].as_str().unwrap(), "owner-a", 120_101)
            .unwrap());
    }

    #[test]
    fn ap_09_unknown_payload_version_fails_without_claiming_or_recreating_task() {
        let directory = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(directory.path()).unwrap();
        repository.initialize_tasks().unwrap();
        repository
            .import_download_history(vec![json!({"id":1,"downloadStatus":"pending"})])
            .unwrap();
        repository.enqueue_redownload(1, 0, 100).unwrap();
        let mut records = repository.records().clone();
        records["tasks"]["redownload:1"]["payloadVersion"] = json!(99);
        repository.commit(records).unwrap();
        assert!(repository.claim_due("owner", 100).unwrap().is_none());
        assert_eq!(repository.task_status().unwrap()[0]["state"], "failed");
        drop(repository);
        let mut repository = Repository::open(directory.path()).unwrap();
        repository.initialize_tasks().unwrap();
        repository.enqueue_redownload(1, 0, 200).unwrap();
        assert_eq!(repository.task_status().unwrap()[0]["state"], "failed");
    }

    #[test]
    fn ap_09_failed_claim_commit_does_not_return_task_for_execution() {
        let directory = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(directory.path()).unwrap();
        repository.initialize_tasks().unwrap();
        repository
            .import_download_history(vec![json!({"id":1,"downloadStatus":"pending"})])
            .unwrap();
        repository.enqueue_redownload(1, 0, 100).unwrap();
        FAIL_NEXT_DIRECTORY_SYNC.with(|flag| flag.set(true));
        assert_eq!(
            repository.claim_due("owner", 100).unwrap_err(),
            "STORAGE_COMMIT_UNCERTAIN:sync"
        );
        assert!(repository.reconcile().unwrap());
        assert_eq!(repository.task_status().unwrap()[0]["state"], "running");
        repository.release_owner("owner", 101).unwrap();
        assert_eq!(repository.task_status().unwrap()[0]["state"], "uncertain");
    }

    #[test]
    fn ap_10_cancel_request_and_manual_resolution_are_distinct() {
        let directory = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(directory.path()).unwrap();
        repository.initialize_tasks().unwrap();
        repository
            .import_download_history(vec![json!({"id":1,"downloadStatus":"pending"})])
            .unwrap();
        repository.enqueue_redownload(1, 0, 100).unwrap();
        let task = repository.claim_due("owner-a", 100).unwrap().unwrap();
        let id = task["id"].as_str().unwrap();
        assert!(repository.request_task_cancel(id, 101).unwrap());
        let status = repository.task_status().unwrap();
        assert_eq!(status[0]["state"], "running");
        assert_eq!(status[0]["cancelRequested"], true);
        repository.release_owner("owner-a", 102).unwrap();
        assert_eq!(repository.task_status().unwrap()[0]["state"], "uncertain");
        repository.resolve_task(id, "retry", 103).unwrap();
        assert_eq!(repository.task_status().unwrap()[0]["attempt"], 0);
        let task = repository.claim_due("owner-b", 103).unwrap().unwrap();
        assert_eq!(task["attempt"], 1);
        repository.release_owner("owner-b", 104).unwrap();
        repository.resolve_task(id, "cancelled", 105).unwrap();
        assert_eq!(repository.task_status().unwrap()[0]["state"], "cancelled");
        assert!(repository.resolve_task(id, "retry", 106).is_err());
    }

    #[test]
    fn ap_10_confirmed_remote_backup_schedules_a_new_cycle_with_new_filename() {
        let directory = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(directory.path()).unwrap();
        repository.initialize_tasks().unwrap();
        let mut records = repository.records().clone();
        records.insert(
            "metadata".into(),
            json!({"backupServers":{"remote":{"enabled":true,"backupInterval":1}}}),
        );
        repository.commit(records).unwrap();
        repository.ensure_periodic_tasks(100).unwrap();
        let first = &repository.records()["tasks"]["periodic:backup:remote"];
        assert_eq!(
            first["payload"]["backupFilename"],
            "PTD_backup_task_120100.zip"
        );
        let mut records = repository.records().clone();
        records["tasks"]["periodic:backup:remote"]["state"] = json!("uncertain");
        repository.commit(records).unwrap();
        repository
            .resolve_task("periodic:backup:remote", "succeeded", 200)
            .unwrap();
        let next = &repository.records()["tasks"]["periodic:backup:remote"];
        assert_eq!(next["state"], "scheduled");
        assert_eq!(next["runAt"], 600_200);
        assert_eq!(
            next["payload"]["backupFilename"],
            "PTD_backup_task_600200.zip"
        );
        assert_eq!(
            repository.task_status().unwrap()[0]["backupFilename"],
            "PTD_backup_task_600200.zip"
        );
    }

    #[test]
    fn ap_10_legacy_backup_without_identity_is_only_backfilled_before_execution() {
        let directory = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(directory.path()).unwrap();
        repository.initialize_tasks().unwrap();
        let mut records = repository.records().clone();
        records.insert(
            "metadata".into(),
            json!({"backupServers":{"fresh":{"enabled":true,"backupInterval":1},"old":{"enabled":true,"backupInterval":1}}}),
        );
        repository.commit(records).unwrap();
        repository.ensure_periodic_tasks(100).unwrap();
        let mut records = repository.records().clone();
        records["tasks"]["periodic:backup:fresh"]["payload"] = json!({"backupServerId":"fresh"});
        records["tasks"]["periodic:backup:old"]["payload"] = json!({"backupServerId":"old"});
        records["tasks"]["periodic:backup:old"]["state"] = json!("running");
        records["tasks"]["periodic:backup:old"]["attempt"] = json!(1);
        records["tasks"]["periodic:backup:old"]["leaseOwner"] = json!("prior-owner");
        records["tasks"]["periodic:backup:old"]["leaseExpiresAt"] = json!(200);
        repository.commit(records).unwrap();
        drop(repository);
        let mut repository = Repository::open(directory.path()).unwrap();
        repository.initialize_tasks().unwrap();
        let tasks = &repository.records()["tasks"];
        assert_eq!(
            tasks["periodic:backup:fresh"]["payload"]["backupFilename"],
            "PTD_backup_task_120100.zip"
        );
        assert_eq!(tasks["periodic:backup:old"]["state"], "uncertain");
        assert_eq!(
            tasks["periodic:backup:old"]["lastError"],
            "TASK_BACKUP_IDENTITY_MISSING"
        );
        assert!(repository.claim_due("new-owner", 200).unwrap().is_none());
        repository
            .resolve_task("periodic:backup:old", "retry", 300)
            .unwrap();
        assert_eq!(
            repository.records()["tasks"]["periodic:backup:old"]["payload"]["backupFilename"],
            "PTD_backup_task_300.zip"
        );
    }

    #[test]
    fn ap_07_capacity_measurement() {
        let directory = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(directory.path()).unwrap();
        let histories: Vec<_> = (1..=5_000)
            .map(|id| json!({"id":id,"downloadStatus":"completed","title":"x".repeat(1_024)}))
            .collect();
        let start = std::time::Instant::now();
        repository.import_download_history(histories).unwrap();
        let import_ms = start.elapsed().as_millis();
        let base = repository.get_download_history(1).unwrap().unwrap();
        let start = std::time::Instant::now();
        repository
            .save_download_history_if_unchanged(
                1,
                base,
                json!({"id":1,"downloadStatus":"failed","title":"x".repeat(1_024)}),
            )
            .unwrap();
        let update_ms = start.elapsed().as_millis();
        let file_bytes = fs::metadata(directory.path().join("app-state.json"))
            .unwrap()
            .len();
        #[cfg(target_os = "macos")]
        let peak_bytes = {
            let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
            assert_eq!(
                unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
                0
            );
            unsafe { usage.assume_init() }.ru_maxrss as u64
        };
        #[cfg(not(target_os = "macos"))]
        let peak_bytes = 0;
        eprintln!("AP-07: records=5000 fileBytes={file_bytes} importMs={import_ms} updateMs={update_ms} processPeakBytes={peak_bytes}");
        assert!(file_bytes < MAX_STATE_BYTES as u64);
    }

    #[test]
    fn ap_07_capacity_rejection_preserves_previous_file() {
        let directory = tempfile::tempdir().unwrap();
        let mut repository = Repository::open(directory.path()).unwrap();
        let path = directory.path().join("app-state.json");
        let before = fs::read(&path).unwrap();
        let oversized = json!({
            "id":1,
            "downloadStatus":"pending",
            "title":"x".repeat(MAX_STATE_BYTES),
        });
        assert!(repository
            .import_download_history(vec![oversized])
            .unwrap_err()
            .starts_with("STORAGE_CAPACITY_EXCEEDED"));
        assert!(!repository.download_history_imported());
        assert_eq!(fs::read(path).unwrap(), before);
    }
}
