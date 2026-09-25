import type {
  AnyBrandedCell,
  CollectionIndexData,
  CollectionIndexKey,
  CollectionIndexKeyEntry,
  GroupIndex,
  KeyIndex,
  ReadonlyCell,
} from "@commonfabric/api";
import {
  assertValidFabricValueLayer,
  cloneIfNecessary,
  deepFreeze,
  type FabricConvertibleJsValue,
  fabricFromConvertibleJsValue,
  FabricInstance,
  FabricPrimitive,
  type FabricValue,
  type FabricValueLayer,
  hashStringOf,
  isFabricSpecialObject,
  refuseFabricInstance,
  shallowCleanArray,
  shallowCleanPlainObject,
  shallowFabricFromConvertibleJsObjectElseUndefined,
  valueEqual,
} from "@commonfabric/data-model";
import {
  type EntityRef,
  entityRefFromString,
  linkRefFrom,
} from "@commonfabric/data-model/cell-rep";
import {
  deepFrozenCloneAndInternSchema,
  internSchema,
  isInternedSchema,
} from "@commonfabric/data-model-schema";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { isCfLinkColumn } from "@commonfabric/memory/sqlite/columns";
import {
  type ScopeKeyIdentity,
  type SqliteDbRef,
  type SqliteParamsWire,
  streamEntriesDocId,
  type StreamLinkRef,
} from "@commonfabric/memory/v2";
import type { OutboxAppendRow } from "@commonfabric/memory/v2/execution-outbox";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { ensureNotRenderThread } from "@commonfabric/utils/env";
import { IndexTrackingStack } from "@commonfabric/utils/index-tracking-stack";
import { getLogger } from "@commonfabric/utils/logger";
import {
  type Immutable,
  isObjectNotArray,
  isObjectOrArray,
  isPlainContainer,
} from "@commonfabric/utils/types";

import { toCell } from "./back-to-cell.ts";
import {
  collectionKeyBucket,
  resolveCollectionKey,
} from "./builtins/collection-index-key.ts";
import { createNodeFactory, lift } from "./builder/module.ts";
import { assertNoReservedCauseKeys, getTopFrame } from "./builder/pattern.ts";
import {
  type AnyCell,
  type AnyCellWrapping,
  type Apply,
  type Cell,
  type CellKind,
  type CellScope,
  type CellTypeConstructor,
  type FactoryInput,
  type Frame,
  type HKT,
  type ICell,
  isReactiveMarker,
  type IsThisObject,
  type IStreamable,
  type JSONSchema,
  type Module,
  type NodeFactory,
  type NodeRef,
  type OpaqueCell,
  type PatternFactory,
  type Reactive,
  type Schema,
  SELF,
  type Stream,
  STREAM_MARKER_KEY,
  type StripDefaultBrand,
} from "./builder/types.ts";
import type { AggregateOperation } from "./builtins/aggregate.ts";
import { listResultSchema } from "./builtins/list-result-schema.ts";
import { encodeCellToSigilString } from "./builtins/sqlite/cf-link-codec.ts";
import { sqliteQueryNodeFactory } from "./builtins/sqlite/query-node.ts";
import { checkSqliteRowLabelWrite } from "./builtins/sqlite/row-label-write.ts";
import { checkSqliteWriteCeiling } from "./builtins/sqlite/write-ceiling.ts";
import { type Cancel, isCancel, useCancelGroup } from "./cancel.ts";
import { ContextualFlowControl, declaredSchemaScope } from "./cfc.ts";
import {
  type CfcLabelView,
  cfcLabelViewForDereferenceTraces,
  cfcLabelViewSymbol,
  cloneCfcLabelView,
  getCarriedCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./cfc/label-view-state.ts";
import {
  cfcLabelViewForCell,
  cfcLabelViewForResolvedCell,
  redactCaveatSourcesForDisplay,
} from "./cfc/label-view.ts";
import { setLinkCfcLabelView } from "./cfc/link-label-view.ts";
import {
  readStoredCfcMetadata,
  storedCfcMetadataAppliesToPath,
} from "./cfc/metadata.ts";
import { cfcConfidentialityForObservationNode } from "./cfc/observation.ts";
import { cfcSchemaWithInheritedDefs } from "./cfc/schema-refs.ts";
import { recordSinkRequestPolicyInput } from "./cfc/sink-request.ts";
import {
  isRendererTrustedEvent,
  propagateRendererTrustedEvent,
} from "./cfc/ui-contract.ts";
import { createRef } from "./create-ref.ts";
import { diffAndUpdate } from "./data-updating.ts";
import {
  dataUriFromValueWithResolvedLinks,
  findAndInlineDataUriLinks,
} from "./data-uri.ts";
import { actingForEmission, waveRunContextOf } from "./executor/wave.ts";
import { type LastNode, resolveLink } from "./link-resolution.ts";
import { areNormalizedLinksSame } from "./link-types.ts";
import {
  areLinksSame,
  createSigilLinkFromParsedLink,
  declareStreamSchema,
  isCellLink,
  KeepAsCell,
  type NormalizedFullLink,
  type NormalizedLink,
  parseLink,
  toMemorySpaceAddress,
} from "./link-utils.ts";
import { type MetaField, type RawMetaWriteAuthorization } from "./meta-seam.ts";
import {
  type CellResult,
  createQueryResultProxy,
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import type { Runtime } from "./runtime.ts";
import {
  type Action,
  ignoreReadForScheduling,
  txToReactivityLog,
} from "./scheduler.ts";
import { mintEventId, scopeCallerEventId } from "./scheduler/event-identity.ts";
import {
  type CellViewRef,
  processDefaultValue,
  resolveSchema,
  schemaHasIfc,
  validateAndTransform,
} from "./schema.ts";
import { isCellScope, narrowerScopeCap, normalizeCellScope } from "./scope.ts";
import {
  type SigilLink,
  type SigilWriteRedirectLink,
  type URI,
} from "./sigil-types.ts";
import { speculationRunContextOf } from "./speculation/overlay-destination.ts";
import { flattenBuilderArtifacts } from "./storage-preflight.ts";
import {
  createChildCellTransaction,
  createNonReactiveTransaction,
} from "./storage/extended-storage-transaction.ts";
import type {
  ChangeGroup,
  EventAppendDeliveryOutcome,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IReadOptions,
  Metadata,
} from "./storage/interface.ts";
import { usesLocalReads } from "./storage/local-read-policy.ts";
import {
  allowMutableTransactionRead,
  internalVerifierRead,
  markReadAsAttemptedWrite,
  mergeableOpRead,
  writeDestinationRead,
} from "./storage/reactivity-log.ts";
import { fromURI, toURI } from "./uri-utils.ts";

ensureNotRenderThread();

const logger = getLogger("cell", { level: "warn" });

const markDocumentSynced = Symbol("markDocumentSynced");

type SinkOptions = {
  changeGroup?: ChangeGroup;

  /**
   * Read-only host subscription for values and metadata. Its query and callback
   * child-cell reads use independent read-only transactions; writes through
   * delivered cells fail. Stream listeners create no subscription transaction.
   * @internal
   */
  readOnly?: boolean;

  /**
   * Read the cell's display CFC label as part of the sink's tracked read set
   * and pass it to the callback as a second argument. Reading it on the sink's
   * transaction makes the cfc-metadata path a reactive dependency, so a
   * label-only write (value unchanged) re-fires the sink — the basis for
   * reactive label delivery over a subscription. Off by default.
   */
  includeCfcLabel?: boolean;
};

export type RawCellReadOptions = IReadOptions & {
  /**
   * Controls whether `getRaw()` follows a final link at the cell's target.
   *
   * Defaults to `"top"`: links on the way to the target are resolved, and a
   * final link is returned as data rather than followed.
   */
  lastNode?: LastNode;
};

// Shared factory instances for all cells
let aggregateFactory: NodeFactory<any, any> | undefined;

let mapFactory: NodeFactory<any, any> | undefined;
let filterFactory: NodeFactory<any, any> | undefined;
let flatMapFactory: NodeFactory<any, any> | undefined;

/** Builds one named aggregate node with its scalar result schema. */
function createAggregate<T>(
  list: unknown,
  operation: AggregateOperation,
  elements?: unknown,
): Reactive<T> {
  aggregateFactory ??= createNodeFactory({
    type: "ref",
    implementation: "aggregate",
  });
  const result = aggregateFactory({ list, operation, elements });
  if (operation !== "minBy" && operation !== "maxBy") {
    result.setSchema(schemaCarryingLinkIfc(result, { type: "number" }));
  }
  return result;
}

/**
 * Error thrown by the function-form `.map`/`.filter`/`.flatMap` on an
 * Reactive/Cell. These wrapped the callback in an anonymous inline pattern,
 * which has no stable content-addressed `{ identity, symbol }` and so cannot be
 * passed/persisted by identity (CT-1623). Authored pattern code is always
 * lowered by the TS transformer to the `*WithPattern(pattern(...), params)` form
 * (with the pattern hoisted to a module export); direct builder-API callers must
 * use the `*WithPattern` variant explicitly.
 */
function throwOpFunctionFormMessage(
  method:
    | "map"
    | "filter"
    | "flatMap"
    | "count"
    | "minBy"
    | "maxBy"
    | "groupBy"
    | "keyBy",
): string {
  return `Reactive.${method}(fn) is no longer supported: an inline pattern has ` +
    `no stable identity. Authored \`.${method}(...)\` is lowered by the TS ` +
    `transformer to \`.${method}WithPattern(pattern(...), { params })\`; if you ` +
    `are calling the builder API directly, use \`.${method}WithPattern(op, params)\`.`;
}

// WeakMap to store connected nodes for each cell instance
const cellNodes = new WeakMap<OpaqueCell<unknown>, Set<NodeRef>>();

const recordSchemaWritePolicyInput = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  schema: JSONSchema | undefined,
  schemaRole?: "output",
): void => {
  const resolvedSchema = resolveSchema(schema) ??
    storedSchemaForWritePolicyInput(tx, link);
  if (resolvedSchema === undefined) {
    return;
  }
  const schemaAndHash = internSchema(resolvedSchema, true);
  tx.recordCfcWritePolicyInput({
    kind: "schema",
    target: {
      space: link.space,
      id: link.id,
      scope: link.scope,
      path: [...link.path],
    },
    schemaHash: schemaAndHash.taggedHashString,
    schema: schemaAndHash.schema,
    ...(schemaRole !== undefined && { schemaRole }),
  });
};

const storedSchemaForWritePolicyInput = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
): JSONSchema | undefined => {
  // A `StoredCfcMetadataError` propagates, deliberately: a stored envelope
  // this build cannot produce labels from fails the read loudly rather
  // than serving the document schemaless.
  const metadata = readStoredCfcMetadata(tx, link);
  if (metadata === undefined) {
    return undefined;
  }
  const stored = tx.readOrThrow({
    space: link.space,
    id: `cid:${metadata.schemaHash}` as URI,
    type: "application/json",
    path: [],
  }, {
    meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
  });
  if (!isObjectOrArray(stored) || stored.value === undefined) {
    return undefined;
  }
  return ContextualFlowControl.getSchemaAtPath(
    stored.value as JSONSchema,
    [...link.path],
  );
};

export const recordRelevantSchemaWritePolicyInput = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  schema: JSONSchema | undefined,
  schemaRole?: "output",
): void => {
  const resolvedSchema = resolveSchema(schema);
  const cfcRelevant = schemaHasIfc(resolvedSchema) ||
    storedCfcMetadataAppliesToPath(tx, link);
  if (!cfcRelevant) {
    return;
  }
  tx.markCfcRelevant(`schema-ifc-write:${link.id}`);
  recordSchemaWritePolicyInput(
    tx,
    link,
    schemaHasIfc(resolvedSchema) ? resolvedSchema : undefined,
    schemaRole,
  );
};

/**
 * Internal-only stream-send options.
 *
 * `eventId` is a caller-supplied durable event id (verb contract WS-D): a
 * retry naming the same id and session collides on the handling's create-only
 * receipt.
 *
 * `session` names the caller that chose that `eventId`, and is REQUIRED
 * alongside it — a send naming an id without one is refused. An ingress
 * caller's id is its own word — an agent picks `add-comment-1` — and two
 * agents can pick the same word for two different calls on one verb, so the
 * id alone does not say whose invocation it is; the session does. Both are
 * inputs to {@link scopeCallerEventId}, so the pair, and not the id, is what
 * decides where a handling's receipt lands.
 *
 * `runtimeInjectedEventKeys` names payload keys the RUNTIME itself merged
 * into this send's event value (the LLM tool-call path injects a `result`
 * cell: `builtins/llm-dialog.ts` sends `{ ...input, result }`). The
 * dispatch-side closed-world gate exempts exactly these keys — and only
 * these — from an `additionalProperties: false` event schema. The marker is
 * PROVENANCE, not shape, and must stay unforgeable: it rides this
 * in-process options argument, never the event value, so no remote or CLI
 * caller can express it — payloads are plain data, and the CLI's invocation
 * engine (`executeResolvedCallable`, packages/cli/lib/callable.ts) builds the
 * send options itself and puts only the caller's id and session in them.
 * In-process callers are gated too: the value must be an array MINTED by
 * {@link markRuntimeInjectedEventKeys} — the stream-send path drops any other
 * value — and the mint lives in runner internals no pattern compartment can
 * import, so sandboxed pattern code holding a real stream cell still cannot
 * smuggle an undeclared key past closed-world by passing a plain array here.
 * Adding any data-expressible way to set it would reopen the
 * accepted-and-ignored hole C5 closes.
 */
export type StreamSendOptions = {
  eventId?: string;
  session?: string;
  runtimeInjectedEventKeys?: readonly string[];

  /**
   * Fires once the sender's own authored act is durable, ahead of the
   * commit callback: under server execution that act is the event append
   * (events.md §1), and the handling the server runs for it settles the
   * commit callback later; otherwise the act is the handling's own
   * commit, and the two fire together. A caller that only needs its event
   * on the record waits here and not for the handling.
   */
  onAppended?: (
    delivery: EventAppendDeliveryOutcome,
    tx: IExtendedStorageTransaction,
  ) => void;
};

// The mint registry backing `runtimeInjectedEventKeys` (see
// StreamSendOptions): membership here is the capability. Only code that can
// call `markRuntimeInjectedEventKeys` — runner-internal modules and
// same-package tests; never a pattern compartment, whose module graph cannot
// import runner internals — can produce an array the send path accepts.
const mintedRuntimeInjectedKeys = new WeakSet<readonly string[]>();

/**
 * Mint an injection-provenance marker for {@link StreamSendOptions}. The
 * returned (frozen) array is the capability: `Cell.set`'s stream branch
 * forwards `runtimeInjectedEventKeys` to dispatch only when it was minted
 * here, so an unminted array — anything a spoofing caller can construct —
 * is ignored and the closed-world gate judges the key like any other
 * undeclared field.
 */

/** An error-status VIEW of a transaction (the durable-ack coupling;
 * verdict blocker, 2026-08-12): everything passes through except
 * `status()`, which reports the append/consequence failure — so a
 * caller that reads the settle callback's tx as the durable
 * acknowledgment (the CLI verb dispatch's verb-contract Settlement
 * read) sees the authoritative failure instead of the speculative
 * echo's local state. */
const errorStatusTxView = (
  tx: IExtendedStorageTransaction,
  message: string,
): IExtendedStorageTransaction => {
  const status = () => {
    const real = tx.status();
    return {
      ...real,
      status: "error" as const,
      error: Object.assign(new Error(message), {
        name: "EventDeliveryError",
      }),
    };
  };
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === "status") return status;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as IExtendedStorageTransaction;
};

export function markRuntimeInjectedEventKeys(
  keys: readonly string[],
): readonly string[] {
  const minted = Object.freeze([...keys]);
  mintedRuntimeInjectedKeys.add(minted);
  return minted;
}

/**
 * Validate PERSISTED runtime-injected-key carriage before re-minting
 * (verdict blocker, 2026-08-12): engine admission refuses malformed
 * carriage at the door, but rows persisted before that guard (or by a
 * corrupted store) can still surface here — and a non-array value
 * would throw inside `markRuntimeInjectedEventKeys`'s spread on EVERY
 * drain pass, churning the serving loop forever on one poisoned
 * entry. Malformed carriage degrades to ABSENT: the closed-world gate
 * then judges the payload keys strictly, exactly as it already treats
 * an unminted (spoofed) array.
 */
export function sanitizeRuntimeInjectedEventKeys(
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    Array.isArray(value) && value.every((key) => typeof key === "string")
  ) {
    return value as readonly string[];
  }
  return undefined;
}

const mintedRuntimeInjectedEventKeys = (
  keys: readonly string[] | undefined,
): readonly string[] | undefined =>
  keys !== undefined && mintedRuntimeInjectedKeys.has(keys) ? keys : undefined;

/**
 * Module augmentation for runtime-specific cell methods.
 * These augmentations add implementation details specific to the runner runtime.
 */
declare module "@commonfabric/api" {
  /**
   * Augment Writable to add runtime-specific write methods with onCommit callbacks
   */
  interface IWritable<T, C extends AnyBrandedCell<any>> {
    set(
      value: AnyCellWrapping<T> | T,
      onCommit?: (tx: IExtendedStorageTransaction) => void,
      sendOptions?: StreamSendOptions,
    ): C;
  }

  /**
   * Augment Streamable to add onCommit callback and internal send-options
   * support ({@link StreamSendOptions} — the caller's event id and session,
   * and the runtime-injected key marker). Event is optional only when T is
   * void (matching public API).
   */
  interface IStreamable<T> {
    send(
      ...args: T extends void ? [] | [AnyCellWrapping<T> | T] | [
          AnyCellWrapping<T> | T,
          (tx: IExtendedStorageTransaction) => void,
        ] | [
          AnyCellWrapping<T> | T,
          ((tx: IExtendedStorageTransaction) => void) | undefined,
          StreamSendOptions,
        ]
        : [AnyCellWrapping<T> | T] | [
          AnyCellWrapping<T> | T,
          (tx: IExtendedStorageTransaction) => void,
        ] | [
          AnyCellWrapping<T> | T,
          ((tx: IExtendedStorageTransaction) => void) | undefined,
          StreamSendOptions,
        ]
    ): void;
  }

  /**
   * Augment Cell to add all internal/system methods that are available
   * on Cell in the runner runtime.
   */
  interface IAnyCell<out T> {
    asSchema<S extends JSONSchema = JSONSchema>(
      schema: S,
    ): Cell<Schema<S>>;
    asSchema<T>(
      schema?: JSONSchema,
    ): Cell<T>;
    asSchemaFromLinks<T = unknown>(): Cell<T>;
    withTx(tx?: IExtendedStorageTransaction): Cell<T>;
    sink(
      callback: (
        value: Readonly<T>,
        cfcLabel?: CfcLabelView | undefined,
      ) => Cancel | undefined | void,
      options?: SinkOptions,
    ): Cancel;
    getMetaRaw(
      metaField: MetaField,
      options?: IReadOptions,
    ): FabricValue | undefined;
    setMetaRaw(
      metaField: MetaField,
      value: FabricValue,
      authorization: RawMetaWriteAuthorization,
    ): void;
    sinkMeta(
      metaField: MetaField,
      callback: (value: FabricValue) => Cancel | undefined | void,
      options?: SinkOptions,
    ): Cancel;
    sync(): Promise<Cell<T>>;
    pull(): Promise<Readonly<T>>;
    getAsQueryResult<Path extends PropertyKey[]>(
      path?: Readonly<Path>,
      tx?: IExtendedStorageTransaction,
    ): CellResult<DeepKeyLookup<T, Path>>;
    getAsNormalizedFullLink(): NormalizedFullLink;
    getAsLink(
      options?: {
        base?: Cell<any>;
        baseSpace?: MemorySpace;
        includeSchema?: boolean;
        keepAsCell?: KeepAsCell;
      },
    ): SigilLink;
    getAsWriteRedirectLink(
      options?: {
        base?: Cell<any>;
        baseSpace?: MemorySpace;
        includeSchema?: boolean;
        keepAsCell?: KeepAsCell;
      },
    ): SigilWriteRedirectLink;
    getRaw(options?: RawCellReadOptions): Immutable<T> | undefined;

    /**
     * Reads the cell's raw value as a `FabricValue`, bypassing the
     * cell's type parameter `T`. Use this when the stored data may not
     * conform to `T` (e.g., `SigilLink` references, stream markers).
     *
     * By default (or with `{ frozen: true }`), returns a deep-frozen
     * `FabricValue`. Pass `{ frozen: false }` to get a mutable
     * deep copy instead.
     *
     * Prefer `getRaw()` when the value is expected to match `T`.
     */
    getRawUntyped(
      options?: RawCellReadOptions & { frozen?: true },
    ): FabricValue;
    getRawUntyped(
      options: RawCellReadOptions & { frozen: false },
    ): FabricValue;
    getRawUntyped(options?: RawCellReadOptions): FabricValue;

    setRaw(value: (NoInfer<T> & FabricValue) | undefined): void;

    /**
     * Sets the raw cell value to any `FabricValue`, bypassing the cell's
     * type parameter `T`. Use this when writing a pre-formed `FabricValue`
     * (e.g., `SigilLink` references, stream markers) that is valid at the
     * storage layer but does not conform to the cell's schema type.
     *
     * Prefer `setRaw()` when the value matches `T`.
     *
     * When `onlyIfDifferent` is `true`, the current raw value is read first and
     * the write is skipped entirely if it deep-equals the value that would be
     * written. The read is marked `ignoreReadForScheduling`, so it does not
     * register a dependency that could re-trigger the writing computation.
     *
     * `schemaRole` is runner-internal provenance. Result projection writes pass
     * `"output"` so the schema record created by this write carries the role;
     * ordinary callers must leave it absent.
     */
    setRawUntyped(
      value: FabricValue,
      onlyIfDifferent?: boolean,
      schemaRole?: "output",
    ): void;

    /**
     * Applies this cell's CFC schema to its existing stored value without
     * rewriting that value.
     */
    applyCfcSchemaToExistingValue(): void;

    setSchema(newSchema: JSONSchema): void;
    connect(node: NodeRef): void;
    export(): {
      cell: OpaqueCell<any>;
      path: readonly PropertyKey[];
      schema?: JSONSchema;
      scope?: CellScope;
      nodes: Set<NodeRef>;
      frame: Frame;
      kind?: CellKind;
      name?: unknown;
      external?: unknown;
    };
    getAsReactiveProxy(
      boundTarget?: (...args: unknown[]) => unknown,
    ): Reactive<T>;

