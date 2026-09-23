/**
 * The schema-observing lazy view.
 *
 * Where `validateAndTransform` builds everything a schema selects in one pass,
 * a view resolves each path as the reader touches it, narrowing the schema by
 * that step. Ordinary container children remain unbuilt and untracked until
 * the reader asks for them.
 *
 * A view is reached only from a transaction marked with `markLazyMaterialize`;
 * `validateAndTransform` reads that mark and branches here after its own link
 * resolution, `asCell` dispatch and schema combination have run, so a view and
 * an eager read agree on which link and which schema they are looking at.
 *
 * ## What a view checks, and when
 *
 * At the container it is built over: the value's type against the schema's, and
 * the schema's `required` keys — that the value carries each of them, and that
 * the schema selects each one it requires. Both come off the container
 * read a view takes anyway, so neither descends.
 *
 * Everything below that is checked where the reader touches it. A subtree the
 * reader never reads is never validated — the deliberate cost of not
 * materializing what nobody wants. One shape is the exception: a combinator
 * (`anyOf`, `oneOf`, `allOf`) is decided by evaluating its subtree through the
 * eager traverser, because whether a branch matches is a question about the
 * whole branch.
 *
 * A mismatch the reader does touch surfaces at the nearest enclosing property,
 * which is where an eager read decides the same question. Under a `required`
 * property it becomes a {@link SchemaMismatchError}; under an optional one it
 * reads as `undefined`, because an eager read leaves a property whose traversal
 * fails out of the object rather than voiding it. Either way the read that
 * failed is registered first, so whatever depends on it runs again when the
 * missing data arrives. A non-null property default replaces a value the view
 * rejects at the container it is built over, before the required-property
 * decision; what fails deeper is decided where it is touched, and never by
 * evaluating the property whole.
 *
 * The root is the exception: a mismatch there yields `undefined`, which is what
 * an eager read yields for the same data, so the runner's existing
 * "argument did not resolve" gate handles it unchanged.
 */

import type { JSONSchema } from "@commonfabric/api";
import { FabricPrimitive, type FabricValue } from "@commonfabric/data-model";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { readStatsActive, recordProxyAccess } from "./read-stats.ts";
import { toCell } from "./back-to-cell.ts";
import { type Cell, createCell } from "./cell.ts";
import { ContextualFlowControl } from "./cfc.ts";
import {
  type CfcLabelView,
  rebaseCfcLabelView,
} from "./cfc/label-view-state.ts";
import { dataUriFromValueWithResolvedLinks } from "./data-uri.ts";
import { declareStreamSchema, type NormalizedFullLink } from "./link-utils.ts";
import { type Runtime } from "./runtime.ts";
import {
  createOpaqueReference,
  processDefaultValue,
  validateAndTransform,
} from "./schema.ts";
import { type IExtendedStorageTransaction } from "./storage/interface.ts";
import {
  arrayItemFallbackType,
  arrayItemUsesValueIdentity,
  getJsonType,
  getPropertyDefaultSchema,
  isOpaquePosition,
  opaqueLeafMissesRequired,
  schemaAcceptsType,
} from "./traverse.ts";

const logger = getLogger("schema-view", { enabled: false, level: "warn" });

/**
 * Thrown when a reader touches data the schema does not describe.
 *
 * The runner treats one of these as an argument that did not resolve rather
 * than as a fault: the run could not proceed on the data available, which is a
 * non-event, not a failure.
 */
export class SchemaMismatchError extends Error {
  override readonly name: string = "SchemaMismatchError";
  readonly link: NormalizedFullLink;
  readonly reason: string;

  constructor(link: NormalizedFullLink, reason: string) {
    super(
      `Schema mismatch at ${link.id}/${link.path.join("/")}: ${reason}`,
    );
    this.link = link;
    this.reason = reason;
  }
}

export function isSchemaMismatchError(
  error: unknown,
): error is SchemaMismatchError {
  return error instanceof SchemaMismatchError;
}

