//! Port of `lib/runtime/account-state.ts` — a pure re-export shim over
//! `account-status.ts` (spec 10 §22). Kept as its own module for 1:1 file
//! parity with the TS tree.

pub use crate::account_status::{
    format_rate_limit_entry, get_rate_limit_reset_time_for_family, resolve_active_index,
};
