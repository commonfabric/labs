/**
 * Factory function to create builder functions with runtime dependency injection
 */

import {
  FabricInstance,
  FabricPrimitive,
  toCompactDebugString,
  toIndentedDebugString,
  valueEqual,
} from "@commonfabric/data-model";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import {
  FabricError,
  FabricLink,
} from "@commonfabric/data-model/fabric-instances";
import {
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  fabricPrimitiveClassesByName,
  isFabricPrimitiveSchemaType,
} from "@commonfabric/data-model/fabric-primitives";
import {
  all as rowLabelAll,
  any as rowLabelAny,
  authoredBy as rowLabelAuthoredBy,
  constant as rowLabelConstant,
  dbOwner as rowLabelDbOwner,
  endorsedBy as rowLabelEndorsedBy,
  intersect as rowLabelIntersect,
  match as rowLabelMatch,
  principal as rowLabelPrincipal,
  whenMatches as rowLabelWhenMatches,
} from "@commonfabric/memory/sqlite/row-label";
import { cfLink, table } from "@commonfabric/memory/sqlite/schema";

import { cellConstructorFactory } from "../cell.ts";
import { renderCellReference } from "../cell-reference.ts";
import { getEntityId } from "../create-ref.ts";
import type { RuntimeProgram } from "../harness/types.ts";
import { freezeVerifiedPlainData } from "../sandbox/plain-data.ts";
import {
  registerUnsafeHostTrustedValue,
  type UnsafeHostTrust,
} from "../unsafe-host-trust.ts";
import {
  cellFromUrl,
  compileAndRun,
  fetchBinary,
  fetchJson,
  fetchJsonUnchecked,
  fetchProgram,
  fetchText,
  generateObject,
  generateText,
  ifElse,
  inspectConfLabel,
  llm,
  llmDialog,
  navigateTo,
  patternTool,
  sqliteDatabase,
  sqliteQuery,
  str,
  streamData,
  uiVariant,
  unless,
  when,
  wish,
} from "./built-in.ts";
import { tagCollectionKey } from "./collection-key.ts";
import { getPatternEnvironment } from "./env.ts";
import { h, UiAction, UiDisclosure, UiPromptSlot } from "./h.ts";
import {
  action,
  assert,
  assertCapture,
  assertRenderParts,
  byRef,
  computed,
  handler,
  lift,
} from "./module.ts";
import { isTrustedPattern, setPatternProgram } from "./pattern-metadata.ts";
import { pattern } from "./pattern.ts";
import type {
  BuilderFunctionsAndConstants,
  ToSchemaFunction,
} from "./types.ts";
import {
  AsCell,
  AsComparableCell,
  AsOpaqueCell,
  AsReadonlyCell,
  AsStream,
  AsWriteonlyCell,
  AuthSchema,
  CHIP_UI,
  FS,
  NAME,
  schema as schemaIdentity,
  SELF,
  TESTS,
  TILE_UI,
  TYPE,
  UI,
  VIEWS,
  WebhookConfigSchema,
} from "./types.ts";
import {
  CFC_CANONICAL_ALIAS_NAMES,
  FABRIC_INSTANCE_PLUS_BRAND,
  FABRIC_PRIMITIVE_BRAND,
  MERGEABLE_OP_METHODS,
} from "@commonfabric/api";

// Runtime implementation of toSchema - this should never be called
// The TypeScript transformer should replace all calls at compile time
const toSchema: ToSchemaFunction = (_options?) => {
  throw new Error(
    "toSchema() must be transformed at compile time - transformer not running\n" +
      "help: the CTS transforms run as part of the Common Fabric build process; check that you are compiling through it",
  );
};

const runtimeSchema = freezeVerifiedPlainData as typeof schemaIdentity;

export interface CreateBuilderOptions {
  unsafeHostTrust?: UnsafeHostTrust;
}

/**
 * Creates a set of builder functions with the given runtime
 * @returns An object containing all builder functions
 */
