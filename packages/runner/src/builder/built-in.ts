import { BuiltInLLMDialogState } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model-schema";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type {
  BuiltInAgentParams,
  BuiltInAgentState,
  BuiltInCompileAndRunParams,
  BuiltInCompileAndRunState,
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
  BuiltInGenerateTextState,
  BuiltInLLMGenerateObjectState,
  BuiltInLLMParams,
  BuiltInLLMState,
  CellFromUrlFunction,
  ConfLabelQuery,
  FetchBinaryResult,
  FetchOptions,
  InspectConfLabelResult,
  PatternToolFunction,
  PatternToolResult,
  SqliteDatabaseFunction,
  SqliteQueryFunction,
  UIVariantKind,
  VNode,
  WishParams,
  WishState,
} from "commonfabric";

import { wishStateSchemaForResult } from "../builtins/wish-schema.ts";
import { LLMDialogResultSchema } from "../builtins/llm-schemas.ts";
import { sqliteQueryNodeFactory } from "../builtins/sqlite/query-node.ts";
import { isCell } from "../cell.ts";
import { h } from "./h.ts";
import { createNodeFactory } from "./module.ts";
import type {
  Cell as CellType,
  FactoryInput,
  JSONSchema,
  NodeFactory,
  PatternFactory,
  Reactive,
  Schema,
} from "./types.ts";

const WISH_ARGUMENT_SCHEMA = internSchema({
  type: "object",
  properties: {
    query: { type: "string" },
    path: { type: "array", items: { type: "string" } },
    schema: { type: "object" },
    context: {
      type: "object",
      additionalProperties: {
        anyOf: [
          { type: "unknown", asCell: ["cell"] },
          { type: "unknown", asCell: ["opaque"] },
        ],
      },
    },
    scope: { type: "array", items: { type: "string" } },
    headless: { type: "boolean" },
  },
});

/**
 * Signature detection for ifElse/when/unless backward compatibility.
 *
 * These functions support two call signatures:
 * - Legacy (no schemas): ifElse(condition, ifTrue, ifFalse)
 * - With schemas: ifElse(condSchema, trueSchema, falseSchema, resultSchema, condition, ifTrue, ifFalse)
 *
 * We CANNOT use `arg !== undefined` to detect which signature was used because
 * `undefined` is a valid VALUE in either signature. For example:
 *   ifElse(pending, undefined, { result })  // Legacy: undefined is the ifTrue value
 *
 * When transformed with schema injection, this becomes:
 *   ifElse(schema1, schema2, schema3, schema4, pending, undefined, { result })
 *
 * If we checked `ifTrue !== undefined`, we'd incorrectly detect the legacy signature
 * and pass schemas as values, causing the runtime to hang.
 *
 * Instead, we use arguments.length which correctly distinguishes the signatures.
 *
 * If these signatures ever change, update the constants below and the corresponding tests.
 */
export const SIGNATURE_ARGS = {
  ifElse: { legacy: 3, withSchemas: 7 },
  when: { legacy: 2, withSchemas: 5 },
  unless: { legacy: 2, withSchemas: 5 },
} as const;

/** Returns true if ifElse was called with schema arguments prepended */
export function ifElseHasSchemas(argsLength: number): boolean {
  return argsLength >= SIGNATURE_ARGS.ifElse.withSchemas;
}

/** Returns true if when was called with schema arguments prepended */
export function whenHasSchemas(argsLength: number): boolean {
  return argsLength >= SIGNATURE_ARGS.when.withSchemas;
}

/** Returns true if unless was called with schema arguments prepended */
export function unlessHasSchemas(argsLength: number): boolean {
  return argsLength >= SIGNATURE_ARGS.unless.withSchemas;
}

export const compileAndRun = createNodeFactory({
  type: "ref",
  implementation: "compileAndRun",
}) as <T = any, S = any>(
  params: FactoryInput<BuiltInCompileAndRunParams<T>>,
) => Reactive<BuiltInCompileAndRunState<S>>;

