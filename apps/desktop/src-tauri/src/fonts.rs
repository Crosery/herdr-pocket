//! System monospace / Nerd Font discovery and raw font-face loader.
//!
//! WKWebView hides user-installed fonts under `~/Library/Fonts` from standard CSS `font-family`
//! matching and Canvas fingerprinting heuristics. Scanning OS font folders directly and serving
//! the selected font faces as raw `ArrayBuffer` bytes (`tauri::ipc::Response`) for `new FontFace(...)`
//! lets the terminal switch cleanly to `Maple Mono NF CN`, `JetBrainsMono Nerd Font`, etc.

use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_FONT_FILE_BYTES: u64 = 48 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontCatalog {
    pub families: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub herdr_font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbols_font: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFaceMeta {
    pub id: usize,
    pub family: String,
    pub weight: u16,
    pub style: String,
    pub format: String,
}

#[derive(Debug, Clone)]
struct ScannedFace {
    id: usize,
    family: String,
    weight: u16,
    italic: bool,
    normal_width: bool,
    is_variable_file: bool,
    format: &'static str,
    path: PathBuf,
    ttc_index: Option<u32>,
    is_mono: bool,
}

struct FontCache {
    faces: Vec<ScannedFace>,
    by_family_lower: HashMap<String, Vec<usize>>,
    families: Vec<String>,
    symbols_font: Option<String>,
}

fn cache() -> &'static Mutex<Option<FontCache>> {
    static CACHE: OnceLock<Mutex<Option<FontCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn font_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(not(windows))]
    let home = crate::home_dir();
    #[cfg(target_os = "macos")]
    {
        if let Some(h) = &home {
            dirs.push(h.join("Library/Fonts"));
        }
        dirs.push(PathBuf::from("/Library/Fonts"));
        dirs.push(PathBuf::from("/System/Library/Fonts"));
        dirs.push(PathBuf::from("/System/Library/Fonts/Supplemental"));
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push(local.join("Microsoft\\Windows\\Fonts"));
        }
        if let Some(win) = std::env::var_os("WINDIR").map(PathBuf::from) {
            dirs.push(win.join("Fonts"));
        } else {
            dirs.push(PathBuf::from("C:\\Windows\\Fonts"));
        }
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        if let Some(h) = &home {
            dirs.push(h.join(".local/share/fonts"));
            dirs.push(h.join(".fonts"));
        }
        dirs.push(PathBuf::from("/usr/local/share/fonts"));
        dirs.push(PathBuf::from("/usr/share/fonts"));
    }
    dirs
}

