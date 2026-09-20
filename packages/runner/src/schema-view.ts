/**
 * The schema-observing lazy view.
 *
 * Where `validateAndTransform` builds everything a schema selects in one pass,
 * a view resolves each path as the reader touches it, narrowing the schema by
 * that step. What the reader never asks for is never built, never link-resolved
 * and never registered as a reactive dependency.
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
 * materializing what nobody wants.
 *
 * A mismatch the reader does touch surfaces at the nearest enclosing property,
 * which is where an eager read decides the same question. Under a `required`
 * property it becomes a {@link SchemaMismatchError}; under an optional one it
 * reads as `undefined`, because an eager read leaves a property whose traversal
 * fails out of the object rather than voiding it. Either way the read that
 * failed is registered first, so whatever depends on it runs again when the
 * missing data arrives.
 *
 * The root is the exception: a mismatch there yields `undefined`, which is what
 * an eager read yields for the same data, so the runner's existing
 * "argument did not resolve" gate handles it unchanged.
 */

import type {
  JSONSchema,
  JSONSchemaObj,
  JSONSchemaTypes,
} from "@commonfabric/api";
import { FabricPrimitive } from "@commonfabric/data-model";
import type { FabricValue } from "@commonfabric/data-model";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { readStatsActive, recordProxyAccess } from "./read-stats.ts";
import { toCell } from "./back-to-cell.ts";
import { type Cell, createCell } from "./cell.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { cfcSchemaWithInheritedDefs } from "./cfc/schema-refs.ts";
import {
  type CfcLabelView,
  rebaseCfcLabelView,
} from "./cfc/label-view-state.ts";
import { dataUriFromValueWithResolvedLinks } from "./data-uri.ts";
import {
  isSigilLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import { type Runtime } from "./runtime.ts";
import {
  createOpaqueReference,
  processDefaultValue,
  validateAndTransform,
} from "./schema.ts";
import { type IExtendedStorageTransaction } from "./storage/interface.ts";
import {
  canBranchMatch,
  combineSchema,
  isOpaquePosition,
  mergeAnyOfBranchSchemas,
  opaqueLeafMissesRequired,
  SchemaObjectTraverser,
  schemaTypeMatchesValueType,
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
 * This is its own marker because `schemaAtPath` also returns `false` for a
 * shape it cannot read a child out of — an `allOf`, or an object schema that
 * omits `type` — where the schema has turned nothing down and the subschema is
 * still reachable below.
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

/**
 * The type name a schema's `type` keyword would use for this value.
 *
 * A `FabricPrimitive` returns its own concrete name (`FabricBytes` and the
 * rest), which is what a schema selecting one declares; `schemaTypeMatchesValueType`
 * still lets an `object` schema accept it through its subtype rule.
 */
const jsonTypeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof FabricPrimitive) {
    return value.schemaType;
  }
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "string":
      return "string";
    default:
      return "object";
  }
};

const typeAccepts = (declared: unknown, actual: string): boolean => {
  const types = Array.isArray(declared) ? declared : [declared];
  return types.some((type) =>
    type === "unknown" ||
    // The same matcher eager traversal uses, so a `FabricBytes` value is
    // accepted both by its own type name and by an `object` schema, and a
    // "number" schema accepts an integer while "integer" refuses a fraction.
    schemaTypeMatchesValueType(
      type as JSONSchemaTypes,
      actual as JSONSchemaTypes,
    )
  );
};

/**
 * The branch a union narrowed to, carrying the union's own keywords.
 *
 * A union sits inside a schema that constrains the value as well: its
 * `properties`, `required` and `default` apply to whichever branch matches. A
 * branch alone therefore accepts values the schema rejects — an outer
 * `properties.radius.type: "number"` beside a branch that only requires
 * `radius` would let `{ radius: "bad" }` through, where an eager read drops the
 * property. Eager traversal evaluates each branch against the schema around it;
 * combining here is that rule, decided on the schema instead of the value.
 *
 * The union's `$defs` ride along, over whatever the combination kept: a
 * branch is routinely a `$ref` into them, and the schema it resolves to can
 * hold further refs — `RenderNode` refers to itself — which have nowhere to
 * point once the definitions are gone. A name the branch carried of its own
 * yields to the union's, which is the definition the ref named all along;
 * names only the branch carries — a resolved view's namespaced ref-site
 * definitions — stay.
 */
const branchWithOuter = (
  schema: JSONSchemaObj,
  branch: JSONSchema,
): JSONSchema => {
  const { anyOf: _anyOf, oneOf: _oneOf, ...outer } = schema;
  const combined = combineSchema(outer as JSONSchemaObj, branch);
  if (!isObjectOrArray(combined) || !isObjectOrArray(schema.$defs)) {
    return combined;
  }
  return {
    ...combined as JSONSchemaObj,
    $defs: {
      ...(isObjectOrArray(combined.$defs) ? combined.$defs : {}),
      ...schema.$defs,
    },
  };
};

