/**
 * Fingerprints durable values across every visible scope using the runtime's
 * canonical value hash. Compiler-generated cells are excluded by default
 * because pattern updates rotate their identities. Exclusions, ambiguous
 * causes, and unhashable values travel with the report so a caller can qualify
 * what an equal hash establishes.
 */

import { type FabricValue, hashOf } from "@commonfabric/data-model";
import { LRUCache } from "@commonfabric/utils/cache";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { utf8Compare } from "@commonfabric/utils/utf8";

import type { SpaceDb } from "./db.ts";
import {
  absentEntity,
  classifyDocument,
  type DocumentReader,
  entityKinds,
  scanLimit,
  spaceDocumentReader,
  visibleEntityRowsByScope,
} from "./model.ts";
import {
  type EntityAddress,
  type EntityDocument,
  type ReconstructOutcome,
  reconstructOutcome,
} from "./reconstruct.ts";
import { scopesOfRows } from "./scopes.ts";

/** Per-scope enumeration bound; exceeding it refuses the entire fingerprint. */
const ENUMERATION_CAP = 1_000_000;

/**
 * Which way of fingerprinting a space this module implements.
 *
 * A clone records the scheme its baseline was computed under, and a verify
 * refuses to compare that baseline with a working copy fingerprinted under
 * another: the two hashes would differ for reasons that have nothing to do with
 * the content, or agree when the content did not. Raise it whenever a change
 * would give the same stored content a different fingerprint — what is hashed,
 * how a value hashes, or which entities are excluded.
 */
export const FINGERPRINT_SCHEME = 1;

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
   * Visits every primary reconstruction, including generated and unreadable
   * records, after capturing fingerprint evidence. Related-document lookups do
   * not invoke this callback. The store must remain unchanged during the scan.
   */
  onEntity?: (at: ScopedEntity, outcome: ReconstructOutcome) => void;

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
  const { generated, named } = fingerprintScanner(space, options, false).scan();
  return { generated, named };
}

/** One entity's compact evidence, retained after its document is released. */
interface FingerprintEntry {
  /** Address and classification reported by the model. */
  entity: EntityFingerprint;

  /** Value-hashing failure, reported only for included entities. */
  unhashable?: string;

  /** Decode failure, thrown only when the entity is included. */
  unreadable?: { error: unknown };
}

/** Collects one document's fingerprint evidence using this store's related reads. */
function fingerprintEntry(
  at: ScopedEntity,
  outcome: ReconstructOutcome,
  readDocument: DocumentReader,
  options: FingerprintOptions,
  hashValues: boolean,
) {
  const doc = outcome.status === "present" ? outcome.document : undefined;
  const kind = outcome.status === "present"
    ? classifyDocument(outcome.document, { id: at.id, readDocument }).kind
    : absentEntity(outcome.status).kind;
  const entry: FingerprintEntry = {
    entity: { id: at.id, scope: at.scope, kind, hash: null },
  };
  if (outcome.status === "undecodable") {
    entry.unreadable = { error: outcome.error };
  }
  if (hashValues && doc?.value !== undefined) {
    const hashed = hashEntityValue(doc.value);
    if ("error" in hashed) entry.unhashable = hashed.error;
    else entry.entity.hash = hashed.hash;
  }
  const causes: { id: string; generated: boolean }[] = [];
  if (
    !options.includeGenerated && kind === "piece" &&
    Array.isArray(doc?.internal)
  ) {
    for (const member of doc.internal) {
      const id = manifestLinkId(member);
      if (id !== undefined && isObjectOrArray(member)) {
        causes.push({
          id,
          generated: isGeneratedCause(member.partialCause),
        });
      }
    }
  }
  return { entry, causes, kind };
}

/**
 * Collects compact evidence while reading documents, then completes the scan
 * over its independent revision enumeration. Classification errors are deferred
 * to enumeration order; errors from final inclusion checks follow listing order.
 */