/**
 * The RULED unresolved-input refusal (OW51, owner ruling 2026-08-21;
 * speculation.md §2): a lazy read whose link chain dead-ended at a
 * hop-target doc the replica cannot serve (`pendingHopDoc` on the
 * resolved link — link-types.ts) refuses with one of these instead of
 * handing `undefined` into the action body. A subclass of
 * {@link SchemaMismatchError} so every existing disposal seam treats it
 * as the same non-event: the run's output is `undefined`, no action
 * failure is surfaced, and the reads registered so far re-trigger the
 * run when any of them change — the arriving doc included. Thrown by
 * the lazy branch in schema.ts; also throwable by an action body itself
 * (the ruling's "a lift can throw a specific error" clause), taking the
 * identical disposition through the same catches.
 */
export class UnresolvedInputError extends SchemaMismatchError {
  override readonly name: string = "UnresolvedInputError";

  constructor(link: NormalizedFullLink) {
    super(
      link,
      "unresolved input: the link chain dead-ends at a doc this replica " +
        "cannot serve yet",
    );
  }
}

export function isUnresolvedInputError(
  error: unknown,
): error is UnresolvedInputError {
  return error instanceof UnresolvedInputError;
}

// `schemaAtPath` reports a property the schema does not select by handing back
// one of these instead of a subschema, so a view can tell "not selected" from
// "selected as anything". An eager read drops such a property; so does a view.
const EXCLUDED_EMPTY: JSONSchema = Object.freeze({
  $comment: "emptyProperties",
});
const EXCLUDED_MISSING: JSONSchema = Object.freeze({
  $comment: "missingProperty",
});

/**
 * A property the schema turns down: declared as the `false` schema, or left
 * unnamed by a schema that refuses the properties it does not name.
 *
 * Neither matches any value, so such a property contributes nothing to a read,
 * and the answer has to come off the schema rather than out of a failed read:
 * writing `false` is how a selection asks for a link's address without the
 * document behind it, and reading first would resolve the link and fetch the
 * document the `false` was there to avoid.
 *
 * This is its own marker because `schemaAtPath` also returns `false` where
 * the schema has turned nothing down: for a declared type that holds no
 * children, and for an `allOf`, which it does not read a child out of while
 * the subschema is still reachable below.
 */
const EXCLUDED_REJECTED: JSONSchema = Object.freeze({
  $comment: "rejectedProperty",
});

const isExcluded = (schema: JSONSchema): boolean =>
  isObjectOrArray(schema) &&
  (schema.$comment === "emptyProperties" ||
    schema.$comment === "missingProperty" ||
    schema.$comment === "rejectedProperty");

/**
 * Whether an excluded property is one the schema turned down on purpose, as
 * {@link EXCLUDED_REJECTED} describes, and not one it merely leaves unnamed.
 */
const isTurnedDown = (schema: JSONSchema): boolean =>
  isObjectOrArray(schema) && schema.$comment === "rejectedProperty";

/**
 * Keys JavaScript itself probes on any object it is handed — promise adoption
 * reads `then`, `JSON.stringify` reads `toJSON` — so a read of one says
 * nothing about what the reader's body asked for.
 */
const MACHINERY_PROBED_KEYS: ReadonlySet<string> = new Set(["then", "toJSON"]);

const requiredKeys = (schema: JSONSchema | undefined): readonly string[] =>
  isObjectOrArray(schema) && Array.isArray(schema.required)
    ? schema.required as string[]
    : [];

/**
 * The schema of `key` under `schema`, narrowed for the `container` the view
 * holds. A schema that declares no `type` is settled to that container first
 * (`ContextualFlowControl.settledForContainer`): narrowing without a value
 * reads it as the union of the readings it offers, and a view has the value
 * in hand.
 */
