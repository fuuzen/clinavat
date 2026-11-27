use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::hub::HubState;
use crate::{downloads, navigation, MAIN_WINDOW};

/// Caps concurrent detached Hub windows to prevent runaway popup creation from a remote page.
const MAX_CHILD_WINDOWS: usize = 16;

const SETTINGS_TABS: &[&str] = &[
  "account",
  "usage",
  "conversation",
  "roster",
  "archived",
  "appearance",
  "system",
];

#[derive(Default)]
struct ManagerState {
  in_flight: HashSet<String>,
  hub_epoch: u64,
  zoom: HashMap<String, f64>,
}

#[derive(Default)]
pub struct WindowManager {
  state: Mutex<ManagerState>,
}

enum ReserveOutcome {
  Reserved(u64),
  AlreadyOpening,
  LimitReached,
}

impl WindowManager {
  fn reserve(&self, label: &str, live_children: &HashSet<String>) -> ReserveOutcome {
    let Ok(mut guard) = self.state.lock() else {
      return ReserveOutcome::LimitReached;
    };
    if guard.in_flight.contains(label) {
      return ReserveOutcome::AlreadyOpening;
    }
    let pending_new = guard.in_flight.iter().filter(|item| !live_children.contains(*item)).count();
    if live_children.len() + pending_new >= MAX_CHILD_WINDOWS {
      return ReserveOutcome::LimitReached;
    }
    guard.in_flight.insert(label.to_string());
    ReserveOutcome::Reserved(guard.hub_epoch)
  }

  fn finish_open(&self, label: &str) -> u64 {
    if let Ok(mut guard) = self.state.lock() {
      guard.in_flight.remove(label);
      return guard.hub_epoch;
    }
    0
  }

  fn bump_epoch_and_clear_child_zooms(&self) {
    if let Ok(mut guard) = self.state.lock() {
      guard.hub_epoch = guard.hub_epoch.wrapping_add(1);
      guard.zoom.retain(|label, _| label == MAIN_WINDOW);
    }
  }

  fn next_zoom(&self, label: &str, delta: Option<f64>) -> f64 {
    let Ok(mut guard) = self.state.lock() else { return 1.0 };
    let next = match delta {
      Some(step) => {
        let current = guard.zoom.get(label).copied().unwrap_or(1.0);
        ((current + step) * 100.0).round() / 100.0
      }
      None => 1.0,
    };
    let clamped = next.clamp(0.5, 2.0);
    if (clamped - 1.0).abs() < f64::EPSILON {
      guard.zoom.remove(label);
    } else {
      guard.zoom.insert(label.to_string(), clamped);
    }
    clamped
  }

  fn remove_zoom(&self, label: &str) {
    if let Ok(mut guard) = self.state.lock() {
      guard.zoom.remove(label);
    }
  }
}

struct InFlightGuard<R: Runtime> {
  app: AppHandle<R>,
  label: String,
  released: bool,
}

impl<R: Runtime> InFlightGuard<R> {
  fn release(mut self) -> u64 {
    self.released = true;
    self.app.try_state::<WindowManager>().map(|m| m.finish_open(&self.label)).unwrap_or(0)
  }
}

impl<R: Runtime> Drop for InFlightGuard<R> {
  fn drop(&mut self) {
    if !self.released {
      if let Some(manager) = self.app.try_state::<WindowManager>() {
        let _ = manager.finish_open(&self.label);
      }
    }
  }
}

#[derive(Debug, Clone)]
pub struct WindowSpec {
  pub key: String,
  pub label: String,
  pub title: String,
  pub width: f64,
  pub height: f64,
  pub min_width: f64,
  pub min_height: f64,
}

/// Returns true when the URL explicitly targets the detached multi-window query protocol.
pub fn has_window_param(url: &Url) -> bool {
  url.query_pairs().any(|(key, _)| key == "window")
}

