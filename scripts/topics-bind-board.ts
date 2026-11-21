#!/usr/bin/env -S deno run --allow-run --allow-read --allow-env

/**
 * Bind each topic's `board` input to its board's collection, against a live
 * server. A topic asks the board's collection which topics mention it, and a
 * topic filed before the board held a collection has nothing bound there, so
 * it shows no backlinks until this has run for it.
 *
 * Usage:
 *   scripts/topics-bind-board.ts --board <fid> --space <did>
 *     (--piece <fid>... | --pieces <file>) [--api-url <url>] [--dry-run]
 *
 * `--pieces` names a file holding one topic fid per line. CF_API_URL and
 * CF_IDENTITY are honored as everywhere else.
 *
 * Each topic is linked with `cf piece link <board>/board <topic>/board`, the
 * link `STRUCTURAL_LINK_SOURCES` records for the field, and then read back:
 * a topic whose input holds no link there afterwards is reported and fails
 * the run. A topic that already holds the link is left alone, so a run that
 * was interrupted is finished by running it again.
 *
 * This binds the input and does nothing else. Adding the topics to the
 * collection is the board's own `adoptTopics` verb, which reads the board's
 * list, and is run once after every topic is on the pattern that declares
 * `board`.
 */

import {
  cf,
  cfJson,
  isAbsentPathError,
  normalizeFid,
  STRUCTURAL_LINK_SOURCES,
} from "./topics-rehearsal-lib.ts";

/** The topic input this script binds. */
const FIELD = "board";

function usage(): never {
  console.error(
    "usage: topics-bind-board.ts --board <fid> --space <did> " +
      "(--piece <fid>... | --pieces <file>) [--api-url <url>] [--dry-run]",
  );
  Deno.exit(2);
}

const pieces: string[] = [];
let piecesFile: string | undefined;
let board: string | undefined;
let space: string | undefined;
let apiUrl = Deno.env.get("CF_API_URL");
let dryRun = false;
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === "--board") board = Deno.args[++i];
  else if (arg === "--space") space = Deno.args[++i];
  else if (arg === "--piece") pieces.push(Deno.args[++i]);
  else if (arg === "--pieces") piecesFile = Deno.args[++i];
  else if (arg === "--api-url") apiUrl = Deno.args[++i];
  else if (arg === "--dry-run") dryRun = true;
  else usage();
}
if (piecesFile !== undefined) {
  const listed = await Deno.readTextFile(piecesFile);
  for (const line of listed.split("\n")) {
    if (line.trim()) pieces.push(line.trim());
  }
}
if (!board || !space || !apiUrl || pieces.length === 0) usage();

const boardFid = normalizeFid(board);
const source = STRUCTURAL_LINK_SOURCES[FIELD];

// Asked before any topic is touched: `cf piece link` refuses a source path
// the board's result does not hold, and a board not yet on the pattern that
// holds a collection publishes none.
try {
  await cfJson<unknown>([
    "cell",
    "get",
    "-q",
    "--piece",
    boardFid,
    "--space",
    space,
    "--api-url",
    apiUrl,
    source,
  ]);
} catch (error) {
  if (!isAbsentPathError(error)) throw error;
  console.error(
    `the board ${boardFid} publishes no ${source}; update the board before ` +
      "binding its topics",
  );
  Deno.exit(1);
}

/** Whether the topic's input holds a link at `FIELD`. */
async function bound(topic: string): Promise<boolean> {
  try {
    const live = await cfJson<unknown>([
      "cell",
      "get",
      "-q",
      "--piece",
      topic,
      "--space",
      space!,
      "--api-url",
      apiUrl!,
      "--input",
      "--select",
      `${FIELD}@`,
    ]);
    return live !== undefined && live !== null;
  } catch (error) {
    if (isAbsentPathError(error)) return false;
    throw error;
  }
}

let linked = 0;
let present = 0;
let failed = 0;
for (const piece of pieces) {
  const topic = normalizeFid(piece);
  try {
    if (await bound(topic)) {
      present++;
      console.log(`${topic}: ${FIELD} link present`);
      continue;
    }
    if (dryRun) {
      linked++;
      console.log(`${topic}: would link ${FIELD}`);
      continue;
    }
    await cf([
      "piece",
      "link",
      "--space",
      space,
      "--api-url",
      apiUrl,
      `${boardFid}/${source}`,
      `${topic}/${FIELD}`,
    ]);
    if (await bound(topic)) {
      linked++;
      console.log(`${topic}: linked ${FIELD}`);
    } else {
      failed++;
      console.error(`${topic}: LINKED BUT READBACK HOLDS NO ${FIELD} LINK`);
    }
  } catch (error) {
    failed++;
    console.error(`${topic}: ${String(error).slice(0, 400)}`);
  }
}

console.log(
  `${dryRun ? "dry run: " : ""}${linked} linked, ${present} already bound, ` +
    `${failed} failed, of ${pieces.length}`,
);
Deno.exit(failed === 0 ? 0 : 1);