const childSchema = (
  schema: JSONSchema | undefined,
  key: string,
  container: "object" | "array",
): JSONSchema => {
  if (schema === undefined) return true;
  const narrowed = ContextualFlowControl.schemaAtPath(
    ContextualFlowControl.settledForContainer(schema, container),
    [key],
    undefined,
    EXCLUDED_EMPTY,
    EXCLUDED_MISSING,
  );
  if (narrowed !== false || !isObjectOrArray(schema)) {
    return narrowed;
  }
  // `schemaAtPath` narrows to `false` where the schema turns the child down —
  // a property declared `false`, or a key left unnamed by a schema that
  // refuses the properties it does not name — and where the schema's declared
  // type holds no children at all. The first two are deliberate absences,
  // settled off the schema: the child is absent to a reader, and the link
  // under it is never followed. Without `additionalProperties`, a schema that
  // names some properties reaches `schemaAtPath` as a missing property rather
  // than as `false`, and an eager read drops the property either way.
  //
  // A schema that names no properties and carries `allOf` parts has turned
  // nothing down: an eager read merges the keywords beside an `allOf` into
  // each part before it looks at a key, so a part can name this one. An
  // `allOf` holding no parts names nothing, and an eager read passes over it.
  if (
    isObjectOrArray(schema.properties) &&
    Object.hasOwn(schema.properties, key) &&
    (schema.properties as Record<string, JSONSchema>)[key] === false
  ) {
    return EXCLUDED_REJECTED;
  }
  if (
    schema.additionalProperties === false &&
    (isObjectOrArray(schema.properties) || !schema.allOf?.length)
  ) {
    return EXCLUDED_REJECTED;
  }
  // What remains is a type that holds no children, and an eager read selects
  // nothing there either: the child reads as absent.
  return false;
};

const declaredDefault = (schema: JSONSchema): FabricValue | undefined => {
  if (!isObjectOrArray(schema)) return undefined;
  const resolved = ContextualFlowControl.resolveSchemaRefs(schema);
  return isObjectOrArray(resolved)
    ? resolved.default as FabricValue | undefined
    : undefined;
};

/**
 * Returns the schema's own default after resolving its root reference.
 * Defaults inside combinator branches are decided by traversal of those
 * branches and do not supply a top-level fallback here.
 */
export const defaultForAbsentValue = (
  schema: JSONSchema | undefined,
): FabricValue | undefined =>
  isObjectOrArray(schema) ? declaredDefault(schema) : undefined;

/**
 * Build a view over `value` at `link`, or report that the data does not match.
 *
 * `link.schema` is the effective schema the caller has already combined from
 * the reader's shape and the link's own. `value` is the container read at that
 * link, which the caller has already taken.
 *
 * The view describes the instant it is built at: the keys `value` carried, an
 * array's length and iteration order, and every value below, which resolve
 * against the epoch taken here rather than against whatever the reader writes
 * afterwards. Taking the read again is what fixes a later instant.
 *
 * At the root a mismatch is `undefined` — the answer an eager read gives for
 * the same data. Below it, a mismatch throws.
 */
