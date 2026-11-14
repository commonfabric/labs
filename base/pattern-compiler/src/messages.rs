//! What each implemented diagnostic tells the author to write instead
//! (`language-subset.md` §10, the column "Message tells the author to").

/// The replacement the message of `id` names. A report's message is the
/// construct found, followed by this text.
pub fn rewrite(id: &str) -> &'static str {
    match id {
        "module-scope:let-declaration" | "module-scope:var-declaration" => {
            "Use `const`. For a value that changes, create a cell in a pattern \
             (`new Writable<T>(initial)`). For imperative code, move it into a function."
        }
        "module-scope:class-declaration" => {
            "Use an object type and authored functions that take the value as a parameter."
        }
        "module-scope:statement" => {
            "Move the code into a function. To compute a constant once, write \
             `const NAME = compute()`; the result is frozen."
        }
        "module-scope:frozen-data-type" => {
            "Declare the function directly (`const f = (...) => ...`), or build the value \
             inside the function that uses it."
        }
        "module-scope:frozen-data-write" => {
            "Copy first (`[...NAME]`, `{ ...NAME }`, `new Map(NAME)`) and change the copy, \
             or keep the state in a cell."
        }
        "module-scope:stateful-regexp" => {
            "Remove the flag and use `replaceAll` or `matchAll`, or create the expression \
             inside the function that uses it."
        }
        "module-scope:import-form" => {
            "Import a named binding from `commonfabric`, `commonfabric/<name>`, a relative \
             path, or a `cf:` specifier. External packages are not available to patterns."
        }
        "module-scope:runtime-call" => {
            "Move the call into a pattern body or a function body. Module scope has no \
             instance to own what the call creates and no event."
        }
        "pattern-context:missing-return" => {
            "End the body with `return` and the value: the pattern's result, or the value \
             the callback gives for the element."
        }
        "function-body:constructor" => {
            "Call the function without `new`. A function that builds a value returns it."
        }
        "builder-callback:indirect-reference" => {
            "Write the function at the call, or bind it in this module \
             (`const save = (event, state) => ...; handler(save)`)."
        }
        "cell-factory:empty-array" => "Write the element type: `new Writable<Donut[]>([])`.",
        "pattern-context:let-declaration" | "pattern-context:var-declaration" => {
            "Use `const`. For a value computed with reassignment, write \
             `computed(() => { let x = ...; ...; return x; })`."
        }
        "pattern-context:assignment" => {
            "Move the write into an `action(() => ...)` or a `handler`."
        }
        "pattern-context:loop" => {
            "Use `map`, `filter`, or `flatMap` on the collection, or move the loop into \
             `computed(() => ...)`."
        }
        "pattern-context:early-return" => "Write one `return` and select with `c ? a : b`.",
        "pattern-context:control-flow" => {
            "Use `c ? a : b` for a choice of values. Move anything else into \
             `computed(() => ...)`."
        }
        "pattern-context:statement" => {
            "Bind the value with `const`, or delete the statement. To run code for its \
             writes, use `computed(() => { ... })` as a statement."
        }
        "pattern-context:function-creation" => {
            "Declare the function at module scope and call it, or wrap the computation in \
             `computed(() => ...)`."
        }
        "pattern-context:object-member" => {
            "Return data. For behavior, return a stream made by `action` or a bound `handler`."
        }
        "pattern-context:parameter-form" => {
            "Declare the default in the input type (`glaze: Default<string, \"plain\">`). \
             Read remaining properties from the undestructured parameter."
        }
        "pattern-context:builder-placement" => {
            "Define it at module scope, or use `computed(() => ...)` for an immediate \
             `lift(fn)(args)` and `action(() => ...)` for a handler that needs no separate state."
        }
        "pattern-context:callback-container" => {
            "Wrap the whole expression: `computed(() => xs.toSorted((a, b) => a.price - b.price))`."
        }
        "reactive:unsupported-call" => {
            "Wrap the expression in `computed(() => ...)`, or call an authored function that \
             does the work."
        }
        "reactive:unsupported-expression" => "Wrap the expression in `computed(() => ...)`.",
        "pattern-context:self-access" => {
            "Read `const self = input[SELF]` in the pattern body, or destructure \
             `[SELF]: self`, and capture `self`."
        }
        "ses-callback:callable-capture" => "Move the function to module scope.",
        "removed-form:helper" | "removed-form:helper-unsupported" => {
            "Write `c ? a : b` for `ifElse(c, a, b)`, `c && v` for `when(c, v)`, `c || f` for \
             `unless(c, f)`, and a plain template literal for the `str` tag."
        }
        "removed-form:pattern-tool" => {
            "Write an inline `pattern(...)` that captures the bound values, and pass it as \
             the tool."
        }
        "removed-form:builtin" => "Write the replacement instead.",
        "collection:callback-parameters" => {
            "Write the arrow at the call, with the element and at most the index. Capture \
             the array by name if the body needs it."
        }
        "collection:reduce-callback" => {
            "Write the step as one expression, `(sum, donut) => sum + donut.price`. A step \
             that needs statements is a loop inside `computed(() => ...)`."
        }
        "collection:reduce-initial" => "Pass the initial value as the second argument.",
        "collection:reduce-accumulator" => {
            "Accumulate into an object, an array, or a primitive. To fold into a `Map`, write \
             the loop inside `computed(() => ...)` and return data."
        }
        "collection:index-keyed" => {
            "Drop the index if the element can supply what it was used for, such as a \
             stable identifier in place of `key={index}`."
        }
        "cell:unsupported-method" => {
            "Use the declared method that does the job, or a declared type in place of a \
             re-typing."
        }
        "cell:collection-method-in-function" => {
            "To keep the result reactive, wrap the expression in an inline `pattern(...)` \
             and instantiate it: `pattern(() => cell.map(...))({})`. To process the values \
             the cell holds when the body runs, read first: `cell.get().map(...)`."
        }
        "cell:cause-not-literal" => {
            "Write a string literal, which names the cell in place of the variable's name: \
             `Writable.for<number>(\"count\")`. A cause computed from data is legal only in \
             a function body."
        }
        "cell:method-tier" => {
            "Move a write into a `handler` or an `action`. Declare a database with \
             `sqliteDatabase` in the pattern body and pass the handle to the function body."
        }
        "sqlite:tables-not-static" => {
            "Write the table declarations from literals and constants. Data that varies \
             belongs in the rows of a table, not in its declaration."
        }
        "collection:nested-scan" => {
            "Measure, and consider an index (`keyBy`, `groupBy`) or an aggregate."
        }
        "function-body:async" => {
            "Use an effectful built-in for asynchronous work (the fetch family, the \
             language-model built-ins) and read its result reactively."
        }
        "function-body:generator" => "Return an array.",
        "function-body:class" => "Use an object type and functions.",
        "function-body:this" => {
            "Take the value as a parameter; use a rest parameter for variable arguments."
        }
        "function-body:var" => "Use `let` or `const`.",
        "function-body:for-in" => "Use `for (const key of Object.keys(value))`.",
        "function-body:dynamic-code" => "Import statically; remove the statement.",
        "function-body:accessor" => {
            "Write a property that holds an arrow function, or compute the value eagerly."
        }
        "function-body:unsupported-global" => {
            "Use the built-in that replaces it, where one does; otherwise remove the use."
        }
        "function-body:global-write" => "Keep the state in a cell.",
        "function-body:ambient-read" => {
            "Read the clock in a `handler` or `action` and store the value in a cell, or \
             take the time as an input."
        }
        "function-body:builder-call" => {
            "Define the builder at module scope and call its result. A function body that \
             needs a reactive value instantiates a pattern."
        }
        "function-body:instantiation-without-cause" => {
            "Write `.for(cause)` on the instantiation, with a cause taken from the record, so \
             that each instance stays with its record when the list changes."
        }
        "function-body:handler-capture" => {
            "Assign the value to a `const` before the handler and capture that."
        }
        "function-body:cell-needs-cause" => {
            "Name it: `Writable.for<T>(cause)`, with a cause that is the same on every \
             evaluation."
        }
        "function-body:effect-in-computation" => {
            "Write the effect in a pattern, inline or named, and instantiate the pattern in \
             the computation. Or request the effect in the pattern body, with the computed \
             value as its input."
        }
        "function-body:event-context-in-computation" => {
            "Read it in the `handler` or `action` and pass or store the value."
        }
        "collection:shared-element-state" => {
            "Take the index parameter and use it, for example in the cell's cause. Or make \
             the elements cells: keep the list in a cell that a handler writes records into."
        }
        "verb-result:undeclared-return" => {
            "Declare the result (`action<Event, Result>(...)`, \
             `handler<Event, State, Result>(...)`), or use a bare `return;`."
        }
        "computed:not-promoted" => {
            "The `computed` stays a function body. Its result has one label for the whole value."
        }
        "computed:redundant" => "Write the body in place of the call.",
        "subset-type:conditional" => {
            "Use a union, an overload-free generic, or one of the native type operators."
        }
        "subset-type:mapped" => {
            "Use `Record<K, T>`, `Partial`, `Required`, `Readonly`, `Pick`, or `Omit`."
        }
        "subset-type:template-literal" => "Use `string`, or a union of string literals.",
        "subset-type:overload" => {
            "Write one signature with a union parameter, or two functions with different \
             names. For a re-typing overload, declare the position with the type that is read."
        }
        "subset-type:class" => "Use object types and authored functions.",
        "subset-type:callable-object" => "Use a function type, or a property of function type.",
        "subset-type:assertion-signature" => "Use a type predicate and an `if` that throws.",
        "subset-type:unsupported-modifier" => "Omit the modifier.",
        "subset-type:index-signature-key" => "Use an array, or a `string` key.",
        "subset-type:tuple-rest" => "Use an array type, or a tuple of fixed length.",
        "subset-syntax:enum" => "Use a union of string literals with an `as const` object.",
        "subset-syntax:namespace" => "Use a module.",
        "subset-syntax:ambient-declaration" => "Write one declaration per name.",
        "subset-syntax:decorator" => "Use a builder call.",
        "subset-type:non-regular-recursion" => "Recurse with the declaration's own parameters.",
        "subset-type:any" => {
            "Use `unknown` or `Cell<unknown>` for a reference, no cast for a pattern instance \
             or a labeled value, `instanceof Error` for a caught error, and \
             `Record<string, unknown>` or `JSONValue` for open data."
        }
        "cast-validation:forbidden-cast" => "Remove the cast.",
        "subset-type:cannot-infer-type-argument" => "Write the type argument.",
        "cast-validation:double-unknown" => {
            "Declare the value with the type it has, or narrow it with a type predicate."
        }
        "schema:unknown-type-access" => {
            "Replace `unknown` with a type that declares the properties read."
        }
        "schema:path-not-in-type" => "Add the property to the type.",
        "pattern:any-result-schema" => "Declare the result: `pattern<Input, Output>(...)`.",
        "pattern-result:unknown-type" => {
            "Annotate the value that produces the field, or declare the result type."
        }
        "pattern-result:opaque-reserved-key" => "Type it as `VNode`, or as the value it holds.",
        "reactive-capture:unknown-type" => "Annotate the captured value.",
        "cfc-label:conflict" => "Declare the key once.",
        "cfc-policy-authoring" => {
            "Declare the rules in the initializer of an exported module-scope constant: \
             `export const rules = exchangeRules([...])`."
        }
        "cfc-label:cast-ignored" => {
            "Remove the cast; declare the label on the cell, the pattern input, or the \
             pattern result."
        }
        "cfc-policy-of" => {
            "Write `PolicyOf<typeof rules>` with `rules` an exported module-scope constant \
             initialized by `exchangeRules([...])`, declared in this module or imported \
             from the module that declares it."
        }
        "subset-type:mismatch" => {
            "Write a value of the expected type, or declare the position with the type \
             the value has."
        }
        "cast-validation:cell-cast" => {
            "Declare the cell type where the value is received: the pattern input or the \
             handler state."
        }
        "schema-type:symbol" => "Use a string key, or a well-known key exported by the API.",
        "stdlib:unsupported-member" => "Use a member that `language-subset.md` §9 lists.",
        "import:signature-not-in-subset" => {
            "Annotate every parameter and the return type with subset types."
        }
        "import:not-a-function" => "Move the constant into a subset module.",
        "import:signature-not-data" => {
            "Pass and return data: read the cell in the caller and pass the value, and write \
             the result in the caller."
        }
        "import:commonfabric-value" => {
            "Use `import type`. Move the code that calls a builder, a built-in, or a cell \
             constructor into a subset module."
        }
        "footprint:widened" => {
            "Read the properties that are needed in place of the whole value \
             (`footprint-analysis.md` §5.3)."
        }
        "footprint:dynamic-read" => {
            "Read through one handle at a static key, ahead of any branch, where every path \
             reads the cell. Where the condition only tests that the handle is present, the \
             optional chain on the handle, `h?.get()`, is the static form."
        }
        "footprint:materializer" => {
            "Write through a handle the body is given, at a static path, or move the write \
             into a `handler` or an `action`."
        }
        "side-write:not-idempotent" => {
            "`set` a value computed from other inputs, or move the update into a `handler` \
             or an `action`."
        }
        "side-write:cycle" => {
            "Make the write leave a settled value unchanged, so that the second evaluation \
             writes what the first did, or move it into a `handler` or an `action`."
        }
        "mergeable-push:read-then-push" => "Push without reading the collection first.",
        _ => "",
    }
}
