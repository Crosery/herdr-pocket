//! The few SQLite calls the cookie reader needs, against the OS's own library
//! (macOS `libsqlite3`, Windows `winsqlite3.dll`), so nothing is compiled from C.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::Path;

const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_DONE: c_int = 101;
const SQLITE_OPEN_READWRITE: c_int = 0x02;

#[cfg_attr(target_os = "macos", link(name = "sqlite3"))]
#[cfg_attr(windows, link(name = "winsqlite3"))]
extern "system" {
    fn sqlite3_open_v2(
        filename: *const c_char,
        db: *mut *mut c_void,
        flags: c_int,
        vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_close(db: *mut c_void) -> c_int;
    fn sqlite3_errmsg(db: *mut c_void) -> *const c_char;
    fn sqlite3_prepare_v2(
        db: *mut c_void,
        sql: *const c_char,
        n: c_int,
        stmt: *mut *mut c_void,
        tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_step(stmt: *mut c_void) -> c_int;
    fn sqlite3_finalize(stmt: *mut c_void) -> c_int;
    #[cfg(test)]
    fn sqlite3_column_count(stmt: *mut c_void) -> c_int;
    fn sqlite3_column_bytes(stmt: *mut c_void, i: c_int) -> c_int;
    fn sqlite3_column_blob(stmt: *mut c_void, i: c_int) -> *const c_void;
    fn sqlite3_column_text(stmt: *mut c_void, i: c_int) -> *const u8;
    fn sqlite3_column_int64(stmt: *mut c_void, i: c_int) -> i64;
    #[cfg(test)]
    fn sqlite3_exec(
        db: *mut c_void,
        sql: *const c_char,
        callback: *const c_void,
        arg: *mut c_void,
        errmsg: *mut *mut c_char,
    ) -> c_int;
}

pub struct Db(*mut c_void);

pub struct Stmt<'a> {
    raw: *mut c_void,
    _db: &'a Db,
}

/// One row's columns as the cookie reader needs them.
pub struct Row<'s> {
    raw: *mut c_void,
    _stmt: std::marker::PhantomData<&'s ()>,
}

impl Db {
    /// Opens a private copy (writable, so SQLite can replay a copied -wal file).
    pub fn open(path: &Path) -> Result<Db, String> {
        let c =
            CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "bad path".to_string())?;
        let mut db = std::ptr::null_mut();
        let rc = unsafe {
            sqlite3_open_v2(c.as_ptr(), &mut db, SQLITE_OPEN_READWRITE, std::ptr::null())
        };
        if rc != SQLITE_OK {
            let msg = Db(db).error();
            return Err(format!("无法打开 Cookie 数据库：{msg}"));
        }
        Ok(Db(db))
    }

    /// Test fixtures: a new database file, filled with `sql`.
    #[cfg(test)]
    pub fn create(path: &Path, sql: &str) -> Result<(), String> {
        let c =
            CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "bad path".to_string())?;
        let mut db = std::ptr::null_mut();
        let rc = unsafe { sqlite3_open_v2(c.as_ptr(), &mut db, 0x02 | 0x04, std::ptr::null()) };
        let db = Db(db);
        if rc != SQLITE_OK {
            return Err(db.error());
        }
        let sql = CString::new(sql).map_err(|_| "bad sql".to_string())?;
        let rc = unsafe {
            sqlite3_exec(
                db.0,
                sql.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if rc != SQLITE_OK {
            return Err(db.error());
        }
        Ok(())
    }

    fn error(&self) -> String {
        if self.0.is_null() {
            return "out of memory".into();
        }
        unsafe {
            CStr::from_ptr(sqlite3_errmsg(self.0))
                .to_string_lossy()
                .into_owned()
        }
    }

    pub fn prepare(&self, sql: &str) -> Result<Stmt<'_>, String> {
        let c = CString::new(sql).map_err(|_| "bad sql".to_string())?;
        let mut stmt = std::ptr::null_mut();
        let rc =
            unsafe { sqlite3_prepare_v2(self.0, c.as_ptr(), -1, &mut stmt, std::ptr::null_mut()) };
        if rc != SQLITE_OK || stmt.is_null() {
            return Err(self.error());
        }
        Ok(Stmt {
            raw: stmt,
            _db: self,
        })
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { sqlite3_close(self.0) };
        }
    }
}

impl Stmt<'_> {
    /// Calls `f` for every row; stops at the first error.
    pub fn each(&mut self, mut f: impl FnMut(&Row<'_>)) -> Result<(), String> {
        loop {
            match unsafe { sqlite3_step(self.raw) } {
                SQLITE_ROW => f(&Row {
                    raw: self.raw,
                    _stmt: std::marker::PhantomData,
                }),
                SQLITE_DONE => return Ok(()),
                rc => return Err(format!("SQLite error {rc}")),
            }
        }
    }

    #[cfg(test)]
    pub fn columns(&self) -> usize {
        unsafe { sqlite3_column_count(self.raw) as usize }
    }
}

impl Drop for Stmt<'_> {
    fn drop(&mut self) {
        unsafe { sqlite3_finalize(self.raw) };
    }
}

impl Row<'_> {
    pub fn text(&self, i: usize) -> String {
        unsafe {
            let p = sqlite3_column_text(self.raw, i as c_int);
            if p.is_null() {
                return String::new();
            }
            let n = sqlite3_column_bytes(self.raw, i as c_int) as usize;
            String::from_utf8_lossy(std::slice::from_raw_parts(p, n)).into_owned()
        }
    }

    pub fn blob(&self, i: usize) -> Vec<u8> {
        unsafe {
            let p = sqlite3_column_blob(self.raw, i as c_int);
            if p.is_null() {
                return Vec::new();
            }
            let n = sqlite3_column_bytes(self.raw, i as c_int) as usize;
            std::slice::from_raw_parts(p as *const u8, n).to_vec()
        }
    }

    pub fn int(&self, i: usize) -> i64 {
        unsafe { sqlite3_column_int64(self.raw, i as c_int) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rows_from_the_system_sqlite() {
        let dir = std::env::temp_dir().join(format!("hp-sqlite-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("t.db");
        let _ = std::fs::remove_file(&path);
        Db::create(
            &path,
            "CREATE TABLE t(a TEXT, b BLOB, c INTEGER); INSERT INTO t VALUES('x', x'0102', 7);",
        )
        .unwrap();
        let db = Db::open(&path).unwrap();
        let mut st = db.prepare("SELECT a, b, c FROM t").unwrap();
        assert_eq!(st.columns(), 3);
        let mut got = Vec::new();
        st.each(|r| got.push((r.text(0), r.blob(1), r.int(2))))
            .unwrap();
        assert_eq!(got, vec![("x".to_string(), vec![1u8, 2], 7)]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