export function materializeSchemaView(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  value: FabricValue,
  cfcLabelView: CfcLabelView | undefined,
  synced: boolean,
  isRoot: boolean,
): unknown {
  const mismatch = (reason: string): undefined => {
    // Register the read that failed before doing anything else. A refusal has
    // to leave behind the dependency that re-triggers the reader when the data
    // it wanted arrives; `noteSchemaRefusal` records the error, not the read.
    // Recursive, because what failed is a value the reader asked for.
    tx.readValueOrThrow(link);
    if (isRoot) return undefined;
    const refusal = new SchemaMismatchError(link, reason);
    // Record as well as throw: a reader can catch this and carry on, and the
    // run still has to be disposed of as an argument that did not resolve.
    tx.noteSchemaRefusal(refusal);
    throw refusal;
  };

  // An absent value takes the schema's own default before type validation.
  if (value === undefined) {
    const fallback = defaultForAbsentValue(link.schema);
    if (fallback !== undefined) {
      // Register the read the default is standing in for. The value was taken
      // without telling the scheduler, so without this the reader holds no
      // dependency on the path it just found empty and never runs again when it
      // fills — a computed that has not produced yet would read as its default
      // forever. Recursive: anything arriving at or below this path changes the
      // answer.
      tx.readValueOrThrow(link);
      return processDefaultValue(
        runtime,
        tx,
        link,
        fallback,
        synced,
        cfcLabelView,
      );
    }
  }

  const schema = link.schema;
  if (schema === false) {
    return mismatch("the schema rejects this value");
  }

  const actualType = getJsonType(value);
  if (
    schema !== undefined && actualType !== null &&
    !schemaAcceptsType(schema, actualType)
  ) {
    return mismatch(`schema does not accept ${actualType}`);
  }

  // An opaque leaf still owes the schema's `required` keys. A `FabricPrimitive`
  // supplies them through class accessors — `FabricBytes.length` satisfies
  // `required: ["length"]` — so the check is prototype-chain membership with
  // the brand exemption, which is what an eager read applies before letting one
  // through.
  if (value instanceof FabricPrimitive && isObjectOrArray(schema)) {
    if (opaqueLeafMissesRequired(schema, value)) {
      return mismatch("opaque leaf is missing a required property");
    }
  }

  // An opaque (`type: "unknown"`) position answers presence and stops, the way
  // traversal does, instead of viewing what is behind it. Same predicate and
  // same projection, so a reader cannot tell which path answered.
  if (
    value !== undefined && schema !== undefined &&
    actualType !== null && isOpaquePosition(schema, actualType)
  ) {
    tx.readValueOrThrow(link, { nonRecursive: true });
    return createOpaqueReference(runtime, link, tx, synced, cfcLabelView);
  }

  // A primitive, and a `FabricPrimitive` with it, is a leaf: the type check
  // above is the whole of what a schema says about it.
  if (!isObjectOrArray(value) || value instanceof FabricPrimitive) {
    // The caller read this document without telling the scheduler — the eager
    // traverser registers its own reads as it walks, and so does a view. Same
    // granularity it uses: non-recursive, which a write at this path still
    // invalidates, and which keeps a view's read set comparable to an eager
    // one's when both are measured against a declared scope envelope.
    tx.readValueOrThrow(link, { nonRecursive: true });
    return value;
  }

  // A container's shape is what the view observed to build itself; what is
  // inside it is registered when the reader touches it. Non-recursive, so a
  // write below this path does not re-trigger a reader that never looked.
  tx.readValueOrThrow(link, { nonRecursive: true });

  const viewLink: NormalizedFullLink = { ...link, schema };

  // The instant this view describes. Taken even where the transaction has not
  // written yet — that is the ordinary case, and it is the asking that puts a
  // later write on notice to keep the root it displaces.
  const epoch = tx.issueReadEpoch();

  if (Array.isArray(value)) {
    return createArrayView(
      runtime,
      tx,
      viewLink,
      value,
      cfcLabelView,
      synced,
      epoch,
    );
  }

  for (const key of requiredKeys(schema)) {
    const narrowed = childSchema(schema, key, "object");
    if (!Object.hasOwn(value, key)) {
      // A declared default stands in for an absent required key, exactly as it
      // does for an eager read, and so does a declared stream: its handle is
      // minted from the schema alone.
      if (
        getPropertyDefaultSchema(schema, key) !== undefined ||
        ContextualFlowControl.declaresStream(narrowed)
      ) continue;
      return mismatch(`missing required property ${JSON.stringify(key)}`);
    }
    // A required property the schema does not select cannot be satisfied while
    // the data carries it: nothing reaches the filtered result at that key, and
    // `required` says the result has to hold it. An eager read voids the whole
    // object here rather than dropping the property, which is what it does for
    // the same schema on an optional one.
    if (isExcluded(narrowed)) {
      return mismatch(
        `required property ${JSON.stringify(key)} is not selected`,
      );
    }
  }

  return createObjectView(
    runtime,
    tx,
    viewLink,
    value,
    cfcLabelView,
    synced,
    epoch,
  );
}