/**
 * Collapse a union onto a branch that declares `asCell`, when one does.
 *
 * An optional handle — `Cell<T> | undefined` — generates as a union whose one
 * branch carries the marker and whose other is the absent case. `hasAsCell`
 * holds for a union only when EVERY branch declares one, so that shape reads
 * as "not a cell" and the reader gets a plain value where the pattern declared
 * a handle. An eager read survives it by evaluating every branch and picking
 * the cell among the results (`mergeMatches`); collapsing to the branch is the
 * same answer, decided on the schema instead.
 */
const preferAsCellBranch = (
  schema: JSONSchema,
  stored?: unknown,
): JSONSchema => {
  if (!isObjectOrArray(schema)) return schema;
  const branches = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(branches)) return schema;
  const resolved = branches.map((branch) => resolveBranch(branch, schema));
  return ontoHandleBranch(schema, resolved, stored) ?? schema;
};

/**
 * `schema` collapsed onto the one of `branches` that declares a handle, or
 * `undefined` when none does.
 *
 * The first such branch, unless what is stored at the position says
 * otherwise. A view node's prop offers both a `cell` and a `stream`, a stream
 * is declared by the link that names it, and a reader asking for a plain cell
 * there is a mismatch, so committing to the `cell` branch on the schema alone
 * would refuse a stream the union allows. `stored` is the value at the
 * position before any link is followed: when it is a link that declares a
 * stream, the branch that declares one is the branch that applies. An eager
 * read reaches the same answer by evaluating every branch.
 */
const ontoHandleBranch = (
  schema: JSONSchemaObj,
  branches: readonly JSONSchema[],
  stored: unknown,
): JSONSchema | undefined => {
  const handles = branches.filter((branch) =>
    ContextualFlowControl.getAsCellValues(branch).length > 0
  );
  if (handles.length === 0) return undefined;
  const namesStream = isSigilLink(stored) &&
    ContextualFlowControl.declaresStream(parseLink(stored)?.schema);
  const chosen = namesStream
    ? handles.find((branch) => ContextualFlowControl.declaresStream(branch))
    : undefined;
  return branchWithOuter(schema, chosen ?? handles[0]);
};

/**
 * A branch with its `$ref` resolved against the union's `$defs`, which take
 * the place of any the branch declares of its own; a union declaring none
 * leaves the branch to resolve as the document it is.
 *
 * A branch that will not resolve narrows to `false` — nothing matches it. It
 * cannot be left as it was: a bare `$ref` declares no `type` and no `required`,
 * so it survives matching, becomes the narrowed schema, and then throws out of
 * `schemaAtPath` the moment the reader touches a property — a raw error, not
 * the refusal the runner knows how to dispose of. Failing the branch closed is
 * also where the eager path lands: its prefilter defers ("we'll properly
 * complain later" in `canBranchMatch`) and traversal then fails the branch it
 * cannot resolve. A view has no later, so it decides here.
 */
const resolveBranch = (
  branch: JSONSchema,
  parent: JSONSchemaObj,
): JSONSchema => {
  if (!isObjectOrArray(branch) || !("$ref" in branch)) return branch;
  try {
    const resolved = ContextualFlowControl.resolveSchemaRefsOrThrow(
      cfcSchemaWithInheritedDefs(branch, parent.$defs) as JSONSchemaObj,
    );
    // A boolean target is a resolution, not a failure to resolve: `true`
    // matches everything and `false` matches nothing, which is what the
    // definition said. The resolver throws rather than returning a boolean for
    // a ref it cannot resolve.
    if (isObjectOrArray(resolved) || typeof resolved === "boolean") {
      return resolved;
    }
  } catch {
    // The warning below covers a ref that does not resolve.
  }
  // Worth saying out loud: an unresolvable ref means a schema document that
  // did not replicate, not data that happens not to match.
  logger.warn(
    "schema-view",
    () => ["unresolvable $ref in a union branch", branch],
  );
  return false;
};

/**
 * Narrow a union against the value in front of it.
 *
 * `canBranchMatch` is a shallow prefilter — type plus required-key presence,
 * no descent — so this stays a decision about the container already read. One
 * surviving branch narrows to it; several merge the way an eager read merges
 * them; none is a mismatch.
 */
