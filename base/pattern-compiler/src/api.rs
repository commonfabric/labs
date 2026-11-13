//! The surface the language is written against: what the `commonfabric`
//! module exports, the methods of a cell handle, and the standard-library
//! members of `language-subset.md` §9.
//!
//! Every table here is keyed by a name as it is exported or declared. A
//! caller resolves a reference through its import before it looks a name up,
//! so a local binding that happens to be named `ifElse` is never classified
//! here.

/// The builders, `language-subset.md` §3.2 and §4.4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Builder {
    Pattern,
    Lift,
    Handler,
    Computed,
    Action,
    Assert,
}

impl Builder {
    pub fn name(self) -> &'static str {
        match self {
            Builder::Pattern => "pattern",
            Builder::Lift => "lift",
            Builder::Handler => "handler",
            Builder::Computed => "computed",
            Builder::Action => "action",
            Builder::Assert => "assert",
        }
    }

    /// Whether the builder defines a node at module scope (§3.2).
    pub fn is_module_scope(self) -> bool {
        matches!(self, Builder::Pattern | Builder::Lift | Builder::Handler)
    }
}

/// What a value exported by `commonfabric` is, for the rules of §4.4 and
/// §5.2. The classes follow `builtin-inventory.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ApiValue {
    Builder(Builder),
    /// `ifElse`, `when`, `unless`, and the `str` tag (§4.4.3).
    RemovedHelper,
    /// `patternTool` (§4.4.3).
    PatternTool,
    /// A removed form with no interim acceptance. The text is the
    /// replacement the diagnostic names.
    RemovedBuiltin(&'static str),
    /// An effectful built-in, class B of the inventory.
    Effect,
    /// A staged change: an effect only a handler requests.
    StagedChange,
    /// A structural built-in, class A of the inventory.
    Structural,
    /// `cellFromUrl`, which the inventory splits between structural and
    /// effectful.
    SplitBuiltin,
    /// `sqliteDatabase`, a declaration that produces a state cell.
    Declaration,
    /// `eventKey` and `currentPrincipal`: context reads that need an event.
    EventContext,
    /// The other context reads of §5.2.
    ContextRead,
    /// A cell constructor of §4.7.
    CellConstructor,
    /// A well-known key such as `UI`, `NAME`, or `SELF`.
    WellKnownKey,
    /// A function or constant the inventory lists as creating nothing and
    /// reading no frame.
    Pure,
    /// A name the transformer's output refers to and authors do not write.
    Emitted,
    /// An export this table does not classify.
    Unclassified,
}