    /**
     * Returns the sigil link naming this cell, or `null` when the cell has no
     * full link yet (one that has not been created). The link is what stands in
     * for a cell wherever a cell itself has no representation, and this is how
     * the storage boundary asks for it -- by name, off a value it has already
     * recognized as a cell. The two members below return the same link.
     */
    toSigilLinkOrNull(): SigilLink | null;

    /**
     * Returns the same link, under the name `encodableFormOf()` reads by. That
     * is how a cell survives a walk over an arbitrary graph -- deriving a
     * content id, or a builder default -- where nothing has recognized it as a
     * cell and there is no representation for one. The type is narrower than
     * the `toEncodableForm` a builder artifact carries, and assignable to it.
     */
    toEncodableForm(): SigilLink | null;

    /**
     * Returns the same link under the JSON protocol's name, so a cell reads as
     * what it names wherever a renderer honors that protocol.
     * `toCompactDebugString()` does, and it is what pattern-test assertion
     * diagnostics render their operands with. Nothing on the way to storage
     * consults it.
     */
    toJSON(): SigilLink | null;

    runtime: Runtime;
    tx: IExtendedStorageTransaction | undefined;
    schema?: JSONSchema;
    __debugValue: T;
    cellLink: SigilLink;
    space: MemorySpace;
    entityId: EntityRef;
    sourceURI: URI;
    path: readonly PropertyKey[];
    copyTrap: boolean;

    /** Set the self-reference for SELF symbol support in patterns */
    setSelfRef(selfRef: Reactive<any>): void;
  }

  interface ICreatable<C extends AnyBrandedCell<any>> {
    for(cause: unknown, allowIfSet?: boolean): C;
  }
}

export type { AnyCell, Cell, Stream } from "@commonfabric/api";

export type { MemorySpace } from "@commonfabric/memory/interface";

const arrayOnlyMethodNames = [
  "groupBy",
  "groupByWithPattern",
  "keyBy",
  "keyByWithPattern",
  "count",
  "countWithPattern",
  "sum",
  "min",
  "max",
  "minBy",
  "minByWithPattern",
  "maxBy",
  "maxByWithPattern",
] as const;
const arrayOnlyMethods: ReadonlySet<string> = new Set(arrayOnlyMethodNames);

// The names a `Reactive` forwards as METHODS of the cell it proxies. Every
// other string reads as data navigation, so a name here shadows a data key
// spelled the same way -- which is why `query` and `exec` are gated below.
const cellMethods = new Set<
  | keyof ICell<unknown>
  | "findIndex"
  | "filter"
  | "filterWithPattern"
  | "flatMap"
  | "flatMapWithPattern"
  | "exec"
  | "query"
  | "lookup"
  | "keys"
  | "keyEntries"
>([
  "get",
  "sample",
  "set",
  "send",
  "update",
  "push",
  "addUnique",
  "increment",
  "remove",
  "removeAll",
  "removeByValue",
  "elementById",
  "equals",
  "equalLinks",
  "key",
  "map",
  "mapWithPattern",
  ...arrayOnlyMethodNames,
  "reduce",
  "findIndex",
  "filter",
  "filterWithPattern",
  "flatMap",
  "flatMapWithPattern",
  "toSigilLinkOrNull",
  "toEncodableForm",
  "toJSON",
  "for",
  "asSchema",
  "withTx",
  "sink",
  "sync",
  "pull",
  "getAsQueryResult",
  "getAsNormalizedFullLink",
  "getAsLink",
  "getAsWriteRedirectLink",
  "getRaw",
  "getRawUntyped",
  "setRaw",
  "setRawUntyped",
  "getArgumentCell",
  "setSchema",
  "connect",
  "export",
  "getAsReactiveProxy",
  "setSelfRef",
  "exec",
  "query",
  "lookup",
  "keys",
  "keyEntries",
]);

/** Whether `schema` admits `value` and nothing else. */
function schemaPinsLiteral(
  schema: JSONSchema | undefined,
  value: string,
): boolean {
  if (!isObjectNotArray(schema)) return false;
  if (schema.const !== undefined) return schema.const === value;
  return Array.isArray(schema.enum) && schema.enum.length === 1 &&
    schema.enum[0] === value;
}

/**
 * The property schemas of a receiver whose own schema describes an index, and
 * `undefined` for one whose schema describes anything else.
 *
 * An index's descriptor is published by a separate scheduler action, and until
 * that action commits it reads as absent. The schema is what tells a consumer
 * in that window that its receiver is an index rather than ordinary data.
 */
function collectionIndexProperties(
  schema: JSONSchema | undefined,
): Record<string, JSONSchema> | undefined {
  const resolved = resolveSchema(schema);
  const properties = isObjectNotArray(resolved)
    ? resolved.properties
    : undefined;
  return isObjectNotArray(properties) &&
      schemaPinsLiteral(properties.kind, "collection-index")
    ? properties as Record<string, JSONSchema>
    : undefined;
}

/**
 * The missing-key behavior an index handle's own schema names, which is what
 * tells a lookup which empty answer to give before the descriptor carrying it
 * is published. `groupBy` and `keyBy` each produce a handle whose type names
 * one; the descriptor interface spelled directly names neither.
 */
function declaredCollectionIndexMode(
  schema: JSONSchema | undefined,
): "group" | "key" | undefined {
  const properties = collectionIndexProperties(schema);
  if (schemaPinsLiteral(properties?.mode, "group")) return "group";
  if (schemaPinsLiteral(properties?.mode, "key")) return "key";
  return undefined;
}

/** Whether an index surface may answer for `cell`, published or not. */
function isCollectionIndexReceiver(cell: AnyCell<unknown>): boolean {
  return (cell as Cell<{ kind?: string }>).key("kind").get() ===
      "collection-index" ||
    collectionIndexProperties(cell.schema) !== undefined;
}

/**
 * `schema` for `result`, carrying the whole `ifc` its link schema already
 * declares. A node factory labels the cell it mints from that node's inputs,
 * and a built-in stamping its own shape onto the same link composes that
 * label back in. CFC §8.5.4.3 puts a collection coordinator's source label on
 * its structural writes, and §8.17.1 puts the join of a count's or a sum's
 * contributors on the scalar it produces.
 */
function schemaCarryingLinkIfc(
  result: { export(): { schema?: JSONSchema } },
  schema: JSONSchema,
): JSONSchema {
  const existing = result.export().schema;
  const ifc = isObjectNotArray(existing) ? existing.ifc : undefined;
  return ifc === undefined ? schema : internSchema({
    ...ContextualFlowControl.toSchemaObj(schema),
    ifc,
  });
}

// The schema for one element of an array schema, suitable for a standalone
// element cell. The array's items schema is often a `$ref` into the array
// schema's `$defs`; carry those `$defs` onto the element schema so the reference
// (and any nested references) still resolve once the element is addressed on its
// own, detached from the array.
// The schema covering one element of `arraySchema`. The covering schema is
// index-determined for tuples — prefixItems[index] when the index is within
// the slots, `items` past them — so callers that know the element's index
// should pass it. Without an index (elementById is id-keyed; the element's
// position is unknown), the element is treated as rest-region: tuple slots
// are positional and cannot be id-addressed, so `items` covers it, and a
// pure tuple (no `items`) yields `undefined` — no principled per-element
// schema exists there (CT-1895 borderline site).
// Exported for unit testing only.
export function elementSchemaFor(
  arraySchema: JSONSchema | undefined,
  index?: number,
): JSONSchema | undefined {
  if (!isObjectOrArray(arraySchema)) return undefined;
  const prefixItems = Array.isArray(arraySchema.prefixItems)
    ? arraySchema.prefixItems as JSONSchema[]
    : undefined;
  const covering = prefixItems !== undefined && index !== undefined &&
      index < prefixItems.length
    ? prefixItems[index]
    : arraySchema.items;
  return covering === undefined
    ? undefined
    : cfcSchemaWithInheritedDefs(covering, arraySchema.$defs);
}

/** Parse the explicit column list from `INSERT INTO t (a, b, c) VALUES ...`,
 *  used to map positional `_cf_link` params. Returns undefined when there is no
 *  explicit column list (columnless `INSERT … VALUES (…)`, `UPDATE`, opaque
 *  SQL). The capture must be immediately followed by `VALUES`, so a columnless
 *  insert's VALUES tuple is NOT mistaken for a column list. */
function parseSqliteInsertColumns(sql: string): string[] | undefined {
  const m = sql.match(
    /\binsert\b[\s\S]*?\binto\b\s+[^()]+?\(([^)]*)\)\s*values\b/i,
  );
  if (!m) return undefined;
  return m[1].split(",").map((c) => c.trim().replace(/^["'`\[]|["'`\]]$/g, ""));
}

/**
 * Recover a Cell from a value that is a Cell or carries a `toCell` back-pointer
 * (delegating the back-pointer case to query-result-proxy's `getCellOrThrow`).
 * Shared by the write path (`encodeSqliteParams`) and `cf-link.ts`'s
 * `encodeCfLinkValue` so `db.exec` and the `sqliteQuery` builtin agree on what
 * counts as a bound cell. (Lives here because it needs `isCell` /
 * `instanceof CellImpl`; cf-link.ts already imports from cell.ts.)
 */
export function asBoundCell(value: unknown): Cell<unknown> | undefined {
  if (isCell(value)) return value as Cell<unknown>;
  if (isCellResultForDereferencing(value)) return getCellOrThrow(value);
  return undefined;
}

/**
 * Encode SQLite bind params for the wire: a cell bound to a `_cf_link` column is
 * encoded to an absolute sigil-link string; a cell bound to any other column
 * throws; an `undefined` value throws (the pending-value guard — `null` is
 * allowed for SQL NULL). Shared by `db.exec` (CellImpl) and the `sqliteQuery`
 * builtin so the encode rules and the undefined guard cannot drift.
 *
 * Positional params are validated against the statement's explicit `INSERT`
 * column list (cycled across multi-row `VALUES` tuples). When the target column
 * of a positional `?` can't be determined (columnless INSERT, UPDATE, opaque
 * SQL), a Cell binding cannot be verified to land in a `_cf_link` column, so it
 * is REJECTED with an actionable error rather than blindly sigil-encoded (which
 * would corrupt a non-link column). Use an explicit column list or named params
 * (`:col`) to bind a Cell in those statements.
 */
export function encodeSqliteParams(
  sql: string,
  params?: ReadonlyArray<unknown> | Record<string, unknown>,
): SqliteParamsWire | undefined {
  if (params === undefined) return undefined;
  const assertDefined = (value: unknown): void => {
    if (value === undefined) {
      throw new TypeError(
        "sqlite: param is undefined (it may be a value that isn't ready yet); " +
          "pass a resolved value, or null for SQL NULL",
      );
    }
  };
  const encodeNested = (value: unknown): unknown => {
    assertDefined(value);
    const cell = asBoundCell(value);
    if (cell) {
      const link = cell.toSigilLinkOrNull();
      if (link === null) {
        throw new TypeError(
          "sqlite: a nested Cell parameter must have a durable link",
        );
      }
      return link;
    }
    if (Array.isArray(value)) {
      return value.map(encodeNested);
    }
    if (isPlainContainer(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, member]) => [
          key,
          encodeNested(member),
        ]),
      );
    }
    return value;
  };
  const encodeOne = (value: unknown, isLinkCol: boolean): unknown => {
    assertDefined(value);
    const cell = asBoundCell(value);
    if (cell) {
      if (!isLinkCol) {
        throw new TypeError("cells may only be bound to _cf_link columns");
      }
      return encodeCellToSigilString(cell);
    }
    return encodeNested(value);
  };
  if (Array.isArray(params)) {
    const cols = parseSqliteInsertColumns(sql);
    return params.map((v, i) => {
      if (cols) {
        // Cycle the column list across multi-row `VALUES (?),(?)` tuples.
        return encodeOne(v, isCfLinkColumn(cols[i % cols.length] ?? ""));
      }
      assertDefined(v);
      if (asBoundCell(v)) {
        throw new TypeError(
          "sqlite: a Cell parameter must bind to a _cf_link column, but the " +
            "target column can't be determined from this statement. Use an " +
            "explicit column list (INSERT INTO t (col) VALUES (?)) or named " +
            "params (:col) so the binding can be verified.",
        );
      }
      return encodeNested(v);
    }) as SqliteParamsWire;
  }
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      encodeOne(value, isCfLinkColumn(key)),
    ]),
  ) as SqliteParamsWire;
}

export function createCell<T>(
  runtime: Runtime,
  link?: NormalizedLink,
  tx?: IExtendedStorageTransaction,
  synced = false,
  kind?: CellKind,
  cfcLabelView?: CfcLabelView,
): Cell<T> {
  return new CellImpl(
    runtime,
    tx,
    link, // Pass the link directly (or undefined)
    synced,
    undefined, // No shared causeContainer
    kind,
    cfcLabelView,
  ) as unknown as Cell<T>; // Cast to set brand
}

/**
 * Mark a cell handle as covered by a document-level sync barrier owned by the
 * caller. Separate handles for the same document otherwise each try to load it.
 */
export function markCellDocumentSynced(cell: Cell<any>): void {
  if (!(cell instanceof CellImpl)) {
    throw new TypeError("Expected a runner CellImpl handle");
  }
  cell[markDocumentSynced]();
}

/** Loads a document for a captured resolution identity without retaining a transaction. */
export function syncCellForIdentity<T>(
  cell: Cell<T>,
  identity: ScopeKeyIdentity | undefined,
): Promise<Cell<T>> {
  if (identity === undefined) return cell.sync();
  markCellDocumentSynced(cell);
  return cell.runtime.storageManager.syncCell(cell, {
    scopeKeyIdentity: identity,
  });
}

/**
 * Shared container for entity ID and cause information across sibling cells.
 * When cells are created via .asSchema(), .withTx(), they share the same
 * logical identity (same entity id) but may have different paths or schemas.
 * The container stores only the entity reference parts that need to be synchronized.
 */
interface CauseContainer {
  // Root cell that created this cause container
  cell: OpaqueCell<unknown>;
  // Entity reference - shared across all siblings
  id: URI | undefined;
  space: MemorySpace | undefined;
  // Cause for creating the entity ID
  cause: unknown | undefined;
}

/**
 * CellImpl - Unified cell implementation that handles both regular cells and
 * streams.
 */
