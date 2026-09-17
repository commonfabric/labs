/**
 * Shared plumbing for the Topics content export/restore pair
 * (`topics-export.ts`, `topics-restore.ts`) — the field vocabulary and the
 * pure functions both sides agree on, plus the `cf` helpers below.
 *
 * The two halves reach their space differently, because they are asking
 * different questions. A restore writes to a LIVE server, which only the CLI
 * can address, so it shells out to `cf` and tracks that contract — the surface
 * the rehearsal runbook already teaches. An export reads an offline snapshot
 * thousands of entities deep, where a subprocess per read costs a `deno task`
 * resolution and a fresh open of a multi-gigabyte database each time, so it
 * opens the store once through `@commonfabric/state-inspector` and uses none
 * of the `cf` helpers here.
 *
 * Because both sides import this file, it carries the narrower side's
 * permissions: nothing here may reach the store reader, whose barrel costs
 * every importer `--allow-ffi` at module load and would make the restore's
 * shebang a lie. That half lives in `topics-snapshot-lib.ts`, which only the
 * export imports, and the test file holds a check that it stayed there.
 */

import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

export const repoRoot = new URL("..", import.meta.url).pathname;

/** Run `cf` from the repository root and return stdout; throw on failure. */
export async function cf(args: string[]): Promise<string> {
  const command = new Deno.Command("deno", {
    args: ["task", "--quiet", "cf", ...args],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const out = new TextDecoder().decode(stdout);
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(
      `cf ${args.join(" ")} exited ${code}\n${err.trim() || out.trim()}`,
    );
  }
  return out;
}

/** Run `cf` and parse its stdout as JSON. */
export async function cfJson<T>(args: string[]): Promise<T> {
  const out = await cf(args);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Error(
      `cf ${args.join(" ")} did not return JSON:\n${out.slice(0, 500)}`,
    );
  }
}

/** Run `cf piece apply` with a JSON input document on stdin. Apply REPLACES
 * the piece's whole input document (measured in the restore drill — a
 * partial document zeroes every field it omits), so callers pass the
 * complete document, never a fragment. */
export async function cfApply(
  addr: string[],
  inputDoc: Record<string, unknown>,
): Promise<void> {
  const command = new Deno.Command("deno", {
    args: ["task", "--quiet", "cf", "piece", "apply", "-q", ...addr],
    cwd: repoRoot,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(inputDoc)));
  await writer.close();
  const { code, stderr } = await child.output();
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(
      `cf piece apply ${addr.join(" ")} exited ${code}\n${err.trim()}`,
    );
  }
}

/**
 * Whether a `cf` failure says the path is not in the document, as opposed to
 * a read that never landed.
 *
 * The restore reads absence as "the current schema retired this field" and
 * forgives it, so absence has to mean absence. An unreachable server, a
 * refused space, or a `cf` that printed something other than JSON also fail
 * the read, and reading those as retirement would forgive every field at once
 * and report a clean restore over a write nobody checked — a worse lie than
 * the false alarm the retirement rule exists to remove.
 *
 * The runtime spells a missing property one way (`resolveCellPath` in
 * `packages/runner/src/piece-helpers.ts`, which keeps the distinction between
 * an absent field and a schema-valid `undefined` one), and the CLI already
 * keys on that phrasing to report it as a data error rather than a usage
 * failure (`isPieceGetDataError`). Wording the runtime changes fails this
 * test, which fails the restore loudly — the safe direction of the two.
 */
export function isAbsentPathError(error: unknown): boolean {
  return error instanceof Error &&
    /Cannot access path "[^"]*" - property "[^"]*" not found/.test(
      error.message,
    );
}

/**
 * The path {@link retiredKeys} reports when the live read does not surface the
 * compared value AT ALL, rather than a key inside it — the root node, spelled
 * as {@link findLink} spells it.
 *
 * A migration that retires a whole top-level field leaves no key inside a
 * record to name, so absence has to be sayable about the value itself. It is
 * read as the whole value only at the root, where no key path reaches — save
 * for a top-level key spelled `$` itself, which the runtime's sigil
 * vocabulary (`$link`, `$UI`) never produces and `findLink` refuses anyway.
 */
export const WHOLE_VALUE = "$";