/// Parses and validates a same-origin detached window URL against the strict `?window=` allowlist.
pub fn parse_window_request(url: &Url) -> Option<WindowSpec> {
  let mut kind_param: Option<String> = None;
  let mut project_id: Option<String> = None;
  let mut project_name: Option<String> = None;
  let mut file_path: Option<String> = None;
  let mut tab: Option<String> = None;

  for (k, v) in url.query_pairs() {
    match k.as_ref() {
      "window" => kind_param = Some(v.into_owned()),
      "projectId" => project_id = Some(v.into_owned()),
      "projectName" => project_name = Some(v.into_owned()),
      "path" => file_path = Some(v.into_owned()),
      "tab" => tab = Some(v.into_owned()),
      _ => {}
    }
  }

  match kind_param.as_deref()? {
    "settings" => {
      if let Some(ref value) = tab {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !SETTINGS_TABS.contains(&trimmed) {
          return None;
        }
      }
      Some(WindowSpec {
        key: "settings".into(),
        label: "win-settings".into(),
        title: "工作台设置 — Clinavat".into(),
        width: 980.0,
        height: 680.0,
        min_width: 680.0,
        min_height: 500.0,
      })
    }
    "memory" => {
      let pid = clean_param(project_id.as_deref(), 128)?;
      let key = format!("memory:{pid}");
      let title = clean_param(project_name.as_deref(), 120)
        .map(|name| format!("项目记忆 · {name}"))
        .unwrap_or_else(|| "项目记忆 — Clinavat".into());
      Some(WindowSpec {
        label: format!("win-mem-{:016x}", fnv1a_64(&key)),
        key,
        title,
        width: 880.0,
        height: 660.0,
        min_width: 560.0,
        min_height: 440.0,
      })
    }
    "preview" => {
      let pid = clean_param(project_id.as_deref(), 128)?;
      let path = clean_param(file_path.as_deref(), 1024)?;
      let key = format!("preview:{pid}:{path}");
      let name = path.rsplit('/').next().filter(|segment| !segment.is_empty()).unwrap_or(&path);
      Some(WindowSpec {
        label: format!("win-prv-{:016x}", fnv1a_64(&key)),
        key,
        title: format!("{name} — 文件预览"),
        width: 1120.0,
        height: 760.0,
        min_width: 560.0,
        min_height: 440.0,
      })
    }
    _ => None,
  }
}

/// Best-effort logical key used to deliver an immediate `ok: false` ack when `?window=` validation fails.
fn rejection_key(url: &Url) -> String {
  let mut kind = String::new();
  let mut pid = String::new();
  let mut path = String::new();
  for (k, v) in url.query_pairs() {
    match k.as_ref() {
      "window" => kind = v.trim().to_string(),
      "projectId" => pid = v.trim().to_string(),
      "path" => path = v.trim().to_string(),
      _ => {}
    }
  }
  match kind.as_str() {
    "settings" => "settings".into(),
    "memory" => format!("memory:{pid}"),
    "preview" => format!("preview:{pid}:{path}"),
    _ => kind,
  }
}

fn clean_param(raw: Option<&str>, max_bytes: usize) -> Option<String> {
  let trimmed = raw?.trim();
  if trimmed.is_empty() || trimmed.len() > max_bytes || trimmed.chars().any(|ch| ch.is_control()) {
    return None;
  }
  Some(trimmed.to_string())
}

fn fnv1a_64(input: &str) -> u64 {
  let mut hash: u64 = 0xcbf29ce484222325;
  for byte in input.as_bytes() {
    hash ^= u64::from(*byte);
    hash = hash.wrapping_mul(0x100000001b3);
  }
  hash
}