/**
 * The keys a reader sees: the data's own keys the schema selects, plus any
 * declared property that is absent but carries a default or declares a
 * stream.
 */
const visibleKeys = (
  schema: JSONSchema | undefined,
  value: Record<string, FabricValue>,
): string[] => {
  const keys = Object.keys(value).filter((key) =>
    !isExcluded(childSchema(schema, key, "object"))
  );
  if (isObjectOrArray(schema) && isObjectOrArray(schema.properties)) {
    for (const key of Object.keys(schema.properties)) {
      if (Object.hasOwn(value, key)) continue;
      if (
        getPropertyDefaultSchema(schema, key) === undefined &&
        !ContextualFlowControl.declaresStream(
          childSchema(schema, key, "object"),
        )
      ) continue;
      keys.push(key);
    }
  }
  return keys;
};

const readChild = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  key: string,
  schema: JSONSchema,
  cfcLabelView: CfcLabelView | undefined,
  synced: boolean,
): unknown => {
  const childLink: NormalizedFullLink = {
    ...link,
    path: [...link.path, key],
    schema,
  };
  return readChildAt(runtime, tx, childLink, [key], cfcLabelView, synced);
};

/**
 * Read a child whose link the caller has already built.
 *
 * `readChild` addresses a child by the key under its parent; an array element
 * that is an inline object is addressed by its own value instead, so it needs
 * this.
 */
const readChildAt = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  childLink: NormalizedFullLink,
  labelPath: readonly string[],
  cfcLabelView: CfcLabelView | undefined,
  synced: boolean,
): unknown => {
  // Back through the front door: link resolution, `asCell` dispatch and schema
  // combination all belong there, and a marked transaction lands back here for
  // whatever the child turns out to be. `mismatchThrows` is what makes a
  // mismatch below the root a refusal rather than an `undefined` the reader
  // cannot tell from an absent value.
  return validateAndTransform(
    runtime,
    tx,
    {
      link: childLink,
      cfcLabelView: rebaseCfcLabelView(cfcLabelView, [...labelPath]),
    },
    [],
    { synced, mismatchThrows: true, viewChild: true },
  );
};

/**
 * What a property reads as when the schema does not describe it.
 *
 * An eager read leaves such a property out of the object it filters, and
 * `undefined` is a value a property can legitimately hold, so the two cannot
 * share a return. A view returns `undefined` for a plain property access either
 * way — that is what reading an absent property gives — and uses this to keep
 * enumeration and `in` agreeing with an eager read about which keys exist.
 */
const ABSENT: unique symbol = Symbol("absent");

const refuseMutation = (what: string): never => {
  throw new Error(
    `Cannot ${what} a schema view; it is a read, not a value you own. ` +
      "Snapshot it first, or write through the cell.",
  );
};

