#[cfg(desktop)]
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, Runtime, Url};
use tauri_plugin_opener::OpenerExt;

use crate::hub::{self, HubState};

/// Hub pages navigate here to return to the Hub list. The `.invalid` domain never resolves.
const SWITCH_HUB_HOST: &str = "switch-hub.clinavat.invalid";

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

/// Lets Hub pages detect the client and offer the way back to the Hub list.
pub fn client_script<R: Runtime>(app: &AppHandle<R>) -> String {
  let client = serde_json::json!({
    "platform": std::env::consts::OS,
    "version": app.package_info().version.to_string(),
    "switchHubUrl": format!("https://{SWITCH_HUB_HOST}/"),
  });
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

/// Keeps the main webview on the Hub list or the chosen Hub; other links open outside the client.
pub fn policy<R: Runtime>(app: AppHandle<R>) -> impl Fn(&Url) -> bool + Send + 'static {
  move |url: &Url| {
    let Some(state) = app.try_state::<HubState>() else { return false };
    match route(url, state.home(), state.current().as_ref()) {
      Route::Stay => true,
      Route::Home => {
        hub::return_home(&app);
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
pub fn new_window<R: Runtime>(app: AppHandle<R>) -> impl Fn(Url, NewWindowFeatures) -> NewWindowResponse<R> + Send + 'static {
  move |url, _features| {
    if external_scheme(&url) {
      open_externally(&app, &url);
    }
    NewWindowResponse::Deny
  }
}

fn route(url: &Url, home: &Url, hub: Option<&Url>) -> Route {
  // about:blank and the login page's srcdoc frame reach this hook on Apple platforms.
  if url.scheme() == "about" {
    return Route::Stay;
  }
  if url.host_str() == Some(SWITCH_HUB_HOST) {
    return Route::Home;
  }
  let target = if url.scheme() == "blob" {
    match Url::parse(url.path()) {
      Ok(inner) => inner,
      Err(_) => return Route::Blocked,
    }
  } else {
    url.clone()
  };
  if same_origin(&target, home) || hub.is_some_and(|hub| same_origin(&target, hub)) {
    Route::Stay
  } else if external_scheme(url) {
    Route::External
  } else {
    Route::Blocked
  }
}

/// Compares scheme, host and port directly, because custom schemes such as tauri:// have opaque origins.
fn same_origin(left: &Url, right: &Url) -> bool {
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
