/**
 * Validates stored arguments without treating unreadable links as invalid
 * values, and without reading through a stored link the argument schema types
 * as a cell handle.
 */

import {
  FabricInstance,
  type FabricValue,
  isKeyableObjectNotArray,
  isKeyableObjectOrArray,
  isWalkableObjectOrArray,
} from "@commonfabric/data-model";
import { stringTupleKey } from "@commonfabric/utils/string-tuple-key";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "./builder/types.ts";
import { type Cell, isCell } from "./cell.ts";
import { ContextualFlowControl } from "./cfc.ts";
import {
  cfcSchemaResolvedRoot,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
} from "./cfc/schema-refs.ts";
import { validateSchemaValue } from "./cfc/schema-sanitization.ts";
import {
  type CellLink,
  isCellLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import {
  getCellOrThrow,
  isCellResult,
  isFabricInstanceOrView,
} from "./query-result-proxy.ts";
import {
  mergeSchemaDefaults,
  schemaAcceptsOpaqueCellValue,
} from "./runner-utils.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import {
  type IExtendedStorageTransaction,
  type IReadOptions,
  toThrowable,
} from "./storage/interface.ts";

// An unreadable stored link has a value owned elsewhere. Its type is checked
// when reactive reads materialize it, rather than against a replica's absence.
const UNRESOLVED_LINK_PLACEHOLDER = Object.freeze({
  "unresolved cell link": true,
});

/**
 * Whether `value` needs no schema check where it stands: an opaque Cell whose
 * wrapper the schema declares, or the placeholder
 * {@link overlayUnreadableLinkPlaceholders} leaves for a stored link this
 * replica cannot read. The two together are what let a document be judged
 * here without judging values that are owned elsewhere.
 */
export const acceptsOpaqueCellOrUnresolvedLink = (
  value: unknown,
  schema: JSONSchema,
): boolean =>
  value === UNRESOLVED_LINK_PLACEHOLDER ||
  schemaAcceptsOpaqueCellValue(value, schema);

const READ_NON_RECURSIVE: IReadOptions = { nonRecursive: true };

/** Per-validation state of the handle view. */
interface HandleViewContext {
  /** Container views keyed by materialized container, then by schema. */
  views: WeakMap<object, Map<JSONSchema, object>>;

  /** The handles the view holds in place of stored links. */
  handles: WeakSet<object>;

  /** The transaction the stored value is read through. */
  tx: IExtendedStorageTransaction;
}

/**
 * Returns the stored value at `cell` as validation reads it: its schemaless
 * materialization through `tx`, in which a stored link at a position whose
 * schema in `schema` declares a cell handle is that handle rather than the
 * value the link reaches. What the link reaches is judged by its top level
 * alone: a shallow read of it, which takes in no label declared below it, is
 * held to the `type` the position's schema allows, and a primitive also to
 * its `enum` and `const`. Nothing below that level is read, so no constraint
 * on it is judged here; the reactive reads that follow the handle check it
 * against the handle's own schema. A link whose top level does not fit is no
 * handle: its position reads as the materialized value, judged in full.
 *
 * Every other position reads as the materialized value does. So do the
 * positions along `materializedPath`, the one a caller writes at, whatever
 * their schema declares, since what is written there lands in what the link
 * reaches.
 *
 * `acceptsOpaque` is the predicate a merge of defaults and a validation over
 * `value` take as their `acceptOpaqueValue`: it accepts the handles this view
 * holds, and whatever {@link acceptsOpaqueCellOrUnresolvedLink} accepts. The
 * handles never reach storage: a caller writes the value at
 * `materializedPath`, which holds none.
 */
export function materializeStoredValueForValidation(
  cell: Cell<unknown>,
  schema: JSONSchema,
  tx: IExtendedStorageTransaction,
  materializedPath: readonly (string | number)[] = [],
): {
  value: unknown;
  acceptsOpaque: (value: unknown, schema: JSONSchema) => boolean;
} {
  const context: HandleViewContext = {
    views: new WeakMap(),
    handles: new WeakSet(),
    tx,
  };
  return {
    value: viewStoredLinksAsHandles(
      cell.asSchema(undefined).withTx(tx).get(),
      schema,
      materializedPath.map(String),
      context,
    ),
    acceptsOpaque: (value, schema) =>
      (isObjectOrArray(value) && context.handles.has(value)) ||
      acceptsOpaqueCellOrUnresolvedLink(value, schema),
  };
}

