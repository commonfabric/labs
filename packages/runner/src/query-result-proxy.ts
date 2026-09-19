import {
  FabricInstance,
  FabricPrimitive,
  isWalkableObjectOrArray,
} from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { readStatsActive, recordProxyAccess } from "./read-stats.ts";
import { isStreamValue } from "./builder/types.ts";
import { type BackToCellInternals, toCell } from "./back-to-cell.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { resolveLinkTracingDereferences } from "./link-resolution.ts";
import { type NormalizedFullLink } from "./link-utils.ts";
import { type Cell, createCell } from "./cell.ts";
import { type Runtime } from "./runtime.ts";
import {
  type IExtendedStorageTransaction,
  type IReadOptions,
} from "./storage/interface.ts";
import { ignoreReadForScheduling } from "./storage/reactivity-log.ts";
import {
  type CfcLabelView,
  cfcLabelViewForDereferenceTraces,
  cloneCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./cfc/label-view-state.ts";

// Maximum recursion depth to prevent infinite loops
const MAX_RECURSION_DEPTH = 100;

// Container/shape reads (proxy creation, ownKeys, getOwnPropertyDescriptor, has,
// array length) are recorded as nonRecursive so the engine applies shallow
// (shape-only) conflict granularity to them — matching how the scheduler
// reader-dirty index already treats nonRecursive reads. Value materialization
// (leaf scalars via child-proxy creation, array methods that consume elements)
// stays recursive.
const SHAPE_READ: IReadOptions = { nonRecursive: true };

// Cache of target objects to their proxies, scoped by ReactivityLog.
//
// `byValue` sits behind `byLink` so that two links resolving to one stored
// object are one object to a consumer comparing by identity.
type ProxyCache = {
  byLink: Map<string, any>;
  byValue: WeakMap<object, any>;
};

const proxyCacheByTx = new WeakMap<
  IExtendedStorageTransaction,
  ProxyCache
>();
// The index a read with no transaction of its own is cached under, one per
// runtime. Two runtimes in a single process — every test that makes its own,
// and any host running more than one — can name the same space and entity, so a
// single process-wide index would hand one runtime's reader a proxy closed over
// the other's runtime, reading through the wrong storage. Held weakly, so an
// index and its cache go when the runtime does.
const defaultTxByRuntime = new WeakMap<
  Runtime,
  IExtendedStorageTransaction
>();

const defaultTxFor = (runtime: Runtime): IExtendedStorageTransaction => {
  let index = defaultTxByRuntime.get(runtime);
  if (index === undefined) {
    index = {} as IExtendedStorageTransaction;
    defaultTxByRuntime.set(runtime, index);
  }
  return index;
};

const getProxyCache = (
  tx: IExtendedStorageTransaction | undefined,
  runtime: Runtime,
): ProxyCache => {
  const cacheIndex = tx ?? defaultTxFor(runtime);
  let txCache = proxyCacheByTx.get(cacheIndex);
  if (!txCache) {
    txCache = {
      byLink: new Map<string, any>(),
      byValue: new WeakMap<object, any>(),
    };
    proxyCacheByTx.set(cacheIndex, txCache);
  }
  return txCache;
};

const proxyCacheKey = (
  link: NormalizedFullLink,
  cfcLabelView: CfcLabelView | undefined,
  // Two pinned views over the same link describe different instants when they
  // were taken either side of a write, so the instant is part of what makes
  // them the same view. An unpinned handle has none and shares as it always
  // has.
  epoch: number | undefined,
): string =>
  JSON.stringify([
    link.space,
    link.id,
    link.path,
    cfcLabelView ?? null,
    epoch ?? null,
  ]);

/** Whether a transaction can still answer a read. */
const isReadable = (tx: IExtendedStorageTransaction): boolean =>
  tx.status().status === "ready";

const childLabelView = (
  cfcLabelView: CfcLabelView | undefined,
  segment: string,
): CfcLabelView | undefined => rebaseCfcLabelView(cfcLabelView, [segment]);

// Array.prototype's entries, and whether they modify the array
enum ArrayMethodType {
  ReadOnly,
  ReadWrite,
  WriteOnly,
}

const arrayMethods: { [key: string]: ArrayMethodType } = {
  at: ArrayMethodType.ReadOnly,
  concat: ArrayMethodType.ReadOnly,
  copyWithin: ArrayMethodType.ReadWrite,
  entries: ArrayMethodType.ReadOnly,
  every: ArrayMethodType.ReadOnly,
  fill: ArrayMethodType.WriteOnly,
  filter: ArrayMethodType.ReadOnly,
  find: ArrayMethodType.ReadOnly,
  findIndex: ArrayMethodType.ReadOnly,
  findLast: ArrayMethodType.ReadOnly,
  findLastIndex: ArrayMethodType.ReadOnly,
  flat: ArrayMethodType.ReadOnly,
  flatMap: ArrayMethodType.ReadOnly,
  forEach: ArrayMethodType.ReadOnly,
  includes: ArrayMethodType.ReadOnly,
  indexOf: ArrayMethodType.ReadOnly,
  join: ArrayMethodType.ReadOnly,
  keys: ArrayMethodType.ReadOnly,
  lastIndexOf: ArrayMethodType.ReadOnly,
  map: ArrayMethodType.ReadOnly,
  pop: ArrayMethodType.ReadWrite,
  push: ArrayMethodType.WriteOnly,
  reduce: ArrayMethodType.ReadOnly,
  reduceRight: ArrayMethodType.ReadOnly,
  reverse: ArrayMethodType.ReadWrite,
  shift: ArrayMethodType.ReadWrite,
  slice: ArrayMethodType.ReadOnly,
  some: ArrayMethodType.ReadOnly,
  sort: ArrayMethodType.ReadWrite,
  splice: ArrayMethodType.ReadWrite,
  toReversed: ArrayMethodType.ReadOnly,
  toSorted: ArrayMethodType.ReadOnly,
  toSpliced: ArrayMethodType.ReadOnly,
  unshift: ArrayMethodType.WriteOnly,
  values: ArrayMethodType.ReadOnly,
  with: ArrayMethodType.ReadOnly,

  hasOwnProperty: ArrayMethodType.ReadOnly,
  isPrototypeOf: ArrayMethodType.ReadOnly,
  propertyIsEnumerable: ArrayMethodType.ReadOnly,
  valueOf: ArrayMethodType.ReadOnly,
  toString: ArrayMethodType.ReadOnly,
  toLocaleString: ArrayMethodType.ReadOnly,
};

/**
 * Builds a read-only JS proxy view over a stored cell. Read traps resolve
 * links and wrap nested values; every write refuses.
 *
 * **A view's own traps carry no write capability.** Property assignment and
 * the in-place array mutators (`push`, `splice`, `unshift`, …) throw, naming
 * `Writable<..>` as the way to ask for write access. Writes reach a cell
 * through the `asCell` handle a `Writable<..>` field mints, whose
 * `Cell.set`/`Cell.push` carry the merge intent and the write-boundary
 * normalization.
 *
 * `h()` (`builder/h.ts`) is the one route that turns a view back into a
 * handle: a view bound to a `$`-prefixed JSX prop is converted to a
 * `keepAsCell` link, so `<cf-input $value={props.title} />` renders a writable
 * binding from a plain one. `collectWritablyBoundRoots` in `builder/pattern.ts`
 * reads a plain binding as unwritable when it classifies a cell `computed`;
 * `docs/specs/computed-cell-identity.md` records exposure on the result surface
 * as an accepted consequence rather than a disqualifier.
 */
export function createQueryResultProxy<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  depth: number = 0,
  cfcLabelView?: CfcLabelView,
): T {
  // The transaction decides which of the two this is. Marked for lazy
  // materialization, the proxy is a view: it keeps this transaction and
  // describes the instant it was taken at, so the value it reports stays the
  // value that was there however the reader writes afterwards, and reading
  // after the transaction finishes throws.
  //
  // Unmarked — every caller today — it is a standing handle on a cell that
  // resolves the transaction afresh on every access, so a holder keeps reading
  // current state after the transaction it was made against has finished. Long-
  // lived consumers depend on that: a tool call dispatched by the LLM builtin,
  // a SQLite result flushed after commit, and a piece started on demand all
  // read handles their originating run no longer owns.
  //
  // An unmarked caller who supplies no transaction gets a genuinely fresh one
  // per access rather than whatever `readTx()` would hand back, so the handle
  // cannot be pinned to an ambient transaction that has since gone stale.
  const pinned = tx?.isLazyMaterialize() === true;
  return createViewProxy(
    runtime,
    pinned ? tx : tx === undefined ? runtime.edit() : runtime.readTx(tx),
    tx,
    link,
    depth,
    cfcLabelView,
    pinned,
  );
}