export class CellImpl<T extends FabricValue>
  implements ICell<T>, IStreamable<T> {
  // Stream-specific fields
  #listeners = new Set<
    (event: AnyCellWrapping<T>) => Cancel | undefined
  >();
  #cleanup: Cancel | undefined;

  /** The cell's own link (space, path, schema). */
  #_link: NormalizedLink;

  /**
   * Shared container for entity ID and cause; siblings share the same instance.
   */
  #causeContainer: CauseContainer;

  /**
   * The frame on top of the stack when this cell was constructed. A runtime
   * keeps a frame on the stack from its construction until its disposal, so a
   * cell has no frame only when it is built after the runtime it came from was
   * disposed, as deriving one with `key()` from a cell that already has a full
   * link does.
   */
  #frame: Frame | undefined;

  #kind: CellKind;

  /** Self-reference, for pattern `SELF` symbol support. */
  #selfRef?: Reactive<any>;

  #viewRefHashCache?: {
    link: NormalizedFullLink;
    cfcLabelView: CfcLabelView | undefined;
    hash: string;
  };

  #synced: boolean;
  #cfcLabelView?: CfcLabelView;

  constructor(
    public readonly runtime: Runtime,
    public readonly tx: IExtendedStorageTransaction | undefined,
    link?: NormalizedLink,
    synced: boolean = false,
    causeContainer?: CauseContainer,
    kind?: CellKind,
    _cfcLabelView?: CfcLabelView,
  ) {
    this.#synced = synced;
    this.#cfcLabelView = _cfcLabelView;
    this.#frame = getTopFrame();

    // Store this cell's own link
    this.#_link = {
      ...(link ?? { path: [] }),
      scope: isCellScope(link?.scope) ? link.scope : normalizeCellScope(
        undefined,
      ),
    };

    // Use provided container or create one
    // If link has an id, extract it to the container
    this.#causeContainer = causeContainer ?? {
      cell: this as unknown as OpaqueCell<unknown>,
      id: this.#_link.id,
      space: this.#_link.space,
      cause: undefined,
    };

    this.#kind = kind ?? "cell";
    this.#cfcLabelView = cloneCfcLabelView(_cfcLabelView);
  }

  [markDocumentSynced](): void {
    this.#synced = true;
  }

  isReadableCell(): boolean {
    return this.#kind === "cell" || this.#kind === "readonly";
  }

  /**
   * The kind this cell was constructed as: `stream` for a handle minted for a
   * stream position, `cell` otherwise. Read off the handle alone, with nothing
   * read from storage, which is what a write boundary needs from it.
   */
  get kind(): CellKind {
    return this.#kind;
  }

  [cfcLabelViewSymbol](): CfcLabelView | undefined {
    return cloneCfcLabelView(this.#cfcLabelView);
  }

  /**
   * Get the full link for this cell, ensuring it has id and space.
   * This will attempt to create a full link if one doesn't exist and we're in a valid context.
   */
  get #link(): NormalizedFullLink {
    // Check if we have a full entity ID and space
    if (!this.#hasFullLink()) {
      // Try to ensure we have a full link
      this.#ensureLink();

      // If still no full link after ensureLink, throw
      if (!this.#hasFullLink()) {
        throw new Error(
          "Cell link creation failed - no cause or context\n" +
            "help: use .for(uniqueId) to set explicit identity, or create cells within handler/pattern contexts",
        );
      }
    }

    // Combine causeContainer id with link's space/path/schema
    return this.#_link as NormalizedFullLink;
  }

  get #viewRef(): CellViewRef {
    return {
      link: this.#link,
      cfcLabelView: this.#cfcLabelView,
    };
  }

  #viewRefHash(): string {
    const link = this.#link;
    const cfcLabelView = this.#cfcLabelView;
    const cached = this.#viewRefHashCache;
    if (cached?.link === link && cached.cfcLabelView === cfcLabelView) {
      return cached.hash;
    }
    const hash = hashStringOf({ link, cfcLabelView } satisfies CellViewRef);
    this.#viewRefHashCache = { link, cfcLabelView, hash };
    return hash;
  }

  /**
   * Check if this cell has a full link (with id and space)
   */
  #hasFullLink(): boolean {
    return this.#_link.id !== undefined && this.#_link.space !== undefined;
  }

  /**
   * Set a cause for this cell. This is used to create a link when the cell doesn't have one yet.
   * This affects all sibling cells (created via .key(), .asSchema(), .withTx()) since they
   * share the same container.
   *
   * Record causes may not use the top-level key `$generated` — it is
   * reserved for system-generated causes.
   * @param cause - The cause to associate with this cell
   * @param allowIfSet - If true, treat as suggestion and silently ignore if cause already set. If false (default), throw error if cause already set.
   * @returns This cell for method chaining
   */
  for(cause: unknown, allowIfSet?: boolean): Cell<T> {
    // If cause or id already exists, either fail or silently ignore based on allowIfSet
    if (this.#causeContainer.id || this.#causeContainer.cause) {
      if (allowIfSet) {
        // Treat as suggestion - silently ignore
        return this as unknown as Cell<T>;
      } else {
        // Fail by default
        throw new Error(
          "Cannot set cause: cell already has a cause or link.",
        );
      }
    }

    // Reject reserved keys before the cause can take effect: a user cause
    // carrying a top-level `$generated` key would mimic the pattern builder's
    // generated-cause namespace.
    assertNoReservedCauseKeys(cause);

    // Store the cause in the shared container - all siblings will see this
    this.#causeContainer.cause = cause;

    return this as unknown as Cell<T>;
  }

  /**
   * Pins this (not-yet-linked) cell to a space before its id exists, and routes
   * any pattern nodes attached to it into that target space. Used by the pattern
   * builder to implement `PatternFactory.inSpace(...)`. Throws if the cell has
   * already been linked.
   */
  setUnlinkedSpace(space: MemorySpace): void {
    if (this.#causeContainer.id || this.#_link.id) {
      throw new Error(
        "Cannot set space: cell already has a link.",
      );
    }
    this.#causeContainer.space = space;
    this.#_link = { ...this.#_link, space };
    for (const node of cellNodes.get(this.#causeContainer.cell) ?? []) {
      (node.module as Module).targetSpace = space;
    }
  }

  /**
   * Force creation of a full link for this cell from the stored cause.
   * This method populates id if it doesn't exist, using information from:
   * - The stored cause (from .for())
   * - The current handler context
   * - Derived information from the graph (for deriving nodes)
   *
   * Updates the shared causeContainer, so all siblings will see the new id.
   *
   * @throws Error if not in a handler context and no cause was provided
   */
  #ensureLink(): void {
    // If we already have a full link (id and space) in the container, just copy
    // it over to our link.
    if (this.#causeContainer.id && this.#causeContainer.space) {
      this.#_link = {
        ...this.#_link,
        id: this.#causeContainer.id,
        space: this.#causeContainer.space,
      };
      return;
    }

    // Otherwise, let's attempt to derive the id:

    const space = this.#_link.space ?? this.#causeContainer.space ??
      this.#frame?.space;

    // We need a space to create a link
    if (!space) {
      throw new Error(
        "Cannot create cell link - space required\n" +
          "help: use computed() to handle closures automatically, or pass cells as explicit parameters",
      );
    }

    // Used passed in cause (via .for()), for events fall back to per-frame
    // counter.
    const cause = this.#causeContainer.cause ??
      (this.#frame?.inHandler
        ? { count: this.#frame.generatedIdCounter++ }
        : undefined);

    if (!cause) {
      throw new Error(
        "Cannot create cell link - not in handler context and no cause provided\n" +
          "help: use .for(cause) for explicit identity, or create cells within handlers where identity is automatic",
      );
    }

    // Create an entity ID from the cause, including the frame's
    const id = toURI(createRef({ frame: cause }, this.#frame?.cause));

    // Populate the id in the shared causeContainer
    // All siblings will see this update
    this.#causeContainer.id = id;
    this.#causeContainer.space = space;

    // Update this cell's link
    this.#_link = { ...this.#_link, id, space };
  }

  get space(): MemorySpace {
    return this.#_link.space ?? this.#causeContainer.space ??
      this.#frame?.space!;
  }

  get path(): readonly PropertyKey[] {
    return this.#_link.path;
  }

  get schema(): JSONSchema | undefined {
    if (this.#_link.schema !== undefined) return this.#_link.schema;

    // If no schema is defined, resolve link and get schema from there (which is
    // what .get() would do).
    if (this.#hasFullLink()) {
      const resolvedLink = resolveLink(
        this.runtime,
        this.runtime.readTx(this.tx),
        this.#link,
        "writeRedirect",
      );
      return resolvedLink.schema;
    }

    return undefined;
  }

  /**
   * Check if this cell contains a stream value
   *
   * TypeScript-private rather than a `#` name: the module-level `isStream()`
   * reads this member off `(value as any)`, and an optional call on a `#`
   * name yields undefined rather than throwing, so every stream would
   * quietly stop being recognized as one.
   */
  private isStream(
    resolvedToValueLink?: NormalizedFullLink,
    /**
     * Metadata for the marker read. `set()` passes
     * {@link writeDestinationRead} beside the default, because there the
     * probe is the write path asking which of two ways to write; `sink()`
     * takes the default, where the probe is an ordinary observation.
     */
    markerReadMeta: Metadata = ignoreReadForScheduling,
  ): boolean {
    if (this.#kind === "stream") return true;

    const tx = this.runtime.readTx(this.tx);

    if (!resolvedToValueLink) {
      // A content read: the terminal-value read below is what decides, so
      // the resolution's crossings mark like any other read's.
      resolvedToValueLink = resolveLink(this.runtime, tx, this.#link, "value", {
        markIfcCrossings: true,
      });
    }

    if (ContextualFlowControl.declaresStream(resolvedToValueLink.schema)) {
      return true;
    }

    // The marker is a scalar at one known path, and this reads that path.
    // What a read consumes is the labels resolving at the path it names, so
    // asking the question this narrowly keeps the labels of the fields
    // beside the marker out of the reading transaction's flow join. A label
    // the document declares at its root resolves at the marker too, which is
    // what `markerReadMeta` answers on the write path.
    const marker = tx.readValueOrThrow({
      ...resolvedToValueLink,
      path: [...resolvedToValueLink.path, STREAM_MARKER_KEY],
      schema: undefined,
    }, {
      meta: markerReadMeta,
    });
    return marker === true;
  }

  get(options?: { traverseCells?: boolean }): Readonly<StripDefaultBrand<T>> {
    if (!this.#synced) this.sync(); // No await, just kicking this off

    // Per-transaction read cache: within one ready transaction, repeatedly
    // reading the same cell with no intervening write recomputes an identical
    // result -- same value, the same reactive reads already registered on the
    // tx, and the same CFC state. Reuse the prior result when the tx supports
    // caching (the non-reactive sample() wrapper does not) and is still open.
    // The tx clears this cache on any write, so a hit only happens when nothing
    // has changed since the last read. Key by the stable value of the view ref
    // (link + CFC label view), not link object identity, so equivalent CellImpl
    // wrappers in the same tx can share the cached traversal result. `variant`
    // separates reads that differ in options or synced state.
    const tx = this.tx;
    const cacheable = tx !== undefined &&
      tx.getCachedReadResult !== undefined &&
      tx.status().status === "ready" &&
      // Once CFC is prepared, the real read path's `read-after-prepare`
      // invalidation is load-bearing: bypass the cache so a post-prepare read
      // still goes through readOrThrow() and invalidates the prepared digest.
      tx.getCfcState().prepare.status !== "prepared";
    const variant = `${options?.traverseCells ?? false}|${this.#synced}`;
    const cacheKey = cacheable ? this.#viewRefHash() : undefined;
    if (cacheable) {
      const cached = tx.getCachedReadResult!(cacheKey!, variant);
      if (cached !== undefined) {
        return cached.value as Readonly<StripDefaultBrand<T>>;
      }
    }

    logger.timeStart("cell", "get");
    const read = validateAndTransform(
      this.runtime,
      this.tx,
      this.#viewRef,
      [],
      { ...options, synced: this.#synced },
    );
    // A stream holds no value, so a read of a stream handle returns the
    // stream. The read finds that out rather than assuming it, because the
    // kind alone does not decide: a union that offers both `cell` and `stream`
    // hands a stream handle to a position that holds a value, and that value
    // is what its read returns. Two outcomes say there is none. The read
    // finds nothing. Or the handle's own schema names a further handle kind
    // behind the stream's, as a view node's prop schema leaves `opaque`
    // there, and the read mints that handle on the very location the stream
    // names: a handle carrying nothing that says stream, whose `send()` would
    // write the event into the stream's document.
    const holdsNoValue = read === undefined ||
      (isCell(read) &&
        areNormalizedLinksSame(read.getAsNormalizedFullLink(), this.#link));
    const value = this.#kind === "stream" && holdsNoValue
      ? this as unknown as typeof read
      : read;
    const elapsed = logger.timeEnd("cell", "get")!;
    if (elapsed > 50) {
      logger.warn(
        `get >${Math.floor(elapsed - (elapsed % 10))}ms`,
        `get() took ${Math.floor(elapsed)}ms`,
        this.#link,
      );
    }
    if (cacheable) {
      // Re-read `#_link`: validateAndTransform (via viewRef -> link) may have
      // run `#ensureLink()` and replaced it with the completed link object, which
      // is the identity subsequent get()s will hash.
      tx.setCachedReadResult!(this.#viewRefHash(), variant, value);
    }
    return value;
  }

  /**
   * Read the cell's current value without creating a reactive dependency.
   * Unlike `get()`, calling `sample()` inside a handler won't cause the handler
   * to re-run when this cell's value changes.
   *
   * Use this when you need to read a value but don't want changes to that value
   * to trigger re-execution of the current reactive context.
   */
  sample(): Readonly<StripDefaultBrand<T>> {
    if (!this.#synced) this.sync(); // No await, just kicking this off

    // Wrap the transaction to make all reads non-reactive. Child cells created
    // during validateAndTransform will use the original transaction (via
    // getTransactionForChildCells).
    const readTx = this.runtime.readTx(this.tx);
    const nonReactiveTx = createNonReactiveTransaction(readTx);

    return validateAndTransform(this.runtime, nonReactiveTx, this.#viewRef);
  }

  /**
   * Pull the cell's value, ensuring all dependencies are computed first.
   *
   * In pull-based scheduling mode, computations don't run automatically when
   * their inputs change - they only run when pulled by an effect. This method
   * registers a temporary effect that reads the cell's value, triggering the
   * scheduler to compute all transitive dependencies first.
   *
   * In push-based mode (the default), this is equivalent to `await idle()`
   * followed by `get()`, but ensures consistent behavior across both modes.
   *
   * Use this in tests or when you need to ensure a computed value is up-to-date
   * before reading it:
   *
   * ```ts
   * // Instead of:
   * await runtime.scheduler.idle();
   * const value = cell.get();
   *
   * // Use:
   * const value = await cell.pull();
   * ```
   *
   * @returns A promise that resolves to the cell's current value after all
   *          dependencies have been computed.
   */
  pull(): Promise<Readonly<T>> {
    if (!this.#synced) {
      // Register the kicked first sync in the settled pool the convergence
      // loop below drains. sync() resolves once the doc is confirmed —
      // arrived or absent — and an UNREGISTERED kick is exactly the race
      // sync()'s own doc comment warns about: over a low-latency link the
      // doc lands before the scheduler goes idle, so the read sees it; over
      // a real network it does not, and pull() resolved from held,
      // not-yet-loaded state (measured: a same-id retry's receipt readback
      // returned undefined against a remote host while identical calls
      // passed against a local toolshed). Failures are swallowed like
      // link-resolution's kicks: the read still resolves from the replica.
      this.runtime.storageManager.trackUntilSettled(
        this.sync().catch(() => {}),
      );
    }

    // Check if we need to traverse the result to register all dependencies.
    // This is needed when there's no schema or when the schema is TrueSchema ("any"),
    // because without schema constraints we need to read all nested values.
    const schema = this.#_link.schema;
    const needsTraversal = schema === undefined ||
      ContextualFlowControl.isTrueSchema(schema);

    return new Promise((resolve) => {
      const action: Action = (tx) => {
        // Read the value inside the effect - this ensures dependencies are pulled
        const value = validateAndTransform(this.runtime, tx, this.#viewRef);

        // If no schema or TrueSchema, traverse the result to register all
        // nested values as read dependencies.
        if (needsTraversal && value !== undefined && value !== null) {
          deepTraverse(value);
        }
      };
      // Name the action for debugging
      Object.defineProperty(action, "name", {
        value: `pull:${this.sourceURI}`,
        configurable: true,
      });
      // Also set .src as backup (name can be finicky)
      (action as Action & { src?: string }).src = `pull:${this.sourceURI}`;

      // Subscribe as an effect so it runs in the next cycle.
      const cancel = this.runtime.scheduler.subscribe(action, {
        isEffect: true,
        noDebounce: true,
      });

      // Wait for the scheduler to process all pending work, then resolve.
      // If the read kicked async loads of absent link targets (cross-space,
      // or same-space docs a fresh replica never pulled), await them and
      // re-idle — each arrival re-runs the read and can reveal the next hop.
      // Every kicked doc is deduped once-per-session, so the total number of
      // rounds is bounded by the reachable-doc depth; the fixed cap is only
      // a backstop against a pathological graph. Pulls that kicked nothing
      // take the zero-iteration path and keep their previous timing.
      this.runtime.scheduler.idle().then(async () => {
        const storage = this.runtime.storageManager;
        // The pending pool is manager-global (same semantics as `synced()`):
        // this pull may also wait on loads kicked by concurrent readers.
        let round = 0;
        for (; round < 100; round++) {
          if ((storage.pendingCrossSpacePromiseCount?.() ?? 0) === 0) break;
          await (storage.crossSpaceSettled?.() ?? Promise.resolve());
          await this.runtime.scheduler.idle();
        }
        if (
          round === 100 && (storage.pendingCrossSpacePromiseCount?.() ?? 0) > 0
        ) {
          logger.warn("pull", () => [
            "pull() convergence bound exhausted with link-target loads still",
            `pending: ${this.sourceURI}`,
          ]);
        }
        cancel?.();
        // The effect above exists to drive the scheduler: it reads inside its
        // own transaction so the dependencies get registered and the
        // computations they gate run. That transaction has committed by the
        // time this resolves, so the value the caller keeps is read here
        // instead — a schemaless cell materializes as a view, and a view
        // pinned to a finished transaction refuses every access.
        //
        // Read against a fresh transaction rather than this cell's. A caller
        // holding a long-lived open transaction has snapshots in it from
        // before the computations this pull just drove, so reading through it
        // would hand back exactly the stale values pull() exists to avoid.
        resolve(validateAndTransform(this.runtime, undefined, this.#viewRef));
      });
    });
  }

  /**
   * SqliteDb write (`db.exec`): records a SQLite write op onto THIS cell's
   * transaction so it commits ATOMICALLY with surrounding cell writes (one
   * commit = cell ops + a `sqlite` op). On SQL failure the whole commit aborts.
   * Only valid on a `"sqlite"`-kind cell and inside a transaction (e.g. a
   * handler). Throws on an `undefined` param (it may be a value that isn't ready
   * yet — pass a resolved value, or `null` for SQL NULL). See
   * docs/specs/sqlite-builtin/plans/sqlitedb-cell-type-exploration.md.
   */
  exec(
    sql: string,
    params?: ReadonlyArray<unknown> | Record<string, unknown>,
  ): void {
    if (!this.tx) {
      throw new Error(
        ".exec() must be called within a transaction (e.g. inside a handler)",
      );
    }
    if (!this.tx.recordSqliteWrite) {
      throw new Error("storage transaction does not support sqlite writes");
    }
    // `"sqlite"` is a type-level kind (the public `SqliteDb` type restricts who
    // can call `.exec`); at runtime we validate the actual handle value rather
    // than `#kind`, since handler-input materialization doesn't always stamp the
    // kind onto the delivered cell. Read the handle with `getRaw()` (NOT `get()`):
    // the delivered cell's schema is whatever the pattern that declared the
    // handle was compiled against, and a pattern compiled before the descriptor
    // emission carries the empty `SqliteDatabase` shape, which shapes the handle
    // down to `{}` and drops the `id`/`tables` fields. Use `lastNode: "value"`
    // so the FINAL link is still resolved (a handler-delivered handle may sit
    // behind a link at its target) — getRaw's default `"top"` would stop at the
    // link object and miss `id`.
    const handle = this.getRaw({ lastNode: "value" }) as
      | { id?: unknown; tables?: unknown; scope?: unknown }
      | undefined;
    if (!handle || typeof handle.id !== "string") {
      throw new TypeError(
        ".exec() is only available on a SqliteDb cell (invalid database handle)",
      );
    }
    // Materialize `tables` through a RESOLVING read: sqliteDatabase now
    // stores the handle inline (self-contained), but a handle written before
    // that fix can still hold doc LINKS where the rule's AST nodes should be,
    // so `getRaw` alone would see links. The permissive schema bypasses the
    // handle's declared shape, which for a pattern compiled before the
    // descriptor emission has no properties and shapes `get()` down to `{}`.
    const materialized = this.asSchema(
      { type: "object", additionalProperties: true } as JSONSchema,
    ).withTx(this.tx).get() as { tables?: unknown } | undefined;
    const tables = materialized?.tables !== undefined
      ? cloneIfNecessary(
        materialized.tables as Parameters<typeof cloneIfNecessary>[0],
        { frozen: false },
      ) as SqliteDbRef["tables"]
      // `handle` is a raw, unvalidated read (see above), so this states the
      // wire shape rather than proving it.
      : handle.tables as SqliteDbRef["tables"];
    // CFC write-ceiling (Phase 2): a value bound to a labeled column must fit the
    // column's `ifc.maxConfidentiality`. The label rides the bound value (a Cell
    // or any carried-label value); fail closed when a labeled value's target
    // column can't be determined. No-op until a column declares `ifc`.
    const confidentialityOf = (value: unknown): readonly unknown[] => {
      const view = cfcLabelViewForCell(value);
      return view
        ? cfcConfidentialityForObservationNode({ labelView: view })
        : [];
    };
    const ceilingViolation = checkSqliteWriteCeiling(
      sql,
      params,
      tables as Parameters<typeof checkSqliteWriteCeiling>[2],
      confidentialityOf,
    );
    if (ceilingViolation) throw new TypeError(ceilingViolation);

    // CFC per-row rule gate (Phase 3): an attributable INSERT into a
    // rule-bearing table computes the prospective row label from its bound
    // values; labeled inputs must be captured by it (no-laundering), and the
    // computed per-row labels are recorded as this write's CFC policy input
    // (sink-request) before the commit. Unattributable shapes fail closed —
    // unless the connected server advertised commit-time re-derivation (3.c),
    // which admits them with unlabeled inputs and evaluates the committed
    // rows server-side. No-op (zero cost) until a table declares a rule.
    const owner = typeof (handle as { owner?: unknown }).owner === "string"
      ? (handle as { owner: string }).owner
      : undefined;
    const rowGate = checkSqliteRowLabelWrite({
      sql,
      params,
      tables,
      owner,
      confidentialityOf,
      serverCommitEval: this.runtime.storageManager.open(this.space)
        .sqliteServerCommitRowLabelEval?.() ?? false,
    });
    if ("error" in rowGate) throw new TypeError(rowGate.error);
    if (rowGate.policies !== undefined && rowGate.policies.length > 0) {
      this.tx.markCfcRelevant(`sqlite-row-label:${handle.id}`);
      // TODO(danfuzz): `JSON.stringify` renders a `FabricPrimitive` bind
      // param (a `FabricBytes` blob, say) as `{}`, so two requests differing
      // only in such a param collapse onto one policy-input identity here.
      recordSinkRequestPolicyInput(
        this.tx,
        `sqlite:${handle.id}`,
        `sqlite-exec:${handle.id}:${sql}:${
          JSON.stringify(encodeSqliteParams(sql, params) ?? null)
        }`,
        {
          table: rowGate.policies[0].table,
          rows: rowGate.policies.map((p) => p.label),
        } as Parameters<typeof recordSinkRequestPolicyInput>[3],
      );
    }

    this.tx.recordSqliteWrite(this.space, {
      op: "sqlite",
      db: {
        id: handle.id,
        // Materialized (link-free) — the server's write path must see the
        // same plain schema JSON the read path's provenance gate keys off.
        tables,
        // Carry the db's declared scope so the write lands in the same per-user
        // / per-session on-disk file the read path resolves (stamped by
        // sqliteDatabase onto the handle value).
        scope: isCellScope(handle.scope) ? handle.scope : undefined,
        // The db's owner resolves the rule's `dbOwner()` term in the SERVER's
        // commit-time re-derivation (3.c) — same handle-stamped value the
        // gate above used.
        owner,
      },
      sql,
      params: encodeSqliteParams(sql, params),
    });
    // Bump a write counter on the DB handle cell in THIS SAME commit. Two
    // effects, both intended:
    //  - `reactOn: db` queries re-run after a write (the handle value changed).
    //  - it serializes concurrent writers: each does a read-modify-write of
    //    `rev`, so two in-flight `db.exec` commits conflict on this cell's
    //    revision (optimistic-concurrency mutex) and one retries.
    // A LEAF write, not a whole-value set of `{...handle, rev}`: exec runs
    // inside a handler frame, where a whole-value `.set()` anchors every
    // object-in-array and would split the handle's inline rule term lists
    // back into per-element linked docs — the split sqliteDatabase stores the
    // handle raw specifically to avoid (a second runtime can't load those).
    const rev = ((handle as { rev?: unknown }).rev as number | undefined) ?? 0;
    (this.withTx(this.tx) as unknown as Cell<{ rev: number }>).key("rev").set(
      rev + 1,
    );
  }

  set(
    newValue: AnyCellWrapping<T> | T,
    /**
     * Internal-only settle callback. This runs once this transaction reaches
     * its final outcome, which includes a rejected commit and an abort, so it
     * must remain non-effectful. Use the post-commit outbox for external side
     * effects that must happen only after success.
     */
    onCommit?: (tx: IExtendedStorageTransaction) => void,
    /**
     * Internal-only stream-send options (see {@link StreamSendOptions}).
     * `eventId` supplies the durable event id (spec §7.5) instead of minting
     * one: an ingress caller that owns a delivery id passes it, with the
     * `session` it chose that id within, so a retry of the same pair collides
     * on the handling's create-only receipt (the verb contract,
     * docs/plans/pattern-verb-contract.md). The receipt is a COMMIT witness,
     * not an execution witness — the redelivered event still runs the handler
     * body and then loses the race, so effects outside the transaction repeat.
     * `runtimeInjectedEventKeys` carries the runtime-injection provenance the
     * closed-world gate consumes. Ignored on the plain-cell write path.
     */
    sendOptions?: StreamSendOptions,
  ): Cell<T> {
    // This resolution is a read — isStream() below reads the resolved
    // terminal value — so it opts into the ifc crossing seam like every
    // other content read. A transaction it marks relevant must then be
    // prepared before commit (prepareTxForCommit), which every
    // runtime-owned commit path already does; a hand-rolled edit()/commit()
    // that sets through an ifc-bearing crossing owes the same call.
    const resolvedToValueLink = resolveLink(
      this.runtime,
      this.runtime.readTx(this.tx),
      this.#link,
      "value",
      { markIfcCrossings: true },
    );

    // Check if we're dealing with a stream
    if (
      this.isStream(resolvedToValueLink, {
        ...ignoreReadForScheduling,
        ...writeDestinationRead,
      })
    ) {
      // Stream behavior

      // A lift (reactive computation) must be pure: emitting an event from a
      // lift is a feedback loop that breaks reactive settling. Gate only the
      // positive "lift" frame — internal/renderer event delivery and handler
      // emits run in other frames and pass through.
      if (getTopFrame()?.frameKind === "lift") {
        throw new Error(
          "Cannot emit an event from a lift/computed context: a lift must be " +
            "pure. Send to streams from a handler instead.",
        );
      }

      // `T` is unconstrained, so this says what the conversion requires rather
      // than what the class guarantees, the same way `CellHandle<T>` does on
      // the client side.
      //
      // TODO(danfuzz): constrain `T`, so that neither cast is needed.
      const event = convertCellsToLinks(
        newValue as CellLinkInput,
      ) as AnyCellWrapping<T>;
      propagateRendererTrustedEvent(newValue, event);

      const mintedKeys = mintedRuntimeInjectedEventKeys(
        sendOptions?.runtimeInjectedEventKeys,
      );
      // The caller's key is opaque and unscoped; queueEvent expects a durable
      // delivery id. Binding it to the session that chose it and to this
      // stream is what keeps one caller's id from addressing another caller's
      // receipt, and two verbs that share input bindings from colliding on
      // one receipt.
      const callerEventId = sendOptions?.eventId;
      let deliveryEventId: string | undefined;
      if (callerEventId !== undefined) {
        const session = sendOptions?.session;
        if (session === undefined) {
          // Refused rather than derived without one: an unscoped address is
          // reachable by anyone who guesses the id, and the guarantee the id
          // is passed for — a retry settling on the original outcome — would
          // then be extended to a caller who made no such call.
          throw new Error(
            "A caller-supplied `eventId` requires the `session` it was " +
              "chosen within: an invocation id is the caller's own word, " +
              "and the pair is what names one invocation.",
          );
        }
        deliveryEventId = scopeCallerEventId(
          callerEventId,
          session,
          resolvedToValueLink,
        );
      }

      // Server-execution v2 Phase 3 (events-down; events.md §1, §7): on a
      // flag-ON CLIENT, a fire from OUTSIDE the scheduler — the tx is
      // absent or unstamped: a DOM/renderer fire, an imperative send —
      // commits THE EVENT as its one authored act: an append to the
      // stream's sidecar doc, queued for fired-order delivery (offline
      // queue, events.md §5/LT9). The local run below is the speculative
      // ECHO. A send from WITHIN a scheduler-stamped run (a handler
      // cascade, echo-side) commits nothing — the scheduler tell
      // (protocol.md §1): only scheduler-driven work moved to the server,
      // and the server's authoritative run produces the durable cascade.
      let firedEventId: string | undefined;
      if (
        this.runtime.experimental.serverExecution === true &&
        this.runtime.servingPosture !== true &&
        (this.tx === undefined ||
          speculationRunContextOf(this.tx) === undefined)
      ) {
        firedEventId = deliveryEventId ??
          mintEventId(resolvedToValueLink, this.tx ?? undefined);
        const stream: StreamLinkRef = {
          id: resolvedToValueLink.id,
          path: [...resolvedToValueLink.path],
          ...(resolvedToValueLink.scope !== undefined
            ? { scope: resolvedToValueLink.scope }
            : {}),
        };
        const sidecarId = streamEntriesDocId(stream);
        const space = resolvedToValueLink.space;
        const replica = this.runtime.storageManager.open(space).replica;
        if (replica.enqueueEventAppend === undefined) {
          // Fail CLOSED (the cross-space arm's posture): a flag-ON
          // fire that cannot commit its event would silently lose the
          // user's intent — refuse loudly instead (events.md §1, §7).
          throw new Error(
            "event fire refused: the storage provider does not support " +
              "event appends, and a flag-ON fire commits ONLY the event " +
              "(events.md §7)",
          );
        }
        {
          const overlay = this.runtime.speculationOverlay;
          overlay?.trackIntent(space, sidecarId, firedEventId);
          const eventId = firedEventId;
          const outcome = replica.enqueueEventAppend({
            sidecarId,
            stream,
            eventId,
            payload: event as never,
            ...(mintedKeys !== undefined
              ? { runtimeInjectedEventKeys: [...mintedKeys] }
              : {}),
            // The renderer-trust attestation (fan-out stage B, OW34):
            // the runtime — never the pattern — records that the sent
            // event carried the process-local renderer-trust mark, so the
            // SERVED handler run can re-mark the payload and record the
            // trusted-event policy input its UI-contract-gated writes
            // need. The sister of the injected-keys carriage above, same
            // trust argument (see StreamEventEntry.rendererTrusted).
            ...(isRendererTrustedEvent(event) ? { rendererTrusted: true } : {}),
          }).then((delivery) => {
            if (!delivery.delivered) {
              // Deterministic admission refusal: the intent is dead —
              // un-render the echo and signal (events.md §5).
              overlay?.resolveIntent(space, sidecarId, eventId, {
                kind: "refused",
                reason: delivery.refused,
              });
            }
            return delivery;
          });
          // The durability barrier (`synced()`) covers undischarged
          // intents: an event queued offline is an unacked write.
          this.runtime.storageManager.trackPendingCommit(
            outcome as Promise<unknown>,
          );
          // The durable-ack coupling (verdict blocker, 2026-08-12): the
          // caller's settle callback must NEVER settle from the
          // speculative local run — under events-down the local
          // handling is the diverted ECHO and its tx commits nothing
          // durable, yet unchanged callers (the CLI verb dispatch, the
          // webhook forwarder) read the callback's tx as the durable
          // acknowledgment. The callback now settles from the APPEND
          // outcome + the intent's authoritative CONSEQUENCE: refusal,
          // a server-side handler error, or the dropped-event notice
          // present an error-status view of the tx; only a delivered
          // append whose handling consequenced (or a bare teardown,
          // reported as such) passes the tx through untouched.
          const onAppended = sendOptions?.onAppended;
          if (onCommit !== undefined || onAppended !== undefined) {
            const callerOnCommit = onCommit;
            onCommit = (echoTx: IExtendedStorageTransaction) => {
              void outcome.then(async (delivery) => {
                onAppended?.(delivery, echoTx);
                if (callerOnCommit === undefined) return;
                if (!delivery.delivered) {
                  callerOnCommit(errorStatusTxView(
                    echoTx,
                    `event append refused: ${delivery.refused}`,
                  ));
                  return;
                }
                const consequence = overlay === undefined
                  ? { kind: "consequenced" as const }
                  : await overlay.waitForIntentConsequence(space, eventId);
                if (
                  consequence.kind === "errored" ||
                  consequence.kind === "dropped" ||
                  consequence.kind === "refused" ||
                  consequence.kind === "needs-attention"
                ) {
                  callerOnCommit(errorStatusTxView(
                    echoTx,
                    `event handling ${consequence.kind}: ${
                      consequence.reason ?? consequence.kind
                    }`,
                  ));
                  return;
                }
                callerOnCommit(echoTx);
              });
            };
          }
        }
      }

      // Server-execution v2 Phase 3, the SERVING arm (events.md §2): a
      // send from a wave-stamped run — a handler cascade, a demanded
      // derivation's emission — is a SERVER-ORIGINATED event carrying
      // the run's INHERITED actor. Same-space targets get their durable
      // stream entry as a WRITE WITHIN the current transaction (LT1's
      // wave carriage: the entry commits with — and rolls back with —
      // the emitting run; the committed entry is durable input the next
      // wave's drain processes, LT1's budget-exhausted fallback).
      // Cross-space targets stage onto the wave's outbox (FP1's durable
      // rows; delivery is post-commit, the loop never awaits another
      // space). Neither queues locally — the drain is the one
      // processing path (events.md §2's "one path, two producers").
      if (
        this.runtime.experimental.serverExecution === true &&
        this.runtime.servingPosture === true &&
        this.tx !== undefined
      ) {
        const context = waveRunContextOf(this.tx);
        if (context !== undefined) {
          const stream: StreamLinkRef = {
            id: resolvedToValueLink.id,
            path: [...resolvedToValueLink.path],
            ...(resolvedToValueLink.scope !== undefined
              ? { scope: resolvedToValueLink.scope }
              : {}),
          };
          const sidecarId = streamEntriesDocId(stream);
          const emittedId = mintEventId(resolvedToValueLink, this.tx);
          // Fan-out stage B (design §F's point of use, RULED 2026-08-16):
          // a demanded DERIVATION's actor derives from the scope it has
          // discovered SO FAR (never broader than the node's known-scope
          // ratchet for this principal), and the scope used is recorded
          // on the run context so an emission the run later out-narrows
          // is refused at the seal — the early-emit guard, fail-closed.
          // Handler runs (explicit `firedAt` actor) are unchanged.
          const acting = actingForEmission(context, this.tx);
          // The LT1-vs-outbox axis is the WAVE'S HOME SPACE (LT1: a
          // SAME-SPACE server-emitted append rides the wave's own
          // derived commit; events.md §2's cross-space arm is the
          // outbox). The sending CELL's space is not that axis: a
          // foreign stream reached through a direct foreign cell handle
          // (a wish-result export — profile-embed's `setName`) has
          // cell.space === resolved.space === the FOREIGN space, and
          // the same-space arm's raw entries write would open a second
          // space's writer inside the run's home-anchored transaction —
          // the one-tx-one-space isolation error (protocol.md §2b) that
          // kills the handler run and loses the emission. Fail-closed:
          // an OUTBOX-CAPABLE destination that names no home space
          // cannot route this decision, and guessing from the cell's
          // space is exactly the mis-axis this branch exists to avoid —
          // refuse loudly. A destination with no outbox at all (bare
          // seal-only test doubles) keeps the cell-space proxy: those
          // harnesses are same-space by construction, and their
          // cross-space arm below refuses on the missing outbox anyway.
          const destination = this.runtime.installedSealDestination;
          if (
            destination?.stageOutboundAppend !== undefined &&
            destination.space === undefined
          ) {
            throw new Error(
              "server-side emission refused: the installed seal " +
                "destination stages outbound appends but names no home " +
                "space, so the LT1-vs-outbox routing axis (the WAVE's " +
                "home space — events.md §2; protocol.md §2b) cannot be " +
                "resolved. Expose `space` on the destination.",
            );
          }
          const servingSpace = destination?.space ?? this.space;
          if (resolvedToValueLink.space === servingSpace) {
            // LT1 same-space carriage: the entry rides the current tx.
            // The engine stamps its stream `seq` at the wave commit
            // (the batch declares it); `firedAt` is the inherited
            // actor, written here — producer and admitter are one
            // trust environment (events.md §2). RAW tx write, not
            // Cell.push: a frame-anchored push cellifies the pushed
            // object into a linked child doc, and a LINK where the
            // entry should be is exactly the shape admission refuses.
            // The mergeable-append record keeps the commit
            // tail-relative (concurrent appends merge, never clobber).
            const entriesLink = {
              space: resolvedToValueLink.space,
              id: sidecarId,
              scope: "space",
              path: ["entries"],
            } as unknown as NormalizedFullLink;
            // The tail read is APPEND MECHANICS, not a semantic input
            // (adjudicated coordinator 2026-08-11, VETOABLE — review
            // M3): a sender does not re-send because someone else
            // sent. Unmarked, this read put the target sidecar in the
            // EMITTING run's dependency log and basis rows, so a
            // demanded derivation emitter RE-RAN (and re-emitted,
            // fresh eventId) on any neighbor's append to the same
            // stream. Classified with the existing machinery-read
            // boundary: `ignoreReadForScheduling` keeps it out of the
            // reactivity log (no re-run subscription), and
            // `mergeableOpRead` — the Cell.push precedent, paired
            // with the recorded mergeable append below — keeps it out
            // of the commit's conflict read set, and with it out of
            // the sealed reads that feed wave basis rows (§3b).
            const currentEntries = this.tx.readValueOrThrow(entriesLink, {
              meta: { ...ignoreReadForScheduling, ...mergeableOpRead },
            });
            const emittedEntry = {
              eventId: emittedId,
              stream,
              payload: event,
              firedAt: {
                ...(acting?.user !== undefined ? { user: acting.user } : {}),
                session: acting?.session ?? "server",
              },
              // A served cascade forwarding a renderer-trusted event
              // object keeps its attestation (in-process propagation's
              // durable twin; fan-out stage B, OW34).
              ...(isRendererTrustedEvent(event)
                ? { rendererTrusted: true as const }
                : {}),
            };
            this.tx.writeValueOrThrow(entriesLink, [
              ...(Array.isArray(currentEntries) ? currentEntries : []),
              emittedEntry,
            ] as never);
            this.tx.recordMergeableOp?.(entriesLink, {
              op: "append",
              count: 1,
            });
            // Same-wave processing (LT1, D-v2-2: "the loop is simply
            // not idle until all events are processed"): queue the
            // emitted event in-process too. Its handler runs in THIS
            // wave; the batch build marks the entry consequenced IFF
            // that run's contribution SURVIVED the wave (wave.ts) — a
            // requeued run leaves the entry unmarked and the next
            // wave's drain re-runs it (C8b), and an emitter that
            // requeues withdraws the entry with its own contribution
            // (C8d). No streamEntry on the stamp: the entry has no
            // durable index yet — the batch owns the mark. The
            // EMITTER's eventId rides as the cascade's parentEventId
            // (review 2026-08-11 M2): the C8d fold keys on it, and
            // without the thread a cascade child COMMITTED while its
            // requeued parent re-emitted under a fresh id — the
            // orphan-consequence double. The EMITTER's transaction rides
            // as `lt1.emitterTx` (stage C build W3, (α); events.md §4's
            // RULED sentence): its seal chooses the wave that carries
            // the entry, and this copy completes in THAT wave or not at
            // all — a copy the flush deadline leaves queued is purged at
            // the deadline, a copy still running at the deadline is
            // refused at the seal (it would commit unmarked in the next
            // wave beside the drain's marked copy — the lunch gate's
            // vote-toggle double); either way the durable entry is the
            // truth and the drain delivers it ONCE, with a streamEntry.
            this.runtime.scheduler.queueEvent(
              resolvedToValueLink,
              event,
              false,
              undefined,
              false,
              {
                eventId: emittedId,
                served: {
                  firedAt: {
                    ...(acting?.user !== undefined
                      ? { user: acting.user }
                      : {}),
                    session: acting?.session ?? "server",
                  },
                  ...(context.eventId !== undefined
                    ? { parentEventId: context.eventId }
                    : {}),
                  lt1: { emitterTx: this.tx },
                },
              },
            );
          } else {
            // Cross-space: the outbox's durable row (FP1), carrying the
            // acting identity — actor inheritance crosses spaces
            // through exactly this carriage (events.md §2) — and the
            // OW15 declaration when the chain has no actor. The
            // capabilityRef is structural presence (grant RESOLUTION
            // is the OW13 owed hardening; no per-doc grant store
            // exists yet).
            // DEPENDENCY MARKER (the scheduler-instance follow-up,
            // OW17/P2-F): today every derivation run carries NO acting
            // identity, so `acting === undefined` truthfully means "a
            // chain with no actor anywhere" and the OW15 declaration
            // below is sound. The day per-instance demanded runs
            // supply acting identities (LT6: a user-instance run's
            // emission carries the user), this derivation must keep
            // reading the RUN's acting identity — deriving
            // userlessness from a MISSING supply would misdeclare a
            // user's emission sessionless-space-scope and destroy the
            // actor at delivery.
            const userless = acting?.user === undefined;
            const row: OutboxAppendRow = {
              targetSpace: resolvedToValueLink.space,
              targetStream: sidecarId,
              targetStreamLink: stream,
              eventId: emittedId,
              payload: event as never,
              ...(userless ? {} : { actingPrincipal: acting!.user }),
              ...(acting?.session !== undefined
                ? { actingSession: acting.session }
                : {}),
              ...(userless && acting?.session === undefined
                ? { sessionlessSpaceScope: true }
                : {}),
              capabilityRef: `stream-append:${sidecarId}`,
              ...(context.streamEntry !== undefined &&
                  context.eventId !== undefined
                ? {
                  sourceEvent: {
                    sidecarId: context.streamEntry.sidecarId,
                    eventId: context.eventId,
                  },
                }
                : {}),
            };
            if (destination?.stageOutboundAppend === undefined) {
              throw new Error(
                "cross-space event emission requires the serving loop's " +
                  "outbox (events.md §2; serving-loop.md §5) — no seal " +
                  "destination with outbound staging is installed",
              );
            }
            destination.stageOutboundAppend(this.tx, row);
          }
          this.#cleanup?.();
          const [cancel, addCancel] = useCancelGroup();
          this.#cleanup = cancel;
          this.#listeners.forEach((callback) => addCancel(callback(event)));
          return this as unknown as Cell<T>;
        }
      }

      // The client-echo cascade thread (independent review M1,
      // 2026-08-11): a send from WITHIN a speculation-stamped handler
      // run is the echo of a same-wave cascade — the queued event's id
      // is minted fresh for THIS attempt, diverging from the server's
      // own mint, so the dispatch stamp must mark downstream navigate
      // captures ATTEMPT-MINTED (navigate-context.ts). Thread the
      // emitter's eventId the same way the serving arm's carriage does
      // (cell.ts's LT1 branch above); root fires (unstamped sends)
      // thread nothing and keep their durable-id capture.
      const clientEmitterContext = this.tx !== undefined
        ? speculationRunContextOf(this.tx)
        : undefined;
      const clientCascadeParent =
        clientEmitterContext?.kind === "event-handler" &&
          clientEmitterContext.eventId !== undefined
          ? clientEmitterContext.eventId
          : undefined;

      // Trigger on fully resolved link. The origin transaction below is
      // the LT6 carriage (events.md §2, stage P2-F): on a serving
      // runtime, the dispatch choke point reads the emitting run's
      // stamped identity off this tx and hands it to the handler run —
      // an event emitted by ANY run carries that run's acting identity,
      // so a demanded (user, session) derivation's emissions no longer
      // classify userless. Everywhere else the tx carries no wave stamp
      // and the carriage is inert. (Under Phase 3's serving arm the
      // wave-stamped emission paths above intercept first and carry the
      // same actor explicitly, as the entry's `firedAt`; this carriage
      // covers the remaining in-process queueEvent shapes.)
      // Off server execution the handling's commit is the sender's own
      // authored act, so `onAppended` fires with the commit callback, and
      // reports what the commit did: delivered when it landed, and when
      // it collided on the handling's receipt — a retry of the same
      // invocation, which settles on the original outcome — and refused,
      // with the reason, when the handling threw or its commit was
      // rejected. Under server execution the wrapper above fires the hook
      // off the append itself.
      const appendedWithCommit = sendOptions?.onAppended;
      const settleCallback = firedEventId === undefined &&
          appendedWithCommit !== undefined
        ? (tx: IExtendedStorageTransaction) => {
          const status = tx.status();
          const deduplicated = status.status === "error" &&
            "precondition" in status.error &&
            status.error.precondition === "receipt-exists";
          appendedWithCommit(
            status.status === "error" && !deduplicated
              ? {
                delivered: false,
                refused: status.error instanceof Error
                  ? status.error.message
                  : String(
                    (status.error as { message?: unknown }).message ??
                      status.error,
                  ),
              }
              : { delivered: true },
            tx,
          );
          onCommit?.(tx);
        }
        : onCommit;
      this.runtime.scheduler.queueEvent(
        resolvedToValueLink,
        event,
        undefined,
        settleCallback,
        false,
        {
          // Under events-down the COMMITTED append's id is the one the
          // echo must carry (overlay origin `intent(eventId)`,
          // speculation.md §1) — the same session-scoped id, one mint.
          eventId: firedEventId ?? deliveryEventId,
          ...(clientCascadeParent !== undefined
            ? { parentEventId: clientCascadeParent }
            : {}),
          originTx: this.tx ?? undefined,
          // Forward injection provenance only when it carries the mint (see
          // markRuntimeInjectedEventKeys): a plain array here — the shape any
          // in-process or sandboxed caller could pass — is dropped, and the
          // closed-world gate then judges the key like any other undeclared
          // field.
          runtimeInjectedEventKeys: mintedKeys,
        },
      );

      this.#cleanup?.();
      const [cancel, addCancel] = useCancelGroup();
      this.#cleanup = cancel;

      this.#listeners.forEach((callback) => addCancel(callback(event)));
    } else {
      // Regular cell behavior
      if (!this.tx) {
        throw new Error(
          "Transaction required for .set() - mutations only work in handlers\n" +
            "help: use handler() to create transaction context, or computed() for read-only transformations",
        );
      }

      // No await for the sync, just kicking this off, so we have the data to
      // retry on conflict.
      if (!this.#synced) this.sync();

      recordRelevantSchemaWritePolicyInput(
        this.tx,
        resolvedToValueLink,
        resolvedToValueLink.schema ?? this.schema,
      );

      const writeLink = resolveLink(
        this.runtime,
        this.tx,
        this.#link,
        "writeRedirect",
      );

      // TODO(@ubik2) investigate whether i need to check confidential as i walk down my own obj
      // The anchor id source makes sure each object in an array gets its own
      // doc, its id drawn from the frame this cell was made in
      // (`frameAnchorIds()`).
      diffAndUpdate(
        this.runtime,
        this.tx,
        writeLink,
        newValue,
        this.#frame?.cause,
        undefined,
        frameAnchorIds(this.#frame),
      );

      // A whole-value set reshapes what a mergeable op intent (an earlier push /
      // addUnique / increment / removeByValue in this transaction) refers to,
      // both at the path it writes and anywhere beneath it — writing an
      // enclosing object rewrites the arrays inside it too. Poison those intents,
      // keyed on `writeLink`, the path diffAndUpdate wrote, so the commit emits
      // this set's whole-array diff rather than a stale tail op.
      //
      // Keying on the written path is what keeps this correct for the writes
      // that should NOT disturb an op: a set on a CHILD path (an element edit)
      // sits beneath the array, so the array's own intent is above the write and
      // survives, and a set that lands on an unrelated slot (a non-redirect
      // alias, a sibling field) covers no intent at all. Only a write at or
      // above an op's array poisons it.
      this.tx.poisonMergeableOp?.(writeLink);

      // Register commit callback if provided. (Bound to a local: the
      // stream branch above reassigns `onCommit` for the durable-ack
      // coupling, which widens the parameter's narrowing.)
      const settleCallback = onCommit;
      if (settleCallback) {
        this.tx.addCommitCallback((committedTx) => {
          try {
            settleCallback(committedTx);
          } catch (error) {
            console.error("Error in cell onCommit callback:", error);
          }
        });
      }
    }

    return this as unknown as Cell<T>;
  }

  send(
    ...args: T extends void ? [] | [AnyCellWrapping<T>] | [
        AnyCellWrapping<T>,

        /**
         * Internal-only commit callback. This runs after the final commit
         * result, including failure, so it must remain non-effectful. Use the
         * post-commit outbox for external side effects that must happen only
         * after success.
         */
        (tx: IExtendedStorageTransaction) => void,
      ] | [
        AnyCellWrapping<T>,
        ((tx: IExtendedStorageTransaction) => void) | undefined,
        StreamSendOptions,
      ]
      : [AnyCellWrapping<T>] | [
        AnyCellWrapping<T>,

        /**
         * Internal-only commit callback. This runs after the final commit
         * result, including failure, so it must remain non-effectful. Use the
         * post-commit outbox for external side effects that must happen only
         * after success.
         */
        (tx: IExtendedStorageTransaction) => void,
      ] | [
        AnyCellWrapping<T>,
        ((tx: IExtendedStorageTransaction) => void) | undefined,

        /**
         * Internal-only stream-send options (see {@link StreamSendOptions}):
         * `eventId` passes a caller-supplied durable event id through to the
         * scheduler, and `session` the caller that chose it, so a retry of
         * that pair collides on the handling's create-only receipt and cannot
         * commit twice — though the body does re-run (verb contract WS-D).
         * `runtimeInjectedEventKeys` carries runtime-injection provenance for
         * the closed-world gate.
         */
        StreamSendOptions,
      ]
  ): void {
    const [event, onCommit, sendOptions] = args;
    this.set(event as AnyCellWrapping<T>, onCommit, sendOptions);
  }

  update<V extends (Partial<T> | AnyCellWrapping<Partial<T>>)>(
    values: V extends object ? AnyCellWrapping<V> : never,
  ): Cell<T> {
    if (!this.tx) {
      throw new Error(
        "Cell.update() requires transaction and object value\n" +
          "help: use in handlers for partial updates, or .set() for non-object values",
      );
    }
    if (!isObjectOrArray(values)) {
      throw new Error(
        "Cell.update() requires transaction and object value\n" +
          "help: use in handlers for partial updates, or .set() for non-object values",
      );
    }

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.#synced) this.sync();

    // Get current value, following aliases and references
    // The read half of this read-modify-write is a content read: labeled
    // crossings mark (the write half's policy input is recorded separately).
    const resolvedLink = resolveLink(
      this.runtime,
      this.tx,
      this.#link,
      "value",
      {
        markIfcCrossings: true,
      },
    );
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      resolvedLink,
      resolvedLink.schema ?? this.schema,
    );
    const currentValue = this.tx.readValueOrThrow(resolvedLink);

    // If there's no current value, initialize based on schema, even if there is
    // no default value.
    if (currentValue === undefined) {
      const resolvedSchema = resolveSchema(this.schema);

      // TODO(seefeld,ubik2): This should all be moved to schema helpers. This
      // just wants to know whether the value could be an object.
      const allowsObject = resolvedSchema === undefined ||
        ContextualFlowControl.isTrueSchema(resolvedSchema) ||
        (isObjectOrArray(resolvedSchema) &&
          (resolvedSchema.type === "object" ||
            (Array.isArray(resolvedSchema.type) &&
              resolvedSchema.type.includes("object")) ||
            (resolvedSchema.anyOf &&
              resolvedSchema.anyOf.some((s) =>
                typeof s === "object" && s.type === "object"
              ))));

      if (!allowsObject) {
        throw new Error(
          "Cannot update with object value - schema does not allow objects",
        );
      }

      // This initialization write only occurs after the read above proved the
      // value is absent, so no-op attempted-target coverage is not relevant.
      this.tx.writeValueOrThrow(resolvedLink, {});
    }

    // Now update each property
    for (const [key, value] of Object.entries(values)) {
      (this as unknown as Cell<any>).key(key).set(value);
    }

    return this as unknown as Cell<T>;
  }

  push(
    ...value: T extends (infer U)[] ? (U | AnyCellWrapping<U>)[] : never
  ): void {
    if (!this.tx) {
      throw new Error(
        "Cell.push() requires transaction and array value\n" +
          "help: use in handlers only, ensure cell is typed as array",
      );
    }

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.#synced) this.sync();

    // Follow aliases and references, since we want to get to an assumed
    // existing array.
    // The read half of this read-modify-write is a content read: labeled
    // crossings mark (the write half's policy input is recorded separately).
    const resolvedLink = resolveLink(
      this.runtime,
      this.tx,
      this.#link,
      "value",
      {
        markIfcCrossings: true,
      },
    );
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      resolvedLink,
      resolvedLink.schema ?? this.schema,
    );
    // The append's destination snapshot supplies storage positions without
    // exposing content or length to the caller. It joins neither observed
    // labels nor conflict preconditions; explicit handler reads retain both.
    let currentValue = this.tx.readValueOrThrow(resolvedLink, {
      meta: { ...mergeableOpRead, ...writeDestinationRead },
    });
    const cause = this.#frame?.cause;

    if (!Array.isArray(currentValue)) {
      if (currentValue !== undefined) {
        throw new Error(
          "Cell.push() requires transaction and array value\n" +
            "help: use in handlers only, ensure cell is typed as array",
        );
      }

      // No array yet, so create it first. This has to be a separate operation,
      // so that in the next steps each object element is properly anchored in
      // the array.
      diffAndUpdate(
        this.runtime,
        this.tx,
        resolvedLink,
        [],
        cause,
      );
      const resolvedSchema = resolveSchema(this.schema);
      // Annotated rather than inferred: `processDefaultValue()` returns `any`,
      // and assigning that back to `currentValue` would discard the narrowing
      // this block exists to establish.
      const created: FabricValue[] =
        isObjectOrArray(resolvedSchema) && Array.isArray(resolvedSchema.default)
          ? processDefaultValue(
            this.runtime,
            this.tx,
            this.#link,
            resolvedSchema.default,
          )
          : [];
      // From here on `currentValue` is the array just created, not what the
      // read returned.
      currentValue = created;
    }

    // Read-only: a value that came from storage is a `FabricArray`, which is a
    // `ReadonlyArray`, and though a freshly created one is not, this method
    // only ever reads what it finds -- the replacement is `combined`, below.
    const array: readonly unknown[] = currentValue;

    // Append the new values to the array, preserving sparse holes in the original.
    const combined = new Array(array.length + value.length);
    array.forEach((v, i) => {
      combined[i] = v;
    });
    for (let i = 0; i < value.length; i++) {
      combined[array.length + i] = value[i];
    }
    // The anchor id source makes sure each pushed object gets its own doc,
    // its id drawn from the frame this cell was made in (`frameAnchorIds()`).
    diffAndUpdate(
      this.runtime,
      this.tx,
      resolvedLink,
      combined,
      cause,
      undefined,
      frameAnchorIds(this.#frame),
    );

    // Record the append intent so the commit emits a tail-relative, mergeable
    // operation instead of a position diffed against a possibly-stale base.
    this.tx.recordMergeableOp?.(resolvedLink, {
      op: "append",
      count: value.length,
    });
  }

  addUnique(
    ...value: T extends (infer U)[] ? (U | AnyCellWrapping<U>)[] : never
  ): void {
    if (!this.tx) {
      throw new Error(
        "Cell.addUnique() requires transaction and array value\n" +
          "help: use in handlers only, ensure cell is typed as array",
      );
    }
    for (const candidate of value) {
      refuseElementReadBack("addUnique", candidate);
    }
    if (!this.#synced) this.sync();

    // The read half of this read-modify-write is a content read: labeled
    // crossings mark (the write half's policy input is recorded separately).
    const resolvedLink = resolveLink(
      this.runtime,
      this.tx,
      this.#link,
      "value",
      {
        markIfcCrossings: true,
      },
    );
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      resolvedLink,
      resolvedLink.schema ?? this.schema,
    );
    let currentValue = this.tx.readValueOrThrow(resolvedLink, {
      meta: mergeableOpRead,
    });
    const cause = this.#frame?.cause;

    if (!Array.isArray(currentValue)) {
      if (currentValue !== undefined) {
        throw new Error(
          "Cell.addUnique() requires transaction and array value\n" +
            "help: use in handlers only, ensure cell is typed as array",
        );
      }

      diffAndUpdate(this.runtime, this.tx, resolvedLink, [], cause);
      const resolvedSchema = resolveSchema(this.schema);
      // Annotated for the same reason as in `push()`: `processDefaultValue()`
      // returns `any`, which would discard the narrowing on assignment.
      const created: FabricValue[] =
        isObjectOrArray(resolvedSchema) && Array.isArray(resolvedSchema.default)
          ? processDefaultValue(
            this.runtime,
            this.tx,
            this.#link,
            resolvedSchema.default,
          )
          : [];
      // As in `push()`, `currentValue` is now the created array.
      currentValue = created;
    }

    // Read-only for the same reason as in `push()`: the comparisons below only
    // read, and the replacement is built separately.
    const array: readonly FabricValue[] = currentValue;

    // Keep only the values not already present (by stored-value equality,
    // matching the server's add-unique dedup). The server re-dedups against
    // durable state, catching elements the local replica had not loaded.
    const candidates = value;
    const existing = array;
    // A cell candidate matches an existing element by its (deterministic) link,
    // so re-adding the same keyed entity is a local no-op; a plain value matches
    // by content, mirroring the server's keyless dedup. The content comparison
    // runs against a fabric-normalized COPY of the candidate (a JS `Date`
    // must match its stored `FabricEpochNsec` form); the original candidate --
    // not the copy -- is what an accepted add writes, so no identity the write
    // path relies on is disturbed.
    const alreadyPresent = (candidate: FabricValue) => {
      if (isCell(candidate)) {
        return existing.some((element) =>
          areLinksSame(
            element,
            candidate,
            this as unknown as Cell<any>,
            true,
            this.tx!,
            this.runtime,
            true,
          )
        );
      }
      // A cyclic candidate can never equal a stored element -- stored fabric
      // values are acyclic (cycles persist as links) -- so it is new by
      // definition, and must skip the strict normalization a cycle would
      // break; the write path anchors it with the cycle as a self-link.
      if (containsCycle(candidate)) {
        return false;
      }
      // A raw sigil link compares as itself -- the write boundary passes it
      // through unconverted, and the strict conversion would reject its
      // non-string-keyed internals.
      const comparable = isCellLink(candidate)
        ? candidate
        : fabricFromConvertibleJsValue(flattenBuilderArtifacts(candidate));
      return existing.some((element) => valueEqual(element, comparable));
    };
    const toAdd = candidates.filter((candidate) => !alreadyPresent(candidate));
    if (toAdd.length === 0) {
      return;
    }
    // The anchor id source makes sure each added object gets its own doc,
    // its id drawn from the frame this cell was made in (`frameAnchorIds()`).
    diffAndUpdate(
      this.runtime,
      this.tx,
      resolvedLink,
      [...existing, ...toAdd],
      cause,
      undefined,
      frameAnchorIds(this.#frame),
    );
    this.tx.recordMergeableOp?.(resolvedLink, {
      op: "add-unique",
      count: toAdd.length,
    });
  }

  increment(by: number = 1): void {
    if (!this.tx) {
      throw new Error(
        "Cell.increment() requires transaction and number value\n" +
          "help: use in handlers only, ensure cell is typed as number",
      );
    }
    if (!Number.isFinite(by) || by === 0) {
      throw new Error(
        "Cell.increment() requires a finite non-zero amount\n" +
          "help: a zero or non-finite increment is not a meaningful change",
      );
    }
    if (!this.#synced) this.sync();

    // The read half of this read-modify-write is a content read: labeled
    // crossings mark (the write half's policy input is recorded separately).
    const resolvedLink = resolveLink(
      this.runtime,
      this.tx,
      this.#link,
      "value",
      {
        markIfcCrossings: true,
      },
    );
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      resolvedLink,
      resolvedLink.schema ?? this.schema,
    );
    const currentValue = this.tx.readValueOrThrow(resolvedLink, {
      meta: mergeableOpRead,
    });
    if (currentValue !== undefined && typeof currentValue !== "number") {
      throw new Error(
        "Cell.increment() requires transaction and number value\n" +
          "help: use in handlers only, ensure cell is typed as number",
      );
    }
    const cause = this.#frame?.cause;
    const next = (typeof currentValue === "number" ? currentValue : 0) + by;
    diffAndUpdate(this.runtime, this.tx, resolvedLink, next, cause);

    // Record the increment intent so the commit emits a mergeable increment the
    // server resolves against durable state instead of a value diffed against a
    // possibly-stale read.
    this.tx.recordMergeableOp?.(resolvedLink, { op: "increment", by });
  }

  /**
   * Removes every element of this array equal to `ref` by stored value. A cell
   * ref matches by its (deterministic) link, so the membership entry is removed
   * without depending on the list's prior contents — concurrent removes of
   * distinct entries merge. The optimistic local filter and the committed op
   * both match by the stored value.
   */
  removeByValue(
    ref: T extends (infer U)[] ? (U | AnyCell<U>) : never,
  ): void {
    if (!this.tx) {
      throw new Error(
        "Cell.removeByValue() requires transaction and array value\n" +
          "help: use in handlers only, ensure cell is typed as array",
      );
    }
    refuseElementReadBack("removeByValue", ref);
    if (!this.#synced) this.sync();

    // The read half of this read-modify-write is a content read: labeled
    // crossings mark (the write half's policy input is recorded separately).
    const resolvedLink = resolveLink(
      this.runtime,
      this.tx,
      this.#link,
      "value",
      {
        markIfcCrossings: true,
      },
    );
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      resolvedLink,
      resolvedLink.schema ?? this.schema,
    );
    const currentValue = this.tx.readValueOrThrow(resolvedLink, {
      meta: mergeableOpRead,
    });
    const array = currentValue;
    if (array === undefined) {
      return;
    }
    if (!Array.isArray(array)) {
      throw new Error(
        "Cell.removeByValue() requires transaction and array value\n" +
          "help: use in handlers only, ensure cell is typed as array",
      );
    }
    // A cell ref matches an element by its (deterministic) link; a plain value
    // matches by stored-value equality. The removed elements are the array's
    // stored representations (links stay as their sigil), so recording each one
    // as the op's value lets the server match the durable element exactly.
    const matches = (element: FabricValue) =>
      isCell(ref)
        ? areLinksSame(
          element,
          ref,
          this as unknown as Cell<any>,
          true,
          this.tx!,
          this.runtime,
          true,
        )
        : valueEqual(element, ref as FabricValue);
    const removed = array.filter(matches);
    if (removed.length === 0) {
      return;
    }
    const filtered = array.filter((element) => !matches(element));
    diffAndUpdate(
      this.runtime,
      this.tx,
      resolvedLink,
      filtered,
      this.#frame?.cause,
    );
    for (const element of removed) {
      this.tx.recordMergeableOp?.(resolvedLink, {
        op: "remove-by-value",
        value: element,
      });
    }
  }

  /**
   * Returns a cell for the entity deterministically derived from this array and
   * `idKey` — the entity a keyed element of this array is identified by. The
   * derivation is content-only (no per-event cause), so the same `idKey` always
   * resolves to the same entity. This lets a handler read/edit one keyed
   * element (e.g. "my vote for this option") and add or remove its membership
   * via `addUnique()` / `removeByValue()`, without ever reading the whole
   * array.
   */
  elementById(idKey: string, schema?: JSONSchema): Cell<any> {
    const tx = this.runtime.readTx(this.tx);
    const resolvedLink = resolveLink(this.runtime, tx, this.#link, "value", {
      markIfcCrossings: true,
    });
    const entityId = createRef(
      { id: idKey },
      {
        parent: { id: resolvedLink.id, space: resolvedLink.space },
        path: resolvedLink.path,
      },
    );
    const arraySchema = resolveSchema(resolvedLink.schema ?? this.schema);
    // The element's index is unknown here (id-keyed addressing, and this
    // method deliberately never reads the array), so a tuple schema's slot
    // cannot be selected: elementSchemaFor falls back to the rest `items`
    // schema for prefixItems arrays. A caller that knows the element sits
    // in a tuple slot can pass the slot schema explicitly via `schema`.
    const elementSchema = schema ?? elementSchemaFor(arraySchema);
    return this.runtime.getCellFromEntityId(
      resolvedLink.space,
      entityId,
      [],
      elementSchema,
      this.tx,
      resolvedLink.scope,
    );
  }

  remove(
    ref: T extends (infer U)[] ? (U | AnyCell<U>) : never,
  ): void {
    type ElemT = T extends (infer U)[] ? U : never;
    const got = this.get();
    if (!Array.isArray(got)) {
      throw new Error("Can't remove from non-array value");
    }
    const array = got as ElemT[];
    const index = typeof ref === "object"
      ? array.findIndex((item) => this.#refMatchesElement(ref, item))
      // Primitives match by `Object.is` (`NaN` is findable; `0` and `-0` are
      // distinct), unlike `indexOf`'s `===`.
      : array.findIndex((item) => Object.is(item, ref));
    if (index === -1) {
      return;
    }
    // Cast needed: TS can't prove ElemT[] reconstitutes to T
    const newArray = [
      ...array.slice(0, index),
      ...array.slice(index + 1),
    ] as unknown as T;
    this.set(newArray);
  }

  removeAll(
    ref: T extends (infer U)[] ? (U | AnyCell<U>) : never,
  ): void {
    type ElemT = T extends (infer U)[] ? U : never;
    const got = this.get();
    if (!Array.isArray(got)) {
      throw new Error("Can't remove from non-array value");
    }
    const array = got as ElemT[];
    // Cast needed: TS can't prove ElemT[] reconstitutes to T
    const newArray = array.filter((item) =>
      typeof ref === "object"
        ? !this.#refMatchesElement(ref, item)
        // As in `remove()`: primitives match by `Object.is`.
        : !Object.is(item, ref)
    ) as unknown as T;
    this.set(newArray);
  }

  /**
   * Whether an object-valued `remove()`/`removeAll()` argument names the given
   * array element. A cell or a link names its element by link, which is what
   * `areLinksSame()` decides. A `FabricSpecialObject` keeps its state in
   * private fields, so a link comparison can only tell whether the two are the
   * same object -- and two equal fabric values written at different times never
   * are. Those name their element by content, the way `removeByValue()`
   * matches.
   */
  #refMatchesElement(ref: unknown, element: unknown): boolean {
    if (
      areLinksSame(
        element,
        ref,
        this as unknown as Cell<any>,
        true, // resolveBeforeComparing
        this.tx,
        this.runtime,
      )
    ) {
      return true;
    }

    return isFabricSpecialObject(ref) && isFabricSpecialObject(element) &&
      valueEqual(element, ref);
  }

  equals(other: any): boolean {
    return areLinksSame(
      this,
      other,
      undefined,
      true,
      this.runtime.readTx(this.tx),
      this.runtime,
    );
  }

  equalLinks(other: any): boolean {
    return areLinksSame(this, other);
  }

  /**
   * Navigate to nested properties by one or more keys.
   *
   * @example
   * cell.key("user")                      // Cell<User>
   * cell.key("user", "profile")           // Cell<Profile>
   * cell.key("user", "profile", "name")   // Cell<string>
   */
  key(...keys: PropertyKey[]): Cell<any> {
    let currentLink = this.#_link;
    let childSchema: JSONSchema | undefined;
    const childPath = keys.map((key) => key.toString());

    // Follow caps this walk narrows past, so resolveLink can still check a hop
    // it later finds at an ancestor. `schema` only ever describes the leaf, so
    // a cap on an `asCell` ancestor otherwise vanishes the moment the path
    // continues past it (#5230). Costs nothing on the uncapped path.
    let scopeCaps = currentLink.scopeCaps;
    const recordCap = (depth: number, schema: JSONSchema | undefined) => {
      // getSchemaScopeCap is the long-standing path-resolution precedence;
      // the compound lookup adds anyOf/oneOf-wrapped asCell caps it cannot
      // see. Taking the narrower is additive: it can only tighten.
      const cap = narrowerScopeCap(
        ContextualFlowControl.getSchemaScopeCap(schema),
        ContextualFlowControl.getAsCellFollowScopeCap(schema),
      );
      if (cap === undefined) return;
      // A repeated key() over the same prefix re-derives the same depth, and
      // asSchema() can re-declare one with a DIFFERENT cap. Keep the narrower:
      // skipping on depth alone would let a looser recorded cap shadow a
      // tighter one the caller just asked for.
      const existing = scopeCaps?.find((entry) => entry.depth === depth);
      if (existing !== undefined) {
        if (narrowerScopeCap(cap, existing.scope) === existing.scope) return;
        scopeCaps = scopeCaps!.map((entry) =>
          entry.depth === depth ? { depth, scope: cap } : entry
        );
        return;
      }
      scopeCaps = [...(scopeCaps ?? []), { depth, scope: cap }];
    };
    // Seed with the cap declared at the address we start from: it governs a
    // link stored AT this address, which the first appended segment already
    // puts beyond the reach of the leaf schema.
    if (keys.length > 0) recordCap(currentLink.path.length, currentLink.schema);

    for (const key of keys) {
      // Get child schema if we have one
      childSchema = currentLink.schema
        ? ContextualFlowControl.getSchemaAtPath(currentLink.schema, [
          key.toString(),
        ])
        : undefined;

      // Create a child link with an extended path. schemaAtPath retains the
      // reachable $defs closure needed for later key() calls while dropping
      // definitions the child can no longer reach.
      //
      // key() only extends the path and walks the schema. It must NOT change the
      // link's scope: scope lives in the schema (top-level and asCell entries)
      // and is resolved later as a follow cap during reads and as the target
      // scope during writes. Stamping schema scope onto this link here would
      // re-address the value to the wrong scoped instance of the container doc
      // (see CT-1623).
      const path = [...currentLink.path, key.toString()] as string[];
      recordCap(path.length, childSchema);

      currentLink = {
        ...currentLink,
        path,
        schema: childSchema,
        ...(scopeCaps !== undefined && { scopeCaps }),
      };
    }

    // Determine the kind based on schema flags
    let kind: CellKind = this.#kind;
    if (isObjectOrArray(childSchema)) {
      const asCellValues = ContextualFlowControl.getAsCellValues(childSchema);
      // we can override the kind of cell we use for a key
      if (asCellValues.length > 0) {
        const asCellEntry = asCellValues[0];
        const asCellKind = ContextualFlowControl.getAsCellKind(asCellEntry);
        if (asCellKind !== undefined) {
          kind = asCellKind;
        }
      }
    }

    return new CellImpl(
      this.runtime,
      this.tx,
      currentLink,
      this.#synced,
      this.#causeContainer,
      kind,
      rebaseCfcLabelView(this.#cfcLabelView, childPath),
    ) as unknown as Cell<any>;
  }

  asSchema<S extends JSONSchema = JSONSchema>(
    schema: S,
  ): Cell<Schema<S>>;
  asSchema<T>(
    schema?: JSONSchema,
  ): Cell<T>;
  asSchema(schema?: JSONSchema): Cell<any> {
    // asSchema creates a sibling with same identity but different schema.
    // Create a new link with the modified schema, interned so downstream
    // identity-keyed schema caches hit (see `internCellLinkSchema`).
    const siblingLink: NormalizedLink = {
      ...this.#_link,
      schema: internCellLinkSchema(schema),
    };

    return new CellImpl(
      this.runtime,
      this.tx,
      siblingLink,
      false, // Reset synced flag, since schema is changing
      this.#causeContainer, // Share the causeContainer with siblings
      this.#kind,
      this.#cfcLabelView,
    ) as unknown as Cell<any>;
  }

  /**
   * Follow all links, even beyond write redirects, and adopt the schema
   * embedded in the resolved link chain, projected along the remaining path.
   *
   * The link stays the same, i.e. it does not advance to the resolved link.
   *
   * Note: That means that the schema might change if the link behind it change.
   * The reads are logged though, so should trigger reactive flows.
   *
   * @returns Cell with schema from links
   */
  asSchemaFromLinks<T = unknown>(): Cell<T> {
    if (!this.#synced) this.sync(); // Auto-sync like .get() - matches framework pattern

    const { schema } = resolveLink(
      this.runtime,
      this.runtime.readTx(this.tx),
      this.#link,
    );

    return new CellImpl(
      this.runtime,
      this.tx,
      {
        ...this.#_link,
        ...(schema !== undefined && { schema }),
      },
      false, // Reset synced flag, since schema is changing
      this.#causeContainer, // Share the causeContainer with siblings
      this.#kind,
      this.#cfcLabelView,
    ) as unknown as Cell<T>;
  }

  withTx(newTx?: IExtendedStorageTransaction): Cell<T> {
    // withTx creates a sibling with same identity but different transaction
    // Share the causeContainer so .for() calls propagate
    return new CellImpl(
      this.runtime,
      newTx,
      this.#_link, // Use the same link
      this.#synced,
      this.#causeContainer, // Share the causeContainer with siblings
      this.#kind,
      this.#cfcLabelView,
    ) as unknown as Cell<T>;
  }

  sink(
    callback: (
      value: Readonly<T>,
      cfcLabel?: CfcLabelView | undefined,
    ) => Cancel | undefined | void,
    options: SinkOptions = {},
  ): Cancel {
    // Check if this is a stream
    if (this.isStream()) {
      // Stream behavior: add listener
      this.#listeners.add(
        callback as (event: AnyCellWrapping<T>) => Cancel | undefined,
      );
      return () =>
        this.#listeners.delete(
          callback as (event: AnyCellWrapping<T>) => Cancel | undefined,
        );
    } else {
      // Regular cell behavior: subscribe to changes
      if (!this.#synced) {
        // sink() returns synchronously and immediately publishes the replica's
        // current value, but the first backing-doc load remains part of the
        // runtime's convergence work. A pull begun after this call sees the
        // cell as synced and will not start a second load of its own, so keep
        // this promise in the shared settled pool until the first load lands.
        this.runtime.storageManager.trackUntilSettled(
          this.sync().catch(() => {}),
        );
      }
      return subscribeToReferencedDocs(
        callback,
        this.runtime,
        this.#viewRef,
        options,
      );
    }
  }

  /**
   * Load this cell's backing doc, returning a promise that resolves once the
   * doc is confirmed: either its value has arrived or it is confirmed absent.
   * The return is always a promise (`syncCell` is async), so awaiting it is the
   * only way it reports pending. `sync() instanceof Promise` is constant-true,
   * and a present-but-undefined read cannot tell a still-loading cell from a
   * settled-empty one, so neither works as a synchronous pending check.
   *
   * A deferred `sync().then(...)` chain is not awaited by `Cell.pull()` until it
   * is registered in the storage manager's cross-space promise set; before that,
   * a pull can return while the chain is still in flight and read held,
   * not-yet-loaded state. Register it with `storageManager.trackUntilSettled` so
   * `Cell.pull()` and `storageManager.synced()` await it. The scheduler's
   * `idle()` waits for reactive quiescence only, not that set, so it does not
   * await such a chain even when registered — code gating on `idle()` alone can
   * still race the deferred sync.
   */
  sync(): Promise<Cell<T>> {
    if (usesLocalReads(this.tx)) {
      return Promise.resolve(this as unknown as Cell<T>);
    }
    this.#synced = true;
    logger.info("sync", this.#link);
    // The runner's explicit-instance read (server-execution v2 stage A —
    // OW17's tx→replica seam): a cell read inside a SERVED per-instance
    // run — its transaction carries the demand-supplied identity — loads
    // THAT principal's instance of a scoped doc, keyed apart in the
    // serving replica; a cell with no run identity (every client, the OFF
    // arm) loads exactly as before. The manager decides whether the
    // identity names anything (own identity and space scope name
    // nothing).
    const identity = this.tx?.tx?.scopeKeyIdentity;
    return this.runtime.storageManager.syncCell<T>(
      this as unknown as Cell<T>,
      identity !== undefined ? { scopeKeyIdentity: identity } : undefined,
    );
  }

  sinkMeta(
    metaField: MetaField,
    callback: (value: FabricValue) => Cancel | undefined | void,
    options: SinkOptions = {},
  ): Cancel {
    if (!this.#synced) {
      this.runtime.storageManager.trackUntilSettled(
        this.sync().catch(() => {}),
      );
    }

    const sink: SinkAction = {
      cleanup: undefined,
      action: (tx) => {
        if (isCancel(sink.cleanup)) sink.cleanup();

        const value = this.withTx(tx).getMetaRaw(metaField);
        sink.cleanup = callback(value);
      },
    };

    return sinkHelper(sink, this.runtime, {
      ...this.#link,
      path: [String(metaField)],
    }, options);
  }

  resolveAsCell(): Cell<T> {
    const readTx = this.runtime.readTx(this.tx);
    const tracesBefore = readTx.getCfcState().dereferenceTraces.length;
    let link: NormalizedFullLink = resolveLink(
      this.runtime,
      readTx,
      this.#link,
      "value",
      { markIfcCrossings: true },
    );
    const dereferenceView = cfcLabelViewForDereferenceTraces(
      readTx,
      readTx.getCfcState().dereferenceTraces.slice(tracesBefore),
    );
    link = maybeConvertArrayPathToDataURILink(readTx, link);
    return createCell(
      this.runtime,
      link,
      this.tx,
      this.#synced,
      undefined,
      mergeCfcLabelViews([this.#cfcLabelView, dereferenceView]),
    );
  }

  getAsQueryResult<Path extends PropertyKey[]>(
    path?: Readonly<Path>,
    tx?: IExtendedStorageTransaction,
  ): CellResult<DeepKeyLookup<T, Path>> {
    if (!this.#synced) this.sync(); // No await, just kicking this off
    const subPath = path || [];
    return createQueryResultProxy(
      this.runtime,
      tx ?? this.tx ?? this.runtime.edit(),
      {
        ...this.#link,
        path: [...this.path, ...subPath.map((p) => p.toString())] as string[],
      },
      0,
      rebaseCfcLabelView(
        this.#cfcLabelView,
        subPath.map((p) => p.toString()),
      ),
    );
  }

  getAsNormalizedFullLink(): NormalizedFullLink {
    return this.#link;
  }

  /**
   * The link a serialized reference to this cell is built from. A stream
   * handle's own link carries the event schema, and what says it is a stream
   * is the handle's kind, which a reference does not carry. The reference
   * outlives the handle, and the document it names holds nothing, so the
   * declaration goes onto the reference's schema.
   */
  #linkForReference(): NormalizedFullLink {
    return this.#kind === "stream"
      ? { ...this.#link, schema: declareStreamSchema(this.#link.schema) }
      : this.#link;
  }

  getAsLink(
    options?: {
      base?: Cell<any>;
      baseSpace?: MemorySpace;
      includeSchema?: boolean;
      keepAsCell?: KeepAsCell;
    },
  ): SigilLink {
    return createSigilLinkFromParsedLink(this.#linkForReference(), {
      ...options,
      overwrite: "this",
    });
  }

  getAsWriteRedirectLink(
    options?: {
      base?: Cell<any>;
      baseSpace?: MemorySpace;
      includeSchema?: boolean;
      keepAsCell?: KeepAsCell;
    },
  ): SigilWriteRedirectLink {
    return createSigilLinkFromParsedLink(this.#linkForReference(), {
      ...options,
      overwrite: "redirect",
    }) as SigilWriteRedirectLink;
  }

  /**
   * Read the cell's value at the fabric layer (no unwrapping to JS form,
   * no Proxy wrapping). By default returns a deep-frozen `FabricValue`
   * snapshot; pass `{ frozen: false }` for a mutable deep copy.
   *
   * **Frozenness contract:** Defaults to `{ frozen: true }`, returning a
   * deep-frozen `FabricValue` snapshot via `cloneIfNecessary()`. The underlying
   * storage already holds a deep-frozen tree, so the clone is typically a
   * no-op. The `{ frozen: false }` variant returns a fresh mutable deep copy
   * and never aliases storage state.
   */
  getRaw(options?: RawCellReadOptions): Immutable<T> | undefined {
    return this.getRawUntyped(options) as Immutable<T> | undefined;
  }

  /**
   * Untyped variant of `getRaw()`; same frozenness contract.
   */
  getRawUntyped(
    options?: RawCellReadOptions & { frozen?: true },
  ): FabricValue;
  getRawUntyped(
    options: RawCellReadOptions & { frozen: false },
  ): FabricValue;
  getRawUntyped(
    options?: RawCellReadOptions & { frozen?: boolean },
  ): FabricValue {
    const { frozen = true, lastNode = "top", ...readOptions } = options ?? {};
    if (!this.#synced) this.sync(); // No await, just kicking this off
    const tx = this.runtime.readTx(this.tx);
    // Resolve all links ON THE WAY to the target, but don't resolve the final
    // link.
    const value = tx.readValueOrThrow(
      // A raw read still resolves links on the way to the target, and those
      // crossings are content reads: the seam marks labeled hops.
      resolveLink(this.runtime, tx, this.#link, lastNode, {
        markIfcCrossings: true,
      }),
      readOptions,
    );
    // Deep-copy with desired frozenness, without unwrapping to JS form --
    // getRaw() and getRawUntyped() return fabric-layer values, not
    // convertible JS ("wild west") values.
    return cloneIfNecessary(value, { frozen });
  }

  setRaw(value: (NoInfer<T> & FabricValue) | undefined): void {
    this.setRawUntyped(value);
  }

  setRawUntyped(
    value: FabricValue,
    onlyIfDifferent = false,
    schemaRole?: "output",
  ): void {
    if (!this.tx) throw new Error("Transaction required for setRaw");

    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.#synced) this.sync();

    const inlined = findAndInlineDataUriLinks(value);

    // When asked to write only on change, read the current raw value and bail
    // out if it already equals what we'd write. `readValueOrThrow` mirrors the
    // `writeValueOrThrow` below (same transaction and address, no link
    // resolution). The read is purely an internal write-elision decision, so it
    // is marked `ignoreReadForScheduling` (it must not register a
    // self-dependency that would re-trigger the writer) and
    // `internalVerifierRead` (it must not taint the transaction's CFC labels
    // with this cell's own value).
    if (onlyIfDifferent) {
      const current = this.tx.readValueOrThrow(this.#link, {
        meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
      });
      if (valueEqual(current, inlined)) return;
    }

    // Raw writes bypass diff-based attempted-target capture. Same-value direct
    // writes through this internal path are therefore outside phase-1 CFC
    // attempted-target coverage unless a caller establishes it separately.
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      this.#link,
      this.#link.schema ?? this.schema,
      schemaRole,
    );
    this.tx.writeValueOrThrow(this.#link, inlined);

    // Every whole-value write poisons the mergeable ops it covers — one rule,
    // rather than a list of write paths that happen to remember. Today's callers
    // are internal machinery writing links into result cells, where no op is
    // ever recorded, so this is inert; it is here so the rule stays true if that
    // changes.
    this.tx.poisonMergeableOp?.(this.#link);
  }

  applyCfcSchemaToExistingValue(): void {
    if (!this.tx) {
      throw new Error(
        "Transaction required for applyCfcSchemaToExistingValue",
      );
    }
    if (!this.#synced) this.sync();

    const writeLink = resolveLink(
      this.runtime,
      this.tx,
      this.#link,
      "writeRedirect",
    );
    const value = this.tx.readValueOrThrow(writeLink, {
      meta: { ...markReadAsAttemptedWrite, ...allowMutableTransactionRead },
    });
    if (value === undefined) {
      throw new Error("Cannot apply a CFC schema to an absent value");
    }
    recordRelevantSchemaWritePolicyInput(
      this.tx,
      writeLink,
      this.schema,
    );
  }

  getArgumentCell<U>(schema?: JSONSchema): Cell<U> | undefined {
    const metaReadOptions = {
      meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
    };
    const linkObj = this.getMetaRaw("argument", metaReadOptions);
    if (linkObj === undefined) return undefined;
    const link = parseLink(linkObj, this.#_link);
    if (link === undefined) return undefined;
    return this.runtime.getCellFromLink(link).asSchema<U>(schema);
  }

  getMetaRaw(
    metaField: MetaField,
    options?: IReadOptions,
  ): FabricValue | undefined {
    if (!this.#synced) this.sync(); // No await, just kicking this off
    const metaAddr = {
      space: this.#link.space,
      id: this.#link.id,
      path: [metaField],
      ...(this.#link.scope !== undefined && { scope: this.#link.scope }),
    };
    return this.runtime.readTx(this.tx).readOrThrow(metaAddr, options);
  }

  /**
   * Writes a meta field on this cell's document.
   *
   * A meta field names the program a piece runs, the cells it is wired to,
   * the shape its result is validated against, and its name in the space, so
   * a write here redirects a piece rather than editing its data. The seam is
   * the runtime's: `authorization` travels with the write as its options, and
   * the storage-write chokepoint refuses a meta write that arrives without
   * one. {@link rawMetaWriteAuthorization} is the value, and the sandbox
   * hands pattern code the builder namespace rather than the runner's
   * modules, so pattern code cannot name it.
   */
  setMetaRaw(
    metaField: MetaField,
    value: FabricValue,
    authorization: RawMetaWriteAuthorization,
  ): void {
    if (!this.tx) throw new Error("Transaction required for setMetaRaw");
    // No await for the sync, just kicking this off, so we have the data to
    // retry on conflict.
    if (!this.#synced) this.sync();
    const metaAddr = {
      space: this.#link.space,
      id: this.#link.id,
      path: [metaField],
      ...(this.#link.scope !== undefined && { scope: this.#link.scope }),
    };
    this.tx.writeOrThrow(metaAddr, value, authorization);
  }

  /**
   * Set the schema for this cell. Only works if the cause isn't set yet.
   * Prefer using .asSchema() instead.
   */
  setSchema(newSchema: JSONSchema): void {
    if (this.#causeContainer.cause || this.#causeContainer.id) {
      throw new Error(
        "Cannot setSchema: cell already has a cause or link. Use .asSchema() instead.",
      );
    }
    // Since we don't have a cause yet, we can modify the link's schema
    this.#_link = { ...this.#_link, schema: newSchema };
  }

  /**
   * Connect this cell to a node reference.
   * This stores the node in a set of connected nodes, which is used during pattern construction.
   * @param node - The node to connect to
   */
  connect(node: NodeRef): void {
    // For cells created during pattern construction, we need to track which nodes
    // they're connected to. Since Cell doesn't have a nodes set like Reactive's store,
    // we'll store this in a WeakMap keyed by the cell instance.
    const top = this.#causeContainer.cell;
    if (!cellNodes.has(top)) {
      cellNodes.set(top, new Set());
    }
    cellNodes.get(top)!.add(node);
  }

  /**
   * Export cell metadata for introspection, similar to Reactive's export method.
   * If the cell has a link, it's included as 'external'. `kind` is the cell's
   * kind, which is what tells a stream from a value cell.
   */
  export(): {
    cell: OpaqueCell<unknown>;
    path: readonly PropertyKey[];
    schema?: JSONSchema;
    scope?: CellScope;
    nodes: Set<NodeRef>;
    frame: Frame;
    kind?: CellKind;
    name?: unknown;
    external?: unknown;
  } {
    // Exporting a cell is a step in building a pattern, and the builder checks
    // the exported frame against the one it is building under.
    if (!this.#frame) {
      throw new Error(
        "Cannot export a cell with no frame\n" +
          "help: this cell was built after the runtime it came from was " +
          "disposed, so it cannot take part in building a pattern",
      );
    }
    return {
      cell: this.#causeContainer.cell,
      path: this.path,
      schema: this.schema,
      scope: isCellScope(this.#_link.scope) ? this.#_link.scope : undefined,
      nodes: cellNodes.get(this.#causeContainer.cell) ?? new Set(),
      frame: this.#frame,
      kind: this.#kind,
      name: this.#causeContainer.cause,
      external: this.#_link.id
        ? this.getAsWriteRedirectLink({
          baseSpace: this.#frame.space,
          includeSchema: true,
        })
        : undefined,
    };
  }

  /**
   * Set the self-reference for pattern SELF symbol support.
   * This allows patterns to access their own output via the SELF symbol.
   */
  setSelfRef(selfRef: Reactive<any>): void {
    this.#selfRef = selfRef;
  }

  /**
   * Wrap this cell in a proxy that provides Reactive behavior.
   * The proxy adds Symbol.iterator, Symbol.toPrimitive, and toCell support,
   * and recursively wraps child cells accessed via property access.
   *
   * @returns A proxied version of this cell with Reactive behavior
   */
  getAsReactiveProxy(
    boundTarget?: (...args: unknown[]) => unknown,
  ): Reactive<T> {
    const self = this as unknown as Cell<T>;
    // `query`/`exec` are SqliteDb-only methods whose names are also common data
    // fields (e.g. wish's `query`). Only forward them as methods on a
    // `"sqlite"`-kind cell; otherwise treat `.query`/`.exec` as data navigation.
    const cellKind = this.#kind;
    const proxy = new Proxy(boundTarget ?? this, {
      get(target, prop) {
        if (prop === Symbol.iterator) {
          // Iterator support for array destructuring
          return function* () {
            let index = 0;
            while (index < 50) { // Limit to 50 items like original
              const itemCell = self.key(index) as Cell<unknown>;
              yield itemCell.getAsReactiveProxy();
              index++;
            }
          };
        } else if (prop === Symbol.toPrimitive) {
          return () => {
            throw new Error(
              "Tried to access a reactive reference outside a reactive context. Use `computed()` to perform operations on reactive values - it handles closures automatically.",
            );
          };
        } else if (prop === toCell) {
          // Return a function that returns the unproxied cell
          return () => self;
        } else if (prop === isReactiveMarker) {
          return true;
        } else if (prop === SELF) {
          // Return the self-reference if set (for pattern SELF symbol support)
          return (self as unknown as CellImpl<T>).#selfRef;
        } else if (typeof prop === "string" || typeof prop === "number") {
          // Recursive property access - wrap the child cell
          const nestedCell = self.key(prop) as Cell<T>;

          // Check if this is a method on the cell. `query`/`exec` are gated to
          // SqliteDb cells so they don't shadow same-named data fields.
          const isSqliteOnlyMethod = prop === "query" || prop === "exec";
          const isIndexOnlyMethod = prop === "lookup" || prop === "keys" ||
            prop === "keyEntries";
          // Array-only method names remain ordinary data fields on non-array refs,
          // including schemaless builder objects. Callable projections cannot
          // be persisted as data because their method/value meaning is ambiguous.
          const arrayMethodSchema = typeof prop === "string" &&
              arrayOnlyMethods.has(prop)
            ? resolveSchema(self.schema)
            : undefined;
          const isArrayMethodReceiver = arrayMethodSchema &&
            typeof arrayMethodSchema === "object" &&
            arrayMethodSchema.type === "array";
          if (
            cellMethods.has(prop as keyof ICell<T>) &&
            (!isSqliteOnlyMethod || cellKind === "sqlite") &&
            (!isIndexOnlyMethod || isCollectionIndexReceiver(self)) &&
            (!arrayOnlyMethods.has(String(prop)) || isArrayMethodReceiver)
          ) {
            return nestedCell.getAsReactiveProxy(
              (self as unknown as Record<
                string,
                (...args: unknown[]) => unknown
              >)[prop]!
                .bind(self),
            );
          } else {
            return nestedCell.getAsReactiveProxy();
          }
        }
        // Delegate everything else to orignal target
        return (target as any)[prop];
      },
    });
    return proxy as unknown as Reactive<T>;
  }

  /**
   * SqliteDb reactive read (`db.query<Row>`): builds a `sqliteQuery` node with
   * this DB handle as the `db` input (sugar over the `sqliteQuery` factory,
   * mirroring how `.map` threads `this` as `list`). The `<Row>` result schema is
   * injected by the transformer (method-call lowering), not set here. Like
   * `.map`, this is a build-time node constructor with no `#kind` guard: at
   * pattern-build time `this` is an opaque builder ref (the `"sqlite"` kind only
   * materializes at runtime via the asCell schema), and the public `SqliteDb`
   * type already restricts who can call it. A wrong handle fails at runtime in
   * `readDbRef`.
   */
  query<Row = Record<string, unknown>>(
    sql: string,
    options?: {
      params?: ReadonlyArray<unknown> | Record<string, unknown>;
      reactOn?: unknown;
      maxConfidentiality?: ReadonlyArray<unknown>;
      onExceed?: "fail" | "skip";
      readClearance?: boolean;
      scope?: CellScope;
    },
  ): Reactive<
    { pending: boolean; result?: Row[]; error?: unknown; withheld?: number }
  > {
    // The scope binds the node the way `.asScope` binds the builder export:
    // the runner folds the node's default scope into the result cell's link.
    // Validated at the boundary: an invalid scope must not reach the link.
    if (options?.scope !== undefined && !isCellScope(options.scope)) {
      throw new TypeError(
        `sqlite: invalid query result scope ${JSON.stringify(options.scope)}`,
      );
    }
    const factory = options?.scope === undefined
      ? sqliteQueryNodeFactory
      : sqliteQueryNodeFactory.asScope(options.scope);
    return factory({
      db: this,
      sql,
      params: options?.params,
      reactOn: options?.reactOn,
      // CFC Phase 3 read surface: the declared output ceiling + exceed mode.
      maxConfidentiality: options?.maxConfidentiality,
      onExceed: options?.onExceed,
      // CFC Phase 3.b: read-time clearance (reader-filtered rows).
      readClearance: options?.readClearance,
      // Forward the transformer-injected `<Row>` schema (lowered into the
      // options object) to the node so the builtin can decode `_cf_link`
      // columns. Read loosely — it is not part of the public options type.
      rowSchema: (options as { rowSchema?: unknown } | undefined)?.rowSchema,
    }) as Reactive<
      { pending: boolean; result?: Row[]; error?: unknown; withheld?: number }
    >;
  }

  /**
   * Map over an array cell, creating a new derived array.
   * Similar to Array.prototype.map but works with Reactives.
   */
  map<S>(
    _fn: (
      element: T extends Array<infer U> ? Reactive<U> : Reactive<T>,
      index: Reactive<number>,
      array: Reactive<T>,
    ) => FactoryInput<S>,
  ): Reactive<S[]> {
    throw new Error(throwOpFunctionFormMessage("map"));
  }

  /**
   * Map over an array cell using a pattern/pattern.
   * Similar to map but accepts a pre-defined pattern instead of a function.
   */
  mapWithPattern<S>(
    this: IsThisObject,
    op: PatternFactory<T extends Array<infer U> ? U : T, S>,
    params: Record<string, any>,
  ): Reactive<S[]> {
    // Create the factory if it doesn't exist
    if (!mapFactory) {
      mapFactory = createNodeFactory({
        type: "ref",
        implementation: "map",
      });
    }

    const result = mapFactory({
      list: this as unknown as Reactive<T>,
      op: op,
      params: params,
    });
    result.setSchema(
      schemaCarryingLinkIfc(result, listResultSchema(op.resultSchema)),
    );
    return result;
  }

  /** @inheritDoc */
  groupBy<K extends CollectionIndexKey>(
    this: AnyBrandedCell<unknown[]>,
    _selector: (
      element: T extends Array<infer U> ? Reactive<U> : Reactive<T>,
    ) => K | null | undefined,
  ): GroupIndex<K, T extends Array<infer U> ? U : T> {
    throw new Error(throwOpFunctionFormMessage("groupBy"));
  }

  /** @inheritDoc */
  groupByWithPattern<K extends CollectionIndexKey>(
    this: AnyBrandedCell<unknown[]>,
    op: PatternFactory<
      T extends Array<infer U> ? U : T,
      { isCell: boolean; value: K | null | undefined }
    >,
    params: Record<string, unknown>,
  ): GroupIndex<K, T extends Array<infer U> ? U : T> {
    const keys = CellImpl.prototype.mapWithPattern.call(this, op, params);
    return createNodeFactory({
      type: "ref",
      implementation: "collectionIndex",
    })({
      list: keys,
      elements: this,
      mode: "group",
    }) as GroupIndex<K, T extends Array<infer U> ? U : T>;
  }

  /** @inheritDoc */
  keyBy<K extends CollectionIndexKey>(
    this: AnyBrandedCell<unknown[]>,
    _selector: (
      element: T extends Array<infer U> ? Reactive<U> : Reactive<T>,
    ) => K | null | undefined,
  ): KeyIndex<K, T extends Array<infer U> ? U : T> {
    throw new Error(throwOpFunctionFormMessage("keyBy"));
  }

  /** @inheritDoc */
  keyByWithPattern<K extends CollectionIndexKey>(
    this: AnyBrandedCell<unknown[]>,
    op: PatternFactory<
      T extends Array<infer U> ? U : T,
      { isCell: boolean; value: K | null | undefined }
    >,
    params: Record<string, unknown>,
  ): KeyIndex<K, T extends Array<infer U> ? U : T> {
    const keys = CellImpl.prototype.mapWithPattern.call(this, op, params);
    return createNodeFactory({
      type: "ref",
      implementation: "collectionIndex",
    })({
      list: keys,
      elements: this,
      mode: "key",
    }) as KeyIndex<K, T extends Array<infer U> ? U : T>;
  }

  /** Reads one index bucket while retaining dependencies on key resolution. */
  lookup(
    key: CollectionIndexKey | null | undefined,
  ): T extends CollectionIndexData<CollectionIndexKey, infer V> ? V : unknown {
    const index = this as unknown as Cell<
      CollectionIndexData<CollectionIndexKey, unknown>
    >;
    if (!isCollectionIndexReceiver(index)) {
      throw new Error("lookup requires a collection index");
    }
    const resolved = resolveCollectionKey(
      this.runtime,
      this.runtime.readTx(this.tx),
      key,
    );
    const value = resolved
      ? index.key("buckets").key(collectionKeyBucket(resolved.identity)).get()
      : undefined;
    if (value !== undefined) {
      return value as T extends CollectionIndexData<CollectionIndexKey, infer V>
        ? V
        : unknown;
    }
    const mode = index.key("mode").get() ??
      declaredCollectionIndexMode(this.schema);
    if (mode === undefined) {
      throw new Error(
        "lookup needs the index mode to answer a missing key: this index has " +
          "published no descriptor, and its type names neither mode",
      );
    }
    return (mode === "group" ? [] : undefined) as T extends
      CollectionIndexData<CollectionIndexKey, infer V> ? V : unknown;
  }

  /** Reads occupied-key enumeration separately from bucket lookup. */
  keys(): T extends CollectionIndexData<infer K, unknown> ? K[] : unknown[] {
    const index = this as unknown as Cell<
      CollectionIndexData<CollectionIndexKey, unknown>
    >;
    if (!isCollectionIndexReceiver(index)) {
      throw new Error("keys requires a collection index");
    }
    return (index.key("keys").get() ?? []) as T extends
      CollectionIndexData<infer K, unknown> ? K[] : unknown[];
  }

  /** Reads tagged key enumeration separately from bucket lookup. */
  keyEntries(): T extends CollectionIndexData<infer K, unknown>
    ? CollectionIndexKeyEntry<K>[]
    : unknown[] {
    const index = this as unknown as Cell<
      CollectionIndexData<CollectionIndexKey, unknown>
    >;
    if (!isCollectionIndexReceiver(index)) {
      throw new Error("keyEntries requires a collection index");
    }
    return (index.key("keyEntries").get() ?? []) as T extends
      CollectionIndexData<infer K, unknown> ? CollectionIndexKeyEntry<K>[]
      : unknown[];
  }

  /** @inheritDoc */
  count(
    this: AnyBrandedCell<unknown[]>,
    predicate?: (
      element: T extends Array<infer U> ? Reactive<U> : Reactive<T>,
      index: Reactive<number>,
      array: Reactive<T>,
    ) => FactoryInput<boolean>,
  ): Reactive<number> {
    if (predicate !== undefined) {
      throw new Error(throwOpFunctionFormMessage("count"));
    }
    return createAggregate(this, "count");
  }

  /** @inheritDoc */
  sum(this: AnyBrandedCell<number[]>): Reactive<number> {
    return createAggregate(this, "sum");
  }

  /** @inheritDoc */
  min(this: AnyBrandedCell<number[]>): Reactive<number> {
    return createAggregate(this, "min");
  }

  /** @inheritDoc */
  max(this: AnyBrandedCell<number[]>): Reactive<number> {
    return createAggregate(this, "max");
  }

  /** @inheritDoc */
  countWithPattern(
    this: AnyBrandedCell<unknown[]>,
    op: PatternFactory<T extends Array<infer U> ? U : T, boolean>,
    params: Record<string, any>,
  ): Reactive<number> {
    const scores = CellImpl.prototype.mapWithPattern.call(this, op, params);
    return createAggregate(scores, "countTruthy", this);
  }

  /** @inheritDoc */
  minBy(
    this: AnyBrandedCell<unknown[]>,
    _score: (
      element: T extends Array<infer U> ? Reactive<U> : Reactive<T>,
      index: Reactive<number>,
      array: Reactive<T>,
    ) => FactoryInput<number>,
  ): Reactive<(T extends Array<infer U> ? U : T) | undefined> {
    throw new Error(throwOpFunctionFormMessage("minBy"));
  }

  /** @inheritDoc */
  minByWithPattern(
    this: AnyBrandedCell<unknown[]>,
    op: PatternFactory<T extends Array<infer U> ? U : T, number>,
    params: Record<string, any>,
  ): Reactive<(T extends Array<infer U> ? U : T) | undefined> {
    const scores = CellImpl.prototype.mapWithPattern.call(this, op, params);
    return createAggregate(scores, "minBy", this);
  }

  /** @inheritDoc */
  maxBy(
    this: AnyBrandedCell<unknown[]>,
    _score: (
      element: T extends Array<infer U> ? Reactive<U> : Reactive<T>,
      index: Reactive<number>,
      array: Reactive<T>,
    ) => FactoryInput<number>,
  ): Reactive<(T extends Array<infer U> ? U : T) | undefined> {
    throw new Error(throwOpFunctionFormMessage("maxBy"));
  }

  /** @inheritDoc */
  maxByWithPattern(
    this: AnyBrandedCell<unknown[]>,
    op: PatternFactory<T extends Array<infer U> ? U : T, number>,
    params: Record<string, any>,
  ): Reactive<(T extends Array<infer U> ? U : T) | undefined> {
    const scores = CellImpl.prototype.mapWithPattern.call(this, op, params);
    return createAggregate(scores, "maxBy", this);
  }

  /**
   * Reduce an array cell to a single accumulated value.
   * Similar to Array.prototype.reduce but reactive — re-runs the full
   * reduction when any element changes.
   */
  reduce<S>(
    this: IsThisObject,
    fn: (
      accumulator: S,
      element: T extends Array<infer U> ? U : T,
      index: number,
      array: (T extends Array<infer U> ? U : T)[],
    ) => S,
    initialValue: S,
  ): Reactive<S> {
    return lift((list: any[]) => {
      if (!Array.isArray(list)) return initialValue;
      return list.reduce(fn, initialValue);
    })(this as unknown as Reactive<any>);
  }

  /**
   * Find the index of the first matching element in an array cell.
   * Similar to Array.prototype.findIndex but reactive — re-runs when any
   * element changes. Returns -1 if no match is found. Throws TypeError
   * if the value is not an array, which surfaces as a scheduler error
   * and leaves the result undefined.
   */
  findIndex(
    this: IsThisObject,
    fn: (
      element: T extends Array<infer U> ? U : T,
      index: number,
      array: (T extends Array<infer U> ? U : T)[],
    ) => boolean,
  ): Reactive<number> {
    // Uses lift rather than a per-element-pattern builtin (like filter/map)
    // because findIndex returns a plain number, not an element reference —
    // there's no benefit to per-element reactive tracking. The lift approach
    // short-circuits naturally and the predicate receives unwrapped values,
    // so normal JS comparisons work. Tradeoff: reruns the full search on any
    // array change. For per-element reactivity, use filter(pred)[0] instead.
    return lift((list: any[]) => {
      if (!Array.isArray(list)) {
        throw new TypeError("findIndex called on non-array value");
      }
      return list.findIndex(fn);
    })(this as unknown as Reactive<any>);
  }

  /**
   * Filter an array cell, creating a new array with only matching elements.
   * Similar to Array.prototype.filter but works with Reactives.
   * Output contains cell references to the original elements.
   */
  filter(
    _fn: (
      element: T extends Array<infer U> ? Reactive<U> : Reactive<T>,
      index: Reactive<number>,
      array: Reactive<T>,
    ) => FactoryInput<boolean>,
  ): Reactive<(T extends Array<infer U> ? U : T)[]> {
    throw new Error(throwOpFunctionFormMessage("filter"));
  }

  /**
   * Filter an array cell using a pre-defined pattern.
   * Similar to filter but accepts a pre-defined pattern instead of a function.
   */
  filterWithPattern<S>(
    this: IsThisObject,
    op: PatternFactory<T extends Array<infer U> ? U : T, S>,
    params: Record<string, any>,
  ): Reactive<(T extends Array<infer U> ? U : T)[]> {
    if (!filterFactory) {
      filterFactory = createNodeFactory({
        type: "ref",
        implementation: "filter",
      });
    }

    const result = filterFactory({
      list: this as unknown as Reactive<T>,
      op: op,
      params: params,
    });
    result.setSchema(schemaCarryingLinkIfc(result, listResultSchema()));
    return result;
  }

  /**
   * FlatMap over an array cell, creating a flattened array from per-element arrays.
   * Similar to Array.prototype.flatMap but works with Reactives.
   * Each callback should return an array; results are concatenated one level deep.
   */
  flatMap<S>(
    _fn: (
      element: T extends Array<infer U> ? Reactive<U> : Reactive<T>,
      index: Reactive<number>,
      array: Reactive<T>,
    ) => FactoryInput<S[]>,
  ): Reactive<S[]> {
    throw new Error(throwOpFunctionFormMessage("flatMap"));
  }

  /**
   * FlatMap over an array cell using a pre-defined pattern.
   * Similar to flatMap but accepts a pre-defined pattern instead of a function.
   */
  flatMapWithPattern<S>(
    this: IsThisObject,
    op: PatternFactory<T extends Array<infer U> ? U : T, S[]>,
    params: Record<string, any>,
  ): Reactive<S[]> {
    if (!flatMapFactory) {
      flatMapFactory = createNodeFactory({
        type: "ref",
        implementation: "flatMap",
      });
    }

    const result = flatMapFactory({
      list: this as unknown as Reactive<T>,
      op: op,
      params: params,
    });
    result.setSchema(schemaCarryingLinkIfc(result, listResultSchema()));
    return result;
  }

  toSigilLinkOrNull(): SigilLink | null {
    // Return null when no link exists (cell hasn't been created yet)
    if (!this.#hasFullLink()) {
      return null;
    }

    // Use sigil link format which includes space for cross-space references
    return createSigilLinkFromParsedLink(this.#link);
  }

  toEncodableForm(): SigilLink | null {
    // The link that stands for a cell, under the name a walk over an arbitrary
    // graph reads by -- one that has recognized nothing about the value it
    // holds. A caller that already knows it has a cell asks the accessor above.
    return this.toSigilLinkOrNull();
  }

  toJSON(): SigilLink | null {
    // TODO(danfuzz): Remove this method once `value-debug` can correctly
    // render cells without it.
    //
    // The JSON protocol's name for the same link, honored by every renderer
    // that walks a value through it -- notably `toCompactDebugString()`, which
    // pattern-test assertion diagnostics render their operands with. Absent
    // this, rendering a value holding a cell walks the cell's own members and
    // reaches the whole runtime, so the rendering carries per-process detail
    // (the runtime's id among it) and reports differently each run.
    //
    // It carries no weight on the way to storage: a value bound for storage is
    // recognized as a cell first, and its link read off it directly.
    return this.toSigilLinkOrNull();
  }

  get __debugValue(): T {
    return this.get();
  }

  get cellLink(): SigilLink {
    return createSigilLinkFromParsedLink(this.#link);
  }

  get entityId(): EntityRef {
    return entityRefFromString(fromURI(this.#link.id));
  }

  get sourceURI(): URI {
    return this.#link.id;
  }

  get copyTrap(): boolean {
    throw new Error(
      "Copy trap: Something is trying to traverse a cell.",
    );
  }
}

export function setCellUnlinkedSpace(
  cell: unknown,
  space: MemorySpace,
): void {
  asCellImpl(cell)?.setUnlinkedSpace(space);
}

function asCellImpl(cell: unknown): CellImpl<FabricValue> | undefined {
  if (cell === null || cell === undefined) return undefined;
  const maybeToCell = (cell as { [toCell]?: () => Cell<unknown> })[toCell];
  const unproxied = typeof maybeToCell === "function"
    ? maybeToCell.call(cell)
    : cell;
  if (!isCell(unproxied)) return undefined;
  return unproxied as unknown as CellImpl<FabricValue>;
}

function subscribeToReferencedDocs<T>(
  callback: (
    value: T,
    cfcLabel?: CfcLabelView | undefined,
  ) => Cancel | undefined | void,
  runtime: Runtime,
  ref: CellViewRef,
  options: SinkOptions = {},
): Cancel {
  const link = ref.link;
  const readOnly = options.readOnly === true;
  const sink: SinkAction = {
    cleanup: undefined,
    action: (tx) => {
      if (isCancel(sink.cleanup)) sink.cleanup();

      // Using a new transaction for child cells, as we're only interested in
      // dependencies for the initial get, not further cells the callback might
      // read. The callback is responsible for calling sink on those cells if it
      // wants to stay updated.
      const extraTx = readOnly ? runtime.readTx() : runtime.edit();
      const wrappedTx = createChildCellTransaction(tx, extraTx);
      const schema = link.schema;
      const needsTraversal = schema === undefined ||
        ContextualFlowControl.isTrueSchema(schema);
      // sink() always kicks off sync before subscribing. Preserve that state
      // on asCell projections created for the callback, just as get() does, so
      // nested sinks reuse the root query instead of opening one per cut point.
      const newValue = validateAndTransform(runtime, wrappedTx, ref, [], {
        synced: true,
      });
      if (needsTraversal && newValue !== undefined && newValue !== null) {
        deepTraverse(newValue);
      }
      // Read the label on the SINK's transaction (`tx`), not the child `extraTx`,
      // so the cfc-metadata read joins this sink's reactive dependency set: a
      // later label-only write re-fires the sink. `cfcLabelViewForResolvedCell`
      // is a pure store read that also follows a link the path crosses part
      // way through, since the label vouching for a bound value is stored on
      // the document that holds it. It kicks no cross-space sync: the value
      // read above resolved the same link and kicked those targets already,
      // and the sink re-fires when they arrive. `internalVerifierRead` keeps
      // it reactive but out of CFC taint. Raw here — the worker redacts before
      // it leaves.
      const cfcLabel = options.includeCfcLabel
        ? cfcLabelViewForResolvedCell(createCell(runtime, link, tx), {
          kickCrossSpaceTargets: false,
        })
        : undefined;
      sink.cleanup = callback(newValue, cfcLabel);

      // no async await here, but that also means no retry. TODO(seefeld): Should
      // we add a retry? So far all sinks are read-only, so they get re-triggered
      // on changes already.
      runtime.prepareTxForCommit(extraTx);
      extraTx.commit();
    },
  };
  return sinkHelper(
    sink,
    runtime,
    toMemorySpaceAddress(link),
    options,
  );
}

type SinkAction = {
  action: Action;
  cleanup: Cancel | undefined | void;
};

function sinkHelper(
  sink: SinkAction,
  runtime: Runtime,
  address: IMemorySpaceAddress,
  options: SinkOptions = {},
) {
  if (options.readOnly === true) {
    const action = sink.action;
    sink.action = (tx) => {
      if (tx.setReadOnly === undefined) {
        throw new Error(
          "Read-only subscriptions require transaction read-only support.",
        );
      }
      tx.setReadOnly("Cell.sink()");
      return action(tx);
    };
  }

  // Attach a name to the sink action
  const sinkName = `sink:${address.space}/${address.id}/${
    address.path.join("/")
  }`;
  Object.defineProperty(sink.action, "name", {
    value: sinkName,
    configurable: true,
  });
  (sink.action as Action & { src?: string }).src = sinkName;

  // Call action once immediately, which also defines what docs need to be
  // subscribed to. Wrap with withExecutingAction so that any child sinks
  // created during the callback see this action as their parent.
  const tx = runtime.edit();
  runtime.scheduler.withExecutingAction(sink.action, () => sink.action(tx));
  const log = txToReactivityLog(tx);

  // Technically unnecessary since we don't expect/allow callbacks to sink to
  // write to other cells, and we retry by design anyway below when read data
  // changed. But ideally we enforce read-only as well.
  runtime.prepareTxForCommit(tx);
  tx.commit();

  // Mark as effect since sink() is a side-effectful consumer (FRP effect/sink)
  // Use resubscribe because we've already run it once above
  const resubscribeOptions = {
    isEffect: true,
    ...(options.changeGroup !== undefined && {
      changeGroup: options.changeGroup,
    }),
  };
  runtime.scheduler.resubscribe(sink.action, log, resubscribeOptions);

  return () => {
    runtime.scheduler.unsubscribe(sink.action);
    if (isCancel(sink.cleanup)) sink.cleanup();
    sink.cleanup = undefined;
  };
}

/**
 * Deeply traverse a value to access all properties.
 * Sinks, pulls, and rendered-property queries share this traversal to register
 * the dependencies behind schema-free values.
 * Works with query result proxies which trigger reads on property access.
 *
 * TODO(danfuzz): A `FabricInstance` passes the `typeof` gate but has no
 * enumerable own properties, so the `for..in` walk ends at it without
 * touching its codec contents: a link nested inside one (a `FabricError`
 * `cause`, say — live traffic via the fetch builtins) is never read, so
 * `pull()` neither registers it as a dependency nor syncs it, and a sink
 * never re-fires on its change. A `FabricPrimitive` ends the walk too, which
 * is correct — it is a leaf.
 */
export function deepTraverse(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "object") return;

  // Avoid infinite loops with circular references
  if (seen.has(value)) return;
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        deepTraverse(item, seen);
      }
    } else {
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          try {
            deepTraverse((value as Record<string, unknown>)[key], seen);
          } catch {
            // Ignore errors from accessing individual properties (e.g., link cycles)
          }
        }
      }
    }
  } catch {
    // Ignore errors from traversal (e.g., link cycles)
    // We've already registered the dependencies we can access
  }
}

function maybeConvertArrayPathToDataURILink(
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
): NormalizedFullLink {
  if (link.path.length === 0) {
    return link;
  }

  let rootValue: FabricValue;
  try {
    rootValue = tx.readValueOrThrow({ ...link, path: [] }, {
      meta: ignoreReadForScheduling,
    });
  } catch {
    return link;
  }

  let current: FabricValue = rootValue;
  const prefix: string[] = [];
  let candidate:
    | {
      value: FabricValue;
      path: string[];
      remainingPath: string[];
    }
    | undefined;

  for (let i = 0; i < link.path.length; i++) {
    if (!isObjectOrArray(current)) {
      break;
    }

    const segment = link.path[i];
    let next: FabricValue;

    if (Array.isArray(current)) {
      if (!isArrayIndexPropertyName(segment)) {
        break;
      }
      next = (current as unknown as Record<string, FabricValue>)[segment];
      if (isObjectOrArray(next) && !isCellLink(next)) {
        candidate = {
          value: next,
          path: [...prefix, segment],
          remainingPath: link.path.slice(i + 1),
        };
      }
    } else {
      next = (current as Record<string, FabricValue>)[segment];
    }

    prefix.push(segment);
    current = next;
  }

  if (candidate === undefined) {
    return link;
  }

  const baseLink: NormalizedFullLink = {
    ...link,
    path: candidate.path,
  };

  // The snapshot identity depends on this inline element's content. A reader
  // must resolve it again when the mutable source changes.
  tx.readValueOrThrow(baseLink);

  return {
    ...link,
    id: dataUriFromValueWithResolvedLinks(candidate.value, baseLink),
    path: candidate.remainingPath,
  };
}

/**
 * Throws when `value` was read back through a cell's `get()`: a query-result
 * view of an element rather than the element's cell.
 *
 * `addUnique()` and `removeByValue()` match their argument against the array's
 * stored elements, by link for a cell and by content for anything else. An
 * object element is stored as a link to a document of its own, which a value
 * read back through `get()` is not, so matching one by content can never find
 * it: a removal would remove nothing and an add would add a duplicate.
 *
 * A cell's Reactive proxy (`getAsReactiveProxy()`) carries the same `toCell`
 * back-pointer a view does, but it is the cell itself and matches by link, so
 * only a value that is not a cell is refused.
 *
 * @throws For a query-result view, naming the cell forms to pass instead.
 */
function refuseElementReadBack(method: string, value: unknown): void {
  if (!isCell(value) && isCellResultForDereferencing(value)) {
    throw new Error(
      `\`Cell.${method}()\` takes an element's cell or a plain value, not a ` +
        "value read back through `get()`\n" +
        "help: pass the element's cell, `list.key(index)` or " +
        "`list.elementById(key)`",
    );
  }
}

/**
 * Whether `value` contains a reference cycle through plain containers.
 * Cells, links, and other non-plain objects are treated as leaves -- a cycle
 * through those resolves at read time and is not a structural cycle of the
 * value itself.
 */
function containsCycle(value: unknown): boolean {
  // The containers the walk is inside, which is what a cycle leads back to.
  const ancestors = new IndexTrackingStack<object>();

  // Nodes already walked to completion without finding a cycle. Without this
  // memo the walk is exponential on shared acyclic references (a diamond per
  // level doubles the work), and candidate values are user-controlled.
  const completed = new Set<object>();

  const walk = (node: unknown): boolean => {
    if (
      !isObjectOrArray(node) || isCell(node) ||
      isCellLink(node) || isFabricSpecialObject(node)
    ) {
      return false;
    }

    if (completed.has(node)) return false;
    if (ancestors.has(node)) return true;

    ancestors.push(node);

    // Every way out of the descent, the early return on a cycle included,
    // takes the node back off the stack.
    try {
      const values = Array.isArray(node) ? node : Object.values(node);

      for (const child of values) {
        if (walk(child)) return true;
      }
    } finally {
      ancestors.popExpect(node);
    }

    completed.add(node);

    return false;
  };

  return walk(value);
}

/**
 * Validates that `value` holds only static data: no cell or cell-like object
 * anywhere in it, and no cycle. A value reached by two paths is shared rather
 * than cyclic, and passes. This is what `Cell.of()` vets its initial value
 * with.
 *
 * @throws If `value` holds a cell or cell-like object, or a cycle.
 */
function validateStaticData(value: unknown): void {
  // The containers the walk is inside, which is what a cycle leads back to.
  const ancestors = new IndexTrackingStack<object>();

  function traverse(val: unknown, path: string[]): void {
    // Primitives are always fine
    if (val === null || val === undefined) return;
    if (typeof val !== "object" && typeof val !== "function") return;

    const obj = val as object;

    // Check for cells and cell-like objects first (before cycle check)
    if (isCell(obj)) {
      throw new Error(
        `Cell.of() only accepts static data, but found a reactive value (Cell) at path '${
          path.join(".")
        }'.\n` +
          "help: use Cell references as handler parameters or in computed() closures instead of embedding them in Cell.of() values",
      );
    }

    if (isCellResultForDereferencing(obj)) {
      throw new Error(
        `Cell.of() only accepts static data, but found a reactive value (CellResult) at path '${
          path.join(".")
        }'.\n` +
          "help: use .get() to extract the value first, or pass Cell references as handler parameters",
      );
    }

    if (ancestors.has(obj)) {
      throw new Error(
        `Cell.of() does not accept circular references. Cycle detected at path '${
          path.join(".")
        }'.\n` +
          "help: restructure your data to avoid circular references",
      );
    }

    ancestors.push(obj);

    // Every way out of the descent, a refusal thrown from inside it included,
    // takes the object back off the stack.
    try {
      // A `FabricPrimitive` reaches here and survives, correctly: it has zero
      // enumerable own properties, so `Object.keys()` is empty and the
      // descent ends -- and a leaf holds no cell for this validation to find.
      //
      // A `FabricInstance` is refused instead. Its codec contents can hold a
      // `Cell`, which is exactly what this validation exists to reject, and
      // those contents are not reachable by property name -- so passing one
      // through _smuggles_ a cell into static data past the check meant to
      // stop it. That is not a completeness gap; it is the validation failing
      // open.
      //
      // Nothing reaches this in production today, de facto rather than by
      // construction: a `FabricError` is ungated and exposed to pattern
      // authors, so what keeps this safe is that nothing yet puts one in
      // `Cell.of()` data.
      //
      // TODO(danfuzz): descend by codec-mediated traversal into instance
      // state, at which point this becomes a walk rather than a refusal.
      if (obj instanceof FabricInstance) {
        refuseFabricInstance(obj, `in \`Cell.of()\` static data`);
      }

      // Traverse arrays and objects
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          traverse(obj[i], [...path, String(i)]);
        }
      } else {
        for (const key of Object.keys(obj)) {
          traverse((obj as Record<string, unknown>)[key], [...path, key]);
        }
      }
    } finally {
      ancestors.popExpect(obj);
    }
  }

  traverse(value, []);
}

/**
 * The per-frame id source for anchoring plain array-element objects into
 * entity documents during a write (`DiffWalkState.nextAnchorId`).
 *
 * A cell holds whichever frame was on top of the builder frame stack when the
 * cell was made, and hands that frame here. The `Runtime` constructor pushes a
 * frame that nothing pops until that runtime is disposed, so a cell made while
 * a runtime is alive always carries one and this always hands back a source.
 * Making the cell inside a handler or a lift puts that frame's counter behind
 * the ids instead. Where the cell was made is what decides, not where the write
 * happens.
 */
export function frameAnchorIds(
  frame: Frame | undefined,
): (() => number) | undefined {
  return frame === undefined ? undefined : () => frame.generatedIdCounter++;
}

/**
 * What `convertCellsToLinks()` is handed: what a pattern produced. That is a
 * `FabricValue` or a convertible JS value, and on top of that the `Cell`s
 * the conversion exists to replace. None of it is durable until it has been
 * through there.
 *
 * `FabricConvertibleJsValue` is an arm rather than something restated, so
 * this stays true of whatever that comes to admit. The container arms are here
 * as well, and they are not redundant with it: theirs hold only what is already
 * fabric or convertible, where a cell may sit at any depth in what a pattern
 * produced. Replacing a nested one is the whole of what this conversion is for.
 */
export type CellLinkInput =
  | FabricConvertibleJsValue
  | readonly CellLinkInput[]
  | { readonly [key: string]: CellLinkInput }
  | Cell<any>;

/** The options by which a cell becomes the link that reaches it. */
type CellLinkOptions = {
  /** Whether the link carries the cell's schema. */
  includeSchema?: boolean;

  /**
   * Whether a query result is walked as the container it is, rather than
   * becoming a link to its cell.
   */
  doNotConvertCellResults?: boolean;

  /**
   * Whether the link carries the cell's CFC label view. What it carries is
   * the view's display form, with each caveat's source redacted: a link
   * minted under this option is bound for the main thread, where a view may
   * be shown and the sources behind it may not. Enforcement reads a cell's
   * view through the cell, never off a link.
   */
  includeCfcLabelView?: boolean;

  /** Which `asCell` entries survive in a carried schema; see `KeepAsCell`. */
  keepAsCell?: KeepAsCell;
};

/**
 * Helper for `convertCellsToLinks()`, which returns the frozen link that
 * reaches a cell, carrying the display form of the cell's CFC label view onto
 * it when asked.
 */
function linkToCell(cell: Cell<any>, options: CellLinkOptions): SigilLink {
  const link = cell.getAsLink(options);

  if (options.includeCfcLabelView) {
    const cfcLabelView = getCarriedCfcLabelView(cell);
    if (cfcLabelView) {
      setLinkCfcLabelView(link, redactCaveatSourcesForDisplay(cfcLabelView));
    }
  }

  return deepFreeze(link);
}

/**
 * Converts cells and objects that can be turned to cells to links. What comes
 * back is a deeply frozen `FabricValue` with a link wherever a cell sat.
 *
 * @param value - The value to convert.
 * @returns The converted value.
 */
export function convertCellsToLinks(
  value: CellLinkInput,
  options: CellLinkOptions = {},
): FabricValue {
  return convertOneToLinks(
    value,
    options,
    [],
    new IndexTrackingStack<object>(),
  );
}

/**
 * Recursive worker for {@link convertCellsToLinks}, carrying the state of the
 * walk in progress.
 *
 * `ancestors` holds the stack of values the walk is inside, so what it
 * recognizes is a cycle. A value reachable twice by different paths is not one:
 * it is shared, and each position gets its own conversion. Returning a
 * back-link for a shared reference would rewrite one of its positions into a
 * pointer at the other -- and a graph holds plenty of shared structure that is
 * nobody's cycle, an empty `path: []` array reachable from every alias in it
 * being the common case.
 *
 * `stack` is the path to `value`, held as one array that the walk pushes to and
 * pops from rather than as a fresh array per position. A back-link is the only
 * thing that reads a path, so what a cycle needs is the depth its ancestor
 * sits at, and the path is cut from the stack there. The cut is correct
 * because an entry sits in `ancestors` only while the walk is inside it, which
 * is exactly while the stack still holds its own path as a prefix -- and the
 * two are pushed and popped together, so an ancestor's index in the one is its
 * depth into the other.
 *
 * Each container is frozen as the walk returns it, and each link as it is
 * minted, which is what makes the whole answer deeply frozen.
 */
function convertOneToLinks(
  value: CellLinkInput,
  options: CellLinkOptions,
  stack: string[],
  ancestors: IndexTrackingStack<object>,
): FabricValue {
  switch (typeof value) {
    case "object": {
      if (value === null) {
        return value;
      }

      break;
    }
    case "function": {
      // No function has a fabric form, and none is a cell or a cell result
      // either, so it is refused before the tests below. The type admits no
      // function here either; this arm is for one that got past it. The
      // refusal is the vetting's, so that it reads the same as everywhere
      // else a value is vetted, and the assertion refuses every function, so
      // the `throw` after it is unreachable: it is here so that the arm ends
      // where it reads as ending, rather than as a `break` into the walk.
      assertValidFabricValueLayer(value);
      throw new Error("Unreachable: a function never passes vetting.");
    }
    default: {
      // A primitive, which is a `FabricValue` by type. No primitive is vetted
      // here, so a symbol the vetting would refuse is returned as given.
      return value;
    }
  }

  // At this point `value` is a non-`null` object.

  const depth = ancestors.indexOf(value);

  if (depth >= 0) {
    return deepFreeze(linkRefFrom({ path: stack.slice(0, depth) }));
  }

  // Early-return cases
  if (!options.doNotConvertCellResults && isCellResultForDereferencing(value)) {
    return linkToCell(getCellOrThrow(value), options);
  } else if (isCell(value)) {
    return linkToCell(value, options);
  }

  // What goes onto `ancestors` -- and comes off again on the way back out --
  // is the object as given.
  const original: object = value;

  // Only a container reaches the walk below: everything else has returned or
  // been refused by the time the branch ends, which is what the type says.
  let container: unknown[] | Record<string, unknown>;

  // Tracked for circularity, at the depth a back-link to it names.
  ancestors.push(original);

  // Everything past the line above runs inside this `try`, so that EVERY way
  // out clears the ancestor just recorded -- the exits that return a value
  // without descending into it as much as the ones that recur. An exit that
  // skipped the clearing would leave the value an ancestor of all the rest of
  // the walk, and the next position holding it would be taken for a cycle.
  try {
    // A schema-bearing read hangs a non-enumerable `toCell` symbol on the
    // containers it returns. That symbol is machinery, not content, and a
    // container carrying it is not a `FabricValue`, so it is kept away from
    // the vetting below, which would refuse it. Whatever else a container
    // carries that is neither an index nor an enumerable string key is
    // dropped along with the symbol.
    if (isCellResultForDereferencing(value) && isPlainContainer(value)) {
      const isArray = Array.isArray(value);

      if (
        Object.hasOwn(value, toCell) &&
        Object.getPrototypeOf(value) ===
          (isArray ? Array.prototype : Object.prototype)
      ) {
        // An annotated container: a plain array or object carrying the
        // symbol as its own property. The rebuild below reads only index and
        // enumerable string keys, so it sheds the symbol on its own, and the
        // container goes to it as it stands. The prototype check is what
        // lets the rebuild use the container's own `map()`, which on a
        // subclass would return a subclass instance.
        container = value as unknown[] | Record<string, unknown>;
      } else {
        // A query-result proxy serves the symbol from a trap rather than as
        // an own property, and a subclass fails the prototype check. Either
        // is read out into a plain copy first, which is a valid
        // `FabricValueLayer` already and so wants no further conversion.
        // Objects need this as much as arrays do -- the annotation goes on
        // either (see `schema.ts`).
        container = (isArray
          ? shallowCleanArray(value, false)
          : shallowCleanPlainObject(value as object, false)) as
            | unknown[]
            | Record<string, unknown>;
      }
    } else {
      // A JS object carrying a fabric form is minted into it here: a
      // `Date` or `Uint8Array` becomes a `FabricPrimitive`, an `Error` a
      // `FabricError`. Anything else comes back `undefined`, which says only
      // that nothing needed minting.
      const minted = shallowFabricFromConvertibleJsObjectElseUndefined(value);

      if (minted === undefined) {
        // Nothing was minted, so the value has to be usable as it stands. This
        // is what refuses a function, a class instance, a container that is
        // not inert, and a `FabricPrimitive` subclass this system does not
        // recognize -- and it runs BEFORE the leaf return below, since a leaf
        // that is refused here is one nothing downstream could have encoded.
        assertValidFabricValueLayer(value);
      }

      // A fresh mint or the value as vetted; either way a decided fabric
      // layer, so the two tests below run once over the pair.
      const layer = minted ?? (value as FabricValueLayer);

      if (layer instanceof FabricPrimitive) {
        // An opaque scalar whose state lives in private fields, so it has zero
        // enumerable own properties and the object branch below would rebuild
        // it from its (empty) entries as a bare `{}`. It leaves whole instead.
        return layer;
      } else if (layer instanceof FabricInstance) {
        // Not a leaf: a container reached by its codec contents, which this
        // walk cannot do.
        refuseFabricInstance(layer, "when converting cells to links");
      }

      container = layer as unknown[] | Record<string, unknown>;
    }

    // A member arrives here `unknown`: only the top level has been decided, so
    // what a container holds is unconverted until the recursion reaches it.
    // That makes each one a `CellLinkInput` -- the very domain this walk takes
    // -- rather than anything narrower.
    //
    // Each descent brackets itself with a push and a pop, so the stack holds
    // the path to whatever the walk is looking at and holds nothing else.
    if (Array.isArray(container)) {
      // Built through `map()` rather than by index assignment into a
      // preallocated array. The two produce equal arrays, and not equally
      // cheap ones: `map()` leaves a hole a hole and returns a packed array
      // where filling `new Array(n)` by index returns a holey one, which
      // costs its consumers -- about a fifth of what structured-cloning the
      // result takes, paid on every crossing to the client.
      return Object.freeze(container.map((element: unknown, index: number) => {
        stack.push(String(index));

        const converted = convertOneToLinks(
          element as CellLinkInput,
          options,
          stack,
          ancestors,
        );

        stack.pop();

        return converted;
      }));
    }

    // Built through `fromEntries()` rather than by assigning member by member.
    // The two produce equal objects, and not equally cheap ones: an object
    // filled by assignment costs about half again as much to structured-clone
    // as the same object built from entries, and every consumer of a converted
    // value pays that, the crossing to the client included.
    return Object.freeze(Object.fromEntries(
      Object.entries(container).map(([key, member]) => {
        stack.push(key);

        const converted = convertOneToLinks(
          member as CellLinkInput,
          options,
          stack,
          ancestors,
        );

        stack.pop();

        return [key, converted];
      }),
    ));
  } finally {
    // `popExpect()` instead of just `pop()`, as defense-in-depth against bugs
    // elsewhere in the code.
    ancestors.popExpect(original);
  }
}

/**
 * Check if value is a simple cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isCell(value: any): value is Cell<any> {
  return value instanceof CellImpl;
}

/** Check whether a cell capability permits reading its stored value. */
export function isReadableCell(
  value: any,
): value is Cell<any> | ReadonlyCell<any> {
  return value instanceof CellImpl && value.isReadableCell();
}

/**
 * Check if value is any kind of cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isAnyCell(value: any): value is AnyCell<any> {
  return value instanceof CellImpl;
}

/**
 * Type guard to check if a value is a Stream.
 * @param value - The value to check
 * @returns True if the value is a Stream
 */
export function isStream<T = any>(value: any): value is Stream<T> {
  return (value instanceof CellImpl && (value as any).isStream?.());
}

export type DeepKeyLookup<T, Path extends PropertyKey[]> = Path extends [] ? T
  : Path extends [infer First, ...infer Rest]
    ? First extends keyof T
      ? Rest extends PropertyKey[] ? DeepKeyLookup<T[First], Rest>
      : any
    : any
  : any;

const scopedConstructorNames = {
  space: "perSpace",
  user: "perUser",
  session: "perSession",
} as const satisfies Record<CellScope, string>;

type ConstructableCellFactory<Wrap extends HKT> = {
  new <T>(value?: T, providedSchema?: JSONSchema): Apply<Wrap, T>;
  of<T>(value?: T, providedSchema?: JSONSchema): Apply<Wrap, T>;
  for<T>(cause: unknown): Apply<Wrap, T>;
};

function mergeSchemaScope(
  providedSchema: JSONSchema | undefined,
  scope: CellScope | undefined,
): JSONSchema | undefined {
  if (!scope) return providedSchema;

  const schema = ContextualFlowControl.toSchemaObj(providedSchema);
  if (schema.scope !== undefined && schema.scope !== scope) {
    throw new Error(
      `Cannot use ${
        scopedConstructorNames[scope]
      } with schema scope "${schema.scope}".`,
    );
  }
  return { ...schema, scope };
}

function schemaWithDefaultAndScope<T>(
  value: T | undefined,
  providedSchema: JSONSchema | undefined,
  scope: CellScope | undefined,
): JSONSchema | undefined {
  const scopedSchema = mergeSchemaScope(providedSchema, scope);
  if (value !== undefined && !isCell(value)) {
    return {
      ...ContextualFlowControl.toSchemaObj(scopedSchema),
      default: value as any,
    };
  }
  return scopedSchema;
}

export function schemaCellScope(
  schema: JSONSchema | undefined,
): CellScope | undefined {
  const declared = declaredSchemaScope(schema);
  return isCellScope(declared) ? declared : undefined;
}

/**
 * Returns `true` if the value is, or transitively contains, a query-result
 * proxy. Schemas are plain JSON, so the walk is acyclic; visiting plain
 * objects is trap-free, and a proxy is detected before recursing into it.
 */
function containsCellResult(value: unknown): boolean {
  if (!isObjectOrArray(value)) return false;
  if (isCellResultForDereferencing(value)) return true;
  for (const v of Object.values(value)) {
    if (containsCellResult(v)) return true;
  }
  return false;
}

/**
 * Interns a schema for attachment to a cell link, so the link carries the
 * canonical deep-frozen instance and the downstream identity-keyed schema
 * caches (cfc.schemaAtPath, schema-ref memos, selector standardization,
 * value-hash) hit instead of staying cold for mutable schema literals.
 *
 * Interning deep-freezes the caller's schema object in place — the same
 * contract `resolveSchema()` already applies to cell schemas on every
 * read/write-policy path.
 *
 * Exception: a schema that (transitively) contains a query-result proxy —
 * e.g. the wish builtin's `schema` argument — must NOT be frozen in place,
 * as that would push structural mutation through the proxy onto the live
 * backing value (and trip the proxy's structural-mutation guard). Such schemas
 * are interned via `deepFrozenCloneAndInternSchema()`, which deep-freezes a
 * clone — de-proxying the containers and preserving `FabricValue` leaves —
 * instead of freezing the argument in place.
 */
export function internCellLinkSchema(schema: JSONSchema): JSONSchema;
export function internCellLinkSchema(
  schema?: JSONSchema,
): JSONSchema | undefined;
export function internCellLinkSchema(
  schema?: JSONSchema,
): JSONSchema | undefined {
  // Already canonical (covers `undefined` and boolean schemas): skip the proxy
  // scan and return as-is.
  if (isInternedSchema(schema)) return schema;
  if (containsCellResult(schema)) {
    return deepFrozenCloneAndInternSchema(schema);
  }
  return internSchema(schema);
}

/**
 * Factory function to create Cell constructor with static methods for a specific cell kind
 */
export function cellConstructorFactory<Wrap extends HKT>(kind: CellKind) {
  const createCellConstructor = (scope?: CellScope) => {
    const createWithDefault = <T>(
      value?: T,
      providedSchema?: JSONSchema,
    ): Apply<Wrap, T> => {
      const frame = getTopFrame();
      if (!frame || !frame.runtime) {
        throw new Error(
          "Can't invoke Cell.of() outside of a pattern/handler/lift context",
        );
      }

      // Validate that value contains only static data (no cells or cycles)
      if (value !== undefined) {
        validateStaticData(value);
      }

      // TODO(danfuzz): JS values in a `Cell.of(...)` initial value are NOT
      // normalized to their fabric form (e.g. a `Date` stays a raw `Date`
      // instead of becoming a `FabricEpochNsec`), unlike the `set()` write path
      // (whose diff normalizes at the write boundary). The raw value flows into
      // `setInitialValue()` and into the schema `default` via
      // `schemaWithDefaultAndScope()` above, and reaches storage/encode from
      // there -- so a `Cell.of(new Date())` throws under the strict codec.
      // (Normalizing only the `setInitialValue()` arg is insufficient; the
      // schema-`default` copy still leaks the raw value, and embedding a
      // `FabricSpecialObject` in a hashed schema `default` is its own hazard.)
      // Fixing this cleanly is entangled with the initial-value / schema-default
      // materialization path; left for that follow-up.

      // Convert schema to object form and merge default value if value is defined
      // BUT: Don't embed Cell objects in the schema's default property, as this
      // causes infinite recursion when the schema is serialized
      const schema = schemaWithDefaultAndScope(value, providedSchema, scope);
      const linkScope = scope ?? schemaCellScope(schema);

      // Create a cell without a link - it will be created on demand via .for()
      const cell = createCell<T>(
        frame.runtime,
        {
          path: [],
          ...(schema !== undefined && { schema }),
          ...(frame.space && { space: frame.space }),
          ...(linkScope !== undefined && { scope: linkScope }),
        },
        frame.tx,
        false,
        kind,
      );

      return cell;
    };

    const createWithCause = <T>(cause: unknown): Apply<Wrap, T> => {
      const frame = getTopFrame();
      if (!frame || !frame.runtime) {
        throw new Error(
          "Can't invoke Cell.for() outside of a pattern/handler/lift context",
        );
      }

      const schema = mergeSchemaScope(undefined, scope);
      const linkScope = scope ?? schemaCellScope(schema);

      // Create a cell without a link
      const cell = createCell<T>(
        frame.runtime,
        {
          path: [],
          ...(schema !== undefined && { schema }),
          ...(frame.space && { space: frame.space }),
          ...(linkScope !== undefined && { scope: linkScope }),
        },
        frame.tx,
        false,
        kind,
      );

      // Associate it with the cause
      cell.for(cause);

      return cell;
    };

    const constructor = function <T>(
      this: unknown,
      value?: T,
      providedSchema?: JSONSchema,
    ): Apply<Wrap, T> {
      return createWithDefault(value, providedSchema);
    };

    return Object.assign(constructor, {
      of: createWithDefault,
      for: createWithCause,
    }) as unknown as ConstructableCellFactory<Wrap>;
  };

  const baseConstructor = createCellConstructor();
  return Object.assign(baseConstructor, {
    perSpace: createCellConstructor("space") as unknown as CellTypeConstructor<
      Wrap
    >["perSpace"],
    perUser: createCellConstructor("user") as unknown as CellTypeConstructor<
      Wrap
    >["perUser"],
    perSession: createCellConstructor(
      "session",
    ) as unknown as CellTypeConstructor<
      Wrap
    >["perSession"],

    /**
     * Compare two cells or values for equality, after resolving them.
     * @param a - First cell or value to compare
     * @param b - Second cell or value to compare
     * @returns true if the values are equal
     */
    equals(
      a: AnyCell<any> | object | undefined,
      b: AnyCell<any> | object | undefined,
    ): boolean {
      const frame = getTopFrame();
      return areLinksSame(
        a,
        b,
        undefined,
        !!frame?.tx,
        frame?.tx,
        frame?.runtime,
      );
    },

    /**
     * Compare two cells or values for equality.
     * @param a - First cell or value to compare
     * @param b - Second cell or value to compare
     * @returns true if the values are equal
     */
    equalLinks(
      a: AnyCell<any> | object | undefined,
      b: AnyCell<any> | object | undefined,
    ): boolean {
      return areLinksSame(a, b);
    },
  }) as unknown as CellTypeConstructor<Wrap>;
}
