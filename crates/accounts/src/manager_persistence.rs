//! Port of the persistence half of `lib/accounts.ts`:
//! `buildStorageSnapshot` / `reconcileTokensFromDisk` / `saveToDisk` /
//! debounced save + `flushPendingSave` / `syncCodexCliActiveSelection*` /
//! `clearAccountTransientState` / `markRateLimited*` + cooldown bookkeeping
//! / `formatAccountLabel` / `formatWorkspaceLines` / `formatCooldown` /
//! `toAuthDetails`.
//!
//! Behavior source: specs/03-accounts.md §1.6–1.7 (+ §14 concurrency, §15
//! gotchas 1–4, 11–17, 31). TS source is authoritative.
//!
//! ARCHITECTURE §8.4: [`AccountManager::build_storage_snapshot`] is THE ONLY
//! bridge from manager state to [`AccountStorageV3`] — it clones the
//! persisted `meta` shape only, so runtime-only state
//! (`runtime.last_rate_limit_reason`, `runtime.consecutive_auth_failures`,
//! cached tracker/circuit keys, health/token trackers) can never reach disk.
//!
//! Debounce model: the TS `setTimeout` + `pendingSave` promise chain needs
//! autonomous firing, which in Rust requires shared ownership of the
//! manager. [`SharedAccountManager`] (defined here) wraps
//! `Arc<tokio::sync::Mutex<AccountManager>>` plus the debounce bookkeeping;
//! the spawned timer task holds only `Weak` handles so a dropped pool
//! cancels its pending save.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};

use cma_cli_mirror::writer::{ActiveSelection, set_codex_cli_active_selection};
use cma_core::constants::MAX_RATE_LIMIT_DELAY_MS;
use cma_core::errors::CodexError;
use cma_core::logger::create_logger;
use cma_core::model_family::{MODEL_FAMILIES, ModelFamily};
use cma_core::schemas::account_storage::{
    AccountMetadataV3, AccountStorageV3, ActiveIndexByFamily, CooldownReason, RateLimitReason,
    RateLimitStateV3, Workspace,
};
use cma_core::types::OAuthAuthDetails;
use cma_core::utils::now_ms;
use cma_storage::facade::get_storage_path;
use cma_storage::identity::get_account_identity_key;
use cma_storage::load::{PinAndGen, read_pin_and_gen_from_disk};
use cma_storage::path_state::run_with_storage_path_state;
use cma_storage::transactions::with_account_storage_transaction;
use serde_json::json;

use crate::manager::{AccountManager, ManagedAccount};
use crate::rate_limits::{RateLimitedEntity, clear_all_rate_limits, format_wait_time, get_quota_key};

/// TS `saveToDiskDebounced(delayMs = 500)` default.
pub const SAVE_DEBOUNCE_DEFAULT_MS: u64 = 500;

// ===========================================================================
// Pure helpers (unit-tested standalone)
// ===========================================================================

/// The pin/gen race-protection core of `buildStorageSnapshot` (#474, spec
/// gotcha 16):
/// - the disk pin is adopted ONLY when the disk `affinityGeneration` is
///   STRICTLY greater than the in-memory one (pin+gen are written atomically
///   by the CLI, so a greater gen marks the disk pin authoritative);
/// - the effective pin is then re-validated against the live account count
///   (out of range → `None`).
///
/// Returns `(effective_pin, effective_gen)` — callers cache both back onto
/// the manager instance.
pub fn resolve_effective_pin_and_gen(
    memory_pin: Option<i64>,
    memory_gen: i64,
    on_disk: PinAndGen,
    accounts_len: usize,
) -> (Option<i64>, i64) {
    let mut pin = memory_pin;
    let mut generation = memory_gen;
    if on_disk.affinity_generation > generation {
        generation = on_disk.affinity_generation;
        pin = on_disk.pinned_account_index;
    }
    if let Some(p) = pin
        && (p < 0 || p >= accounts_len as i64)
    {
        pin = None;
    }
    (pin, generation)
}

/// TS `reconcileTokensFromDisk(snapshot, current)` (stress audit H3, spec
/// gotcha 17): for each snapshot account whose identity also exists on
/// disk, adopt the DISK token material (refreshToken + accessToken +
/// expiresAt together) only when the disk expiry is STRICTLY greater and
/// the disk row has a refresh token. Equal expiries keep the in-memory
/// copy; our own fresh refresh (newest expiry) always wins — a routine save
/// can never clobber a token another process just rotated.
pub fn reconcile_tokens_from_disk(
    snapshot: &mut AccountStorageV3,
    current: Option<&AccountStorageV3>,
) {
    let Some(current) = current else {
        return;
    };
    let mut disk_by_identity: HashMap<String, &AccountMetadataV3> = HashMap::new();
    for disk_account in &current.accounts {
        if let Some(key) = get_account_identity_key(disk_account) {
            // Later duplicates overwrite earlier ones (TS `Map.set`).
            disk_by_identity.insert(key, disk_account);
        }
    }
    for account in snapshot.accounts.iter_mut() {
        let Some(key) = get_account_identity_key(&*account) else {
            continue;
        };
        let Some(disk) = disk_by_identity.get(&key) else {
            continue;
        };
        let disk_expires = disk.expires_at.unwrap_or(0);
        let memory_expires = account.expires_at.unwrap_or(0);
        if disk_expires > memory_expires && !disk.refresh_token.is_empty() {
            account.refresh_token = disk.refresh_token.clone();
            account.access_token = disk.access_token.clone();
            account.expires_at = disk.expires_at;
        }
    }
}

/// The rate-limit write matrix of TS `markRateLimitedWithReason` (spec
/// gotcha 1), factored pure for testability:
/// - clamp `retry_after_ms` to `[0, MAX_RATE_LIMIT_DELAY_MS]` (7 days —
///   stress audit H1);
/// - base-key write when there is no model OR the reason is
///   `quota`/`unknown`;
/// - model-key write when a model is given AND the reason is
///   `tokens`/`concurrent`/`unknown` (so `unknown`+model writes BOTH keys;
///   `tokens`/`concurrent` leave the base key clear for other models);
/// - every write is a monotone max-merge — a shorter later retry-after can
///   never shrink an existing window.
///
/// An empty-string model counts as "no model" (JS falsiness).
pub fn apply_rate_limit_with_reason(
    times: &mut RateLimitStateV3,
    now: i64,
    retry_after_ms: i64,
    family: ModelFamily,
    reason: RateLimitReason,
    model: Option<&str>,
) {
    let model = model.filter(|m| !m.is_empty());
    let retry_ms = retry_after_ms.clamp(0, MAX_RATE_LIMIT_DELAY_MS);
    let reset_at = now + retry_ms;

    if model.is_none() || matches!(reason, RateLimitReason::Quota | RateLimitReason::Unknown) {
        let base_key = get_quota_key(family, None);
        let current = times.get(&base_key).unwrap_or(0);
        times.insert(base_key, current.max(reset_at));
    }

    if let Some(model) = model
        && matches!(
            reason,
            RateLimitReason::Tokens | RateLimitReason::Concurrent | RateLimitReason::Unknown
        )
    {
        let model_key = get_quota_key(family, Some(model));
        let current = times.get(&model_key).unwrap_or(0);
        times.insert(model_key, current.max(reset_at));
    }
}

// ===========================================================================
// ManagedAccount — rate-limit / cooldown bookkeeping + toAuthDetails
// (auth-failure tracking lives in manager.rs with the struct definition)
// ===========================================================================

impl ManagedAccount {
    /// TS `markRateLimited(account, retryAfterMs, family, model?)` —
    /// delegates with reason `"unknown"`.
    pub fn mark_rate_limited(
        &mut self,
        retry_after_ms: i64,
        family: ModelFamily,
        model: Option<&str>,
    ) {
        self.mark_rate_limited_with_reason(retry_after_ms, family, RateLimitReason::Unknown, model);
    }

