fn main() {
  // Declaring the commands puts them under the ACL, so only capabilities can grant them.
  let manifest = tauri_build::AppManifest::new().commands(&["normalize_hub_url", "open_hub", "close_hub"]);
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
    .expect("failed to run the Tauri build script");
}
