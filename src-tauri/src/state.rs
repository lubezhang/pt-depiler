use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cookie_store::CookieStore;
use reqwest::{redirect::Policy, Client};
use reqwest_cookie_store::CookieStoreMutex;
use tauri::Manager;
use tempfile::NamedTempFile;
use tokio::sync::oneshot;

const COOKIE_FILE_NAME: &str = "cookies.v2.json";
const EARLY_HTTP_CANCELLATION_TTL: Duration = Duration::from_secs(30);
#[cfg(debug_assertions)]
const E2E_DATA_DIR_ENV: &str = "PTD_E2E_DATA_DIR";

#[derive(Default)]
struct HttpCancellationRegistry {
    active: HashMap<String, oneshot::Sender<()>>,
    early: HashMap<String, Instant>,
}

struct CookiePersistence {
    path: PathBuf,
}

impl CookiePersistence {
    fn load(path: PathBuf) -> Result<(Self, CookieStore), String> {
        let persistence = Self { path };
        let plaintext = match fs::read(&persistence.path) {
            Ok(plaintext) => plaintext,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((persistence, CookieStore::default()));
            }
            Err(_) => return Err("COOKIE_STORE_LOAD_FAILED".to_string()),
        };
        let store = cookie_store::serde::json::load(Cursor::new(plaintext))
            .map_err(|_| "COOKIE_STORE_LOAD_FAILED")?;
        Ok((persistence, store))
    }

    fn persist(&self, store: &CookieStore) -> Result<(), String> {
        let parent = self.path.parent().ok_or("Cookie 文件缺少父目录")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;

        let mut plaintext = Vec::new();
        cookie_store::serde::json::save_incl_expired_and_nonpersistent(store, &mut plaintext)
            .map_err(|error| error.to_string())?;

        let mut temporary = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        temporary
            .write_all(&plaintext)
            .and_then(|_| temporary.flush())
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|error| error.to_string())?;
        temporary
            .persist(&self.path)
            .map_err(|error| error.error.to_string())?;
        sync_directory(parent)?;
        Ok(())
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CookieRecovery {
    id: String,
    before: Vec<u8>,
    after: Vec<u8>,
}

fn load_cookie_mirror(bytes: &[u8]) -> Result<CookieStore, String> {
    cookie_store::serde::json::load(Cursor::new(bytes))
        .map_err(|_| "STORAGE_CORRUPT:cookie_mirror".into())
}

fn write_cookie_recovery(path: &Path, recovery: &CookieRecovery) -> Result<(), String> {
    let parent = path.parent().ok_or("STORAGE_UNAVAILABLE:cookie_path")?;
    fs::create_dir_all(parent).map_err(|_| "STORAGE_UNAVAILABLE:cookie_directory")?;
    let mut temporary =
        NamedTempFile::new_in(parent).map_err(|_| "STORAGE_UNAVAILABLE:cookie_prepare")?;
    serde_json::to_writer(&mut temporary, recovery)
        .map_err(|_| "STORAGE_UNAVAILABLE:cookie_prepare")?;
    temporary
        .flush()
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "STORAGE_UNAVAILABLE:cookie_prepare")?;
    temporary
        .persist(path)
        .map_err(|_| "STORAGE_UNAVAILABLE:cookie_prepare")?;
    sync_directory(parent)
}

/// 全局应用状态。Cookie Store 由所有请求共享，并按 RFC 6265 的 domain/path 规则隔离。
pub struct AppState {
    pub(crate) no_redirect_client: Client,
    pub cookie_store: Arc<CookieStoreMutex>,
    http_cancellations: Mutex<HttpCancellationRegistry>,
    site_login_target: Mutex<Option<String>>,
    persistence: Option<CookiePersistence>,
}

impl AppState {
    /// 仅用于测试和无持久化工具上下文。桌面应用必须使用 `load`。
    pub fn new() -> Self {
        Self::from_store(CookieStore::default(), None, false)
    }

    pub fn load(app: &tauri::AppHandle) -> Result<Self, String> {
        #[cfg(debug_assertions)]
        if let Some(app_data_dir) = load_e2e_data_dir()? {
            eprintln!(
                "PT-depiler debug E2E Cookie Store is active at {}",
                app_data_dir.display()
            );
            return Self::with_persistence(app_data_dir.join(COOKIE_FILE_NAME), false);
        }

        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        Self::with_persistence(app_data_dir.join(COOKIE_FILE_NAME), false)
    }

    fn with_persistence(path: PathBuf, use_system_proxy: bool) -> Result<Self, String> {
        let (persistence, store) = CookiePersistence::load(path)?;
        Ok(Self::from_store(store, Some(persistence), use_system_proxy))
    }