/**
 * The shared proxy body.
 *
 * Reads go through `readTx()`: the transaction fixed at creation when
 * `pinned`, and one resolved per access otherwise. Cell minting goes through
 * `tx` — the transaction the caller actually supplied, which is `undefined`
 * when they supplied none. Every write trap refuses. The proxy cache is keyed
 * on `viewTx`, the transaction the proxies in it actually read through, so a
 * cached proxy is never handed to a caller reading through a different one.
 */
function createViewProxy<T>(
  runtime: Runtime,
  viewTx: IExtendedStorageTransaction,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  depth: number,
  cfcLabelView: CfcLabelView | undefined,
  pinned: boolean,
): T {
  // The transaction a trap reads through, and the one a child view is built
  // over. A pinned view keeps the transaction it was created with for both; an
  // unpinned one resolves afresh, so it tracks current state once its original
  // has finished. A child of an unpinned tx-less view inherits that view's own
  // transaction rather than minting one per child.
  const readTx = (): IExtendedStorageTransaction =>
    pinned ? viewTx : runtime.readTx(tx);
  const childViewTx = (): IExtendedStorageTransaction =>
    pinned ? viewTx : runtime.readTx(tx ?? viewTx);
  // The instant a pinned view describes. A child built inside a parent's trap
  // inherits that parent's instant rather than taking a later one, which is
  // what `issueReadEpoch` hands back while a read is already walking. An
  // unpinned handle tracks current state and takes none.
  //
  // The reads this construction makes need no scope around them: no write can
  // land between the epoch above and them, so current state IS that instant.
  // The traps below fire later, and those do.
  const epoch = pinned ? viewTx.issueReadEpoch() : undefined;
  // Unlike the schema view, which gates its two read chokepoints by hand, the
  // traps here read from a dozen branches apiece, so they share one wrapper.
  // The thunk costs an allocation per trap call on a transaction that has
  // written; this is the schema-LESS path, which a lift's argument does not
  // take, and the shape of these traps makes the by-hand form a worse trade.
  const atEpoch = <T>(body: () => T): T => {
    if (epoch === undefined || !viewTx.hasWrites()) return body();
    const previous = viewTx.enterReadEpoch(epoch);
    try {
      return body();
    } finally {
      viewTx.exitReadEpoch(previous);
    }
  };
  // Check recursion depth
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error(
      `Maximum recursion depth of ${MAX_RECURSION_DEPTH} exceeded`,
    );
  }

  // Resolve path and follow links to actual value. The resolution hands back
  // the dereference traces it recorded, so the label view below costs no read
  // of the transaction's CFC state.
  // A proxy access is a content read: the crossing seam marks labeled hops
  // (schema-less readers carry no schema of their own to catch them).
  const resolved = resolveLinkTracingDereferences(
    runtime,
    viewTx,
    link,
    "value",
    {
      markIfcCrossings: true,
    },
  );

  // Everything from here down — the label view, the value read, the stream and
  // primitive dispatch, the proxy — is a function of this transaction's
  // snapshot and the link the caller ASKED for. The cache below is keyed on
  // that link rather than the resolved one, which is the difference between
  // consulting it and having to resolve and read a value first just to name
  // the entry. A scan that touches each element more than once pays the walk
  // and the read once.
  //
  // The resolution above still runs on every access: it is what records this
  // read's dereference traces and fires the sync kicks that belong to it, and
  // being memoized itself, that is all it does on a repeat.
  //
  // The key names no more than the caches below it already distinguish, so
  // this index can never be the reason two things that differ share a view.
  // `depth` is not in it, because `byLink` conflates it. `pinned` is: a memo
  // may outlive a write when a reader holds the instant it describes, and
  // after that write a pinned view still describes that instant while an
  // unpinned handle reads current state, so the two are different things
  // under one link.
  //
  // A caller-supplied label view would have to be part of the key, and
  // serializing one costs more than the read it saves. Those reads take the
  // long way; a label view arrives only where a document carries stored CFC
  // labels.
  const viewMemo = cfcLabelView === undefined && resolved.memoKey !== undefined
    ? viewTx.getSnapshotMemo?.()
    : undefined;
  const viewKey = viewMemo === undefined
    ? ""
    : `view:${pinned ? "pinned" : "handle"}:${resolved.memoKey}`;
  const cached = viewMemo?.get(viewKey) as { view: unknown } | undefined;
  if (cached !== undefined) return cached.view as T;
  const remember = <V>(view: V): V => {
    viewMemo?.set(viewKey, { view });
    return view;
  };

  link = resolved.link;
  cfcLabelView = mergeCfcLabelViews([
    cloneCfcLabelView(cfcLabelView),
    cfcLabelViewForDereferenceTraces(viewTx, resolved.traces),
  ]);
  // A stream position is declared by the link's schema: the stamp the builder
  // puts on a stream's alias, which the stored redirect carries onto the
  // resolved link. The handle is minted from that alone, since the document
  // behind a stream holds no value to read.
  if (ContextualFlowControl.declaresStream(link.schema)) {
    return remember(
      createCell(runtime, link, tx, false, "stream", cfcLabelView) as T,
    );
  }

  const value = viewTx.readValueOrThrow(link, SHAPE_READ) as any;

  // The SHAPE_READ above only tracks the container's shape, but the stream
  // check depends on a specific field's VALUE. Register an explicit read of
  // `$stream` when present, so a value flipping into/out of a stream marker
  // re-triggers consumers. [review: ubik2]
  if (isObjectOrArray(value) && "$stream" in value) {
    viewTx.readValueOrThrow({ ...link, path: [...link.path, "$stream"] });
  }

  // If the value is a stream marker ({ $stream: true }), return a Cell with
  // stream kind so that .send() is available. This handles the case where a
  // pattern's Output type wasn't explicitly specified, causing the capture
  // schema to lose the asCell stream information.
  if (isStreamValue(value)) {
    return remember(
      createCell(runtime, link, tx, false, "stream", cfcLabelView) as T,
    );
  }

  // `FabricPrimitive`s (byte sequences, temporal values, hashes, ...) are
  // immutable leaves that behave like primitives -- there is no reactive
  // substructure to resolve and they are already frozen. Hand back the value
  // directly, exactly as for JS primitives above; wrapping one in a live proxy
  // serves no purpose and would leak that proxy into any consumer that
  // deep-clones or freezes the surrounding value (e.g. schema interning).
  if (!isObjectOrArray(value) || value instanceof FabricPrimitive) {
    // The SHAPE_READ above tracks only the container's shape, but a
    // FabricPrimitive is an atomic VALUE the consumer materializes here (handed
    // back directly, like a JS primitive), not a container whose shape it
    // inspects. Register a recursive value read so an in-place change to the
    // primitive (e.g. a FabricBytes updated to different bytes) re-triggers
    // consumers — a nonRecursive read is compared shape-only and would miss it.
    if (value instanceof FabricPrimitive) {
      viewTx.readValueOrThrow(link);
    }
    return remember(value);
  }

  // A `FabricInstance` is _not_ exempted here the way a `FabricPrimitive` is
  // above, so one gets wrapped in a proxy -- and that has a consequence outside
  // this file which is easy to miss from here.
  //
  // The proxy target is an empty stub and there is no `getPrototypeOf` trap, so
  // a proxied instance's prototype is `Object.prototype` and
  // `instanceof FabricInstance` is _false_ for it. Every
  // `instanceof FabricInstance` guard in the runner is therefore blind to an
  // instance that arrives through a cell read -- the refusal does not fire and
  // the walk proceeds to rebuild the value as a bare `{}`. That is around ten
  // sites and counting, so they are not listed here to go stale;
  // `grep -rn 'instanceof FabricInstance' packages/runner/src` finds them.
  //
  // `isFabricInstanceOrView()` below is the interim test for a client that
  // has an answer for an instance and must not lose one this way. It asks
  // nothing of the view: `storedValueByView` records, at construction, the
  // stored object each view stands for, and the predicate asks `instanceof`
  // of that object.
  //
  // `test/llm-dialog-special-objects.test.ts` pins that end to end, so closing
  // this turns that test red rather than letting it pass silently.
  //
  // TODO(danfuzz): make a proxied `FabricInstance` perceived as one by the
  // proxy's clients. Note this is not simply extending the raw-return exemption
  // above: unlike a primitive, an instance is not necessarily frozen and _does_
  // expose outgoing references (just as plain objects and arrays do), so the
  // proxy is here on purpose and something has to preserve type identity
  // without losing member resolution.

  // Stored objects are deep-frozen during storage normalization
  // (fabricFromConvertibleJsValue). A frozen proxy target would force every
  // property access through the invariant guard (ECMAScript 10.5.8: a [[Get]]
  // trap on a non-configurable, non-writable data property must return the
  // target's own value), bypassing the get trap's link resolution entirely.
  //
  // Fix: use an unfrozen empty stub as the proxy target. The stub's contents
  // are irrelevant -- the get trap always reads live data from the transaction,
  // never from the target. The stub only needs to:
  //   1. Be unfrozen, so all properties are configurable (no invariant
  //      conflicts).
  //   2. Match the value's type: [] for arrays (so Array.isArray checks on the
  //      proxy target work) and {} for objects.
  //   3. For arrays, match the length (getOwnPropertyDescriptor returns the
  //      target's non-configurable length property, so it must be correct).
  //
  // Sparse arrays (new Array(n)) are used for array stubs -- JS engines
  // represent these as holey arrays with no element allocation until writes,
  // and we never write to the stub.
  const proxyTarget = Object.isFrozen(value)
    ? (Array.isArray(value) ? new Array(value.length) : {})
    : value;

  // Index by the CALLER's transaction, not by the one reads resolve through.
  // A standing handle is created without a transaction and resolves a fresh one
  // per access, so indexing by the resolved transaction gives every read its own
  // cache and hands back a different object each time — and a consumer that
  // holds one and later meets it again (FUSE matching a callable against its own
  // entry, a value whose element points back at the array containing it) sees
  // two things where there is one. Tx-less reads share the default index, which
  // is what makes them the same object.
  //
  // A pinned view has the marked transaction as its caller tx, so it still gets
  // one cache per transaction — which is right, because it describes the instant
  // that transaction saw.
  const txCache = getProxyCache(tx, runtime);
  const cacheKey = proxyCacheKey(link, cfcLabelView, epoch);

  // Check if we already have a proxy for this target in the cache.
  // The cache key is the original `value` (not the stub), ensuring that
  // the same frozen object always maps to the same proxy instance.
  const existingProxy = txCache.byLink.get(cacheKey) ??
    (cfcLabelView === undefined && epoch === undefined
      ? txCache.byValue.get(value)
      : undefined);
  if (existingProxy) return remember(existingProxy);

  const proxy = new Proxy(proxyTarget as object, {
    get: (target, prop, receiver) =>
      atEpoch(() => {
        // Promise adoption probes `then` on every value it receives, so a view
        // that refuses the probe cannot cross a promise boundary at all — and a
        // lift's result crosses one by construction. A finished view returns
        // `undefined` for it, which is what a live one returns for a value
        // with no `then`; every other property still refuses.
        if (prop === "then" && pinned && !isReadable(viewTx)) return undefined;
        if (Array.isArray(value) && prop === "length") {
          const accessTx = readTx();
          if (readStatsActive) recordProxyAccess(accessTx);
          const current = accessTx.readValueOrThrow(link) as typeof value;
          return Array.isArray(current) ? current.length : 0;
        }

        // When encountering a frozen property, we just return the value to
        // maintain proxy invariants.
        const descriptor = Object.getOwnPropertyDescriptor(target, prop);
        if (descriptor?.configurable === false) {
          return Reflect.get(target, prop, receiver);
        }

        if (typeof prop === "symbol") {
          if (prop === toCell) {
            return () =>
              createCell(runtime, link, tx, false, undefined, cfcLabelView);
          } else if (prop === Symbol.iterator && Array.isArray(value)) {
            return function () {
              let index = 0;
              return {
                // Pulled after the trap returned, so it steps into the
                // instant itself rather than inheriting the trap's scope.
                next: () =>
                  atEpoch(() => {
                    const length = readTx().readValueOrThrow({
                      ...link,
                      path: [...link.path, "length"],
                    }) as number;
                    if (index < length) {
                      const accessTx = childViewTx();
                      if (readStatsActive) recordProxyAccess(accessTx);
                      const result = {
                        value: createViewProxy(
                          runtime,
                          accessTx,
                          tx,
                          {
                            ...link,
                            path: [...link.path, String(index)],
                          },
                          depth + 1,
                          childLabelView(cfcLabelView, String(index)),
                          pinned,
                        ),
                        done: false,
                      };
                      index++;
                      return result;
                    }
                    return { done: true };
                  }),
              };
            };
          }
          const current = readTx().readValueOrThrow(link) as typeof value;

          const returnValue = Reflect.get(current, prop, current);
          if (typeof returnValue === "function") {
            return returnValue.bind(current);
          } else return returnValue;
        }

        if (
          Array.isArray(value) &&
          Object.prototype.hasOwnProperty.call(arrayMethods, prop) &&
          typeof (value[prop as keyof typeof value]) === "function"
        ) {
          const method = Array.prototype[prop as keyof typeof Array.prototype];
          const isReadWrite = arrayMethods[prop as keyof typeof arrayMethods];

          return isReadWrite === ArrayMethodType.ReadOnly
            // Invoked after the trap returned, so reading the elements steps
            // into the instant itself; see the iterator above. The caller's
            // callback runs OUTSIDE it, below — the instant belongs to reading
            // this array, not to whatever the caller does with what it reads,
            // and a read the callback takes of anything else (a cell it just
            // wrote, most of all) describes current state as it would anywhere
            // else. Mirrors `materialize()` in the schema view.
            ? (...args: any[]) => {
              const copy = atEpoch(() => {
                // This will also mark each element read in the log. Almost all
                // methods implicitly read all elements. TODO: Deal with
                // exceptions like at().
                const length = readTx().readValueOrThrow({
                  ...link,
                  path: [...link.path, "length"],
                }) as number;

                if (typeof length !== "number") {
                  throw new Error(
                    `Array length is not a number for ${prop} operation`,
                  );
                }

                const current = readTx().readValueOrThrow(link) as typeof value;
                const copy = new Array(length);
                for (let i = 0; i < length; i++) {
                  if (!(i in current)) {
                    continue;
                  }
                  const accessTx = childViewTx();
                  if (readStatsActive) recordProxyAccess(accessTx);
                  copy[i] = createViewProxy(
                    runtime,
                    accessTx,
                    tx,
                    { ...link, path: [...link.path, String(i)] },
                    depth + 1,
                    childLabelView(cfcLabelView, String(i)),
                    pinned,
                  );
                }

                return copy;
              });
              return method.apply(copy, args);
            }
            : () => {
              // A view is read-only, so the in-place mutators have nothing to
              // route to. Mutate through the `asCell` handle a `Writable<..>`
              // field mints, whose `Cell.push`/`Cell.set` carry the merge intent
              // these methods never could.
              throw new Error(
                "This value is read-only, declare type as Writable<..> instead to get a writable version",
              );
            };
        }

        // Prototype properties are JavaScript behavior, not persisted child
        // values. Reflect them from the current container instead of issuing a
        // storage read for an inherited path such as `constructor` or
        // `toString`. Storage traversal deliberately considers own properties
        // only; keeping the same boundary here also avoids recording spurious
        // reactive dependencies for prototype members.
        //
        // The receiver is the container, not this proxy: a prototype accessor
        // has to run against the object that actually holds the state. Every
        // `FabricInstance` keeps its state in private fields behind accessors,
        // and a private field is unreachable from a proxy that does not declare
        // it. (The receiver is immaterial for a data property, which is what
        // every prototype member of a plain object or array is, so this costs
        // those nothing.) A `FabricInstance` leafs through storage traversal
        // whole, so the read of the container already covers what an accessor
        // returns.
        if (!Object.hasOwn(value, prop) && prop in value) {
          return Reflect.get(value, prop);
        }

        const accessTx = childViewTx();
        if (readStatsActive) recordProxyAccess(accessTx);
        return createViewProxy(
          runtime,
          accessTx,
          tx,
          { ...link, path: [...link.path, prop] },
          depth + 1,
          childLabelView(cfcLabelView, String(prop)),
          pinned,
        );
      }),
    set: (_, prop) => {
      if (typeof prop === "symbol") return false;
      throw new Error(
        "This value is read-only, declare type as Writable<..> instead to get a writable version",
      );
    },
    ownKeys: () =>
      atEpoch(() => {
        const current = readTx().readValueOrThrow(link, SHAPE_READ);
        const keys = isObjectOrArray(current) || Array.isArray(current)
          ? Reflect.ownKeys(current)
          : Reflect.ownKeys(value);
        if (Array.isArray(proxyTarget)) {
          if (!keys.includes("length")) {
            // Insert `length` where a real array carries it -- after the index
            // keys, ahead of any other name -- rather than appending it.
            // Own-key order is load-bearing: a consumer can tell an index-only
            // array from one carrying named properties by asking whether
            // `length` comes last, and appending would make a named property
            // look like an index-only one. `isInertArray()` reads exactly that,
            // and fabric membership (`isValidFabricValue()`) is decided by it
            // for every array, so the order here is what makes a proxied array
            // carrying a named property fail membership instead of passing as
            // index-only.
            const firstNonIndex = keys.findIndex((key) =>
              !((typeof key === "string") && isArrayIndexPropertyName(key))
            );
            keys.splice(
              (firstNonIndex === -1) ? keys.length : firstNonIndex,
              0,
              "length",
            );
          }
          // Enumerating an array's keys (`Object.keys`/`values`/`entries`, a spread,
          // `for...in`) observes which index keys are present. For a dense array
          // that is its `length`, but an array here can be sparse (holes below
          // `length`), and filling or punching a hole changes the present-key set
          // without changing `length` — a write at `/arr/<i>` with no `/arr/length`
          // write. The SHAPE_READ above is dropped at commit as the op's incidental
          // container read, and neither a `length` read nor a nonRecursive shape
          // read at the array path conflicts with a same-length element-slot write.
          // Record a recursive (by-value) read of the array — the one read the
          // mergeable narrowing keeps that a hole edit invalidates — so an
          // enumeration-derived mergeable write conflicts and retries instead of
          // merging on a stale key set. It is marked `ignoreReadForScheduling` so it
          // adds only the conflict dependency; reactivity stays on the SHAPE_READ.
          readTx().readValueOrThrow(link, { meta: ignoreReadForScheduling });
        }
        return keys;
      }),
    getOwnPropertyDescriptor: (target, prop) =>
      atEpoch(() => {
        if (Array.isArray(target) && prop === "length") {
          const accessTx = readTx();
          if (readStatsActive) recordProxyAccess(accessTx);
          // Read the array fully (not SHAPE_READ) so the length descriptor tracks
          // element add/remove, matching the `length` get trap above. [review: ubik2]
          const current = accessTx.readValueOrThrow(link);
          return {
            configurable: false,
            enumerable: false,
            writable: true,
            value: Array.isArray(current) ? current.length : 0,
          };
        }

        // For properties that exist on the original target (e.g. array `length`),
        // delegate to the target to satisfy proxy invariants for non-configurable
        // properties.
        const targetDesc = Object.getOwnPropertyDescriptor(target, prop);
        if (targetDesc && !targetDesc.configurable) {
          return targetDesc;
        }
        if (typeof prop === "symbol") {
          return Object.getOwnPropertyDescriptor(value, prop);
        }
        const current = readTx().readValueOrThrow(
          link,
          SHAPE_READ,
        ) as typeof value;
        // `Object.hasOwn`, not `in`: this trap reports on OWN properties, and
        // `in` walks the prototype chain. Because the underlying value is an
        // ordinary `Object.prototype`-rooted record, `in` reported every member of
        // `Object.prototype` -- `toString`, `valueOf`, `constructor`, `__proto__`
        // -- as an own property of the proxy, while `ownKeys` (which uses
        // `Reflect.ownKeys`) listed none of them. Two traps describing the same
        // value disagreed by construction, so every consumer that reasons about a
        // read-back value's shape was being told it carries names it does not.
        //
        // That is not academic: `unsafeObjectKeyIn()` refuses a `FabricValue`
        // carrying own `__proto__`/`constructor` and tests with `Object.hasOwn()`,
        // so writing a read-back record back to a cell was rejected for a key the
        // record never had, and every read-modify-write against a cell failed
        // (loom CT-1949). The `has` trap below keeps `in` -- there it is correct,
        // being the `in` operator's own trap.
        if (
          (isObjectOrArray(current) || Array.isArray(current)) &&
          Object.hasOwn(current, prop)
        ) {
          const accessTx = childViewTx();
          if (readStatsActive) recordProxyAccess(accessTx);
          return {
            configurable: true,
            enumerable: true,
            writable: false,
            value: createViewProxy(
              runtime,
              accessTx,
              tx,
              { ...link, path: [...link.path, prop as string] },
              depth + 1,
              childLabelView(cfcLabelView, String(prop)),
              pinned,
            ),
          };
        }
        return undefined;
      }),
    has: (_target, prop) =>
      atEpoch(() => {
        if (typeof prop === "symbol") {
          return prop in value;
        }
        const current = readTx().readValueOrThrow(link, SHAPE_READ);
        if (isObjectOrArray(current) || Array.isArray(current)) {
          // Probing whether a numeric index is present (`n in arr`) observes the
          // array's key set: for a dense array the answer is `n < length`, but a
          // sparse array has holes, so the answer depends on whether index `n` is
          // specifically present — which a same-length hole fill or punch changes
          // with no `length` write. Record a recursive read of the array (marked
          // conflict-only, like ownKeys above) so an `n in arr`-derived mergeable
          // write conflicts and retries instead of merging on a stale key set.
          if (Array.isArray(current) && /^\d+$/.test(prop)) {
            readTx().readValueOrThrow(link, { meta: ignoreReadForScheduling });
          }
          return prop in current;
        }
        return prop in value;
      }),
    // A query-result proxy is a live, transaction-backed view: reads resolve
    // through the get trap on every access. Structural mutations (freeze, seal,
    // defineProperty, delete) cannot be honored without either corrupting the
    // backing store (when the proxy fronts the live value) or defeating live
    // resolution (a non-configurable target property forces [[Get]] to return
    // the target's own value, bypassing the trap). So we refuse them outright;
    // callers that need an immutable/structurally-edited form must snapshot the
    // proxy to a plain value first.
    preventExtensions: () => {
      throw new Error(
        "Cannot freeze or seal a live cell-result proxy; snapshot it to a " +
          "plain value first.",
      );
    },
    defineProperty: () => {
      throw new Error(
        "Cannot define properties on a live cell-result proxy; assign through " +
          "a transaction, or snapshot to a plain value first.",
      );
    },
    deleteProperty: () => {
      throw new Error(
        "Cannot delete properties on a live cell-result proxy; mutate through " +
          "a transaction, or snapshot to a plain value first.",
      );
    },
  }) as T;

  // Cache the proxy in the appropriate cache before returning
  storedValueByView.set(proxy as object, value);
  txCache.byLink.set(cacheKey, proxy);
  // Not the by-value index for a pinned view: it names a value rather than an
  // instant, so it would hand a view taken at one epoch to a reader asking at
  // another.
  if (cfcLabelView === undefined && epoch === undefined) {
    txCache.byValue.set(value, proxy);
  }
  return remember(proxy);
}

