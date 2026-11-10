use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{App, Manager, Runtime};

use crate::{hub, MAIN_WINDOW};

const SWITCH_HUB: &str = "switch-hub";
const RELOAD: &str = "reload";

/// The desktop way back to the Hub list, which keeps working when a Hub page fails to load.
pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
  let switch_hub = MenuItem::with_id(app, SWITCH_HUB, "切换 Hub…", true, None::<&str>)?;
  // Only macOS gets a shortcut: elsewhere Ctrl+R belongs to the shell history search in the web terminal.
  let reload = MenuItem::with_id(app, RELOAD, "重新加载", true, cfg!(target_os = "macos").then_some("Cmd+R"))?;
  let hub_menu = Submenu::with_items(app, "Hub", true, &[&switch_hub, &reload])?;
  #[cfg(target_os = "macos")]
  let menu = {
    // The default menu carries the Edit items that WKWebView needs for copy and paste shortcuts.
    let menu = Menu::default(app.handle())?;
    menu.insert(&hub_menu, 1)?;
    menu
  };
  #[cfg(not(target_os = "macos"))]
  let menu = Menu::with_items(app, &[&hub_menu])?;
  app.set_menu(menu)?;
  app.on_menu_event(|app, event| match event.id().as_ref() {
    SWITCH_HUB => hub::return_home(app),
    RELOAD => {
      if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.reload();
      }
    }
    _ => {}
  });
  Ok(())
}
