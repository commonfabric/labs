//! The diagnostics catalog of `language-subset.md` §10, and what this front
//! end does with each entry.
//!
//! `catalog-ids.txt` in the crate root is a copy of the catalog's identifiers
//! and severities extracted from the document. `tests/catalog.rs` fails when
//! the document, the copy, and [`CATALOG`] disagree.

use crate::diagnostics::Severity;

/// What the front end does with one catalog entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// The front end reports the entry. `rest` names the part of the entry's
    /// condition that syntax and name resolution cannot decide, which is left
    /// to the type checker.
    Implemented { rest: Option<&'static str> },
    /// The condition needs a fact only the type checker has. The text names
    /// the fact.
    NeedsTypes(&'static str),
    /// The condition needs the footprint of a body, or the plan built from
    /// footprints. The text names what is needed.
    NeedsFootprint(&'static str),
    /// The entry is not decided when a module is compiled.
    NotCompileTime(&'static str),
    /// The catalog lists the identifier as no longer reported.
    Retired,
}

impl Status {
    /// The name of the status as the `catalog` command prints it.
    pub fn label(self) -> &'static str {
        match self {
            Status::Implemented { rest: None } => "implemented",
            Status::Implemented { rest: Some(_) } => "implemented in part",
            Status::NeedsTypes(_) => "needs the type checker",
            Status::NeedsFootprint(_) => "needs footprint analysis",
            Status::NotCompileTime(_) => "not a compile-time rule",
            Status::Retired => "retired",
        }
    }

    /// The explanation printed beside the label, if the status has one.
    pub fn detail(self) -> Option<&'static str> {
        match self {
            Status::Implemented { rest } => rest,
            Status::NeedsTypes(text)
            | Status::NeedsFootprint(text)
            | Status::NotCompileTime(text) => Some(text),
            Status::Retired => None,
        }
    }
}

/// One entry of the catalog.
#[derive(Debug, Clone, Copy)]
pub struct Entry {
    pub id: &'static str,
    /// `None` for a retired identifier, which has no severity.
    pub severity: Option<Severity>,
    pub status: Status,
}

const fn done(id: &'static str, severity: Severity) -> Entry {
    Entry {
        id,
        severity: Some(severity),
        status: Status::Implemented { rest: None },
    }
}

const fn part(id: &'static str, severity: Severity, rest: &'static str) -> Entry {
    Entry {
        id,
        severity: Some(severity),
        status: Status::Implemented { rest: Some(rest) },
    }
}

const fn footprint(id: &'static str, severity: Severity, need: &'static str) -> Entry {
    Entry {
        id,
        severity: Some(severity),
        status: Status::NeedsFootprint(need),
    }
}

const fn retired(id: &'static str) -> Entry {
    Entry {
        id,
        severity: None,
        status: Status::Retired,
    }
}

use Severity::{Error, Hint, Warning};

const LABEL_TEMPLATES: &str =
    "the label templates of the plan, which are built from footprints and declared labels";
const PROMOTION_REST: &str = "decided by syntax and by method names, as the measurement of \
     `language-subset.md` §11.5 is; whether a method is the pure one of its name needs \
     the receiver's type";
const HANDLE_REST: &str = "reported when an annotation or a cell constructor declares the \
     receiver as a cell handle; any other receiver needs its type";

/// Every entry of the catalog, in the order of the document.
pub const CATALOG: &[Entry] = &[
    // §10.1 Module scope
    done("module-scope:let-declaration", Error),
    done("module-scope:var-declaration", Error),
    done("module-scope:class-declaration", Error),
    done("module-scope:statement", Error),
    part(
        "module-scope:frozen-data-type",
        Error,
        "reported for a function written in the literal structure of the initializer; \
         any other initializer needs its type",
    ),
    part(
        "module-scope:frozen-data-write",
        Error,
        "reported for an assignment, `delete`, `++`, or `--` through the binding, and \
         for a mutating method on a constant whose initializer is an array literal, \
         `new Map`, or `new Set`; a write through an alias or through any other \
         constant needs the read-only type",
    ),
    part(
        "module-scope:stateful-regexp",
        Error,
        "reported for a literal and for `new RegExp` with literal flags; flags that \
         are computed need their literal type",
    ),
    done("module-scope:import-form", Error),
    part(
        "module-scope:runtime-call",
        Error,
        "reported for a call the callee's name decides; a call of a factory value \
         needs the callee's type",
    ),
    done("builder-callback:indirect-reference", Error),
    part(
        "cell-factory:empty-array",
        Error,
        "reported when no type argument is written; whether an expected type \
         supplies the element type needs the checker",
    ),
    // §10.2 Reactive tier
    done("pattern-context:let-declaration", Error),
    done("pattern-context:var-declaration", Error),
    done("pattern-context:assignment", Error),
    done("pattern-context:loop", Error),
    done("pattern-context:early-return", Error),
    done("pattern-context:missing-return", Error),
    done("pattern-context:control-flow", Error),
    done("pattern-context:statement", Error),
    done("pattern-context:function-creation", Error),
    done("pattern-context:object-member", Error),
    done("pattern-context:parameter-form", Error),
    done("pattern-context:builder-placement", Error),
    done("pattern-context:callback-container", Error),
    part(
        "reactive:unsupported-call",
        Error,
        "reported when the callee is decided by name resolution or by a method name \
         no legal receiver has; a method call with one argument that could be the \
         argument of a factory value needs the receiver's type",
    ),
    done("reactive:unsupported-expression", Error),
    part(
        "opaque-get:invalid-call",
        Error,
        "reported where the receiver's type comes from a declaration; a receiver whose type needs expression inference is not decided",
    ),
    done("pattern-context:self-access", Error),
    part(
        "ses-callback:callable-capture",
        Error,
        "reported for a captured binding that is declared as a function; a captured \
         binding whose type is a function type needs the checker",
    ),
    done("removed-form:helper", Warning),
    done("removed-form:helper-unsupported", Error),
    done("removed-form:pattern-tool", Error),
    done("removed-form:builtin", Error),
    done("collection:callback-parameters", Error),
    done("collection:reduce-callback", Error),
    done("collection:reduce-initial", Error),
    part(
        "collection:reduce-accumulator",
        Error,
        "reported where the initial value has a standard-library object type or a \
         function type; an accumulator whose code type shows only in the step's \
         expression is not decided",
    ),
    done("collection:index-keyed", Hint),
    part("cell:unsupported-method", Error, HANDLE_REST),
    part("cell:collection-method-in-function", Error, HANDLE_REST),
    done("cell:cause-not-literal", Error),
    part(
        "cell:method-tier",
        Error,
        "reported when an annotation or a cell constructor declares the receiver as a \
         cell handle, for `.for(cause)` on an instantiation, and for `sqliteDatabase` \
         in a function body; any other receiver needs its type",
    ),
    part(
        "sqlite:tables-not-static",
        Error,
        "reported when the `tables` option is not an object literal with static keys \
         whose values are calls or names; whether each is a `table(...)` call with \
         constant arguments, and what a row-label rule refers to, is not followed",
    ),
    part(
        "collection:nested-scan",
        Warning,
        "reported for a scan of a captured binding of an enclosing reactive body; \
         whether the binding has an array type needs the checker",
    ),
    retired("pattern-context:get-call"),
    retired("pattern-context:optional-chaining"),
    retired("pattern-context:computation"),
    retired("compute-context:local-reactive-use"),
    retired("standalone-function:reactive-operation"),
    // §10.3 Function tier
    done("function-body:async", Error),
    done("function-body:generator", Error),
    done("function-body:class", Error),
    done("function-body:this", Error),
    done("function-body:var", Error),
    done("function-body:for-in", Error),
    done("function-body:dynamic-code", Error),
    done("function-body:accessor", Error),
    done("function-body:unsupported-global", Error),
    done("function-body:global-write", Error),
    done("function-body:constructor", Error),
    done("function-body:ambient-read", Error),
    done("function-body:builder-call", Error),
    done("function-body:handler-capture", Error),
    part(
        "function-body:cell-needs-cause",
        Error,
        "reported for a cell constructor called in the body or in an authored \
         function it calls by name; a call through a function value needs the \
         call's resolved target",
    ),
    part(
        "function-body:effect-in-computation",
        Error,
        "reported for the effectful built-ins called by their imported names; \
         `query` on a SQLite handle needs the receiver's type",
    ),
    done("function-body:event-context-in-computation", Error),
    part(
        "collection:shared-element-state",
        Error,
        "reported when the collection is plain by its syntax: a module-scope \
         constant, an array literal, or the result of `Object.keys`, \
         `Object.entries`, or `split`; any other collection needs its element type",
    ),
    done("function-body:instantiation-without-cause", Warning),
    done("verb-result:undeclared-return", Error),
    part(
        "mergeable-push:read-then-push",
        Warning,
        "reported where a handler pushes onto a cell it read through `get()` or `sample()` \
         earlier in the source; whether the pushed value depends on the read is not decided",
    ),
    part(
        "footprint:widened",
        Hint,
        "reported for the causes W1 to W6 at the site in the body's own text, and not for W7 \
         or for a widening inside a helper; the message names the cause and not the widened \
         entries",
    ),
    part(
        "footprint:dynamic-read",
        Hint,
        "a read that is dynamic only because the body is used with the handle bound to a \
         computed value is not reported",
    ),
    part(
        "footprint:materializer",
        Hint,
        "reported at each write whose target is not static and at each cell created under a \
         cause computed from data, in the body's own text",
    ),
    part(
        "side-write:not-idempotent",
        Warning,
        "a read of its own target is found by the paths of the body's text; two handles that \
         link to one cell are not seen",
    ),
    part(
        "side-write:cycle",
        Warning,
        "found over the edges of the plan the first slice of plan emission lists: a write \
         through a handle from a computed input has no edge, and a cycle through a pattern \
         called in the reactive tier is not seen",
    ),
    part("computed:not-promoted", Hint, PROMOTION_REST),
    part("computed:redundant", Hint, PROMOTION_REST),
    retired("function-body:instantiation-in-computation"),
    // §10.4 Types
    done("subset-type:conditional", Error),
    done("subset-type:mapped", Error),
    done("subset-type:template-literal", Error),
    done("subset-type:overload", Error),
    done("subset-type:class", Error),
    done("subset-type:callable-object", Error),
    done("subset-type:assertion-signature", Error),
    part(
        "subset-type:unsupported-modifier",
        Error,
        "reported for variance annotations and `const` type parameters; `satisfies` \
         on a type parameter is not a form the parser produces",
    ),
    part(
        "subset-type:index-signature-key",
        Error,
        "reported for an index signature; `Record<K, T>` needs the evaluated key type",
    ),
    done("subset-type:tuple-rest", Error),
    done("subset-syntax:enum", Error),
    done("subset-syntax:namespace", Error),
    done("subset-syntax:ambient-declaration", Error),
    done("subset-syntax:decorator", Error),
    done("subset-type:function-in-data", Error),
    part(
        "subset-type:non-regular-recursion",
        Error,
        "reported for a declaration that refers to itself directly; recursion \
         through other declarations needs alias instantiation",
    ),
    part(
        "subset-type:empty-intersection",
        Error,
        "reported for primitive, literal, and object operands; an intersection with a handle, a function, or an opaque API type is not evaluated",
    ),
    done("subset-type:operator-operand", Error),
    part(
        "subset-type:cannot-infer-type-argument",
        Error,
        "reported for a call of an authored generic function when no parameter that is \
         given an argument names the type parameter; a type parameter that an argument \
         names in a form the crate does not unify is counted and not reported",
    ),
    done("subset-type:any", Error),
    part(
        "subset-type:mismatch",
        Error,
        "reported for an argument, a returned value under a written return type, and an \
         initializer under an annotation that is not assignable, and for a wrong argument \
         count; a value whose type is not evaluated is not decided",
    ),
    part(
        "cast-validation:double-unknown",
        Error,
        "reported when neither type is assignable to the other; a cast whose operand or \
         target type is not evaluated is counted and not reported",
    ),
    part(
        "cast-validation:forbidden-cast",
        Error,
        "reported when the target is written as `Reactive<T>`; a target reached \
         through an alias needs the evaluated type",
    ),
    part(
        "cast-validation:cell-cast",
        Error,
        "reported when the target is written as a cell type; a target reached \
         through an alias needs the evaluated type",
    ),
    part(
        "schema:unknown-type-access",
        Error,
        "reported for a property read with a static name inside a function; a receiver \
         with no type is counted and not reported",
    ),
    part(
        "schema:path-not-in-type",
        Error,
        "reported for a property read with a static name on a closed object type, or on a \
         union of them none of which declares the property; a receiver with no type is \
         counted and not reported",
    ),
    part(
        "pattern:any-result-schema",
        Error,
        "reported for a declared result, and for an inferred one where the callback's \
         result has a type; a result with no type is counted and not reported",
    ),
    part(
        "pattern-result:unknown-type",
        Error,
        "reported where the callback's result has a type; a result with no type is \
         counted and not reported",
    ),
    done("pattern-result:opaque-reserved-key", Error),
    part(
        "reactive-capture:unknown-type",
        Error,
        "reported where a declaration gives the captured binding the type `unknown`; a \
         binding with no type is not reported",
    ),
    done("schema-type:symbol", Error),
    retired("schema-type:unread"),
    part(
        "stdlib:unsupported-member",
        Error,
        "reported for a global and for a member of a standard-library namespace; a \
         method or property of a value needs the receiver's type",
    ),
    part(
        "import:signature-not-in-subset",
        Error,
        "reported for a missing annotation and for a refused type form written in \
         the signature; a refused form reached through an alias needs the evaluated type",
    ),
    done("import:not-a-function", Error),
    part(
        "import:signature-not-data",
        Error,
        "reported for a cell type or a function type written in the signature; one \
         reached through an alias needs the evaluated type",
    ),
    done("import:commonfabric-value", Error),
    // §10.5 Labels, defaults, and scopes
    done("cfc-label:not-a-list", Error),
    done("cfc-label:not-static", Error),
    part(
        "cfc-label:conflict",
        Error,
        "reported for two annotations written around one type node; two annotations \
         that meet on a property through an intersection are not compared",
    ),
    part(
        "cfc-label:cast-ignored",
        Warning,
        "reported where the operand has a type; annotations are compared at the root \
         and at the properties of an object type, three levels deep",
    ),
    part(
        "cfc-write-authorized-by",
        Error,
        "reported for `WriteAuthorizedBy` and the two trusted-action write aliases; a \
         binding written through an alias or a type parameter is accepted",
    ),
    part(
        "cfc-policy-of",
        Error,
        "reported for a `PolicyOf` atom of a label list; a binding imported from a \
         module the program does not hold, a `cf:` specifier included, is not decided",
    ),
    part(
        "cfc-policy-authoring",
        Error,
        "reported for `exchangeRule` or `exchangeRules` called outside the initializer \
         of an exported module-scope constant, the one condition the document states \
         (§4.4.4); the contract's conditions on the rule declaration itself are not in \
         the document and are not checked",
    ),
    retired("cfc-write-authorized-by:unread"),
    retired("cfc-label:unread"),
    retired("cfc-schema:recursion-limit"),
    retired("cfc-schema:recursive-alias-of-any"),
    footprint("cfc-flow:max-confidentiality", Error, LABEL_TEMPLATES),
    footprint("cfc-flow:required-integrity", Error, LABEL_TEMPLATES),
    part(
        "cfc-flow:write-policy",
        Error,
        "decided for `WriteAuthorizedBy` on a path a body writes through a handle of a slot \
         whose root has a declared type; the policies of `WritePolicyAnyOf` and of the \
         trusted-action aliases are not read, and a write that is in another module than \
         the pattern is reported at the start of the module",
    ),
    footprint("cfc-flow:write-floor", Error, LABEL_TEMPLATES),
    footprint("cfc-flow:writer-fit", Error, LABEL_TEMPLATES),
    footprint("cfc-flow:ui-contract", Warning, LABEL_TEMPLATES),
    part(
        "default:not-static",
        Error,
        "reported for a value that is not literal-like; whether the value is assignable to the type is not checked",
    ),
    done("scope:union-member", Error),
];

/// Entries the front end reports under an identifier the specification has
/// not named yet. `tests/catalog.rs` fails once the specification has one of
/// these, so that it moves into [`CATALOG`].
pub const PROVISIONAL: &[Entry] = &[];

/// The entry for `id`, if the catalog has one.
pub fn entry(id: &str) -> Option<&'static Entry> {
    CATALOG
        .iter()
        .chain(PROVISIONAL)
        .find(|entry| entry.id == id)
}

