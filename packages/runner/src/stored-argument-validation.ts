/** Validates stored arguments without treating unreadable links as invalid values. */

import {
  FabricInstance,
  type FabricValue,
  isWalkableObjectOrArray,
} from "@commonfabric/data-model";
import { stringTupleKey } from "@commonfabric/utils/string-tuple-key";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "./builder/types.ts";
import { type Cell, isCell } from "./cell.ts";
import {
  ContextualFlowControl,
  resolveExternalRootRefForStructure,
} from "./cfc.ts";
import { localDefinitionName } from "./cfc/schema-primitives.ts";
import { validateSchemaValue } from "./cfc/schema-sanitization.ts";
import {
  type CellLink,
  isCellLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
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

/** Keywords whose subschemas describe the same value against other schemas. */
const COMBINATOR_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

/**
 * The schema a value is materialized under before it is validated against
 * `schema`: the paths of `schema` that lead to a declared handle, with those
 * handle declarations, and no constraints. Reading under it returns a Cell at
 * each position `schema` declares a handle, without opening what the handle
 * refers to, and returns everything else as a schemaless read would, links
 * followed. A schema declaring no handle reduces to `true`.
 *
 * A handle's contents are judged where they are read through the handle,
 * against whatever they are then; a check made through the referring document
 * certifies nothing about them later. Reading a handle's target here would
 * make it a commit dependency of the referring write and let a malformed
 * target refuse that write, which the reader avoids by stopping at the handle.
 *
 * Constraints are left out so that the read neither drops nor substitutes a
 * mismatched value: the validator has to see what is stored to refuse it. For
 * the same reason no reference survives into the result unless it names a
 * reduced definition, since any other would carry the full schema back into
 * the read. A union reads as a schemaless value, because which branch a value
 * takes is the validator's question, and a handle one branch declares is not
 * one the reader mints. So does a position behind a reference to another
 * schema document, and a reference-form schema whose document has not
 * arrived: a handle there is judged by its contents, as a value would be.
 */
export function handleBoundarySchema(schema: JSONSchema): JSONSchema {
  if (!isObjectNotArray(schema)) return true;
  const root = resolveExternalRootRefForStructure(schema);
  const definitions = isObjectNotArray(root.$defs) ? root.$defs : {};
  // A definition, or the root, can lead to a handle through a reference to
  // another, so which of them do is found by repeating the reduction until
  // the answer stops growing.
  const leads: HandleLeads = { definitions: new Set(), root: false };
  while (true) {
    const reducedDefinitions = Object.entries(definitions).map((
      [name, definition],
    ) => [name, reduceToHandles(definition, leads)] as const);
    const body = reduceToHandles(root, leads);
    const before = leads.definitions.size + (leads.root ? 1 : 0);
    for (const [name, definition] of reducedDefinitions) {
      if (definition !== true) leads.definitions.add(name);
    }
    leads.root ||= body !== true;
    if (leads.definitions.size + (leads.root ? 1 : 0) > before) continue;
    if (body === true) return true;
    const $defs = reducedDefinitions.filter(([name]) =>
      leads.definitions.has(name)
    );
    return $defs.length === 0
      ? body
      : { ...body, $defs: Object.fromEntries($defs) } as JSONSchema;
  }
}

/** Which definitions of the root, and whether the root, lead to a handle. */
interface HandleLeads {
  /** Names in the root's `$defs` whose definition leads to a handle. */
  definitions: Set<string>;

  /** Whether the root leads to a handle, for a `#` reference to it. */
  root: boolean;
}

/**
 * Helper for {@link handleBoundarySchema}, which reduces one schema node to
 * the paths below it that lead to a handle. A `$ref` survives only when it
 * names a definition, or the root, that `leads` says leads to one.
 */
function reduceToHandles(
  schema: JSONSchema,
  leads: HandleLeads,
): JSONSchema {
  if (!isObjectNotArray(schema)) return true;
  if (ContextualFlowControl.getAsCellValues(schema).length > 0) {
    return {
      asCell: schema.asCell,
      ...(schema.scope === undefined ? {} : { scope: schema.scope }),
    };
  }
  if (COMBINATOR_KEYWORDS.some((keyword) => schema[keyword] !== undefined)) {
    return true;
  }
  if (typeof schema.$ref === "string") {
    // Siblings of a `$ref` describe the same value, and a reduced sibling
    // carries no constraint, so the reference alone decides this node.
    const name = localDefinitionName(schema.$ref);
    const leadsToHandle = name === undefined
      ? schema.$ref === "#" && leads.root
      : leads.definitions.has(name);
    return leadsToHandle ? { $ref: schema.$ref } : true;
  }
  const reduce = (sub: JSONSchema) => reduceToHandles(sub, leads);
  const result: Record<string, JSONSchema | readonly JSONSchema[]> = {};
  if (isObjectNotArray(schema.properties)) {
    const properties: Record<string, JSONSchema> = {};
    for (const [key, sub] of Object.entries(schema.properties)) {
      const reduced = reduce(sub);
      if (reduced !== true) properties[key] = reduced;
    }
    if (Object.keys(properties).length > 0) result.properties = properties;
  }
  if (schema.additionalProperties !== undefined) {
    const reduced = reduce(schema.additionalProperties);
    if (reduced !== true) result.additionalProperties = reduced;
  }
  if (Array.isArray(schema.prefixItems)) {
    const reduced = schema.prefixItems.map(reduce);
    if (reduced.some((sub) => sub !== true)) result.prefixItems = reduced;
  }
  if (schema.items !== undefined) {
    const reduced = reduce(schema.items);
    if (reduced !== true) result.items = reduced;
  }
  if (Object.keys(result).length === 0) return true;
  // A key this node does not name reads as a schemaless value would.
  if (result.additionalProperties === undefined) {
    result.additionalProperties = true;
  }
  return result as JSONSchema;
}

/**
 * Materializes `cell` for validation against `schema`, stopping at the handles
 * `schema` declares; see {@link handleBoundarySchema}.
 */
export function materializeForValidation(
  cell: Cell<unknown>,
  schema: JSONSchema,
  tx: IExtendedStorageTransaction,
): unknown {
  const boundary = handleBoundarySchema(schema);
  return cell.asSchema(boundary === true ? undefined : boundary).withTx(tx)
    .get();
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
  const argumentLink = argumentCell.getAsNormalizedFullLink();
  const materializedArgument = materializeForValidation(
    argumentCell,
    argumentSchema,
    tx,
  );
  const validationArgument: unknown = mergeSchemaDefaults(
    materializedArgument,
    defaults,
    argumentSchema,
    {
      mergeMaterializedLinks: true,
      acceptOpaqueValue: acceptsOpaqueCellOrUnresolvedLink,
    },
  );
  const validationOptions = {
    acceptOpaqueValue: acceptsOpaqueCellOrUnresolvedLink,
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
  let validationFailure = validateSchemaValue(
    argumentSchema,
    validationArgument,
    argumentSchema,
    validationOptions,
  );
  if (validationFailure !== undefined) {
    // Judge only what this context can actually read. The materialization
    // above resolves the staged doc's whole link graph through this
    // transaction, and a link chain that dead-ends at a doc the local
    // replica cannot serve materializes as `undefined` — indistinguishable
    // from a stored mistake, though the stored bytes are fine and every
    // OTHER context may read them. Validating that `undefined` bricks the
    // piece permanently (same identity, same refusal — see
    // `isStoredArgumentSchemaRefusal`), so such slots validate as opaque
    // and their schema check is deferred to instantiation-time reactive
    // reads, which sync what they need. Supplied and re-staged arguments
    // alike: a caller vouches for the value it stages, but which link
    // targets happen to be replicated HERE was never part of that value.
    // The overlay only ever turns `undefined` into an accepted opaque, so
    // running it on failure alone changes no verdict — it spares the
    // happy path a second walk of the stored graph.
    validationFailure = validateSchemaValue(
      argumentSchema,
      overlayUnreadableLinkPlaceholders(
        tx,
        argumentLink,
        argumentCell.withTx(tx).getRaw({ meta: ignoreReadForScheduling }),
        validationArgument,
      ),
      argumentSchema,
      validationOptions,
    );
  }
  return validationFailure;
}
