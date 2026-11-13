//! Assignability (`language-subset.md` §7.5).

use crate::program::Resolver;
use crate::types::TypeId;

impl Resolver<'_, '_> {
    /// Whether a value of type `from` is assignable to a position of type
    /// `to`. `None` where a part of either type is not evaluated.
    pub fn assignable(&self, from: TypeId, to: TypeId) -> Option<bool> {
        Some(self.fits(from, to))
    }
}
