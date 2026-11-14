//! The relations a label constraint tests, over labels as data, and what
//! a template evaluates to on declared labels
//! (`plan-and-label-templates.md` §4.4, "The relations a constraint
//! tests" and "What the compiler decides"; cited as PL).
//!
//! A confidentiality label and a ceiling are lists of clauses. A clause
//! is an atom, or `{ anyOf: [...] }` with its alternatives. An integrity
//! label is a list of atoms, and a required integrity a list of
//! patterns. Every value is in the canonical form of
//! `language-subset.md` §8.5.

use serde_json::Value;

/// The name of an atom's type: the last segment of the identifier the
/// API gives it (`CFC_ATOM_TYPE` in `base/api/cfc.ts`), so an atom
/// written with the bare name is read alike.
fn type_name(atom: &Value) -> Option<&str> {
    let name = atom.get("type")?.as_str()?;
    Some(name.rsplit('/').next().unwrap_or(name))
}

fn has_exactly(atom: &Value, members: &[&str]) -> bool {
    atom.as_object().is_some_and(|record| {
        record.len() == members.len() && members.iter().all(|member| record.contains_key(*member))
    })
}

/// "An atom `a` entails an atom `b`."
pub fn atom_entails(a: &Value, b: &Value) -> bool {
    if a == b {
        return true;
    }
    let expiry = |atom: &Value| {
        (type_name(atom) == Some("Expires") && has_exactly(atom, &["type", "timestamp"]))
            .then(|| atom["timestamp"].as_f64())
            .flatten()
            .filter(|timestamp| timestamp.is_finite())
    };
    match (expiry(a), expiry(b)) {
        (Some(a), Some(b)) => a <= b,
        _ => false,
    }
}

/// The alternatives of a clause: the list of `{ anyOf }`, or the atom
/// itself.
fn alternatives(clause: &Value) -> Vec<&Value> {
    match clause.as_object() {
        Some(record) if record.len() == 1 => match record.get("anyOf").and_then(Value::as_array) {
            Some(listed) => listed.iter().collect(),
            None => vec![clause],
        },
        _ => vec![clause],
    }
}

/// "A ceiling clause subsumes a label clause."
pub fn clause_subsumes(ceiling: &Value, label: &Value) -> bool {
    let wanted = alternatives(ceiling);
    let mut had: Vec<Value> = alternatives(label).into_iter().cloned().collect();
    // A `PersonalSpace(owner)` alternative of the label also counts as
    // `User(owner)`.
    let restated: Vec<Value> = had
        .iter()
        .filter(|atom| type_name(atom) == Some("PersonalSpace") && has_exactly(atom, &["type", "owner"]))
        .filter_map(|atom| {
            let personal = atom["type"].as_str()?;
            let user = match personal.rsplit_once('/') {
                Some((prefix, _)) => format!("{prefix}/User"),
                None => "User".to_string(),
            };
            Some(serde_json::json!({ "type": user, "subject": atom["owner"] }))
        })
        .collect();
    had.extend(restated);
    !wanted.is_empty()
        && wanted
            .iter()
            .all(|wanted| had.iter().any(|had| atom_entails(wanted, had)))
}

/// "A label fits a ceiling where every clause of the label is subsumed
/// by some clause of the ceiling." The first clause that is not.
pub fn misfit(label: &[Value], ceiling: &[Value]) -> Option<Value> {
    label
        .iter()
        .find(|clause| !ceiling.iter().any(|allowed| clause_subsumes(allowed, clause)))
        .cloned()
}

/// A variable of a pattern: a record with the one member `var`, a
/// string that is not empty.
fn variable(pattern: &Value) -> Option<&str> {
    let record = pattern.as_object()?;
    (record.len() == 1)
        .then(|| record.get("var")?.as_str())
        .flatten()
        .filter(|name| !name.is_empty())
}

fn matches<'v>(pattern: &'v Value, value: &'v Value, bound: &mut Vec<(&'v str, &'v Value)>) -> bool {
    if let Some(name) = variable(pattern) {
        return match bound.iter().find(|(other, _)| *other == name) {
            Some((_, had)) => *had == value,
            None => {
                bound.push((name, value));
                true
            }
        };
    }
    match (pattern, value) {
        (Value::Array(pattern), Value::Array(value)) => {
            pattern.len() == value.len()
                && pattern
                    .iter()
                    .zip(value)
                    .all(|(pattern, value)| matches(pattern, value, bound))
        }
        (Value::Object(pattern), Value::Object(value)) => pattern.iter().all(|(key, pattern)| {
            value
                .get(key)
                .is_some_and(|value| matches(pattern, value, bound))
        }),
        (Value::Array(_) | Value::Object(_), _) => false,
        _ => pattern == value,
    }
}

/// "A pattern matches an atom" by the structural match. A member the
/// pattern gives as `undefined` has no canonical form (LS §8.5), so no
/// pattern a compiler reads has one.
pub fn pattern_matches(pattern: &Value, atom: &Value) -> bool {
    matches(pattern, atom, &mut Vec::new())
}

/// "An atom satisfies a required pattern where the pattern matches it or
/// the atom entails the pattern."
pub fn atom_satisfies(atom: &Value, pattern: &Value) -> bool {
    pattern_matches(pattern, atom) || atom_entails(atom, pattern)
}

