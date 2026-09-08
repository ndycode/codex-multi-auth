//! Port of `lib/oc-chatgpt-import-adapter.ts` — pure merge/normalize logic to
//! export this tool's account pool into oc-chatgpt-multi-auth.
//!
//! Key invariants (spec 12 §11 + gotchas 14–17):
//! - De-dup bucket ORDER defines output account order: identity bucket, then
//!   email, then refresh-token, each insertion-ordered.
//! - Bare accountId without email deliberately skips the accountId bucket so
//!   a shared workspace id cannot collapse distinct business accounts.
//! - `pickNewest` ties prefer the CURRENT/destination record.
//! - Merge NEVER touches destination active selection
//!   (`preserve-destination`).

use std::collections::HashSet;

use cma_core::model_family::MODEL_FAMILIES;
use cma_core::schemas::account_storage::{
    AccountMetadataV3, AccountStorageV3, ActiveIndexByFamily,
};
use cma_core::schemas::parse::Version3;
use cma_storage::identity::{get_account_identity_key, normalize_email_key};
use cma_storage::matching::{AccountMatchOptions, find_matching_account_index};
use serde::Serialize;

/// TS `MatchStrategy = "accountId" | "email" | "refreshToken"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum MatchStrategy {
    #[serde(rename = "accountId")]
    AccountId,
    #[serde(rename = "email")]
    Email,
    #[serde(rename = "refreshToken")]
    RefreshToken,
}

impl MatchStrategy {
    pub const fn as_str(self) -> &'static str {
        match self {
            MatchStrategy::AccountId => "accountId",
            MatchStrategy::Email => "email",
            MatchStrategy::RefreshToken => "refreshToken",
        }
    }
}

/// TS `OcChatgptImportPayload = AccountStorageV3`.
pub type OcChatgptImportPayload = AccountStorageV3;

/// TS `OcChatgptAccountRef` — preview-safe reference with a masked token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OcChatgptAccountRef {
    #[serde(rename = "accountId", skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(rename = "refreshTokenLast4")]
    pub refresh_token_last4: String,
}

/// TS `OcChatgptPreviewPayload`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OcChatgptPreviewPayload {
    /// Literal `3`.
    pub version: Version3,
    #[serde(rename = "activeIndex")]
    pub active_index: i64,
    #[serde(
        rename = "activeIndexByFamily",
        skip_serializing_if = "Option::is_none"
    )]
    pub active_index_by_family: Option<ActiveIndexByFamily>,
    pub accounts: Vec<OcChatgptAccountRef>,
}

/// One `toUpdate` entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OcChatgptUpdateEntry {
    pub previous: OcChatgptAccountRef,
    pub next: OcChatgptAccountRef,
    #[serde(rename = "matchedBy")]
    pub matched_by: MatchStrategy,
}

/// One `toSkip` entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OcChatgptSkipEntry {
    pub source: OcChatgptAccountRef,
    pub reason: String,
}

/// TS `OcChatgptMergePreview`.
#[derive(Clone, Debug, PartialEq)]
pub struct OcChatgptMergePreview {
    pub payload: OcChatgptPreviewPayload,
    /// WARNING: contains raw refreshToken values — do not log directly.
    pub merged: AccountStorageV3,
    pub to_add: Vec<OcChatgptAccountRef>,
    pub to_update: Vec<OcChatgptUpdateEntry>,
    pub to_skip: Vec<OcChatgptSkipEntry>,
    pub unchanged_destination_only: Vec<OcChatgptAccountRef>,
    /// Always `"preserve-destination"`.
    pub active_selection_behavior: &'static str,
}

struct NormalizedForTarget {
    storage: AccountStorageV3,
    skipped: Vec<OcChatgptSkipEntry>,
}

/// Adapter-local `clampIndex(index, length)` (TS defines its own).
fn clamp_index(index: i64, length: usize) -> i64 {
    if length == 0 {
        return 0;
    }
    index.clamp(0, (length - 1) as i64)
}

/// TS `pickNewest(current, candidate)` — returns true when CANDIDATE wins:
/// strictly larger `lastUsed`, or a `lastUsed` tie with strictly larger
/// `addedAt`. Full ties prefer `current`.
fn candidate_is_newest(current: &AccountMetadataV3, candidate: &AccountMetadataV3) -> bool {
    if candidate.last_used > current.last_used {
        return true;
    }
    if candidate.last_used < current.last_used {
        return false;
    }
    candidate.added_at > current.added_at
}

