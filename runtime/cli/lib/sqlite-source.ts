// Phase 7 — `cf piece link <piece>/<field> sqlite:<absPath>` source parsing +
// deterministic handle-id derivation (read-only on-disk SQLite source, v1).
//
// These are pure helpers (no I/O) so they unit-test in isolation. The link
// action (lib/piece.ts `linkSqliteDiskSource`) uses them to: derive a stable
// handle id from (space, absPath), create the handle cell at that id, register
// the on-disk source with the server, and link it into the target field.

import { createRef } from "@commonfabric/runner";
import { isObjectNotArray } from "@commonfabric/utils/types";

const SQLITE_SCHEME = "sqlite:";

export interface SqliteDiskSource {
  /** Absolute path to the on-disk SQLite file. */
  path: string;
}

/**
 * Recognize a `sqlite:<absPath>` link source. Returns `null` for any non-`sqlite:`
 * ref (so the caller falls back to the normal piece/path parse), and throws on a
 * malformed `sqlite:` ref (empty or non-absolute path) — those are operator
 * mistakes, not "not a sqlite source".
 */
export function parseSqliteSource(ref: string): SqliteDiskSource | null {
  if (!ref.startsWith(SQLITE_SCHEME)) return null;
  const path = ref.slice(SQLITE_SCHEME.length);
  if (path.length === 0) {
    throw new Error(
      `sqlite: source is missing a path (expected sqlite:/abs/path.db)`,
    );
  }
  if (!path.startsWith("/")) {
    throw new Error(
      `sqlite: source path must be absolute, got "${path}" (expected sqlite:/abs/path.db)`,
    );
  }
  return { path };
}

/**
 * Derive a stable handle id from `(space, absPath)`. Linking the same path in the
 * same space twice resolves to the same handle cell (idempotent). The returned
 * string is used BOTH as the handle cell's entity id (where cf creates it) and as
 * the db handle `value.id` (what `db.query`/`db.exec` send, and the key the server
 * disk-source registry is keyed by) — keeping them identical means a pattern read
 * of the linked handle resolves to the same id the server has a descriptor for.
 */
export function deriveDiskHandleId(space: string, absPath: string): string {
  const ref = createRef({ disk: { path: absPath } }, {
    space,
    scheme: "sqlite",
  });
  // The canonical id string is the tagged-hash form, matching
  // `entityRefToString(handle.entityId)` — the form the runtime uses for a db
  // handle's `value.id`.
  return ref.taggedHashString;
}

/** The stored shape of an injected on-disk source's handle cell. */
export interface DiskHandleValue {
  id: string;
  tables?: Record<string, unknown>;
  scope?: string;
  owner?: string;
  rev?: number;
}

/**
 * A plain, inline copy of a stored contract: `{}` for a value that is not an
 * object (it declares no labels, so there is nothing to keep), and a THROW for
 * an object that cannot be copied.
 *
 * The caller reads `prior` off a live cell, so `tables` can be a proxy over
 * stored data. A handle's contract must be written INLINE — a query-side load
 * resolves no links inside it — so the value that goes back is a materialized
 * copy rather than the proxy itself. A copy that fails is not an empty
 * contract: writing `{}` in its place would lower every column's read label
 * to nothing, silently, so the repair refuses instead.
 */
function inlineTables(id: string, tables: unknown): Record<string, unknown> {
  if (!isObjectNotArray(tables)) {
    return {};
  }
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(tables));
  } catch (err) {
    throw new Error(
      `cf piece link: the contract on handle ${id} cannot be copied, so the ` +
        `handle is left as it stands rather than re-seeded without its ` +
        `labels: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isObjectNotArray(copy)) {
    throw new Error(
      `cf piece link: the contract on handle ${id} did not copy as an ` +
        `object, so the handle is left as it stands rather than re-seeded ` +
        `without its labels`,
    );
  }
  return copy as Record<string, unknown>;
}

/**
 * The handle value a link action should write for the on-disk source at `id`,
 * or `undefined` to leave an already-committed handle exactly as it stands.
 *
 * A first link seeds an EMPTY contract: v1 does not migrate external files, so
 * the on-disk db owns its schema and the server skips `ensureTables` for a
 * registered source. A RE-link must not re-seed that empty contract over a
 * handle whose `tables` someone has since declared. `tables[].ifc` carries the
 * per-column read labels, and a store's effective label is monotone (§8.12.1) —
 * it may strengthen, never weaken. Overwriting a declared contract with `{}`
 * lowers every column's read label to nothing, and because a contract-less
 * query still returns its rows (`labelResultSchema` labels nothing rather than
 * refusing), the downgrade is silent: same rows, no label, no error.
 *
 * The handle's other fields are as fixed as its labels. `owner` resolves
 * `dbOwner()` row admission, `scope` partitions the db, and `rev` is what every
 * handle hasher reads to decide a query has new inputs — so a re-link that
 * dropped them would rotate row admission and re-issue every live query.
 * Preserving the whole prior value keeps all four properties together.
 */
export function diskHandleSeed(
  id: string,
  prior: DiskHandleValue | undefined,
): DiskHandleValue | undefined {
  // "Committed" is decided by the handle's own `id` BEING the one this
  // (space, path) derives — not by the doc being present, and not by the field
  // merely holding a string. A doc holding `null`, a partial value with no
  // `id`, an empty string, or an id that names a different source is not a
  // handle any query can use: `readDbRef` refuses a value whose `id` is not a
  // string, and an id that does resolve reaches another source's registry
  // entry. Treating any of them as committed leaves the link pointing at a
  // handle that can never resolve this file, and nothing re-seeds it.
  if (prior?.id === id) return undefined;

  // A repair rewrites the one field this function can derive. What else it
  // keeps depends on what the stored `id` says about where the value came
  // from. No id at all (or an empty one) is THIS path's handle with its
  // derived field missing, and every other field is preserved — dropping one
  // is the direction that loses something, as the re-link rule above says. An
  // id that names ANOTHER source means the value was written for a handle
  // that is not this one, and only the labels come across: carrying a
  // declared `tables` can at most over-label, which monotonicity permits,
  // while `owner` (row admission), `scope` (the db partition) and `rev` (a
  // count of a source this handle never was) are not labels, and carrying
  // them is not the safe direction. They start fresh. A `tables` that is not
  // an object declares no labels and is not worth carrying either way; one
  // that cannot be copied refuses the repair rather than writing `{}`.
  const seed: DiskHandleValue = {
    id,
    tables: inlineTables(id, prior?.tables),
    rev: 0,
  };
  const foreign = typeof prior?.id === "string" && prior.id !== "";
  if (foreign) return seed;
  if (typeof prior?.rev === "number") seed.rev = prior.rev;
  if (typeof prior?.scope === "string") seed.scope = prior.scope;
  if (typeof prior?.owner === "string") seed.owner = prior.owner;
  return seed;
}