/// The classification of the value `name` exported by `commonfabric`.
pub fn api_value(name: &str) -> ApiValue {
    use ApiValue::*;
    match name {
        "pattern" => Builder(self::Builder::Pattern),
        "lift" => Builder(self::Builder::Lift),
        "handler" => Builder(self::Builder::Handler),
        "computed" => Builder(self::Builder::Computed),
        "action" => Builder(self::Builder::Action),
        "assert" => Builder(self::Builder::Assert),
        "ifElse" | "when" | "unless" | "str" => RemovedHelper,
        "patternTool" => PatternTool,
        "llm" => {
            RemovedBuiltin("`generateText(...)`, or `generateObject(...)` for a structured result")
        }
        "streamData" => RemovedBuiltin("a built-in of the fetch family, such as `fetchJson(...)`"),
        "cell" => RemovedBuiltin("`Cell.of(value)` or `new Cell(value)`"),
        "byRef" => RemovedBuiltin("the built-in imported by name from `commonfabric`"),
        "nameInstance" => {
            RemovedBuiltin("a `const` binding of the instance, whose name the compiler records")
        }
        "fetchBinary" | "fetchText" | "fetchJson" | "fetchJsonUnchecked" | "fetchProgram"
        | "generateText" | "generateObject" | "llmDialog" | "agent" | "sqliteQuery"
        | "navigateTo" | "compileAndRun" => Effect,
        "grantSpaceAccess" | "revokeSpaceAccess" | "nameBlob" => StagedChange,
        "wish" | "anchorsOf" | "inspectConfLabel" => Structural,
        "cellFromUrl" => SplitBuiltin,
        "sqliteDatabase" => Declaration,
        "eventKey" | "currentPrincipal" => EventContext,
        "principalOf"
        | "principalsOf"
        | "writtenPrincipalOf"
        | "profileOwnerOf"
        | "resultOwnerOf"
        | "linksOf"
        | "spaceOf"
        | "spaceAccess"
        | "spaceAccessOf"
        | "spaceMembers"
        | "spaceDeleted"
        | "equals"
        | "getPatternEnvironment" => ContextRead,
        "Cell" | "Writable" | "OpaqueCell" | "Stream" | "ComparableCell" | "ReadonlyCell"
        | "WriteonlyCell" => CellConstructor,
        "TYPE" | "NAME" | "UI" | "TILE_UI" | "CHIP_UI" | "FS" | "TESTS" | "VIEWS" | "SELF" => {
            WellKnownKey
        }
        "valueEqual"
        | "schema"
        | "toSchema"
        | "getEntityId"
        | "entityRefToString"
        | "renderCellReference"
        | "isWellFormedDID"
        | "parseDID"
        | "toCompactDebugString"
        | "toIndentedDebugString"
        | "debugStr"
        | "dataFile"
        | "table"
        | "cfLink"
        | "cfSqlite"
        | "uiVariant"
        | "multiUserTest"
        | "UiAction"
        | "UiPromptSlot"
        | "UiDisclosure"
        | "AuthSchema"
        | "WebhookConfigSchema" => Pure,
        "__cf_data" | "__cfHelpers" | "tagCollectionKey" => Emitted,
        _ => Unclassified,
    }
}

/// The direct-call arity under which a removed helper is accepted for the
/// interim (§4.4.3), or `None` for a name that is not a callable helper.
pub fn removed_helper_arity(name: &str) -> Option<usize> {
    match name {
        "ifElse" => Some(3),
        "when" | "unless" => Some(2),
        _ => None,
    }
}

/// The rewrite the diagnostic for a removed helper names.
pub fn removed_helper_rewrite(name: &str) -> &'static str {
    match name {
        "ifElse" => "`c ? a : b` for `ifElse(c, a, b)`",
        "when" => "`c && v` for `when(c, v)`",
        "unless" => "`c || f` for `unless(c, f)`",
        _ => "a plain template literal for the `str` tag",
    }
}

/// The types `commonfabric` exports that denote a cell handle (§7.2).
pub fn is_cell_type(name: &str) -> bool {
    matches!(
        name,
        "Cell" | "Writable" | "ReadonlyCell" | "WriteonlyCell" | "ComparableCell" | "OpaqueCell"
    )
}

/// The types a cast may not target under `cast-validation:cell-cast`.
pub fn is_cell_cast_target(name: &str) -> bool {
    is_cell_type(name) || matches!(name, "Stream" | "CellTypeConstructor")
}

/// The API types that are their first type argument with an annotation
/// added: defaults, scopes, `Reactive`, and the label aliases of §8.1.
pub fn is_transparent_wrapper(name: &str) -> bool {
    matches!(
        name,
        "Reactive"
            | "Default"
            | "PerSpace"
            | "PerUser"
            | "PerSession"
            | "PerAny"
            | "Scoped"
            | "Confidential"
            | "Integrity"
            | "AddIntegrity"
            | "RepresentsCurrentUser"
            | "AuthoredByCurrentUser"
            | "RequiresIntegrity"
            | "MaxConfidentiality"
            | "WriteAuthorizedBy"
            | "WritePolicyAnyOf"
            | "TrustedActionWrite"
            | "TrustedActionWriteWithIntegrity"
            | "TrustedActionUiContract"
            | "ExactCopy"
            | "ProjectionPath"
            | "ProjectionOf"
            | "Cfc"
    )
}

/// The scoped constructors of §4.7: `X.perSpace`, `X.perUser`, `X.perSession`.
pub fn is_cell_scope(name: &str) -> bool {
    matches!(name, "perSpace" | "perUser" | "perSession")
}

