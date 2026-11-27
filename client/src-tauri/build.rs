fn main() {
  // Declaring the commands puts them under the ACL, so only capabilities can grant them.
  let manifest = tauri_build::AppManifest::new().commands(&[
    "normalize_hub_url",
    "open_hub",
    "close_hub",
    "daemon_status",
    "set_hub_daemon_enabled",
    "reconnect_hub_daemon",
    "disconnect_hub",
    "disconnect_all",
    "sync_known_hubs",
    "confirm_host_fingerprint",
    "reject_host_fingerprint",
  ]);
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
    .expect("failed to run the Tauri build script");
}
