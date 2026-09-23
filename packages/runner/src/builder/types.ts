import type {
  AssertCaptureFunction,
  AssertRenderPartsFunction,
  Cell,
  CellScope,
  FabricExecValue,
  FactoryInput,
  HFunction,
  JSONSchema,
  JSONValue,
  Module,
  Pattern,
  Reactive,
  schema as schemaFunction,
  SELF as SELFSymbol,
} from "@commonfabric/api";
// The declared surface this file checks against is `typeof` this whole
// module, which only a namespace import can name, and a namespace import
// takes no other name beside it. So this statement and the one above it
// cannot become one, and reaching through the namespace instead would
// prefix every use of the types above.
// deno-lint-ignore cf-import-list/one-statement-per-kind
import type * as DeclaredApi from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";
import {
  CHIP_UI,
  FRAMEWORK_RESULT_KEYS,
  FS,
  NAME,
  TESTS,
  TILE_UI,
  TYPE,
  UI,
  VIEWS,
} from "@commonfabric/utils/framework-result-keys";
import type { entityRefToString } from "@commonfabric/data-model/cell-rep";
import type { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";
import type { valueEqual } from "@commonfabric/data-model";
import type * as RowLabelHelpers from "@commonfabric/memory/sqlite/row-label";
import type { cfLink, table } from "@commonfabric/memory/sqlite/schema";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { ImplementationIdentity } from "../cfc/types.ts";
import type { EntityKind } from "../entity-kind.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { type Runtime } from "../runtime.ts";
import {
  type IExtendedStorageTransaction,
  type MemorySpace,
} from "../storage/interface.ts";
import type { PatternBuilder } from "./pattern.ts";
import { AuthSchema, WebhookConfigSchema } from "./schema-lib.ts";

// Define runtime constants here - actual runtime values

// The reserved result keys are spelled in `@commonfabric/utils`, where the
// transformer that polices what a pattern may declare about them reads the
// same list. They are re-exported here because this is the builder surface a
// pattern sees them through.
export {
  CHIP_UI,
  FRAMEWORK_RESULT_KEYS,
  FS,
  NAME,
  TESTS,
  TILE_UI,
  TYPE,
  UI,
  VIEWS,
};

// Symbol for accessing self-reference in patterns
export const SELF: typeof SELFSymbol = Symbol("SELF") as any;

export const schema: typeof schemaFunction = (schema) => schema;

export {
  AuthSchema,
  OAuth2TokenSchema,
  WebhookConfigSchema,
} from "./schema-lib.ts";
export type {
  AnyCell,
  AnyCellWrapping,
  Apply,
  AsCell,
  AsComparableCell,
  AsOpaqueCell,
  AsReadonlyCell,
  AssertPart,
  AssertRawPart,
  AssertRecord,
  AsStream,
  AsWriteonlyCell,
  Cell,
  CellKind,
  CellScope,
  CellTypeConstructor,
  FabricExecArray,
  FabricExecFunction,
  FabricExecPlainObject,
  FabricExecValue,
  FabricValue,
  FactoryInput,
  FsProjection,
  Handler,
  HandlerFactory,
  HandlerState,
  HKT,
  ICell,
  IDerivable,
  IKeyableOpaque,
  IOpaquable,
  IOpaqueCell,
  IsThisObject,
  IStreamable,
  JSONArray,
  JSONObject,
  JSONSchema,
  JSONSchemaObj,
  JSONSchemaTypes,
  JSONValue,
  KeyResultType,
  LinkScope,
  Module,
  ModuleFactory,
  MutableJSONSchema,
  MutableJSONSchemaObj,
  NodeFactory,
  OpaqueCell,
  Pattern,
  PatternFactory,
  PatternFunction,
  Props,
  Reactive,
  RenderNode,
  RequireDefaults,
  SchemaScope,
  Stream,
  StripCell,
  StripDefaultBrand,
  toEncodableForm,
  toJSON,
  ToSchemaFunction,
  UiActionProps,
  UiDisclosureProps,
  UiPromptSlotProps,
  UnwrapCell,
  VNode,
} from "@commonfabric/api";
export type { AsCellEntry } from "@commonfabric/api";
export type { Schema, SchemaWithoutCell } from "@commonfabric/api/schema";

export const isReactiveMarker = Symbol("isReactive");

export function isReactive<T = any>(
  value: unknown,
): value is Reactive<T> {
  return !!value &&
    typeof (value as { [isReactiveMarker]: true })[isReactiveMarker] ===
      "boolean";
}

export type NodeRef = {
  module: Module | Pattern | Reactive<Module | Pattern>;
  inputs: FactoryInput<any>;
  outputs: Reactive<any>;
  frame: Frame | undefined;
};

export type StreamValue = {
  $stream: true;
};

/**
 * The key a stream value carries, holding `true`. A reader that only needs
 * to know whether a value is a stream reads this one path rather than the
 * whole value.
 */
export const STREAM_MARKER_KEY = "$stream";

export function isStreamValue(value: unknown): value is StreamValue {
  return isObjectNotArray(value) && STREAM_MARKER_KEY in value &&
    value[STREAM_MARKER_KEY] === true;
}

declare module "@commonfabric/api" {
  export interface Module {
    type: "ref" | "javascript" | "pattern" | "raw" | "isolated" | "passthrough";
    implementation?: ((...args: any[]) => any) | Pattern | string;

    /**
     * Content-addressed reference to the module-scope builder artifact whose
     * implementation this module runs: the defining module's content identity
     * and the artifact's export/`__cfReg` symbol — the ONLY serialized
     * identity (see docs/specs/content-addressed-action-identity.md).
     */
    $implRef?: { identity: string; symbol: string };

    wrapper?: "handler";
    argumentSchema?: JSONSchema;
    resultSchema?: JSONSchema;

    /** If true, this module is an effect (side-effectful) rather than a computation */
    isEffect?: boolean;

    /** Optional scheduler debounce delay in milliseconds */
    debounce?: number;

    /** Opt out of scheduler auto-debounce */
    noDebounce?: boolean;

    /** Optional scheduler throttle period in milliseconds */
    throttle?: number;

    /** Pull-mode write envelopes for broad/dynamic writable-input materializers */
    materializerWriteEnvelopes?: readonly NormalizedFullLink[];

    /**
     * Exhaustive analyzed record of input paths the module may write. Only
     * writable-branded paths become materializer envelopes; stream paths
     * stay in the record (they disqualify pure-derivation treatment) but
     * are never collectible. Presence of this field, even empty, bypasses
     * the opaque-result envelope fallback.
     */
    materializerWriteInputPaths?: readonly (readonly string[])[];

    /**
     * Transformer proof that this source-backed lift's cell surface is
     * exhaustively described by its structural bindings.  Absence means
     * unknown/incomplete; raw modules and handlers never receive this marker.
     */
    completeSchedulerScopeSummary?: true;

    /** Run this module's result in a specific space. */
    targetSpace?: MemorySpace;
  }
}

export function isModule(value: unknown): value is Module {
  return (
    (typeof value === "function" || typeof value === "object") &&
    value !== null && typeof (value as unknown as Module).type === "string"
  );
}

/**
 * A node in a pattern's execution graph.
 *
 * This shape is de facto compatible with {@link FabricExecPlainObject}, and is
 * intended to remain so. It deliberately does not intersect with that type,
 * because its string index signature would allow undeclared property names.
 */
export type Node = {
  description?: string;
  module: Module; // TODO(seefeld): Add `Alias` here once supported
  inputs: FabricExecValue;
  outputs: FabricExecValue;
};

export type DerivedInternalCellDescriptor = {
  partialCause: JSONValue;
  schema?: JSONSchema;
  scope?: CellScope;

  /**
   * Entity kind minted into the cell's id (preimage + visible tag). Set to
   * `"computed"` only when the builder proves the cell is written solely by
   * compute nodes. Participates in manifest matching: a kind change
   * re-materializes the cell under a new id. See
   * `docs/specs/computed-cell-identity.md`.
   */
  kind?: EntityKind;
};

declare module "@commonfabric/api" {
  interface Pattern {
    argumentSchema: JSONSchema;
    resultSchema: JSONSchema;
    derivedInternalCells?: DerivedInternalCellDescriptor[];
    result: FabricExecValue;
    nodes: Node[];
    // NOTE: `program` (rehydration source) and the derivation link to a
    // copy's original live in WeakMaps/WeakSets in ./pattern-metadata.ts (so
    // exported patterns can be frozen, and so no own property can carry
    // trust). Use get/setPatternProgram, noteDerivedCopy/resolveOriginal.
  }
}

export function isPattern(value: unknown): value is Pattern {
  return (
    (typeof value === "function" || typeof value === "object") &&
    value !== null &&
    (value as Pattern).argumentSchema !== undefined &&
    (value as Pattern).resultSchema !== undefined &&
    Array.isArray((value as Pattern).nodes)
  );
}

export type UnsafeBinding = {
  pattern: Pattern;
  materialize: (path: readonly PropertyKey[]) => any;
  space: MemorySpace;
  tx: IExtendedStorageTransaction;
  parent?: UnsafeBinding;
};

export type Frame = {
  parent?: Frame;
  cause?: unknown;
  generatedIdCounter: number;
  implementationIdentity?: ImplementationIdentity;
  runtime?: Runtime;
  tx?: IExtendedStorageTransaction;
  space?: MemorySpace;
  inHandler?: boolean;
  reactives: Set<Reactive<any>>;

  /**
   * Positive marker for the kind of authored pattern code running under this
   * frame: "handler" for an event handler, "lift" for a reactive computation
   * (lift/computed/derived/action). Absent for internal runner frames. Unlike
   * `inHandler`, this lets a guard distinguish a pattern lift from internal code
   * — both of which lack `inHandler` — without conflating them.
   */
  frameKind?: "lift" | "handler";

  /**
   * The wall-clock instant (ms) bound to the event that opened this handler
   * frame. A handler's ambient clock reads this FROZEN value, coarsened, rather
   * than the live wall clock, so time does not advance during a handler's own
   * work — reading it before and after an `await` yields the same value, which
   * denies a handler an intra-run clock. Events a handler emits carry this same
   * instant forward, so a whole causal chain from one gesture shares one time.
   * Only meaningful on handler frames.
   */
  eventTime?: number;

  unsafe_binding?: UnsafeBinding;

  /**
   * Marks a module-evaluation frame. Its presence is the whole signal: it is
   * how the action-execution guard admits the transformer's module-scope
   * builder mints while an action is suspended.
   */
  moduleEvaluation?: true;

  /**
   * Named/anonymous `PatternFactory.inSpace(...)` targets encountered during
   * this frame whose space DID was not yet cached. The runner resolves these
   * after the run and re-runs (see RetryImmediately).
   */
  pendingSpaceNames?: Set<string>;

  /** Per-frame counter giving each anonymous `inSpace()` call a stable name. */
  inSpaceCounter?: number;
};

/**
 * The type of the `commonfabric` module as pattern code sees it. A pattern
 * compiles against `types/commonfabric.d.ts`, which is `packages/api/index.ts`,
 * and the sandbox binds that same module name to the object `createBuilder()`
 * returns. So these declarations describe that object, and every value they
 * declare has to be there.
 *
 * `@commonfabric/api/schema` adds schema-carrying overloads to several of these
 * declarations by module augmentation, and this file imports it above, so those
 * overloads are part of what is required here.
 */
type DeclaredSurface = typeof DeclaredApi;

/**
 * The bindings whose implementation type does not satisfy the type
 * `@commonfabric/api` declares for them, each mapped to the type the binding
 * actually has. Every other name on the pattern surface is required to match
 * its declaration exactly, so this is the whole of what the compiler is not
 * checking.
 *
 * - `table` takes a column map, and a parameter is checked the other way round
 *   from a result: the declared `Record<string, SqliteColumnSpec>` has to be
 *   assignable to the implementation's own generic column map, which it is not.
 * - `cfSqlite` gathers `table` with the row-label helpers, whose declarations
 *   say `unknown` where the implementation says which label shape it takes. So
 *   the whole namespace is taken from the implementation, which is also what
 *   keeps its members agreeing with each other: a rule built from the helpers
 *   has to be one `table` accepts.
 * - `entityRefToString` and `valueEqual` come from `@commonfabric/data-model`
 *   and take fabric values as parameters, so the same reversal applies. The
 *   pattern-visible `FabricHash` and `FabricValue` are structural views of
 *   classes whose private fields no interface can carry, which is why no
 *   declaration can be assignable to them.
 * - `FabricKeyPair` is the one fabric class in the same position: its second
 *   constructor takes the key bytes, so the declared `FabricBytes` would have
 *   to be assignable to the class. Its instance side is compared, both here and
 *   by the `satisfies` beside the class.
 *
 * {@link StaleDriftingBinding} keeps this set from outliving its reasons.
 */
interface DriftingBindings {
  table: typeof table;
  cfSqlite:
    & Pick<
      typeof RowLabelHelpers,
      Exclude<keyof DeclaredSurface["cfSqlite"], "table" | "cfLink">
    >
    & { table: typeof table; cfLink: typeof cfLink };
  entityRefToString: typeof entityRefToString;
  valueEqual: typeof valueEqual;
  FabricKeyPair: typeof FabricKeyPair;
}

/**
 * A member of {@link DriftingBindings} whose implementation has come back into
 * line with its declaration. Such a member no longer needs an entry, and the
 * assertion below stops compiling until the entry is removed -- so the set can
 * only shrink.
 */
type StaleDriftingBinding = {
  [K in keyof DriftingBindings]: DriftingBindings[K] extends DeclaredSurface[K]
    ? K
    : never;
}[keyof DriftingBindings];

/** Fails to compile when `T` is anything but `never`. */
type AssertNever<T extends never> = T;

/** Fails to compile unless `Bound` satisfies `Declared`. */
type AssertSatisfies<Bound extends Declared, Declared> = Bound;

export type NoStaleDriftingBindings = AssertNever<StaleDriftingBinding>;

/**
 * `pattern` is the one name below written out because its binding is a
 * different type rather than a richer one, so it is the one name the interface
 * cannot check for itself. This says what the two still have in common:
 * whatever else `PatternBuilder` carries, a pattern author's call has to be one
 * `PatternFunction` describes.
 */
export type PatternBuilderSatisfiesDeclaration = AssertSatisfies<
  PatternBuilder,
  DeclaredSurface["pattern"]
>;

/**
 * Every declared name the interface below does not require, written out.
 *
 * This was once two rules -- drop a `unique symbol`, drop anything the CFC
 * authoring vocabulary also exports -- which read well and were the wrong
 * shape. A rule reaches as far as it reaches, so a declaration that fell
 * through one would not fail; it would quietly stop being required, which is
 * the one outcome all of this exists to prevent. `SELF` was the standing proof:
 * a `unique symbol` and so a brand by that rule, yet a real value a pattern
 * reads, required only because someone noticed and wrote it back in.
 *
 * Written out instead, the default is the safe one. A declaration is required
 * unless it appears here, so a new one is checked without anyone deciding
 * anything, and exempting one is a visible edit to this list with its reason
 * beside it.
 */
type IntentionallyUnrequired =
  // Brands. Each keys a branded type and has no runtime existence.
  | "CELL_BRAND"
  | "CELL_INNER_TYPE"
  | "CELL_LIKE"
  | "CELL_RESULT_TYPE"
  | "DEFAULT_MARKER"
  | "FRAMEWORK_PROVIDED_MARKER"
  | "SCOPE_BRAND"
  | "SQLITE_DB_BRAND"
  // The CFC authoring vocabulary. `packages/api/index.ts` re-exports the types
  // out of `cfc.ts` with `export type *`, and TypeScript carries the value
  // meaning of those names into the module's type even though nothing is
  // re-exported at runtime. Their runtime home is `commonfabric/cfc`, bound
  // alongside this module in `sandbox/runtime-modules.ts`. Not
  // `CFC_CANONICAL_ALIAS_NAMES`, which `index.ts` re-exports as a value, so a
  // pattern reaches that one through `commonfabric` and it is required.
  | "CFC_ATOM_TYPE"
  | "CFC_COMPILED_BY_ATOM"
  | "CFC_COMPILED_BY_ATOM_PREFIX"
  | "CFC_CONCEPT_KIND"
  | "CFC_FUSE_ATOM_CLASS"
  | "CFC_RUNTIME_SUBJECT"
  | "THIS_POLICY"
  | "cfcAtom"
  | "cfcPattern"
  | "exchangeRule"
  | "exchangeRules"
  | "v";

/**
 * A name exempted above that `@commonfabric/api` no longer declares. Its entry
 * exempts nothing, and is either a typo or what a removed declaration left
 * behind, so this stops compiling until the entry goes.
 */
export type NoStaleIntentionallyUnrequired = AssertNever<
  Exclude<IntentionallyUnrequired, keyof DeclaredSurface>
>;

/**
 * The `commonfabric` module the sandbox hands a pattern.
 *
 * Every value `@commonfabric/api` declares is required here, with the declared
 * type, because that is what a pattern was type-checked against: a declaration
 * with no binding behind it compiles and then reads as `undefined` when the
 * pattern runs. What the members below add to that is a binding whose type says
 * more than the declaration does, and the bindings a pattern cannot name at
 * all.
 */
export interface BuilderFunctionsAndConstants extends
  Omit<
    DeclaredSurface,
    IntentionallyUnrequired | keyof DriftingBindings | "pattern"
  >,
  DriftingBindings {
  /**
   * Carries the pattern-building methods (`inSpace`, and the rest) alongside
   * the call signature `PatternFunction` declares.
   */
  pattern: PatternBuilder;

  // The rest of this interface is what the sandbox binds beyond what
  // `@commonfabric/api` declares. Pattern source cannot name any of it: the
  // assert-diagnostics transformer reaches the two operand recorders through
  // the injected `__cfHelpers` object, JSX lowering emits calls to `h`, and the
  // two schemas are read by the runner rather than by pattern code.
  assertCapture: AssertCaptureFunction;
  assertRenderParts: AssertRenderPartsFunction;
  h: HFunction;
  AuthSchema: typeof AuthSchema;
  WebhookConfigSchema: typeof WebhookConfigSchema;
}

// Runtime interface needed by createCell
export interface BuilderRuntime {
  getCell<T>(
    space: MemorySpace,
    cause: any,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    cause: any,
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
}

// Factory function to create builder with runtime
export type CreateBuilder = (
  runtime: BuilderRuntime,
  getCellOrThrow?: (value: any) => any,
) => BuilderFunctionsAndConstants;