    /// TS `markRateLimitedWithReason` — see
    /// [`apply_rate_limit_with_reason`] for the key matrix; additionally
    /// records the runtime-only `lastRateLimitReason` (never persisted).
    pub fn mark_rate_limited_with_reason(
        &mut self,
        retry_after_ms: i64,
        family: ModelFamily,
        reason: RateLimitReason,
        model: Option<&str>,
    ) {
        apply_rate_limit_with_reason(
            self.rate_limit_reset_times_mut(),
            now_ms(),
            retry_after_ms,
            family,
            reason,
            model,
        );
        self.runtime.last_rate_limit_reason = Some(reason);
    }

    /// TS `markAccountCoolingDown(account, cooldownMs, reason)` —
    /// `coolingDownUntil = now + max(0, floor(ms))`.
    pub fn mark_cooling_down(&mut self, cooldown_ms: i64, reason: CooldownReason) {
        let ms = cooldown_ms.max(0);
        self.meta.cooling_down_until = Some(now_ms() + ms);
        self.meta.cooldown_reason = Some(reason);
    }

    /// TS `isAccountCoolingDown(account)` — false when no cooldown is set;
    /// SELF-CLEARS an expired cooldown as a side effect (spec gotcha 12;
    /// `recordSuccess` healing must observe the metadata BEFORE calling
    /// this).
    pub fn is_cooling_down(&mut self) -> bool {
        let Some(until) = self.meta.cooling_down_until else {
            return false;
        };
        if now_ms() >= until {
            self.clear_cooldown();
            return false;
        }
        true
    }

    /// TS `clearAccountCooldown(account)` — removes BOTH fields (TS
    /// `delete`, not `= undefined` — matters for `hadCooldownMetadata`
    /// checks and JSON output, spec gotcha 13).
    pub fn clear_cooldown(&mut self) {
        self.meta.cooling_down_until = None;
        self.meta.cooldown_reason = None;
    }

    /// TS `toAuthDetails(account)` — `{type: "oauth", access: access ?? "",
    /// refresh, expires: expires ?? 0}`.
    pub fn to_auth_details(&self) -> OAuthAuthDetails {
        OAuthAuthDetails {
            access: self.meta.access_token.clone().unwrap_or_default(),
            refresh: self.meta.refresh_token.clone(),
            expires: self.meta.expires_at.unwrap_or(0),
        }
    }
}

// ===========================================================================
// AccountManager — persistence half
// ===========================================================================

impl AccountManager {
    /// TS-named index-based wrapper over
    /// [`ManagedAccount::mark_rate_limited`]. Returns `false` when the
    /// index is out of range.
    pub fn mark_rate_limited(
        &mut self,
        account_index: i64,
        retry_after_ms: i64,
        family: ModelFamily,
        model: Option<&str>,
    ) -> bool {
        self.mark_rate_limited_with_reason(
            account_index,
            retry_after_ms,
            family,
            RateLimitReason::Unknown,
            model,
        )
    }

    /// TS-named index-based wrapper over
    /// [`ManagedAccount::mark_rate_limited_with_reason`].
    pub fn mark_rate_limited_with_reason(
        &mut self,
        account_index: i64,
        retry_after_ms: i64,
        family: ModelFamily,
        reason: RateLimitReason,
        model: Option<&str>,
    ) -> bool {
        let Some(account) = self.get_account_by_index_mut(account_index) else {
            return false;
        };
        account.mark_rate_limited_with_reason(retry_after_ms, family, reason, model);
        true
    }

    /// TS-named index-based wrapper over
    /// [`ManagedAccount::mark_cooling_down`].
    pub fn mark_account_cooling_down(
        &mut self,
        account_index: i64,
        cooldown_ms: i64,
        reason: CooldownReason,
    ) -> bool {
        let Some(account) = self.get_account_by_index_mut(account_index) else {
            return false;
        };
        account.mark_cooling_down(cooldown_ms, reason);
        true
    }

    /// TS-named index-based wrapper over
    /// [`ManagedAccount::is_cooling_down`] (mutating lazy expiry).
    pub fn is_account_cooling_down(&mut self, account_index: i64) -> bool {
        match self.get_account_by_index_mut(account_index) {
            Some(account) => account.is_cooling_down(),
            None => false,
        }
    }

    /// TS-named index-based wrapper over
    /// [`ManagedAccount::clear_cooldown`].
    pub fn clear_account_cooldown(&mut self, account_index: i64) -> bool {
        let Some(account) = self.get_account_by_index_mut(account_index) else {
            return false;
        };
        account.clear_cooldown();
        true
    }

    /// TS `clearAccountTransientState()` — in-memory half (issue #606):
    /// wipe active cooldowns, ALL rate-limit reset windows (including
    /// still-future ones) and the runtime `lastRateLimitReason` on every
    /// account. Returns `true` when the pool was non-empty, i.e. when the
    /// caller should schedule the debounced persist
    /// ([`SharedAccountManager::clear_account_transient_state`] does both;
    /// callers needing durability must
    /// [`SharedAccountManager::flush_pending_save`]).
    pub fn clear_account_transient_state(&mut self) -> bool {
        if self.accounts.is_empty() {
            return false;
        }
        for account in self.accounts.iter_mut() {
            account.clear_cooldown();
            clear_all_rate_limits(account);
            account.runtime.last_rate_limit_reason = None;
        }
        true
    }

    /// TS `syncCodexCliActiveSelectionForIndex(index)` — bounds-checked
    /// mirror write of the given account into the official Codex CLI files
    /// (result deliberately ignored, matching the TS `await` of a
    /// best-effort writer).
    pub async fn sync_codex_cli_active_selection_for_index(&self, index: i64) {
        if index < 0 || index as usize >= self.accounts.len() {
            return;
        }
        let Some(account) = self.accounts.get(index as usize) else {
            return;
        };
        let selection = ActiveSelection {
            account_id: account.meta.account_id.clone(),
            email: account.meta.email.clone(),
            access_token: account.meta.access_token.clone(),
            refresh_token: Some(account.meta.refresh_token.clone()),
            expires_at: account.meta.expires_at.map(|expires| expires as f64),
            id_token: None,
        };
        let _ = set_codex_cli_active_selection(&selection).await;
    }

    /// TS `buildStorageSnapshot()` — THE ONLY manager → [`AccountStorageV3`]
    /// bridge (ARCHITECTURE §8.4).
    ///
    /// 1. `activeIndexByFamily[f] = clamp(current pointer, ≥0)` for every
    ///    family (a `-1` pointer serializes as `0` — spec gotcha 15);
    ///    `activeIndex` = the codex family value.
    /// 2. Pin/gen race protection (#474): re-read pin+gen from disk and
    ///    adopt via [`resolve_effective_pin_and_gen`]; cache the refreshed
    ///    values back onto the instance. (The Rust disk reader never fails —
    ///    it returns `{None, 0}` on any problem, which the strictly-greater
    ///    rule treats exactly like the TS catch-and-keep-memory branch.)
    /// 3. Serialize accounts in pool order with the EXACT allow-listed field
    ///    mapping: `enabled` is `false` or omitted (never `true` on disk),
    ///    empty `rateLimitResetTimes` is omitted, runtime-only fields are
    ///    never copied.
    /// 4. `pinnedAccountIndex` only when defined; `affinityGeneration` only
    ///    when `> 0`.
    pub fn build_storage_snapshot(&mut self) -> AccountStorageV3 {
        let mut by_family = ActiveIndexByFamily::default();
        for family in MODEL_FAMILIES {
            let raw = self.current_account_index_by_family.get(family);
            by_family.set(family, Some(raw.max(0)));
        }
        let active_index = by_family.get(ModelFamily::Codex).unwrap_or(0);

        let on_disk = read_pin_and_gen_from_disk(get_storage_path());
        let (effective_pin, effective_gen) = resolve_effective_pin_and_gen(
            self.pinned_account_index,
            self.affinity_generation,
            on_disk,
            self.accounts.len(),
        );
        self.pinned_account_index = effective_pin;
        self.affinity_generation = effective_gen;

        let mut snapshot = AccountStorageV3::empty();
        snapshot.accounts = self
            .accounts
            .iter()
            .map(managed_account_to_metadata)
            .collect();
        snapshot.active_index = active_index;
        snapshot.active_index_by_family = Some(by_family);
        snapshot.pinned_account_index = effective_pin;
        snapshot.affinity_generation = if effective_gen > 0 {
            Some(effective_gen)
        } else {
            None
        };
        snapshot
    }

