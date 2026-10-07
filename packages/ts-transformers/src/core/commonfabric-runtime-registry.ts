export type CommonFabricRuntimeExportSpec =
  | {
    exportName: string;
    category: "builder";
    builderName: string;
    reactiveOrigin: boolean;
  }
  | {
    exportName: string;
    category: "call";
    callKind:
      | "cell-factory"
      | "lift-applied"
      | "ifElse"
      | "when"
      | "unless"
      | "wish"
      | "generate-text"
      | "generate-object"
      | "pattern-tool"
      | "runtime-call";
    reactiveOrigin: boolean;
  }
  | {
    exportName: string;
    category: "ignored";
    reactiveOrigin: boolean;
  };

export const COMMONFABRIC_RUNTIME_EXPORT_REGISTRY = [
  {
    exportName: "tagCollectionKey",
    category: "ignored",
    reactiveOrigin: false,
  },
  {
    exportName: "pattern",
    category: "builder",
    builderName: "pattern",
    reactiveOrigin: true,
  },
  {
    exportName: "handler",
    category: "builder",
    builderName: "handler",
    reactiveOrigin: true,
  },
  {
    exportName: "action",
    category: "builder",
    builderName: "action",
    reactiveOrigin: true,
  },
  {
    exportName: "lift",
    category: "builder",
    builderName: "lift",
    reactiveOrigin: true,
  },
  {
    exportName: "computed",
    category: "builder",
    builderName: "computed",
    reactiveOrigin: true,
  },
  // `assert` is `computed` plus operand recording: AssertDiagnosticsTransformer
  // rewrites the body, and everything after it lowers the call exactly as a
  // computed. Mapping it onto `computed` here is what makes every stage that
  // already handles computed handle assert with no change.
  {
    exportName: "assert",
    category: "builder",
    builderName: "computed",
    reactiveOrigin: true,
  },
  {
    exportName: "byRef",
    category: "ignored",
    reactiveOrigin: false,
  },
  // Reads the principal the running handler acts for, and returns a plain DID
  // rather than a reactive value.
  {
    exportName: "currentPrincipal",
    category: "ignored",
    reactiveOrigin: false,
  },
  // Reads the principal a cell's label attests, inside the computation or
  // handler that calls it, and returns a plain DID rather than a reactive
  // value. It builds no graph node.
  {
    exportName: "principalOf",
    category: "ignored",
    reactiveOrigin: false,
  },
  // Reads every principal a cell's label attests, as `principalOf` reads the
  // one, and returns a plain array of DIDs. It builds no graph node.
  {
    exportName: "principalsOf",
    category: "ignored",
    reactiveOrigin: false,
  },
  // Reads the key of the event the running handler handles, and returns a
  // plain string rather than a reactive value.
  {
    exportName: "eventKey",
    category: "ignored",
    reactiveOrigin: false,
  },
  // A predicate over its argument alone, returning a plain boolean rather than
  // a reactive value.
  {
    exportName: "isWellFormedDID",
    category: "ignored",
    reactiveOrigin: false,
  },
  // `assertCapture` records one operand of an `assert` body and returns it
  // unchanged. AssertDiagnosticsTransformer emits the calls; authored code
  // does not call it. It takes a resolved value and hands the same value back,
  // so it originates nothing reactive and needs no dedicated CallKind — a
  // plain call, like `byRef`.
  {
    exportName: "assertCapture",
    category: "ignored",
    reactiveOrigin: false,
  },
  // `assertRenderParts` renders the operands `assertCapture` recorded into the
  // assert record's `parts`, and only when the assertion failed.
  // AssertDiagnosticsTransformer emits the call; authored code does not. It
  // takes plain data and returns plain data, so like `assertCapture` it
  // originates nothing reactive and is a plain call.
  {
    exportName: "assertRenderParts",
    category: "ignored",
    reactiveOrigin: false,
  },
  {
    exportName: "render",
    category: "builder",
    builderName: "render",
    reactiveOrigin: true,
  },
  {
    exportName: "cell",
    category: "call",
    callKind: "cell-factory",
    reactiveOrigin: true,
  },
  {
    exportName: "ifElse",
    category: "call",
    callKind: "ifElse",
    reactiveOrigin: true,
  },
  {
    exportName: "when",
    category: "call",
    callKind: "when",
    reactiveOrigin: true,
  },
  {
    exportName: "unless",
    category: "call",
    callKind: "unless",
    reactiveOrigin: true,
  },
  {
    exportName: "wish",
    category: "call",
    callKind: "wish",
    reactiveOrigin: true,
  },
  {
    exportName: "generateText",
    category: "call",
    callKind: "generate-text",
    reactiveOrigin: true,
  },
  {
    exportName: "generateObject",
    category: "call",
    callKind: "generate-object",
    reactiveOrigin: true,
  },
  {
    exportName: "agent",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "patternTool",
    category: "call",
    callKind: "pattern-tool",
    reactiveOrigin: false,
  },
  {
    exportName: "str",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "llm",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "llmDialog",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "fetchBinary",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "fetchText",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  // `fetchJson` additionally gets type-argument schema injection in
  // schema-injection.ts (lowering `fetchJson<T>` to an injected `schema`
  // parameter, like sqliteQuery's `rowSchema`), and is a compile error
  // without a type argument.
  {
    exportName: "fetchJson",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "cellFromUrl",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "fetchJsonUnchecked",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "fetchProgram",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "streamData",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "compileAndRun",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "navigateTo",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  // inspectConfLabel(target, targetPath, query) — the inv-12 Stage 2 bounded
  // label-introspection builtin (CFC spec §4.6.4.1). A plain node-factory
  // call returning a Reactive result, like navigateTo: no dedicated
  // CallKind, no schema injection (its argument schema is fixed on the
  // factory).
  {
    exportName: "inspectConfLabel",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  // `policySecretHash` gets type-argument schema injection in
  // schema-injection.ts, like `fetchJson`: the injected `schema` names the
  // module policy its result belongs to, and the call is a compile error
  // without a type argument.
  {
    exportName: "policySecretHash",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  // SQLite builtins. `sqliteQuery` additionally gets dedicated type-argument
  // schema injection in schema-injection.ts (lowering `sqliteQuery<Row>` to an
  // injected `rowSchema`); the others are registered so the factory-injected
  // callables are recognized reactive-origin calls (registry guard test).
  {
    exportName: "sqliteDatabase",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  {
    exportName: "sqliteQuery",
    category: "call",
    callKind: "runtime-call",
    reactiveOrigin: true,
  },
  // uiVariant(piece, kind) returns a static `cf-render` VNode (it just calls
  // `h`); cf-render owns all reactivity at render time. The transformer needs no
  // special handling — it is not a reactive-origin call and gets no dedicated
  // CallKind, so it is "ignored" (treated as a plain call, like `byRef`).
  {
    exportName: "uiVariant",
    category: "ignored",
    reactiveOrigin: false,
  },
  // spaceAccess(target?) reads the current principal's level from the space's
  // access list and returns a string or `undefined`. It builds no graph node,
  // so it is a plain call inside the computation or handler that makes it.
  {
    exportName: "spaceAccess",
    category: "ignored",
    reactiveOrigin: false,
  },
  // spaceOf(target) returns the DID of the space a cell's value lives in, or
  // `undefined`. It builds no graph node, so it is a plain call inside the
  // computation or handler that makes it.
  {
    exportName: "spaceOf",
    category: "ignored",
    reactiveOrigin: false,
  },
  // grantSpaceAccess(target, principal, level) and revokeSpaceAccess(target,
  // principal) stage an access-list change in the running handler and return
  // nothing. They build no graph node, so each is a plain call inside the
  // handler that makes it.
  {
    exportName: "grantSpaceAccess",
    category: "ignored",
    reactiveOrigin: false,
  },
  {
    exportName: "revokeSpaceAccess",
    category: "ignored",
    reactiveOrigin: false,
  },
] as const satisfies readonly CommonFabricRuntimeExportSpec[];

export const COMMONFABRIC_RUNTIME_EXPORTS_BY_NAME: ReadonlyMap<
  string,
  CommonFabricRuntimeExportSpec
> = new Map(
  COMMONFABRIC_RUNTIME_EXPORT_REGISTRY.map((
    entry,
  ) => [entry.exportName, entry]),
);

export const COMMONFABRIC_BUILDER_EXPORT_NAMES: ReadonlySet<string> = new Set(
  COMMONFABRIC_RUNTIME_EXPORT_REGISTRY
    .filter((entry) => entry.category === "builder")
    .map((entry) => entry.exportName),
);

/**
 * The builder a runtime export lowers as. This is the export's own name for
 * every builder but `assert`, which lowers as a `computed`. Callers resolving
 * a call site to a builder use this rather than the export name, so that an
 * export mapped onto another builder reaches the stages that handle it.
 */
export function builderNameForExportName(exportName: string): string {
  const entry = COMMONFABRIC_RUNTIME_EXPORTS_BY_NAME.get(exportName);
  return entry?.category === "builder" ? entry.builderName : exportName;
}

export const COMMONFABRIC_CALL_EXPORT_NAMES: ReadonlySet<string> = new Set(
  COMMONFABRIC_RUNTIME_EXPORT_REGISTRY
    .filter((entry) => entry.category === "call")
    .map((entry) => entry.exportName),
);

export const COMMONFABRIC_REACTIVE_ORIGIN_BUILDER_NAMES: ReadonlySet<string> =
  new Set(
    COMMONFABRIC_RUNTIME_EXPORT_REGISTRY
      .filter((entry) => entry.category === "builder" && entry.reactiveOrigin)
      .map((entry) => entry.builderName),
  );

export const COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES: ReadonlySet<
  string
> = new Set(
  COMMONFABRIC_RUNTIME_EXPORT_REGISTRY
    .filter((entry) => entry.category === "call" && entry.reactiveOrigin)
    .map((entry) => entry.exportName),
);