fn trimmed_or_none(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// TS `sanitizeAccount(account)` — `None` when the refresh token is empty
/// after trimming; trims id/email/label; other fields spread through
/// unchanged.
fn sanitize_account(account: &AccountMetadataV3) -> Option<AccountMetadataV3> {
    let refresh_token = account.refresh_token.trim();
    if refresh_token.is_empty() {
        return None;
    }
    let mut sanitized = account.clone();
    sanitized.account_id = trimmed_or_none(account.account_id.as_deref());
    sanitized.email = trimmed_or_none(account.email.as_deref());
    sanitized.account_label = trimmed_or_none(account.account_label.as_deref());
    sanitized.refresh_token = refresh_token.to_string();
    Some(sanitized)
}

/// TS `tokenLast4(token)` — `<= 4` chars ⇒ all asterisks, else last 4.
fn token_last4(token: &str) -> String {
    let trimmed = token.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 4 {
        return "*".repeat(chars.len());
    }
    chars[chars.len() - 4..].iter().collect()
}

/// TS `summarizeAccount(account)`.
fn summarize_account(account: &AccountMetadataV3) -> OcChatgptAccountRef {
    OcChatgptAccountRef {
        account_id: account.account_id.clone(),
        email: account.email.clone(),
        refresh_token_last4: token_last4(&account.refresh_token),
    }
}

/// TS `buildPreviewPayload(storage)`.
fn build_preview_payload(storage: &AccountStorageV3) -> OcChatgptPreviewPayload {
    OcChatgptPreviewPayload {
        version: Version3::default(),
        active_index: storage.active_index,
        active_index_by_family: storage.active_index_by_family.clone(),
        accounts: storage.accounts.iter().map(summarize_account).collect(),
    }
}

/// TS `remapActiveIndex(originalAccounts, originalIndex, normalizedAccounts)`.
fn remap_active_index(
    original_accounts: Option<&[AccountMetadataV3]>,
    original_index: Option<i64>,
    normalized_accounts: &[AccountMetadataV3],
) -> i64 {
    let Some(original) = original_accounts.filter(|accounts| !accounts.is_empty()) else {
        return clamp_index(0, normalized_accounts.len());
    };
    let safe_original_index = clamp_index(original_index.unwrap_or(0), original.len());
    let original_active = &original[safe_original_index as usize];
    if let Some(remapped) = find_matching_account_index(
        normalized_accounts,
        original_active,
        AccountMatchOptions::default(),
    ) {
        return remapped as i64;
    }
    clamp_index(safe_original_index, normalized_accounts.len())
}

/// TS `normalizeActiveIndexByFamily(...)` — iterates `MODEL_FAMILIES` only
/// (unknown keys are dropped by the typed map), skips missing values.
fn normalize_active_index_by_family(
    active_index_by_family: Option<&ActiveIndexByFamily>,
    original_accounts: Option<&[AccountMetadataV3]>,
    normalized_accounts: &[AccountMetadataV3],
) -> Option<ActiveIndexByFamily> {
    let map = active_index_by_family?;
    let mut normalized = ActiveIndexByFamily::default();
    for family in MODEL_FAMILIES {
        let Some(raw) = map.get(family) else {
            continue;
        };
        normalized.set(
            family,
            Some(remap_active_index(
                original_accounts,
                Some(raw),
                normalized_accounts,
            )),
        );
    }
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// Insertion-ordered map bucket (JS `Map.set` keeps the original slot when a
/// key is replaced).
struct Bucket {
    entries: Vec<(String, AccountMetadataV3)>,
}

impl Bucket {
    fn new() -> Self {
        Bucket { entries: Vec::new() }
    }

    fn get(&self, key: &str) -> Option<&AccountMetadataV3> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, account)| account)
    }

    fn set(&mut self, key: &str, account: AccountMetadataV3) {
        if let Some(slot) = self.entries.iter_mut().find(|(k, _)| k == key) {
            slot.1 = account;
        } else {
            self.entries.push((key.to_string(), account));
        }
    }

    fn into_values(self) -> impl Iterator<Item = AccountMetadataV3> {
        self.entries.into_iter().map(|(_, account)| account)
    }
}

