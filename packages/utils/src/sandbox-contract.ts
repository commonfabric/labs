/**
 * The contract between the pattern toolchain and the sandbox compartment a
 * pattern runs in: the globals a compartment withholds, the builder and
 * data-helper names that are trusted, the identifiers reserved within a
 * factory's scope, and the source text of the helpers that carry the
 * value-side parts of the contract.
 */

/**
 * Names that a factory's scope shadows, so that authored code reaching for one
 * of them finds `undefined` rather than the module loader's binding.
 */
export const SHADOWED_FACTORY_BINDINGS = [
  "define",
  "runtimeDeps",
  "__cfAmdHooks",
] as const;

/**
 * Globals that a sandbox compartment does not provide, and that the type
 * libraries the pattern compiler serves therefore must not declare.
 *
 * A pattern is compiled against `es2023.d.ts` and `dom.d.ts` and then runs
 * inside a compartment. A name declared by those libraries but missing from
 * the compartment type checks, compiles and deploys, then throws a
 * `TypeError` the first time the authored code reaches it. Keeping this list
 * and those declarations in step turns that runtime failure into a compile
 * error.
 *
 * `packages/static/scripts/strip-withheld-globals.ts` removes the matching
 * declaration from the type libraries, and
 * `packages/runner/test/sandbox-global-contract.test.ts` checks each name here
 * against a real compartment. Endowing one of these globals means dropping it
 * from this list and restoring its declaration; the test fails until both
 * happen.
 *
 * Changing this list also affects the `ts-transformers` and `schema-generator`
 * fixture suites, which type-check their fixtures against the type libraries
 * and are checked only in CI; see `packages/static/README.md`.
 */
export const SANDBOX_WITHHELD_GLOBALS = Object.freeze(
  [
    // SES keeps these out of every compartment.
    //
    // `Float32Array` and `Float64Array` carry the NaN side channel. A NaN's
    // unused mantissa bits can hold a payload, and storing one into a float
    // typed array writes those bits through to the underlying buffer, where a
    // second view reads them back. Lockdown repairs
    // `DataView.prototype.setFloat*` to write only canonical NaNs, but a
    // typed-array element store is not a method and nothing can intercept it,
    // so SES withholds the constructors instead.
    "Float32Array",
    "Float64Array",
    // `Atomics` and `SharedArrayBuffer` combine shared memory with a timing
    // source precise enough to read it.
    "Atomics",
    "SharedArrayBuffer",
    // `WeakRef` and `FinalizationRegistry` make garbage collection observable.
    "WeakRef",
    "FinalizationRegistry",

    // The runtime removes this one; see `compartment-globals.ts`.
    "Proxy",

    // Timers and the microtask queue. A pattern reacts through the runtime's
    // scheduler rather than driving its own clock, so a compartment installs
    // none of these. The type libraries declare them, so a pattern that calls
    // one type checks and then throws; withholding turns that into a compile
    // error instead.
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "queueMicrotask",
    // `Intl` reaches the host's default locale and time zone whenever a
    // formatter is constructed without explicit arguments, which is both
    // nondeterministic across runtimes and a fingerprinting channel. The
    // sanitized `toLocale*` methods in `locale-taming.ts` pin those defaults
    // for the surface a pattern actually uses; the `Intl` constructors have no
    // such taming, and no pattern needs them, so they stay out. Stripping
    // removes the namespace's value members (`var Collator`,
    // `var NumberFormat`, ...) while its interfaces remain, so a pattern can
    // still annotate an `Intl.NumberFormatOptions` even though it cannot
    // construct a formatter.
    //
    // Locale-specific formatting is served by a capability carrying the user's
    // preferred locales -- a `wish("#locale")` reading them from the user's
    // profile and falling back to the platform defaults -- rather than by
    // endowing `Intl`. A pattern passes that locale explicitly to the
    // sanitized `toLocale*` methods, which already honor one, so common
    // number, date, and currency formatting needs no `Intl`.
    "Intl",

    // `fetch` is network egress the runtime never sees. A pattern reaches the
    // network through the fetch builtins (`fetchJson`, `fetchText`,
    // `fetchBinary`, `fetchJsonUnchecked`, `fetchProgram`), which are reactive
    // nodes the runtime issues on the pattern's behalf: it records each request
    // as a CFC sink request, which a deployment's ceiling then gates, and signs
    // it when it targets a first-party route. An ambient `fetch` performs the
    // same egress with no record and nothing to gate.
    "fetch",

    // The web request globals. Each is inert on its own — none reaches the
    // network — and each exists to build or read a `fetch` call, which nothing
    // in a compartment can make. Endowing one again is a question of whether
    // something needs it, not of what it would grant.
    "Headers",
    "Request",
    "Response",

    // Web globals the runtime has never endowed. Unlike the entries above,
    // these are absent because nothing has supplied them, not because they are
    // unsafe.
    "AbortController",
    "AbortSignal",
    "Blob",
    "ByteLengthQueuingStrategy",
    "CountQueuingStrategy",
    "CustomEvent",
    "DOMException",
    "ErrorEvent",
    "Event",
    "EventSource",
    "EventTarget",
    "MessageChannel",
    "MessageEvent",
    "MessagePort",
    "PromiseRejectionEvent",
    "ReadableByteStreamController",
    "ReadableStream",
    "ReadableStreamBYOBReader",
    "ReadableStreamBYOBRequest",
    "ReadableStreamDefaultController",
    "ReadableStreamDefaultReader",
    "TextDecoderStream",
    "TextEncoderStream",
    "TransformStream",
    "TransformStreamDefaultController",
    "WritableStream",
    "WritableStreamDefaultController",
    "WritableStreamDefaultWriter",
    "self",
  ] as const,
);

