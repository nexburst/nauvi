//! Give freed heap memory back to the system (#397).
//!
//! glibc keeps memory it has freed in its arenas for later allocations. A
//! table watch parses its whole initial list (500 objects a page) and then
//! keeps only the rows, so without this most of that transient peak stays
//! in the process's RSS after the objects are gone. Other allocators and
//! platforms return memory on their own; there this does nothing.

/// Return free heap pages to the system. Cheap when there is little to
/// give back; a few milliseconds after a large list.
pub fn release() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: malloc_trim only walks glibc's own arenas; any thread may call it.
    unsafe {
        libc::malloc_trim(0);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn release_can_be_called_any_time() {
        let v: Vec<Vec<u8>> = (0..1000).map(|_| vec![0u8; 4096]).collect();
        drop(v);
        super::release();
        super::release();
    }
}
