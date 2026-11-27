use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{App, Runtime};

use crate::{hub, windows};

const SWITCH_HUB: &str = "switch-hub";
const RELOAD: &str = "reload";
const ZOOM_IN: &str = "zoom-in";
const ZOOM_OUT: &str = "zoom-out";
const ZOOM_RESET: &str = "zoom-reset";

/// Desktop menu actions apply to whichever window currently has focus (falling back to the main window).
pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
  let switch_hub = MenuItem::with_id(app, SWITCH_HUB, "切换 Hub…", true, None::<&str>)?;
  // Only macOS gets shortcuts: elsewhere Ctrl+R / Ctrl+= may conflict with web terminal shortcuts.
  let reload = MenuItem::with_id(app, RELOAD, "重新加载", true, cfg!(target_os = "macos").then_some("Cmd+R"))?;
  let separator = PredefinedMenuItem::separator(app)?;
  let zoom_in = MenuItem::with_id(app, ZOOM_IN, "放大", true, cfg!(target_os = "macos").then_some("Cmd+Equal"))?;
  let zoom_out = MenuItem::with_id(app, ZOOM_OUT, "缩小", true, cfg!(target_os = "macos").then_some("Cmd+Minus"))?;
  let zoom_reset = MenuItem::with_id(app, ZOOM_RESET, "实际大小", true, cfg!(target_os = "macos").then_some("Cmd+0"))?;
  let hub_menu = Submenu::with_items(app, "Hub", true, &[&switch_hub, &reload, &separator, &zoom_in, &zoom_out, &zoom_reset])?;
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
      if let Some(window) = windows::focused_or_main(app) {
        let _ = window.reload();
      }
    }
    ZOOM_IN => windows::adjust_zoom(app, Some(0.1)),
    ZOOM_OUT => windows::adjust_zoom(app, Some(-0.1)),
    ZOOM_RESET => windows::adjust_zoom(app, None),
    _ => {}
  });
  Ok(())
}
