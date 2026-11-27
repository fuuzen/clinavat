#[cfg(desktop)]
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, Runtime, Url};
use tauri_plugin_opener::OpenerExt;

use crate::hub::{self, HubState};
#[cfg(desktop)]
use crate::windows;

/// Hub pages navigate here to return to the Hub list. The `.invalid` domain never resolves.
const SWITCH_HUB_HOST: &str = "switch-hub.clinavat.invalid";
/// Detached child windows navigate here to close themselves without native IPC access.
#[cfg(desktop)]
const CLOSE_WINDOW_HOST: &str = "close-window.clinavat.invalid";
/// Detached child windows navigate here to bring the main workbench window to the front.
#[cfg(desktop)]
const FOCUS_MAIN_HOST: &str = "focus-main.clinavat.invalid";

/// WKWebView on iOS ignores target=_blank links, so they go through the navigation policy instead.
const IOS_BLANK_TARGETS: &str = r#"
window.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href][target='_blank']") : null;
  if (!link || event.defaultPrevented || event.button !== 0) return;
  event.preventDefault();
  window.location.assign(link.href);
});"#;

enum Route {
  Stay,
  Home,
  #[cfg(desktop)]
  CloseChild,
  #[cfg(desktop)]
  FocusMain,
  External,
  Blocked,
}

/// The bundled Hub list page, at the address Tauri serves it from on this platform.
pub fn home_url<R: Runtime>(app: &AppHandle<R>) -> Url {
  if cfg!(dev) {
    if let Some(url) = &app.config().build.dev_url {
      return url.join("index.html").unwrap_or_else(|_| url.clone());
    }
  }
  // Mirrors Tauri's custom protocol; the window enables the HTTPS scheme where it applies.
  let origin = if cfg!(any(windows, target_os = "android")) { "https://tauri.localhost" } else { "tauri://localhost" };
  Url::parse(origin).and_then(|origin| origin.join("index.html")).expect("the bundled page has a valid URL")
}

/// Lets Hub pages in the main window detect the client, switch Hubs, open detached windows, and read device metadata.
pub fn client_script<R: Runtime>(app: &AppHandle<R>) -> String {
  wrap_client_script(client_metadata(app))
}

/// Minimal frozen metadata for detached child windows: omits `switchHubUrl` and local daemon pairing fields.
#[cfg(desktop)]
pub fn child_client_script<R: Runtime>(app: &AppHandle<R>) -> String {
  let client = serde_json::json!({
    "platform": std::env::consts::OS,
    "version": app.package_info().version.to_string(),
    "multiWindow": true,
    "closeWindowUrl": format!("https://{CLOSE_WINDOW_HOST}/"),
    "focusMainUrl": format!("https://{FOCUS_MAIN_HOST}/"),
  });
  wrap_client_script(client)
}

fn wrap_client_script(client: serde_json::Value) -> String {
  let mut script = format!(
    "(() => {{ if (window.__CLINAVAT_CLIENT__) return; \
     Object.defineProperty(window, '__CLINAVAT_CLIENT__', {{ value: Object.freeze({client}) }}); \
     window.dispatchEvent(new Event('clinavat:client')); }})();"
  );
  if cfg!(target_os = "ios") {
    script.push_str(IOS_BLANK_TARGETS);
  }
  script
}

fn client_metadata<R: Runtime>(app: &AppHandle<R>) -> serde_json::Value {
  let base = serde_json::json!({
    "platform": std::env::consts::OS,
    "version": app.package_info().version.to_string(),
    "switchHubUrl": format!("https://{SWITCH_HUB_HOST}/"),
  });
  #[cfg(desktop)]
  {
    let mut client = base;
    if let Some(obj) = client.as_object_mut() {
      obj.insert("multiWindow".into(), serde_json::Value::Bool(true));
      obj.insert("closeWindowUrl".into(), serde_json::Value::String(format!("https://{CLOSE_WINDOW_HOST}/")));
      obj.insert("focusMainUrl".into(), serde_json::Value::String(format!("https://{FOCUS_MAIN_HOST}/")));
      if let Some(meta) = app.try_state::<crate::daemon_bridge::DaemonBridge>().and_then(|b| b.client_device_meta()) {
        obj.insert("deviceId".into(), serde_json::Value::String(meta.device_id));
        obj.insert("publicKey".into(), serde_json::Value::String(meta.public_key));
        obj.insert("deviceName".into(), serde_json::Value::String(meta.device_name));
        obj.insert("arch".into(), serde_json::Value::String(meta.arch));
        obj.insert("osVersion".into(), serde_json::Value::String(meta.os_version));
        obj.insert("defaultShell".into(), serde_json::Value::String(meta.default_shell));
        obj.insert("homedir".into(), serde_json::Value::String(meta.homedir));
      }
    }
    client
  }
  #[cfg(mobile)]
  base
}

