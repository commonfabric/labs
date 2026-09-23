// Durable-content fingerprints — "did this space's content survive?" as a
// number you can compare, and a diff when it didn't.
//
// Why (docs/plans/space-clone-rehearsal.md): the July 2026 Topics rehearsal
// verified content preservation with ad-hoc SQL and Python heredocs written
// fresh each attempt. Two rehearsals whose fingerprints were computed
// differently cannot be compared, and an improvised check that quietly measures
// less than last time looks exactly like a pass. This is that check, computed
// one way.
//
// COMPILER-GENERATED CELLS ARE EXCLUDED BY DEFAULT. A pattern update rotates
// generated internal-cell identities on purpose (labs#4916), so including them
// guarantees the fingerprint changes on every legitimate migration — which
// makes it useless as a "content survived" signal. Verified against the real
// Estuary Topics store: all 20 write-storm cells (192,381 revisions, 90.3% of
// every revision) are `$generated`, and NONE of them is authored content.
//
// Hashing goes through `@commonfabric/data-model` — the same
// canonicalizing hash the runtime derives entity ids with, so this cannot drift
// from the engine's notion of value identity.

import { type FabricValue, hashOf } from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { utf8Compare } from "@commonfabric/utils/utf8";
import type { SpaceDb } from "./db.ts";
import {
  type EntityModel,
  listEntityModels,
  visibleEntityRowsByScope,
} from "./model.ts";
import { type EntityAddress, reconstructDocument } from "./reconstruct.ts";
import { scopesOfRows } from "./scopes.ts";

/**
 * `listEntityModels` caps at 5,000 by default — a real Estuary space already
 * exceeds that. A fingerprint computed over a truncated enumeration would still
 * return a confident-looking hash, which is the exact failure this whole module
 * exists to prevent, so we raise the cap and REFUSE the listing that reports
 * itself truncated rather than hash a partial space.
 */
const ENUMERATION_CAP = 1_000_000;

/**
 * Hash one entity's durable value, reporting a rejection instead of throwing.
 *
 * `hashOf` refuses some values it is given, a value nested past the call stack
 * among them, and a single odd entity must not abort a whole-space fingerprint —
 * nor be quietly treated as empty, which would let real content drift read as
 * "unchanged".
 */