const narrowForValue = (
  schema: JSONSchema | undefined,
  value: FabricValue,
): JSONSchema | undefined => {
  if (!isObjectOrArray(schema)) return schema;
  const rawBranches = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(rawBranches) || rawBranches.length === 0) return schema;
  // Resolve `$ref` branches against this schema's `$defs`. A branch
  // written as a bare `$ref` carries no `type`, no `required` and no `asCell`,
  // so matching it decides nothing: every branch survives, the union never
  // narrows, and whatever the branches declared — including a property the
  // pattern declared as a `Cell` — is unreachable. `canBranchMatch` resolves a
  // ref on its own but has no `$defs` to resolve it against, which is where the
  // "Unresolved $ref in schema" warnings come from.
  const branches = rawBranches.map((branch) => resolveBranch(branch, schema));
  const matching = branches.filter((branch) => canBranchMatch(branch, value));
  if (matching.length === 0) return false;
  if (matching.length === 1) return branchWithOuter(schema, matching[0]);
  // Prefer a branch that declares `asCell`. An eager read evaluates every
  // matching branch and picks the cell among the results (`mergeMatches`);
  // merging the SCHEMAS instead leaves the marker off the merged top level, so
  // a property the pattern declared as a `Cell` — `authorProfile: ProfileCell`
  // on a message union — comes back as a plain value and `.get()` is not a
  // function. Preferring the branch keeps the two reads agreeing.
  return ontoHandleBranch(schema, matching, value) ??
    mergeAnyOfBranchSchemas(matching as JSONSchema[], schema) ?? schema;
};

const requiredKeys = (schema: JSONSchema | undefined): readonly string[] =>
  isObjectOrArray(schema) && Array.isArray(schema.required)
    ? schema.required as string[]
    : [];

