//! The JSON schema of a type, and the declared label at a path of one.
//!
//! The schema follows `docs/specs/schema-generator/ts_to_json_schema_mapping.md`
//! (cited as SM) for the type forms of the subset: the primitives and
//! literals of its §4, objects, arrays and tuples, the handle wrappers of
//! §6.2, the unions of §8, a default (§7), and the `ifc` metadata of §11
//! for the label annotations of `language-subset.md` §8.1 (cited as LS).
//! It hoists no named type into `$defs`, so a type that contains itself
//! is cut at a fixed depth, and it emits no scope entry in `asCell`.
//! `SPEC-NOTES.md` lists what it leaves out.

use serde_json::{json, Map, Value};

use crate::program::Resolver;
use crate::types::{Annotation, HandleKind, Shape, TypeId};

/// The deepest nesting of types a schema follows.
const MAX_DEPTH: u32 = 12;

/// The keys of the label annotations a schema node holds under `ifc`.
const LABEL_KEYS: [&str; 6] = [
    "confidentiality",
    "integrity",
    "addIntegrity",
    "requiredIntegrity",
    "maxConfidentiality",
    "writeAuthorizedBy",
];

/// A term of the label-argument language (LS §8.5) as data, read from the
/// text the annotation keeps: a list, a literal atom, an object atom, and
/// `AnyOf<list>`. `None` where the text holds anything else: a reference
/// to an alias, a constant reference, a marker type, or a spread.
pub fn label_term(text: &str) -> Option<Value> {
    let mut parser = Term {
        text: text.as_bytes(),
        at: 0,
    };
    let value = parser.term()?;
    parser.space();
    (parser.at == parser.text.len()).then_some(value)
}

struct Term<'t> {
    text: &'t [u8],
    at: usize,
}

impl Term<'_> {
    fn space(&mut self) {
        while self.text.get(self.at).is_some_and(u8::is_ascii_whitespace) {
            self.at += 1;
        }
    }

    fn eat(&mut self, token: &str) -> bool {
        self.space();
        if self.text[self.at..].starts_with(token.as_bytes()) {
            self.at += token.len();
            true
        } else {
            false
        }
    }

    fn word(&mut self) -> &str {
        self.space();
        let start = self.at;
        while self
            .text
            .get(self.at)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$'))
        {
            self.at += 1;
        }
        std::str::from_utf8(&self.text[start..self.at]).unwrap_or("")
    }

    fn term(&mut self) -> Option<Value> {
        self.space();
        match *self.text.get(self.at)? {
            b'[' => {
                self.at += 1;
                let mut members = Vec::new();
                loop {
                    if self.eat("]") {
                        return Some(Value::Array(members));
                    }
                    members.push(self.term()?);
                    if !self.eat(",") && !self.text[self.at..].starts_with(b"]") {
                        return None;
                    }
                }
            }
            b'{' => {
                self.at += 1;
                let mut members = Map::new();
                loop {
                    if self.eat("}") {
                        return Some(Value::Object(members));
                    }
                    self.space();
                    let name = match self.text.get(self.at)? {
                        b'"' | b'\'' => self.term()?.as_str()?.to_string(),
                        _ => self.word().to_string(),
                    };
                    if name.is_empty() || !self.eat(":") {
                        return None;
                    }
                    members.insert(name, self.term()?);
                    if !self.eat(";") && !self.eat(",") {
                        self.space();
                        if !self.text[self.at..].starts_with(b"}") {
                            return None;
                        }
                    }
                }
            }
            quote @ (b'"' | b'\'') => {
                let start = self.at + 1;
                let mut end = start;
                while *self.text.get(end)? != quote {
                    if self.text[end] == b'\\' {
                        return None;
                    }
                    end += 1;
                }
                self.at = end + 1;
                Some(json!(std::str::from_utf8(&self.text[start..end]).ok()?))
            }
            byte if byte.is_ascii_digit() || byte == b'-' => {
                let start = self.at;
                self.at += 1;
                while self
                    .text
                    .get(self.at)
                    .is_some_and(|byte| byte.is_ascii_digit() || *byte == b'.')
                {
                    self.at += 1;
                }
                let text = std::str::from_utf8(&self.text[start..self.at]).ok()?;
                serde_json::from_str(text).ok()
            }
            _ => match self.word() {
                "readonly" => self.term(),
                "true" => Some(json!(true)),
                "false" => Some(json!(false)),
                "null" => Some(Value::Null),
                // "`AnyOf<X>` | when nested in an IFC label tuple, one
                // atom `{ anyOf: X }`" (SM §11).
                "AnyOf" => {
                    if !self.eat("<") {
                        return None;
                    }
                    let list = self.term()?;
                    self.eat(">").then(|| json!({ "anyOf": list }))
                }
                _ => None,
            },
        }
    }
}

