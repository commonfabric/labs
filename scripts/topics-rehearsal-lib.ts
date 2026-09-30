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
 * Three today: `mentionable` (the board's derived mention index),
 * `boardCrossrefs` (its reference pivot), and `boardNames` (its names table).
 * The mention index publishes display rows with stable strings and unread
 * member references, matching the wiring the board supplies when it creates a
 * topic.
 *
 * Adding a wiring input to the topic pattern means adding it here. Leaving it
 * out is not silent: `buildRestoreDocument` throws on any link-valued field it
 * does not recognize, because writing one as data would corrupt it and
 * dropping it would destroy it. The restore drill
 * (`packages/cli/integration/topics-restore-drill.sh`) is what turns that
 * throw into a failing check rather than a surprise mid-incident.
 *
 * A field stays here after the pattern stops declaring it, because whether it
 * is live is a fact about the TARGET rather than about the field's name — see
 * {@link RETIRABLE_LINK_FIELDS}.
 */
export const STRUCTURAL_LINK_SOURCES: Record<string, string> = {
  mentionable: "mentionable",
  boardCrossrefs: "crossrefs",
  boardNames: "namesTable",
};

export const STRUCTURAL_LINK_FIELDS = Object.keys(STRUCTURAL_LINK_SOURCES);

/**
 * Link-valued fields the topic pattern may no longer declare, which a restore
 * retires for a target that does not declare them and re-establishes for one
 * that does.
 *
 * The condition is the point. A restore runs against targets of two vintages
 * at once during a migration: one whose pattern still declares the field and
 * holds a live link there, and one already moved to a pattern without it.
 * Retiring by name alone deletes the first kind's working link — the apply
 * replaces the whole document, so a field left out of both lists is simply
 * gone — while re-linking the second kind's sends `cf piece link` at a path
 * its pattern does not have, which refuses after the apply has landed. So the
 * caller says which fields the target declares and this decides per target;
 * `buildRestoreDocument`'s `declaredLinks` is that answer.
 *
 * `myName` predates the agentName attribution and no pattern declares it.
 * `boardNames` named the board's table a topic read its number from, before a
 * topic stored its own.
 */
export const RETIRABLE_LINK_FIELDS = ["myName", "boardNames"] as const;

/**
 * Fields a restore carries forward from the LIVE piece rather than from the
 * export, when the export does not name them.
 *
 * `cf piece apply` replaces the whole document, so a field the export cannot
 * describe is removed by a restore that says nothing about it. For content
 * that is the intent — the export is the state being restored to. For a value
 * the piece owns permanently it is destruction: the export predates the field,
 * and no later run puts the value back.
 *
 * One today: `shortName`, the number the topic's board allocated. A number is
 * permanent and never reused, so the live value is the only right one, and a
 * restore that cleared it would leave the board's namespace pointing at a
 * topic that no longer knows its own number.
 */
export const PRESERVED_FIELDS = ["shortName"] as const;

/**
 * The {@link RETIRABLE_LINK_FIELDS} the TARGET declares —
 * `buildRestoreDocument`'s `declaredLinks`, decided by asking the target
 * rather than by the field's name or the export's vintage.
 *
 * Every retirable field is asked about, which is why the export is not a
 * parameter here. What the export carries bounds neither side of the
 * question: the apply replaces the whole document, so a field the export
 * never mentioned is gone from the target just as surely as one it mentioned
 * and neither list named. A restore runs against targets of two vintages at
 * once, and the export can be the newer of the two as easily as the older.
 *
 * `read` is a targeted read of the target's durable input at one field,
 * answering `undefined` where the read does not land. Anything else means the
 * target declares the path: a declared input carrying a default answers with
 * that default even when nothing is bound there — Topics' `boardNames` reads
 * `[]` for an unbound topic, which the 2026-09-05 clone rehearsal measured —
 * while a path the current pattern does not declare is refused outright.
 *
 * THE EXPORT'S OWN VINTAGE CANNOT DECIDE THIS, and neither can the pattern
 * identity matching. A topic migrated past an input keeps the stored link in
 * its raw argument document, unreachable through the new projection
 * (`packages/cli/test/piece-link-input-visibility.test.ts`), and an export
 * taken from it afterwards therefore holds a link at a path its own source
 * does not declare, with the identity matching. Reasoning from identity to
 * "declared" sends the restore to `cf piece link` against that path, which
 * refuses — after the content write has landed.
 *
 * The bound on the probe: a declared input that carries NO default and holds
 * nothing reads the same as an undeclared one, so it is reported here as
 * undeclared and retired. That direction is the safe one and costs nothing —
 * the target holds no value at such a path, so retiring it removes nothing —
 * and the run names every field it retired. The other direction ends the
 * restore with the document already replaced.
 */
export async function declaredRetirableLinks(
  read: (field: string) => Promise<unknown>,
): Promise<string[]> {
  const declared: string[] = [];
  for (const field of RETIRABLE_LINK_FIELDS) {
    if (await read(field) !== undefined) declared.push(field);
  }
  return declared;
}

/** What the target's current pattern declares and currently holds. */
export interface RestoreTarget {
  /**
   * The link-valued fields the target's CURRENT pattern declares. A
   * {@link RETIRABLE_LINK_FIELDS} entry named here is re-established; one not
   * named here is left retired. Omitted, every retirable field is retired,
   * which is the answer for a target already migrated past all of them.
   */
  declaredLinks?: readonly string[];

  /**
   * The target's live values at {@link PRESERVED_FIELDS}, for carrying
   * forward. A field absent here is one the target holds no value at.
   */
  preserved?: Record<string, unknown>;
}

export interface RestoreDocument {
  /** The complete input document a restore applies. */
  doc: Record<string, unknown>;

  /** Link fields present in the raw argument that the caller re-links. */
  structural: string[];

  /** Retirable link fields the target no longer declares, left retired. */
  legacy: string[];

  /** Preserved fields taken from the live piece because the export names
   * none, which a whole-document apply would otherwise remove. */
  carried: string[];
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
 *
 * `target` is what the same whole-document apply costs when the export and the
 * target are of different vintages, which it takes in both directions. A
 * retirable link field is re-established or left retired according to what the
 * target declares rather than its name — including one the export never named,
 * which the walk over the export cannot reach and the apply would therefore
 * erase; it is relinked from the board's path, or refused before the apply
 * where no board path re-establishes it. A {@link PRESERVED_FIELDS} value the
 * target holds and the export does not name is carried forward instead of
 * being written away. An export that names such a field with a different value
 * is refused: the fields are permanent, so two values mean the export and the
 * target are not the same piece, and guessing between them is not this
 * script's to do.
 */
export function buildRestoreDocument(
  rawArgument: Record<string, unknown>,
  resolved: { comments: unknown[]; links: unknown[] },
  target: RestoreTarget = {},
): RestoreDocument {
  const declared = target.declaredLinks ?? [];
  const doc: Record<string, unknown> = {};
  const structural: string[] = [];
  const legacy: string[] = [];
  const carried: string[] = [];
  for (const [field, value] of Object.entries(rawArgument)) {
    if (value === undefined) continue;
    const retirable = (RETIRABLE_LINK_FIELDS as readonly string[])
      .includes(field);
    if ((LINKED_ARRAY_FIELDS as readonly string[]).includes(field)) {
      doc[field] = resolved[field as (typeof LINKED_ARRAY_FIELDS)[number]];
    } else if (retirable && !declared.includes(field)) {
      // The target's pattern does not declare it, so there is nothing to
      // re-link to and the apply leaving it out is the whole retirement.
      legacy.push(field);
    } else if (
      (STRUCTURAL_LINK_FIELDS as readonly string[]).includes(field)
    ) {
      structural.push(field);
    } else if (retirable) {
      // Declared by the target but with no board path to re-link from, which
      // is the shape of a field retired on the board's side first. Reported
      // rather than written: it is a link, so the apply cannot carry it.
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
  // A retirable field the TARGET declares and the export never named. The walk
  // above cannot reach it — it walks the export — and the apply replaces the
  // whole document, so leaving it here is how a newer export erases an older
  // target's working link. The relink needs nothing from the export, because
  // it links to the board's own path.
  for (const field of declared) {
    if (Object.hasOwn(rawArgument, field)) continue;
    if (!(STRUCTURAL_LINK_FIELDS as readonly string[]).includes(field)) {
      throw new Error(
        `${field} is declared by the target and absent from the export, and ` +
          "no board path re-establishes it; applying this document would " +
          "destroy a link nothing can put back",
      );
    }
    structural.push(field);
  }
  for (const field of PRESERVED_FIELDS) {
    const live = target.preserved?.[field];
    if (live === undefined) continue;
    const exported = doc[field];
    if (exported === undefined) {
      doc[field] = live;
      carried.push(field);
    } else if (!deepEqual(exported, live)) {
      throw new Error(
        `${field} is ${JSON.stringify(live)} on the target and ` +
          `${JSON.stringify(exported)} in the export; it is permanent, so ` +
          "the two are not the same piece and this restore will not choose " +
          "between them",
      );
    }
  }
  return { doc, structural, legacy, carried };
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