    #[cfg(test)]
    pub(crate) fn persistent_for_test(path: PathBuf) -> Self {
        Self::with_persistence(path, false).expect("load test Cookie Store")
    }

    fn from_store(
        store: CookieStore,
        persistence: Option<CookiePersistence>,
        use_system_proxy: bool,
    ) -> Self {
        let cookie_store = Arc::new(CookieStoreMutex::new(store));
        let mut no_redirect_client_builder = Client::builder()
            .cookie_provider(Arc::clone(&cookie_store))
            .redirect(Policy::none());
        if !use_system_proxy {
            no_redirect_client_builder = no_redirect_client_builder.no_proxy();
        }
        let no_redirect_client = no_redirect_client_builder
            .build()
            .expect("failed to build no-redirect reqwest client");
        Self {
            no_redirect_client,
            cookie_store,
            http_cancellations: Mutex::new(HttpCancellationRegistry::default()),
            site_login_target: Mutex::new(None),
            persistence,
        }
    }

    pub(crate) fn ensure_recovery_ready(&self) -> Result<(), String> {
        if let Some(persistence) = &self.persistence {
            if persistence
                .path
                .with_file_name("cookies.v2.restore.json")
                .exists()
            {
                return Err("STORAGE_RECOVERY_REQUIRED:cookies".into());
            }
        }
        Ok(())
    }

    pub(crate) fn cookie_snapshot(&self) -> Result<serde_json::Value, String> {
        self.ensure_recovery_ready()?;
        let store = self
            .cookie_store
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:cookie_lock")?;
        let cookies = store
            .iter_any()
            .map(crate::http::cookie_to_info)
            .collect::<Result<Vec<_>, _>>()?;
        serde_json::to_value(cookies).map_err(|_| "STORAGE_UNAVAILABLE:cookies".into())
    }

    pub(crate) fn restore_with_cookies(
        &self,
        id: &str,
        cookies: Vec<crate::http::CookieInfo>,
        hosts: &[String],
        mut commit: impl FnMut(bool) -> Result<(), String>,
    ) -> Result<(), String> {
        self.ensure_recovery_ready()?;
        let persistence = self
            .persistence
            .as_ref()
            .ok_or("STORAGE_UNAVAILABLE:cookie_persistence")?;
        let mut store = self
            .cookie_store
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:cookie_lock")?;
        let mut after = store.clone();
        for cookie in cookies {
            if !crate::http::cookie_owned_by_sites(&cookie, hosts)
                || cookie.name.is_empty()
                || cookie
                    .name
                    .bytes()
                    .any(|byte| byte <= 32 || byte >= 127 || b"()<>@,;:\\\"/[]?={}".contains(&byte))
                || cookie.value.chars().any(|character| character.is_control())
                || cookie.path.chars().any(|character| character.is_control())
                || !cookie.path.starts_with('/')
                || cookie.domain.contains(['/', ':', '@'])
                || cookie
                    .expiration_date
                    .is_some_and(|expiration| !expiration.is_finite())
            {
                return Err("STORAGE_INVALID_INPUT:restore_cookie".into());
            }
            crate::http::store_cookie_info(&mut after, cookie)?;
        }
        let mut before_bytes = Vec::new();
        let mut after_bytes = Vec::new();
        cookie_store::serde::json::save_incl_expired_and_nonpersistent(&store, &mut before_bytes)
            .map_err(|_| "STORAGE_UNAVAILABLE:cookie_serialize")?;
        cookie_store::serde::json::save_incl_expired_and_nonpersistent(&after, &mut after_bytes)
            .map_err(|_| "STORAGE_UNAVAILABLE:cookie_serialize")?;
        let recovery = CookieRecovery {
            id: id.into(),
            before: before_bytes,
            after: after_bytes,
        };
        let recovery_path = persistence.path.with_file_name("cookies.v2.restore.json");
        write_cookie_recovery(&recovery_path, &recovery)?;
        // Keep the store lock through the JSON and Cookie commits. Failed phases
        // retain both mirrors; startup decides from the authoritative JSON journal.
        commit(false)?;
        persistence.persist(&after)?;
        *store = after;
        commit(true)?;
        fs::remove_file(&recovery_path).map_err(|_| "STORAGE_UNAVAILABLE:cookie_cleanup")?;
        sync_directory(
            recovery_path
                .parent()
                .ok_or("STORAGE_UNAVAILABLE:cookie_path")?,
        )
    }

