// Local space-DB discovery — so callers never have to hand-feed absolute
// sqlite paths. Finds memory v2 space DBs from env overrides and from the known
// on-disk cache layouts, walking up from the working directory.
//
// On-disk layout (verified): `<root>/{packages/toolshed/,}cache/memory/engine-v3/
// engine-v3/<did>.sqlite`. The engine-v3 segment is sometimes doubled, so we
// walk a bounded depth under each cache base rather than assume a fixed path.

import * as Path from "@std/path";

import { Identity } from "@commonfabric/identity";
import { assertNotDID, isDID } from "@commonfabric/identity/did";
import { configuredStorePath } from "@commonfabric/memory/v2/storage-path";

import { openSpace } from "./db.ts";
import { rootCacheDir } from "./remote.ts";

// A named space's DID is reproducibly derived by the runtime from its name:
// `Identity.fromPassphrase("common user").derive(<name>)` (see
// `packages/identity/src/session.ts` `createSession`). The shell addresses a
// space by name (`/<space-name>/…`); we mirror that derivation so
// `cf inspect <name>` resolves the same DB the runtime would, without anyone
// copying a DID around.
//
// The derivation supports the legacy space names used during development, and
// nothing else. It is removed once those development-only spaces have been
// migrated; `docs/plans/random-space-identities.md` carries the migration.
const SPACE_ROOT_PASSPHRASE = "common user";
let spaceRoot: Promise<Identity> | undefined;

/** Derive the DID of a NAMED space, the same way the runtime does. */
export async function deriveSpaceDid(name: string): Promise<string> {
  assertNotDID(name, "A space name");
  spaceRoot ??= Identity.fromPassphrase(SPACE_ROOT_PASSPHRASE);
  const space = await (await spaceRoot).derive(name);
  return space.did();
}

export interface DiscoveredSpace {
  /** Space DID (DB file basename without `.sqlite`). */
  did: string;

  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

function* walkSqlite(dir: string, depth: number): Generator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return; // missing/unreadable dir
  }
  for (const e of entries) {
    // `Path.join` rather than a separator between the two: `dir` may be a store
    // location as its configuration spelled it, trailing separator and all, and
    // an empty segment in the middle of every path this yields would reach every
    // caller that reports one.
    const full = Path.join(dir, e.name);
    if (e.isFile && e.name.endsWith(".sqlite")) yield full;
    else if (e.isDirectory && depth > 0) yield* walkSqlite(full, depth - 1);
  }
}