function createObjectView(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  value: Record<string, FabricValue>,
  cfcLabelView: CfcLabelView | undefined,
  synced: boolean,
  epoch: number | undefined,
): unknown {
  const schema = link.schema;
  const required = new Set(requiredKeys(schema));
  const resolveChild = (key: string): unknown => {
    const narrowed = childSchema(schema, key, "object");
    if (isExcluded(narrowed)) {
      // The data carries this key and the schema does not select it, so the
      // reader gets the `undefined` an absent key gives, and nothing at the
      // read says a field was there. A reader in that position has a schema
      // that selects less than its body reads: one written by hand narrower
      // than the code, or an input schema shrunk past a read the capability
      // analysis did not see. The read is counted under a key of its own; the
      // pattern test runner fails a test on any warning a run counts, unless
      // the test allows console warnings. A key the schema turned down on
      // purpose is a deliberate absence, and is not counted.
      if (
        !isTurnedDown(narrowed) && Object.hasOwn(value, key) &&
        !MACHINERY_PROBED_KEYS.has(key)
      ) {
        logger.warn(
          "unselected-key-read",
          () => [
            `Read of \`${key}\` at ${link.id}/${link.path.join("/")}: the ` +
            "data carries the key and the schema does not select it, so it " +
            "reads as `undefined`.",
          ],
        );
      }
      return undefined;
    }
    const defaultSchema = getPropertyDefaultSchema(schema, key);
    const applyDefault = () =>
      defaultSchema === undefined ? undefined : processDefaultValue(
        runtime,
        tx,
        { ...link, path: [...link.path, key], schema: defaultSchema },
        defaultSchema.default as FabricValue,
        synced,
        rebaseCfcLabelView(cfcLabelView, [key]),
      );
    if (!Object.hasOwn(value, key)) {
      // Register the read even though there is nothing there. An absent key is
      // usually a computed that has not produced yet, and the reader has to run
      // again when it does — a container read alone does not carry that, since
      // the value arrives at the child's own path. This is the same obligation
      // a refusal carries, for the case that is not a refusal: the schema does
      // not require this key, so reading it is an ordinary miss, not a mismatch.
      tx.readValueOrThrow({ ...link, path: [...link.path, key] });
      // A declared stream's handle is minted from the schema alone, whether or
      // not the data names the key. The declaration is restated at the
      // schema's root, as the eager read restates it, since a union or a
      // reference that declares it has no value here for its branches to be
      // read against.
      if (ContextualFlowControl.declaresStream(narrowed)) {
        return readChild(
          runtime,
          tx,
          link,
          key,
          declareStreamSchema(narrowed),
          cfcLabelView,
          synced,
        );
      }
      return applyDefault();
    }
    try {
      // What arrives here is the child's own verdict: the container-level
      // check a view makes when it is built, or a combinator's whole-branch
      // evaluation. A mismatch deeper inside a child view is not decided here;
      // it surfaces where the reader touches it.
      return readChild(runtime, tx, link, key, narrowed, cfcLabelView, synced);
    } catch (error) {
      if (!isSchemaMismatchError(error)) throw error;
      // A child can dead-end at a doc the replica cannot serve — inside a
      // combinator evaluated whole, or at its own target. Nothing in it is
      // known to be invalid, so nothing may be published in its place: a
      // declared default is refused rather than stood in, and a required
      // property refuses below. A property with neither reads as absent, as
      // an eager read reads it, with the dead-end's read registered by the
      // entry point so the reader runs again when the document arrives. The
      // property's own dead-end never arrives here with a default declared:
      // the entry point stands the default in before it can refuse.
      if (defaultSchema !== undefined && isUnresolvedInputError(error)) {
        throw error;
      }
      if (defaultSchema !== undefined) {
        const fallback = applyDefault();
        if (fallback !== undefined) {
          tx.clearSchemaRefusal(error);
          return fallback;
        }
      }
      if (required.has(key)) throw error;
      tx.clearSchemaRefusal(error);
      return ABSENT;
    }
  };

  // Every read this view takes goes through here, so this is where it steps
  // into the instant it describes. Before the transaction's first write there
  // is nothing to step into — every epoch names the same root — so the common
  // case checks the accounting flag and the read epoch. Entered by hand rather than around a
  // callback: a reader walking a large value touches this per property, and a
  // callback would allocate a closure each time.
  const childOrAbsent = (key: string): unknown => {
    if (readStatsActive) recordProxyAccess(tx);
    if (!tx.hasWrites()) return resolveChild(key);
    const previous = tx.enterReadEpoch(epoch);
    try {
      return resolveChild(key);
    } finally {
      tx.exitReadEpoch(previous);
    }
  };

  const child = (key: string): unknown => {
    const result = childOrAbsent(key);
    return result === ABSENT ? undefined : result;
  };

  return new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      // See the same guard in `query-result-proxy.ts`: promise adoption probes
      // `then`, and a view that refuses the probe cannot be returned from a
      // lift at all.
      if (prop === "then" && tx.status().status !== "ready") return undefined;
      if (typeof prop === "symbol") {
        if (prop === toCell) {
          return (): Cell<unknown> =>
            createCell(runtime, link, tx, synced, undefined, cfcLabelView);
        }
        return Reflect.get(value, prop);
      }
      return child(prop);
    },
    // `ownKeys` stays cheap — listing the keys must not read every value. The
    // proxy target is an extensible object with no own properties, so a key
    // listed here whose descriptor comes back `undefined` is simply not there
    // as far as `Object.keys`, a spread, `for...in` and `JSON.stringify` are
    // concerned; each of them asks for the descriptor before believing the key.
    ownKeys: () => visibleKeys(schema, value),
    getOwnPropertyDescriptor: (_target, prop) => {
      if (typeof prop === "symbol") return undefined;
      if (!visibleKeys(schema, value).includes(prop)) return undefined;
      const value_ = childOrAbsent(prop);
      if (value_ === ABSENT) return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: value_,
      };
    },
    has: (_target, prop) =>
      typeof prop === "symbol"
        ? prop in value
        : visibleKeys(schema, value).includes(prop) &&
          childOrAbsent(prop) !== ABSENT,
    set: () => refuseMutation("assign to"),
    deleteProperty: () => refuseMutation("delete from"),
    defineProperty: () => refuseMutation("define properties on"),
    preventExtensions: () => refuseMutation("freeze or seal"),
  });
}

