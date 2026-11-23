//! The identity of a handler that a write policy names, and the form a
//! writer policy has in a schema.
//!
//! A handler declared at a `const` of module scope is identified by the pair
//! of the content-addressed identity of its module
//! (`Resolver::module_identity`) and the path of its binding in that module,
//! the record PL §1.5 forms `Body.code` from. `Body.code` of such a handler
//! holds the pair, and a writer policy holds the same pair for the handler
//! its `typeof` names, so the commit preparation compares the two.
//!
//! In a schema a writer policy is written as the runtime stores a writer
//! claim (`ts_to_json_schema_mapping.md` §11): `{ __ctWriterIdentityOf: {
//! file, path, moduleIdentity } }`, with a UI contract beside the claim and
//! not inside it.

use serde_json::{json, Map, Value};

/// `Body.code` of a handler declared at the module-scope binding `binding`
/// of the module whose identity is `module`.
pub fn body_code(module: &str, binding: &str) -> Value {
    json!({ "module": module, "binding": [binding] })
}

/// The writer claim of a policy, as a schema holds it: the file and the
/// binding of the handler the policy names, and the identity of the module
/// that declares it. `None` for a policy that names no handler, or names one
/// without the identity of its module.
fn stored_claim(policy: &Value) -> Option<Value> {
    let body = policy.get("body")?;
    Some(json!({
        "__ctWriterIdentityOf": {
            "file": body.get("module")?.as_str()?,
            "path": [body.get("binding")?.as_str()?],
            "moduleIdentity": body.get("identity")?.as_str()?,
        }
    }))
}

/// Inserts the value of a label annotation into the `ifc` record of a
/// schema node. A writer policy is written in the stored form: under
/// `writeAuthorizedBy` the claim alone, with the UI contract of the policy
/// under `uiContract` of the node, and under `writePolicyAnyOf` one record
/// per alternative that holds the claim under `writeAuthorizedBy` and the
/// contract under `uiContract`. A value that is no policy of that form is
/// inserted as it is.
pub fn insert_label(ifc: &mut Map<String, Value>, key: &str, value: Value) {
    match (key, &value) {
        ("writeAuthorizedBy", policy) => {
            let Some(claim) = stored_claim(policy) else {
                ifc.insert(key.to_string(), value);
                return;
            };
            ifc.insert(key.to_string(), claim);
            if let Some(contract) = policy.get("uiContract") {
                ifc.entry("uiContract".to_string())
                    .or_insert_with(|| contract.clone());
            }
        }
        ("writePolicyAnyOf", Value::Array(policies)) => {
            let stored: Option<Vec<Value>> = policies
                .iter()
                .map(|policy| {
                    let mut alternative = Map::new();
                    alternative.insert("writeAuthorizedBy".to_string(), stored_claim(policy)?);
                    if let Some(contract) = policy.get("uiContract") {
                        alternative.insert("uiContract".to_string(), contract.clone());
                    }
                    Some(Value::Object(alternative))
                })
                .collect();
            ifc.insert(key.to_string(), stored.map_or(value, Value::Array));
        }
        _ => {
            ifc.insert(key.to_string(), value);
        }
    }
}