export const llm = createNodeFactory({
  type: "ref",
  implementation: "llm",
}) as (
  params: FactoryInput<BuiltInLLMParams>,
) => Reactive<BuiltInLLMState>;

export const llmDialog = createNodeFactory({
  type: "ref",
  implementation: "llmDialog",
  resultSchema: LLMDialogResultSchema,
}) as (
  params: FactoryInput<BuiltInLLMParams>,
) => Reactive<BuiltInLLMDialogState>;

export const generateObject = createNodeFactory({
  type: "ref",
  implementation: "generateObject",
}) as <T = any>(
  params: FactoryInput<BuiltInGenerateObjectParams>,
) => Reactive<BuiltInLLMGenerateObjectState<T>>;

export const generateText = createNodeFactory({
  type: "ref",
  implementation: "generateText",
}) as (
  params: FactoryInput<BuiltInGenerateTextParams>,
) => Reactive<BuiltInGenerateTextState>;

export const agent = createNodeFactory({
  type: "ref",
  implementation: "agent",
}) as <T = any>(
  params: FactoryInput<BuiltInAgentParams>,
) => Reactive<BuiltInAgentState<T>>;

export const fetchBinary = createNodeFactory({
  type: "ref",
  implementation: "fetchBinary",
}) as (
  params: FactoryInput<{
    url: string;
    options?: FetchOptions;
  }>,
) => Reactive<{
  pending: boolean;
  result: FetchBinaryResult;
  error?: unknown;
}>;

export const fetchText = createNodeFactory({
  type: "ref",
  implementation: "fetchText",
}) as (
  params: FactoryInput<{
    url: string;
    options?: FetchOptions;
  }>,
) => Reactive<{ pending: boolean; result: string; error?: unknown }>;

export const fetchJson = createNodeFactory({
  type: "ref",
  implementation: "fetchJson",
}) as <T>(
  params: FactoryInput<{
    url: string;
    schema?: JSONSchema;
    options?: FetchOptions;
    result?: T;
  }>,
) => Reactive<{ pending: boolean; result: T; error?: unknown }>;

export const cellFromUrl = createNodeFactory({
  type: "ref",
  implementation: "cellFromUrl",
}) as CellFromUrlFunction;

export const fetchJsonUnchecked = createNodeFactory({
  type: "ref",
  implementation: "fetchJsonUnchecked",
}) as (
  params: FactoryInput<{
    url: string;
    options?: FetchOptions;
  }>,
) => Reactive<{ pending: boolean; result: any; error?: unknown }>;

export const fetchProgram = createNodeFactory({
  type: "ref",
  implementation: "fetchProgram",
}) as (
  params: FactoryInput<{ url: string }>,
) => Reactive<{
  pending: boolean;
  result: {
    files: Array<{ name: string; contents: string }>;
    main: string;
  } | undefined;
  error?: unknown;
}>;

export const streamData = createNodeFactory({
  type: "ref",
  implementation: "streamData",
}) as <T>(
  params: FactoryInput<{
    url: string;
    options?: FetchOptions;
    result?: T;
  }>,
) => Reactive<{ pending: boolean; result: T; error?: unknown }>;

export const sqliteDatabase = createNodeFactory({
  type: "ref",
  implementation: "sqliteDatabase",
}) as SqliteDatabaseFunction;

// Shares the single `sqliteQuery` node factory with `db.query` (cell.ts) — see
// builtins/sqlite/query-node.ts — so both construct the same node.
export const sqliteQuery =
  sqliteQueryNodeFactory as unknown as SqliteQueryFunction;