/**
 * Get cell or throw if not a cell value proxy.
 *
 * @param {any} value - The value to get the cell from.
 * @returns {Cell<T>}
 * @throws {Error} If the value is not a cell value proxy.
 */
export function getCellOrThrow<T = any>(value: any): Cell<T> {
  if (isCellResult(value)) return value[toCell]();
  else throw new Error("Value is not a cell proxy");
}

/**
 * Check if value is a cell value proxy.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isCellResult(value: any): value is CellResult<any> {
  return isObjectOrArray(value) &&
    typeof (value as Partial<BackToCellInternals>)[toCell] === "function";
}

/**
 * The stored object each view stands for, recorded when the view is built.
 *
 * A view's proxy target is an empty stub with no `getPrototypeOf` trap (the
 * marker above the proxy construction says why), so nothing about the view
 * itself -- its prototype, `instanceof`, a plain-object test -- reports the
 * class of the value behind it. The class is a fact about that value, and the
 * value is in hand where the view is built, so this records it there rather
 * than reconstructing it from the view afterwards.
 *
 * Deliberately not exported. The object is the creation-time read, and
 * reading its contents directly would bypass the view's read tracking; the
 * one question asked of it, {@link isFabricInstanceOrView}, is a class
 * question that touches no contents.
 */
const storedValueByView = new WeakMap<object, unknown>();