fn read_herdr_app_font() -> Option<String> {
    let home = crate::home_dir()?;
    let path = home.join(".config").join("herdr-app").join("settings.json");
    let raw = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("font")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn be_u16(b: &[u8]) -> u16 {
    u16::from_be_bytes([b[0], b[1]])
}

fn be_u32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn decode_name_string(platform_id: u16, encoding_id: u16, raw: &[u8]) -> Option<String> {
    if platform_id == 3 || platform_id == 0 || (platform_id == 2 && encoding_id == 1) {
        if raw.len() % 2 != 0 {
            return None;
        }
        let u16s: Vec<u16> = raw.chunks_exact(2).map(be_u16).collect();
        let s = String::from_utf16(&u16s).ok()?;
        let t = s.trim().trim_matches('\0');
        return if t.is_empty() { None } else { Some(t.to_string()) };
    }
    if platform_id == 1 && encoding_id == 0 {
        let s: String = raw
            .iter()
            .filter(|&&b| (0x20..=0x7e).contains(&b))
            .map(|&b| b as char)
            .collect();
        let t = s.trim();
        return if t.is_empty() { None } else { Some(t.to_string()) };
    }
    None
}

fn parse_name_table(data: &[u8]) -> (Option<String>, Option<String>) {
    if data.len() < 6 {
        return (None, None);
    }
    let count = be_u16(&data[2..4]) as usize;
    let string_offset = be_u16(&data[4..6]) as usize;
    if data.len() < 6 + count * 12 || string_offset >= data.len() {
        return (None, None);
    }

    let mut fam16: Option<(u8, String)> = None;
    let mut fam1: Option<(u8, String)> = None;
    let mut sub17: Option<(u8, String)> = None;
    let mut sub2: Option<(u8, String)> = None;

    for i in 0..count {
        let rec = &data[6 + i * 12..6 + (i + 1) * 12];
        let platform = be_u16(&rec[0..2]);
        let encoding = be_u16(&rec[2..4]);
        let lang = be_u16(&rec[4..6]);
        let name_id = be_u16(&rec[6..8]);
        if !matches!(name_id, 1 | 2 | 16 | 17) {
            continue;
        }
        let len = be_u16(&rec[8..10]) as usize;
        let off = string_offset.saturating_add(be_u16(&rec[10..12]) as usize);
        if off.checked_add(len).is_none_or(|end| end > data.len()) {
            continue;
        }
        let rank: u8 = match (platform, encoding, lang) {
            (3, 1, 0x0409) | (3, 10, 0x0409) => 4,
            (3, 1, _) | (3, 10, _) => 3,
            (0, _, _) => 2,
            (1, 0, 0) => 1,
            _ => 0,
        };
        if rank == 0 {
            continue;
        }
        let Some(val) = decode_name_string(platform, encoding, &data[off..off + len]) else {
            continue;
        };
        let slot = match name_id {
            16 => &mut fam16,
            1 => &mut fam1,
            17 => &mut sub17,
            2 => &mut sub2,
            _ => unreachable!(),
        };
        if slot.as_ref().is_none_or(|(best, _)| rank > *best) {
            *slot = Some((rank, val));
        }
    }

    (
        fam16.or(fam1).map(|(_, s)| s),
        sub17.or(sub2).map(|(_, s)| s),
    )
}

pub fn name_looks_mono(name: &str) -> bool {
    let cleaned = name.to_ascii_lowercase().replace("unicode", "");
    const NEEDLES: &[&str] = &[
        "mono",
        "code",
        "console",
        "term",
        "nerd",
        "menlo",
        "monaco",
        "consolas",
        "cascadia",
        "courier",
        "hack",
        "iosevka",
        "cica",
        "sarasa",
        "inconsolata",
        "fira",
        "victor",
        "hermit",
        "fantasque",
    ];
    NEEDLES.iter().any(|n| cleaned.contains(n))
}

pub fn is_selectable_mono_family(family: &str, is_mono: bool) -> bool {
    if !is_mono || family.starts_with('.') {
        return false;
    }
    let lower = family.to_ascii_lowercase();
    if lower.starts_with("symbols nerd font") {
        return false;
    }
    if lower.ends_with(" propo") || lower.contains("nerd font propo") {
        return false;
    }
    !matches!(
        lower.as_str(),
        "gb18030 bitmap" | "apple braille" | "stixnonunicode" | "arial unicode ms"
    )
}

#[derive(Debug, Clone)]
struct TableDirEntry {
    tag: [u8; 4],
    offset: u32,
    length: u32,
}

fn read_exact_at(f: &mut File, off: u64, len: usize) -> std::io::Result<Vec<u8>> {
    let mut buf = vec![0u8; len];
    f.seek(SeekFrom::Start(off))?;
    f.read_exact(&mut buf)?;
    Ok(buf)
}

fn parse_sfnt_metadata(
    f: &mut File,
    sfnt_off: u64,
    file_len: u64,
    path: &Path,
    ttc_index: Option<u32>,
) -> Option<ScannedFace> {
    if sfnt_off + 12 > file_len {
        return None;
    }
    let hdr = read_exact_at(f, sfnt_off, 12).ok()?;
    let sfnt_ver = &hdr[0..4];
    let format = if sfnt_ver == b"OTTO" {
        "opentype"
    } else if sfnt_ver == [0x00, 0x01, 0x00, 0x00] || sfnt_ver == b"true" {
        "truetype"
    } else {
        return None;
    };
    let num_tables = be_u16(&hdr[4..6]) as usize;
    if num_tables == 0 || num_tables > 128 || sfnt_off + 12 + (num_tables as u64) * 16 > file_len {
        return None;
    }
    let table_bytes = read_exact_at(f, sfnt_off + 12, num_tables * 16).ok()?;

    let mut name_rec: Option<(u32, u32)> = None;
    let mut os2_rec: Option<(u32, u32)> = None;
    let mut post_rec: Option<(u32, u32)> = None;
    let mut head_rec: Option<(u32, u32)> = None;

    for i in 0..num_tables {
        let r = &table_bytes[i * 16..(i + 1) * 16];
        let tag = &r[0..4];
        let off = be_u32(&r[8..12]);
        let len = be_u32(&r[12..16]);
        match tag {
            b"name" => name_rec = Some((off, len)),
            b"OS/2" => os2_rec = Some((off, len)),
            b"post" => post_rec = Some((off, len)),
            b"head" => head_rec = Some((off, len)),
            _ => {}
        }
    }

    let (name_off, name_len) = name_rec?;
    if name_len == 0 || name_len > 2 * 1024 * 1024 || (name_off as u64) + (name_len as u64) > file_len {
        return None;
    }
    let name_bytes = read_exact_at(f, name_off as u64, name_len as usize).ok()?;
    let (family_opt, subfamily_opt) = parse_name_table(&name_bytes);
    let family = family_opt?;

    let mut weight = 400u16;
    let mut italic = false;
    let mut panose_mono = false;
    let mut width_class = 5u16;
    if let Some((off, len)) = os2_rec {
        if len >= 64 && (off as u64) + 64 <= file_len {
            if let Ok(os2) = read_exact_at(f, off as u64, 64) {
                let w = be_u16(&os2[4..6]);
                if (100..=900).contains(&w) {
                    weight = w;
                }
                let wc = be_u16(&os2[6..8]);
                if wc > 0 {
                    width_class = wc;
                }
                if os2[35] == 9 {
                    panose_mono = true;
                }
                let fs_sel = be_u16(&os2[62..64]);
                if fs_sel & 1 != 0 || fs_sel & (1 << 9) != 0 {
                    italic = true;
                }
            }
        }
    }
    if !italic {
        if let Some((off, len)) = head_rec {
            if len >= 46 && (off as u64) + 46 <= file_len {
                if let Ok(head) = read_exact_at(f, off as u64, 46) {
                    if be_u16(&head[44..46]) & 2 != 0 {
                        italic = true;
                    }
                }
            }
        }
    }
    let mut sub_non_normal_width = false;
    if let Some(sub) = &subfamily_opt {
        let lower = sub.to_ascii_lowercase();
        if lower.contains("italic") || lower.contains("oblique") {
            italic = true;
        }
        if ["wide", "semiwide", "condensed", "semicondensed", "compressed", "narrow"]
            .iter()
            .any(|k| lower.contains(k))
        {
            sub_non_normal_width = true;
        }
    }
    let normal_width = (width_class == 0 || width_class == 5) && !sub_non_normal_width;
    let is_variable_file = path
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.contains('['));

    let mut fixed_pitch = false;
    if let Some((off, len)) = post_rec {
        if len >= 16 && (off as u64) + 16 <= file_len {
            if let Ok(post) = read_exact_at(f, off as u64, 16) {
                if be_u32(&post[12..16]) != 0 {
                    fixed_pitch = true;
                }
            }
        }
    }

    let is_mono = fixed_pitch || panose_mono || name_looks_mono(&family);
    Some(ScannedFace {
        id: 0,
        family,
        weight,
        italic,
        normal_width,
        is_variable_file,
        format,
        path: path.to_path_buf(),
        ttc_index,
        is_mono,
    })
}