/// The eight methods the transformer emits for a collection method with a
/// pattern argument (§4.4.3).
pub fn is_with_pattern_method(name: &str) -> bool {
    matches!(
        name,
        "mapWithPattern"
            | "filterWithPattern"
            | "flatMapWithPattern"
            | "countWithPattern"
            | "minByWithPattern"
            | "maxByWithPattern"
            | "groupByWithPattern"
            | "keyByWithPattern"
    )
}

/// The reactive collection methods whose callback takes an element and,
/// optionally, the index (§4.4.1).
pub fn is_element_method(name: &str) -> bool {
    matches!(
        name,
        "map" | "filter" | "flatMap" | "some" | "every" | "find" | "findIndex"
    )
}

/// The aggregates and collection indexes that take a selector or a predicate
/// with the grammar of a `map` callback (§4.4).
pub fn is_selector_method(name: &str) -> bool {
    matches!(
        name,
        "count" | "sum" | "min" | "max" | "minBy" | "maxBy" | "groupBy" | "keyBy"
    )
}

/// The collection methods of a cell handle (§4.7), which are legal on a
/// handle in the reactive tier only.
pub fn is_handle_collection_method(name: &str) -> bool {
    is_element_method(name) || is_selector_method(name) || name == "reduce"
}

/// The methods of the runtime's cell object that the API does not declare
/// (§4.7), and the deprecated `setSchema`.
pub fn is_undeclared_cell_method(name: &str) -> bool {
    matches!(
        name,
        "asSchema"
            | "withTx"
            | "sink"
            | "sync"
            | "pull"
            | "getRaw"
            | "setRaw"
            | "getAsLink"
            | "getAsNormalizedFullLink"
            | "setSchema"
    )
}

/// The handle methods that are legal in the reactive tier and are not
/// collection methods (§4.7), with the modifiers of a pattern factory.
fn is_reactive_handle_method(name: &str) -> bool {
    matches!(
        name,
        "get"
            | "key"
            | "elementById"
            | "resolveAsCell"
            | "equals"
            | "equalLinks"
            | "for"
            | "lookup"
            | "keys"
            | "keyEntries"
            | "query"
            | "asScope"
            | "inSpace"
    )
}

/// The handle methods of §4.7 that are legal in the function tier only.
fn is_function_handle_method(name: &str) -> bool {
    matches!(
        name,
        "sample"
            | "getArgumentCell"
            | "set"
            | "update"
            | "push"
            | "pushAll"
            | "addUnique"
            | "remove"
            | "removeByValue"
            | "removeAll"
            | "increment"
            | "applyChanges"
            | "send"
            | "exec"
    )
}

/// The methods of standard-library values that §9 marks "R". A method that
/// §9 marks "R" only for some arguments, such as `toSorted` and `replace`,
/// is listed, and the caller checks the arguments.
fn is_reactive_stdlib_method(name: &str) -> bool {
    matches!(
        name,
        // §9.1 String
        "at" | "charAt" | "charCodeAt" | "codePointAt" | "concat" | "endsWith" | "includes"
            | "indexOf" | "lastIndexOf" | "localeCompare" | "normalize" | "padEnd"
            | "padStart" | "repeat" | "slice" | "split" | "startsWith" | "substring"
            | "toLowerCase" | "toUpperCase" | "trim" | "trimEnd" | "trimStart"
            | "toString" | "match" | "replace" | "replaceAll"
            // §9.2 Array
            | "entries" | "flat" | "join" | "keys" | "toReversed" | "toSpliced"
            | "values" | "with" | "toSorted"
            // §9.4 Number
            | "toFixed" | "toPrecision" | "toLocaleString"
            // §9.6 Date
            | "getDate" | "getDay" | "getFullYear" | "getHours" | "getMinutes"
            | "getMonth" | "getSeconds" | "getTime" | "getUTCDate" | "getUTCDay"
            | "getUTCFullYear" | "getUTCHours" | "getUTCMinutes" | "getUTCMonth"
            | "getUTCSeconds" | "getUTCMilliseconds" | "toISOString"
            | "toLocaleDateString" | "toLocaleTimeString" | "valueOf"
            // §9.8 RegExp, and §9.9 ReadonlyMap and ReadonlySet
            | "test" | "has" | "get"
    )
}