/// Validates and asynchronously opens or focuses a detached Hub window.
/// Always called from `on_new_window` before returning `NewWindowResponse::Deny` to avoid WebView2 deadlocks.
pub fn open_if_allowed<R: Runtime>(app: &AppHandle<R>, source_label: &str, url: &Url, expected_hub: &Url) {
  let app = app.clone();
  let source = source_label.to_string();
  let url = url.clone();
  let expected_hub = expected_hub.clone();

  let Some(spec) = parse_window_request(&url) else {
    let key = rejection_key(&url);
    tauri::async_runtime::spawn(async move {
      notify_window_ack(&app, &source, &key, false);
    });
    return;
  };

  tauri::async_runtime::spawn(async move {
    let still_trusted = app
      .try_state::<HubState>()
      .and_then(|state| state.current())
      .is_some_and(|current| navigation::same_origin(&current, &expected_hub) && navigation::same_origin(&url, &current));
    if !still_trusted {
      notify_window_ack(&app, &source, &spec.key, false);
      return;
    }

    if let Some(existing) = app.get_webview_window(&spec.label) {
      let _ = existing.unminimize();
      let _ = existing.show();
      let _ = existing.set_focus();
      notify_window_ack(&app, &source, &spec.key, true);
      return;
    }

    let Some(manager) = app.try_state::<WindowManager>() else {
      notify_window_ack(&app, &source, &spec.key, false);
      return;
    };

    let live_children: HashSet<String> = app
      .webview_windows()
      .keys()
      .filter(|label| label.as_str() != MAIN_WINDOW)
      .cloned()
      .collect();

    let reserved_epoch = match manager.reserve(&spec.label, &live_children) {
      ReserveOutcome::Reserved(epoch) => epoch,
      ReserveOutcome::AlreadyOpening => {
        notify_window_ack(&app, &source, &spec.key, true);
        return;
      }
      ReserveOutcome::LimitReached => {
        notify_window_ack(&app, &source, &spec.key, false);
        return;
      }
    };
    let guard = InFlightGuard { app: app.clone(), label: spec.label.clone(), released: false };

    // Acknowledge immediately once preflight & reservation succeed so slow WebView creation never triggers modal fallback.
    notify_window_ack(&app, &source, &spec.key, true);

    let built = WebviewWindowBuilder::new(&app, &spec.label, WebviewUrl::External(url))
      .title(&spec.title)
      .inner_size(spec.width, spec.height)
      .min_inner_size(spec.min_width, spec.min_height)
      .disable_drag_drop_handler()
      .initialization_script(navigation::child_client_script(&app))
      .on_navigation(navigation::child_policy(app.clone(), spec.label.clone()))
      .on_download(downloads::handle)
      .on_new_window(navigation::new_window(app.clone(), spec.label.clone()))
      .build();

    let current_epoch = guard.release();
    let hub_unchanged = app
      .try_state::<HubState>()
      .and_then(|state| state.current())
      .is_some_and(|current| navigation::same_origin(&current, &expected_hub));
    let main_alive = app.get_webview_window(MAIN_WINDOW).is_some();

    match built {
      Ok(window) => {
        if current_epoch != reserved_epoch || !hub_unchanged || !main_alive {
          let _ = window.destroy();
        } else {
          let _ = window.set_focus();
        }
      }
      Err(err) => {
        eprintln!("failed to build detached window {}: {err}", spec.label);
        notify_window_ack(&app, &source, &spec.key, false);
      }
    }
  });
}

fn notify_window_ack<R: Runtime>(app: &AppHandle<R>, source_label: &str, key: &str, ok: bool) {
  let Some(source) = app.get_webview_window(source_label) else { return };
  let Ok(serialized_key) = serde_json::to_string(key) else { return };
  let ok_literal = if ok { "true" } else { "false" };
  let script = format!(
    "window.dispatchEvent(new CustomEvent('clinavat:window-ack', {{ detail: {{ key: {serialized_key}, ok: {ok_literal} }} }}));"
  );
  let _ = source.eval(&script);
}

/// Closes and destroys a single detached child window; `"main"` is never closed through this hook.
pub fn close_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
  if label == MAIN_WINDOW {
    return;
  }
  let app = app.clone();
  let label = label.to_string();
  tauri::async_runtime::spawn(async move {
    if let Some(window) = app.get_webview_window(&label) {
      let _ = window.destroy();
    }
  });
}

/// Brings the main workbench window out of minimization and focuses it.
pub fn focus_main<R: Runtime>(app: &AppHandle<R>) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
      let _ = main.unminimize();
      let _ = main.show();
      let _ = main.set_focus();
    }
  });
}

/// Bumps the Hub epoch before releasing locks, then destroys all non-main child windows outside any mutex.
pub fn close_all_children_now<R: Runtime>(app: &AppHandle<R>) {
  if let Some(manager) = app.try_state::<WindowManager>() {
    manager.bump_epoch_and_clear_child_zooms();
  }
  let children: Vec<WebviewWindow<R>> = app
    .webview_windows()
    .into_iter()
    .filter_map(|(label, window)| (label != MAIN_WINDOW).then_some(window))
    .collect();
  for window in children {
    let _ = window.destroy();
  }
}

/// Returns whichever webview window currently has focus, falling back to `"main"`.
pub fn focused_or_main<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
  let windows = app.webview_windows();
  if let Some(focused) = windows.values().find(|window| window.is_focused().unwrap_or(false)) {
    return Some(focused.clone());
  }
  windows.get(MAIN_WINDOW).cloned()
}

/// Adjusts zoom on the currently focused window (`None` resets to 100%).
pub fn adjust_zoom<R: Runtime>(app: &AppHandle<R>, delta: Option<f64>) {
  let Some(window) = focused_or_main(app) else { return };
  let Some(manager) = app.try_state::<WindowManager>() else { return };
  let level = manager.next_zoom(window.label(), delta);
  let _ = window.set_zoom(level);
}

pub fn clear_zoom<R: Runtime>(app: &AppHandle<R>, label: &str) {
  if let Some(manager) = app.try_state::<WindowManager>() {
    manager.remove_zoom(label);
  }
}