function createArrayView(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  value: FabricValue[],
  cfcLabelView: CfcLabelView | undefined,
  synced: boolean,
  epoch: number | undefined,
): unknown {
  const schema = link.schema;
  const resolveElement = (index: number): unknown => {
    const key = String(index);
    const item = value[index];
    const itemSchema = childSchema(schema, key, "array");
    const slotLink: NormalizedFullLink = {
      ...link,
      path: [...link.path, key],
      schema: itemSchema,
    };
    // An inline element that is a container — an object, or a nested array —
    // takes its identity from its own value, not from the slot it sits in.
    // `toCell` on `xs[0]` would otherwise hand back a link to INDEX 0 of this
    // array: write that anywhere and it names whatever lands there next rather
    // than this element. Eager traversal rebases the same elements onto a
    // `data:` URI, and the value is already in hand here, so the identity
    // costs no read. An element that is itself a link already carries its own
    // identity, and an `asCell` item is a handle whose link is the point of
    // it; `arrayItemUsesValueIdentity` is the one predicate both paths apply.
    if (arrayItemUsesValueIdentity(item, itemSchema)) {
      // The read still belongs to the slot, and recursively: the identity is
      // derived from the whole element value, so anything inside it changing
      // changes what the reader was handed. Rebasing onto the URI moves where
      // the value is READ FROM, not what the reader depends on — without this
      // the element's own document is all that is registered, and a write into
      // the array never reaches the reader.
      tx.readValueOrThrow(slotLink);
      return readChildAt(
        runtime,
        tx,
        {
          ...slotLink,
          id: dataUriFromValueWithResolvedLinks(item, slotLink),
          path: [],
        },
        [key],
        cfcLabelView,
        synced,
      );
    }
    return readChildAt(runtime, tx, slotLink, [key], cfcLabelView, synced);
  };

  // The array's counterpart to the object view's gate: every element read steps
  // into the instant this view describes, and skips the step entirely until the
  // transaction has written. See the note there for why it is entered by hand.
  const element = (index: number): unknown => {
    if (readStatsActive) recordProxyAccess(tx);
    const hasWrites = tx.hasWrites();
    const previous = hasWrites ? tx.enterReadEpoch(epoch) : undefined;
    try {
      return resolveElement(index);
    } catch (error) {
      if (!isSchemaMismatchError(error)) throw error;
      // An unavailable hop target has no value to validate or substitute yet,
      // whether it is the slot's own or one inside a combinator item evaluated
      // whole. A substitute answers only for the element's own verdict: the
      // container-level check of its view, or a combinator's evaluation. What
      // fails deeper inside an element view is decided where it is touched.
      if (isUnresolvedInputError(error)) throw error;
      const fallbackType = arrayItemFallbackType(
        childSchema(schema, String(index), "array"),
      );
      if (fallbackType === undefined) throw error;
      tx.clearSchemaRefusal(error);
      return fallbackType === "null" ? null : undefined;
    } finally {
      if (hasWrites) tx.exitReadEpoch(previous);
    }
  };

  // A read-only array method runs against element views built on demand. The
  // methods that would reshape the array are absent: a view is a read.
  //
  // Every element is visited even once one has failed. An eager read walks the
  // whole array before it decides the array invalid, registering each element's
  // read on the way; stopping at the first failure would leave a reader
  // depending on one element where the eager path had it depending on all of
  // them, and nothing would wake it when the rest arrived. The first refusal is
  // the one that surfaces — the others are the view's own, and are cleared so
  // they do not outlive the call that provoked them.
  const materialize = (): unknown[] => {
    const copy = new Array<unknown>(value.length);
    let refusal: SchemaMismatchError | undefined;
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) continue;
      try {
        copy[index] = element(index);
      } catch (error) {
        if (!isSchemaMismatchError(error)) throw error;
        if (refusal === undefined) refusal = error;
        else tx.clearSchemaRefusal(error);
      }
    }
    if (refusal !== undefined) throw refusal;
    return copy;
  };

  return new Proxy(new Array(value.length), {
    get: (_target, prop, receiver) => {
      if (prop === "then" && tx.status().status !== "ready") return undefined;
      if (prop === "length") {
        if (readStatsActive) recordProxyAccess(tx);
        return value.length;
      }
      if (typeof prop === "symbol") {
        if (prop === toCell) {
          return (): Cell<unknown> =>
            createCell(runtime, link, tx, synced, undefined, cfcLabelView);
        }
        if (prop === Symbol.iterator) {
          return function* () {
            for (let index = 0; index < value.length; index++) {
              yield element(index);
            }
          };
        }
        return Reflect.get(value, prop);
      }
      if (isArrayIndexPropertyName(prop)) {
        const index = Number(prop);
        if (index in value) return element(index);
        if (readStatsActive) recordProxyAccess(tx);
        return undefined;
      }
      const method = Reflect.get(Array.prototype, prop, receiver);
      if (typeof method !== "function") return method;
      if (!READ_ONLY_ARRAY_METHODS.has(prop)) {
        return () => refuseMutation(`call ${prop}() on`);
      }
      return (...args: unknown[]) =>
        (method as (...a: unknown[]) => unknown).apply(materialize(), args);
    },
    ownKeys: () => {
      // Enumeration (`Object.keys`, a spread, `for...in`) has to see the same
      // indices `getOwnPropertyDescriptor` reports as present, or a view reads
      // as an empty array to every consumer that enumerates it.
      const keys = Object.keys(value).filter(isArrayIndexPropertyName);
      keys.push("length");
      return keys;
    },
    getOwnPropertyDescriptor: (target, prop) => {
      if (prop === "length") {
        if (readStatsActive) recordProxyAccess(tx);
        return Object.getOwnPropertyDescriptor(target, "length");
      }
      if (typeof prop === "symbol" || !isArrayIndexPropertyName(prop)) {
        return undefined;
      }
      const index = Number(prop);
      if (!(index in value)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: element(index),
      };
    },
    has: (_target, prop) =>
      typeof prop === "symbol"
        ? prop in value
        : prop === "length" || prop in value,
    set: () => refuseMutation("assign to"),
    deleteProperty: () => refuseMutation("delete from"),
    defineProperty: () => refuseMutation("define properties on"),
    preventExtensions: () => refuseMutation("freeze or seal"),
  });
}

const READ_ONLY_ARRAY_METHODS = new Set<string>([
  "at",
  "concat",
  "entries",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "slice",
  "some",
  "toLocaleString",
  "toReversed",
  "toSorted",
  "toSpliced",
  "toString",
  "values",
  "with",
]);
