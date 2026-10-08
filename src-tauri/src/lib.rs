mod download;
pub mod error;
mod http;
mod http_policy;
mod repository;
#[cfg(debug_assertions)]
mod stage_a_acceptance;
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
    let context = tauri::generate_context!();
    #[cfg(all(debug_assertions, target_os = "macos"))]
    let mut context = context;
    #[cfg(all(debug_assertions, target_os = "macos"))]
    if let Some(identifier) = stage_a_acceptance::isolated_webview_identifier() {
        for window in &mut context.config_mut().app.windows {
            window.data_store_identifier = Some(identifier);
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            storage::initialize(app.handle()).map_err(std::io::Error::other)?;
            let state = AppState::load(app.handle()).map_err(std::io::Error::other)?;
            app.manage(state);
            app.manage(http_policy::HttpPolicy);
            http::write_debug_log("app_started".to_string());
            #[cfg(debug_assertions)]
            stage_a_acceptance::install(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            http::ptd_fetch,
            http::ptd_cancel_fetch,
            http::open_site_login,
            http::finish_site_login,
            http::get_cookies,
            http::set_cookie,
            storage::get_ext_storage,
            storage::set_ext_storage,
            storage::merge_ext_storage,
            storage::merge_ext_storage_batch,
            storage::get_storage_status,
            storage::get_cache_snapshot,
            storage::reconcile_storage_commit,
            storage::import_download_history,
            storage::list_download_history,
            storage::get_download_history,
            storage::insert_download_history,
            storage::save_download_history_if_unchanged,
            storage::delete_download_history,
            storage::clear_download_history,
            storage::replace_download_history,
            download::download_to_local,
            storage::schedule_redownload,
            storage::ensure_periodic_tasks,
            storage::claim_due_task,
            storage::renew_task,
            storage::finish_task,
            storage::release_tasks,
            storage::list_task_status,
            storage::request_task_cancel,
            storage::resolve_task,
        ])
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod ipc_contract_tests;