/// The severity of `id` when the front end implements it, and `None` for any
/// other identifier.
pub fn implemented_severity(id: &str) -> Option<Severity> {
    let entry = entry(id)?;
    match entry.status {
        Status::Implemented { .. } => entry.severity,
        _ => None,
    }
}

/// The status labels, in the order the `catalog` command prints their counts.
pub const STATUS_LABELS: [&str; 6] = [
    "implemented",
    "implemented in part",
    "needs the type checker",
    "needs footprint analysis",
    "not a compile-time rule",
    "retired",
];

/// The number of entries with each status label, in the order of
/// [`STATUS_LABELS`].
pub fn status_counts() -> Vec<(&'static str, usize)> {
    STATUS_LABELS
        .iter()
        .map(|label| {
            let count = CATALOG
                .iter()
                .filter(|entry| entry.status.label() == *label)
                .count();
            (*label, count)
        })
        .collect()
}

/// The catalog as the `catalog` command prints it: one line per entry, then
/// the number of entries with each status.
pub fn render() -> String {
    let mut out = String::new();
    let width = CATALOG
        .iter()
        .map(|entry| entry.id.len())
        .max()
        .unwrap_or(0);
    for entry in CATALOG {
        let severity = entry.severity.map_or("-", Severity::as_str);
        out.push_str(&format!(
            "{:width$}  {:7}  {}",
            entry.id,
            severity,
            entry.status.label()
        ));
        if let Some(detail) = entry.status.detail() {
            let detail = detail.split_whitespace().collect::<Vec<_>>().join(" ");
            out.push_str(&format!(": {detail}"));
        }
        out.push('\n');
    }
    out.push('\n');
    for (label, count) in status_counts() {
        out.push_str(&format!("{count:4}  {label}\n"));
    }
    out.push_str(&format!("{:4}  entries\n", CATALOG.len()));
    for entry in PROVISIONAL {
        out.push_str(&format!(
            "\nprovisional: {} ({})\n",
            entry.id,
            entry.status.label()
        ));
    }
    out
}