fn scan_dir(dir: &Path, depth: u8, out: &mut Vec<ScannedFace>) {
    if depth > 4 || !dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir(&path, depth + 1, out);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "ttf" | "otf" | "ttc") {
            continue;
        }
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let file_len = meta.len();
        if file_len < 32 || file_len > MAX_FONT_FILE_BYTES {
            continue;
        }
        let Ok(mut f) = File::open(&path) else {
            continue;
        };
        let Ok(head) = read_exact_at(&mut f, 0, 12) else {
            continue;
        };
        if &head[0..4] == b"ttcf" {
            let num_fonts = be_u32(&head[8..12]);
            if num_fonts == 0 || num_fonts > 64 || 12 + (num_fonts as u64) * 4 > file_len {
                continue;
            }
            let Ok(offs) = read_exact_at(&mut f, 12, (num_fonts as usize) * 4) else {
                continue;
            };
            for idx in 0..num_fonts {
                let sfnt_off = be_u32(&offs[(idx as usize) * 4..((idx as usize) + 1) * 4]) as u64;
                if let Some(face) = parse_sfnt_metadata(&mut f, sfnt_off, file_len, &path, Some(idx)) {
                    out.push(face);
                }
            }
        } else if let Some(face) = parse_sfnt_metadata(&mut f, 0, file_len, &path, None) {
            out.push(face);
        }
    }
}

