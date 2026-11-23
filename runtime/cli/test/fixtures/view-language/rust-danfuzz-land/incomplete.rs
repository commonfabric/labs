//! "Identifiers," as the manual's data model chapter defines them: a non-empty
//! sequence of ASCII alphanumerics, of length up to [`MAX_LENGTH`], which
//! starts with a letter.

/// The most characters an identifier may have.
pub const MAX_LENGTH: usize = 100;

/// Indicates whether the given string is an identifier.
pub fn is_identifier(s: &str) -> bool {
    let bytes = s.as_bytes();

    (1..=MAX_LENGTH).contains(&bytes.len())
        && bytes[0].is_ascii_alphabetic()
        && bytes.iter().all(u8::is_ascii_alphanumeric)
}

#[cfg(test)]
mod tests {
    use super::{MAX_LENGTH, is_identifier};

    #[test]
    fn has_a_limit_of_100() {
        assert_eq!(MAX_LENGTH, 100);
    }

    #[test]
    fn accepts_identifiers() {
        for s in ["a", "Z", "a1", "Florp99x", &"a".repeat(100)] {
            assert!(is_identifier(s), "{s:?}");
        }
    }

    #[test]
    fn rejects_non_identifiers() {
        for s in [
            "",
            &"a".repeat(