    /// TS `saveToDisk()` — re-enter the storage-path state captured at
    /// construction (a project-scoped manager keeps writing to its
    /// project-scoped file), then, under the account-storage transaction
    /// (cross-process lock + load-current + atomic persist), snapshot the
    /// live pool and reconcile against the just-loaded disk state so a
    /// routine save cannot clobber a token another process rotated (H3).
    pub async fn save_to_disk(&mut self) -> Result<(), CodexError> {
        let path_state = self.storage_path_state.clone();
        let this: &mut AccountManager = self;
        run_with_storage_path_state(path_state, async move {
            with_account_storage_transaction(move |current, persist| async move {
                let mut snapshot = this.build_storage_snapshot();
                reconcile_tokens_from_disk(&mut snapshot, current.as_ref());
                persist.persist(&snapshot).await
            })
            .await
        })
        .await
    }

}

/// The `buildStorageSnapshot` per-account field mapping (spec §1.6 step 3):
/// clone the persisted `meta` shape, then apply the on-disk omission rules.
/// Runtime-only state lives in `account.runtime` and is structurally
/// excluded.
fn managed_account_to_metadata(account: &ManagedAccount) -> AccountMetadataV3 {
    let mut meta = account.meta.clone();
    // Never `Some(true)` on disk — enabled accounts omit the field
    // (spec gotcha 3).
    meta.enabled = if account.meta.enabled == Some(false) {
        Some(false)
    } else {
        None
    };
    // The live windows are the DIRECT `rate_limit_reset_times` field (the
    // `meta` slot is dormant in memory); empty maps are omitted on disk
    // (spec gotcha 4).
    meta.rate_limit_reset_times = if account.rate_limit_reset_times.is_empty() {
        None
    } else {
        Some(account.rate_limit_reset_times.clone())
    };
    meta
}

// ===========================================================================
// SharedAccountManager — debounced save + flush (TS saveToDiskDebounced /
// flushPendingSave / clearAccountTransientState scheduling). The debounce
// bookkeeping lives HERE, beside the pool mutex — `AccountManager` itself
// carries no timer state (manager.rs defers the TS debounce surface to
// this wrapper).
// ===========================================================================

/// Completion latch for one in-flight save (TS `pendingSave` promise). The
/// failure message is stored so `flush_pending_save` can re-surface it,
/// mirroring TS awaiting the same rejected promise.
struct PendingSave {
    done: AtomicBool,
    notify: tokio::sync::Notify,
    error: StdMutex<Option<String>>,
}

impl PendingSave {
    fn new() -> Self {
        Self {
            done: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
            error: StdMutex::new(None),
        }
    }

