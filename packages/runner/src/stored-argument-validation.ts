/** Validates stored arguments without treating unreadable links as invalid values. */

import {
  FabricInstance,
  type FabricValue,
  isWalkableObjectOrArray,
} from "@commonfabric/data-model";
import { stringTupleKey } from "@commonfabric/utils/string-tuple-key";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "./builder/types.ts";
import { type Cell, isCell } from "./cell.ts";
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
  const materializedArgument = argumentCell.asSchema(undefined).withTx(tx)
    .get();
  const validationArgument: unknown = mergeSchemaDefaults(
    materializedArgument,
    defaults,
    argumentSchema,
    { mergeMaterializedLinks: true },
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
