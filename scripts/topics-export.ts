#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi --allow-net=github.com,release-assets.githubusercontent.com

/**
 * Export every topic's authored content from a Topics space snapshot,
 * offline. The export is the restore payload `topics-restore.ts` consumes,
 * and the portable backup the content-safety plan calls for: it survives the
 * space becoming unusable, and it diffs against a later export.
 *
 * Usage:
 *   scripts/topics-export.ts <snapshot.sqlite> --out <export.json>
 *     [--topic-identity <id>]... [--board-identity <id>]
 *
 * The snapshot is a `VACUUM INTO` copy of the space store (the acquisition
 * step of docs/development/space-clone-rehearsal.md); everything here reads
 * it directly through `@commonfabric/state-inspector`, so no server is
 * involved and no subprocess is spawned per entity. With no identity flags,
 * topics are selected by verb shape — a piece whose result offers
 * `addComment`, `addLink`, and `setBody` — and the board by `addTopic`; the
 * selected pattern identities are printed so an operator can confirm them
 * against the migration manifest, and explicit flags override the inference.
 *
 * Comment and link array elements are stored as links to entities of their
 * own, so the export resolves each element. Any deeper link inside a content
 * field aborts the export: recording a reference as if it were content is
 * exactly the silent corruption this tool exists to rule out.
 *
 * The permissions in the shebang are the complete set the store read needs,
 * and the omission is as deliberate as the inclusions. Opening the snapshot
 * loads SQLite over FFI and reads its configuration from the environment, so
 * `--allow-ffi --allow-env`. The library is not shipped with `@db/sqlite`
 * either: on a cold cache `plug` fetches it at RUNTIME from the two hosts
 * named — the release URL and the target it redirects to — which is an
 * ordinary `fetch` and so wants `--allow-net`. Only `--allow-run` is absent,
 * because nothing here starts a process.
 *
 * `scripts/topics-export.test.ts` asserts this exact list, so changing it is
 * a deliberate act rather than a drift. Verify any change against an empty
 * `DENO_DIR`, never the cache this machine happens to be carrying: a warm
 * cache makes the SQLite download disappear, and with it the evidence that
 * the program ever reached the network at all.
 */

import type { FabricValue } from "@commonfabric/data-model";
import {
  annotate,
  getValueAt,
  isCompleteScan,
  listEntityModels,
  openSpace,
  resolveSpace,
} from "@commonfabric/state-inspector";

import {
  findLink,
  LINKED_ARRAY_FIELDS,
  SCALAR_CONTENT_FIELDS,
  type TopicContent,
  type TopicExportRow,
  type TopicsExport,
} from "./topics-rehearsal-lib.ts";

import { argumentIdOf } from "./topics-snapshot-lib.ts";

interface PieceInfo {
  id: string;
  pattern?: { identity?: string };
  input?: { id?: string };
  resultKeys?: string[];
}

function usage(): never {
  console.error(
    "usage: topics-export.ts <snapshot.sqlite> --out <export.json> " +
      "[--topic-identity <id>]... [--board-identity <id>]",
  );
  Deno.exit(2);
}

const positional: string[] = [];
const topicIdentities: string[] = [];
let boardIdentity: string | undefined;
let outPath: string | undefined;
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === "--out") outPath = Deno.args[++i];
  else if (arg === "--topic-identity") topicIdentities.push(Deno.args[++i]);
  else if (arg === "--board-identity") boardIdentity = Deno.args[++i];
  else if (arg.startsWith("--")) usage();
  else positional.push(arg);
}
const snapshot = positional[0];
if (!snapshot || positional.length > 1 || !outPath) usage();

const didMatch = /(did:key:[A-Za-z0-9]+)\.sqlite$/.exec(snapshot);
const spaceDid = didMatch ? didMatch[1] : null;

// Named past any plausible piece count so the cap never bites in practice. A
// finite cap is still a cliff, so the scan's own extent is checked below
// rather than trusted.
const PIECE_LIMIT = 1_000_000;