function fingerprintScanner(
  space: SpaceDb,
  options: FingerprintOptions,
  hashValues: boolean,
) {
  const branch = options.branch ?? "";

  /** Evidence or an error to surface when the scan reaches this address. */
  type Captured =
    | { evidence: ReturnType<typeof fingerprintEntry> }
    | { error: unknown };

  const captured = new Map<string, Map<string, Captured>>();
  let relatedScope: string | undefined;
  let relatedReader: DocumentReader;
  const related = new LRUCache<
    string,
    { document: EntityDocument | undefined }
  >({ capacity: 256 });

  /** Reads this scope's owners and space-scoped schemas through a bounded cache. */
  const readDocument: DocumentReader = (id) => {
    let hit = related.get(id);
    if (hit === undefined) {
      hit = { document: relatedReader(id) };
      related.put(id, hit);
    }
    return hit.document;
  };

  /** Reads a primary document and collects its evidence before notifying callers. */
  const visit = (
    at: Pick<ScopedEntity, "id" | "scope">,
  ): { outcome: ReconstructOutcome; result: Captured } => {
    const address = { id: at.id, scope: at.scope, branch };
    const outcome = reconstructOutcome(space, address);
    if (relatedScope !== at.scope) {
      related.clear();
      relatedScope = at.scope;
      relatedReader = spaceDocumentReader(space, { branch, scope: at.scope });
    }
    let result: Captured;
    try {
      result = {
        evidence: fingerprintEntry(
          at,
          outcome,
          readDocument,
          options,
          hashValues,
        ),
      };
    } catch (error) {
      result = { error };
    }
    options.onEntity?.(address, outcome);
    return { outcome, result };
  };

  /** Retains a caller's primary read as compact evidence for the scan. */
  const read = (
    at: Pick<ScopedEntity, "id" | "scope">,
  ): ReconstructOutcome => {
    const { outcome, result } = visit(at);
    let scoped = captured.get(at.scope);
    if (scoped === undefined) captured.set(at.scope, scoped = new Map());
    scoped.set(at.id, result);
    return outcome;
  };

  /** Completes every scope, including addresses the caller never read. */
  const scan = () => {
    const cap = options.enumerationCap ?? ENUMERATION_CAP;
    const rowsByScope = visibleEntityRowsByScope(space, { branch });
    const entries: FingerprintEntry[] = [];
    const generated = new Set<string>();
    const named = new Set<string>();
    for (const scope of scopesOfRows(rowsByScope)) {
      const rows = rowsByScope.get(scope.raw) ?? [];
      if (rows.length > scanLimit(cap)) {
        throw new Error(
          `scope ${scope.raw} holds ${rows.length} entities, past the ` +
            `${cap} cap; refusing to fingerprint a truncated enumeration.`,
        );
      }
      const scoped = rows.map((row) => {
        const result = captured.get(scope.raw)?.get(row.id) ??
          visit({ id: row.id, scope: scope.raw }).result;
        if ("error" in result) throw result.error;
        return { ...result.evidence, revisions: row.revisions };
      });
      captured.delete(scope.raw);
      // Match listing order for diagnostics and exclusions. Each store uses
      // its own revision counts even when its documents compare equal.
      scoped.sort((a, b) =>
        entityKinds.indexOf(a.kind) - entityKinds.indexOf(b.kind) ||
        b.revisions - a.revisions
      );
      for (const { entry, causes } of scoped) {
        if (hashValues) entries.push(entry);
        for (const cause of causes) {
          (cause.generated ? generated : named).add(cause.id);
        }
      }
    }
    captured.clear();
    related.clear();
    return { entries, generated, named };
  };

  return { read, scan };
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
  return fingerprintReader(space, options).finish();
}

/**
 * Reads documents at the configured branch's head while retaining compact
 * fingerprint evidence. `finish()` enumerates every visible revision address,
 * reads any not yet visited, and applies globally collected manifest causes.
 * The store must remain unchanged until `finish()` returns. Primary document
 * bodies are returned to the caller, never retained by this reader.
 */
export function fingerprintReader(
  space: SpaceDb,
  options: FingerprintOptions = {},
): {
  /** Reads a document and captures its fingerprint evidence for `finish()`. */
  read(at: Pick<ScopedEntity, "id" | "scope">): ReconstructOutcome;

  /** Completes the fingerprint, reporting errors in enumeration/listing order. */
  finish(): FingerprintReport;
} {
  const scanner = fingerprintScanner(space, options, true);
  return {
    read: scanner.read,
    finish: () => finishFingerprint(scanner.scan()),
  };
}

/** Applies the global exclusions and rolls up a completed scan's evidence. */
function finishFingerprint(
  { entries, generated, named }: ReturnType<
    ReturnType<typeof fingerprintScanner>["scan"]
  >,
): FingerprintReport {
  const ambiguous = [...generated].filter((id) => named.has(id)).sort(
    utf8Compare,
  );
  const perEntity: EntityFingerprint[] = [];
  const unhashable: { id: string; reason: string }[] = [];
  const excludedGeneratedAddresses: ScopedEntity[] = [];

  for (const { entity, unreadable, unhashable: reason } of entries) {
    if (generated.has(entity.id)) {
      excludedGeneratedAddresses.push({ id: entity.id, scope: entity.scope });
      continue;
    }
    if (unreadable !== undefined) throw unreadable.error;
    if (reason !== undefined) {
      unhashable.push({ id: entity.id, reason });
      continue;
    }
    perEntity.push(entity);
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