/**
 * Keys the export carries that the live read does not surface at all.
 *
 * A restore across a migration writes content recorded under the OLD pattern
 * and reads it back through the NEW one, so a field the new schema retired
 * comes back absent however faithfully it was written. Comparing the two
 * whole then reports every comment-bearing topic as damaged, which trains an
 * operator to ignore the one signal that matters during an incident.
 *
 * Absence is the discriminator, and it is a sound one: a field the schema
 * still declares reads back present — as its value, its default, or null —
 * even when the data behind it was lost, so real loss shows up as a
 * DIFFERENCE rather than as a gap. Only a field the schema no longer declares
 * disappears entirely.
 *
 * A retired field that was a scalar or an object disappears the same way, but
 * with no surviving record to be missing from: the whole compared value is
 * gone. That is {@link WHOLE_VALUE}, and it is the only place `undefined` is
 * read as absence — a live read that landed carries `null` for a declared but
 * empty field, and the caller is responsible for not handing a read that
 * never landed to this function at all.
 */
export function retiredKeys(
  expected: unknown,
  actual: unknown,
  path = "",
): string[] {
  if (path === "" && actual === undefined) {
    return expected === undefined ? [] : [WHOLE_VALUE];
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const out: string[] = [];
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
      out.push(...retiredKeys(expected[i], actual[i], `${path}[]`));
    }
    return [...new Set(out)];
  }
  if (!isPlainRecord(expected) || !isPlainRecord(actual)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    const where = path === "" ? key : `${path}.${key}`;
    if (!(key in actual)) out.push(where);
    else out.push(...retiredKeys(value, actual[key], where));
  }
  return [...new Set(out)];
}

/** `expected` with every path in `retired` removed, for comparison. A retired
 * {@link WHOLE_VALUE} removes the value itself, which is `undefined` — what
 * {@link deepEqual} already treats as equal to an absent live read. */
export function withoutKeys(
  expected: unknown,
  retired: ReadonlySet<string>,
  path = "",
): unknown {
  if (path === "" && retired.has(WHOLE_VALUE)) return undefined;
  if (Array.isArray(expected)) {
    return expected.map((v) => withoutKeys(v, retired, `${path}[]`));
  }
  if (!isPlainRecord(expected)) return expected;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(expected)) {
    const where = path === "" ? key : `${path}.${key}`;
    if (retired.has(where)) continue;
    out[key] = withoutKeys(value, retired, where);
  }
  return out;
}

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  isObjectNotArray(v);

/** The authored scalar fields of a topic's argument document. Everything a
 * restore may write and nothing else: `myName` is per-user state and
 * `mentionable` is a structural link into the board, so neither is content. */
export const SCALAR_CONTENT_FIELDS = [
  "title",
  "body",
  "createdAt",
  "createdBy",
  "createdByName",
  "bodyUpdatedAt",
  "bodyUpdatedBy",
] as const;

/** The authored array fields whose elements the store keeps as links to
 * their own entities, so an export must resolve each element. */
export const LINKED_ARRAY_FIELDS = ["comments", "links"] as const;

export type TopicContent =
  & {
    [K in (typeof SCALAR_CONTENT_FIELDS)[number]]?: unknown;
  }
  & { comments: unknown[]; links: unknown[] };

export interface TopicExportRow {
  fid: string;
  patternIdentity: string;
  argumentId: string;
  content: TopicContent;

  /** The argument document exactly as stored, links unresolved — the
   * forensic copy. Restore consumes `content`, never this. */
  rawArgument: unknown;
}

export interface TopicsExport {
  version: 1;
  exportedAt: string;
  snapshot: string;
  spaceDid: string | null;
  board: {
    fid: string;
    patternIdentity: string;
    argumentId: string;

    /** Stored membership links of the board's `topics` array, in order —
     * evidence of membership and order, never a restore payload. */
    topicsLinks: unknown[];
  } | null;
  topics: TopicExportRow[];

  /** Every piece in the snapshot, so "did I select the right ones?" is
   * answerable from the export alone. */
  manifest: { fid: string; patternIdentity: string; resultKeys: string[] }[];
}