/// Keeps the main webview on the Hub list or the chosen Hub; other links open outside the client.
pub fn policy<R: Runtime>(app: AppHandle<R>) -> impl Fn(&Url) -> bool + Send + 'static {
  move |url: &Url| {
    let Some(state) = app.try_state::<HubState>() else { return false };
    match route(url, Some(state.home()), state.current().as_ref(), false) {
      Route::Stay => true,
      Route::Home => {
        hub::return_home(&app);
        false
      }
      #[cfg(desktop)]
      Route::CloseChild => false,
      #[cfg(desktop)]
      Route::FocusMain => {
        windows::focus_main(&app);
        false
      }
      Route::External => {
        open_externally(&app, url);
        false
      }
      Route::Blocked => false,
    }
  }
}

/// Navigation policy for detached child windows: locked to the active Hub origin only, with close/focus sentinels.
#[cfg(desktop)]
pub fn child_policy<R: Runtime>(app: AppHandle<R>, label: String) -> impl Fn(&Url) -> bool + Send + 'static {
  move |url: &Url| {
    let Some(state) = app.try_state::<HubState>() else { return false };
    match route(url, None, state.current().as_ref(), true) {
      Route::Stay => true,
      Route::Home => false,
      Route::CloseChild => {
        windows::close_window(&app, &label);
        false
      }
      Route::FocusMain => {
        windows::focus_main(&app);
        false
      }
      Route::External => {
        open_externally(&app, url);
        false
      }
      Route::Blocked => false,
    }
  }
}

#[cfg(desktop)]
pub fn new_window<R: Runtime>(
  app: AppHandle<R>,
  source_label: String,
) -> impl Fn(Url, NewWindowFeatures) -> NewWindowResponse<R> + Send + 'static {
  move |url, _features| {
    let current_hub = app.try_state::<HubState>().and_then(|state| state.current());
    if let Some(hub) = current_hub.as_ref().filter(|hub| same_origin(&url, hub)) {
      if windows::has_window_param(&url) {
        windows::open_if_allowed(&app, &source_label, &url, hub);
      } else if external_scheme(&url) {
        open_externally(&app, &url);
      }
    } else if external_scheme(&url) {
      open_externally(&app, &url);
    }
    NewWindowResponse::Deny
  }
}

fn route(url: &Url, home: Option<&Url>, hub: Option<&Url>, is_child: bool) -> Route {
  // about:blank and the login page's srcdoc frame reach this hook on Apple platforms.
  if url.scheme() == "about" {
    return Route::Stay;
  }
  #[cfg(desktop)]
  {
    if url.host_str() == Some(CLOSE_WINDOW_HOST) {
      return if is_child { Route::CloseChild } else { Route::Blocked };
    }
    if url.host_str() == Some(FOCUS_MAIN_HOST) {
      return Route::FocusMain;
    }
  }
  if url.host_str() == Some(SWITCH_HUB_HOST) {
    return if is_child { Route::Blocked } else { Route::Home };
  }
  let target = if url.scheme() == "blob" {
    match Url::parse(url.path()) {
      Ok(inner) => inner,
      Err(_) => return Route::Blocked,
    }
  } else {
    url.clone()
  };
  let allowed_home = home.is_some_and(|home| same_origin(&target, home));
  let allowed_hub = hub.is_some_and(|hub| same_origin(&target, hub));
  if allowed_home || allowed_hub {
    Route::Stay
  } else if external_scheme(url) {
    Route::External
  } else {
    Route::Blocked
  }
}

/// Compares scheme, host and port directly, because custom schemes such as tauri:// have opaque origins.
pub(crate) fn same_origin(left: &Url, right: &Url) -> bool {
  left.scheme() == right.scheme()
    && left.host_str() == right.host_str()
    && left.port_or_known_default() == right.port_or_known_default()
}

fn external_scheme(url: &Url) -> bool {
  matches!(url.scheme(), "http" | "https" | "mailto" | "tel")
}

fn open_externally<R: Runtime>(app: &AppHandle<R>, url: &Url) {
  let app = app.clone();
  let url = url.to_string();
  // On mobile the opener calls into the UI thread, which is still deciding this navigation.
  tauri::async_runtime::spawn(async move {
    let _ = app.opener().open_url(url, None::<&str>);
  });
}