/**
 * Whether `value` is a `FabricInstance`, held directly or seen through a cell
 * read.
 *
 * A view over an instance has `Object.prototype` for its prototype, so
 * `instanceof FabricInstance` is `false` for it and a plain-object test takes
 * it for a record with no keys. A walk that has an answer for an instance and
 * would otherwise copy the view needs to know -- and the copy cannot even fail
 * quietly: its descriptor query meets the instance's non-configurable freeze
 * shield, which the stub target lacks, and the proxy invariant throws.
 *
 * The answer is `instanceof` of the object the view stands for, which the view
 * registry recorded at construction; the view itself is asked nothing, and no
 * storage read is made. A value that is neither an instance nor a view is not
 * one.
 *
 * TODO(danfuzz): once a view over a `FabricInstance` is perceived as one (the
 * marker above the proxy construction), this collapses to `instanceof`.
 */
export function isFabricInstanceOrView(value: unknown): boolean {
  if (value instanceof FabricInstance) return true;
  if (typeof value !== "object" || value === null) return false;
  return storedValueByView.get(value) instanceof FabricInstance;
}

/**
 * Materializes a live query-result view as detached plain arrays/objects.
 * Query proxies deliberately reject freeze/clone traps; validation and hashing
 * boundaries use this snapshot instead of retaining a transaction-backed view.
 */
