//! Helpers shared by the integration test binaries (`mod common;`).

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};

/// A random suffix for names of temporary objects (namespaces, dirs), unique
/// across the tests of one run and across concurrent test processes.
///
/// The time alone is not enough: two tests that started in the same
/// microsecond got the same namespace (#314). `RandomState` is seeded from
/// the OS's random source, and the counter separates calls in this process.
pub fn unique_suffix() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(SEQ.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    hasher.finish()
}
