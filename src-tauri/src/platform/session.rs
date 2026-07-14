use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
};

use crate::domain::DataPage;

pub const PAGE_CACHE_CAPACITY: usize = 8;
pub const TOTAL_PAGE_CACHE_CAPACITY: usize = 64;
pub const TOTAL_PAGE_CACHE_BYTES: usize = 256 * 1024 * 1024;
pub const DOCUMENT_LIMIT: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PageCacheKey {
    offset: u64,
    limit: usize,
    columns: Option<Vec<String>>,
}

impl PageCacheKey {
    pub fn new(offset: u64, limit: usize, columns: Option<Vec<String>>) -> Self {
        Self {
            offset,
            limit,
            columns,
        }
    }
}

#[derive(Debug, Default)]
struct PageCache {
    entries: VecDeque<CachedPage>,
    #[cfg(test)]
    next_access: u64,
}

#[derive(Debug)]
struct CachedPage {
    key: PageCacheKey,
    page: DataPage,
    last_access: u64,
    estimated_bytes: usize,
}

impl PageCache {
    #[cfg(test)]
    fn get(&mut self, key: &PageCacheKey) -> Option<DataPage> {
        self.next_access = self.next_access.saturating_add(1);
        self.get_at(key, self.next_access)
    }

    fn get_at(&mut self, key: &PageCacheKey, access: u64) -> Option<DataPage> {
        let index = self.entries.iter().position(|entry| &entry.key == key)?;
        let mut entry = self.entries.remove(index)?;
        entry.last_access = access;
        let page = entry.page.clone();
        self.entries.push_back(entry);
        Some(page)
    }

    #[cfg(test)]
    fn insert(&mut self, key: PageCacheKey, page: DataPage) {
        self.next_access = self.next_access.saturating_add(1);
        self.insert_at(key, page, self.next_access);
    }

    fn insert_at(&mut self, key: PageCacheKey, page: DataPage, access: u64) {
        if let Some(index) = self.entries.iter().position(|entry| entry.key == key) {
            self.entries.remove(index);
        }
        let estimated_bytes = estimate_page_bytes(&page);
        self.entries.push_back(CachedPage {
            key,
            page,
            last_access: access,
            estimated_bytes,
        });
        while self.entries.len() > PAGE_CACHE_CAPACITY {
            self.entries.pop_front();
        }
    }

    fn usage(&self) -> (usize, usize) {
        (
            self.entries.len(),
            self.entries.iter().map(|entry| entry.estimated_bytes).sum(),
        )
    }

    fn oldest_access(&self) -> Option<u64> {
        self.entries.front().map(|entry| entry.last_access)
    }

    fn pop_oldest(&mut self) -> bool {
        self.entries.pop_front().is_some()
    }
}

fn estimate_page_bytes(page: &DataPage) -> usize {
    let column_bytes: usize = page.columns.iter().map(String::len).sum();
    let value_bytes: usize = page
        .rows
        .iter()
        .flatten()
        .map(|value| value.display.as_ref().map_or(0, String::len))
        .sum();
    column_bytes
        .saturating_add(value_bytes)
        .saturating_add(page.columns.len() * std::mem::size_of::<String>())
        .saturating_add(
            page.rows
                .iter()
                .map(|row| row.len() * std::mem::size_of::<crate::domain::DataValue>())
                .sum::<usize>(),
        )
}

#[derive(Debug)]
#[cfg(test)]
pub struct SessionSlot<T> {
    next_id: u64,
    active: Option<ActiveSession<T>>,
}

#[derive(Debug)]
#[cfg(test)]
struct ActiveSession<T> {
    id: String,
    source: T,
    page_cache: PageCache,
}

#[derive(Debug, PartialEq, Eq)]
#[cfg(test)]
pub enum SessionAccessError {
    NotFound { requested_id: String },
}

#[cfg(test)]
impl<T> Default for SessionSlot<T> {
    fn default() -> Self {
        Self {
            next_id: 1,
            active: None,
        }
    }
}