fn build_cache() -> FontCache {
    let mut raw = Vec::new();
    for dir in font_dirs() {
        scan_dir(&dir, 0, &mut raw);
    }

    let mut mono_families: BTreeMap<String, String> = BTreeMap::new();
    let mut by_family_lower: HashMap<String, Vec<usize>> = HashMap::new();
    let mut faces = Vec::with_capacity(raw.len());
    let mut symbols_font: Option<String> = None;

    for mut face in raw {
        if face.family.starts_with('.') {
            continue;
        }
        let id = faces.len();
        face.id = id;
        let key = face.family.to_ascii_lowercase();
        if is_selectable_mono_family(&face.family, face.is_mono) {
            mono_families
                .entry(key.clone())
                .or_insert_with(|| face.family.clone());
        }
        if key == "symbols nerd font mono" {
            symbols_font = Some(face.family.clone());
        } else if key == "symbols nerd font" && symbols_font.is_none() {
            symbols_font = Some(face.family.clone());
        }
        by_family_lower.entry(key).or_default().push(id);
        faces.push(face);
    }

    let mut families: Vec<String> = mono_families.into_values().collect();
    families.sort_by_key(|s| s.to_ascii_lowercase());

    FontCache {
        faces,
        by_family_lower,
        families,
        symbols_font,
    }
}

fn ensure_cache<T>(f: impl FnOnce(&FontCache) -> T) -> Result<T, String> {
    let mut guard = cache()
        .lock()
        .map_err(|_| "font cache lock poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(build_cache());
    }
    Ok(f(guard.as_ref().expect("cache populated")))
}

/// Extract a standalone SFNT binary from a `.ttc` file, rewriting absolute table offsets.
fn extract_ttc_face(file_bytes: &[u8], index: u32) -> Result<Vec<u8>, String> {
    if file_bytes.len() < 12 || &file_bytes[0..4] != b"ttcf" {
        return Err("不是有效的 TTC 字体集合".into());
    }
    let num_fonts = be_u32(&file_bytes[8..12]);
    if index >= num_fonts || 12 + (num_fonts as usize) * 4 > file_bytes.len() {
        return Err("TTC 字体索引越界".into());
    }
    let sfnt_off = be_u32(&file_bytes[12 + (index as usize) * 4..16 + (index as usize) * 4]) as usize;
    if sfnt_off + 12 > file_bytes.len() {
        return Err("TTC 表头越界".into());
    }
    let num_tables = be_u16(&file_bytes[sfnt_off + 4..sfnt_off + 6]) as usize;
    if num_tables == 0 || sfnt_off + 12 + num_tables * 16 > file_bytes.len() {
        return Err("TTC 表目录越界".into());
    }

    let mut tables = Vec::with_capacity(num_tables);
    let mut total_data = 0usize;
    for i in 0..num_tables {
        let r = &file_bytes[sfnt_off + 12 + i * 16..sfnt_off + 12 + (i + 1) * 16];
        let tag: [u8; 4] = r[0..4].try_into().unwrap();
        let off = be_u32(&r[8..12]);
        let len = be_u32(&r[12..16]);
        if (off as usize).checked_add(len as usize).is_none_or(|e| e > file_bytes.len()) {
            return Err("TTC 表数据越界".into());
        }
        tables.push(TableDirEntry { tag, offset: off, length: len });
        total_data += ((len as usize) + 3) & !3;
    }

    let dir_size = 12 + num_tables * 16;
    let mut out = Vec::with_capacity(dir_size + total_data);
    out.extend_from_slice(&file_bytes[sfnt_off..sfnt_off + 12]);
    let mut cur_off = dir_size;
    for t in &tables {
        let orig_rec_off = sfnt_off + 12 + tables.iter().position(|x| x.tag == t.tag).unwrap() * 16;
        out.extend_from_slice(&t.tag);
        out.extend_from_slice(&file_bytes[orig_rec_off + 4..orig_rec_off + 8]);
        out.extend_from_slice(&(cur_off as u32).to_be_bytes());
        out.extend_from_slice(&t.length.to_be_bytes());
        cur_off += ((t.length as usize) + 3) & !3;
    }
    for t in &tables {
        let s = t.offset as usize;
        let e = s + t.length as usize;
        out.extend_from_slice(&file_bytes[s..e]);
        let pad = (4 - (t.length as usize % 4)) % 4;
        out.resize(out.len() + pad, 0);
    }
    Ok(out)
}