/**
 * Helper for `viewStoredLinksAsHandles()`, which says whether the top level of
 * what the link stored at `slot` reaches fits `schema`. A link that reaches
 * nothing readable fits, its check deferred to the reactive reads that follow
 * it, as an unreadable link is elsewhere in this validation.
 */
function reachedTopLevelFits(
  slot: Cell<unknown>,
  schema: JSONSchema,
  tx: IExtendedStorageTransaction,
): boolean {
  const reached = readTopLevel(slot, tx);
  if (reached === null) return true;
  // A container is judged by its kind alone, so it stands in empty, and what
  // the schema says of its members is left out of the judgement below.
  const container = isKeyableObjectOrArray(reached.value);
  const standIn = !container
    ? reached.value
    : Array.isArray(reached.value)
    ? []
    : {};
  const topLevel = topLevelSchema(schema, schema, !container, new Set());
  return validateSchemaValue(topLevel, standIn, topLevel) === undefined;
}

/**
 * Helper for `reachedTopLevelFits()`, which reads the value the link stored
 * at `slot` reaches without descending into it: a non-recursive read, which
 * takes in the labels declared at its path and above and none below. `null`
 * where the document or the path is absent.
 */
function readTopLevel(
  slot: Cell<unknown>,
  tx: IExtendedStorageTransaction,
): { value: unknown } | null {
  const target = slot.resolveAsCell().getAsNormalizedFullLink();
  const { ok, error } = tx.read(
    {
      space: target.space,
      id: target.id,
      scope: target.scope,
      type: "application/json",
      path: ["value", ...target.path],
    },
    { ...READ_NON_RECURSIVE, meta: ignoreReadForScheduling },
  );
  if (error !== undefined) {
    // The line `readStoredLinkChainRaw()` draws.
    if (error.name !== "NotFoundError" && error.name !== "TypeMismatchError") {
      throw toThrowable(error);
    }
    return null;
  }
  return ok.value === undefined ? null : { value: ok.value };
}

/**
 * Helper for `reachedTopLevelFits()`, which reduces `schema`, whose
 * references resolve against `root`, to what it says about a value's top level
 * alone: its `type`, and also its `enum` and `const` when `primitive`.
 * References are resolved in place and every combinator keeps its branches,
 * reduced the same way, except that `oneOf` becomes `anyOf`: two branches that
 * differ only below the top level reduce alike, so more than one of them may
 * fit. `active` holds the schemas being reduced, so a reference that leads
 * back to one says nothing more.
 */
function topLevelSchema(
  schema: JSONSchema,
  root: JSONSchema,
  primitive: boolean,
  active: Set<object>,
): JSONSchema {
  if (!isObjectOrArray(schema) || active.has(schema)) return schema ?? true;
  active.add(schema);
  try {
    if (typeof schema.$ref === "string") {
      const resolved = resolveCfcSchemaRefs(schema, root);
      if (resolved === undefined) return true;
      return topLevelSchema(
        resolved,
        isObjectOrArray(resolved)
          ? cfcSchemaResolvedRoot(
            resolved,
            resolveCfcSchemaRefRoot(schema, root),
          )
          : root,
        primitive,
        active,
      );
    }
    const reduced: Record<string, unknown> = {};
    if (schema.type !== undefined) reduced.type = schema.type;
    if (primitive && schema.enum !== undefined) reduced.enum = schema.enum;
    if (primitive && Object.hasOwn(schema, "const")) {
      reduced.const = schema.const;
    }
    const branches = (list: unknown) =>
      (list as JSONSchema[]).map((branch) =>
        topLevelSchema(branch, root, primitive, active)
      );
    if (Array.isArray(schema.allOf)) reduced.allOf = branches(schema.allOf);
    const either = [
      ...(Array.isArray(schema.anyOf) ? [schema.anyOf] : []),
      ...(Array.isArray(schema.oneOf) ? [schema.oneOf] : []),
    ];
    if (either.length === 1) reduced.anyOf = branches(either[0]);
    if (either.length === 2) {
      reduced.allOf = [
        ...(reduced.allOf as JSONSchema[] ?? []),
        { anyOf: branches(either[0]) },
        { anyOf: branches(either[1]) },
      ];
    }
    return reduced as JSONSchema;
  } finally {
    active.delete(schema);
  }
}

