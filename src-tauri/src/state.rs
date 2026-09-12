use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use aes_gcm::aead::{rand_core::RngCore, Aead, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
#[cfg(debug_assertions)]
use base64::{engine::general_purpose::STANDARD, Engine};
use cookie_store::CookieStore;
use reqwest::Client;
use reqwest_cookie_store::CookieStoreMutex;
use tauri::Manager;
use tempfile::NamedTempFile;
use tokio::sync::oneshot;

const COOKIE_FILE_NAME: &str = "cookies.v1.enc";
const COOKIE_FILE_MAGIC: &[u8] = b"PTDCOOKIE\x01";
const COOKIE_KEY_SERVICE: &str = "com.ptplugins.pt-depiler";
const COOKIE_KEY_ACCOUNT: &str = "cookie-store-v1";
const KEY_LENGTH: usize = 32;
const NONCE_LENGTH: usize = 12;
const EARLY_HTTP_CANCELLATION_TTL: Duration = Duration::from_secs(30);
#[cfg(debug_assertions)]
const E2E_COOKIE_KEY_ENV: &str = "PTD_E2E_COOKIE_KEY_BASE64";
#[cfg(debug_assertions)]
const E2E_DATA_DIR_ENV: &str = "PTD_E2E_DATA_DIR";

#[derive(Default)]
struct HttpCancellationRegistry {
    active: HashMap<String, oneshot::Sender<()>>,
    early: HashMap<String, Instant>,
}

struct CookiePersistence {
    path: PathBuf,
    key: [u8; KEY_LENGTH],
}

impl CookiePersistence {
    fn load(path: PathBuf, key: [u8; KEY_LENGTH]) -> (Self, CookieStore, Option<String>) {
        let persistence = Self { path, key };
        if !persistence.path.exists() {
            return (persistence, CookieStore::default(), None);
        }

        match persistence.read_store() {
            Ok(store) => (persistence, store, None),
            Err(error) => {
                let diagnostic = format!(
                    "cookie_store_load_failed file={} error={error}",
                    persistence.path.display()
                );
                (persistence, CookieStore::default(), Some(diagnostic))
            }
        }
    }

    fn read_store(&self) -> Result<CookieStore, String> {
        let encrypted = fs::read(&self.path).map_err(|error| error.to_string())?;
        let prefix_length = COOKIE_FILE_MAGIC.len() + NONCE_LENGTH;
        if encrypted.len() <= prefix_length || !encrypted.starts_with(COOKIE_FILE_MAGIC) {
            return Err("Cookie 文件格式无效".to_string());
        }

        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|error| error.to_string())?;
        let nonce = Nonce::from_slice(&encrypted[COOKIE_FILE_MAGIC.len()..prefix_length]);
        let plaintext = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &encrypted[prefix_length..],
                    aad: COOKIE_FILE_MAGIC,
                },
            )
            .map_err(|_| "Cookie 文件认证失败".to_string())?;
        cookie_store::serde::json::load(Cursor::new(plaintext)).map_err(|error| error.to_string())
    }

    fn persist(&self, store: &CookieStore) -> Result<(), String> {
        let parent = self.path.parent().ok_or("Cookie 文件缺少父目录")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;

        let mut plaintext = Vec::new();
        cookie_store::serde::json::save_incl_expired_and_nonpersistent(store, &mut plaintext)
            .map_err(|error| error.to_string())?;

        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|error| error.to_string())?;
        let mut nonce_bytes = [0_u8; NONCE_LENGTH];
        OsRng.fill_bytes(&mut nonce_bytes);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: &plaintext,
                    aad: COOKIE_FILE_MAGIC,
                },
            )
            .map_err(|_| "Cookie 文件加密失败".to_string())?;

        let mut temporary = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        temporary
            .write_all(COOKIE_FILE_MAGIC)
            .and_then(|_| temporary.write_all(&nonce_bytes))
            .and_then(|_| temporary.write_all(&ciphertext))
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

/// 全局应用状态。Cookie Store 由所有请求共享，并按 RFC 6265 的 domain/path 规则隔离。
pub struct AppState {
    pub client: Client,
    pub cookie_store: Arc<CookieStoreMutex>,
    http_cancellations: Mutex<HttpCancellationRegistry>,
    persistence: Option<CookiePersistence>,
    startup_diagnostic: Option<String>,
}