    async fn wait(&self) {
        loop {
            if self.done.load(Ordering::Acquire) {
                return;
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            // Close the race between the check and registering.
            if self.done.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    fn complete(&self, error: Option<String>) {
        *self.error.lock().expect("pending-save error poisoned") = error;
        self.done.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    fn error_message(&self) -> Option<String> {
        self.error
            .lock()
            .expect("pending-save error poisoned")
            .clone()
    }
}

/// TS `saveDebounceTimer` + `pendingSave` bookkeeping.
#[derive(Default)]
struct DebounceState {
    /// Bumped on every schedule/cancel; a sleeping timer task only fires
    /// while its generation is still the armed one (TS `clearTimeout`
    /// equivalence).
    generation: u64,
    /// `Some(gen)` while a timer for `gen` is armed
    /// (⇔ TS `saveDebounceTimer !== null`).
    armed: Option<u64>,
    /// The in-flight save latch (⇔ TS `pendingSave !== null`).
    pending: Option<Arc<PendingSave>>,
}

/// Shared handle around an [`AccountManager`] providing the TS debounced
/// persistence surface. Runtime layers (manager cache, proxy pipeline) hold
/// the pool through this handle.
#[derive(Clone)]
pub struct SharedAccountManager {
    manager: Arc<tokio::sync::Mutex<AccountManager>>,
    debounce: Arc<StdMutex<DebounceState>>,
}

impl SharedAccountManager {
    pub fn new(manager: AccountManager) -> Self {
        Self::from_arc(Arc::new(tokio::sync::Mutex::new(manager)))
    }

    pub fn from_arc(manager: Arc<tokio::sync::Mutex<AccountManager>>) -> Self {
        Self {
            manager,
            debounce: Arc::new(StdMutex::new(DebounceState::default())),
        }
    }

    /// The underlying pool mutex (for direct method access).
    pub fn manager(&self) -> &Arc<tokio::sync::Mutex<AccountManager>> {
        &self.manager
    }

    pub async fn lock(&self) -> tokio::sync::MutexGuard<'_, AccountManager> {
        self.manager.lock().await
    }

    /// TS `saveToDiskDebounced(delayMs = 500)` — trailing-edge debounce
    /// with single-flight coalescing: every call re-arms the timer (the
    /// LAST call's delay governs); when it fires, the worker first awaits
    /// any in-flight save, then runs `saveToDisk`, logging (never
    /// propagating) failures. Synchronous like the TS method; must be
    /// called from within a tokio runtime.
    pub fn save_to_disk_debounced(&self, delay_ms: u64) {
        let my_generation = {
            let mut state = self.debounce.lock().expect("debounce state poisoned");
            state.generation = state.generation.wrapping_add(1);
            state.armed = Some(state.generation);
            state.generation
        };
        let manager = Arc::downgrade(&self.manager);
        let debounce = Arc::downgrade(&self.debounce);
        tokio::spawn(async move {
            cma_core::utils::sleep(delay_ms).await;
            run_debounced_save(manager, debounce, my_generation).await;
        });
    }

    /// TS `flushPendingSave()` — cancel a pending timer and save
    /// immediately (propagating that save's error), then await any
    /// in-flight background save (re-surfacing its stored failure message).
    pub async fn flush_pending_save(&self) -> Result<(), CodexError> {
        let had_timer = {
            let mut state = self.debounce.lock().expect("debounce state poisoned");
            if state.armed.is_some() {
                // Cancel the sleeping timer task (generation supersession).
                state.armed = None;
                state.generation = state.generation.wrapping_add(1);
                true
            } else {
                false
            }
        };
        if had_timer {
            save_to_disk_shared(&self.manager).await?;
        }
        let pending = {
            self.debounce
                .lock()
                .expect("debounce state poisoned")
                .pending
                .clone()
        };
        if let Some(pending) = pending {
            pending.wait().await;
            if let Some(message) = pending.error_message() {
                return Err(CodexError::new(message));
            }
        }
        Ok(())
    }

    /// TS `clearAccountTransientState()` — full-fidelity variant: immediate
    /// in-memory clear (that is what unblocks the live pool), then a
    /// debounced persist of the cleared pool. No-op on an empty pool.
    pub async fn clear_account_transient_state(&self) {
        let should_save = {
            let mut manager = self.manager.lock().await;
            manager.clear_account_transient_state()
        };
        if should_save {
            self.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
        }
    }

    /// TS `recordSuccess(account, family, model?)` — full-fidelity variant:
    /// run the tracker/healing half ([`AccountManager::record_success`]) and,
    /// when cooldown/auth-failure healing occurred, schedule the debounced
    /// persist (the TS method's `saveToDiskDebounced()` call). Same
    /// plain-method/shared-wrapper split as `clear_account_transient_state`.
    pub async fn record_success(&self, index: i64, family: ModelFamily, model: Option<&str>) {
        let healed = {
            let mut manager = self.manager.lock().await;
            manager.record_success(index, family, model)
        };
        if healed {
            self.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
        }
    }
}

/// `saveToDisk` over a shared handle: identical pipeline to
/// [`AccountManager::save_to_disk`], but the manager lock is held only
/// while snapshotting — the pool stays usable during the file IO, matching
/// the TS event-loop interleaving.
pub async fn save_to_disk_shared(
    manager: &Arc<tokio::sync::Mutex<AccountManager>>,
) -> Result<(), CodexError> {
    let path_state = {
        let manager = manager.lock().await;
        manager.storage_path_state.clone()
    };
    run_with_storage_path_state(path_state, async move {
        with_account_storage_transaction(move |current, persist| async move {
            let mut snapshot = {
                let mut manager = manager.lock().await;
                manager.build_storage_snapshot()
            };
            reconcile_tokens_from_disk(&mut snapshot, current.as_ref());
            persist.persist(&snapshot).await
        })
        .await
    })
    .await
}

/// The timer body of the debounced save (TS `doSave`).
async fn run_debounced_save(
    manager: Weak<tokio::sync::Mutex<AccountManager>>,
    debounce: Weak<StdMutex<DebounceState>>,
    my_generation: u64,
) {
    let Some(debounce) = debounce.upgrade() else {
        return;
    };
    let Some(manager) = manager.upgrade() else {
        return;
    };
    // Claim the fired timer; abort when superseded (a newer schedule) or
    // flushed (TS clearTimeout). Install our latch as the new pendingSave.
    let (previous, mine) = {
        let mut state = debounce.lock().expect("debounce state poisoned");
        if state.armed != Some(my_generation) {
            return;
        }
        state.armed = None;
        let previous = state.pending.take();
        let mine = Arc::new(PendingSave::new());
        state.pending = Some(Arc::clone(&mine));
        (previous, mine)
    };
    // TS: `if (this.pendingSave) await this.pendingSave;` — single-flight
    // ordering. Never while holding any lock.
    if let Some(previous) = previous {
        previous.wait().await;
    }
    let result = save_to_disk_shared(&manager).await;
    let error_message = match result {
        Ok(()) => None,
        Err(error) => {
            let message = error.message().to_string();
            create_logger("accounts").warn(
                "Debounced save failed",
                Some(&json!({ "error": message })),
            );
            Some(message)
        }
    };
    mine.complete(error_message);
    // TS `.finally(() => { this.pendingSave = null; })` — clear the slot
    // only if it is still ours.
    let mut state = debounce.lock().expect("debounce state poisoned");
    if let Some(pending) = &state.pending
        && Arc::ptr_eq(pending, &mine)
    {
        state.pending = None;
    }
}

// ===========================================================================
// Module-level formatters (TS exports of lib/accounts.ts)
// ===========================================================================

/// Field access needed by [`format_account_label`] /
/// [`format_workspace_lines`]. Implemented for [`ManagedAccount`] and
/// [`AccountMetadataV3`] so both live-pool and storage rows format
/// identically.
pub trait AccountLabelSource {
    fn label_email(&self) -> Option<&str>;
    fn label_account_id(&self) -> Option<&str>;
    fn label_account_label(&self) -> Option<&str>;
    fn label_workspaces(&self) -> Option<&[Workspace]>;
    fn label_current_workspace_index(&self) -> Option<i64>;
}

impl AccountLabelSource for AccountMetadataV3 {
    fn label_email(&self) -> Option<&str> {
        self.email.as_deref()
    }
    fn label_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn label_account_label(&self) -> Option<&str> {
        self.account_label.as_deref()
    }
    fn label_workspaces(&self) -> Option<&[Workspace]> {
        self.workspaces.as_deref()
    }
    fn label_current_workspace_index(&self) -> Option<i64> {
        self.current_workspace_index
    }
}

impl AccountLabelSource for ManagedAccount {
    fn label_email(&self) -> Option<&str> {
        self.meta.email.as_deref()
    }
    fn label_account_id(&self) -> Option<&str> {
        self.meta.account_id.as_deref()
    }
    fn label_account_label(&self) -> Option<&str> {
        self.meta.account_label.as_deref()
    }
    fn label_workspaces(&self) -> Option<&[Workspace]> {
        self.meta.workspaces.as_deref()
    }
    fn label_current_workspace_index(&self) -> Option<i64> {
        self.meta.current_workspace_index
    }
}

/// JS `id.slice(-6)` (whole id when ≤ 6 chars).
fn last_six_chars(value: &str) -> &str {
    let count = value.chars().count();
    if count <= 6 {
        return value;
    }
    let (idx, _) = value.char_indices().nth(count - 6).expect("count > 6");
    &value[idx..]
}

/// TS private `activeWorkspaceName(account)` — the active workspace's
/// trimmed name (`currentWorkspaceIndex ?? 0`, out-of-range falls back to
/// the first workspace), `None` when empty/untracked.
fn active_workspace_name(account: &dyn AccountLabelSource) -> Option<String> {
    let workspaces = account.label_workspaces()?;
    if workspaces.is_empty() {
        return None;
    }
    let idx = account.label_current_workspace_index().unwrap_or(0);
    let workspace = usize::try_from(idx)
        .ok()
        .and_then(|idx| workspaces.get(idx))
        .or_else(|| workspaces.first())?;
    let name = workspace.name.as_deref()?.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// TS `formatAccountLabel(account, index)` — 1-based display label.
/// Segments in order: manual `accountLabel`; `[workspaceName]` (skipped
/// when it repeats the label — #491); `email`; accountId 6-char suffix
/// (`id:<suffix>` when other segments precede, bare otherwise). No
/// segments → `"Account N"`.
pub fn format_account_label(account: Option<&dyn AccountLabelSource>, index: usize) -> String {
    let account_label = account
        .and_then(|a| a.label_account_label())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let workspace_name = account.and_then(active_workspace_name);
    let email = account
        .and_then(|a| a.label_email())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let account_id = account
        .and_then(|a| a.label_account_id())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let id_suffix = account_id.map(last_six_chars);

    let mut segments: Vec<String> = Vec::new();
    if let Some(label) = account_label {
        segments.push(label.to_string());
    }
    if let Some(workspace_name) = &workspace_name
        && account_label != Some(workspace_name.as_str())
    {
        segments.push(format!("[{workspace_name}]"));
    }
    if let Some(email) = email {
        segments.push(email.to_string());
    }
    if let Some(suffix) = id_suffix {
        if segments.is_empty() {
            segments.push(suffix.to_string());
        } else {
            segments.push(format!("id:{suffix}"));
        }
    }

    if segments.is_empty() {
        format!("Account {}", index + 1)
    } else {
        format!("Account {} ({})", index + 1, segments.join(", "))
    }
}

/// Default indent of TS `formatWorkspaceLines`.
pub const WORKSPACE_LINE_DEFAULT_INDENT: &str = "   ";

/// TS `formatWorkspaceLines(account, indent = "   ")` — one display line
/// per tracked workspace, the active one marked with `*` (issue #491).
pub fn format_workspace_lines(
    account: Option<&dyn AccountLabelSource>,
    indent: &str,
) -> Vec<String> {
    let Some(workspaces) = account.and_then(|a| a.label_workspaces()) else {
        return Vec::new();
    };
    if workspaces.is_empty() {
        return Vec::new();
    }
    let active_index = account
        .and_then(|a| a.label_current_workspace_index())
        .unwrap_or(0);
    workspaces
        .iter()
        .enumerate()
        .map(|(idx, workspace)| {
            let is_active = idx as i64 == active_index;
            let name = workspace
                .name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("(unnamed)");
            let id = workspace.id.trim();
            let id_suffix = last_six_chars(id);
            let mut tags: Vec<&str> = Vec::new();
            if is_active {
                tags.push("active");
            }
            if !workspace.enabled {
                tags.push("disabled");
            }
            let tag_label = if tags.is_empty() {
                String::new()
            } else {
                format!(" ({})", tags.join(", "))
            };
            let id_label = if id_suffix.is_empty() {
                String::new()
            } else {
                format!(" id:{id_suffix}")
            };
            format!(
                "{indent}{} {}. [{name}]{id_label}{tag_label}",
                if is_active { "*" } else { "-" },
                idx + 1,
            )
        })
        .collect()
}

/// TS `formatCooldown(account, now = nowMs())` — `None` when not cooling
/// down or already expired; otherwise `"<wait>"` or `"<wait> (<reason>)"`
/// (`formatWaitTime` floors — spec gotcha 31).
pub fn format_cooldown(
    cooling_down_until: Option<i64>,
    cooldown_reason: Option<&str>,
    now: i64,
) -> Option<String> {
    let until = cooling_down_until?;
    let remaining = until - now;
    if remaining <= 0 {
        return None;
    }
    let wait = format_wait_time(remaining);
    Some(match cooldown_reason {
        Some(reason) => format!("{wait} ({reason})"),
        None => wait,
    })
}

// ===========================================================================
// Tests (ported from test/accounts.test.ts persistence/snapshot suites)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::RuntimeAccountState;
    use cma_storage::facade::set_storage_path;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn metadata(
        account_id: Option<&str>,
        email: Option<&str>,
        refresh: &str,
        access: Option<&str>,
        expires_at: Option<i64>,
    ) -> AccountMetadataV3 {
        let mut account = AccountMetadataV3::new(refresh.to_string(), 1, 0);
        account.account_id = account_id.map(str::to_string);
        account.email = email.map(str::to_string);
        account.access_token = access.map(str::to_string);
        account.expires_at = expires_at;
        account
    }

    fn storage_with(accounts: Vec<AccountMetadataV3>) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        storage.accounts = accounts;
        storage
    }

    fn managed(refresh: &str) -> ManagedAccount {
        ManagedAccount {
            index: 0,
            rate_limit_reset_times: RateLimitStateV3::new(),
            meta: AccountMetadataV3::new(refresh.to_string(), 1, 0),
            runtime: RuntimeAccountState::default(),
        }
    }

    // ---- apply_rate_limit_with_reason (markRateLimitedWithReason suite) ----

    #[test]
    fn marks_rate_limited_with_quota_reason_on_base_key() {
        let mut times = RateLimitStateV3::new();
        apply_rate_limit_with_reason(
            &mut times,
            1_000,
            60_000,
            ModelFamily::Codex,
            RateLimitReason::Quota,
            None,
        );
        assert_eq!(times.get("codex"), Some(61_000));
    }

    #[test]
    fn h1_clamps_absurd_retry_after_to_seven_days() {
        let now = 1_775_000_000_000_i64;
        let mut times = RateLimitStateV3::new();
        // Hostile/buggy upstream: ~31 years in ms.
        apply_rate_limit_with_reason(
            &mut times,
            now,
            999_999_999_999,
            ModelFamily::Codex,
            RateLimitReason::Quota,
            None,
        );
        let seven_days_ms = 7 * 24 * 60 * 60 * 1000;
        assert_eq!(MAX_RATE_LIMIT_DELAY_MS, seven_days_ms);
        assert_eq!(times.get("codex"), Some(now + seven_days_ms));
    }

    #[test]
    fn negative_retry_after_clamps_to_zero() {
        let mut times = RateLimitStateV3::new();
        apply_rate_limit_with_reason(
            &mut times,
            5_000,
            -60_000,
            ModelFamily::Codex,
            RateLimitReason::Quota,
            None,
        );
        assert_eq!(times.get("codex"), Some(5_000));
    }

    #[test]
    fn scopes_token_rate_limits_to_the_model_specific_key() {
        let mut times = RateLimitStateV3::new();
        apply_rate_limit_with_reason(
            &mut times,
            1_000,
            60_000,
            ModelFamily::Codex,
            RateLimitReason::Tokens,
            Some("gpt-5.2"),
        );
        assert_eq!(times.get("codex"), None);
        assert_eq!(times.get("codex:gpt-5.2"), Some(61_000));
    }

    #[test]
    fn concurrent_with_model_writes_model_key_only() {
        let mut times = RateLimitStateV3::new();
        apply_rate_limit_with_reason(
            &mut times,
            1_000,
            30_000,
            ModelFamily::Gpt5_2,
            RateLimitReason::Concurrent,
            Some("gpt-5.2-pro"),
        );
        assert_eq!(times.get("gpt-5.2"), None);
        assert_eq!(times.get("gpt-5.2:gpt-5.2-pro"), Some(31_000));
    }

    #[test]
    fn unknown_with_model_writes_both_keys() {
        let mut times = RateLimitStateV3::new();
        apply_rate_limit_with_reason(
            &mut times,
            1_000,
            60_000,
            ModelFamily::Codex,
            RateLimitReason::Unknown,
            Some("gpt-5.2"),
        );
        assert_eq!(times.get("codex"), Some(61_000));
        assert_eq!(times.get("codex:gpt-5.2"), Some(61_000));
    }

    #[test]
    fn quota_with_model_writes_base_key_only() {
        let mut times = RateLimitStateV3::new();
        apply_rate_limit_with_reason(
            &mut times,
            1_000,
            60_000,
            ModelFamily::Codex,
            RateLimitReason::Quota,
            Some("gpt-5.2"),
        );
        assert_eq!(times.get("codex"), Some(61_000));
        assert_eq!(times.get("codex:gpt-5.2"), None);
    }

    #[test]
    fn empty_model_string_counts_as_no_model() {
        let mut times = RateLimitStateV3::new();
        apply_rate_limit_with_reason(
            &mut times,
            1_000,
            60_000,
            ModelFamily::Codex,
            RateLimitReason::Tokens,
            Some(""),
        );
        // JS falsiness: `!model` → base-key branch; model branch skipped.
        assert_eq!(times.get("codex"), Some(61_000));
        assert_eq!(times.len(), 1);
    }

    #[test]
    fn does_not_shorten_an_existing_reset_when_later_window_is_smaller() {
        let start = 1_775_000_000_000_i64;
        let mut times = RateLimitStateV3::new();
        apply_rate_limit_with_reason(
            &mut times,
            start,
            90 * 60_000,
            ModelFamily::Codex,
            RateLimitReason::Quota,
            None,
        );
        let expected_reset_at = start + 90 * 60_000;
        // 30 minutes later a SHORTER window arrives — max-merge keeps the
        // original.
        apply_rate_limit_with_reason(
            &mut times,
            start + 30 * 60_000,
            60_000,
            ModelFamily::Codex,
            RateLimitReason::Quota,
            None,
        );
        assert_eq!(times.get("codex"), Some(expected_reset_at));
    }

    #[test]
    fn does_not_shorten_an_existing_model_scoped_reset() {
        let start = 1_775_000_000_000_i64;
        let mut times = RateLimitStateV3::new();
        apply_rate_limit_with_reason(
            &mut times,
            start,
            90 * 60_000,
            ModelFamily::Codex,
            RateLimitReason::Tokens,
            Some("gpt-5.2"),
        );
        let expected_reset_at = start + 90 * 60_000;
        apply_rate_limit_with_reason(
            &mut times,
            start + 30 * 60_000,
            60_000,
            ModelFamily::Codex,
            RateLimitReason::Tokens,
            Some("gpt-5.2"),
        );
        assert_eq!(times.get("codex:gpt-5.2"), Some(expected_reset_at));
    }

    // ---- ManagedAccount marking / cooldown / toAuthDetails ----

    #[test]
    fn managed_account_marking_records_runtime_reason_and_map() {
        let mut account = managed("token-1");
        account.mark_rate_limited_with_reason(60_000, ModelFamily::Codex, RateLimitReason::Quota, None);
        assert_eq!(
            account.runtime.last_rate_limit_reason,
            Some(RateLimitReason::Quota)
        );
        assert!(account.rate_limit_reset_times.get("codex").is_some());
        // The meta slot stays dormant — only the snapshot builder fills it.
        assert!(account.meta.rate_limit_reset_times.is_none());
    }

    #[test]
    fn cooldown_marking_and_lazy_expiry() {
        let mut account = managed("token-1");
        account.mark_cooling_down(30_000, CooldownReason::AuthFailure);
        assert!(account.is_cooling_down());
        assert_eq!(
            account.meta.cooldown_reason,
            Some(CooldownReason::AuthFailure)
        );
        // Manual clear removes both fields.
        account.clear_cooldown();
        assert!(!account.is_cooling_down());
        assert_eq!(account.meta.cooldown_reason, None);
        // Expired cooldowns self-clear on inspection (gotcha 12).
        account.meta.cooling_down_until = Some(now_ms() - 1_000);
        account.meta.cooldown_reason = Some(CooldownReason::NetworkError);
        assert!(!account.is_cooling_down());
        assert_eq!(account.meta.cooling_down_until, None);
        assert_eq!(account.meta.cooldown_reason, None);
        // Negative cooldown clamps to 0 → immediately expired.
        account.mark_cooling_down(-5_000, CooldownReason::ServerError);
        assert!(!account.is_cooling_down());
    }

    #[test]
    fn to_auth_details_defaults_missing_access_and_expiry() {
        let mut account = managed("refresh-1");
        assert_eq!(
            account.to_auth_details(),
            OAuthAuthDetails {
                access: String::new(),
                refresh: "refresh-1".to_string(),
                expires: 0,
            }
        );
        account.meta.access_token = Some("access-1".to_string());
        account.meta.expires_at = Some(42);
        assert_eq!(
            account.to_auth_details(),
            OAuthAuthDetails {
                access: "access-1".to_string(),
                refresh: "refresh-1".to_string(),
                expires: 42,
            }
        );
    }

    #[test]
    fn clear_account_transient_state_wipes_every_account() {
        let storage = storage_with(vec![
            metadata(Some("a1"), None, "token-1", None, None),
            metadata(Some("a2"), None, "token-2", None, None),
        ]);
        let mut manager = AccountManager::new(None, Some(&storage));
        manager.mark_account_cooling_down(0, 60_000, CooldownReason::RateLimit);
        manager.mark_rate_limited_with_reason(
            0,
            90 * 60_000,
            ModelFamily::Codex,
            RateLimitReason::Quota,
            None,
        );
        manager.mark_rate_limited_with_reason(
            1,
            90 * 60_000,
            ModelFamily::Gpt5_2,
            RateLimitReason::Tokens,
            Some("gpt-5.2-pro"),
        );

        assert!(manager.clear_account_transient_state());

        for index in 0..2 {
            let account = manager.get_account_by_index(index).unwrap();
            assert_eq!(account.meta.cooling_down_until, None);
            assert_eq!(account.meta.cooldown_reason, None);
            assert!(account.rate_limit_reset_times.is_empty());
            assert_eq!(account.runtime.last_rate_limit_reason, None);
        }
    }

    #[test]
    fn clear_account_transient_state_is_a_noop_on_empty_pool() {
        let mut manager = AccountManager::new(None, None);
        assert!(!manager.clear_account_transient_state());
    }

    // ---- resolve_effective_pin_and_gen (#474) ----

    #[test]
    fn adopts_disk_pin_only_when_disk_generation_strictly_greater() {
        // Strictly greater → adopt both.
        assert_eq!(
            resolve_effective_pin_and_gen(
                Some(1),
                2,
                PinAndGen {
                    pinned_account_index: Some(0),
                    affinity_generation: 3
                },
                4,
            ),
            (Some(0), 3),
        );
        // Equal → keep memory pin.
        assert_eq!(
            resolve_effective_pin_and_gen(
                Some(1),
                3,
                PinAndGen {
                    pinned_account_index: Some(0),
                    affinity_generation: 3
                },
                4,
            ),
            (Some(1), 3),
        );
        // Disk-read failure shape ({None, 0}) → keep memory values.
        assert_eq!(
            resolve_effective_pin_and_gen(
                Some(2),
                5,
                PinAndGen {
                    pinned_account_index: None,
                    affinity_generation: 0
                },
                4,
            ),
            (Some(2), 5),
        );
    }

    #[test]
    fn validates_effective_pin_against_live_account_count() {
        // Adopted disk pin out of range → cleared (gen still adopted).
        assert_eq!(
            resolve_effective_pin_and_gen(
                None,
                0,
                PinAndGen {
                    pinned_account_index: Some(7),
                    affinity_generation: 2
                },
                3,
            ),
            (None, 2),
        );
        // Memory pin invalidated by a shrunken pool.
        assert_eq!(
            resolve_effective_pin_and_gen(
                Some(3),
                1,
                PinAndGen {
                    pinned_account_index: None,
                    affinity_generation: 0
                },
                3,
            ),
            (None, 1),
        );
        // Disk gen strictly greater with an UNSET disk pin clears the pin
        // (pin+gen are one atomic CLI write).
        assert_eq!(
            resolve_effective_pin_and_gen(
                Some(1),
                1,
                PinAndGen {
                    pinned_account_index: None,
                    affinity_generation: 2
                },
                3,
            ),
            (None, 2),
        );
    }

    // ---- reconcile_tokens_from_disk (H3) ----

    #[test]
    fn adopts_strictly_newer_disk_tokens() {
        let mut snapshot = storage_with(vec![metadata(
            Some("acc1"),
            Some("a@example.com"),
            "mem-refresh",
            Some("mem-access"),
            Some(1_000),
        )]);
        let disk = storage_with(vec![metadata(
            Some("acc1"),
            Some("a@example.com"),
            "disk-refresh",
            Some("disk-access"),
            Some(2_000),
        )]);
        reconcile_tokens_from_disk(&mut snapshot, Some(&disk));
        let account = &snapshot.accounts[0];
        assert_eq!(account.refresh_token, "disk-refresh");
        assert_eq!(account.access_token.as_deref(), Some("disk-access"));
        assert_eq!(account.expires_at, Some(2_000));
    }

    #[test]
    fn equal_expiries_keep_the_memory_copy() {
        let mut snapshot = storage_with(vec![metadata(
            Some("acc1"),
            None,
            "mem-refresh",
            Some("mem-access"),
            Some(2_000),
        )]);
        let disk = storage_with(vec![metadata(
            Some("acc1"),
            None,
            "disk-refresh",
            Some("disk-access"),
            Some(2_000),
        )]);
        reconcile_tokens_from_disk(&mut snapshot, Some(&disk));
        assert_eq!(snapshot.accounts[0].refresh_token, "mem-refresh");
        assert_eq!(
            snapshot.accounts[0].access_token.as_deref(),
            Some("mem-access")
        );
    }

    #[test]
    fn newer_memory_copy_wins_our_own_refresh() {
        let mut snapshot = storage_with(vec![metadata(
            Some("acc1"),
            None,
            "mem-refresh",
            Some("mem-access"),
            Some(3_000),
        )]);
        let disk = storage_with(vec![metadata(
            Some("acc1"),
            None,
            "disk-refresh",
            Some("disk-access"),
            Some(2_000),
        )]);
        reconcile_tokens_from_disk(&mut snapshot, Some(&disk));
        assert_eq!(snapshot.accounts[0].refresh_token, "mem-refresh");
    }

    #[test]
    fn newer_disk_row_without_refresh_token_is_ignored() {
        let mut snapshot = storage_with(vec![metadata(
            Some("acc1"),
            None,
            "mem-refresh",
            None,
            Some(1_000),
        )]);
        // Zod forbids empty refresh tokens on load, but reconcile guards
        // anyway (TS truthiness check on disk.refreshToken).
        let mut disk_row = metadata(Some("acc1"), None, "x", Some("disk-access"), Some(9_000));
        disk_row.refresh_token = String::new();
        let disk = storage_with(vec![disk_row]);
        reconcile_tokens_from_disk(&mut snapshot, Some(&disk));
        assert_eq!(snapshot.accounts[0].refresh_token, "mem-refresh");
        assert_eq!(snapshot.accounts[0].expires_at, Some(1_000));
    }

    #[test]
    fn missing_current_storage_is_a_noop() {
        let mut snapshot = storage_with(vec![metadata(
            Some("acc1"),
            None,
            "mem-refresh",
            None,
            Some(1_000),
        )]);
        reconcile_tokens_from_disk(&mut snapshot, None);
        assert_eq!(snapshot.accounts[0].refresh_token, "mem-refresh");
    }

    #[test]
    fn non_matching_identities_are_untouched() {
        let mut snapshot = storage_with(vec![metadata(
            Some("acc1"),
            None,
            "mem-refresh",
            None,
            Some(1_000),
        )]);
        let disk = storage_with(vec![metadata(
            Some("acc2"),
            None,
            "disk-refresh",
            Some("disk-access"),
            Some(9_000),
        )]);
        reconcile_tokens_from_disk(&mut snapshot, Some(&disk));
        assert_eq!(snapshot.accounts[0].refresh_token, "mem-refresh");
    }

    // ---- build_storage_snapshot / save_to_disk (sandboxed) ----

    #[test]
    #[serial(env, storage_path_state)]
    fn snapshot_clamps_pointers_and_applies_omission_rules() {
        let _sandbox = EnvSandbox::new();
        set_storage_path(None);
        // Empty pool: -1 pointers serialize as 0 (gotcha 15).
        let mut empty = AccountManager::new(None, None);
        let snapshot = empty.build_storage_snapshot();
        assert_eq!(snapshot.active_index, 0);
        let by_family = snapshot.active_index_by_family.as_ref().unwrap();
        for family in MODEL_FAMILIES {
            assert_eq!(by_family.get(family), Some(0));
        }
        assert_eq!(snapshot.pinned_account_index, None);
        assert_eq!(snapshot.affinity_generation, None);

        // Enabled account: `enabled` and empty rateLimitResetTimes OMITTED.
        let storage = storage_with(vec![metadata(Some("a1"), None, "token-1", None, None)]);
        let mut manager = AccountManager::new(None, Some(&storage));
        let snapshot = manager.build_storage_snapshot();
        let row = serde_json::to_value(&snapshot.accounts[0]).unwrap();
        let object = row.as_object().unwrap();
        assert!(!object.contains_key("enabled"));
        assert!(!object.contains_key("rateLimitResetTimes"));
        assert!(!object.contains_key("coolingDownUntil"));
        assert_eq!(object.get("refreshToken").unwrap(), "token-1");
    }

    #[test]
    #[serial(env, storage_path_state)]
    fn snapshot_adopts_disk_pin_when_disk_generation_is_newer() {
        let _sandbox = EnvSandbox::new();
        set_storage_path(None);
        let storage = storage_with(vec![metadata(Some("a1"), None, "token-1", None, None)]);
        let mut manager = AccountManager::new(None, Some(&storage));

        let path = std::path::PathBuf::from(get_storage_path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"pinnedAccountIndex":0,"affinityGeneration":5}"#).unwrap();

        let snapshot = manager.build_storage_snapshot();
        assert_eq!(snapshot.pinned_account_index, Some(0));
        assert_eq!(snapshot.affinity_generation, Some(5));
        // Refreshed values are cached back onto the instance: a second
        // snapshot with the file gone keeps them.
        std::fs::remove_file(&path).unwrap();
        let snapshot = manager.build_storage_snapshot();
        assert_eq!(snapshot.pinned_account_index, Some(0));
        assert_eq!(snapshot.affinity_generation, Some(5));
    }

    #[tokio::test]
    #[serial(env, storage_path_state)]
    async fn save_to_disk_persists_the_pool_and_reconciles_disk_tokens() {
        let _sandbox = EnvSandbox::new();
        set_storage_path(None);
        let path = std::path::PathBuf::from(get_storage_path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Another process rotated this token to a NEWER expiry.
        std::fs::write(
            &path,
            concat!(
                r#"{"version":3,"accounts":[{"accountId":"acc1","refreshToken":"disk-refresh","#,
                r#""accessToken":"disk-access","expiresAt":9000,"addedAt":1,"lastUsed":0}],"activeIndex":0}"#,
            ),
        )
        .unwrap();

        let mut mem_row = metadata(Some("acc1"), None, "mem-refresh", Some("mem-access"), Some(100));
        mem_row.rate_limit_reset_times = None;
        let storage = storage_with(vec![mem_row]);
        let mut manager = AccountManager::new(None, Some(&storage));
        manager.save_to_disk().await.unwrap();

        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["version"], 3);
        // H3: the routine save must NOT clobber the newer disk token.
        assert_eq!(written["accounts"][0]["refreshToken"], "disk-refresh");
        assert_eq!(written["accounts"][0]["accessToken"], "disk-access");
        assert_eq!(written["accounts"][0]["expiresAt"], 9000);
    }

    // ---- debounced save + flush ----

    #[tokio::test]
    #[serial(env, storage_path_state)]
    async fn debounced_save_coalesces_and_only_the_last_timer_fires() {
        let _sandbox = EnvSandbox::new();
        set_storage_path(None);
        let storage = storage_with(vec![metadata(Some("a1"), None, "token-1", None, None)]);
        let shared = SharedAccountManager::new(AccountManager::new(None, Some(&storage)));

        shared.save_to_disk_debounced(50);
        shared.save_to_disk_debounced(50);
        shared.save_to_disk_debounced(50);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        shared.flush_pending_save().await.unwrap();

        let path = std::path::PathBuf::from(get_storage_path());
        assert!(path.exists(), "debounced save must have fired");

        // Prove the superseded timers never fire: remove the file and let
        // any stale workers wake — none may re-create it.
        std::fs::remove_file(&path).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!path.exists(), "superseded debounce timers must not save");
    }

    #[tokio::test]
    #[serial(env, storage_path_state)]
    async fn flush_pending_save_cancels_the_timer_and_saves_immediately() {
        let _sandbox = EnvSandbox::new();
        set_storage_path(None);
        let storage = storage_with(vec![metadata(Some("a1"), None, "token-1", None, None)]);
        let shared = SharedAccountManager::new(AccountManager::new(None, Some(&storage)));

        shared.save_to_disk_debounced(400);
        // Flush long before the timer deadline: must save NOW.
        shared.flush_pending_save().await.unwrap();
        let path = std::path::PathBuf::from(get_storage_path());
        assert!(path.exists(), "flush must save immediately");

        // The cancelled worker must not fire later.
        std::fs::remove_file(&path).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        assert!(!path.exists(), "cancelled debounce timer must not save");
    }

    #[tokio::test]
    #[serial(env, storage_path_state)]
    async fn clear_account_transient_state_persists_the_cleared_pool() {
        let _sandbox = EnvSandbox::new();
        set_storage_path(None);
        let mut row = metadata(Some("a1"), None, "token-1", None, None);
        row.cooling_down_until = Some(now_ms() + 3_600_000);
        row.cooldown_reason = Some(CooldownReason::RateLimit);
        let mut times = RateLimitStateV3::new();
        times.insert("codex", now_ms() + 3_600_000);
        row.rate_limit_reset_times = Some(times);
        let storage = storage_with(vec![row]);
        let shared = SharedAccountManager::new(AccountManager::new(None, Some(&storage)));

        shared.clear_account_transient_state().await;
        shared.flush_pending_save().await.unwrap();

        let path = std::path::PathBuf::from(get_storage_path());
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let account = &written["accounts"][0];
        assert_eq!(account.get("coolingDownUntil"), None);
        assert_eq!(account.get("cooldownReason"), None);
        assert_eq!(account.get("rateLimitResetTimes"), None);
    }

    #[tokio::test]
    #[serial(env, storage_path_state, volatile)]
    async fn record_success_persists_cooldown_healing_via_debounced_save() {
        let _sandbox = EnvSandbox::new();
        set_storage_path(None);
        let mut row = metadata(Some("a1"), None, "token-1", None, None);
        // EXPIRED cooldown: metadata still present, but the account is no
        // longer cooling down — recordSuccess must heal (clear both fields)
        // and schedule the debounced persist (TS `saveToDiskDebounced()`).
        row.cooling_down_until = Some(now_ms() - 1_000);
        row.cooldown_reason = Some(CooldownReason::RateLimit);
        let storage = storage_with(vec![row]);
        let shared = SharedAccountManager::new(AccountManager::new(None, Some(&storage)));

        shared.record_success(0, ModelFamily::Codex, None).await;
        shared.flush_pending_save().await.unwrap();

        let path = std::path::PathBuf::from(get_storage_path());
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let account = &written["accounts"][0];
        assert_eq!(account.get("coolingDownUntil"), None);
        assert_eq!(account.get("cooldownReason"), None);
    }

    // ---- formatters ----

    #[derive(Default)]
    struct TestAccount {
        email: Option<String>,
        account_id: Option<String>,
        account_label: Option<String>,
        workspaces: Option<Vec<Workspace>>,
        current_workspace_index: Option<i64>,
    }

    impl AccountLabelSource for TestAccount {
        fn label_email(&self) -> Option<&str> {
            self.email.as_deref()
        }
        fn label_account_id(&self) -> Option<&str> {
            self.account_id.as_deref()
        }
        fn label_account_label(&self) -> Option<&str> {
            self.account_label.as_deref()
        }
        fn label_workspaces(&self) -> Option<&[Workspace]> {
            self.workspaces.as_deref()
        }
        fn label_current_workspace_index(&self) -> Option<i64> {
            self.current_workspace_index
        }
    }

    fn workspace(id: &str, name: Option<&str>, enabled: bool) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: name.map(str::to_string),
            enabled,
            disabled_at: None,
            is_default: None,
        }
    }

    #[test]
    fn formats_account_label_preferring_email_and_id_suffix() {
        let account = TestAccount {
            email: Some("user@example.com".into()),
            account_id: Some("abcdef123456".into()),
            ..Default::default()
        };
        assert_eq!(
            format_account_label(Some(&account), 0),
            "Account 1 (user@example.com, id:123456)"
        );
        let email_only = TestAccount {
            email: Some("user@example.com".into()),
            ..Default::default()
        };
        assert_eq!(
            format_account_label(Some(&email_only), 1),
            "Account 2 (user@example.com)"
        );
        let id_only = TestAccount {
            account_id: Some("abcdef123456".into()),
            ..Default::default()
        };
        assert_eq!(format_account_label(Some(&id_only), 2), "Account 3 (123456)");
        assert_eq!(format_account_label(None, 3), "Account 4");
    }

    #[test]
    fn formats_account_label_with_account_label_variations() {
        let label_only = TestAccount {
            account_label: Some("Work".into()),
            ..Default::default()
        };
        assert_eq!(format_account_label(Some(&label_only), 0), "Account 1 (Work)");
        let label_email = TestAccount {
            account_label: Some("Work".into()),
            email: Some("work@co.com".into()),
            ..Default::default()
        };
        assert_eq!(
            format_account_label(Some(&label_email), 0),
            "Account 1 (Work, work@co.com)"
        );
        let label_id = TestAccount {
            account_label: Some("Work".into()),
            account_id: Some("abcdef123456".into()),
            ..Default::default()
        };
        assert_eq!(
            format_account_label(Some(&label_id), 0),
            "Account 1 (Work, id:123456)"
        );
        let all = TestAccount {
            account_label: Some("Work".into()),
            email: Some("work@co.com".into()),
            account_id: Some("abcdef123456".into()),
            ..Default::default()
        };
        assert_eq!(
            format_account_label(Some(&all), 0),
            "Account 1 (Work, work@co.com, id:123456)"
        );
    }

    #[test]
    fn formats_account_label_with_short_account_id() {
        let short = TestAccount {
            account_id: Some("abc".into()),
            ..Default::default()
        };
        assert_eq!(format_account_label(Some(&short), 0), "Account 1 (abc)");
        let exact = TestAccount {
            account_id: Some("123456".into()),
            ..Default::default()
        };
        assert_eq!(format_account_label(Some(&exact), 0), "Account 1 (123456)");
    }

    #[test]
    fn surfaces_the_active_workspace_to_distinguish_same_email_accounts() {
        let personal = TestAccount {
            email: Some("user@gmail.com".into()),
            account_id: Some("org-AAAA".into()),
            workspaces: Some(vec![workspace("org-AAAA", Some("Personal Plus"), true)]),
            current_workspace_index: Some(0),
            ..Default::default()
        };
        assert_eq!(
            format_account_label(Some(&personal), 0),
            "Account 1 ([Personal Plus], user@gmail.com, id:g-AAAA)"
        );
        let business = TestAccount {
            email: Some("user@gmail.com".into()),
            account_id: Some("org-BBBB".into()),
            workspaces: Some(vec![workspace("org-BBBB", Some("GkTech Business"), true)]),
            current_workspace_index: Some(0),
            ..Default::default()
        };
        assert_eq!(
            format_account_label(Some(&business), 1),
            "Account 2 ([GkTech Business], user@gmail.com, id:g-BBBB)"
        );
    }

    #[test]
    fn follows_current_workspace_index_when_picking_the_workspace_tag() {
        let account = TestAccount {
            email: Some("user@gmail.com".into()),
            workspaces: Some(vec![
                workspace("org-AAAA", Some("Personal Plus"), true),
                workspace("org-BBBB", Some("GkTech Business"), true),
            ]),
            current_workspace_index: Some(1),
            ..Default::default()
        };
        assert_eq!(
            format_account_label(Some(&account), 0),
            "Account 1 ([GkTech Business], user@gmail.com)"
        );
    }

    #[test]
    fn omits_the_workspace_tag_when_it_duplicates_the_account_label() {
        let account = TestAccount {
            account_label: Some("Personal Plus".into()),
            email: Some("user@gmail.com".into()),
            workspaces: Some(vec![workspace("org-AAAA", Some("Personal Plus"), true)]),
            current_workspace_index: Some(0),
            ..Default::default()
        };
        assert_eq!(
            format_account_label(Some(&account), 0),
            "Account 1 (Personal Plus, user@gmail.com)"
        );
    }

    #[test]
    fn ignores_empty_or_unnamed_workspaces_in_the_label() {
        let unnamed = TestAccount {
            email: Some("user@gmail.com".into()),
            workspaces: Some(vec![workspace("org-AAAA", None, true)]),
            current_workspace_index: Some(0),
            ..Default::default()
        };
        assert_eq!(
            format_account_label(Some(&unnamed), 0),
            "Account 1 (user@gmail.com)"
        );
        let empty = TestAccount {
            email: Some("user@gmail.com".into()),
            workspaces: Some(vec![]),
            current_workspace_index: Some(0),
            ..Default::default()
        };
        assert_eq!(
            format_account_label(Some(&empty), 0),
            "Account 1 (user@gmail.com)"
        );
    }

    #[test]
    fn lists_workspaces_with_the_active_one_marked() {
        let account = TestAccount {
            workspaces: Some(vec![
                workspace("org-AAAA", Some("Personal Plus"), true),
                workspace("org-BBBB", Some("GkTech Business"), true),
            ]),
            current_workspace_index: Some(1),
            ..Default::default()
        };
        assert_eq!(
            format_workspace_lines(Some(&account), WORKSPACE_LINE_DEFAULT_INDENT),
            vec![
                "   - 1. [Personal Plus] id:g-AAAA",
                "   * 2. [GkTech Business] id:g-BBBB (active)",
            ]
        );
    }

    #[test]
    fn marks_disabled_workspaces_and_honors_a_custom_indent() {
        let mut disabled = workspace("org-BBBB", None, false);
        disabled.disabled_at = Some(1);
        let account = TestAccount {
            workspaces: Some(vec![
                workspace("org-AAAA", Some("Personal Plus"), true),
                disabled,
            ]),
            current_workspace_index: Some(0),
            ..Default::default()
        };
        assert_eq!(
            format_workspace_lines(Some(&account), "  "),
            vec![
                "  * 1. [Personal Plus] id:g-AAAA (active)",
                "  - 2. [(unnamed)] id:g-BBBB (disabled)",
            ]
        );
    }

    #[test]
    fn returns_no_workspace_lines_when_none_are_tracked() {
        assert!(format_workspace_lines(None, WORKSPACE_LINE_DEFAULT_INDENT).is_empty());
        let no_field = TestAccount::default();
        assert!(format_workspace_lines(Some(&no_field), WORKSPACE_LINE_DEFAULT_INDENT).is_empty());
        let empty = TestAccount {
            workspaces: Some(vec![]),
            ..Default::default()
        };
        assert!(format_workspace_lines(Some(&empty), WORKSPACE_LINE_DEFAULT_INDENT).is_empty());
    }

    #[test]
    fn format_cooldown_matches_ts_cases() {
        let now = 1_775_000_000_000_i64;
        assert_eq!(format_cooldown(None, None, now), None);
        assert_eq!(format_cooldown(Some(now - 1_000), None, now), None);
        assert_eq!(format_cooldown(Some(now), None, now), None);
        assert_eq!(
            format_cooldown(Some(now + 30_000), None, now),
            Some("30s".to_string())
        );
        assert_eq!(
            format_cooldown(Some(now + 60_000), Some("auth-failure"), now),
            Some("1m 0s (auth-failure)".to_string())
        );
        assert_eq!(
            format_cooldown(Some(now + 150_000), Some("network-error"), now),
            Some("2m 30s (network-error)".to_string())
        );
    }
}
