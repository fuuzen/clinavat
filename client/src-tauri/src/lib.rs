mod downloads;
mod hub;
#[cfg(desktop)]
mod menu;
mod navigation;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const MAIN_WINDOW: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Hub pages have no IPC access, so links go through the navigation policy rather than this plugin's script.
    .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
    .manage(downloads::Downloads::default())
    .invoke_handler(tauri::generate_handler![hub::normalize_hub_url, hub::open_hub, hub::close_hub])
    .setup(|app| {
      let handle = app.handle();
      app.manage(hub::HubState::new(navigation::home_url(handle)));
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
        .on_new_window(navigation::new_window(handle.clone()));
      builder.build()?;
      #[cfg(desktop)]
      menu::install(app)?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("failed to run the Clinavat client");
}