export function hashEntityValue(
  value: FabricValue,
): { hash: string } | { error: string } {
  try {
    return { hash: hashOf(value).toString() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Enumerates every scope in the space, refusing listings that exceed `cap`.
 *
 * `listEntityModels()` defaults to the shared space scope. Per-user and
 * per-session state is durable content too, so this walk uses every scope
 * the rows are grouped under.
 */
function allEntities(
  space: SpaceDb,
  branch: string,
  cap: number = ENUMERATION_CAP,
): EntityModel[] {
  const out: EntityModel[] = [];
  // Scopes and their rows come from one pass, so every scope walked is one the
  // rows were grouped under.
  const rowsByScope = visibleEntityRowsByScope(space, { branch });
  for (const scope of scopesOfRows(rowsByScope)) {
    const rows = rowsByScope.get(scope.raw) ?? [];
    const listing = listEntityModels(space, {
      branch,
      scope: scope.raw,
      limit: cap,
      rows,
    });
    if (listing.extent.truncated) {
      throw new Error(
        `scope ${scope.raw} holds ${listing.extent.total} entities, past the ` +
          `${cap} cap; refusing to fingerprint a truncated enumeration.`,
      );
    }
    // Appending individually avoids V8's argument limit for large scopes.
    for (const entity of listing.entities) out.push(entity);
  }
  return out;
}

/**
 * An {@link EntityAddress} whose scope is known — which, for anything this
 * module reports, it always is.
 *
 * An id is NOT unique on its own: one id can hold a shared space value plus
 * per-user/per-session overrides that are genuinely different entities. So a
 * report names the pair it computed over. A bare id forces every caller to
 * re-associate it with a scope by guessing — a lookup that silently lets the
 * last scope win, misclassifying exactly the per-kind precision ("74 pieces vs
 * 73 cells") the diff exists to provide.
 *
 * Being an `EntityAddress` is the useful part: what a diff entry is FOR is
 * looking the entity up, and this hands straight to `reconstructDocument`.
 */
export type ScopedEntity = EntityAddress & { scope: string };

/**
 * The composite key an entity address indexes by — one spelling, exported, so
 * two sides of a comparison cannot key differently and quietly disagree about
 * which entity is which.
 *
 * The separator is NUL because it has to be a byte neither field can hold. A
 * minted id is `of:fid1:<base64url>`, `computed:fid1:<…>` or a DID, and a scope
 * key is `space` or `user:`/`session:` over percent-encoded segments, so no
 * value the runtime writes contains a control byte. A printable separator has
 * no such floor under it: this tool reads stores it did not write, where both
 * columns are opaque TEXT, and `("of:a", "b c")` and `("of:a b", "c")` would
 * then share a key. That is not a cosmetic collision — `verifyClone` subtracts
 * generated exclusions by this key, so an alias could clear a removal that
 * really happened, which is the one verdict this module must never soften.
 */
export function entityAddressKey(at: ScopedEntity): string {
  return `${at.id}\x00${at.scope}`;
}

/** One entity's content hash at head. */
export interface EntityFingerprint {
  id: string;
  scope: string;

  /** Entity classification (`piece`, `cell`, …) as the model reports it. */
  kind: string;

  /** `hashOf` the entity's durable `value`, or null when it has no value. */
  hash: string | null;
}

export interface FingerprintReport {
  /** Hash over every included entity's (id, scope, hash) — the one number. */
  hash: string;

  /** Entities included in `hash`. */
  entities: number;

  /** Internal cells skipped because a manifest calls them compiler-generated. */
  excludedGenerated: number;

  /**
   * The entities behind {@link excludedGenerated}, by address. A diff against a
   * fingerprint taken from another store must subtract these before calling
   * anything removed: the two stores compute their exclusions independently, so
   * a cell no manifest listed THERE and this manifest calls generated HERE is
   * present in both and absent from one list. Reporting that as removed content
   * is the loudest verdict this module has, spent on a filter disagreement.
   *
   * The scope travels with the id because the subtraction is only sound per
   * (id, scope). A manifest link carries an id and no scope, so calling a cell
   * generated excludes EVERY scope that holds the id; subtracting by id alone
   * would then clear the alarm for a scope whose rows are gone, reporting
   * destroyed per-user state as a filter disagreement.
   */
  excludedGeneratedAddresses: ScopedEntity[];

  /**
   * Ids some manifest calls generated and another calls named. Counted as
   * generated (rotation-prone wins, so the fingerprint stays stable) but
   * reported, because that choice can hide a real content change and must never
   * be silent. Zero on every store observed so far.
   */
  ambiguous: string[];

  /** Entities whose value could not be hashed, with the reason. Never silent. */
  unhashable: { id: string; reason: string }[];

  /** Per-entity hashes, id-sorted — the input to `diffFingerprints`. */
  perEntity: EntityFingerprint[];
}

export interface FingerprintOptions {
  branch?: string;

  /**
   * Refuse rather than fingerprint a space whose scope enumerates more than
   * this many entities, since the enumeration was truncated. A scope holding
   * exactly the cap is complete and accepted. Defaults to 1,000,000 — far above
   * any real space; raise it only knowingly.
   */
  enumerationCap?: number;

  /**
   * Include compiler-generated internal cells. Default false. Turning this on
   * makes the fingerprint change on every pattern update by design; it exists
   * for "what moved at all?", not for "did content survive?".
   */
  includeGenerated?: boolean;
}

/**
 * Entity ids that some piece's `internal` manifest attributes to a
 * compiler-generated cause (`partialCause: { $generated: N }`) rather than an
 * authored name (`partialCause: "entries"`).
 *
 * The manifest is the only place this distinction is recorded: entity ids are
 * content hashes and carry no marker of their own.
 */
export function generatedInternalCellIds(
  space: SpaceDb,
  options: { branch?: string; enumerationCap?: number } = {},
): { generated: Set<string>; named: Set<string> } {
  const branch = options.branch ?? "";
  return generatedIdsAmong(
    space,
    allEntities(space, branch, options.enumerationCap),
    branch,
  );
}

/**
 * {@link generatedInternalCellIds} over models a caller already enumerated, so
 * a caller that walks every entity for its own reasons does not build every
 * model a second time to learn which ones are generated.
 */
function generatedIdsAmong(
  space: SpaceDb,
  models: Iterable<EntityModel>,
  branch: string,
): { generated: Set<string>; named: Set<string> } {
  const generated = new Set<string>();
  const named = new Set<string>();
  for (const model of models) {
    if (model.kind !== "piece") continue;
    const doc = reconstructDocument(space, {
      id: model.id,
      scope: model.scope,
      branch,
    });
    const internal = (doc as Record<string, unknown> | undefined)?.internal;
    if (!Array.isArray(internal)) continue;
    for (const entry of internal) {
      const id = manifestLinkId(entry);
      if (id === undefined) continue;
      if (isGeneratedCause((entry as Record<string, unknown>).partialCause)) {
        generated.add(id);
      } else {
        named.add(id);
      }
    }
  }
  return { generated, named };
}

/** `{ $generated: N }` — the compiler's anonymous per-build ordinal. */
function isGeneratedCause(cause: unknown): boolean {
  return isObjectOrArray(cause) && "$generated" in cause;
}

/** The link target id of a manifest entry (`{ partialCause, link }`). */
function manifestLinkId(entry: unknown): string | undefined {
  if (!isObjectOrArray(entry)) return undefined;
  const link = (entry as Record<string, unknown>).link;
  if (!isObjectOrArray(link)) return undefined;
  const envelope = (link as Record<string, unknown>)["/"];
  if (!isObjectOrArray(envelope)) return undefined;
  const payload = (envelope as Record<string, unknown>)["link@1"];
  if (!isObjectOrArray(payload)) return undefined;
  const id = (payload as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

/** Content fingerprint of a space at head. */
export function contentFingerprint(
  space: SpaceDb,
  options: FingerprintOptions = {},
): FingerprintReport {
  const branch = options.branch ?? "";
  // One walk serves both the generated-cell exclusion and the hashing: every
  // model is built once, which is most of what a fingerprint costs.
  const models = allEntities(space, branch, options.enumerationCap);
  const { generated, named } = options.includeGenerated
    ? { generated: new Set<string>(), named: new Set<string>() }
    : generatedIdsAmong(space, models, branch);

  const ambiguous = [...generated].filter((id) => named.has(id)).sort(
    utf8Compare,
  );
  const perEntity: EntityFingerprint[] = [];
  const unhashable: { id: string; reason: string }[] = [];
  const excludedGeneratedAddresses: ScopedEntity[] = [];

  for (const model of models) {
    if (generated.has(model.id)) {
      excludedGeneratedAddresses.push({ id: model.id, scope: model.scope });
      continue;
    }
    // The models come from this branch, so the values must too — reading the
    // default branch here would hash a parent's content under a child's name
    // and certify two different spaces as identical.
    const doc = reconstructDocument(space, {
      id: model.id,
      scope: model.scope,
      branch,
    });
    const value = doc?.value;
    let hash: string | null = null;
    if (value !== undefined) {
      const hashed = hashEntityValue(value);
      if ("error" in hashed) {
        unhashable.push({ id: model.id, reason: hashed.error });
        continue;
      }
      hash = hashed.hash;
    }
    perEntity.push({
      id: model.id,
      scope: model.scope,
      kind: model.kind,
      hash,
    });
  }

  // Sort so the roll-up is independent of enumeration order.
  perEntity.sort((a, b) =>
    a.id === b.id ? utf8Compare(a.scope, b.scope) : utf8Compare(a.id, b.id)
  );

  return {
    hash: hashOf(
      perEntity.map((e) => [e.id, e.scope, e.hash] as const),
    ).toString(),
    entities: perEntity.length,
    excludedGenerated: excludedGeneratedAddresses.length,
    excludedGeneratedAddresses,
    ambiguous,
    unhashable,
    perEntity,
  };
}

export interface FingerprintDiff {
  equal: boolean;
  added: ScopedEntity[];
  removed: ScopedEntity[];
  changed: ScopedEntity[];
}

/**
 * What moved between two fingerprints. This is the answer a rehearsal actually
 * needs: not "the fingerprint differs" but "these three topic bodies differ".
 */
export function diffFingerprints(
  before: FingerprintReport,
  after: FingerprintReport,
): FingerprintDiff {
  const a = new Map(before.perEntity.map((e) => [entityAddressKey(e), e]));
  const b = new Map(after.perEntity.map((e) => [entityAddressKey(e), e]));

  const added: ScopedEntity[] = [];
  const removed: ScopedEntity[] = [];
  const changed: ScopedEntity[] = [];
  const at = (e: EntityFingerprint): ScopedEntity => ({
    id: e.id,
    scope: e.scope,
  });

  for (const [k, e] of b) if (!a.has(k)) added.push(at(e));
  for (const [k, e] of a) {
    const other = b.get(k);
    if (other === undefined) removed.push(at(e));
    else if (other.hash !== e.hash) changed.push(at(e));
  }

  const byAddress = (x: ScopedEntity, y: ScopedEntity) =>
    x.id === y.id ? utf8Compare(x.scope, y.scope) : utf8Compare(x.id, y.id);
  added.sort(byAddress);
  removed.sort(byAddress);
  changed.sort(byAddress);
  return {
    equal: added.length === 0 && removed.length === 0 && changed.length === 0,
    added,
    removed,
    changed,
  };
}