// Every read below goes through this ONE handle. The obvious spelling — shell
// out to `cf` per entity — costs a `deno task` resolution and a fresh open of
// a multi-gigabyte database for each of several thousand reads, which is hours
// for a board this size. Same answers, one process.
//
// `annotate` at unbounded depth is not decoration either: it is what
// `cf inspect value-at --json --full-depth` returns, and `findLink` below
// reads the `$link` shape that annotation produces. Reading the raw value
// instead would quietly change what the export records.
const space = openSpace(await resolveSpace(snapshot));
const annotateFully = (value: FabricValue) =>
  annotate(value, Number.POSITIVE_INFINITY);

const listing = listEntityModels(space, { limit: PIECE_LIMIT, kind: "piece" });
// An incomplete listing would hand the export a subset of the space's pieces,
// and a rollback payload missing topics reads exactly like a complete one. A
// `kind` scan falls short two ways — it can hit the cap, and it drops any
// entity it could not reconstruct well enough to classify — so the refusal
// names which one happened, because only the first is answered by a larger
// limit.
if (!isCompleteScan(listing.extent)) {
  const { limit, total, truncated, unreadable } = listing.extent;
  console.error(
    "refusing: the piece listing does not cover the space, so this export " +
      "would be a subset of it with nothing to say so" +
      (truncated ? `; capped at ${limit} of ${total} entities` : "") +
      (unreadable > 0
        ? `; ${unreadable} of ${total} entities could not be reconstructed`
        : ""),
  );
  Deno.exit(1);
}

// Selection reads each piece's DOCUMENT, not its description. `describePiece`
// additionally resolves owned cells and lineage, which is what an operator
// wants when inspecting one piece and ruinous across every piece in a space:
// measured at ~22s each here against ~1.7ms for the document, which is the
// difference between this export finishing in under a minute and not finishing
// at all. Everything selection needs is in the document — the pattern identity
// it carries, the argument it links, and its result keys, which are exactly the
// keys of `value` (verified against `describePiece` on a topic).
//
// The space holds far more pieces than the board's children: 14807 in the
// 2026-08-27 snapshot, of which about 126 are the board and its topics. The
// sweep is what makes finding them affordable.
const infos: PieceInfo[] = [];
for (const row of listing.entities) {
  const document = getValueAt(space, { id: row.id }).document;
  if (!document) continue;
  const value = document.value as Record<string, unknown> | undefined;
  const identity = document.patternIdentity as
    | { identity?: string }
    | string
    | undefined;
  infos.push({
    id: row.id,
    pattern: {
      identity: typeof identity === "string" ? identity : identity?.identity,
    },
    input: { id: argumentIdOf(document) },
    resultKeys: value ? Object.keys(value) : [],
  });
  if (infos.length % 2000 === 0) {
    console.error(`  swept ${infos.length}/${listing.entities.length} pieces`);
  }
}

const hasVerbs = (info: PieceInfo, verbs: string[]) =>
  verbs.every((verb) => info.resultKeys?.includes(verb));
const isTopic = (info: PieceInfo) =>
  topicIdentities.length > 0
    ? topicIdentities.includes(info.pattern?.identity ?? "")
    : hasVerbs(info, ["addComment", "addLink", "setBody"]);
const isBoard = (info: PieceInfo) =>
  boardIdentity !== undefined
    ? info.pattern?.identity === boardIdentity
    : hasVerbs(info, ["addTopic"]);

const topicInfos = infos.filter(isTopic);
const boardInfos = infos.filter(isBoard);
if (boardInfos.length > 1) {
  console.error(
    `refusing: ${boardInfos.length} board-shaped pieces; ` +
      `name one with --board-identity:\n` +
      boardInfos.map((b) => `  ${b.id}  ${b.pattern?.identity}`).join("\n"),
  );
  Deno.exit(1);
}
if (topicInfos.length === 0) {
  console.error("refusing: no topic-shaped pieces found in the snapshot");
  Deno.exit(1);
}

function argumentValue(info: PieceInfo): unknown {
  const argumentId = info.input?.id;
  if (!argumentId) {
    throw new Error(`piece ${info.id} reports no argument entity`);
  }
  const at = getValueAt(space, { id: argumentId });
  if (!at.exists) throw new Error(`argument ${argumentId} does not exist`);
  return annotateFully(at.value);
}

