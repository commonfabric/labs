#!/usr/bin/env -S deno run --allow-run --allow-read --allow-env

/**
 * Restore one topic's authored content from a `topics-export.ts` export,
 * against a live server — never through verbs, which stamp their own write
 * time and author and would falsify every timestamp and attribution being
 * restored. Writes land in the same piece, so identity and every crossref
 * edge survive.
 *
 * Usage:
 *   scripts/topics-restore.ts <export.json> --piece <fid>
 *     [--api-url <url>] [--space <did>] [--dry-run]
 *     [--allow-identity-mismatch]
 *
 * CF_API_URL and CF_IDENTITY are honored as everywhere else; --space
 * defaults to the DID recorded in the export. Every write is read back and
 * compared against the export before the script will exit zero.
 *
 * The restore is whole-topic by construction: `cf piece apply` REPLACES the
 * piece's input document (measured, not assumed — a partial apply zeroes
 * every field it omits), and no narrower CLI write path exists today, since
 * both sides of `cf cell set` validate the untouched remainder of the document
 * and refuse it — the input side judges the stored `mentionable` link
 * against its declared array type unresolved, and the result side demands
 * session-scoped fields no other session can see. So the script applies the
 * complete document in one call — built from the export's RAW argument, so
 * a plain authored field no field list here names still rides the restore —
 * then re-establishes every wiring link a document write cannot carry
 * (`$link` values are refused by the same validation), using
 * `cf piece link` against the board recorded in the export.
 *
 * Those wiring links are `STRUCTURAL_LINK_SOURCES`, which maps each one to
 * the board path it points at: `mentionable` to the board's `mentionable`
 * index and `boardCrossrefs` to its `crossrefs`. A link-valued field absent
 * from that map stops the restore rather than being guessed at, so a wiring
 * input added to the topic pattern announces itself here.
 *
 * Four honest costs. Comment and link elements are re-written as plain
 * values, so their element entities are minted fresh: content, order,
 * timestamps, and attribution are exact, but a stored reference to an
 * individual old element is not preserved. A re-established link targets the
 * board's RESULT path where the original targeted its argument document —
 * aliases of one another (#5632), so a before/after diff of the stored link
 * differs while resolution does not. A `RETIRABLE_LINK_FIELDS` link is
 * restored or retired according to what the TARGET declares, not its name: a
 * topic still running a pattern that declares `boardNames` gets its link back,
 * one already migrated past it does not, and `myName` — the pre-agentName
 * attribution fallback — is declared by nothing and so always retired. And a
 * `PRESERVED_FIELDS` value the target holds is carried forward where the
 * export names none, because the apply would otherwise remove a number the
 * topic owns permanently.
 * And a field the CURRENT schema retired is written but cannot be read back,
 * so it is reported `not restored` and does not fail the run; only a field
 * the schema still declares can be checked, and there a difference is still a
 * failure.
 *
 * The target's deployed pattern identity must match the export row's;
 * --allow-identity-mismatch overrides, which a restore after a deliberate
 * migration needs — the migration changed the identity on purpose.
 */

import {
  buildRestoreDocument,
  cf,
  cfApply,
  cfJson,
  declaredRetirableLinks,
  deepEqual,
  isAbsentPathError,
  normalizeFid,
  PRESERVED_FIELDS,
  retiredKeys,
  STRUCTURAL_LINK_SOURCES,
  type TopicsExport,
  WHOLE_VALUE,
  withoutKeys,
} from "./topics-rehearsal-lib.ts";

function usage(): never {
  console.error(
    "usage: topics-restore.ts <export.json> --piece <fid> " +
      "[--api-url <url>] [--space <did>] [--dry-run] " +
      "[--allow-identity-mismatch]",
  );
  Deno.exit(2);
}

const positional: string[] = [];
let piece: string | undefined;
let apiUrl = Deno.env.get("CF_API_URL");
let space: string | undefined;
let dryRun = false;
let allowIdentityMismatch = false;
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === "--piece") piece = Deno.args[++i];
  else if (arg === "--api-url") apiUrl = Deno.args[++i];
  else if (arg === "--space") space = Deno.args[++i];
  else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--allow-identity-mismatch") allowIdentityMismatch = true;
  else if (arg.startsWith("--")) usage();
  else positional.push(arg);
}
const exportPath = positional[0];
if (!exportPath || positional.length > 1 || !piece || !apiUrl) usage();

const export_ = JSON.parse(
  await Deno.readTextFile(exportPath),
) as TopicsExport;
if (export_.version !== 1) {
  console.error(`unsupported export version: ${export_.version}`);
  Deno.exit(1);
}

const targetFid = normalizeFid(piece);
const row = export_.topics.find((t) => normalizeFid(t.fid) === targetFid);
if (!row) {
  console.error(
    `no topic ${targetFid} in ${exportPath} ` +
      `(${export_.topics.length} topics exported)`,
  );
  Deno.exit(1);
}

space ??= export_.spaceDid ?? undefined;
if (!space) {
  console.error("no --space given and the export records no space DID");
  Deno.exit(2);
}
const addr = ["--piece", targetFid, "--space", space, "--api-url", apiUrl];