/// The atom two labels compare as one witness by: "an atom whose `scope`
/// has a `valueRef` is compared without its `scope.projection`."
fn witness(atom: &Value) -> Value {
    let mut atom = atom.clone();
    if let Some(scope) = atom.get_mut("scope").and_then(Value::as_object_mut) {
        if scope.contains_key("valueRef") {
            scope.remove("projection");
        }
    }
    atom
}

/// "Several integrity labels satisfy a required integrity coherently
/// where, for every pattern, one atom satisfies it in every one of the
/// labels." The first pattern no one atom satisfies in all of them.
pub fn coherent_failure(labels: &[Vec<Value>], patterns: &[Value]) -> Option<Value> {
    let Some((first, rest)) = labels.split_first() else {
        return None;
    };
    patterns
        .iter()
        .find(|pattern| {
            !first.iter().any(|atom| {
                atom_satisfies(atom, pattern)
                    && rest.iter().all(|label| {
                        label.iter().any(|other| witness(other) == witness(atom))
                    })
            })
        })
        .cloned()
}

/// Whether a label value holds a term bound at run time: "the
/// `CurrentPrincipal` marker, the atom of a `PolicyOf` term, and a
/// `Concept` pattern."
pub fn run_time_term(value: &Value) -> bool {
    match value {
        Value::Array(members) => members.iter().any(run_time_term),
        Value::Object(record) => {
            record.contains_key("__ctCurrentPrincipal")
                || record.contains_key("policyOf")
                || type_name(value) == Some("Concept")
                || record.values().any(run_time_term)
        }
        _ => false,
    }
}

/// Whether a clause holds an atom of the given type among its
/// alternatives.
pub fn holds_type(clause: &Value, names: &[&str]) -> bool {
    alternatives(clause)
        .iter()
        .any(|atom| type_name(atom).is_some_and(|name| names.contains(&name)))
}

/// Whether a pattern can match a `TransformedBy` atom: a variable, or a
/// record whose `type` is absent, a variable, or that type.
pub fn may_match_transformed_by(pattern: &Value) -> bool {
    if variable(pattern).is_some() {
        return true;
    }
    match pattern.as_object() {
        Some(record) => match record.get("type") {
            None => true,
            Some(ty) => variable(ty).is_some() || type_name(pattern) == Some("TransformedBy"),
        },
        None => false,
    }
}

fn union(into: &mut Vec<Value>, more: Vec<Value>) {
    for clause in more {
        if !into.contains(&clause) {
            into.push(clause);
        }
    }
}

/// The lower bound of `C(template)` on declared labels, where the
/// template is evaluated: "`const` is empty, a `slot` is its declared
/// list, a `derive` is the union of its inputs, and a `select` is the
/// union of its condition with the clauses that every branch has."
pub fn confidentiality_bound(template: &Value, slots: &[Value]) -> Option<Vec<Value>> {
    match template["op"].as_str()? {
        "const" => Some(Vec::new()),
        "slot" => slots
            .get(template["slot"].as_u64()? as usize)?
            .get("declared")?
            .get("confidentiality")?
            .as_array()
            .cloned(),
        "derive" => {
            let mut bound = Vec::new();
            for input in template["inputs"].as_array()? {
                union(&mut bound, confidentiality_bound(input, slots)?);
            }
            Some(bound)
        }
        "select" => {
            let mut bound = confidentiality_bound(&template["condition"], slots)?;
            let mut shared: Option<Vec<Value>> = None;
            for branch in template["branches"].as_array()? {
                let branch = confidentiality_bound(branch, slots)?;
                shared = Some(match shared {
                    Some(shared) => shared
                        .into_iter()
                        .filter(|clause| branch.contains(clause))
                        .collect(),
                    None => branch,
                });
            }
            union(&mut bound, shared.unwrap_or_default());
            Some(bound)
        }
        _ => None,
    }
}

/// `I(template)` on declared labels.
#[derive(Debug, Clone, PartialEq)]
pub struct Integrity {
    /// The atoms the declarations give.
    pub atoms: Vec<Value>,
    /// The label also has the `TransformedBy` atom of a `derive`, which
    /// names a code hash the compiler does not form.
    pub minted: bool,
}

/// `I(template)` from the declared lists, where the template is
/// evaluated. A template that is `const` alone is neutral and has no
/// list, so it is not evaluated.
pub fn integrity_of(template: &Value, slots: &[Value]) -> Option<Integrity> {
    match template["op"].as_str()? {
        "slot" => Some(Integrity {
            atoms: slots
                .get(template["slot"].as_u64()? as usize)?
                .get("declared")?
                .get("integrity")?
                .as_array()?
                .clone(),
            minted: false,
        }),
        "derive" => {
            let mut atoms: Option<Vec<Value>> = None;
            for input in template["inputs"].as_array()? {
                if input["op"] == "const" {
                    continue;
                }
                let input = integrity_of(input, slots)?;
                atoms = Some(match atoms {
                    Some(atoms) => atoms
                        .into_iter()
                        .filter(|atom| input.atoms.contains(atom))
                        .collect(),
                    None => input.atoms,
                });
            }
            Some(Integrity {
                atoms: atoms.unwrap_or_default(),
                minted: true,
            })
        }
        "select" => {
            let mut found: Option<Integrity> = None;
            for branch in template["branches"].as_array()? {
                let branch = integrity_of(branch, slots)?;
                match &found {
                    Some(other) if *other != branch => return None,
                    _ => found = Some(branch),
                }
            }
            found
        }
        _ => None,
    }
}