const childSchema = (
  schema: JSONSchema | undefined,
  key: string,
  // What is stored at `key`, before any link is followed; a union of handle
  // kinds is settled by it (`ontoHandleBranch`).
  stored?: unknown,
): JSONSchema => {
  if (schema === undefined) return true;
  const narrowed = ContextualFlowControl.schemaAtPath(
    schema,
    [key],
    undefined,
    EXCLUDED_EMPTY,
    EXCLUDED_MISSING,
  );
  if (narrowed !== false || !isObjectOrArray(schema)) {
    return preferAsCellBranch(narrowed, stored);
  }
  // `schemaAtPath` decides which children exist from the schema's `type`, so a
  // schema that declares `properties` or `items` and omits `type` narrows to
  // `false` — no child selected. An eager read reaches those children, and the
  // subschema is right there, so read it directly rather than refuse. Losing it
  // costs more than a refusal: the child's `asCell` marker goes with it, and
  // the reader gets a plain view where the pattern declared a `Cell`.
  if (
    isObjectOrArray(schema.properties) && Object.hasOwn(schema.properties, key)
  ) {
    const declared = (schema.properties as Record<string, JSONSchema>)[key];
    // Except where the subschema is `false`, which turns the child down rather
    // than describing one to read through.
    return declared === false ? EXCLUDED_REJECTED : declared;
  }
  if (isArrayIndexPropertyName(key) && schema.items !== undefined) {
    return schema.items as JSONSchema;
  }
  // A schema that refuses the properties it does not name has turned this key
  // down, whether it names some or none. Without `additionalProperties`, one
  // that names some reaches `schemaAtPath` as a missing property rather than as
  // `false`, and an eager read drops the property either way.
  //
  // One that names none and carries `allOf` parts has not: an eager read merges
  // the keywords beside an `allOf` into each part before it looks at a key, so
  // a part can name this one, and it is left to the read below. An `allOf`
  // holding no parts names nothing, and an eager read passes over it.
  if (
    schema.additionalProperties === false &&
    (isObjectOrArray(schema.properties) || !schema.allOf?.length)
  ) {
    return EXCLUDED_REJECTED;
  }
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
 * The default that stands in for a value which is not there.
 *
 * Only one the schema declares at its own top level, which is the rule an eager
 * read applies: a default sitting inside a branch of a union is reached by
 * evaluating that branch against a value, and an absent value gets no branch
 * evaluated. Reading one out anyway would return a value where an eager read
 * leaves it absent.
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

  // A value that is not there takes the schema's declared default, which an
  // eager read applies before it decides whether the type matches. Decided
  // ahead of the narrowing verdict below: an absent value matches no branch of a
  // union, so narrowing would refuse where the schema says what to read instead.
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

  const schema = narrowForValue(link.schema, value);
  if (schema === false) {
    return mismatch("no branch of the schema matches this value");
  }

  if (ContextualFlowControl.getAsCellValues(schema).length > 0) {
    // `validateAndTransform` dispatches `asCell` before handing over, but only
    // on what it can see at the top of the schema. Narrowing a union against
    // the value can surface a branch that declares one, and the reader is owed
    // the same handle either route would have produced.
    //
    // Hand it back rather than minting one here. Minting a handle is where the
    // consumed `asCell` marker is unwrapped off the handle's own schema and
    // where the follow-scope cap is applied — a read THROUGH the handle is
    // exactly the hop that cap bounds — and that belongs in one place. Passing
    // the narrowed schema back means the dispatch sees the marker it could not
    // see before and takes that path; it returns the handle without arriving
    // here again, so this does not recur.
    return validateAndTransform(
      runtime,
      tx,
      { link: { ...link, schema }, cfcLabelView },
      [],
      { synced, mismatchThrows: !isRoot, viewChild: true },
    );
  }

  const actualType = jsonTypeOf(value);
  if (isObjectOrArray(schema) && schema.type !== undefined) {
    if (!typeAccepts(schema.type, actualType)) {
      return mismatch(
        `expected ${JSON.stringify(schema.type)}, found ${actualType}`,
      );
    }
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
    isOpaquePosition(schema, actualType as JSONSchemaTypes)
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
    const narrowed = childSchema(schema, key);
    if (!Object.hasOwn(value, key)) {
      // A declared default stands in for an absent required key, exactly as it
      // does for an eager read, and so does a declared stream: its handle is
      // minted from the schema alone.
      if (
        declaredDefault(narrowed) !== undefined ||
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
    !isExcluded(childSchema(schema, key))
  );
  if (isObjectOrArray(schema) && isObjectOrArray(schema.properties)) {
    for (const key of Object.keys(schema.properties)) {
      if (Object.hasOwn(value, key)) continue;
      const narrowed = childSchema(schema, key);
      if (
        declaredDefault(narrowed) === undefined &&
        !ContextualFlowControl.declaresStream(narrowed)
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
    const narrowed = childSchema(schema, key, value[key]);
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
    if (!Object.hasOwn(value, key)) {
      // Register the read even though there is nothing there. An absent key is
      // usually a computed that has not produced yet, and the reader has to run
      // again when it does — a container read alone does not carry that, since
      // the value arrives at the child's own path. This is the same obligation
      // a refusal carries, for the case that is not a refusal: the schema does
      // not require this key, so reading it is an ordinary miss, not a mismatch.
      tx.readValueOrThrow({ ...link, path: [...link.path, key] });
      if (ContextualFlowControl.declaresStream(narrowed)) {
        return readChild(
          runtime,
          tx,
          link,
          key,
          narrowed,
          cfcLabelView,
          synced,
        );
      }
      const fallback = declaredDefault(narrowed);
      if (fallback === undefined) return undefined;
      return processDefaultValue(
        runtime,
        tx,
        { ...link, path: [...link.path, key], schema: narrowed },
        fallback,
        synced,
        rebaseCfcLabelView(cfcLabelView, [key]),
      );
    }
    if (required.has(key)) {
      return readChild(runtime, tx, link, key, narrowed, cfcLabelView, synced);
    }
    // A property the schema does not require reads as `undefined` when the data
    // underneath does not match it. That is what an eager read leaves behind: a
    // property whose traversal fails is left out of the object, and only a
    // `required` one takes the object down with it. Refusing here instead would
    // stop a reader the eager path runs — a field waiting on a computed that has
    // not produced is the ordinary case, not a fault.
    try {
      return readChild(runtime, tx, link, key, narrowed, cfcLabelView, synced);
    } catch (error) {
      if (!isSchemaMismatchError(error)) throw error;
      // The view asked for this read and the view is answering for it, so the
      // refusal never reaches the reader and must not survive on the
      // transaction. The read it registered does survive, which is what brings
      // the reader back when the data arrives.
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
    const itemSchema = childSchema(schema, key, item);
    const slotLink: NormalizedFullLink = {
      ...link,
      path: [...link.path, key],
      schema: itemSchema,
    };
    // An inline object element takes its identity from its own value, not from
    // the slot it sits in. `toCell` on `xs[0]` would otherwise hand back a link
    // to INDEX 0 of this array: write that anywhere and it names whatever lands
    // there next rather than this object. Eager traversal rebases the same
    // elements onto a `data:` URI, and the value is already in hand here, so
    // the identity costs no read. An element that is itself a link already
    // carries its own identity, and an `asCell` item is a handle whose link is
    // the point of it.
    if (
      isObjectNotArray(item) && !isSigilLink(item) &&
      !SchemaObjectTraverser.hasAsCell(itemSchema)
    ) {
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
    if (!tx.hasWrites()) return resolveElement(index);
    const previous = tx.enterReadEpoch(epoch);
    try {
      return resolveElement(index);
    } finally {
      tx.exitReadEpoch(previous);
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