const listing = await cfJson<{ pattern?: { identity?: string } }>([
  "piece",
  "verbs",
  ...addr,
  "--json",
]);
const liveIdentity = listing.pattern?.identity ?? "(unresolved)";
if (liveIdentity !== row.patternIdentity) {
  const message = `deployed pattern identity ${liveIdentity} differs from ` +
    `the export's ${row.patternIdentity}`;
  if (!allowIdentityMismatch) {
    console.error(
      `refusing: ${message}. After a deliberate migration, re-run with ` +
        "--allow-identity-mismatch.",
    );
    Deno.exit(1);
  }
  console.error(`proceeding despite mismatch: ${message}`);
}

async function liveValue(field: string): Promise<unknown> {
  // A read of an absent optional path fails rather than returning null;
  // treat that as "absent" so it compares against an absent export value.
  // Only that failure: absence is what the readback forgives as a retired
  // field, so a read that never landed must stop the run rather than be
  // forgiven as one.
  try {
    return await cfJson<unknown>([
      "cell",
      "get",
      "-q",
      ...addr,
      "--input",
      field,
    ]);
  } catch (error) {
    if (isAbsentPathError(error)) return undefined;
    throw error;
  }
}

// What the TARGET declares and holds, which is what decides two things the
// export cannot: whether a retirable link field is still live here, and
// whether this piece holds a permanent value the export predates.
//
// Asked of the target every time, for every retirable field and not only the
// ones this export happens to hold — never inferred from the export's vintage
// or from the pattern identity matching. `declaredRetirableLinks` says why,
// and what the probe cannot see.
const rawArgument = (row.rawArgument ?? {}) as Record<string, unknown>;
const declaredLinks = await declaredRetirableLinks(liveValue);
const preserved: Record<string, unknown> = {};
for (const field of PRESERVED_FIELDS) {
  const live = await liveValue(field);
  if (live !== undefined) preserved[field] = live;
}

const { doc: restoreDoc, structural, legacy, carried } = buildRestoreDocument(
  rawArgument,
  row.content,
  { declaredLinks, preserved },
);
for (const field of carried) {
  console.log(
    `${field}: carried forward from the target (${
      JSON.stringify(restoreDoc[field])
    }); the export names none`,
  );
}
const differing: string[] = [];
for (const [field, wanted] of Object.entries(restoreDoc)) {
  if (!deepEqual(await liveValue(field), wanted)) differing.push(field);
}

const boardFid = export_.board?.fid;
// A structural link the export recorded but the live piece has lost is a
// reason to restore even when every content field already matches.
const missingLinks: string[] = [];
for (const field of structural) {
  const live = await cfJson<unknown>([
    "cell",
    "get",
    "-q",
    ...addr,
    "--input",
    "--select",
    `${field}@`,
  ]).catch(() => undefined);
  if (live === undefined) missingLinks.push(field);
}

if (differing.length === 0 && missingLinks.length === 0) {
  console.log("nothing to restore: every content field matches the export");
  Deno.exit(0);
}
for (const field of differing) console.log(`${field}: differs from export`);
for (const field of missingLinks) console.log(`${field}: board link absent`);
if (dryRun) {
  console.log(`dry run: ${differing.length} field(s) would be restored`);
  Deno.exit(0);
}

await cfApply(addr, restoreDoc);
// The apply replaced the whole document, so any board link that was present a
// moment ago is gone now — relink every structural field the export recorded,
// never on the pre-apply reading.
for (const field of structural) {
  const source = STRUCTURAL_LINK_SOURCES[field];
  if (!boardFid) {
    console.error(
      `${field} was linked but the export records no board; re-link it by ` +
        `hand with \`cf piece link <board>/${source} ${targetFid}/${field}\``,
    );
    continue;
  }
  await cf([
    "piece",
    "link",
    "--space",
    space,
    "--api-url",
    apiUrl,
    `${normalizeFid(boardFid)}/${source}`,
    `${targetFid}/${field}`,
  ]);
}

let failed = 0;
for (const field of Object.keys(restoreDoc)) {
  const after = await liveValue(field);
  // A field the CURRENT schema no longer declares reads back absent however
  // faithfully it was written, so comparing whole would report every
  // comment-bearing topic as damaged after a migration that retired one. Real
  // loss still shows as a difference, because a declared field reads back
  // present even when empty.
  const retired = retiredKeys(restoreDoc[field], after);
  const wanted = withoutKeys(restoreDoc[field], new Set(retired));
  if (!deepEqual(after, wanted)) {
    console.error(`${field}: WROTE BUT READBACK DIFFERS from export`);
    failed++;
  } else if (retired.includes(WHOLE_VALUE)) {
    // A retired scalar or object leaves nothing to read back, so there is no
    // honest way to call it restored — only a reason not to call it damaged.
    console.log(`${field}: not restored (the current schema retired it)`);
  } else if (retired.length > 0) {
    console.log(
      `${field}: restored (${retired.length} field(s) the current schema ` +
        `does not surface: ${retired.join(", ")})`,
    );
  } else {
    console.log(`${field}: restored`);
  }
}
for (const field of structural) {
  const after = await cfJson<unknown>([
    "cell",
    "get",
    "-q",
    ...addr,
    "--input",
    "--select",
    `${field}@`,
  ]).catch(() => undefined);
  if (after === undefined) {
    console.error(`${field}: board link NOT re-established`);
    failed++;
  } else {
    console.log(`${field}: board link present`);
  }
}
for (const field of legacy) {
  console.log(`${field}: not restored (the target declares no such input)`);
}

console.log(`restored ${Object.keys(restoreDoc).length} field(s)`);
if (failed > 0) Deno.exit(1);