/// TS `normalizeAccountsForTarget(accounts)`.
fn normalize_accounts_for_target(
    accounts: &[AccountMetadataV3],
) -> (Vec<AccountMetadataV3>, Vec<OcChatgptSkipEntry>) {
    let mut skipped: Vec<OcChatgptSkipEntry> = Vec::new();
    let mut valid: Vec<AccountMetadataV3> = Vec::new();

    for candidate in accounts {
        match sanitize_account(candidate) {
            Some(sanitized) => valid.push(sanitized),
            None => skipped.push(OcChatgptSkipEntry {
                source: summarize_account(candidate),
                reason: "invalid-refresh-token".to_string(),
            }),
        }
    }

    let mut by_account_identity = Bucket::new();
    let mut without_account_id: Vec<AccountMetadataV3> = Vec::new();

    for account in valid {
        if account.account_id.is_some() && normalize_email_key(account.email.as_deref()).is_some()
        {
            let Some(identity_key) = get_account_identity_key(&account) else {
                without_account_id.push(account);
                continue;
            };
            match by_account_identity.get(&identity_key) {
                None => by_account_identity.set(&identity_key, account),
                Some(existing) => {
                    if candidate_is_newest(existing, &account) {
                        skipped.push(OcChatgptSkipEntry {
                            source: summarize_account(existing),
                            reason: "duplicate-account-id".to_string(),
                        });
                        by_account_identity.set(&identity_key, account);
                    } else {
                        skipped.push(OcChatgptSkipEntry {
                            source: summarize_account(&account),
                            reason: "duplicate-account-id".to_string(),
                        });
                    }
                }
            }
            continue;
        }
        without_account_id.push(account);
    }

    let mut by_email = Bucket::new();
    let mut without_identity: Vec<AccountMetadataV3> = Vec::new();

    for account in without_account_id {
        if let Some(normalized_email) = normalize_email_key(account.email.as_deref()) {
            match by_email.get(&normalized_email) {
                None => by_email.set(&normalized_email, account),
                Some(existing) => {
                    if candidate_is_newest(existing, &account) {
                        skipped.push(OcChatgptSkipEntry {
                            source: summarize_account(existing),
                            reason: "duplicate-email".to_string(),
                        });
                        by_email.set(&normalized_email, account);
                    } else {
                        skipped.push(OcChatgptSkipEntry {
                            source: summarize_account(&account),
                            reason: "duplicate-email".to_string(),
                        });
                    }
                }
            }
            continue;
        }
        without_identity.push(account);
    }

    let mut by_refresh_token = Bucket::new();
    for account in without_identity {
        let key = account.refresh_token.clone();
        match by_refresh_token.get(&key) {
            None => by_refresh_token.set(&key, account),
            Some(existing) => {
                if candidate_is_newest(existing, &account) {
                    skipped.push(OcChatgptSkipEntry {
                        source: summarize_account(existing),
                        reason: "duplicate-refresh-token".to_string(),
                    });
                    by_refresh_token.set(&key, account);
                } else {
                    skipped.push(OcChatgptSkipEntry {
                        source: summarize_account(&account),
                        reason: "duplicate-refresh-token".to_string(),
                    });
                }
            }
        }
    }

    let accounts: Vec<AccountMetadataV3> = by_account_identity
        .into_values()
        .chain(by_email.into_values())
        .chain(by_refresh_token.into_values())
        .collect();
    (accounts, skipped)
}

/// TS `normalizeStorageForTarget(storage)`.
///
/// NOTE: the TS output literal carries only `version/accounts/activeIndex/
/// activeIndexByFamily` — a source `pinnedAccountIndex`/`affinityGeneration`
/// is deliberately dropped (verified against the TS source; spec 12 §14's
/// "passes through" note describes the field's optionality, not this path).
fn normalize_storage_for_target(storage: Option<&AccountStorageV3>) -> NormalizedForTarget {
    let original_accounts = storage.map(|s| s.accounts.as_slice());
    let (accounts, skipped) = normalize_accounts_for_target(original_accounts.unwrap_or(&[]));
    let active_index = remap_active_index(
        original_accounts,
        storage.map(|s| s.active_index),
        &accounts,
    );
    let active_index_by_family = normalize_active_index_by_family(
        storage.and_then(|s| s.active_index_by_family.as_ref()),
        original_accounts,
        &accounts,
    );
    NormalizedForTarget {
        storage: AccountStorageV3 {
            version: Version3::default(),
            accounts,
            active_index,
            active_index_by_family,
            pinned_account_index: None,
            affinity_generation: None,
        },
        skipped,
    }
}

/// TS `cloneStorage(storage)`.
fn clone_storage(storage: &AccountStorageV3) -> AccountStorageV3 {
    AccountStorageV3 {
        version: Version3::default(),
        accounts: storage.accounts.clone(),
        active_index: storage.active_index,
        active_index_by_family: storage.active_index_by_family.clone(),
        pinned_account_index: None,
        affinity_generation: None,
    }
}

