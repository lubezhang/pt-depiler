use tauri::{Listener, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) fn enabled() -> bool {
    cfg!(debug_assertions)
        && std::env::var("PTD_STAGE_A_GUI").as_deref() == Ok("1")
        && std::env::var_os("PTD_E2E_DATA_DIR")
            .is_some_and(|path| std::path::Path::new(&path).is_absolute())
}

pub(crate) fn install(app: &tauri::App) -> tauri::Result<()> {
    if !enabled() {
        return Ok(());
    }
    app.add_capability(
        serde_json::json!({
            "identifier": "stage-a-local-acceptance",
            "windows": ["main", "stage-a-peer"],
            "permissions": ["core:default", "core:window:allow-close", "core:window:allow-destroy"]
        })
        .to_string(),
    )?;
    let handle = app.handle().clone();
    app.listen("stage-a:create-peer", move |_| {
        if handle.get_webview_window("stage-a-peer").is_none() {
            WebviewWindowBuilder::new(
                &handle,
                "stage-a-peer",
                WebviewUrl::App("index.html?stage-a-peer=1".into()),
            )
            .title("Stage A isolated peer")
            .build()
            .expect("create acceptance peer");
        }
    });
    let directory = std::path::PathBuf::from(std::env::var_os("PTD_E2E_DATA_DIR").unwrap());
    app.listen("stage-a:result", move |event| {
        let value: serde_json::Value =
            serde_json::from_str(event.payload()).expect("acceptance result");
        std::fs::write(
            directory.join("stage-a-gui.json"),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .expect("write acceptance evidence");
    });
    let directory = std::path::PathBuf::from(std::env::var_os("PTD_E2E_DATA_DIR").unwrap());
    if let Some(window) = app.get_webview_window("main") {
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                std::fs::write(
                    directory.join("stage-a-closed.txt"),
                    "main destroyed after async disposal\n",
                )
                .expect("write close evidence");
            }
        });
    }
    Ok(())
}