// ifElse with optional schema arguments (backward compatible)
// See SIGNATURE_ARGS documentation above for why we use arguments.length
export function ifElse<T = unknown, U = unknown, V = unknown>(
  conditionSchemaOrCondition: JSONSchema | FactoryInput<T>,
  ifTrueSchemaOrIfTrue: JSONSchema | FactoryInput<U>,
  ifFalseSchemaOrIfFalse: JSONSchema | FactoryInput<V>,
  resultSchemaOrCondition?: JSONSchema | FactoryInput<T>,
  condition?: FactoryInput<T>,
  ifTrue?: FactoryInput<U>,
  ifFalse?: FactoryInput<V>,
): Reactive<U | V> {
  ifElseFactory ||= createNodeFactory({
    type: "ref",
    implementation: "ifElse",
  });

  if (ifElseHasSchemas(arguments.length)) {
    return ifElseFactory({
      conditionSchema: conditionSchemaOrCondition as JSONSchema,
      ifTrueSchema: ifTrueSchemaOrIfTrue as JSONSchema,
      ifFalseSchema: ifFalseSchemaOrIfFalse as JSONSchema,
      resultSchema: resultSchemaOrCondition as JSONSchema,
      condition,
      ifTrue,
      ifFalse,
    }) as Reactive<U | V>;
  }

  // Legacy signature: ifElse(cond, ifTrue, ifFalse)
  return ifElseFactory({
    condition: conditionSchemaOrCondition,
    ifTrue: ifTrueSchemaOrIfTrue,
    ifFalse: ifFalseSchemaOrIfFalse,
  }) as Reactive<U | V>;
}

let ifElseFactory:
  | NodeFactory<{
    conditionSchema?: JSONSchema;
    ifTrueSchema?: JSONSchema;
    ifFalseSchema?: JSONSchema;
    resultSchema?: JSONSchema;
    condition: unknown;
    ifTrue: unknown;
    ifFalse: unknown;
  }, any>
  | undefined;

// when(condition, value) - returns value if condition is truthy, else condition
// See SIGNATURE_ARGS documentation above for why we use arguments.length
export function when<T = unknown, U = unknown>(
  conditionSchemaOrCondition: JSONSchema | FactoryInput<T>,
  valueSchemaOrValue: JSONSchema | FactoryInput<U>,
  resultSchemaOrCondition?: JSONSchema | FactoryInput<T>,
  condition?: FactoryInput<T>,
  value?: FactoryInput<U>,
): Reactive<T | U> {
  whenFactory ||= createNodeFactory({
    type: "ref",
    implementation: "when",
  });

  if (whenHasSchemas(arguments.length)) {
    return whenFactory({
      conditionSchema: conditionSchemaOrCondition as JSONSchema,
      valueSchema: valueSchemaOrValue as JSONSchema,
      resultSchema: resultSchemaOrCondition as JSONSchema,
      condition,
      value,
    }) as Reactive<T | U>;
  }

  // Legacy signature: when(cond, value)
  return whenFactory({
    condition: conditionSchemaOrCondition,
    value: valueSchemaOrValue,
  }) as Reactive<T | U>;
}

let whenFactory:
  | NodeFactory<{
    conditionSchema?: JSONSchema;
    valueSchema?: JSONSchema;
    resultSchema?: JSONSchema;
    condition: unknown;
    value: unknown;
  }, any>
  | undefined;

// unless(condition, fallback) - returns condition if truthy, else fallback
// See SIGNATURE_ARGS documentation above for why we use arguments.length
export function unless<T = unknown, U = unknown>(
  conditionSchemaOrCondition: JSONSchema | FactoryInput<T>,
  fallbackSchemaOrFallback: JSONSchema | FactoryInput<U>,
  resultSchemaOrCondition?: JSONSchema | FactoryInput<T>,
  condition?: FactoryInput<T>,
  fallback?: FactoryInput<U>,
): Reactive<T | U> {
  unlessFactory ||= createNodeFactory({
    type: "ref",
    implementation: "unless",
  });

  if (unlessHasSchemas(arguments.length)) {
    return unlessFactory({
      conditionSchema: conditionSchemaOrCondition as JSONSchema,
      fallbackSchema: fallbackSchemaOrFallback as JSONSchema,
      resultSchema: resultSchemaOrCondition as JSONSchema,
      condition,
      fallback,
    }) as Reactive<T | U>;
  }

  // Legacy signature: unless(cond, fallback)
  return unlessFactory({
    condition: conditionSchemaOrCondition,
    fallback: fallbackSchemaOrFallback,
  }) as Reactive<T | U>;
}

