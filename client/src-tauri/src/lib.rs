mod daemon_bridge;
mod daemon_store;
mod downloads;
mod hub;
#[cfg(desktop)]
mod menu;
mod navigation;
#[cfg(desktop)]
mod windows;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const MAIN_WINDOW: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    // Hub pages have no IPC access, so links go through the navigation policy rather than this plugin's script.
    .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
    .manage(downloads::Downloads::default())
    .manage(daemon_bridge::DaemonBridge::new());

  #[cfg(desktop)]
  let builder = builder
    .manage(windows::WindowManager::default())
    .on_window_event(|window, event| {
      if window.label() == MAIN_WINDOW
        && matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed)
      {
        windows::close_all_children_now(window.app_handle());
      }
      if matches!(event, tauri::WindowEvent::Destroyed) {
        windows::clear_zoom(window.app_handle(), window.label());
      }
    });

  let app = builder
    .invoke_handler(tauri::generate_handler![
      hub::normalize_hub_url,
      hub::open_hub,
      hub::close_hub,
      daemon_bridge::daemon_status,
      daemon_bridge::set_hub_daemon_enabled,
      daemon_bridge::reconnect_hub_daemon,
      daemon_bridge::disconnect_hub,
      daemon_bridge::disconnect_all,
      daemon_bridge::sync_known_hubs,
      daemon_bridge::confirm_host_fingerprint,
      daemon_bridge::reject_host_fingerprint,
    ])
    .setup(|app| {
      let handle = app.handle();
      app.manage(hub::HubState::new(navigation::home_url(handle)));
      #[cfg(not(any(target_os = "android", target_os = "ios")))]
      {
        let start_handle = handle.clone();
        tauri::async_runtime::spawn(async move {
          start_handle.state::<daemon_bridge::DaemonBridge>().start_enabled();
        });
      }
      let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .use_https_scheme(true)
        // The Hub uploads files through HTML5 drag and drop, which the native handler would swallow.
        .disable_drag_drop_handler()
        .initialization_script(navigation::client_script(handle))
        .on_navigation(navigation::policy(handle.clone()))
        .on_download(downloads::handle);
      #[cfg(desktop)]
      let builder = builder
        .title(app.package_info().name.clone())
        .inner_size(1280.0, 820.0)
        .min_inner_size(420.0, 560.0)
        .on_new_window(navigation::new_window(handle.clone(), MAIN_WINDOW.to_string()));
      builder.build()?;
      #[cfg(desktop)]
      menu::install(app)?;
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("failed to build the Clinavat client");

  app.run(|_handle, _event| {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if matches!(_event, tauri::RunEvent::Exit) {
      #[cfg(desktop)]
      windows::close_all_children_now(_handle);
      _handle.state::<daemon_bridge::DaemonBridge>().stop_all();
    }
  });
}