/// The methods of standard-library values that §9 lists for the function
/// tier only.
fn is_function_stdlib_method(name: &str) -> bool {
    matches!(
        name,
        "matchAll"
            | "findLast"
            | "findLastIndex"
            | "forEach"
            | "reduceRight"
            | "fill"
            | "pop"
            | "push"
            | "reverse"
            | "shift"
            | "sort"
            | "splice"
            | "unshift"
            | "setDate"
            | "setMonth"
            | "setFullYear"
            | "setHours"
            | "setMinutes"
            | "setTime"
            | "exec"
            | "set"
            | "delete"
            | "clear"
            | "add"
            | "encode"
    )
}

/// Where a method name is legal when its receiver's type is not known.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MethodName {
    /// Some receiver has this method in the reactive tier.
    Reactive,
    /// A receiver has this method, and only in the function tier.
    FunctionOnly,
    /// No receiver of §4.7 or §9 has a method of this name.
    Unlisted,
}

/// Classifies a method by its name alone, over every receiver of §4.7 and
/// §9. The collection methods and the `...WithPattern` methods are not
/// classified here; a caller tests for them first.
pub fn method_name(name: &str) -> MethodName {
    if is_reactive_handle_method(name) || is_reactive_stdlib_method(name) {
        MethodName::Reactive
    } else if is_function_handle_method(name) || is_function_stdlib_method(name) {
        MethodName::FunctionOnly
    } else {
        MethodName::Unlisted
    }
}

/// The mutating methods of an array (§9.2).
pub fn is_array_mutator(name: &str) -> bool {
    matches!(
        name,
        "fill" | "pop" | "push" | "reverse" | "shift" | "sort" | "splice" | "unshift"
    )
}

/// The mutating methods of a `Map` or a `Set` (§9.9).
pub fn is_keyed_collection_mutator(name: &str) -> bool {
    matches!(name, "set" | "add" | "delete" | "clear")
}

/// How §9 treats a member of a standard-library namespace or constructor,
/// such as `Math.floor` or `Date.now`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlobalMember {
    /// A primitive operation in the reactive tier.
    Reactive,
    /// Available in the function tier only.
    FunctionOnly,
    /// A read of the ambient clock or entropy (§5.1).
    Ambient,
    /// A reflective member §9.11 refuses.
    Reflective,
}

/// The classification of `namespace.member`, or `None` when §9 does not list
/// the member or `namespace` is not a standard-library namespace.
pub fn global_member(namespace: &str, member: &str) -> Option<GlobalMember> {
    use GlobalMember::*;
    let class = match (namespace, member) {
        (
            "Math",
            "abs" | "atan2" | "ceil" | "cos" | "floor" | "hypot" | "imul" | "log" | "max" | "min"
            | "pow" | "round" | "sign" | "sin" | "sqrt" | "trunc" | "PI" | "E",
        ) => Reactive,
        ("Math", "random") => Ambient,
        ("Object", "keys" | "values" | "entries" | "fromEntries" | "hasOwn") => Reactive,
        ("Object", "assign" | "freeze" | "getPrototypeOf" | "create") => FunctionOnly,
        (
            "Object",
            "defineProperty"
            | "defineProperties"
            | "getOwnPropertyDescriptor"
            | "getOwnPropertyDescriptors"
            | "getOwnPropertyNames"
            | "getOwnPropertySymbols"
            | "setPrototypeOf"
            | "preventExtensions"
            | "seal"
            | "isExtensible"
            | "isFrozen"
            | "isSealed",
        ) => Reflective,
        (
            "Number",
            "isFinite" | "isInteger" | "isNaN" | "isSafeInteger" | "parseFloat" | "parseInt"
            | "MAX_SAFE_INTEGER" | "EPSILON",
        ) => Reactive,
        ("String", "fromCharCode" | "fromCodePoint") => Reactive,
        ("Array", "isArray" | "from" | "of") => Reactive,
        ("Date", "parse" | "UTC") => Reactive,
        ("Date", "now") => Ambient,
        ("JSON", "stringify") => Reactive,
        ("JSON", "parse") => FunctionOnly,
        ("console", "log" | "warn" | "error") => FunctionOnly,
        _ => return None,
    };
    Some(class)
}