let unlessFactory:
  | NodeFactory<{
    conditionSchema?: JSONSchema;
    fallbackSchema?: JSONSchema;
    resultSchema?: JSONSchema;
    condition: unknown;
    fallback: unknown;
  }, any>
  | undefined;

/**
 * uiVariant(piece, kind) — render a piece at a UI variant (`full` | `chip` |
 * `tile`) from render paths that aren't already `<cf-render>` JSX (CT-1321
 * Phase B / CT-1766).
 *
 * Returns a `cf-render` VNode bound to the piece, i.e. it is exactly equivalent
 * to writing `<cf-render variant={kind} $cell={piece} />`. cf-render owns the
 * actual rendering: it resolves the piece link to its root cell, renders the
 * exported variant key ([CHIP_UI] / [TILE_UI] / [UI]) when the piece exports
 * one, and otherwise fails over to the per-variant platform default (chip →
 * cf-cell-link; tile → the full [UI] scaled, clipped, click-to-navigate; full
 * is the universal floor). This helper is the blessed way to reach that failover
 * from inline code that previously indexed a variant key directly (e.g.
 * `piece[TILE_UI]`), which yields `undefined` and renders nothing when absent.
 */
export function uiVariant(
  piece: FactoryInput<unknown>,
  kind: UIVariantKind = "full",
): VNode {
  return h("cf-render", { variant: kind, $cell: piece });
}

export const navigateTo = createNodeFactory({
  type: "ref",
  implementation: "navigateTo",
}) as (cell: Reactive<unknown>) => Reactive<boolean>;

// inv-12 Stage 2 (spec §4.6.4.1): the bounded label-introspection surface.
// `target` rides the node input `asCell` so the builtin receives the
// REFERENCE — inspecting a label never reads the labeled payload value.
const INSPECT_CONF_LABEL_ARGUMENT_SCHEMA = internSchema({
  type: "object",
  properties: {
    target: { type: "object", properties: {}, asCell: ["cell"] },
    path: { type: "string" },
    query: {
      type: "object",
      properties: {
        atomType: { type: "string" },
        caveatKind: { type: "string" },
        source: { type: "unknown" },
        resourceClass: { type: "string" },
        policyName: { type: "string" },
        originUri: { type: "string" },
      },
    },
  },
});

const INSPECT_CONF_LABEL_RESULT_SCHEMA = internSchema({
  type: "object",
  properties: {
    status: { type: "string" },
    atoms: { type: "array", items: { type: "object" } },
  },
});

/**
 * inspectConfLabel(target, targetPath, query) — first-layer introspection of
 * the confidentiality label stored at `target`'s payload path (§4.6.4.1's
 * signature, node-factory form). See the api-level
 * `InspectConfLabelFunction` docs for semantics.
 */
export function inspectConfLabel(
  target: FactoryInput<unknown>,
  targetPath: FactoryInput<string>,
  query: FactoryInput<ConfLabelQuery>,
): Reactive<InspectConfLabelResult> {
  inspectConfLabelFactory ||= createNodeFactory({
    type: "ref",
    implementation: "inspectConfLabel",
    argumentSchema: INSPECT_CONF_LABEL_ARGUMENT_SCHEMA,
    resultSchema: INSPECT_CONF_LABEL_RESULT_SCHEMA,
  });
  return inspectConfLabelFactory({
    target,
    path: targetPath,
    query,
  }) as Reactive<InspectConfLabelResult>;
}

let inspectConfLabelFactory:
  | NodeFactory<{
    target: unknown;
    path: unknown;
    query: unknown;
  }, any>
  | undefined;