    pub(crate) fn cookie_recovery_id(&self) -> Result<Option<String>, String> {
        let Some(persistence) = &self.persistence else {
            return Ok(None);
        };
        match fs::read(persistence.path.with_file_name("cookies.v2.restore.json")) {
            Ok(bytes) => serde_json::from_slice::<CookieRecovery>(&bytes)
                .map(|recovery| Some(recovery.id))
                .map_err(|_| "STORAGE_CORRUPT:cookie_recovery".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("STORAGE_UNAVAILABLE:cookie_recovery".into()),
        }
    }

    pub(crate) fn recover_cookies(
        &self,
        id: Option<&str>,
        required: bool,
        forward: bool,
        finish: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let Some(persistence) = &self.persistence else {
            return finish();
        };
        let path = persistence.path.with_file_name("cookies.v2.restore.json");
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if required {
                    return Err("STORAGE_RECOVERY_REQUIRED:cookie_mirror_missing".into());
                }
                return finish();
            }
            Err(_) => return Err("STORAGE_UNAVAILABLE:cookie_recovery".into()),
        };
        let recovery: CookieRecovery =
            serde_json::from_slice(&bytes).map_err(|_| "STORAGE_CORRUPT:cookie_recovery")?;
        if id.is_some_and(|id| id != recovery.id) {
            return Err("STORAGE_CONFLICT:cookie_recovery_id".into());
        }
        let before = load_cookie_mirror(&recovery.before)?;
        let after = load_cookie_mirror(&recovery.after)?;
        let mut store = self
            .cookie_store
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:cookie_lock")?;
        let canonical = |store: &CookieStore| -> Result<serde_json::Value, String> {
            let mut cookies = store
                .iter_any()
                .map(crate::http::cookie_to_info)
                .collect::<Result<Vec<_>, _>>()?;
            cookies
                .sort_by(|a, b| (&a.domain, &a.path, &a.name).cmp(&(&b.domain, &b.path, &b.name)));
            serde_json::to_value(cookies).map_err(|_| "STORAGE_UNAVAILABLE:cookie_serialize".into())
        };
        let current = canonical(&store)?;
        if current != canonical(&before)? && current != canonical(&after)? {
            return Err("STORAGE_CONFLICT:cookie_manual_recovery".into());
        }
        let target = if forward { after } else { before };
        persistence.persist(&target)?;
        *store = target;
        finish()?;
        fs::remove_file(&path).map_err(|_| "STORAGE_UNAVAILABLE:cookie_cleanup")?;
        sync_directory(path.parent().ok_or("STORAGE_UNAVAILABLE:cookie_path")?)
    }

    pub fn persist_cookies(&self) -> Result<(), String> {
        self.ensure_recovery_ready()?;
        let Some(persistence) = &self.persistence else {
            return Ok(());
        };
        let store = self
            .cookie_store
            .lock()
            .map_err(|error| error.to_string())?;
        persistence.persist(&store)
    }

    pub(crate) fn commit_with_cookie_cleanup<T>(
        &self,
        previous: &[String],
        next: &[String],
        commit: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.ensure_recovery_ready()?;
        let mut store = self
            .cookie_store
            .lock()
            .map_err(|_| "STORAGE_UNAVAILABLE:cookie_lock")?;
        let matches = |cookie: &crate::http::CookieInfo, hosts: &[String]| {
            hosts.iter().any(|host| {
                let domain = cookie.domain.trim_start_matches('.');
                host == domain || !cookie.host_only && host.ends_with(&format!(".{domain}"))
            })
        };
        let removed = store
            .iter_any()
            .map(crate::http::cookie_to_info)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|cookie| matches(cookie, previous) && !matches(cookie, next))
            .collect::<Vec<_>>();
        if removed.is_empty() {
            return commit();
        }
        let mut proposed = store.clone();
        for cookie in &removed {
            proposed.remove(
                cookie.domain.trim_start_matches('.'),
                &cookie.path,
                &cookie.name,
            );
        }
        if let Some(persistence) = &self.persistence {
            persistence.persist(&proposed)?;
        }
        match commit() {
            Ok(result) => {
                *store = proposed;
                Ok(result)
            }
            Err(error) => {
                if let Some(persistence) = &self.persistence {
                    persistence.persist(&store)?;
                }
                Err(error)
            }
        }
    }

    pub(crate) fn set_site_login_target(&self, site_url: String) -> Result<(), String> {
        *self
            .site_login_target
            .lock()
            .map_err(|error| error.to_string())? = Some(site_url);
        Ok(())
    }

    pub(crate) fn take_site_login_target(&self) -> Result<Option<String>, String> {
        Ok(self
            .site_login_target
            .lock()
            .map_err(|error| error.to_string())?
            .take())
    }

    pub(crate) fn register_http_request(
        &self,
        request_id: &str,
    ) -> Result<oneshot::Receiver<()>, String> {
        let mut registry = self
            .http_cancellations
            .lock()
            .map_err(|error| error.to_string())?;
        let now = Instant::now();
        registry.early.retain(|_, cancelled_at| {
            now.duration_since(*cancelled_at) < EARLY_HTTP_CANCELLATION_TTL
        });

        let (sender, receiver) = oneshot::channel();
        if registry.early.remove(request_id).is_some() {
            drop(sender);
        } else if let Some(previous) = registry.active.insert(request_id.to_string(), sender) {
            let _ = previous.send(());
        }
        Ok(receiver)
    }

    pub(crate) fn cancel_http_request(&self, request_id: &str) -> Result<(), String> {
        let mut registry = self
            .http_cancellations
            .lock()
            .map_err(|error| error.to_string())?;
        let now = Instant::now();
        registry.early.retain(|_, cancelled_at| {
            now.duration_since(*cancelled_at) < EARLY_HTTP_CANCELLATION_TTL
        });
        if let Some(sender) = registry.active.remove(request_id) {
            let _ = sender.send(());
        } else {
            registry.early.insert(request_id.to_string(), now);
        }
        Ok(())
    }

    pub(crate) fn finish_http_request(&self, request_id: &str) {
        if let Ok(mut registry) = self.http_cancellations.lock() {
            registry.active.remove(request_id);
            registry.early.remove(request_id);
        }
    }
}