/**
 * The link-valued argument fields a restore re-establishes with
 * `cf piece link` rather than writing as data, mapped to the board path each
 * one points at. A document write cannot carry a `$link`, so these are routed
 * aside and re-linked after the apply.
 *
 * Two today: `mentionable` (the board's derived mention index) and
 * `boardCrossrefs` (its reference pivot). The mention index publishes display
 * rows with stable strings and unread member references, matching the wiring
 * the board supplies when it creates a topic.
 *
 * Adding a wiring input to the topic pattern means adding it here. Leaving it
 * out is not silent: `buildRestoreDocument` throws on any link-valued field it
 * does not recognize, because writing one as data would corrupt it and
 * dropping it would destroy it. The restore drill
 * (`packages/cli/integration/topics-restore-drill.sh`) is what turns that
 * throw into a failing check rather than a surprise mid-incident.
 */
export const STRUCTURAL_LINK_SOURCES: Record<string, string> = {
  mentionable: "mentionable",
  boardCrossrefs: "crossrefs",
};

export const STRUCTURAL_LINK_FIELDS = Object.keys(STRUCTURAL_LINK_SOURCES);

/**
 * Retired link-valued fields, recognized so that a restore sets one aside by
 * name rather than reaching the unknown-link throw below.
 *
 * A field belongs here once the topic pattern stops declaring it, and moving
 * it is not cosmetic: a retired field left in `STRUCTURAL_LINK_SOURCES` sends
 * the restore to `cf piece link` against a path the pattern no longer has,
 * which refuses — after the apply has already landed. `boardNames` is here
 * because a topic stores the number its board calls it by rather than reading
 * a table for it, so an export taken before that carries a link this restore
 * leaves retired.
 */
export const LEGACY_LINK_FIELDS = ["myName", "boardNames"] as const;

export interface RestoreDocument {
  /** The complete input document a restore applies. */
  doc: Record<string, unknown>;

  /** Link fields present in the raw argument that the caller re-links. */
  structural: string[];

  /** Deprecated link fields present in the raw argument, left retired. */
  legacy: string[];
}

/**
 * The document a restore writes, built from the export's raw argument rather
 * than from a fixed field list: `cf piece apply` replaces the whole document,
 * so a field a list failed to name would be zeroed by the restore — a schema
 * that has since grown a field must not lose it to an older script. Every
 * plain-valued field is carried verbatim; the linked arrays take their
 * resolved values; the known link fields are reported for the caller to
 * handle; and an unrecognized link-valued field throws, because writing it as
 * data would corrupt it and dropping it would destroy it.
 */
export function buildRestoreDocument(
  rawArgument: Record<string, unknown>,
  resolved: { comments: unknown[]; links: unknown[] },
): RestoreDocument {
  const doc: Record<string, unknown> = {};
  const structural: string[] = [];
  const legacy: string[] = [];
  for (const [field, value] of Object.entries(rawArgument)) {
    if (value === undefined) continue;
    if ((LINKED_ARRAY_FIELDS as readonly string[]).includes(field)) {
      doc[field] = resolved[field as (typeof LINKED_ARRAY_FIELDS)[number]];
    } else if ((STRUCTURAL_LINK_FIELDS as readonly string[]).includes(field)) {
      structural.push(field);
    } else if ((LEGACY_LINK_FIELDS as readonly string[]).includes(field)) {
      legacy.push(field);
    } else {
      const linkPath = findLink(value);
      if (linkPath) {
        throw new Error(
          `${field} holds a link at ${linkPath} and this restore does not ` +
            "understand it; writing it as data would corrupt it and " +
            "dropping it would destroy it",
        );
      }
      doc[field] = value;
    }
  }
  return { doc, structural, legacy };
}

/** The path below any node where a `$link` marker appears, or null. Used to
 * refuse an export that would silently record a reference as content. */
export function findLink(node: unknown, path = "$"): string | null {
  if (!isObjectOrArray(node)) return null;
  if (Object.hasOwn(node, "$link")) return path;
  for (const [key, value] of Object.entries(node)) {
    const hit = findLink(value, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

/** Structural equality over JSON values; `undefined` equals absent. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) {
    return false;
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a).filter((k) =>
    (a as Record<string, unknown>)[k] !== undefined
  );
  const keysB = Object.keys(b).filter((k) =>
    (b as Record<string, unknown>)[k] !== undefined
  );
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    )
  );
}

/** Normalize any accepted piece spelling to its bare `of:fid1:…` id. */
export function normalizeFid(ref: string): string {
  let id = ref.trim();
  if (id.startsWith("/")) id = id.slice(1);
  const hash = id.indexOf("#");
  if (hash >= 0) id = id.slice(0, hash);
  if (id.startsWith("fid1:")) id = `of:${id}`;
  return id;
}