impl AppState {
    /// 仅用于测试和无持久化工具上下文。桌面应用必须使用 `load`。
    pub fn new() -> Self {
        Self::from_store(CookieStore::default(), None, None, false)
    }

    pub fn load(app: &tauri::AppHandle) -> Result<Self, String> {
        #[cfg(debug_assertions)]
        if let Some((app_data_dir, key)) = load_e2e_cookie_config()? {
            eprintln!(
                "PT-depiler debug E2E Cookie Store is active at {}",
                app_data_dir.display()
            );
            return Ok(Self::with_persistence(
                app_data_dir.join(COOKIE_FILE_NAME),
                key,
                true,
            ));
        }

        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let key = load_or_create_key()?;
        Ok(Self::with_persistence(
            app_data_dir.join(COOKIE_FILE_NAME),
            key,
            true,
        ))
    }

    fn with_persistence(path: PathBuf, key: [u8; KEY_LENGTH], use_system_proxy: bool) -> Self {
        let (persistence, store, diagnostic) = CookiePersistence::load(path, key);
        Self::from_store(store, Some(persistence), diagnostic, use_system_proxy)
    }

    #[cfg(test)]
    pub(crate) fn persistent_for_test(path: PathBuf, key: [u8; KEY_LENGTH]) -> Self {
        Self::with_persistence(path, key, false)
    }

    fn from_store(
        store: CookieStore,
        persistence: Option<CookiePersistence>,
        startup_diagnostic: Option<String>,
        use_system_proxy: bool,
    ) -> Self {
        let cookie_store = Arc::new(CookieStoreMutex::new(store));
        let mut client_builder = Client::builder()
            .cookie_provider(Arc::clone(&cookie_store))
            .redirect(reqwest::redirect::Policy::limited(10));
        if !use_system_proxy {
            client_builder = client_builder.no_proxy();
        }
        let client = client_builder
            .build()
            .expect("failed to build reqwest client");
        Self {
            client,
            cookie_store,
            http_cancellations: Mutex::new(HttpCancellationRegistry::default()),
            persistence,
            startup_diagnostic,
        }
    }

    pub fn persist_cookies(&self) -> Result<(), String> {
        let Some(persistence) = &self.persistence else {
            return Ok(());
        };
        let store = self
            .cookie_store
            .lock()
            .map_err(|error| error.to_string())?;
        persistence.persist(&store)
    }