#[cfg(debug_assertions)]
fn load_e2e_data_dir() -> Result<Option<PathBuf>, String> {
    let Some(data_dir) = std::env::var_os(E2E_DATA_DIR_ENV) else {
        return Ok(None);
    };
    let data_dir = PathBuf::from(data_dir);
    if !data_dir.is_absolute() {
        return Err(format!("{E2E_DATA_DIR_ENV} 必须是绝对路径"));
    }
    fs::create_dir_all(&data_dir).map_err(|error| {
        format!(
            "无法创建 {E2E_DATA_DIR_ENV} 指定的目录 {}: {error}",
            data_dir.display()
        )
    })?;
    Ok(Some(data_dir))
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cookie::Cookie;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use url::Url;

    fn persistent_state(directory: &Path) -> AppState {
        AppState::with_persistence(directory.join(COOKIE_FILE_NAME), false)
            .expect("load test Cookie Store")
    }

    fn insert_cookie(state: &AppState, value: &str) {
        let url = Url::parse("https://tracker.example/account").expect("cookie URL");
        let cookie = Cookie::parse(format!(
            "session={value}; Path=/; Secure; HttpOnly; SameSite=Lax"
        ))
        .expect("valid cookie");
        state
            .cookie_store
            .lock()
            .expect("cookie store lock")
            .store_response_cookies(std::iter::once(cookie.into_owned()), &url);
    }

    #[test]
    fn persists_and_restores_session_cookies_as_json() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let state = persistent_state(directory.path());
        insert_cookie(&state, "plain-secret-value");
        state.persist_cookies().expect("persist cookies");

        let persisted = fs::read_to_string(directory.path().join(COOKIE_FILE_NAME))
            .expect("plain JSON cookie file");
        assert!(persisted.contains("plain-secret-value"));

        let restored = persistent_state(directory.path());
        let url = Url::parse("https://tracker.example/").expect("request URL");
        let values: Vec<_> = restored
            .cookie_store
            .lock()
            .expect("cookie store lock")
            .get_request_values(&url)
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        assert_eq!(
            values,
            [("session".to_string(), "plain-secret-value".to_string())]
        );
    }

    #[test]
    fn ap_03_corrupted_cookie_file_blocks_startup_and_preserves_source() {
        let directory = tempfile::tempdir().expect("temporary app data");
        fs::write(directory.path().join(COOKIE_FILE_NAME), b"corrupted")
            .expect("write corrupted cookie file");

        assert_eq!(
            AppState::with_persistence(directory.path().join(COOKIE_FILE_NAME), false)
                .err()
                .as_deref(),
            Some("COOKIE_STORE_LOAD_FAILED")
        );
        assert_eq!(
            fs::read(directory.path().join(COOKIE_FILE_NAME)).unwrap(),
            b"corrupted"
        );
    }

    #[test]
    fn interrupted_write_leaves_previous_cookie_file_readable() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let state = persistent_state(directory.path());
        insert_cookie(&state, "old-value");
        state.persist_cookies().expect("persist original cookies");
        fs::write(directory.path().join("interrupted.tmp"), b"partial")
            .expect("simulate interrupted temporary write");

        let restored = persistent_state(directory.path());
        let url = Url::parse("https://tracker.example/").expect("request URL");
        assert_eq!(
            restored
                .cookie_store
                .lock()
                .expect("cookie store lock")
                .get_request_values(&url)
                .next(),
            Some(("session", "old-value"))
        );
    }

    #[test]
    fn startup_discards_expired_cookies() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let path = directory.path().join(COOKIE_FILE_NAME);
        let url = Url::parse("https://tracker.example/").expect("cookie URL");
        let raw = Cookie::parse("expired=old; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
            .expect("expired cookie")
            .into_owned();
        let stored = cookie_store::Cookie::try_from_raw_cookie(&raw, &url)
            .expect("stored expired cookie")
            .into_owned();
        let store = CookieStore::from_cookies(std::iter::once(Ok::<_, String>(stored)), true)
            .expect("store with expired cookie");
        CookiePersistence { path: path.clone() }
            .persist(&store)
            .expect("persist expired cookie fixture");

        let restored = AppState::persistent_for_test(path);

        assert_eq!(
            restored
                .cookie_store
                .lock()
                .expect("cookie store lock")
                .iter_any()
                .count(),
            0
        );
    }

    #[test]
    fn concurrent_mutations_are_serialized_to_complete_disk_state() {
        const COOKIE_COUNT: usize = 12;
        let directory = tempfile::tempdir().expect("temporary app data");
        let path = directory.path().join(COOKIE_FILE_NAME);
        let state = Arc::new(AppState::persistent_for_test(path.clone()));
        let barrier = Arc::new(Barrier::new(COOKIE_COUNT));
        let mut workers = Vec::new();

        for index in 0..COOKIE_COUNT {
            let state = Arc::clone(&state);
            let barrier = Arc::clone(&barrier);
            workers.push(thread::spawn(move || {
                barrier.wait();
                let url = Url::parse("https://tracker.example/").expect("cookie URL");
                let cookie = Cookie::parse(format!("session{index}=value{index}; Path=/"))
                    .expect("valid cookie");
                state
                    .cookie_store
                    .lock()
                    .expect("cookie store lock")
                    .store_response_cookies(std::iter::once(cookie.into_owned()), &url);
                state
                    .persist_cookies()
                    .expect("persist concurrent mutation");
            }));
        }
        for worker in workers {
            worker.join().expect("cookie worker");
        }

        let restored = AppState::persistent_for_test(path);
        let names: Vec<_> = restored
            .cookie_store
            .lock()
            .expect("cookie store lock")
            .iter_unexpired()
            .map(|cookie| cookie.name().to_string())
            .collect();
        assert_eq!(names.len(), COOKIE_COUNT);
        for index in 0..COOKIE_COUNT {
            assert!(names.contains(&format!("session{index}")));
        }
    }
}

