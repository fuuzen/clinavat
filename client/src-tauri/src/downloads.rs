use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::webview::DownloadEvent;
use tauri::{Manager, Runtime, Webview};

/// Destinations by download URL, because macOS does not report the saved path when a download finishes.
#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, PathBuf>>);

pub fn handle<R: Runtime>(webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
  let downloads = webview.state::<Downloads>();
  match event {
    DownloadEvent::Requested { url, destination } => {
      #[cfg(target_os = "ios")]
      ios::move_to_documents(&webview, destination);
      if let Ok(mut pending) = downloads.0.lock() {
        pending.insert(url.to_string(), destination.clone());
      }
    }
    DownloadEvent::Finished { url, path, success } => {
      let requested = downloads.0.lock().ok().and_then(|mut pending| pending.remove(url.as_str()));
      if success {
        reveal(&webview, path.or(requested));
      }
    }
    _ => {}
  }
  true
}

#[cfg(desktop)]
fn reveal<R: Runtime>(webview: &Webview<R>, path: Option<PathBuf>) {
  use tauri_plugin_opener::OpenerExt;
  if let Some(path) = path {
    let _ = webview.opener().reveal_item_in_dir(path);
  }
}

/// iOS saves into Documents, which the Files app lists; Android webviews do not start downloads at all.
#[cfg(mobile)]
fn reveal<R: Runtime>(_webview: &Webview<R>, _path: Option<PathBuf>) {}

#[cfg(target_os = "ios")]
mod ios {
  use std::path::{Path, PathBuf};

  use tauri::{Manager, Runtime, Webview};

  /// The engine proposes a desktop-style Downloads folder, which does not exist inside the app sandbox.
  pub fn move_to_documents<R: Runtime>(webview: &Webview<R>, destination: &mut PathBuf) {
    let (Ok(home), Some(name)) = (webview.path().home_dir(), destination.file_name()) else { return };
    let directory = home.join("Documents");
    let name = Path::new(name);
    let stem = name.file_stem().unwrap_or(name.as_os_str()).to_string_lossy().into_owned();
    let extension = name.extension().map(|extension| format!(".{}", extension.to_string_lossy())).unwrap_or_default();
    let mut candidate = directory.join(name);
    let mut counter = 1;
    while candidate.exists() {
      candidate = directory.join(format!("{stem} ({counter}){extension}"));
      counter += 1;
    }
    *destination = candidate;
  }
}