/// Whether `name` is a standard-library namespace whose members
/// [`global_member`] lists.
pub fn is_global_namespace(name: &str) -> bool {
    matches!(
        name,
        "Math" | "Object" | "Number" | "String" | "Array" | "Date" | "JSON" | "console"
    )
}

/// How §9 treats a global name used as a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Global {
    /// A function that is a primitive operation in the reactive tier.
    ReactiveFunction,
    /// A constant: `Infinity`, `NaN`, `undefined`.
    Constant,
    /// A namespace or a constructor §9 lists. Its use is decided by the
    /// member read from it or by the `new` that calls it.
    Listed,
    /// `eval` and `Function` (§5.1).
    DynamicCode,
    /// A global §9.11 lists as not typed. The text names the replacement,
    /// where one exists.
    Refused(Option<&'static str>),
    /// A global §9 does not mention.
    Unlisted,
}

/// The classification of a global name.
pub fn global(name: &str) -> Global {
    use Global::*;
    const EFFECT: Option<&str> = Some("an effectful built-in, such as `fetchJson`");
    match name {
        "String" | "Number" | "Boolean" | "BigInt" | "parseInt" | "parseFloat" | "isNaN"
        | "isFinite" | "encodeURIComponent" | "decodeURIComponent" | "encodeURI" | "decodeURI"
        | "btoa" | "atob" => ReactiveFunction,
        "Infinity" | "NaN" | "undefined" => Constant,
        "Math" | "Object" | "Array" | "Date" | "JSON" | "console" | "RegExp" | "Map" | "Set"
        | "Error" | "TypeError" | "RangeError" | "URL" | "TextEncoder" | "Uint8Array" => Listed,
        "eval" | "Function" => DynamicCode,
        "Promise" | "fetch" | "structuredClone" => Refused(EFFECT),
        "setTimeout"
        | "setInterval"
        | "clearTimeout"
        | "clearInterval"
        | "setImmediate"
        | "clearImmediate"
        | "queueMicrotask"
        | "requestAnimationFrame"
        | "cancelAnimationFrame"
        | "requestIdleCallback" => Refused(EFFECT),
        "crypto" | "Intl" | "Proxy" | "Reflect" | "Symbol" | "WeakMap" | "WeakSet" | "WeakRef"
        | "globalThis" | "window" | "document" => Refused(None),
        "Int8Array" | "Uint8ClampedArray" | "Int16Array" | "Uint16Array" | "Int32Array"
        | "Uint32Array" | "Float32Array" | "Float64Array" | "BigInt64Array" | "BigUint64Array" => {
            Refused(Some("`Uint8Array`"))
        }
        _ => Unlisted,
    }
}

/// Whether `new name(...)` is a constructor §9 lists for the function tier.
pub fn is_function_tier_constructor(name: &str) -> bool {
    matches!(
        name,
        "Date"
            | "Map"
            | "Set"
            | "Error"
            | "TypeError"
            | "RangeError"
            | "URL"
            | "TextEncoder"
            | "Uint8Array"
            | "Array"
            | "RegExp"
    )
}

/// Whether a global type name is a name of the DOM library
/// (`language-subset.md` §7.10): an event, an element, or another object
/// of the browser.
pub fn is_dom_type_name(name: &str) -> bool {
    name == "Event"
        || (name.ends_with("Event") && name.chars().next().is_some_and(char::is_uppercase))
        || name.starts_with("HTML")
        || name.starts_with("SVG")
        || name.starts_with("DOM")
        || matches!(
            name,
            "EventTarget"
                | "EventListener"
                | "Element"
                | "Node"
                | "NodeList"
                | "Document"
                | "DocumentFragment"
                | "Window"
                | "File"
                | "FileList"
                | "Blob"
                | "FormData"
                | "DataTransfer"
                | "Touch"
                | "TouchList"
                | "Selection"
                | "Range"
                | "ShadowRoot"
                | "CSSStyleDeclaration"
                | "Storage"
                | "Location"
                | "History"
                | "Navigator"
        )
}