#[cfg(test)]
mod phase_c_cookie_tests {
    use super::*;

    #[test]
    fn ap_12_cookie_conflict_preserves_both_mirrors_and_blocks_writes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cookies.v2.json");
        let state = AppState::persistent_for_test(path.clone());
        let mut after = CookieStore::default();
        after.store_response_cookies(
            std::iter::once(cookie::Cookie::parse("session=restored; Path=/").unwrap()),
            &url::Url::parse("https://tracker.example/").unwrap(),
        );
        let mut bytes = Vec::new();
        cookie_store::serde::json::save_incl_expired_and_nonpersistent(&after, &mut bytes).unwrap();
        let recovery_path = path.with_file_name("cookies.v2.restore.json");
        write_cookie_recovery(
            &recovery_path,
            &CookieRecovery {
                id: "restore-1".into(),
                before: b"[]".to_vec(),
                after: bytes,
            },
        )
        .unwrap();
        let mut concurrent = CookieStore::default();
        concurrent.store_response_cookies(
            std::iter::once(cookie::Cookie::parse("session=concurrent; Path=/").unwrap()),
            &url::Url::parse("https://tracker.example/").unwrap(),
        );
        CookiePersistence { path: path.clone() }
            .persist(&concurrent)
            .unwrap();
        drop(state);
        let state = AppState::persistent_for_test(path.clone());
        let original = fs::read(&path).unwrap();
        assert!(state
            .recover_cookies(Some("restore-1"), true, true, || panic!(
                "conflict must not finish"
            ))
            .unwrap_err()
            .starts_with("STORAGE_CONFLICT"));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(recovery_path.exists());
        assert!(state
            .persist_cookies()
            .unwrap_err()
            .starts_with("STORAGE_RECOVERY_REQUIRED"));
    }
}
