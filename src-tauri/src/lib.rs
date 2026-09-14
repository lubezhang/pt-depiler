mod download;
pub mod error;
mod http;
mod scheduler;
mod state;
mod storage;

use state::AppState;
use tauri::Manager;

#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = AppState::load(app.handle()).map_err(std::io::Error::other)?;
            if let Some(diagnostic) = state.startup_diagnostic() {
                http::write_debug_log(diagnostic.to_string());
            }
            app.manage(state);
            http::write_debug_log("app_started".to_string());
            scheduler::start_scheduler(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            http::ptd_fetch,
            http::ptd_cancel_fetch,
            http::open_site_login,
            http::finish_site_login,
            http::write_debug_log,
            http::get_cookies,
            http::set_cookie,
            storage::get_ext_storage,
            storage::set_ext_storage,
            download::download_to_local,
            scheduler::schedule_redownload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