#[cfg(test)]
impl<T> SessionSlot<T> {
    /// Replaces the active source only after its caller has opened it successfully.
    pub fn replace(&mut self, source: T) -> String {
        let id = format!("session-{}", self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        self.active = Some(ActiveSession {
            id: id.clone(),
            source,
            page_cache: PageCache::default(),
        });
        id
    }

    pub fn get_or_load_page<E>(
        &mut self,
        requested_id: &str,
        key: PageCacheKey,
        load: impl FnOnce(&T) -> Result<DataPage, E>,
    ) -> Result<Result<DataPage, E>, SessionAccessError> {
        let active = match self.active.as_mut() {
            Some(active) if active.id == requested_id => active,
            _ => {
                return Err(SessionAccessError::NotFound {
                    requested_id: requested_id.to_owned(),
                })
            }
        };

        if let Some(page) = active.page_cache.get(&key) {
            return Ok(Ok(page));
        }

        match load(&active.source) {
            Ok(page) => {
                active.page_cache.insert(key, page.clone());
                Ok(Ok(page))
            }
            Err(error) => Ok(Err(error)),
        }
    }

    pub fn with_source<R>(
        &self,
        requested_id: &str,
        operation: impl FnOnce(&T) -> R,
    ) -> Result<R, SessionAccessError> {
        match self.active.as_ref() {
            Some(active) if active.id == requested_id => Ok(operation(&active.source)),
            _ => Err(SessionAccessError::NotFound {
                requested_id: requested_id.to_owned(),
            }),
        }
    }

    pub fn close(&mut self, requested_id: &str) -> Result<(), SessionAccessError> {
        match self.active.as_ref() {
            Some(active) if active.id == requested_id => {
                self.active = None;
                Ok(())
            }
            _ => Err(SessionAccessError::NotFound {
                requested_id: requested_id.to_owned(),
            }),
        }
    }

    #[cfg(test)]
    fn active_id(&self) -> Option<&str> {
        self.active.as_ref().map(|active| active.id.as_str())
    }

    #[cfg(test)]
    fn cache_keys(&self) -> Vec<PageCacheKey> {
        self.active
            .as_ref()
            .map(|active| {
                active
                    .page_cache
                    .entries
                    .iter()
                    .map(|entry| entry.key.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Debug)]
pub struct DocumentRegistry<T> {
    state: Mutex<DocumentRegistryState<T>>,
    reservation_changed: Condvar,
    access_clock: AtomicU64,
}

#[derive(Debug)]
struct DocumentRegistryState<T> {
    next_document_id: u64,
    next_session_id: u64,
    documents: HashMap<String, Arc<DocumentEntry<T>>>,
    paths: HashMap<String, String>,
    reservations: HashMap<String, String>,
    closed_documents: HashMap<String, HashSet<String>>,
}

#[derive(Debug)]
struct DocumentEntry<T> {
    document_id: String,
    canonical_key: String,
    state: Mutex<DocumentState<T>>,
}

#[derive(Debug)]
struct DocumentState<T> {
    session_id: String,
    previous_session_id: Option<String>,
    source: Arc<T>,
    page_cache: PageCache,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathReservation {
    document_id: String,
    canonical_key: String,
}

#[derive(Debug)]
pub enum ReservePath<T> {
    Existing(DocumentRef<T>),
    Reserved(PathReservation),
}

#[derive(Debug)]
pub struct DocumentRef<T>(Arc<DocumentEntry<T>>);

impl<T> Clone for DocumentRef<T> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentAccessError {
    NotFound {
        document_id: String,
    },
    Closed {
        document_id: String,
    },
    StaleSession {
        document_id: String,
        requested_session_id: String,
    },
    LimitReached {
        limit: usize,
        open: usize,
        reserved: usize,
    },
    Unavailable,
}

impl<T> Default for DocumentRegistryState<T> {
    fn default() -> Self {
        Self {
            next_document_id: 1,
            next_session_id: 1,
            documents: HashMap::new(),
            paths: HashMap::new(),
            reservations: HashMap::new(),
            closed_documents: HashMap::new(),
        }
    }
}

impl<T> Default for DocumentRegistry<T> {
    fn default() -> Self {
        Self {
            state: Mutex::new(DocumentRegistryState::default()),
            reservation_changed: Condvar::new(),
            access_clock: AtomicU64::new(0),
        }
    }
}

impl<T> DocumentRegistry<T> {
    /// Reserves capacity for a canonical path without performing file I/O while
    /// the registry is locked. Concurrent opens of the same path wait for the
    /// first reservation to commit or fail, then reuse or retry deterministically.
    pub fn reserve_path(
        &self,
        canonical_key: String,
    ) -> Result<ReservePath<T>, DocumentAccessError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DocumentAccessError::Unavailable)?;
        loop {
            if let Some(document_id) = state.paths.get(&canonical_key) {
                let entry = state
                    .documents
                    .get(document_id)
                    .cloned()
                    .ok_or(DocumentAccessError::Unavailable)?;
                return Ok(ReservePath::Existing(DocumentRef(entry)));
            }
            if !state.reservations.contains_key(&canonical_key) {
                break;
            }
            state = self
                .reservation_changed
                .wait(state)
                .map_err(|_| DocumentAccessError::Unavailable)?;
        }

        let open = state.documents.len();
        let reserved = state.reservations.len();
        if open.saturating_add(reserved) >= DOCUMENT_LIMIT {
            return Err(DocumentAccessError::LimitReached {
                limit: DOCUMENT_LIMIT,
                open,
                reserved,
            });
        }

        let document_id = format!("document-{}", state.next_document_id);
        state.next_document_id = state.next_document_id.saturating_add(1);
        state
            .reservations
            .insert(canonical_key.clone(), document_id.clone());
        Ok(ReservePath::Reserved(PathReservation {
            document_id,
            canonical_key,
        }))
    }

    pub fn cancel_reservation(&self, reservation: &PathReservation) {
        if let Ok(mut state) = self.state.lock() {
            if state.reservations.get(&reservation.canonical_key) == Some(&reservation.document_id)
            {
                state.reservations.remove(&reservation.canonical_key);
                self.reservation_changed.notify_all();
            }
        }
    }

    pub fn commit(
        &self,
        reservation: PathReservation,
        source: T,
        initial_key: PageCacheKey,
        initial_page: DataPage,
    ) -> Result<(String, String), DocumentAccessError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DocumentAccessError::Unavailable)?;
        if state.reservations.get(&reservation.canonical_key) != Some(&reservation.document_id) {
            return Err(DocumentAccessError::Closed {
                document_id: reservation.document_id,
            });
        }
        let session_id = format!("session-{}", state.next_session_id);
        state.next_session_id = state.next_session_id.saturating_add(1);
        let mut page_cache = PageCache::default();
        page_cache.insert_at(initial_key, initial_page, self.next_access());
        let entry = Arc::new(DocumentEntry {
            document_id: reservation.document_id.clone(),
            canonical_key: reservation.canonical_key.clone(),
            state: Mutex::new(DocumentState {
                session_id: session_id.clone(),
                previous_session_id: None,
                source: Arc::new(source),
                page_cache,
            }),
        });
        state.paths.insert(
            reservation.canonical_key.clone(),
            reservation.document_id.clone(),
        );
        state
            .documents
            .insert(reservation.document_id.clone(), entry);
        state.reservations.remove(&reservation.canonical_key);
        self.reservation_changed.notify_all();
        let identity = (reservation.document_id, session_id);
        drop(state);
        self.trim_cache();
        Ok(identity)
    }

    pub fn identity(
        &self,
        document: &DocumentRef<T>,
    ) -> Result<(String, String), DocumentAccessError> {
        let session_id = document
            .0
            .state
            .lock()
            .map_err(|_| DocumentAccessError::Unavailable)?
            .session_id
            .clone();
        self.validate(&document.0.document_id, &session_id)?;
        Ok((document.0.document_id.clone(), session_id))
    }

    pub fn with_source<R>(
        &self,
        document_id: &str,
        session_id: &str,
        operation: impl FnOnce(&T) -> R,
    ) -> Result<R, DocumentAccessError> {
        let entry = self.entry(document_id)?;
        let state = entry
            .state
            .lock()
            .map_err(|_| DocumentAccessError::Unavailable)?;
        ensure_session(&entry.document_id, &state.session_id, session_id)?;
        let source = Arc::clone(&state.source);
        drop(state);
        let result = operation(&source);
        self.validate(document_id, session_id)?;
        Ok(result)
    }

    pub fn get_or_load_page<E>(
        &self,
        document_id: &str,
        session_id: &str,
        key: PageCacheKey,
        load: impl FnOnce(&T) -> Result<DataPage, E>,
    ) -> Result<Result<DataPage, E>, DocumentAccessError> {
        let entry = self.entry(document_id)?;
        let access = self.next_access();
        let mut state = entry
            .state
            .lock()
            .map_err(|_| DocumentAccessError::Unavailable)?;
        ensure_session(&entry.document_id, &state.session_id, session_id)?;
        if let Some(page) = state.page_cache.get_at(&key, access) {
            drop(state);
            self.validate(document_id, session_id)?;
            self.trim_cache();
            return Ok(Ok(page));
        }
        let source = Arc::clone(&state.source);
        drop(state);
        let page = load(&source);
        let mut state = entry
            .state
            .lock()
            .map_err(|_| DocumentAccessError::Unavailable)?;
        ensure_session(&entry.document_id, &state.session_id, session_id)?;
        if let Ok(page) = &page {
            state.page_cache.insert_at(key, page.clone(), access);
        }
        drop(state);
        self.validate(document_id, session_id)?;
        self.trim_cache();
        Ok(page)
    }

    pub fn replace_source(
        &self,
        document_id: &str,
        session_id: &str,
        source: T,
    ) -> Result<String, DocumentAccessError> {
        let entry = self.entry(document_id)?;
        let new_session_id = self.allocate_session_id()?;
        let mut state = entry
            .state
            .lock()
            .map_err(|_| DocumentAccessError::Unavailable)?;
        ensure_session(&entry.document_id, &state.session_id, session_id)?;
        let previous = std::mem::replace(&mut state.source, Arc::new(source));
        let previous_session_id = state.session_id.clone();
        state.previous_session_id = Some(previous_session_id);
        state.session_id = new_session_id.clone();
        state.page_cache = PageCache::default();
        drop(state);
        // CsvSource::drop may join its index worker. Never do that while the
        // per-document state mutex is held.
        drop(previous);
        self.validate(document_id, &new_session_id)?;
        Ok(new_session_id)
    }

    pub fn close(&self, document_id: &str, session_id: &str) -> Result<(), DocumentAccessError> {
        let entry = match self.entry(document_id) {
            Ok(entry) => entry,
            Err(DocumentAccessError::Closed { .. }) => {
                let registry = self
                    .state
                    .lock()
                    .map_err(|_| DocumentAccessError::Unavailable)?;
                return if registry
                    .closed_documents
                    .get(document_id)
                    .is_some_and(|known| known.contains(session_id))
                {
                    Ok(())
                } else {
                    Err(DocumentAccessError::StaleSession {
                        document_id: document_id.to_owned(),
                        requested_session_id: session_id.to_owned(),
                    })
                };
            }
            Err(error) => return Err(error),
        };
        let document = entry
            .state
            .lock()
            .map_err(|_| DocumentAccessError::Unavailable)?;
        if document.session_id != session_id
            && document.previous_session_id.as_deref() != Some(session_id)
        {
            return Err(DocumentAccessError::StaleSession {
                document_id: document_id.to_owned(),
                requested_session_id: session_id.to_owned(),
            });
        }
        // Document IDs are never reused. A close issued with a known previous
        // generation must still close if configure won the race.
        let mut known_sessions = HashSet::from([document.session_id.clone()]);
        if let Some(previous) = &document.previous_session_id {
            known_sessions.insert(previous.clone());
        }
        let removed = {
            let mut registry = self
                .state
                .lock()
                .map_err(|_| DocumentAccessError::Unavailable)?;
            let is_current = registry
                .documents
                .get(document_id)
                .is_some_and(|current| Arc::ptr_eq(current, &entry));
            if !is_current {
                return Err(DocumentAccessError::Closed {
                    document_id: document_id.to_owned(),
                });
            }
            registry.paths.remove(&entry.canonical_key);
            let removed = registry.documents.remove(document_id);
            registry
                .closed_documents
                .insert(document_id.to_owned(), known_sessions);
            removed
        };
        drop(document);
        // Dropping a CSV source may join its worker, so the final Arc is always
        // released after the registry mutex has been dropped.
        drop(removed);
        Ok(())
    }

    pub fn find_by_session(
        &self,
        session_id: &str,
    ) -> Result<(String, String), DocumentAccessError> {
        let entries: Vec<_> = self
            .state
            .lock()
            .map_err(|_| DocumentAccessError::Unavailable)?
            .documents
            .values()
            .cloned()
            .collect();
        for entry in entries {
            let state = entry
                .state
                .lock()
                .map_err(|_| DocumentAccessError::Unavailable)?;
            if state.session_id == session_id {
                return Ok((entry.document_id.clone(), state.session_id.clone()));
            }
        }
        Err(DocumentAccessError::NotFound {
            document_id: session_id.to_owned(),
        })
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.documents.len())
            .unwrap_or(0)
    }

