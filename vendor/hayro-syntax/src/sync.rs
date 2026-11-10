pub(crate) use std::collections::HashMap;

pub(crate) use rustc_hash::{FxHashMap, FxHashSet};

// Keep in sync with the implementation in `page`.
pub(crate) use std::sync::Arc;

pub(crate) use std::sync::Weak;

pub(crate) use std::sync::OnceLock;

pub(crate) use std::sync::Mutex;

pub(crate) use std::sync::RwLock;

pub(crate) type MutexGuard<'a, T> = std::sync::MutexGuard<'a, T>;

pub(crate) type RwLockReadGuard<'a, T> = std::sync::RwLockReadGuard<'a, T>;

pub(crate) type RwLockWriteGuard<'a, T> = std::sync::RwLockWriteGuard<'a, T>;

pub(crate) trait MutexExt<T> {
    fn get(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn get(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap()
    }
}

pub(crate) trait RwLockExt<T> {
    fn get(&self) -> RwLockReadGuard<'_, T>;
    fn put(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T> RwLockExt<T> for RwLock<T> {
    fn get(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap()
    }

    fn put(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap()
    }
}

