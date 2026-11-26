//! "Identifiers," as the project's top-level `README.md` defines them: a
//! non-empty sequence of ASCII alphanumerics, of length up to 256, which starts
//! with a letter.

/// Indicates whether the given string is an identifier.
pub fn is_identifier(s: &str) -> bool {
    let bytes = s.as_bytes();

    (1..=256).contains(&bytes.len())
        && bytes[0].is_ascii_alphabetic()
        && bytes.iter().all(u8::is_ascii_alphanumeric)
}

#[cfg(test)]
mod tests {
    use super::is_identifier;

    #[test]
    fn accepts_identifiers() {
        for s in ["a", "Z", "a1", "Florp99x", &"a".repeat(256)] {
            assert!(is_identifier(s), "{s:?}");
        }
    }

    #[test]
    fn rejects_non_identifiers() {
        for s in ["", "1", "1a", "a_b", "a b", "é", &"a".repeat(257)] {
            assert!(!is_identifier(s), "{s:?}");
        }
    }
}