export function wish<T = unknown>(
  target: FactoryInput<WishParams>,
): Reactive<WishState<T>>;
export function wish<T = unknown>(
  target: FactoryInput<WishParams>,
  schema: JSONSchema,
): Reactive<WishState<T>>;
export function wish<T = unknown>(
  target: FactoryInput<WishParams>,
  schema?: JSONSchema,
): Reactive<WishState<T>> {
  let param;
  let resultSchema;

  if (schema !== undefined && isObjectOrArray(target) && !isCell(target)) {
    param = {
      schema,
      ...target, // Pass in after, so schema here overrides any schema in target
    };
    resultSchema = !isCell(param.schema)
      ? param.schema as JSONSchema | undefined
      : schema;
  } else {
    param = target;
    resultSchema = schema;
  }
  return createNodeFactory({
    type: "ref",
    implementation: "wish",
    argumentSchema: WISH_ARGUMENT_SCHEMA,
    resultSchema: wishStateSchemaForResult(resultSchema),
  })(param);
}

const strFactory = createNodeFactory<
  { strings: string[]; values: unknown[] },
  string
>({
  type: "ref",
  implementation: "str",
});

// Example:
// str`Hello, ${name}!`
//
export function str(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Reactive<string> {
  // Spread the template strings into a plain array: a `TemplateStringsArray`
  // carries a `raw` property that the binding walk does not preserve, and the
  // interpolation reads only the indexed chunks.
  return strFactory({ strings: [...strings], values });
}

/**
 * Create a cell with a given schema and name.
 *
 * @param schema - Optional, The schema of the cell.
 * @param name - Optional, a name for the cell. If provided, the cell id will be
 *   derived from the current context and that name, otherwise it'll be derived
 *   by the order of invocation, which is less stable.
 * @param value - Optional, the initial value of the cell.
 */
declare function createCell<T>(
  schema?: JSONSchema,
  name?: string,
  value?: T,
): CellType<T>;
declare function createCell<S extends JSONSchema = JSONSchema>(
  schema: S,
  name?: string,
  value?: Schema<S>,
): CellType<Schema<S>>;

export type { createCell };

/**
 * Helper function for creating LLM tool definitions from patterns with optional
 * pre-filled parameters. Returns an object suitable for use as an LLM tool, with
 * proper TypeScript typing that reflects only the non-pre-filled parameters.
 *
 * The first argument must be a `pattern(...)` (CT-1655). A module-scoped reactive
 * value the pattern's callback reads is captured by the pattern automatically (as
 * a module-scope closure); per-instance values are pre-filled via `extraParams`.
 *
 * @param pattern - An already-created PatternFactory (wrap callbacks in pattern())
 * @param extraParams - Optional object of parameter values to pre-fill
 * @returns An object with `pattern` and `extraParams` properties, typed to show only remaining params
 *
 * @example
 * ```ts
 * import { pattern, patternTool } from "commonfabric";
 *
 * const grepTool = patternTool(
 *   pattern(({ query, content }: { query: string; content: string }) => {
 *     return content.split("\n").filter((c) => c.includes(query));
 *   }),
 *   { content },
 * );
 *
 * // With a pattern declared elsewhere:
 * const grepTool2 = patternTool(myGrepPattern, { content });
 *
 * // Result type: PatternToolResult<{ content: string }>
 * // which has { pattern: Pattern, extraParams: { content: string } }
 * ```
 */
export const patternTool = (<
  T,
  E extends Partial<T> = Record<PropertyKey, never>,
>(
  // CT-1655: must already be a pattern. Authors wrap callbacks explicitly —
  // `patternTool(pattern(fn), extraParams?)` — so the unit is addressable and
  // hoistable; the runtime no longer coerces a bare function into a pattern.
  pattern: PatternFactory<T, any>,
  extraParams?: FactoryInput<E>,
): PatternToolResult<E> => {
  return {
    pattern,
    extraParams: (extraParams ?? {}) as E,
  };
}) as PatternToolFunction;