/**
 * Helper for `viewStoredLinksAsHandles()`, which says whether `schema`
 * declares a cell handle for a slot whose stored value is a link. A link is
 * neither `undefined` nor `null`, so a branch of the slot's `anyOf` or `oneOf`
 * that admits only those says nothing about it, and the slot declares a handle
 * when its other branches do: one typed `Cell<T> | undefined` holds a handle as
 * one typed `Cell<T>` does. The union is read where the slot's schema reaches
 * it, through a `$ref` at its root as much as written in place, which is how a
 * slot typed by a named alias of such a union arrives.
 */
function declaresHandleForLink(schema: JSONSchema): boolean {
  if (ContextualFlowControl.declaredHandleKind(schema) !== undefined) {
    return true;
  }
  if (!isObjectNotArray(schema)) return false;
  const union = typeof schema.$ref === "string"
    ? resolveCfcSchemaRefs(schema)
    : schema;
  if (!isObjectNotArray(union)) return false;
  return (["anyOf", "oneOf"] as const).some((keyword) => {
    const branches = union[keyword];
    if (!Array.isArray(branches)) return false;
    const linkable = branches.filter((branch) => !admitsOnlyAbsence(branch));
    return linkable.length > 0 && linkable.length < branches.length &&
      ContextualFlowControl.declaredHandleKind({
          ...union,
          [keyword]: linkable,
        }) !== undefined;
  });
}

/**
 * Helper for `declaresHandleForLink()`, which says whether `branch` admits no
 * value but `undefined` and `null`, by its `type` alone.
 */
function admitsOnlyAbsence(branch: unknown): boolean {
  if (!isObjectNotArray(branch) || branch.asCell !== undefined) return false;
  const types = Array.isArray(branch.type) ? branch.type : [branch.type];
  return types.length > 0 &&
    types.every((type) => type === "undefined" || type === "null");
}

/**
 * Helper for `materializeStoredValueForValidation()`, which views
 * `materialized`, read under `schema`, with its handle-typed stored links as
 * handles, leaving the position `keep` names materialized. Fields resolve on
 * access, so validation only reads the graph it inspects. A container off
 * `keep` read under the same schema twice is the same view, so shared
 * containers and cycles keep their identity for the validator's recursion
 * guard.
 */
function viewStoredLinksAsHandles(
  materialized: unknown,
  schema: JSONSchema,
  keep: readonly string[],
  context: HandleViewContext,
): unknown {
  if (
    typeof schema === "boolean" || !isCellResult(materialized) ||
    isFabricInstanceOrView(materialized)
  ) {
    return materialized;
  }
  let bySchema: Map<JSONSchema, object> | undefined;
  if (keep.length === 0) {
    bySchema = context.views.get(materialized);
    if (bySchema === undefined) {
      bySchema = new Map();
      context.views.set(materialized, bySchema);
    }
    const cached = bySchema.get(schema);
    if (cached !== undefined) return cached;
  }

  const container = getCellOrThrow(materialized);
  const view: object = Array.isArray(materialized)
    ? new Array(materialized.length)
    : {};
  bySchema?.set(schema, view);
  for (const key of Object.keys(materialized)) {
    Object.defineProperty(view, key, {
      configurable: true,
      enumerable: true,
      get: () => {
        const childSchema = ContextualFlowControl.schemaAtPath(schema, [key]);
        const kept = keep[0] === key;
        const slot = container.key(key);
        // Only the slot's own bytes are read here: a raw read resolves links
        // on the way to the slot and leaves the one stored in it unfollowed.
        const handle = !kept &&
          declaresHandleForLink(childSchema) &&
          isCellLink(slot.getRaw({ meta: ignoreReadForScheduling })) &&
          reachedTopLevelFits(slot, childSchema, context.tx);
        if (handle) context.handles.add(slot);
        const child = handle ? slot : viewStoredLinksAsHandles(
          (materialized as Record<string, unknown>)[key],
          childSchema,
          kept ? keep.slice(1) : [],
          context,
        );
        Object.defineProperty(view, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: child,
        });
        return child;
      },
    });
  }
  return view;
}

/** Per-validation caches for the unreadable-link view. */
interface LinkOverlayContext {
  /** Linked views keyed by normalized address and materialized identity. */
  links: Map<string, Map<unknown, unknown>>;