/** Name of a global withheld from a sandbox compartment. */
export type SandboxWithheldGlobalName =
  (typeof SANDBOX_WITHHELD_GLOBALS)[number];

/**
 * Names of the builders a pattern may call, whose results the toolchain
 * treats as trusted.
 */
export const TRUSTED_BUILDERS = Object.freeze(
  [
    "action",
    "computed",
    "derive",
    "handler",
    "lift",
    // Identity tag for multi-user test descriptors (`cf test`); its
    // arguments are trusted-builder results, never event-carrying closures.
    "multiUserTest",
    "pattern",
  ] as const,
);

/** Name of a trusted builder. */
export type TrustedBuilderName = (typeof TRUSTED_BUILDERS)[number];

/** `TRUSTED_BUILDERS`, indexed for lookup. */
const TRUSTED_BUILDER_SET = new Set<string>(TRUSTED_BUILDERS);

/** Indicates whether `name` is the name of a trusted builder. */
export function isTrustedBuilder(name: string): name is TrustedBuilderName {
  return TRUSTED_BUILDER_SET.has(name);
}

/**
 * Names of the data helpers a pattern may call, whose results the toolchain
 * treats as trusted.
 */
export const TRUSTED_DATA_HELPERS = Object.freeze(
  [
    "schema",
    "__cf_data",
  ] as const,
);

/** Name of a trusted data helper. */
export type TrustedDataHelperName = (typeof TRUSTED_DATA_HELPERS)[number];

/** `TRUSTED_DATA_HELPERS`, indexed for lookup. */
const TRUSTED_DATA_HELPER_SET = new Set<string>(TRUSTED_DATA_HELPERS);

/** Indicates whether `name` is the name of a trusted data helper. */
export function isTrustedDataHelper(
  name: string,
): name is TrustedDataHelperName {
  return TRUSTED_DATA_HELPER_SET.has(name);
}

/** Default name of the function-hardening helper. */
export const FUNCTION_HARDENING_HELPER_NAME = "__cfHardenFn";

/** Default name of the binding-identity helper. */
export const BINDING_IDENTITY_HELPER_NAME = "__cfBindVerifiedBinding";

/** Default name of the property the binding-identity helper writes. */
export const VERIFIED_BINDING_METADATA_FIELD = "__cfVerifiedBindingIdentity";

/** Names that authored code must not bind at the top level of a factory. */
export const RESERVED_FACTORY_BINDINGS = [
  ...SHADOWED_FACTORY_BINDINGS,
] as const;

/**
 * Returns the source lines that shadow each of `SHADOWED_FACTORY_BINDINGS`
 * with `undefined`, one declaration per line.
 */
export function createFactoryShadowGuardSource(): string[] {
  return SHADOWED_FACTORY_BINDINGS.map((name) => `const ${name} = undefined;`);
}

/**
 * Returns the source text of the function-hardening helper: a function that
 * freezes what it is given, freezes its `.prototype` when it has an object
 * one, and returns it. `helperName` names the declared function, and
 * `options.typedParameter` annotates the parameter, for a helper emitted into
 * TypeScript rather than JavaScript.
 */
export function createFunctionHardeningHelperSource(
  helperName = FUNCTION_HARDENING_HELPER_NAME,
  options: { typedParameter?: boolean } = {},
): string {
  const parameter = options.typedParameter ? "fn: Function" : "fn";
  return [
    `function ${helperName}(${parameter}) {`,
    "  Object.freeze(fn);",
    "  const prototype = fn.prototype;",
    '  if (prototype && typeof prototype === "object") {',
    "    Object.freeze(prototype);",
    "  }",
    "  return fn;",
    "}",
  ].join("\n");
}

/**
 * Returns the source text of the binding-identity helper: a function that
 * stamps `metadataField` onto the value it is given, and onto that value's
 * `.implementation` when there is a callable one, then returns the value. A
 * non-extensible target is left alone rather than throwing. `helperName` names
 * the declared function, and `options.typedParameter` annotates the
 * parameters, for a helper emitted into TypeScript rather than JavaScript.
 */
export function createBindingIdentityHelperSource(
  helperName = BINDING_IDENTITY_HELPER_NAME,
  metadataField = VERIFIED_BINDING_METADATA_FIELD,
  options: { typedParameter?: boolean } = {},
): string {
  const parameter = options.typedParameter ? "value: any" : "value";
  const metadataParameter = options.typedParameter
    ? "metadata: any"
    : "metadata";
  return [
    `function ${helperName}(${parameter}, ${metadataParameter}) {`,
    '  if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {',
    "    Object.defineProperty(value, " +
    JSON.stringify(metadataField) +
    ", {",
    "      value: metadata,",
    "      configurable: true",
    "    });",
    "  }",
    '  if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {',
    "    var implementation = value.implementation;",
    '    if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {',
    "      Object.defineProperty(implementation, " +
    JSON.stringify(metadataField) +
    ", {",
    "        value: metadata,",
    "        configurable: true",
    "      });",
    "    }",
    "  }",
    "  return value;",
    "}",
  ].join("\n");
}