    fn entry(&self, document_id: &str) -> Result<Arc<DocumentEntry<T>>, DocumentAccessError> {
        let state = self
            .state
            .lock()
            .map_err(|_| DocumentAccessError::Unavailable)?;
        if let Some(entry) = state.documents.get(document_id) {
            return Ok(Arc::clone(entry));
        }
        if state.closed_documents.contains_key(document_id) {
            Err(DocumentAccessError::Closed {
                document_id: document_id.to_owned(),
            })
        } else {
            Err(DocumentAccessError::NotFound {
                document_id: document_id.to_owned(),
            })
        }
    }

    fn validate(&self, document_id: &str, session_id: &str) -> Result<(), DocumentAccessError> {
        let entry = self.entry(document_id).map_err(|error| match error {
            DocumentAccessError::NotFound { .. } => DocumentAccessError::Closed {
                document_id: document_id.to_owned(),
            },
            other => other,
        })?;
        let state = entry
            .state
            .lock()
            .map_err(|_| DocumentAccessError::Unavailable)?;
        ensure_session(document_id, &state.session_id, session_id)
    }

    fn allocate_session_id(&self) -> Result<String, DocumentAccessError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| DocumentAccessError::Unavailable)?;
        let id = format!("session-{}", state.next_session_id);
        state.next_session_id = state.next_session_id.saturating_add(1);
        Ok(id)
    }

    fn next_access(&self) -> u64 {
        self.access_clock.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn trim_cache(&self) {
        let entries: Vec<_> = match self.state.lock() {
            Ok(state) => state.documents.values().cloned().collect(),
            Err(_) => return,
        };
        loop {
            let mut pages = 0;
            let mut bytes: usize = 0;
            let mut oldest: Option<(u64, Arc<DocumentEntry<T>>)> = None;
            for entry in &entries {
                let Ok(state) = entry.state.lock() else {
                    continue;
                };
                let usage = state.page_cache.usage();
                pages += usage.0;
                bytes = bytes.saturating_add(usage.1);
                if let Some(access) = state.page_cache.oldest_access() {
                    if oldest.as_ref().is_none_or(|(known, _)| access < *known) {
                        oldest = Some((access, Arc::clone(entry)));
                    }
                }
            }
            if pages <= TOTAL_PAGE_CACHE_CAPACITY && bytes <= TOTAL_PAGE_CACHE_BYTES {
                break;
            }
            let Some((_, entry)) = oldest else {
                break;
            };
            if let Ok(mut state) = entry.state.lock() {
                state.page_cache.pop_oldest();
            };
        }
    }
}