/// TS `matchDestination(source, destination, usedIndexes)` — ordered rules:
/// (a) exact accountId+email composite identity; (b) unique bare accountId
/// (bails on multiple matches; email conflict rejects); (c) email against
/// id-less destination rows only; (d) refreshToken against rows with neither
/// id nor email.
fn match_destination(
    source: &AccountMetadataV3,
    destination: &[AccountMetadataV3],
    used_indexes: &HashSet<usize>,
) -> Option<(usize, MatchStrategy)> {
    let source_account_id = source
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let source_email = normalize_email_key(source.email.as_deref());

    if source_account_id.is_some() && source_email.is_some() {
        let source_identity_key = get_account_identity_key(source);
        for (i, account) in destination.iter().enumerate() {
            if used_indexes.contains(&i) {
                continue;
            }
            if get_account_identity_key(account) == source_identity_key {
                return Some((i, MatchStrategy::AccountId));
            }
        }
    }

    if let Some(source_id) = source_account_id {
        let mut idx: Option<usize> = None;
        let mut matched_email: Option<String> = None;
        for (i, account) in destination.iter().enumerate() {
            if used_indexes.contains(&i) {
                continue;
            }
            if account.account_id.as_deref().map(str::trim) != Some(source_id) {
                continue;
            }
            if idx.is_some() {
                idx = None;
                break;
            }
            idx = Some(i);
            matched_email = normalize_email_key(account.email.as_deref());
        }
        if let Some(i) = idx
            && (source_email.is_none()
                || matched_email.is_none()
                || matched_email == source_email)
        {
            return Some((i, MatchStrategy::AccountId));
        }
    }

    if let Some(source_email) = &source_email {
        for (i, account) in destination.iter().enumerate() {
            if used_indexes.contains(&i) {
                continue;
            }
            if account.account_id.is_some() {
                continue;
            }
            if normalize_email_key(account.email.as_deref()).as_ref() == Some(source_email) {
                return Some((i, MatchStrategy::Email));
            }
        }
    }

    for (i, account) in destination.iter().enumerate() {
        if used_indexes.contains(&i) {
            continue;
        }
        if account.account_id.is_some() {
            continue;
        }
        if normalize_email_key(account.email.as_deref()).is_some() {
            continue;
        }
        if account.refresh_token == source.refresh_token {
            return Some((i, MatchStrategy::RefreshToken));
        }
    }

    None
}

/// TS `buildOcChatgptImportPayload(source)`.
///
/// WARNING: the payload includes raw `refreshToken` values — redact before
/// logging.
pub fn build_oc_chatgpt_import_payload(
    source: Option<&AccountStorageV3>,
) -> OcChatgptImportPayload {
    normalize_storage_for_target(source).storage
}

