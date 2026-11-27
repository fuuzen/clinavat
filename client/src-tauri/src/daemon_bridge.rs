use tauri::State;

pub use crate::daemon_store::DaemonBridgeSnapshot;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod imp {
  use std::collections::{BTreeMap, HashSet};
  use std::path::PathBuf;
  use std::sync::{Arc, Mutex};

  use clinavat_daemon::identity::DeviceIdentity;
  use clinavat_daemon::{ensure_crypto_provider, init_process_umask, DaemonConfig, DaemonState, DaemonSupervisor};

  use crate::daemon_store::desktop::{
    build_hub_status, load_persisted, persist_map, validate_and_normalize, PersistedHubDaemon,
  };
  use crate::daemon_store::{ClientDeviceMeta, DaemonBridgeSnapshot};

  struct HubRuntime {
    hub_url: String,
    enabled: bool,
    supervisor: Option<Arc<DaemonSupervisor>>,
    last_error: Option<String>,
  }

  struct BridgeState {
    hubs: BTreeMap<String, HubRuntime>,
    config_error: Option<String>,
    config_corrupted: bool,
  }

  pub struct DaemonBridge {
    identity: Option<Arc<DeviceIdentity>>,
    config_path: Option<PathBuf>,
    init_error: Option<String>,
    state: Mutex<BridgeState>,
  }

  impl DaemonBridge {
    pub fn new() -> Self {
      init_process_umask();
      ensure_crypto_provider();
      match DeviceIdentity::load_or_create(None) {
        Ok(identity) => {
          let config_path = identity.state_dir().join("daemon_hubs.json");
          let loaded = load_persisted(&config_path);
          let hubs = loaded
            .entries
            .into_iter()
            .map(|(k, rec)| (k, HubRuntime { hub_url: rec.hub_url, enabled: rec.enabled, supervisor: None, last_error: None }))
            .collect();
          Self {
            identity: Some(Arc::new(identity)),
            config_path: Some(config_path),
            init_error: None,
            state: Mutex::new(BridgeState { hubs, config_error: loaded.load_error, config_corrupted: loaded.corrupted }),
          }
        }
        Err(err) => Self {
          identity: None,
          config_path: None,
          init_error: Some(err.to_string()),
          state: Mutex::new(BridgeState { hubs: BTreeMap::new(), config_error: None, config_corrupted: false }),
        },
      }
    }

    pub fn client_device_meta(&self) -> Option<ClientDeviceMeta> {
      self.identity.as_ref().map(|id| ClientDeviceMeta {
        device_id: id.device_id.clone(), public_key: id.public_key.clone(), device_name: id.name.clone(),
        arch: id.arch.clone(), os_version: id.os_version.clone(),
        default_shell: id.default_shell.clone(), homedir: id.homedir.clone(),
      })
    }

    /// Starts supervisors for every persisted Hub that has `enabled = true` (must run inside async runtime).
    pub fn start_enabled(&self) {
      let Some(identity) = self.identity.as_ref() else { return };
      let Ok(mut guard) = self.state.lock() else { return };
      for rt in guard.hubs.values_mut() {
        if rt.enabled && rt.supervisor.is_none() {
          match spawn_supervisor(&rt.hub_url, Arc::clone(identity)) {
            Ok(sup) => { rt.supervisor = Some(sup); rt.last_error = None; }
            Err(err) => rt.last_error = Some(err),
          }
        }
      }
    }

    pub fn stop_all(&self) {
      if let Ok(mut guard) = self.state.lock() {
        for rt in guard.hubs.values_mut() {
          if let Some(sup) = rt.supervisor.take() { sup.stop(); }
        }
      }
    }

    pub fn snapshot(&self) -> DaemonBridgeSnapshot {
      let (hubs, config_error) = self.state.lock()
        .map(|g| {
          let list = g.hubs.iter()
            .map(|(k, rt)| build_hub_status(k, &rt.hub_url, rt.enabled, rt.last_error.as_deref(), rt.supervisor.as_deref()))
            .collect();
          (list, g.config_error.clone())
        })
        .unwrap_or_default();
      DaemonBridgeSnapshot {
        supported: true,
        device_id: self.identity.as_ref().map(|id| id.device_id.clone()),
        device_name: self.identity.as_ref().map(|id| id.name.clone()),
        public_key: self.identity.as_ref().map(|id| id.public_key.clone()),
        platform: std::env::consts::OS.to_string(),
        arch: self.identity.as_ref().map(|id| id.arch.clone()),
        default_shell: self.identity.as_ref().map(|id| id.default_shell.clone()),
        init_error: self.init_error.clone(),
        config_error,
        hubs,
      }
    }

    pub fn set_enabled(&self, raw_url: &str, enabled: bool) -> Result<DaemonBridgeSnapshot, String> {
      let identity = self.require_identity()?;
      let (hub_url, hub_key) = validate_and_normalize(raw_url)?;
      let mut guard = self.state.lock().map_err(|_| "守护进程状态锁异常".to_string())?;
      let old_map = to_persisted_map(&guard.hubs);
      let mut next_map = old_map.clone();
      next_map.insert(hub_key.clone(), PersistedHubDaemon { hub_url: hub_url.clone(), enabled });
      // Persist before starting any supervisor so a write failure never leaks a running daemon (`L5`).
      persist_map(self.config_path.as_deref(), &next_map)?;
      if enabled {
        let needs_spawn = guard.hubs.get(&hub_key).is_none_or(|rt| rt.supervisor.is_none());
        let spawned = if needs_spawn {
          match spawn_supervisor(&hub_url, Arc::clone(identity)) {
            Ok(sup) => Some(sup),
            Err(err) => {
              let _ = persist_map(self.config_path.as_deref(), &old_map);
              return Err(err);
            }
          }
        } else {
          None
        };
        let entry = guard.hubs.entry(hub_key).or_insert_with(|| HubRuntime {
          hub_url: hub_url.clone(), enabled: true, supervisor: None, last_error: None,
        });
        entry.hub_url = hub_url;
        entry.enabled = true;
        entry.last_error = None;
        if let Some(sup) = spawned { entry.supervisor = Some(sup); }
      } else {
        let entry = guard.hubs.entry(hub_key).or_insert_with(|| HubRuntime {
          hub_url: hub_url.clone(), enabled: false, supervisor: None, last_error: None,
        });
        entry.hub_url = hub_url;
        entry.enabled = false;
        if let Some(sup) = entry.supervisor.take() { sup.stop(); }
      }
      guard.config_error = None;
      guard.config_corrupted = false;
      drop(guard);
      Ok(self.snapshot())
    }

    pub fn reconnect(&self, raw_url: &str) -> Result<DaemonBridgeSnapshot, String> {
      let identity = self.require_identity()?;
      let (hub_url, hub_key) = validate_and_normalize(raw_url)?;
      let mut guard = self.state.lock().map_err(|_| "守护进程状态锁异常".to_string())?;
      let old_map = to_persisted_map(&guard.hubs);
      let mut next_map = old_map.clone();
      next_map.insert(hub_key.clone(), PersistedHubDaemon { hub_url: hub_url.clone(), enabled: true });
      persist_map(self.config_path.as_deref(), &next_map)?;
      let can_wake = guard.hubs.get(&hub_key)
        .and_then(|rt| rt.supervisor.as_ref())
        .is_some_and(|sup| !matches!(sup.current_state(), DaemonState::Stopped));
      let spawned = if can_wake {
        None
      } else {
        match spawn_supervisor(&hub_url, Arc::clone(identity)) {
          Ok(sup) => Some(sup),
          Err(err) => {
            let _ = persist_map(self.config_path.as_deref(), &old_map);
            return Err(err);
          }
        }
      };
      let entry = guard.hubs.entry(hub_key).or_insert_with(|| HubRuntime {
        hub_url: hub_url.clone(), enabled: true, supervisor: None, last_error: None,
      });
      entry.hub_url = hub_url;
      entry.enabled = true;
      entry.last_error = None;
      if let Some(sup) = spawned {
        entry.supervisor = Some(sup);
      } else if let Some(sup) = &entry.supervisor {
        sup.trigger_reconnect();
      }
      guard.config_error = None;
      guard.config_corrupted = false;
      drop(guard);
      Ok(self.snapshot())
    }

    pub fn disconnect_all(&self) -> Result<DaemonBridgeSnapshot, String> {
      let mut guard = self.state.lock().map_err(|_| "守护进程状态锁异常".to_string())?;
      for rt in guard.hubs.values_mut() {
        rt.enabled = false;
        if let Some(sup) = rt.supervisor.take() { sup.stop(); }
      }
      if !guard.config_corrupted || !guard.hubs.is_empty() {
        persist_map(self.config_path.as_deref(), &to_persisted_map(&guard.hubs))?;
        guard.config_error = None;
        guard.config_corrupted = false;
      }
      drop(guard);
      Ok(self.snapshot())
    }

    pub fn sync_known_hubs(&self, hub_urls: Vec<String>) -> Result<DaemonBridgeSnapshot, String> {
      let known_keys: HashSet<String> = hub_urls
        .iter()
        .filter_map(|raw| validate_and_normalize(raw).ok().map(|(_, key)| key))
        .collect();
      let mut guard = self.state.lock().map_err(|_| "守护进程状态锁异常".to_string())?;
      let orphans: Vec<String> = guard.hubs.keys().filter(|k| !known_keys.contains(*k)).cloned().collect();
      if !orphans.is_empty() {
        for key in orphans {
          if let Some(mut rt) = guard.hubs.remove(&key) {
            if let Some(sup) = rt.supervisor.take() { sup.stop(); }
          }
        }
        if !guard.config_corrupted {
          persist_map(self.config_path.as_deref(), &to_persisted_map(&guard.hubs))?;
        }
      }
      drop(guard);
      Ok(self.snapshot())
    }

    pub fn confirm_fingerprint(&self, raw_url: &str, fingerprint: &str) -> Result<DaemonBridgeSnapshot, String> {
      let (_, hub_key) = validate_and_normalize(raw_url)?;
      let sup = self.state.lock().map_err(|_| "守护进程状态锁异常".to_string())?
        .hubs.get(&hub_key).and_then(|rt| rt.supervisor.clone())
        .ok_or_else(|| "当前 Hub 没有待确认指纹的守护进程".to_string())?;
      sup.confirm_host_fingerprint(fingerprint).map_err(|e| e.to_string())?;
      Ok(self.snapshot())
    }

    pub fn reject_fingerprint(&self, raw_url: &str) -> Result<DaemonBridgeSnapshot, String> {
      let (_, hub_key) = validate_and_normalize(raw_url)?;
      let mut guard = self.state.lock().map_err(|_| "守护进程状态锁异常".to_string())?;
      if let Some(entry) = guard.hubs.get_mut(&hub_key) {
        entry.enabled = false;
        if let Some(sup) = entry.supervisor.take() { sup.reject_host_fingerprint(); }
        entry.last_error = Some("已拒绝未受信任的主机密钥指纹".into());
        persist_map(self.config_path.as_deref(), &to_persisted_map(&guard.hubs))?;
        guard.config_error = None;
        guard.config_corrupted = false;
      }
      drop(guard);
      Ok(self.snapshot())
    }

    fn require_identity(&self) -> Result<&Arc<DeviceIdentity>, String> {
      self.identity.as_ref().ok_or_else(|| {
        self.init_error.clone().unwrap_or_else(|| "守护进程身份初始化失败".into())
      })
    }
  }

  impl Drop for DaemonBridge {
    fn drop(&mut self) { self.stop_all(); }
  }

  fn spawn_supervisor(hub_url: &str, identity: Arc<DeviceIdentity>) -> Result<Arc<DaemonSupervisor>, String> {
    let sup = Arc::new(DaemonSupervisor::with_identity(DaemonConfig::new(hub_url), identity).map_err(|e| e.to_string())?);
    let _ = sup.start();
    Ok(sup)
  }

  fn to_persisted_map(hubs: &BTreeMap<String, HubRuntime>) -> BTreeMap<String, PersistedHubDaemon> {
    hubs.iter().map(|(k, rt)| (k.clone(), PersistedHubDaemon { hub_url: rt.hub_url.clone(), enabled: rt.enabled })).collect()
  }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
mod imp {
  use crate::daemon_store::DaemonBridgeSnapshot;

  pub struct DaemonBridge;

  impl DaemonBridge {
    pub fn new() -> Self { Self }
    pub fn snapshot(&self) -> DaemonBridgeSnapshot {
      DaemonBridgeSnapshot { supported: false, platform: std::env::consts::OS.to_string(), ..Default::default() }
    }
    pub fn set_enabled(&self, _: &str, _: bool) -> Result<DaemonBridgeSnapshot, String> { Err("移动端不支持本机开发机守护进程".into()) }
    pub fn reconnect(&self, _: &str) -> Result<DaemonBridgeSnapshot, String> { Err("移动端不支持本机开发机守护进程".into()) }
    pub fn disconnect_all(&self) -> Result<DaemonBridgeSnapshot, String> { Ok(self.snapshot()) }
    pub fn sync_known_hubs(&self, _: Vec<String>) -> Result<DaemonBridgeSnapshot, String> { Ok(self.snapshot()) }
    pub fn confirm_fingerprint(&self, _: &str, _: &str) -> Result<DaemonBridgeSnapshot, String> { Err("移动端不支持本机开发机守护进程".into()) }
    pub fn reject_fingerprint(&self, _: &str) -> Result<DaemonBridgeSnapshot, String> { Err("移动端不支持本机开发机守护进程".into()) }
  }
}

pub use imp::DaemonBridge;

#[tauri::command]
pub fn daemon_status(bridge: State<'_, DaemonBridge>) -> DaemonBridgeSnapshot { bridge.snapshot() }
#[tauri::command]
pub async fn set_hub_daemon_enabled(bridge: State<'_, DaemonBridge>, hub_url: String, enabled: bool) -> Result<DaemonBridgeSnapshot, String> { bridge.set_enabled(&hub_url, enabled) }
#[tauri::command]
pub async fn reconnect_hub_daemon(bridge: State<'_, DaemonBridge>, hub_url: String) -> Result<DaemonBridgeSnapshot, String> { bridge.reconnect(&hub_url) }
#[tauri::command]
pub async fn disconnect_hub(bridge: State<'_, DaemonBridge>, hub_url: String) -> Result<DaemonBridgeSnapshot, String> { bridge.set_enabled(&hub_url, false) }
#[tauri::command]
pub async fn disconnect_all(bridge: State<'_, DaemonBridge>) -> Result<DaemonBridgeSnapshot, String> { bridge.disconnect_all() }
#[tauri::command]
pub async fn sync_known_hubs(bridge: State<'_, DaemonBridge>, hub_urls: Vec<String>) -> Result<DaemonBridgeSnapshot, String> { bridge.sync_known_hubs(hub_urls) }
#[tauri::command]
pub async fn confirm_host_fingerprint(bridge: State<'_, DaemonBridge>, hub_url: String, fingerprint: String) -> Result<DaemonBridgeSnapshot, String> { bridge.confirm_fingerprint(&hub_url, &fingerprint) }
#[tauri::command]
pub async fn reject_host_fingerprint(bridge: State<'_, DaemonBridge>, hub_url: String) -> Result<DaemonBridgeSnapshot, String> { bridge.reject_fingerprint(&hub_url) }