    pub fn startup_diagnostic(&self) -> Option<&str> {
        self.startup_diagnostic.as_deref()
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
fn decode_e2e_cookie_key(encoded: &str) -> Result<[u8; KEY_LENGTH], String> {
    let secret = STANDARD
        .decode(encoded.trim())
        .map_err(|_| format!("{E2E_COOKIE_KEY_ENV} 不是有效的 Base64"))?;
    secret.try_into().map_err(|secret: Vec<u8>| {
        format!(
            "{E2E_COOKIE_KEY_ENV} 解码后必须为 {KEY_LENGTH} 字节，实际为 {} 字节",
            secret.len()
        )
    })
}

#[cfg(debug_assertions)]
fn load_e2e_cookie_config() -> Result<Option<(PathBuf, [u8; KEY_LENGTH])>, String> {
    let Some(encoded_key) = std::env::var_os(E2E_COOKIE_KEY_ENV) else {
        return Ok(None);
    };
    let encoded_key = encoded_key
        .into_string()
        .map_err(|_| format!("{E2E_COOKIE_KEY_ENV} 必须是 UTF-8 文本"))?;
    let data_dir = std::env::var_os(E2E_DATA_DIR_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| format!("设置 {E2E_COOKIE_KEY_ENV} 时必须同时设置 {E2E_DATA_DIR_ENV}"))?;
    if !data_dir.is_absolute() {
        return Err(format!("{E2E_DATA_DIR_ENV} 必须是绝对路径"));
    }
    fs::create_dir_all(&data_dir).map_err(|error| {
        format!(
            "无法创建 {E2E_DATA_DIR_ENV} 指定的目录 {}: {error}",
            data_dir.display()
        )
    })?;
    Ok(Some((data_dir, decode_e2e_cookie_key(&encoded_key)?)))
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

fn load_or_create_key() -> Result<[u8; KEY_LENGTH], String> {
    let entry = keyring::Entry::new(COOKIE_KEY_SERVICE, COOKIE_KEY_ACCOUNT)
        .map_err(|error| format!("无法访问系统安全存储: {error}"))?;
    let secret = match entry.get_secret() {
        Ok(secret) => secret,
        Err(keyring::Error::NoEntry) => {
            let mut secret = vec![0_u8; KEY_LENGTH];
            OsRng.fill_bytes(&mut secret);
            entry
                .set_secret(&secret)
                .map_err(|error| format!("无法写入系统安全存储: {error}"))?;
            secret
        }
        Err(error) => return Err(format!("无法读取系统安全存储: {error}")),
    };
    secret.try_into().map_err(|secret: Vec<u8>| {
        format!("系统安全存储中的 Cookie 密钥长度无效: {}", secret.len())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cookie::Cookie;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use url::Url;

    fn persistent_state(directory: &Path, key: [u8; KEY_LENGTH]) -> AppState {
        AppState::with_persistence(directory.join(COOKIE_FILE_NAME), key, false)
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
    fn validates_debug_e2e_cookie_key_length() {
        let encoded = STANDARD.encode([23_u8; KEY_LENGTH]);
        assert_eq!(
            decode_e2e_cookie_key(&encoded).expect("valid E2E key"),
            [23_u8; KEY_LENGTH]
        );
        assert!(decode_e2e_cookie_key(&STANDARD.encode([1_u8; KEY_LENGTH - 1])).is_err());
        assert!(decode_e2e_cookie_key("not-base64").is_err());
    }

    #[test]
    fn encrypts_and_restores_session_cookies() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let key = [7_u8; KEY_LENGTH];
        let state = persistent_state(directory.path(), key);
        insert_cookie(&state, "plain-secret-value");
        state.persist_cookies().expect("persist encrypted cookies");

        let bytes =
            fs::read(directory.path().join(COOKIE_FILE_NAME)).expect("encrypted cookie file");
        assert!(bytes.starts_with(COOKIE_FILE_MAGIC));
        assert!(!String::from_utf8_lossy(&bytes).contains("plain-secret-value"));

        let restored = persistent_state(directory.path(), key);
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
    fn corrupted_cookie_file_falls_back_to_empty_store_with_diagnostic() {
        let directory = tempfile::tempdir().expect("temporary app data");
        fs::write(directory.path().join(COOKIE_FILE_NAME), b"corrupted")
            .expect("write corrupted cookie file");

        let state = persistent_state(directory.path(), [9_u8; KEY_LENGTH]);

        assert!(state.startup_diagnostic().is_some());
        assert_eq!(
            state
                .cookie_store
                .lock()
                .expect("cookie store lock")
                .iter_any()
                .count(),
            0
        );
    }

    #[test]
    fn interrupted_write_leaves_previous_cookie_file_readable() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let key = [11_u8; KEY_LENGTH];
        let state = persistent_state(directory.path(), key);
        insert_cookie(&state, "old-value");
        state.persist_cookies().expect("persist original cookies");
        fs::write(directory.path().join("interrupted.tmp"), b"partial")
            .expect("simulate interrupted temporary write");

        let restored = persistent_state(directory.path(), key);
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
        let key = [13_u8; KEY_LENGTH];
        let url = Url::parse("https://tracker.example/").expect("cookie URL");
        let raw = Cookie::parse("expired=old; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
            .expect("expired cookie")
            .into_owned();
        let stored = cookie_store::Cookie::try_from_raw_cookie(&raw, &url)
            .expect("stored expired cookie")
            .into_owned();
        let store = CookieStore::from_cookies(std::iter::once(Ok::<_, String>(stored)), true)
            .expect("store with expired cookie");
        CookiePersistence {
            path: path.clone(),
            key,
        }
        .persist(&store)
        .expect("persist expired cookie fixture");

        let restored = AppState::persistent_for_test(path, key);

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
        let key = [17_u8; KEY_LENGTH];
        let state = Arc::new(AppState::persistent_for_test(path.clone(), key));
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

        let restored = AppState::persistent_for_test(path, key);
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
