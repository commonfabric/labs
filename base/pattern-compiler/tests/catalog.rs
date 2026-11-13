//! The catalog table of the crate agrees with the diagnostics catalog of the
//! specification.

use std::collections::BTreeSet;

use pattern_compiler::catalog::{Status, CATALOG};

const SPECIFICATION: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/specs/compiled-pattern-language/language-subset.md"
);
const COPY: &str = include_str!("../catalog-ids.txt");

/// The identifier and severity of each entry of a catalog table row: every
/// identifier in the row's first cell, with the row's second cell.
fn entries_of_document(text: &str) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    let mut in_catalog = false;
    for line in text.lines() {
        if line.starts_with("## ") {
            in_catalog = line.starts_with("## 10. ");
        }
        if !in_catalog || !line.starts_with("| `") {
            continue;
        }
        let cells: Vec<&str> = line.trim_matches('|').split(" | ").collect();
        let severity = match cells[1].trim() {
            "—" => "retired",
            other => other,
        };
        for (index, piece) in cells[0].split('`').enumerate() {
            if index % 2 == 1 {
                entries.push((piece.to_string(), severity.to_string()));
            }
        }
    }
    entries
}

fn entries_of_copy() -> Vec<(String, String)> {
    COPY.lines()
        .filter(|line| !line.starts_with('#') && !line.is_empty())
        .map(|line| {
            let (id, severity) = line.split_once(' ').expect("an identifier and a severity");
            (id.to_string(), severity.to_string())
        })
        .collect()
}

fn entries_of_table() -> Vec<(String, String)> {
    CATALOG
        .iter()
        .map(|entry| {
            let severity = entry
                .severity
                .map_or("retired", |severity| severity.as_str());
            (entry.id.to_string(), severity.to_string())
        })
        .collect()
}

#[test]
fn copy_holds_the_identifiers_of_the_specification() {
    let text = std::fs::read_to_string(SPECIFICATION).expect("the specification is readable");
    assert_eq!(entries_of_copy(), entries_of_document(&text));
}

#[test]
fn table_holds_the_identifiers_of_the_copy() {
    assert_eq!(entries_of_table(), entries_of_copy());
}

#[test]
fn table_names_each_identifier_once() {
    let ids: BTreeSet<&str> = CATALOG.iter().map(|entry| entry.id).collect();
    assert_eq!(ids.len(), CATALOG.len());
}

#[test]
fn table_marks_exactly_the_entries_without_severity_as_retired() {
    for entry in CATALOG {
        assert_eq!(
            entry.severity.is_none(),
            entry.status == Status::Retired,
            "{}",
            entry.id
        );
    }
}

#[test]
fn provisional_identifiers_are_not_yet_in_the_specification() {
    let text = std::fs::read_to_string(SPECIFICATION).expect("the specification is readable");
    let known: Vec<String> = entries_of_document(&text)
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    for entry in pattern_compiler::catalog::PROVISIONAL {
        assert!(
            !known.iter().any(|id| id == entry.id),
            "{} is in the specification now; move it into the catalog table",
            entry.id
        );
    }
}
