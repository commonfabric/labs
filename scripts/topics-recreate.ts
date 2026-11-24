#!/usr/bin/env -S deno run -A

/**
 * Recreate the topics of a `topics-export.ts` export on a fresh board, against
 * a live server, in one process.
 *
 * Usage:
 *   scripts/topics-recreate.ts <export.json> --board <fid> --space <did>
 *     --agent-name <name> --progress <file> [--api-url <url>]
 *     [--limit <count>]
 *
 * CF_API_URL and CF_IDENTITY are honored as everywhere else. `--board` names
 * a board already deployed from `patterns/apps/topics/main.tsx` that holds no
 * topics yet; `--agent-name` signs the `addTopic` calls the first pass makes,
 * whose attribution the second pass then replaces with the export's.
 *
 * The board's collection takes a write from the board's own verbs and from
 * nothing else, so every topic is created through `addTopic`, which numbers
 * it, creates it, adds it to the collection and wires its `board` and
 * `mentionable` in one transaction. The export's numbers run densely from 1,
 * and the topics are created in that order, so each topic gets the number it
 * had; a number that comes back different stops the run.
 *
 * Two passes, because a topic's mentions point at other topics, which have
 * to exist first:
 *
 * 1. Each topic is created with its title. `--progress` records each
 *    created topic, old reference and new, as one line of JSON, so a run
 *    that stopped is finished by running it again with the same file.
 * 2. Each topic's input document takes the export's fields: the title, body,
 *    comments and links, creation and activity times and authors, its number,
 *    and its `mentioned` list and the destinations of its `references` (the
 *    body's `[Label][key]` mentions) with every topic of the old board
 *    replaced by the topic recreated from it. A mention of anything else is
 *    kept as it was. The `board` and `mentionable` links `addTopic` wrote are kept, and
 *    the inputs only an earlier topic pattern declared are left out. The pass
 *    writes the same fields each time it runs.
 *
 * `--limit` stops each pass after that many topics, for a rehearsal on a few.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";
import {
  executePieceCallable,
  loadPieces,
  type PieceConfig,
  type SpaceConfig,
} from "../runtime/cli/lib/piece.ts";
import { parseCellSelectionOptions } from "../runtime/cli/lib/cell-selection.ts";
import { newSessionId } from "../runtime/cli/lib/session.ts";
import {
  normalizeFid,
  recreatedDocument,
  type TopicExportRow,
  type TopicsExport,
} from "./topics-rehearsal-lib.ts";

/** One line of the progress file: a topic and the one recreated from it. */
interface ProgressLine {
  name: string;
  from: string;
  to: string;
}

/**
 * What a create's readback selects: the number, and the topic as an address.
 * Reading the topic itself would subscribe this process to it, and the
 * serving runtime keeps every topic something subscribes to running, so each
 * create would re-run the backlink query of every topic created before it.
 */
const CREATE_SELECTION = await parseCellSelectionOptions({
  select: "name,topic@",
});

function usage(): never {
  console.error(
    "usage: topics-recreate.ts <export.json> --board <fid> --space <did> " +
      "--agent-name <name> --progress <file> [--api-url <url>] " +
      "[--limit <count>]",
  );
  Deno.exit(2);
}

let exportPath: string | undefined;
let board: string | undefined;
let space: string | undefined;
let agentName: string | undefined;
let progressPath: string | undefined;
let apiUrl = Deno.env.get("CF_API_URL");
let limit = Infinity;
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === "--board") board = normalizeFid(Deno.args[++i]);
  else if (arg === "--space") space = Deno.args[++i];
  else if (arg === "--agent-name") agentName = Deno.args[++i];
  else if (arg === "--progress") progressPath = Deno.args[++i];
  else if (arg === "--api-url") apiUrl = Deno.args[++i];
  else if (arg === "--limit") limit = Number(Deno.args[++i]);
  else if (arg.startsWith("--")) usage();
  else if (exportPath === undefined) exportPath = arg;
  else usage();
}
const identity = Deno.env.get("CF_IDENTITY");
if (
  !exportPath || !board || !space || !agentName?.trim() || !progressPath ||
  !apiUrl || !identity || !(limit > 0)
) {
  usage();
}

const exported = JSON.parse(
  await Deno.readTextFile(exportPath),
) as TopicsExport;
const topics = orderByNumber(exported.topics);