function resolveElement(
  topicFid: string,
  field: string,
  index: number,
  element: unknown,
): unknown {
  const link = (element as { $link?: { id?: string } })?.$link;
  const resolved = link?.id
    ? annotateFully(getValueAt(space, { id: link.id }).value)
    : element;
  const deeper = findLink(resolved);
  if (deeper) {
    throw new Error(
      `${topicFid} ${field}[${index}] holds a link at ${deeper}; ` +
        "the export cannot flatten it and refuses to record a reference " +
        "as content",
    );
  }
  return resolved;
}

// Fields this tool classifies; anything else an argument document carries is
// still exported raw and restored by `buildRestoreDocument`, and is worth a
// line in the summary so a schema that grew is noticed at export time.
const CLASSIFIED_FIELDS = new Set<string>([
  ...SCALAR_CONTENT_FIELDS,
  ...LINKED_ARRAY_FIELDS,
  "myName",
  "mentionable",
]);

const topics: TopicExportRow[] = [];
const unclassified = new Set<string>();
let commentTotal = 0;
let linkTotal = 0;
for (const info of topicInfos) {
  const raw = argumentValue(info) as Record<string, unknown>;
  const content = { comments: [], links: [] } as TopicContent;
  for (const field of SCALAR_CONTENT_FIELDS) {
    const value = raw[field];
    const linkPath = value === undefined ? null : findLink(value);
    if (linkPath) {
      throw new Error(
        `${info.id} ${field} holds a link at ${linkPath}; refusing to ` +
          "record a reference as content",
      );
    }
    if (value !== undefined) content[field] = value;
  }
  for (const field of LINKED_ARRAY_FIELDS) {
    const elements = Array.isArray(raw[field]) ? raw[field] as unknown[] : [];
    const resolved: unknown[] = [];
    for (let i = 0; i < elements.length; i++) {
      resolved.push(resolveElement(info.id, field, i, elements[i]));
    }
    content[field] = resolved;
  }
  for (const field of Object.keys(raw)) {
    if (!CLASSIFIED_FIELDS.has(field)) unclassified.add(field);
  }
  commentTotal += content.comments.length;
  linkTotal += content.links.length;
  topics.push({
    fid: info.id,
    patternIdentity: info.pattern?.identity ?? "",
    argumentId: info.input?.id ?? "",
    content,
    rawArgument: raw,
  });
}

let board: TopicsExport["board"] = null;
if (boardInfos.length === 1) {
  const info = boardInfos[0];
  const raw = argumentValue(info) as Record<string, unknown>;
  board = {
    fid: info.id,
    patternIdentity: info.pattern?.identity ?? "",
    argumentId: info.input?.id ?? "",
    topicsLinks: Array.isArray(raw.topics) ? raw.topics as unknown[] : [],
  };
}

const topicsExport: TopicsExport = {
  version: 1,
  exportedAt: new Date().toISOString(),
  snapshot,
  spaceDid,
  board,
  topics,
  manifest: infos.map((info) => ({
    fid: info.id,
    patternIdentity: info.pattern?.identity ?? "",
    resultKeys: info.resultKeys ?? [],
  })),
};

await Deno.writeTextFile(
  outPath,
  JSON.stringify(topicsExport, null, 2) + "\n",
);

const identities = [...new Set(topicInfos.map((t) => t.pattern?.identity))];
console.log(`wrote ${outPath}`);
console.log(
  `topics: ${topics.length}  comments: ${commentTotal}  links: ${linkTotal}`,
);
console.log(`topic pattern identities: ${identities.join(", ")}`);
if (unclassified.size > 0) {
  console.log(
    `note: unclassified authored fields, carried raw and restored ` +
      `verbatim: ${[...unclassified].sort().join(", ")}`,
  );
}
if (board) {
  console.log(
    `board: ${board.fid} (${board.patternIdentity}), ` +
      `${board.topicsLinks.length} membership links`,
  );
} else {
  console.log("board: none selected");
}