/// TS `previewOcChatgptImportMerge({source, destination})`.
pub fn preview_oc_chatgpt_import_merge(
    source: Option<&AccountStorageV3>,
    destination: Option<&AccountStorageV3>,
) -> OcChatgptMergePreview {
    let source_normalized = normalize_storage_for_target(source);
    let destination_normalized = normalize_storage_for_target(destination);

    let mut merged = clone_storage(&destination_normalized.storage);
    // Match targets are a snapshot limited to the original destination length
    // so newly appended source accounts are never match targets.
    let destination_accounts: Vec<AccountMetadataV3> = merged
        .accounts
        .iter()
        .take(destination_normalized.storage.accounts.len())
        .cloned()
        .collect();
    let mut used_destination_indexes: HashSet<usize> = HashSet::new();

    let mut to_add: Vec<OcChatgptAccountRef> = Vec::new();
    let mut to_update: Vec<OcChatgptUpdateEntry> = Vec::new();
    let mut to_skip: Vec<OcChatgptSkipEntry> = source_normalized.skipped.clone();
    to_skip.extend(destination_normalized.skipped.iter().map(|entry| {
        OcChatgptSkipEntry {
            source: entry.source.clone(),
            reason: format!("destination-{}", entry.reason),
        }
    }));

    for account in &source_normalized.storage.accounts {
        let Some((index, matched_by)) =
            match_destination(account, &destination_accounts, &used_destination_indexes)
        else {
            merged.accounts.push(account.clone());
            to_add.push(summarize_account(account));
            continue;
        };

        let current = merged.accounts[index].clone();
        used_destination_indexes.insert(index);
        if !candidate_is_newest(&current, account) {
            to_skip.push(OcChatgptSkipEntry {
                source: summarize_account(account),
                reason: "unchanged-or-older-than-destination".to_string(),
            });
            continue;
        }

        merged.accounts[index] = account.clone();
        to_update.push(OcChatgptUpdateEntry {
            previous: summarize_account(&current),
            next: summarize_account(account),
            matched_by,
        });
    }

    let destination_length = destination_normalized.storage.accounts.len();
    let mut unchanged_destination_only: Vec<OcChatgptAccountRef> = Vec::new();
    for (i, account) in destination_normalized
        .storage
        .accounts
        .iter()
        .enumerate()
        .take(destination_length)
    {
        if used_destination_indexes.contains(&i) {
            continue;
        }
        unchanged_destination_only.push(summarize_account(account));
    }

    OcChatgptMergePreview {
        payload: build_preview_payload(&source_normalized.storage),
        merged,
        to_add,
        to_update,
        to_skip,
        unchanged_destination_only,
        active_selection_behavior: "preserve-destination",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from test/oc-chatgpt-import-adapter.test.ts.

    fn account(
        account_id: Option<&str>,
        email: Option<&str>,
        refresh_token: &str,
        added_at: i64,
        last_used: i64,
    ) -> AccountMetadataV3 {
        let mut a = AccountMetadataV3::new(refresh_token, added_at, last_used);
        a.account_id = account_id.map(str::to_string);
        a.email = email.map(str::to_string);
        a
    }

    fn storage(accounts: Vec<AccountMetadataV3>, active_index: i64) -> AccountStorageV3 {
        let mut s = AccountStorageV3::empty();
        s.accounts = accounts;
        s.active_index = active_index;
        s
    }

    fn ref_of(
        account_id: Option<&str>,
        email: Option<&str>,
        last4: &str,
    ) -> OcChatgptAccountRef {
        OcChatgptAccountRef {
            account_id: account_id.map(str::to_string),
            email: email.map(str::to_string),
            refresh_token_last4: last4.to_string(),
        }
    }

    #[test]
    fn builds_payload_filtering_invalid_and_preserving_identity_rich_duplicates() {
        let source = storage(
            vec![
                account(Some("acc-1"), Some("same@example.com"), "token-new", 5, 5),
                account(Some("acc-1"), Some("same@example.com"), "token-old", 3, 3),
                account(Some("acc-2"), Some("same@example.com"), "token-two", 4, 4),
                account(None, Some("legacy@example.com"), "token-legacy-new", 2, 9),
                account(None, Some("legacy@example.com"), "token-legacy-old", 1, 1),
                account(None, Some("no-token@example.com"), "   ", 1, 1),
            ],
            0,
        );

        let payload = build_oc_chatgpt_import_payload(Some(&source));
        assert_eq!(payload.accounts.len(), 3);
        let acc1 = payload
            .accounts
            .iter()
            .find(|a| a.account_id.as_deref() == Some("acc-1"))
            .expect("acc-1 kept");
        assert_eq!(acc1.refresh_token, "token-new");
        assert!(
            payload
                .accounts
                .iter()
                .any(|a| a.account_id.as_deref() == Some("acc-2"))
        );
        let legacy = payload
            .accounts
            .iter()
            .find(|a| a.email.as_deref() == Some("legacy@example.com"))
            .expect("legacy kept");
        assert_eq!(legacy.refresh_token, "token-legacy-new");
    }

    #[test]
    fn previews_merge_with_account_id_precedence_and_preserves_destination_selection() {
        let mut destination = storage(
            vec![
                account(Some("acc-1"), Some("same@example.com"), "token-old", 1, 1),
                {
                    let mut a =
                        account(Some("acc-2"), Some("same@example.com"), "token-two", 2, 2);
                    a.account_label = Some("Destination only".to_string());
                    a
                },
                account(None, Some("legacy-only@example.com"), "legacy-old", 1, 1),
            ],
            1,
        );
        destination.active_index_by_family = Some(ActiveIndexByFamily {
            codex: Some(1),
            ..Default::default()
        });

        let source = storage(
            vec![
                account(Some("acc-1"), Some("same@example.com"), "token-new", 3, 5),
                account(Some("acc-3"), Some("same@example.com"), "token-three", 4, 4),
                account(None, Some("legacy-only@example.com"), "legacy-new", 2, 6),
            ],
            0,
        );

        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&destination));
        assert_eq!(preview.active_selection_behavior, "preserve-destination");
        assert_eq!(
            preview.payload.accounts,
            vec![
                ref_of(Some("acc-1"), Some("same@example.com"), "-new"),
                ref_of(Some("acc-3"), Some("same@example.com"), "hree"),
                ref_of(None, Some("legacy-only@example.com"), "-new"),
            ]
        );
        assert_eq!(preview.to_add.len(), 1);
        assert_eq!(preview.to_update.len(), 2);
        assert_eq!(preview.to_skip.len(), 0);
        assert_eq!(preview.unchanged_destination_only.len(), 1);
        assert_eq!(preview.merged.accounts.len(), 4);
        assert_eq!(preview.merged.active_index, destination.active_index);
        assert_eq!(
            preview
                .merged
                .active_index_by_family
                .as_ref()
                .and_then(|f| f.codex),
            Some(1)
        );

        let updated_acc1 = preview
            .merged
            .accounts
            .iter()
            .find(|a| a.account_id.as_deref() == Some("acc-1"))
            .expect("acc-1 updated");
        assert_eq!(updated_acc1.refresh_token, "token-new");

        assert!(
            preview
                .merged
                .accounts
                .iter()
                .any(|a| a.account_id.as_deref() == Some("acc-3"))
        );

        let updated_legacy = preview
            .merged
            .accounts
            .iter()
            .find(|a| a.email.as_deref() == Some("legacy-only@example.com"))
            .expect("legacy updated");
        assert_eq!(updated_legacy.refresh_token, "legacy-new");

        let preserved = preview
            .merged
            .accounts
            .iter()
            .find(|a| a.account_id.as_deref() == Some("acc-2"))
            .expect("destination-only preserved");
        assert_eq!(preserved, &destination.accounts[1]);

        assert_eq!(
            preview.to_update,
            vec![
                OcChatgptUpdateEntry {
                    previous: ref_of(Some("acc-1"), Some("same@example.com"), "-old"),
                    next: ref_of(Some("acc-1"), Some("same@example.com"), "-new"),
                    matched_by: MatchStrategy::AccountId,
                },
                OcChatgptUpdateEntry {
                    previous: ref_of(None, Some("legacy-only@example.com"), "-old"),
                    next: ref_of(None, Some("legacy-only@example.com"), "-new"),
                    matched_by: MatchStrategy::Email,
                },
            ]
        );
        assert_eq!(
            preview.to_add,
            vec![ref_of(Some("acc-3"), Some("same@example.com"), "hree")]
        );
        assert_eq!(
            preview.unchanged_destination_only,
            vec![ref_of(Some("acc-2"), Some("same@example.com"), "-two")]
        );
    }

    #[test]
    fn does_not_collapse_identity_rich_destination_when_source_only_has_email() {
        let destination = storage(
            vec![account(
                Some("acc-identity"),
                Some("dup@example.com"),
                "token-dest",
                1,
                10,
            )],
            0,
        );
        let source = storage(
            vec![account(None, Some("dup@example.com"), "token-source", 2, 3)],
            0,
        );

        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&destination));
        assert_eq!(preview.to_update.len(), 0);
        assert_eq!(preview.to_add.len(), 1);
        assert_eq!(preview.to_add[0].refresh_token_last4, "urce");
        assert_eq!(preview.merged.accounts.len(), 2);
        let preserved = preview
            .merged
            .accounts
            .iter()
            .find(|a| a.account_id.as_deref() == Some("acc-identity"))
            .expect("preserved");
        assert_eq!(preserved.refresh_token, "token-dest");
    }

    #[test]
    fn does_not_match_by_ambiguous_bare_shared_account_id() {
        let destination = storage(
            vec![
                account(
                    Some("shared-account"),
                    Some("alpha@example.com"),
                    "dest-alpha",
                    1,
                    1,
                ),
                account(
                    Some("shared-account"),
                    Some("beta@example.com"),
                    "dest-beta",
                    2,
                    2,
                ),
            ],
            1,
        );
        let source = storage(
            vec![account(Some("shared-account"), None, "source-new", 3, 3)],
            0,
        );

        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&destination));
        assert_eq!(preview.to_update.len(), 0);
        assert_eq!(
            preview.to_add,
            vec![ref_of(Some("shared-account"), None, "-new")]
        );
        assert_eq!(preview.unchanged_destination_only.len(), 2);
        assert_eq!(preview.merged.accounts.len(), 3);
        let tokens: Vec<&str> = preview
            .merged
            .accounts
            .iter()
            .map(|a| a.refresh_token.as_str())
            .collect();
        for expected in ["dest-alpha", "dest-beta", "source-new"] {
            assert!(tokens.contains(&expected));
        }
    }

    #[test]
    fn preserves_duplicate_no_email_shared_account_id_rows_and_remaps_selection() {
        let mut source = storage(
            vec![
                account(Some("shared-account"), None, "source-old", 1, 1),
                account(
                    Some("identity-account"),
                    Some("gamma@example.com"),
                    "gamma-refresh",
                    2,
                    2,
                ),
                account(Some("shared-account"), None, "source-new", 3, 3),
            ],
            0,
        );
        source.active_index_by_family = Some(ActiveIndexByFamily {
            codex: Some(0),
            ..Default::default()
        });

        let payload = build_oc_chatgpt_import_payload(Some(&source));
        let empty = storage(vec![], 0);
        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&empty));

        let tokens: Vec<&str> = payload
            .accounts
            .iter()
            .map(|a| a.refresh_token.as_str())
            .collect();
        assert_eq!(tokens, vec!["gamma-refresh", "source-old", "source-new"]);
        assert_eq!(
            payload
                .accounts
                .iter()
                .filter(|a| a.account_id.as_deref() == Some("shared-account"))
                .count(),
            2
        );
        assert_eq!(payload.active_index, 1);
        assert_eq!(
            payload.active_index_by_family.as_ref().and_then(|f| f.codex),
            Some(1)
        );
        assert_eq!(preview.payload.active_index, 1);
        assert_eq!(
            preview
                .payload
                .active_index_by_family
                .as_ref()
                .and_then(|f| f.codex),
            Some(1)
        );
    }

    #[test]
    fn does_not_match_unique_bare_account_id_when_emails_conflict() {
        let destination = storage(
            vec![account(
                Some("shared-account"),
                Some("beta@example.com"),
                "dest-beta",
                1,
                1,
            )],
            0,
        );
        let source = storage(
            vec![account(
                Some("shared-account"),
                Some("alpha@example.com"),
                "source-new",
                2,
                2,
            )],
            0,
        );

        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&destination));
        assert_eq!(preview.to_update.len(), 0);
        assert_eq!(
            preview.to_add,
            vec![ref_of(
                Some("shared-account"),
                Some("alpha@example.com"),
                "-new"
            )]
        );
        assert_eq!(preview.merged.accounts.len(), 2);
    }

    #[test]
    fn keeps_reversed_order_shared_account_imports_distinct() {
        let destination = storage(
            vec![account(
                Some("shared-account"),
                Some("alice@example.com"),
                "dest-alice",
                10,
                10,
            )],
            0,
        );
        let source = storage(
            vec![
                account(
                    Some("shared-account"),
                    Some("bob@example.com"),
                    "source-bob",
                    2,
                    2,
                ),
                account(
                    Some("shared-account"),
                    Some("alice@example.com"),
                    "source-alice-older",
                    1,
                    1,
                ),
            ],
            1,
        );

        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&destination));
        assert_eq!(preview.to_update.len(), 0);
        assert_eq!(
            preview.to_add,
            vec![ref_of(
                Some("shared-account"),
                Some("bob@example.com"),
                "-bob"
            )]
        );
        assert_eq!(preview.merged.accounts.len(), 2);
        let tokens: Vec<&str> = preview
            .merged
            .accounts
            .iter()
            .map(|a| a.refresh_token.as_str())
            .collect();
        assert!(tokens.contains(&"dest-alice"));
        assert!(tokens.contains(&"source-bob"));
    }

    #[test]
    fn keeps_newer_destination_metadata_on_older_refresh_token_fallback() {
        let destination = storage(
            vec![{
                let mut a = account(None, None, "shared-refresh-token", 10, 20);
                a.account_label = Some("Destination winner".to_string());
                a
            }],
            0,
        );
        let source = storage(
            vec![{
                let mut a = account(None, None, "shared-refresh-token", 5, 15);
                a.account_label = Some("Older source".to_string());
                a
            }],
            0,
        );

        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&destination));
        assert_eq!(preview.to_add.len(), 0);
        assert_eq!(preview.to_update.len(), 0);
        assert_eq!(
            preview.to_skip,
            vec![OcChatgptSkipEntry {
                source: ref_of(None, None, "oken"),
                reason: "unchanged-or-older-than-destination".to_string(),
            }]
        );
        assert_eq!(preview.unchanged_destination_only.len(), 0);
        assert_eq!(preview.merged.accounts, destination.accounts);
        assert_eq!(preview.merged.active_index, 0);
    }

    #[test]
    fn refresh_token_fallback_skips_destination_rows_with_richer_identity() {
        let destination = storage(
            vec![{
                let mut a = account(
                    Some("acc-existing"),
                    Some("existing@example.com"),
                    "shared-refresh-token",
                    1,
                    2,
                );
                a.account_label = Some("Destination account".to_string());
                a
            }],
            0,
        );
        let source = storage(
            vec![{
                let mut a = account(None, None, "shared-refresh-token", 3, 4);
                a.account_label = Some("Source update".to_string());
                a
            }],
            0,
        );

        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&destination));
        assert_eq!(preview.to_update.len(), 0);
        assert_eq!(preview.to_add.len(), 1);
        assert_eq!(preview.to_add[0].refresh_token_last4, "oken");
        assert_eq!(preview.merged.accounts.len(), 2);
        assert!(preview.unchanged_destination_only.contains(&ref_of(
            Some("acc-existing"),
            Some("existing@example.com"),
            "oken"
        )));
    }

    #[test]
    fn preserves_destination_metadata_on_timestamp_ties() {
        let destination = storage(
            vec![{
                let mut a =
                    account(Some("acc-tie"), Some("tie@example.com"), "dest-token", 10, 20);
                a.account_label = Some("Destination label".to_string());
                a
            }],
            0,
        );
        let source = storage(
            vec![{
                let mut a = account(
                    Some("acc-tie"),
                    Some("tie@example.com"),
                    "source-token",
                    10,
                    20,
                );
                a.account_label = Some("Source label".to_string());
                a
            }],
            0,
        );

        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&destination));
        assert_eq!(preview.to_add.len(), 0);
        assert_eq!(preview.to_update.len(), 0);
        assert_eq!(preview.merged.accounts[0].refresh_token, "dest-token");
        assert_eq!(
            preview.merged.accounts[0].account_label.as_deref(),
            Some("Destination label")
        );
    }

    #[test]
    fn records_exact_matched_by_counts_and_skip_reasons() {
        let destination = storage(
            vec![
                account(Some("acc-1"), Some("match@example.com"), "token-old", 1, 1),
                account(None, Some("dest-only@example.com"), "dest-only", 2, 2),
            ],
            0,
        );
        let source = storage(
            vec![
                account(Some("acc-1"), Some("match@example.com"), "token-new", 3, 5),
                account(None, Some("new@example.com"), "token-add", 4, 4),
                account(None, Some("bad@example.com"), "   ", 5, 5),
            ],
            0,
        );

        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&destination));
        assert_eq!(preview.to_update.len(), 1);
        assert_eq!(preview.to_update[0].matched_by, MatchStrategy::AccountId);
        assert_eq!(preview.to_add.len(), 1);
        assert_eq!(preview.to_skip.len(), 1);
        assert_eq!(preview.to_skip[0].reason, "invalid-refresh-token");
        assert_eq!(preview.unchanged_destination_only.len(), 1);
        assert_eq!(preview.active_selection_behavior, "preserve-destination");
    }

    #[test]
    fn surfaces_invalid_destination_accounts_in_to_skip() {
        let destination = storage(
            vec![account(None, Some("broken@example.com"), "   ", 1, 1)],
            0,
        );
        let source = storage(vec![], 0);

        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&destination));
        assert!(preview.to_skip.contains(&OcChatgptSkipEntry {
            source: ref_of(None, Some("broken@example.com"), ""),
            reason: "destination-invalid-refresh-token".to_string(),
        }));
        assert_eq!(preview.merged.accounts.len(), 0);
        assert_eq!(preview.unchanged_destination_only.len(), 0);
    }

    #[test]
    fn matches_id_less_accounts_by_case_folded_email_but_not_plus_variants() {
        let destination = storage(
            vec![account(None, Some("user@example.com"), "dest-token", 1, 1)],
            0,
        );
        let source = storage(
            vec![
                account(None, Some("USER@EXAMPLE.COM"), "token-case-fold", 2, 3),
                account(None, Some("user+tag@example.com"), "token-plus", 4, 5),
            ],
            0,
        );

        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&destination));
        let case_folded = preview
            .to_update
            .iter()
            .find(|entry| entry.next.refresh_token_last4 == "fold")
            .expect("case-folded email matched");
        assert_eq!(case_folded.matched_by, MatchStrategy::Email);
        assert!(preview.to_add.contains(&ref_of(
            None,
            Some("user+tag@example.com"),
            "plus"
        )));
    }

    #[test]
    fn remaps_active_index_by_family_when_duplicates_collapse() {
        let mut source = storage(
            vec![
                account(Some("acc-dup"), Some("first@example.com"), "token-old", 1, 1),
                account(Some("acc-dup"), Some("first@example.com"), "token-new", 2, 2),
                account(None, Some("second@example.com"), "token-second", 3, 3),
            ],
            2,
        );
        source.active_index_by_family = Some(ActiveIndexByFamily {
            codex: Some(2),
            gpt5_1: Some(1),
            ..Default::default()
        });

        let payload = build_oc_chatgpt_import_payload(Some(&source));
        let empty = storage(vec![], 0);
        let preview = preview_oc_chatgpt_import_merge(Some(&source), Some(&empty));

        assert_eq!(payload.accounts.len(), 2);
        assert_eq!(payload.active_index, 1);
        let families = payload.active_index_by_family.as_ref().expect("families");
        assert_eq!(families.codex, Some(1));
        assert_eq!(families.gpt5_1, Some(0));
        let preview_families = preview
            .payload
            .active_index_by_family
            .as_ref()
            .expect("families");
        assert_eq!(preview_families.codex, Some(1));
        assert_eq!(preview_families.gpt5_1, Some(0));
    }

    #[test]
    fn normalizes_whitespace_only_account_labels_to_none() {
        let mut a = account(None, None, "token-label", 1, 1);
        a.account_label = Some("   ".to_string());
        let payload = build_oc_chatgpt_import_payload(Some(&storage(vec![a], 0)));
        assert_eq!(payload.accounts[0].account_label, None);
    }

    #[test]
    fn token_last4_masks_short_tokens_entirely() {
        assert_eq!(token_last4("abcd"), "****");
        assert_eq!(token_last4(" ab "), "**");
        assert_eq!(token_last4(""), "");
        assert_eq!(token_last4("refresh-token-1"), "en-1");
    }
}