fn ensure_session(
    document_id: &str,
    active_session_id: &str,
    requested_session_id: &str,
) -> Result<(), DocumentAccessError> {
    if active_session_id == requested_session_id {
        Ok(())
    } else {
        Err(DocumentAccessError::StaleSession {
            document_id: document_id.to_owned(),
            requested_session_id: requested_session_id.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc,
        },
        thread,
        time::Duration,
    };

    #[derive(Debug)]
    struct DropProbe(Arc<AtomicUsize>);

    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn key(offset: u64, limit: usize, columns: Option<&[&str]>) -> PageCacheKey {
        PageCacheKey::new(
            offset,
            limit,
            columns.map(|columns| columns.iter().map(|column| (*column).to_owned()).collect()),
        )
    }

    fn page(offset: u64, limit: usize) -> DataPage {
        DataPage {
            offset,
            limit,
            total_rows: Some(100),
            has_more: true,
            columns: vec![String::from("id")],
            rows: Vec::new(),
        }
    }

    fn load_page(
        slot: &mut SessionSlot<()>,
        session_id: &str,
        cache_key: PageCacheKey,
        loads: &Cell<usize>,
    ) -> DataPage {
        let offset = cache_key.offset;
        let limit = cache_key.limit;
        slot.get_or_load_page(session_id, cache_key, |_| {
            loads.set(loads.get() + 1);
            Ok::<_, ()>(page(offset, limit))
        })
        .expect("active session")
        .expect("page load")
    }

    #[test]
    fn successful_replace_invalidates_the_previous_session() {
        let mut slot = SessionSlot::default();
        let first_id = slot.replace("first");
        let second_id = slot.replace("second");

        assert_ne!(first_id, second_id);
        assert_eq!(slot.active_id(), Some(second_id.as_str()));
        assert_eq!(
            slot.with_source(&first_id, |source| *source),
            Err(SessionAccessError::NotFound {
                requested_id: first_id,
            })
        );
        assert_eq!(slot.with_source(&second_id, |source| *source), Ok("second"));
    }

    #[test]
    fn failed_open_can_leave_the_previous_session_untouched() {
        let mut slot = SessionSlot::default();
        let first_id = slot.replace("first");

        let attempted_source: Result<&str, &str> = Err("invalid parquet");
        if let Ok(source) = attempted_source {
            slot.replace(source);
        }

        assert_eq!(slot.active_id(), Some(first_id.as_str()));
        assert_eq!(slot.with_source(&first_id, |source| *source), Ok("first"));
    }

    #[test]
    fn close_drops_the_active_source_and_bad_ids_are_rejected() {
        let mut slot = SessionSlot::default();
        let session_id = slot.replace(String::from("source"));

        assert_eq!(
            slot.close("missing"),
            Err(SessionAccessError::NotFound {
                requested_id: String::from("missing"),
            })
        );
        assert_eq!(slot.active_id(), Some(session_id.as_str()));

        slot.close(&session_id)
            .expect("active session should close");
        assert_eq!(slot.active_id(), None);
        assert_eq!(
            slot.with_source(&session_id, String::len),
            Err(SessionAccessError::NotFound {
                requested_id: session_id,
            })
        );
    }

    #[test]
    fn same_page_key_hits_cache_without_loading_again() {
        let mut slot = SessionSlot::default();
        let session_id = slot.replace(());
        let loads = Cell::new(0);
        let cache_key = key(10, 20, Some(&["label", "id"]));

        load_page(&mut slot, &session_id, cache_key.clone(), &loads);
        load_page(&mut slot, &session_id, cache_key, &loads);

        assert_eq!(loads.get(), 1);
        assert_eq!(slot.cache_keys().len(), 1);
    }

    #[test]
    fn offset_limit_and_projection_order_are_independent_cache_keys() {
        let mut slot = SessionSlot::default();
        let session_id = slot.replace(());
        let loads = Cell::new(0);
        let keys = [
            key(0, 10, Some(&["id", "label"])),
            key(1, 10, Some(&["id", "label"])),
            key(0, 20, Some(&["id", "label"])),
            key(0, 10, Some(&["label", "id"])),
            key(0, 10, None),
        ];

        for cache_key in keys {
            load_page(&mut slot, &session_id, cache_key, &loads);
        }

        assert_eq!(loads.get(), 5);
        assert_eq!(slot.cache_keys().len(), 5);
    }

    #[test]
    fn ninth_entry_evicts_only_the_least_recently_used_page() {
        let mut slot = SessionSlot::default();
        let session_id = slot.replace(());
        let loads = Cell::new(0);

        for offset in 0..PAGE_CACHE_CAPACITY as u64 {
            load_page(&mut slot, &session_id, key(offset, 1, None), &loads);
        }
        assert_eq!(slot.cache_keys().len(), PAGE_CACHE_CAPACITY);

        // Refresh offset 0, making offset 1 the least recently used entry.
        load_page(&mut slot, &session_id, key(0, 1, None), &loads);
        load_page(
            &mut slot,
            &session_id,
            key(PAGE_CACHE_CAPACITY as u64, 1, None),
            &loads,
        );

        let keys = slot.cache_keys();
        assert_eq!(keys.len(), PAGE_CACHE_CAPACITY);
        assert!(!keys.contains(&key(1, 1, None)));
        assert!(keys.contains(&key(0, 1, None)));
        assert!(keys.contains(&key(PAGE_CACHE_CAPACITY as u64, 1, None)));
    }

    #[test]
    fn close_and_replace_release_the_session_cache() {
        let mut slot = SessionSlot::default();
        let first_id = slot.replace(());
        let loads = Cell::new(0);
        load_page(&mut slot, &first_id, key(0, 10, None), &loads);
        assert_eq!(slot.cache_keys().len(), 1);

        slot.close(&first_id).expect("close first session");
        assert!(slot.cache_keys().is_empty());

        let second_id = slot.replace(());
        load_page(&mut slot, &second_id, key(0, 10, None), &loads);
        assert_eq!(slot.cache_keys().len(), 1);
        let third_id = slot.replace(());
        assert_ne!(second_id, third_id);
        assert!(slot.cache_keys().is_empty());
    }

    #[test]
    fn replace_and_close_drop_each_owned_source_exactly_once() {
        let drops = Arc::new(AtomicUsize::new(0));
        let mut slot = SessionSlot::default();
        let first_id = slot.replace(DropProbe(Arc::clone(&drops)));
        let second_id = slot.replace(DropProbe(Arc::clone(&drops)));

        assert_ne!(first_id, second_id);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        slot.close(&second_id).expect("close replacement");
        assert_eq!(drops.load(Ordering::SeqCst), 2);
    }

    fn commit_document<T>(
        registry: &DocumentRegistry<T>,
        path: &str,
        source: T,
    ) -> (String, String) {
        let ReservePath::Reserved(reservation) = registry
            .reserve_path(path.to_owned())
            .expect("reserve document")
        else {
            panic!("path unexpectedly existed");
        };
        registry
            .commit(reservation, source, key(0, 1, None), page(0, 1))
            .expect("commit document")
    }

    #[test]
    fn registry_enforces_64_documents_and_reuses_a_closed_slot() {
        let registry = DocumentRegistry::default();
        let mut identities = Vec::new();
        for index in 0..DOCUMENT_LIMIT {
            identities.push(commit_document(&registry, &format!("path-{index}"), index));
        }
        assert_eq!(registry.len(), DOCUMENT_LIMIT);
        assert!(matches!(
            registry.reserve_path(String::from("overflow")),
            Err(DocumentAccessError::LimitReached {
                limit: DOCUMENT_LIMIT,
                open: DOCUMENT_LIMIT,
                reserved: 0,
            })
        ));
        registry.close(&identities[0].0, &identities[0].1).unwrap();
        assert!(matches!(
            registry.reserve_path(String::from("replacement")),
            Ok(ReservePath::Reserved(_))
        ));
    }

    #[test]
    fn registry_deduplicates_a_committed_canonical_path() {
        let registry = DocumentRegistry::default();
        let expected = commit_document(&registry, "canonical", 42);
        let ReservePath::Existing(document) = registry
            .reserve_path(String::from("canonical"))
            .expect("existing path")
        else {
            panic!("duplicate path was reserved again");
        };
        assert_eq!(registry.identity(&document).unwrap(), expected);
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn generation_replacement_rejects_the_old_session_only_for_its_document() {
        let registry = DocumentRegistry::default();
        let (document_id, first_session) = commit_document(&registry, "csv", String::from("a"));
        let (other_document, other_session) =
            commit_document(&registry, "parquet", String::from("other"));
        let second_session = registry
            .replace_source(&document_id, &first_session, String::from("ab"))
            .unwrap();
        let value = registry
            .with_source(&document_id, &second_session, Clone::clone)
            .unwrap();
        assert_eq!(value, "ab");
        assert_ne!(first_session, second_session);
        assert!(matches!(
            registry.with_source(&document_id, &first_session, Clone::clone),
            Err(DocumentAccessError::StaleSession { .. })
        ));
        assert_eq!(
            registry
                .with_source(&other_document, &other_session, Clone::clone)
                .unwrap(),
            "other"
        );
    }

    #[test]
    fn close_drops_a_registry_source_exactly_once() {
        let drops = Arc::new(AtomicUsize::new(0));
        let registry = DocumentRegistry::default();
        let (document_id, session_id) =
            commit_document(&registry, "drop", DropProbe(Arc::clone(&drops)));
        registry.close(&document_id, &session_id).unwrap();
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn close_does_not_wait_for_page_decode_and_late_result_is_closed() {
        let registry = Arc::new(DocumentRegistry::default());
        let (document_id, session_id) = commit_document(&registry, "slow-read", ());
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let reader_registry = Arc::clone(&registry);
        let reader_document = document_id.clone();
        let reader_session = session_id.clone();
        let reader = thread::spawn(move || {
            reader_registry.get_or_load_page(
                &reader_document,
                &reader_session,
                key(10, 1, None),
                |_| {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok::<_, ()>(page(10, 1))
                },
            )
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        let close_registry = Arc::clone(&registry);
        let close_document = document_id.clone();
        let close_session = session_id.clone();
        let (closed_tx, closed_rx) = mpsc::channel();
        thread::spawn(move || {
            let result = close_registry.close(&close_document, &close_session);
            closed_tx.send(result).unwrap();
        });
        closed_rx
            .recv_timeout(Duration::from_millis(250))
            .expect("close must not wait for decode")
            .unwrap();
        release_tx.send(()).unwrap();
        assert!(matches!(
            reader.join().unwrap(),
            Err(DocumentAccessError::Closed { .. })
        ));
    }

    #[test]
    fn close_is_idempotent_and_tombstones_are_distinct_from_unknown_ids() {
        let registry = DocumentRegistry::default();
        let (document_id, session_id) = commit_document(&registry, "closed", 1);
        registry.close(&document_id, &session_id).unwrap();
        registry.close(&document_id, &session_id).unwrap();
        assert!(matches!(
            registry.close(&document_id, "unrelated-session"),
            Err(DocumentAccessError::StaleSession { .. })
        ));
        assert!(matches!(
            registry.with_source(&document_id, &session_id, |source| *source),
            Err(DocumentAccessError::Closed { .. })
        ));
        assert!(matches!(
            registry.with_source("never-existed", "session", |source| *source),
            Err(DocumentAccessError::NotFound { .. })
        ));
    }

    #[test]
    fn a_session_from_another_document_cannot_close_this_document() {
        let registry = DocumentRegistry::default();
        let (document_a, session_a) = commit_document(&registry, "a", 10);
        let (document_b, session_b) = commit_document(&registry, "b", 20);

        assert!(matches!(
            registry.close(&document_a, &session_b),
            Err(DocumentAccessError::StaleSession { .. })
        ));
        assert_eq!(
            registry
                .with_source(&document_a, &session_a, |source| *source)
                .unwrap(),
            10
        );
        assert_eq!(
            registry
                .with_source(&document_b, &session_b, |source| *source)
                .unwrap(),
            20
        );
    }

    #[test]
    fn only_current_or_immediately_previous_generation_can_close() {
        let registry = DocumentRegistry::default();
        let (document_id, first) = commit_document(&registry, "generations", 1);
        let second = registry.replace_source(&document_id, &first, 2).unwrap();
        let third = registry.replace_source(&document_id, &second, 3).unwrap();

        assert!(matches!(
            registry.close(&document_id, &first),
            Err(DocumentAccessError::StaleSession { .. })
        ));
        assert_eq!(
            registry
                .with_source(&document_id, &third, |source| *source)
                .unwrap(),
            3
        );
        registry.close(&document_id, &second).unwrap();
        assert!(matches!(
            registry.with_source(&document_id, &third, |source| *source),
            Err(DocumentAccessError::Closed { .. })
        ));
    }
}
