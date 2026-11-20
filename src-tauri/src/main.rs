#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
#[derive(Default)]
struct Bridge {
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    sequence: AtomicU64,
}
fn fail_pending(bridge: &Bridge, message: &str) {
    for (_, sender) in bridge.pending.lock().unwrap().drain() {
        let _ = sender.send(Err(message.to_string()));
    }
}
#[tauri::command]
async fn desktop_request(
    bridge: tauri::State<'_, Bridge>,
    method: String,
    payload: Option<Value>,
) -> Reply {
    if ![
        "snapshot",
        "detect",
        "connect",
        "start",
        "stop",
        "importFile",
        "retry",
        "rollback",
    ]
    .contains(&method.as_str())
    {
        return Err("未知桌面操作".into());
    }
    let id = bridge.sequence.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    bridge.pending.lock().unwrap().insert(id, sender);
    let line = format!(
        "{}\n",
        json!({"id": id, "method": method, "payload": payload.unwrap_or(json!({}))})
    );
    let sent = {
        let mut guard = bridge.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => child.write(line.as_bytes()).map_err(|e| e.to_string()),
            None => Err("迁移内核尚未启动，请重新打开应用".into()),
        }
    };
    if let Err(error) = sent {
        bridge.pending.lock().unwrap().remove(&id);
        return Err(error);
    }
    match tokio::time::timeout(Duration::from_secs(600), receiver).await {
        Ok(Ok(result)) => result,
        _ => {
            bridge.pending.lock().unwrap().remove(&id);
            Err("操作等待超时；任务可能仍在处理，请刷新任务列表确认".into())
        }
    }
}
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Bridge::default())
        .invoke_handler(tauri::generate_handler![desktop_request])
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            std::fs::create_dir_all(&root)?;
            let plugin = app
                .path()
                .resource_dir()?
                .join("resources/dsh-oc-migrate-plugin.tgz");
            let (mut events, child) = app
                .shell()
                .sidecar("migrate-backend")?
                .env("DSH_OC_SIDECAR", "1")
                .env("DSH_OC_APP_DATA", root)
                .env("DSH_OC_PLUGIN_FILE", plugin)
                .spawn()?;
            *app.state::<Bridge>().child.lock().unwrap() = Some(child);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                                if value["kind"] == "event" {
                                    let _ = handle.emit("desktop-event", &value["event"]);
                                } else if let Some(id) = value["id"].as_u64() {
                                    let sender = handle
                                        .state::<Bridge>()
                                        .pending
                                        .lock()
                                        .unwrap()
                                        .remove(&id);
                                    if let Some(sender) = sender {
                                        let result = match value["error"].as_str() {
                                            Some(error) => Err(error.to_string()),
                                            None => Ok(value["result"].clone()),
                                        };
                                        let _ = sender.send(result);
                                    }
                                }
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("{}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(_) => {
                            fail_pending(
                                &handle.state::<Bridge>(),
                                "迁移内核已退出，请重新打开应用",
                            );
                            handle.state::<Bridge>().child.lock().unwrap().take();
                            let _ = handle.emit("desktop-event", json!({"type": "backend-exited"}));
                        }
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("应用启动失败");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(child) = handle.state::<Bridge>().child.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