const spaceConfig: SpaceConfig = { apiUrl, space, identity };
const pieces = await loadPieces(spaceConfig);
const deps = { loadPieces: () => Promise.resolve(pieces) };
const boardConfig: PieceConfig = { ...spaceConfig, piece: board };
const session = newSessionId();

const created = await readProgress(progressPath);

// Pass 1: create each topic through the board, in number order.
let made = 0;
for (const [name, topic] of topics) {
  if (made >= limit) break;
  if (created.has(topic.fid)) continue;
  const title = typeof topic.content.title === "string" &&
      topic.content.title.trim()
    ? topic.content.title
    : "(untitled topic)";
  const outcome = await executePieceCallable(
    boardConfig,
    "addTopic",
    ["--json", JSON.stringify({ title, agentName })],
    {
      ...deps,
      invocation: { id: crypto.randomUUID(), session },
      selection: CREATE_SELECTION,
    },
  );
  const result = outcome.invocation?.result as
    | { name?: unknown; topic?: unknown }
    | undefined;
  if (result?.name !== name) {
    throw new Error(
      `addTopic numbered ${topic.fid} ${String(result?.name)}, not ${name}; ` +
        "the board is not the fresh board this run was started on",
    );
  }
  const to = createdTopicId(result.topic);
  const line: ProgressLine = { name, from: topic.fid, to };
  await Deno.writeTextFile(progressPath, JSON.stringify(line) + "\n", {
    append: true,
  });
  created.set(topic.fid, to);
  made++;
  if (made % 100 === 0) console.error(`created ${made}`);
}
console.log(`pass 1: created ${made}, ${created.size} recorded in all`);

// Pass 2: write each recreated topic's document.
let written = 0;
for (const [name, topic] of topics) {
  if (written >= limit) break;
  const to = created.get(topic.fid);
  if (to === undefined) continue;
  await writeFields(to, recreatedDocument(topic, name, created));
  written++;
  if (written % 100 === 0) console.error(`wrote ${written}`);
}
console.log(`pass 2: wrote ${written} documents`);
await pieces.synced();
await pieces.dispose();
Deno.exit(0);

/**
 * Writes each of `fields` into the input document of the topic `id`, at its
 * own path and in one transaction, leaving the fields it does not name alone.
 * The `board` and `mentionable` links `addTopic` wrote are among those: a
 * write of the whole document would carry them back through the link checks a
 * stored link to the board's collection does not pass.
 */
async function writeFields(
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const piece = await pieces.get(id, false);
  const result = await pieces.runtime.editWithRetry((tx) => {
    const argument = pieces.getArgument(piece.getCell().withTx(tx));
    for (const [field, value] of Object.entries(fields)) {
      argument.withTx(tx).key(field).set(value);
    }
  });
  if (result.error) {
    throw new Error(`writing topic ${id} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }
}

/**
 * The export's topics keyed by number, in number order. Throws unless the
 * numbers run densely from 1, which is what lets creating them in order give
 * each topic its number.
 */
function orderByNumber(rows: TopicExportRow[]): [string, TopicExportRow][] {
  const byNumber = new Map<number, TopicExportRow>();
  for (const row of rows) {
    const name = (row.rawArgument as Record<string, unknown>).shortName;
    const number = typeof name === "string" ? Number(name) : NaN;
    if (!Number.isInteger(number) || number < 1 || byNumber.has(number)) {
      throw new Error(`${row.fid} has no number of its own: ${String(name)}`);
    }
    byNumber.set(number, row);
  }
  const ordered: [string, TopicExportRow][] = [];
  for (let number = 1; number <= byNumber.size; number++) {
    const row = byNumber.get(number);
    if (row === undefined) {
      throw new Error(`the export's numbers skip ${number}`);
    }
    ordered.push([String(number), row]);
  }
  return ordered;
}

/** The progress file's topics, old reference to new; empty when absent. */
async function readProgress(path: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let text = "";
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  for (const line of text.split("\n").filter(Boolean)) {
    const { from, to } = JSON.parse(line) as ProgressLine;
    map.set(from, to);
  }
  return map;
}

/**
 * The topic an `addTopic` call created, from the `topic@` its result carries:
 * the topic's address, read without reading the topic.
 */
function createdTopicId(topic: unknown): string {
  const address = (topic as { $link?: unknown } | undefined)?.$link;
  if (typeof address !== "string" || !address.startsWith("/of:")) {
    throw new Error(
      `addTopic reported no topic address: ${describeFailure(topic)}`,
    );
  }
  return address.slice(1);
}