export function snapshotQueryResult<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const snapshot = (current: unknown): unknown => {
    // A special object leafs through whole. It has no own properties for the
    // rebuild below to copy, so snapshotting one by its keys would return
    // `{}` and lose the value.
    //
    // TODO(danfuzz): that covers a value handed over directly and not one
    // arriving through a cell read. This function's callers pass `cell.get()`,
    // and the proxy erases the prototype, so a proxied `FabricInstance` still
    // reaches the rebuild below and snapshots as `{}`. The fix is the one the
    // marker further down this file names.
    if (!isWalkableObjectOrArray(current)) return current;
    const existing = seen.get(current);
    if (existing !== undefined) return existing;
    if (Array.isArray(current)) {
      const array: unknown[] = [];
      seen.set(current, array);
      for (let index = 0; index < current.length; index++) {
        array[index] = snapshot(current[index]);
      }
      return array;
    }
    const object: Record<string, unknown> = {};
    seen.set(current, object);
    for (const key of Object.keys(current)) {
      object[key] = snapshot((current as Record<string, unknown>)[key]);
    }
    return object;
  };
  return snapshot(value) as T;
}

/**
 * Check if value is a cell value proxy. Return as type that allows
 * dereferencing, but not using the proxy.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export function isCellResultForDereferencing(
  value: any,
): value is CellResultInternals {
  return isCellResult(value);
}

export type CellResultInternals = {
  [toCell]: () => Cell<unknown>;
};

export type CellResult<T> = T & CellResultInternals;