  /** Container views keyed by base address, raw identity, and snapshot identity. */
  containers: Map<string, WeakMap<object, WeakMap<object, object>>>;
}

/** Helper for the overlay caches, which identifies a stored location. */
function overlayAddressKey(link: NormalizedFullLink): string {
  return stringTupleKey([link.space, link.id, link.scope, ...link.path]);
}

/**
 * Resolves one stored link — and any links it chains through — to the RAW
 * value tree at its endpoint, reading doc bytes through `tx`. `value` is
 * `undefined` whenever no readable tree is there: an absent doc, a doc
 * record holding no value (what a meta-only write leaves behind), a path the
 * present tree does not hold, a chain that cycles. The caller draws no
 * distinction among those — this walk exists to mirror the structure the
 * materialization resolved, not to judge absences, and which of them a raw
 * read is looking at is not knowable here (a slot a pattern materializes
 * lazily reads exactly like one that never synced; the pattern-vintage gate
 * holds real stores of both).
 *
 * Steps hop by hop rather than calling link-resolution's resolver because
 * the caller needs the endpoint's raw tree to recurse into, and because a
 * raw read of a path that crosses a mid-doc link would descend into the
 * link sigil's own JSON — so path segments are walked in memory and links
 * met along the way are followed.
 *
 * `chain` carries the addresses visited within one alias sequence, including
 * any addresses the caller supplies. Every key this walk adds is removed on
 * exit, preserving the caller's set. The overlay starts a fresh chain for each
 * link it resolves. The repeat-address guard terminates alias-only cycles;
 * direct callers can exercise it without first materializing the linked graph.
 */
export function readStoredLinkChainRaw(
  tx: IExtendedStorageTransaction,
  startLink: NormalizedFullLink,
  chain: Set<string>,
): {
  value: unknown;
  base: NormalizedFullLink;
  /** Whether the result depends on a repeated address in the active chain. */
  cyclic?: true;
} {
  const added: string[] = [];
  const follow = (
    value: CellLink,
    base: NormalizedFullLink,
    rest: string[],
  ) => {
    const next = parseLink(value, base);
    const path = [...next.path, ...rest];
    const key = stringTupleKey([next.space, next.id, next.scope, ...path]);
    if (chain.has(key)) return undefined;
    chain.add(key);
    added.push(key);
    return { ...next, path };
  };
  try {
    let link = startLink;
    while (true) {
      const { ok, error } = tx.read(
        {
          space: link.space,
          id: link.id,
          scope: link.scope,
          type: "application/json",
          path: ["value"],
        },
        READ_NON_RECURSIVE,
      );
      if (error !== undefined) {
        // The same line readOrThrow draws: an absent document or a path
        // through a primitive reads as no value here, and every other
        // failure — a dead transaction, malformed storage — surfaces.
        if (
          error.name !== "NotFoundError" && error.name !== "TypeMismatchError"
        ) {
          throw toThrowable(error);
        }
        return { value: undefined, base: link };
      }
      if (ok.value === undefined) {
        return { value: undefined, base: link };
      }
      let value: unknown = ok.value;
      const path = [...link.path] as string[];
      let followed: NormalizedFullLink | undefined;
      while (path.length > 0) {
        if (isCellLink(value)) {
          // A link met mid-path: the rest of the path applies at its target.
          followed = follow(value, link, path);
          if (followed === undefined) {
            return { value: undefined, base: link, cyclic: true };
          }
          break;
        }
        if (!isObjectOrArray(value)) {
          return { value: undefined, base: link };
        }
        value = (value as Record<string, unknown>)[path.shift()!];
      }
      if (followed === undefined && isCellLink(value)) {
        followed = follow(value, link, []);
        if (followed === undefined) {
          return { value: undefined, base: link, cyclic: true };
        }
      }
      if (followed !== undefined) {
        link = followed;
        continue;
      }
      return { value, base: link };
    }
  } finally {
    for (const key of added) chain.delete(key);
  }
}