export const createBuilder = (options: CreateBuilderOptions = {}): {
  commonfabric: BuilderFunctionsAndConstants;
  exportsCallback: (exports: Map<any, RuntimeProgram>) => void;
} => {
  const trustValue = <T>(value: T): T => {
    registerUnsafeHostTrustedValue(options.unsafeHostTrust, value);
    return value;
  };

  const trustedPattern = ((...args: any[]) =>
    trustValue(
      (pattern as (...args: any[]) => unknown)(...args),
    )) as typeof pattern;
  const trustedLift = ((...args: any[]) =>
    trustValue(
      (lift as (...args: any[]) => unknown)(...args),
    )) as typeof lift;
  const trustedHandler = ((...args: any[]) =>
    trustValue(
      (handler as (...args: any[]) => unknown)(...args),
    )) as typeof handler;
  const trustedComputed = ((...args: any[]) =>
    trustValue(
      (computed as (...args: any[]) => unknown)(...args),
    )) as typeof computed;
  const trustedAssert = ((...args: any[]) =>
    trustValue(
      (assert as (...args: any[]) => unknown)(...args),
    )) as typeof assert;
  const trustedStr =
    ((strings: TemplateStringsArray, ...values: unknown[]) =>
      trustValue(str(strings, ...values))) as typeof str;
  const trustedPatternTool = ((...args: any[]) =>
    trustValue(
      (patternTool as (...args: any[]) => unknown)(...args),
    )) as typeof patternTool;

  // Associate runtime programs with patterns after compilation and initial eval
  // and before compilation returns, so before any e.g. pattern would be
  // instantiated. This way they get saved with a way to rehydrate them.
  const exportsCallback = (exports: Map<any, RuntimeProgram>) => {
    for (const [value, program] of exports) {
      // `isTrustedPattern` (not the structural `isPattern`): only a value the
      // trusted builder produced may acquire a rehydration program, so a
      // `__cf_data`-forged pattern-shaped export cannot launder trust metadata.
      if (isTrustedPattern(value)) {
        // Associate the program with the pattern via the side-table so it works
        // even when the exported pattern has been frozen by the loader.
        setPatternProgram(value, program);
      }
    }
  };

  // Annotated rather than cast, so the object literal is checked against the
  // declarations a pattern compiles against: a missing binding, a binding whose
  // type has drifted from its declaration, and a binding nothing declares are
  // each an error here. `__cfHelpers` is the one member that cannot be written
  // in the literal, because its value is the literal.
  const surface: Omit<BuilderFunctionsAndConstants, "__cfHelpers"> = {
    // Pattern creation
    pattern: trustedPattern,
    patternTool: trustedPatternTool,

    // Module creation
    lift: trustedLift,
    handler: trustedHandler,
    action,
    computed: trustedComputed,
    assert: trustedAssert,

    // Operand recording for transformer-instrumented `assert` bodies. Plain
    // data in, plain data out — no builder artifact to trust. `assertCapture`
    // stashes each operand's value; `assertRenderParts` renders them only when
    // the assertion failed.
    assertCapture,
    assertRenderParts,

    // Built-in modules
    str: trustedStr,
    ifElse,
    when,
    unless,
    uiVariant,
    llm,
    llmDialog,
    generateObject,
    generateText,
    fetchBinary,
    cellFromUrl,
    renderCellReference,
    fetchText,
    fetchJson,
    fetchJsonUnchecked,
    fetchProgram,
    streamData,
    compileAndRun,
    // Placeholder for the per-module binding. A graph carrying data files hands
    // each module its own copy of this namespace, whose reader is closed over
    // that load's files and that module's path (see
    // `compileSourcesToRecords`). Reaching this body means the module is
    // running outside a graph that carries any.
    dataFile: (path: string): string => {
      throw new Error(
        `No attached data file "${path}": this pattern was loaded without a ` +
          `data-file closure.`,
      );
    },
    sqliteDatabase,
    sqliteQuery,
    table,
    cfLink,
    // The SQLite helper namespace — one import for the growing vocabulary:
    // `const { table, all, principal, match, … } = cfSqlite`. The row-label
    // helpers (CFC Phase 3) live only here. There is deliberately no bare
    // `when`/`matches`: the builder's control-flow `when` lowering matches by
    // NAME and would mangle a local so named — the fused `whenMatches` avoids
    // the collision class entirely.
    cfSqlite: {
      table,
      cfLink,
      match: rowLabelMatch,
      principal: rowLabelPrincipal,
      all: rowLabelAll,
      any: rowLabelAny,
      intersect: rowLabelIntersect,
      whenMatches: rowLabelWhenMatches,
      dbOwner: rowLabelDbOwner,
      endorsedBy: rowLabelEndorsedBy,
      authoredBy: rowLabelAuthoredBy,
      constant: rowLabelConstant,
    },
    navigateTo,
    // inv-12 Stage 2: bounded first-layer label introspection (§4.6.4.1).
    inspectConfLabel,
    wish,

    // Multi-user test descriptor tag (see api MultiUserTestDescriptor):
    // identity at runtime; the call expression keeps the descriptor's pattern
    // factories out of module-level plain-data hardening.
    multiUserTest: <T>(descriptor: T): T => descriptor,

    // Cell creation
    cell: cellConstructorFactory<AsCell>("cell").of,
    equals: cellConstructorFactory<AsCell>("cell").equals,

    // Cell constructors with static methods
    Cell: cellConstructorFactory<AsCell>("cell"),
    Writable: cellConstructorFactory<AsCell>("cell"), // Alias for Cell with clearer semantics
    OpaqueCell: cellConstructorFactory<AsOpaqueCell>("opaque"),
    Stream: cellConstructorFactory<AsStream>("stream"),
    ComparableCell: cellConstructorFactory<AsComparableCell>("comparable"),
    ReadonlyCell: cellConstructorFactory<AsReadonlyCell>("readonly"),
    WriteonlyCell: cellConstructorFactory<AsWriteonlyCell>("writeonly"),

    // Utility
    byRef,

    // Environment
    getPatternEnvironment,

    // Entity utilities
    getEntityId,
    entityRefToString,

    // Constants
    SELF,
    TYPE,
    NAME,
    UI,
    TILE_UI,
    CHIP_UI,
    FS,
    TESTS,
    VIEWS,

    // Schema utilities
    schema: runtimeSchema,
    toSchema,
    __cf_data: freezeVerifiedPlainData,
    AuthSchema,
    WebhookConfigSchema,

    // The schema `type` vocabulary of the primitive classes, which
    // `@commonfabric/api` declares and the data model implements.
    FABRIC_PRIMITIVE_SCHEMA_TYPES,
    isFabricPrimitiveSchemaType,

    // The names `@commonfabric/api` both declares and implements, passed
    // through so a pattern that imports one reads the value rather than
    // `undefined`: the sandbox resolves `commonfabric` to this object, not to
    // that module.
    FABRIC_INSTANCE_PLUS_BRAND,
    FABRIC_PRIMITIVE_BRAND,
    MERGEABLE_OP_METHODS,
    CFC_CANONICAL_ALIAS_NAMES,

    // Render utils
    h,
    UiAction,
    UiPromptSlot,
    UiDisclosure,

    // The special-object classes -- runtime values backing the type
    // declarations in data-model/src/api.ts. Enables `new FabricEpochNsec(...)`
    // and `instanceof` checks in patterns. `FabricInstance` and
    // `FabricPrimitive` are abstract; they are bound for `instanceof` only.
    // The concrete primitive classes arrive under the names `api.ts` declares
    // them by.
    FabricInstance,
    FabricPrimitive,
    ...fabricPrimitiveClassesByName(),
    FabricLink,
    FabricError,

    // Debug stringifiers (helpers exposed for pattern code)
    toCompactDebugString,
    toIndentedDebugString,

    // Value comparison helper exposed for pattern code
    valueEqual,
    tagCollectionKey,
  };

  // The helpers object the transformer's output reaches for is this same
  // surface, so it can only be attached once the surface exists.
  const commonfabric: BuilderFunctionsAndConstants = Object.assign(surface, {
    __cfHelpers: surface,
  });

  return {
    commonfabric,
    exportsCallback,
  };
};