/// The value an annotation holds in a schema: the term its text is, or
/// the text where it is no term this module reads.
fn annotation_value(annotation: &Annotation) -> Value {
    if annotation.key == "writeAuthorizedBy" {
        // "`WriteAuthorizedBy<T, typeof b>` | `{ writeAuthorizedBy: {
        // __ctWriterIdentityOf: { file, path: [binding] } } }`" (SM §11).
        let binding = annotation
            .argument
            .trim()
            .trim_start_matches("typeof")
            .trim();
        return json!({ "__ctWriterIdentityOf": { "path": [binding] } });
    }
    label_term(&annotation.argument)
        .unwrap_or_else(|| json!({ "$source": annotation.argument.trim() }))
}

/// The declared label of a position (`Slot.declared`): the annotations of
/// every node from the root to the position, outermost first. "`
/// confidentiality` lists join, outer first, each atom once" (LS §8.3),
/// and `integrity` is declared alike wherever it is declared, so it is
/// the first one found. A dimension whose list this module cannot read is
/// left out.
pub fn declared_label(nodes: &[Vec<Annotation>]) -> Option<Value> {
    let mut confidentiality: Option<Vec<Value>> = None;
    let mut unread = false;
    let mut integrity: Option<Value> = None;
    for annotation in nodes.iter().flatten() {
        match annotation.key {
            "confidentiality" => match label_term(&annotation.argument) {
                Some(Value::Array(atoms)) => {
                    let list = confidentiality.get_or_insert_with(Vec::new);
                    for atom in atoms {
                        if !list.contains(&atom) {
                            list.push(atom);
                        }
                    }
                }
                _ => unread = true,
            },
            "integrity" if integrity.is_none() => {
                integrity = label_term(&annotation.argument).filter(Value::is_array);
            }
            _ => {}
        }
    }
    let mut declared = Map::new();
    if let (Some(confidentiality), false) = (confidentiality, unread) {
        declared.insert("confidentiality".to_string(), json!(confidentiality));
    }
    if let Some(integrity) = integrity {
        declared.insert("integrity".to_string(), integrity);
    }
    (!declared.is_empty()).then_some(Value::Object(declared))
}

impl Resolver<'_, '_> {
    /// The JSON schema of `ty`.
    pub fn schema_of(&self, ty: TypeId) -> Value {
        self.schema_at(ty, 0)
    }

    fn schema_at(&self, ty: TypeId, depth: u32) -> Value {
        if depth > MAX_DEPTH {
            return json!({});
        }
        let next = depth + 1;
        let mut schema = match self.shape(ty) {
            Shape::String => json!({ "type": "string" }),
            Shape::Number => json!({ "type": "number" }),
            Shape::Boolean => json!({ "type": "boolean" }),
            Shape::BigInt => json!({ "type": "integer" }),
            Shape::Null => json!({ "type": "null" }),
            Shape::Undefined => json!({ "type": "undefined" }),
            Shape::Void => json!({ "asCell": ["opaque"] }),
            Shape::Never => json!(false),
            Shape::Unknown => json!({ "type": "unknown" }),
            Shape::NonPrimitive => json!({ "type": "object", "additionalProperties": true }),
            Shape::Literal(text) => literal_schema(&text),
            Shape::Object(properties, index) => {
                let mut members = Map::new();
                let mut required = Vec::new();
                for property in &properties {
                    // "Functions / callables / constructables | property
                    // skipped entirely" (SM §4).
                    if matches!(self.shape(property.ty), Shape::Function) {
                        continue;
                    }
                    members.insert(property.name.clone(), self.schema_at(property.ty, next));
                    if !property.optional {
                        required.push(json!(property.name));
                    }
                }
                let mut object = Map::new();
                object.insert("type".to_string(), json!("object"));
                object.insert("properties".to_string(), Value::Object(members));
                if !required.is_empty() {
                    object.insert("required".to_string(), Value::Array(required));
                }
                if let Some(index) = index {
                    object.insert(
                        "additionalProperties".to_string(),
                        self.schema_at(index, next),
                    );
                }
                Value::Object(object)
            }
            Shape::Array(element) => {
                json!({ "type": "array", "items": self.schema_at(element, next) })
            }
            // "Tuple | `{ type: "array", items: <merged element union> }`".
            Shape::Tuple(elements) => {
                let members = elements
                    .iter()
                    .map(|element| self.schema_at(*element, next))
                    .collect();
                json!({ "type": "array", "items": union_schema(members) })
            }
            Shape::Union(members) => union_schema(
                members
                    .iter()
                    .map(|member| self.schema_at(*member, next))
                    .collect(),
            ),
            Shape::Handle(kind, value) => {
                let brand = match kind {
                    HandleKind::Cell | HandleKind::Any => "cell",
                    HandleKind::ReadonlyCell => "readonly",
                    HandleKind::WriteonlyCell => "writeonly",
                    HandleKind::ComparableCell => "comparable",
                    HandleKind::OpaqueCell => "opaque",
                    HandleKind::Stream => "stream",
                    HandleKind::Sqlite => "sqlite",
                };
                // "Prepends one entry to a single `asCell` array on the
                // inner schema" (SM §6.2).
                let mut inner = match self.schema_at(value, next) {
                    Value::Object(inner) => inner,
                    Value::Bool(true) => Map::new(),
                    _ => {
                        let mut inner = Map::new();
                        inner.insert("not".to_string(), json!(true));
                        inner
                    }
                };
                let mut brands = vec![json!(brand)];
                if let Some(Value::Array(rest)) = inner.remove("asCell") {
                    brands.extend(rest);
                }
                inner.insert("asCell".to_string(), Value::Array(brands));
                Value::Object(inner)
            }
            // A factory is held as a cell of its result (SM §4, the
            // callable properties that are kept).
            Shape::PatternFactory(..) => json!({ "asCell": ["cell"] }),
            Shape::HandlerFactory(..) => json!({ "asCell": ["stream"] }),
            Shape::Function
            | Shape::Code(_)
            | Shape::Opaque(_)
            | Shape::Parameter(_)
            | Shape::Unresolved(_) => json!({}),
        };
        // The annotations of the node: a default (SM §7), and the label
        // annotations under `ifc` (SM §11).
        let annotations = self.annotations_of(ty);
        if let (Value::Object(schema), false) = (&mut schema, annotations.is_empty()) {
            let mut ifc = Map::new();
            for annotation in &annotations {
                if annotation.key == "default" {
                    schema.insert("default".to_string(), annotation_value(annotation));
                } else if LABEL_KEYS.contains(&annotation.key) {
                    ifc.insert(annotation.key.to_string(), annotation_value(annotation));
                }
            }
            if !ifc.is_empty() {
                schema.insert("ifc".to_string(), Value::Object(ifc));
            }
        }
        schema
    }
}