/**
 * Creates a validation view that defers unreadable stored links. A linked slot
 * materialized as `undefined` reads as an opaque placeholder; literal absences
 * and readable values retain their schema checks. Defaults in `materialized`
 * remain in the view, and neither input is modified.
 *
 * Fields resolve on access, so validation only follows the graph it inspects.
 * Shared containers and cycles retain their identity within the view, keyed by
 * stored location and materialized snapshot. Separately defaulted snapshots
 * remain distinct. A recursive schema over a cyclic view is still judged by
 * the validator's recursion guard.
 *
 * The view belongs to this validation and transaction. Deferred slots are
 * checked when reactive reads materialize them.
 */
export function overlayUnreadableLinkPlaceholders(
  tx: IExtendedStorageTransaction,
  base: NormalizedFullLink,
  raw: unknown,
  materialized: unknown,
): unknown {
  return overlayUnreadableLinkPlaceholdersInternal(
    tx,
    base,
    raw,
    materialized,
    { links: new Map(), containers: new Map() },
  );
}

/** Helper for `overlayUnreadableLinkPlaceholders()`, which reuses linked views. */
function overlayUnreadableLinkPlaceholdersInternal(
  tx: IExtendedStorageTransaction,
  base: NormalizedFullLink,
  raw: unknown,
  materialized: unknown,
  context: LinkOverlayContext,
): unknown {
  if (isCell(materialized)) return materialized;
  if (isCellLink(raw)) {
    if (materialized === undefined) return UNRESOLVED_LINK_PLACEHOLDER;
    const link = parseLink(raw, base);
    const key = overlayAddressKey(link);
    let byValue = context.links.get(key);
    if (byValue?.has(materialized)) return byValue.get(materialized);
    if (byValue === undefined) {
      byValue = new Map();
      context.links.set(key, byValue);
    }
    // Only the chain of aliases needs a cutoff. A link to a concrete container
    // resolves to a cached view whose fields can point back to that same view.
    const reading = readStoredLinkChainRaw(tx, link, new Set([key]));
    const result = reading.value === undefined
      ? materialized
      : overlayUnreadableLinkPlaceholdersInternal(
        tx,
        reading.base,
        reading.value,
        materialized,
        context,
      );
    // The same snapshot also reuses an unavailable raw read's unchanged value.
    byValue.set(materialized, result);
    return result;
  }
  // The validator judges instances whole, so preserve its input for that verdict.
  if (raw instanceof FabricInstance || materialized instanceof FabricInstance) {
    return materialized;
  }
  if (
    !isWalkableObjectOrArray(raw) || !isWalkableObjectOrArray(materialized)
  ) return materialized;

  const key = overlayAddressKey(base);
  let byRaw = context.containers.get(key);
  if (byRaw === undefined) {
    byRaw = new WeakMap();
    context.containers.set(key, byRaw);
  }
  let byValue = byRaw.get(raw);
  if (byValue?.has(materialized)) return byValue.get(materialized);
  if (byValue === undefined) {
    byValue = new WeakMap();
    byRaw.set(raw, byValue);
  }
  const result = Array.isArray(materialized)
    ? materialized.slice()
    : { ...materialized };
  // Publish the container before any child is resolved, so a back edge shares
  // its view instead of expanding another path through the graph.
  byValue.set(materialized, result);
  for (const [key, rawChild] of Object.entries(raw)) {
    if (!Object.hasOwn(materialized, key) && !isCellLink(rawChild)) continue;
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      get: () => {
        const child = overlayUnreadableLinkPlaceholdersInternal(
          tx,
          base,
          rawChild,
          (materialized as Record<string, unknown>)[key],
          context,
        );
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: child,
        });
        return child;
      },
    });
  }
  return result;
}

/**
 * Returns a stored argument's schema mismatch, deferring unreadable linked slots.
 * Source preflight and runtime setup use the same defaults and absence rules.
 * The caller supplies the transaction so staged writes and read-only checks
 * validate the storage version they actually act on.
 */
export function storedArgumentValidationIssue(
  argumentCell: Cell<unknown>,
  argumentSchema: JSONSchema,
  defaults: FabricValue,
  tx: IExtendedStorageTransaction,
): string | undefined {
  return storedArgumentJudge(argumentCell, argumentSchema, defaults, tx)(
    argumentSchema,
    (argument) => argument,
  );
}

/**
 * Returns the mismatch of each of `slots`, top-level slots of a stored
 * argument, against the schema `argumentSchema` gives that slot, keyed by
 * slot. A slot that matches has no entry, and so does a slot the schema does
 * not describe where it admits slots it does not name. Each slot is judged
 * under the defaults, absence rules and deferral of unreadable links that
 * `storedArgumentValidationIssue()` applies to the whole argument.
 */
