use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, State, Url};
use url::Host;

use crate::MAIN_WINDOW;

/// Where the main webview may stay: the bundled Hub list, and the Hub the user opened from it.
pub struct HubState {
  home: Url,
  current: Mutex<Option<Url>>,
}

impl HubState {
  pub fn new(home: Url) -> Self {
    Self { home, current: Mutex::new(None) }
  }

  pub fn home(&self) -> &Url {
    &self.home
  }

  pub fn current(&self) -> Option<Url> {
    self.current.lock().ok().and_then(|current| current.clone())
  }

  fn set_current(&self, hub: Option<Url>) {
    if let Ok(mut current) = self.current.lock() {
      *current = hub;
    }
  }
}

/// Accepts a Hub address with an optional base path; an address without a scheme means HTTPS.
pub fn parse_hub_url(input: &str) -> Result<Url, String> {
  let input = input.trim();
  if input.is_empty() {
    return Err("请填写 Hub 地址".into());
  }
  let has_scheme = input.split_once("://").is_some_and(|(scheme, _)| {
    scheme.starts_with(|first: char| first.is_ascii_alphabetic())
      && scheme.chars().all(|character| character.is_ascii_alphanumeric() || "+-.".contains(character))
  });
  let candidate = if has_scheme { input.to_owned() } else { format!("https://{input}") };
  let mut url = Url::parse(&candidate).map_err(|_| "Hub 地址格式无效".to_string())?;
  match url.scheme() {
    "https" => {}
    "http" if is_local_network(&url) => {}
    "http" => return Err("公网 Hub 必须使用 HTTPS，HTTP 只能用于本机或内网地址".into()),
    _ => return Err("Hub 地址必须以 https:// 或 http:// 开头".into()),
  }
  if !url.username().is_empty() || url.password().is_some() {
    return Err("Hub 地址不能包含用户名或密码".into());
  }
  url.set_query(None);
  url.set_fragment(None);
  Ok(url)
}

/// Plain HTTP stays acceptable only where traffic does not leave this machine or a private network.
fn is_local_network(url: &Url) -> bool {
  match url.host() {
    Some(Host::Ipv4(address)) => is_private_ipv4(address),
    Some(Host::Ipv6(address)) => is_private_ipv6(address),
    Some(Host::Domain(name)) => {
      let name = name.trim_end_matches('.').to_ascii_lowercase();
      !name.contains('.') || [".localhost", ".local", ".home.arpa"].iter().any(|suffix| name.ends_with(suffix))
    }
    None => false,
  }
}

fn is_private_ipv4(address: Ipv4Addr) -> bool {
  let [first, second, ..] = address.octets();
  // 100.64.0.0/10 is shared address space, which overlay networks such as Tailscale assign.
  address.is_loopback() || address.is_private() || address.is_link_local() || (first == 100 && (64..128).contains(&second))
}

fn is_private_ipv6(address: Ipv6Addr) -> bool {
  let first = address.segments()[0];
  // fc00::/7 holds unique local addresses and fe80::/10 link-local ones.
  address.is_loopback()
    || (first & 0xfe00) == 0xfc00
    || (first & 0xffc0) == 0xfe80
    || address.to_ipv4_mapped().is_some_and(is_private_ipv4)
}

/// Leaves the current Hub for the bundled Hub list.
pub fn return_home<R: Runtime>(app: &AppHandle<R>) {
  let state = app.state::<HubState>();
  state.set_current(None);
  let home = state.home().clone();
  let app = app.clone();
  // Callers include the webview's own navigation hook, so the next navigation starts after it returns.
  tauri::async_runtime::spawn(async move {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
      let _ = window.navigate(home);
    }
  });
}

#[tauri::command]
pub fn normalize_hub_url(url: String) -> Result<String, String> {
  parse_hub_url(&url).map(String::from)
}

#[tauri::command]
pub async fn open_hub<R: Runtime>(app: AppHandle<R>, state: State<'_, HubState>, url: String) -> Result<String, String> {
  let hub = parse_hub_url(&url)?;
  let window = app.get_webview_window(MAIN_WINDOW).ok_or("找不到客户端主窗口")?;
  state.set_current(Some(hub.clone()));
  window.navigate(hub.clone()).map_err(|error| error.to_string())?;
  Ok(hub.into())
}

#[tauri::command]
pub fn close_hub<R: Runtime>(app: AppHandle<R>) {
  return_home(&app);
}