/// "String/number literal | `{ type: …, enum: [v] }` (type path)", and
/// "Boolean literal | `{ type: "boolean", enum: [true/false] }`" (SM §4).
fn literal_schema(text: &str) -> Value {
    match label_term(text) {
        Some(value @ Value::String(_)) => json!({ "type": "string", "enum": [value] }),
        Some(value @ Value::Number(_)) => json!({ "type": "number", "enum": [value] }),
        Some(value @ Value::Bool(_)) => json!({ "type": "boolean", "enum": [value] }),
        _ => json!({ "type": "string" }),
    }
}

/// The schema of a union of the members with these schemas (SM §8).
fn union_schema(members: Vec<Value>) -> Value {
    // "A `true` member short-circuits the union to `true`; `false`
    // members drop; exact-JSON duplicates drop".
    let mut kept: Vec<Value> = Vec::new();
    for member in members {
        match member {
            Value::Bool(true) => return json!(true),
            Value::Bool(false) => {}
            member if kept.contains(&member) => {}
            member => kept.push(member),
        }
    }
    if kept.is_empty() {
        return json!(false);
    }
    let literal = |member: &Value| -> Option<Value> {
        let object = member.as_object()?;
        let only = object.len() == 2 && object.contains_key("type");
        let values = object.get("enum")?.as_array()?;
        (only && values.len() == 1).then(|| values[0].clone())
    };
    let is_null = |member: &Value| *member == json!({ "type": "null" });
    // "All-literal unions → `{ enum: [...] }` with no `type` key; `null`
    // joins the enum when present ... The pair `true | false`
    // re-collapses to `{ type: "boolean" }`."
    if kept
        .iter()
        .all(|member| literal(member).is_some() || is_null(member))
        && kept.iter().any(|member| literal(member).is_some())
        && kept.len() > 1
    {
        let values: Vec<Value> = kept
            .iter()
            .map(|member| literal(member).unwrap_or(Value::Null))
            .collect();
        if values.len() == 2 && values.contains(&json!(true)) && values.contains(&json!(false)) {
            return json!({ "type": "boolean" });
        }
        return json!({ "enum": values });
    }
    // "Bare primitive types merge into sorted `type` arrays".
    let bare = |member: &Value| -> Option<String> {
        let object = member.as_object()?;
        (object.len() == 1).then(|| object.get("type")?.as_str().map(str::to_string))?
    };
    let mut types: Vec<String> = kept.iter().filter_map(bare).collect();
    let mut rest: Vec<Value> = kept
        .iter()
        .filter(|member| bare(member).is_none())
        .cloned()
        .collect();
    types.sort();
    match types.len() {
        0 => {}
        1 => rest.insert(0, json!({ "type": types[0] })),
        _ => rest.insert(0, json!({ "type": types })),
    }
    // "Singletons unwrap."
    if rest.len() == 1 {
        return rest.remove(0);
    }
    json!({ "anyOf": rest })
}