export function storedArgumentSlotIssues(
  argumentCell: Cell<unknown>,
  argumentSchema: JSONSchema,
  defaults: FabricValue,
  tx: IExtendedStorageTransaction,
  slots: Iterable<string>,
): Map<string, string> {
  const judge = storedArgumentJudge(argumentCell, argumentSchema, defaults, tx);
  const issues = new Map<string, string>();
  for (const slot of slots) {
    const issue = judge(
      ContextualFlowControl.schemaAtPath(argumentSchema, [slot]),
      (argument) =>
        isKeyableObjectNotArray(argument) ? argument[slot] : undefined,
    );
    if (issue !== undefined) issues.set(slot, issue);
  }
  return issues;
}

/**
 * Helper for `storedArgumentValidationIssue()` and
 * `storedArgumentSlotIssues()`, which materializes the stored argument once
 * and returns a function judging the part `select` picks out of it against
 * `schema`, resolving references against `argumentSchema`.
 */
function storedArgumentJudge(
  argumentCell: Cell<unknown>,
  argumentSchema: JSONSchema,
  defaults: FabricValue,
  tx: IExtendedStorageTransaction,
): (
  schema: JSONSchema,
  select: (argument: unknown) => unknown,
) => string | undefined {
  const argumentLink = argumentCell.getAsNormalizedFullLink();
  const stored = materializeStoredValueForValidation(
    argumentCell,
    argumentSchema,
    tx,
  );
  const validationArgument: unknown = mergeSchemaDefaults(
    stored.value,
    defaults,
    argumentSchema,
    { mergeMaterializedLinks: true, acceptOpaqueValue: stored.acceptsOpaque },
  );
  const validationOptions = {
    acceptOpaqueValue: stored.acceptsOpaque,
    // An OPTIONAL key holding `undefined` carries no data, and a handler
    // mints one without meaning to: `comments.push({ author, ... })` with
    // no author in hand writes the key, and the codec stores that presence.
    // Measuring it here asks whether `undefined` satisfies the property's
    // declared type, which nothing ordinary answers yes to — and THIS
    // refusal is permanent, because the same identity refuses identically
    // (see `isStoredArgumentSchemaRefusal`). A pattern would be unable to
    // update documents it wrote itself. Measured on `topics/topic.tsx`
    // (`author`) and `lunch-poll/main.tsx` (`imageUrl`).
    //
    // Scoped to THIS caller rather than made the validator's rule: writing
    // `undefined` where a number is declared is still a mistake worth
    // rejecting at a result write, while the caller can still see it.
    optionalUndefinedIsAbsent: true,
  };
  let overlaid: { value: unknown } | undefined;
  return (schema, select) => {
    const validationFailure = validateSchemaValue(
      schema,
      select(validationArgument),
      argumentSchema,
      validationOptions,
    );
    if (validationFailure === undefined) return undefined;
    // Judge only what this context can actually read. The materialization
    // above resolves the staged doc's link graph through this transaction,
    // short of the links it holds as handles, and a link chain that dead-ends
    // at a doc the local replica cannot serve materializes as `undefined` —
    // indistinguishable from a stored mistake, though the stored bytes are
    // fine and every OTHER context may read them. Validating that `undefined`
    // bricks the piece permanently (same identity, same refusal — see
    // `isStoredArgumentSchemaRefusal`), so such slots validate as opaque and
    // their schema check is deferred to instantiation-time reactive reads,
    // which sync what they need. Supplied and re-staged arguments alike: a
    // caller vouches for the value it stages, but which link targets happen
    // to be replicated HERE was never part of that value. The overlay only
    // ever turns `undefined` into an accepted opaque, and leaves a handle as
    // it is, so building it on a failure alone changes no verdict — it spares
    // the happy path a second walk of the stored graph.
    overlaid ??= {
      value: overlayUnreadableLinkPlaceholders(
        tx,
        argumentLink,
        argumentCell.withTx(tx).getRaw({ meta: ignoreReadForScheduling }),
        validationArgument,
      ),
    };
    return validateSchemaValue(
      schema,
      select(overlaid.value),
      argumentSchema,
      validationOptions,
    );
  };
}