/** Candidate cache directories to search, in priority order. */
export function candidateRoots(cwd: string = Deno.cwd()): string[] {
  const roots: string[] = [];
  // Both variables name their store the way the server was configured, which
  // for MEMORY_DIR is a URL wherever the server itself reads it. What follows
  // walks the filesystem, so each becomes a path first.
  const env = Deno.env.get("MEMORY_DIR");
  if (env) roots.push(configuredStorePath(env));
  const dbPath = Deno.env.get("DB_PATH");
  if (dbPath) {
    const dbStore = configuredStorePath(dbPath);
    roots.push(
      dbStore.endsWith(".sqlite") ? Path.dirname(dbStore) : dbStore,
    );
  }
  // Spaces pulled from a remote (`cf inspect --remote` / `pull`) land here.
  roots.push(rootCacheDir());
  // Walk up from cwd; check both cache layouts at each level.
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    roots.push(Path.join(dir, "packages", "toolshed", "cache", "memory"));
    roots.push(Path.join(dir, "cache", "memory"));
    const parent = Path.dirname(dir);
    // A root is its own parent, which is where the walk stops.
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/**
 * Discover local space DBs. `dirs` are searched before the default roots.
 * `defaultRoots: false` searches ONLY `dirs`, skipping env overrides, the
 * remote-pull cache, and the cwd walk — tests need this to stay hermetic on
 * machines whose real `~/.cache/cf-inspect` holds pulled DBs.
 */
export function discoverSpaceDbs(
  opts: { dirs?: string[]; cwd?: string; defaultRoots?: boolean } = {},
): DiscoveredSpace[] {
  const roots = [
    ...(opts.dirs ?? []),
    ...(opts.defaultRoots === false ? [] : candidateRoots(opts.cwd)),
  ];
  const seen = new Set<string>();
  const out: DiscoveredSpace[] = [];
  for (const root of roots) {
    for (const path of walkSqlite(root, 4)) {
      let real: string;
      try {
        real = Deno.realPathSync(path);
      } catch {
        real = path;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      let stat: Deno.FileInfo;
      try {
        stat = Deno.statSync(path);
      } catch {
        continue;
      }
      out.push({
        did: Path.basename(path, ".sqlite"),
        path,
        sizeBytes: stat.size,
        mtimeMs: stat.mtime?.getTime() ?? 0,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Resolve a space token (a DID / DID-prefix, or a path) to a DB file path.
 * Paths win if they exist; otherwise the token is matched against discovered
 * DIDs (exact, then substring). Throws on no/ambiguous match.
 */
export function resolveSpacePath(
  token: string,
  discovered?: DiscoveredSpace[],
): string {
  if (token.endsWith(".sqlite") || token.includes("/")) {
    try {
      Deno.statSync(token);
      return token;
    } catch {
      // not a real path — fall through to DID matching
    }
  }
  const spaces = discovered ?? discoverSpaceDbs();
  const exact = spaces.filter((s) => s.did === token);
  const matches = exact.length
    ? exact
    : spaces.filter((s) => s.did.includes(token));
  if (matches.length === 1) return matches[0].path;
  if (matches.length === 0) {
    throw new Error(`no space matches "${token}" (run: inspect spaces)`);
  }
  throw new Error(
    `"${token}" is ambiguous (${matches.length} matches); use a longer prefix or a path`,
  );
}

/**
 * Resolve a space token to a DB path, accepting a space NAME in addition to a
 * DID / DID-prefix / path. Tries the synchronous matcher first (path/DID); only
 * if that finds nothing AND the token looks like a name (not a path, not already
 * `did:`-shaped) does it derive the name's DID via {@link deriveSpaceDid} and
 * match that. Async because the derivation uses the identity keypair.
 *
 * Precedence: a path / DID / DID-prefix match always WINS over name derivation,
 * so a token that is a substring of a discovered DID resolves to that DB and is
 * never treated as a name. Harmless in practice — space names (e.g.
 * `2026-06-29-ben`) are never DID-shaped — and a name can never shadow a DID.
 */
export async function resolveSpace(
  token: string,
  discovered?: DiscoveredSpace[],
): Promise<string> {
  const spaces = discovered ?? discoverSpaceDbs();
  try {
    return resolveSpacePath(token, spaces);
  } catch (err) {
    const looksLikeName = !token.includes("/") &&
      !token.endsWith(".sqlite") && !isDID(token);
    if (!looksLikeName) throw err;
    const did = await deriveSpaceDid(token);
    const match = spaces.find((s) => s.did === did);
    if (match) return match.path;
    throw new Error(
      `no space matches "${token}" — as a name it derives to ${did}, ` +
        `but no local DB for that DID was found (run: inspect spaces)`,
    );
  }
}

export interface SpaceQuickStats {
  commits: number;
  entities: number;
  lastActivity: string | null;
}

/** Cheap one-query stats for listing many DBs without a full summary. */
export function quickStats(path: string): SpaceQuickStats | null {
  let space;
  try {
    space = openSpace(path);
  } catch {
    return null;
  }
  try {
    const row = space.db
      .prepare(
        `SELECT
           (SELECT count(*) FROM "commit") AS commits,
           (SELECT count(DISTINCT id) FROM revision) AS entities,
           (SELECT max(created_at) FROM "commit") AS lastActivity`,
      )
      .get<
        { commits: number; entities: number; lastActivity: string | null }
      >();
    return row
      ? {
        commits: row.commits,
        entities: row.entities,
        lastActivity: row.lastActivity,
      }
      : null;
  } catch {
    return null; // not a memory v2 space DB
  } finally {
    space.close();
  }
}
