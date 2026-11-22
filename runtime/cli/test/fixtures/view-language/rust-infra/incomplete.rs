//! Channel-bound grants, single-use challenges, release and renewal.
use crate::wire::{self, Challenge, Id, Proof, Receipt, Statement};
use anyhow::{Result, ensure};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// A principal refused at one of the context's principal limits.
#[derive(Debug)]
pub struct AtLimit(pub &'static str);
impl std::fmt::Display for AtLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for AtLimit {}

/// Per-connection capacity, from the router config. Each connection may hold
/// `spaces` sessions and `principals` active principals; `principal_history`
/// bounds the active and released principals a connection remembers until
/// their statements expire, which includes the key of every space it
/// creates, and `principals_per_challenge` the principals that may sign one
/// challenge. `watches` and `holdings` bound the connection's sessions
/// together, and `requests` the requests it has in flight and waiting.
/// `frame_slots` bounds the JSON values in one frame, in either direction.
/// A `None` quota disables its admission check, not protocol correctness.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limits {
    pub spaces: Option<usize>,
    pub principals: Option<usize>,
    pub principal_history: Option<usize>,
    pub principals_per_challenge: Option<usize>,
    pub challenges: Option<usize>,
    pub watches: Option<usize>,
}

impl Limits {
    /// Watch IDs are needed only for the two watch-count quotas.
    pub fn track_watch_ids(&self) -> bool {
        self.session_watches.is_some() || self.watches.is_some()
    }
    pub fn track_views(&self) -> bool {
        self.session_views.is_some() || self.watches.is_some()
    }
    pub fn track_holdings(&self) -> bool {
        self.session_holdings.is_some() || self.holdings.is_some()
    }
    /// Whether any of a session's watch usage is counted, and so its staged
    /// set mirrored.
    pub fn track_watch_usage(&self) -> bool {
        self.track_watch_ids() ||
