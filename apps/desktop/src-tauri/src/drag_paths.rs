//! Reads native OS file/folder paths dragged into the desktop window from Finder.
//!
//! With `"dragDropEnabled": false` in `tauri.conf.json`, HTML5 drag-and-drop fires so
//! intra-app workspace/tab drags continue to work, while macOS WebKit holds the real
//! Finder filesystem paths on the drag pasteboard (`Apple CFPasteboard drag`).

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraggedOsItem {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

fn clean_path_str(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if raw.len() > 1 {
        let trimmed = raw.trim_end_matches(['/', '\\']);
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    raw.into_owned()
}

pub fn decode_file_url_to_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim().trim_end_matches('\0').trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("file://") {
        let parsed = url::Url::parse(trimmed).ok()?;
        if parsed.scheme() != "file" {
            return None;
        }
        return parsed.to_file_path().ok();
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        Some(path)
    } else {
        None
    }
}

pub fn build_dragged_item(path: &Path) -> Option<DraggedOsItem> {
    let meta = std::fs::metadata(path).ok()?;
    let is_dir = meta.is_dir();
    let size = if is_dir { 0 } else { meta.len() };
    let cleaned = clean_path_str(path);
    let name = Path::new(&cleaned)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cleaned.clone());
    Some(DraggedOsItem {
        path: cleaned,
        name,
        is_dir,
        size,
    })
}

pub fn collect_unique_dragged_items(
    paths: impl IntoIterator<Item = PathBuf>,
) -> Vec<DraggedOsItem> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        let Some(item) = build_dragged_item(&path) else {
            continue;
        };
        if seen.insert(item.path.clone()) {
            out.push(item);
        }
    }
    out
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn read_os_drag_paths_macos() -> Vec<DraggedOsItem> {
    use objc2_app_kit::{NSFilenamesPboardType, NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::{ns_string, NSArray, NSString, NSURL};

    objc2::rc::autoreleasepool(|_| {
        let pb = NSPasteboard::pasteboardWithName(ns_string!("Apple CFPasteboard drag"));
        let mut candidates: Vec<PathBuf> = Vec::new();

        let url_to_path = |raw: &str| -> Option<PathBuf> {
            let trimmed = raw.trim().trim_end_matches('\0').trim();
            if trimmed.is_empty() {
                return None;
            }
            if trimmed.starts_with("file://") {
                let ns = NSString::from_str(trimmed);
                if let Some(nsurl) = NSURL::URLWithString(&ns) {
                    if nsurl.isFileURL() {
                        if let Some(resolved) = nsurl.filePathURL().and_then(|u| u.to_file_path()) {
                            return Some(resolved);
                        }
                        if let Some(resolved) = nsurl.to_file_path() {
                            return Some(resolved);
                        }
                    }
                }
            }
            decode_file_url_to_path(trimmed)
        };

        let file_url_type = unsafe { NSPasteboardTypeFileURL };
        let public_file_url = ns_string!("public.file-url");
        let filenames_type = unsafe { NSFilenamesPboardType };

        if let Some(items) = pb.pasteboardItems() {
            for item in items.iter() {
                let mut got_from_item = false;
                for ty in [file_url_type, public_file_url] {
                    if let Some(s) = item.stringForType(ty) {
                        if let Some(p) = url_to_path(&s.to_string()) {
                            candidates.push(p);
                            got_from_item = true;
                            break;
                        }
                    }
                    if let Some(data) = item.dataForType(ty) {
                        let s = String::from_utf8_lossy(&data.to_vec()).into_owned();
                        if let Some(p) = url_to_path(&s) {
                            candidates.push(p);
                            got_from_item = true;
                            break;
                        }
                    }
                }
                if !got_from_item {
                    if let Some(plist) = item.propertyListForType(filenames_type) {
                        if let Some(s) = plist.downcast_ref::<NSString>() {
                            if let Some(p) = decode_file_url_to_path(&s.to_string()) {
                                candidates.push(p);
                            }
                        } else if let Some(arr) = plist.downcast_ref::<NSArray>() {
                            for elem in arr.iter() {
                                if let Some(s) = elem.downcast_ref::<NSString>() {
                                    if let Some(p) = decode_file_url_to_path(&s.to_string()) {
                                        candidates.push(p);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if let Some(plist) = pb.propertyListForType(filenames_type) {
            if let Some(arr) = plist.downcast_ref::<NSArray>() {
                for elem in arr.iter() {
                    if let Some(s) = elem.downcast_ref::<NSString>() {
                        if let Some(p) = decode_file_url_to_path(&s.to_string()) {
                            candidates.push(p);
                        }
                    }
                }
            } else if let Some(s) = plist.downcast_ref::<NSString>() {
                if let Some(p) = decode_file_url_to_path(&s.to_string()) {
                    candidates.push(p);
                }
            }
        }

        collect_unique_dragged_items(candidates)
    })
}

#[tauri::command]
pub fn read_os_drag_paths() -> Vec<DraggedOsItem> {
    #[cfg(target_os = "macos")]
    {
        read_os_drag_paths_macos()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{build_dragged_item, collect_unique_dragged_items, decode_file_url_to_path};
    use std::path::PathBuf;

    #[test]
    fn decodes_file_urls_and_absolute_paths() {
        assert_eq!(
            decode_file_url_to_path("file:///tmp/hello%20world/notes.txt"),
            Some(PathBuf::from("/tmp/hello world/notes.txt"))
        );
        assert_eq!(
            decode_file_url_to_path("file:///tmp/%E4%B8%AD%E6%96%87/dir/\0"),
            Some(PathBuf::from("/tmp/中文/dir/"))
        );
        assert_eq!(
            decode_file_url_to_path("https://example.com/file.txt"),
            None
        );
        assert_eq!(decode_file_url_to_path("relative/path.txt"), None);
        assert_eq!(decode_file_url_to_path(""), None);
    }

    #[test]
    fn builds_deduplicated_metadata_for_temp_dir_and_file() {
        let base = std::env::temp_dir().join(format!("herdr-pocket-drag-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let sub = base.join("my folder");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("report.md");
        std::fs::write(&file, b"hello drag").unwrap();

        let dir_url = url::Url::from_directory_path(&sub).unwrap().to_string();
        let file_url = url::Url::from_file_path(&file).unwrap().to_string();
        let p_dir = decode_file_url_to_path(&dir_url).unwrap();
        let p_file = decode_file_url_to_path(&file_url).unwrap();

        let dir_item = build_dragged_item(&p_dir).unwrap();
        assert_eq!(dir_item.name, "my folder");
        assert!(dir_item.is_dir);
        assert_eq!(dir_item.size, 0);
        assert!(!dir_item.path.ends_with('/'));

        let file_item = build_dragged_item(&p_file).unwrap();
        assert_eq!(file_item.name, "report.md");
        assert!(!file_item.is_dir);
        assert_eq!(file_item.size, 10);

        let items = collect_unique_dragged_items([
            p_dir.clone(),
            p_file.clone(),
            sub.clone(),
            base.join("does-not-exist"),
        ]);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], dir_item);
        assert_eq!(items[1], file_item);

        let _ = std::fs::remove_dir_all(&base);
    }
}