#[tauri::command]
pub async fn terminal_list_fonts() -> Result<FontCatalog, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let herdr_font = read_herdr_app_font();
        ensure_cache(|c| FontCatalog {
            families: c.families.clone(),
            herdr_font,
            symbols_font: c.symbols_font.clone(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn terminal_font_faces(family: String) -> Result<Vec<FontFaceMeta>, String> {
    let want = family.trim().to_ascii_lowercase();
    if want.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        ensure_cache(|c| {
            let Some(ids) = c.by_family_lower.get(&want) else {
                return Vec::new();
            };
            // Pick best representative per (weight, italic) slot; cap to keep load instantaneous:
            // Regular (~400 normal) + Bold (~700 normal), plus Italic (~400 italic) if present.
            let pick_closest = |target_weight: u16, target_italic: bool| -> Option<&ScannedFace> {
                ids.iter()
                    .map(|&id| &c.faces[id])
                    .filter(|f| f.italic == target_italic)
                    .min_by_key(|f| (!f.normal_width, f.is_variable_file, f.weight.abs_diff(target_weight)))
            };
            let mut chosen: Vec<&ScannedFace> = Vec::new();
            for (w, it) in [(400, false), (700, false), (400, true), (700, true)] {
                if let Some(face) = pick_closest(w, it) {
                    if !chosen.iter().any(|existing| existing.id == face.id) {
                        chosen.push(face);
                    }
                }
            }
            chosen
                .into_iter()
                .map(|f| FontFaceMeta {
                    id: f.id,
                    family: f.family.clone(),
                    weight: f.weight,
                    style: if f.italic { "italic".into() } else { "normal".into() },
                    format: f.format.to_string(),
                })
                .collect()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn terminal_font_bytes(id: usize) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, ttc_index) = ensure_cache(|c| {
            c.faces
                .get(id)
                .map(|f| (f.path.clone(), f.ttc_index))
                .ok_or_else(|| "找不到对应的字体".to_string())
        })??;
        let bytes = fs::read(&path).map_err(|e| format!("无法读取字体文件: {e}"))?;
        let out = match ttc_index {
            Some(idx) => extract_ttc_face(&bytes, idx)?,
            None => bytes,
        };
        Ok(tauri::ipc::Response::new(out))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{is_selectable_mono_family, name_looks_mono, parse_name_table};

    #[test]
    fn mono_name_heuristic_matches_terminal_fonts() {
        assert!(name_looks_mono("Maple Mono NF CN"));
        assert!(name_looks_mono("JetBrainsMono Nerd Font"));
        assert!(name_looks_mono("Menlo"));
        assert!(name_looks_mono("Fira Code"));
        assert!(!name_looks_mono("Helvetica Neue"));
        assert!(!name_looks_mono("Arial Unicode MS"));
        assert!(!name_looks_mono("STIXNonUnicode"));
    }

    #[test]
    fn selectable_mono_family_filters_propo_symbols_and_bitmap_fallbacks() {
        assert!(is_selectable_mono_family("Maple Mono NF CN", true));
        assert!(is_selectable_mono_family("Fira Code", true));
        assert!(is_selectable_mono_family("SF Mono", true));
        assert!(!is_selectable_mono_family("JetBrainsMono Nerd Font Propo", true));
        assert!(!is_selectable_mono_family("ComicShannsMono Nerd Font Propo", true));
        assert!(!is_selectable_mono_family("Symbols Nerd Font", true));
        assert!(!is_selectable_mono_family("Symbols Nerd Font Mono", true));
        assert!(!is_selectable_mono_family("GB18030 Bitmap", true));
        assert!(!is_selectable_mono_family("Arial Unicode MS", false));
        assert!(!is_selectable_mono_family("STIXNonUnicode", false));
        assert!(!is_selectable_mono_family(".SF NS Mono", true));
    }

    #[test]
    fn name_table_reads_utf16_family() {
        // Minimal SFNT `name` table with 1 record: platform 3, enc 1, lang 0x0409, nameID 16 ("TestMono")
        let utf16: Vec<u8> = "TestMono"
            .encode_utf16()
            .flat_map(|u| u.to_be_bytes())
            .collect();
        let mut table = Vec::new();
        table.extend_from_slice(&0u16.to_be_bytes()); // format
        table.extend_from_slice(&1u16.to_be_bytes()); // count
        table.extend_from_slice(&(6u16 + 12u16).to_be_bytes()); // stringOffset
        // record
        table.extend_from_slice(&3u16.to_be_bytes());
        table.extend_from_slice(&1u16.to_be_bytes());
        table.extend_from_slice(&0x0409u16.to_be_bytes());
        table.extend_from_slice(&16u16.to_be_bytes());
        table.extend_from_slice(&(utf16.len() as u16).to_be_bytes());
        table.extend_from_slice(&0u16.to_be_bytes());
        table.extend_from_slice(&utf16);
        let (fam, sub) = parse_name_table(&table);
        assert_eq!(fam.as_deref(), Some("TestMono"));
        assert!(sub.is_none());
    }
}
