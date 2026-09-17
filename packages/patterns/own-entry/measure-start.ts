/**
 * What starting one topic loads, measured two ways on one board. A measurement
 * rig for the own-entry experiment, not part of any pattern.
 *
 * One process measures one board: one arm at one size. The process must be
 * started with `CF_MEMORY_FRAME_LOG` naming a file, because the memory client
 * reads that variable once, at module load, and every client in the process
 * then appends one line per frame to that file. The rig renames the file at
 * each phase boundary, so each phase's frames land in a file of their own:
 * `<out>/<arm>-N<n>.<phase>.jsonl`.
 *
 * Phases, all against one in-process memory server (`newLoopbackServer`):
 *
 * - `build`: runtime A files N topics through the board's `addTopic` and makes
 *   the mentions, all but the last topic's.
 * - `op-add`: runtime A files one more topic. The board's cost of an add.
 * - `op-mention`: runtime A makes the last mention, which names topic 0. The
 *   board's cost of a mention change.
 * - `replay`: the #7439 method. A loopback session asks the server for a graph
 *   query rooted at topic 0's argument document under the schema recorded on
 *   its argument link, and at each input's document under that input's
 *   property schema.
 * - runtime A is disposed and its storage manager closed; the server stays.
 * - `b-compile`: runtime B, a fresh runtime with its own session on the same
 *   server, compiles the board program, which includes the topic pattern.
 * - `start`: runtime B starts topic 0 by its result document's link and waits
 *   for its scheduler to go idle and its storage to settle.
 * - `pull`: runtime B pulls topic 0's result cell, which carries no schema, as
 *   `PiecesController.startPiece` does after `runtime.start`.
 * - `checks`: runtime B reads what topic 0 computed.
 *
 * Mentions: topic k, for k from 1 to N - 1, mentions topics k+1 .. k+d, modulo
 * N. Topic 0 mentions nothing, so every topic document a start of topic 0
 * receives arrives through its inbound references or its board, never through
 * a reference topic 0 itself holds. Topic 0 is mentioned by topics N-d .. N-1.
 *
 * A delivered document is attributed to topic k when its id is topic k's
 * result, argument or pattern document (`other` when k is not 0), and to topic
 * k's family when the chain of `result` backlinks from it reaches one of those
 * (`family`). Bytes are the frame log's: the UTF-8 length of the document
 * record as JSON.
 *
 * Usage:
 *   CF_MEMORY_FRAME_LOG=<file> deno run -A \
 *     packages/patterns/own-entry/measure-start.ts \
 *     --arm=<arm> --n=<N> --d=<inbound degree> --out=<dir>
 *
 * Writes one JSON object to `<out>/<arm>-N<n>.result.json`.
 */

import { Identity } from "@commonfabric/identity";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  experimentalOptionsFromEnv,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";

import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../runner/src/storage/cache.deno.ts";
import { getMetaLink, parseLink } from "../../runner/src/link-utils.ts";
import { lookupSchemaDocument } from "../../runner/src/schema-registry.ts";
import { testPrincipalSessionOpenAuthFactory } from "../../runner/test/memory-v2-test-utils.ts";

import { ARMS } from "./arms.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const PATTERNS_ROOT = new URL("../", import.meta.url).pathname;

const args = Object.fromEntries(
  Deno.args.filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, value] = arg.slice(2).split("=");
    return [key, value ?? "true"];
  }),
);
const armName = args.arm ?? "current";
const size = Number(args.n ?? "4");
const degree = Number(args.d ?? "2");
const outDir = args.out ?? "experiment-output/frames";
const withPull = args.pull !== "false";
const arm = ARMS[armName];
if (arm === undefined) throw new Error(`unknown arm: ${armName}`);
if (degree >= size) throw new Error("degree must be below N");

const logPath = Deno.env.get("CF_MEMORY_FRAME_LOG");
if (!logPath) throw new Error("CF_MEMORY_FRAME_LOG must name a file");
Deno.mkdirSync(outDir, { recursive: true });

const stage = (name: string) =>
  console.error(`# ${new Date().toISOString()} ${armName} N=${size} ${name}`);

/** Moves the frames written so far to the named phase's file. */
const rotate = (phase: string): string => {
  const target = `${outDir}/${armName}-N${size}.${phase}.jsonl`;
  try {
    Deno.renameSync(logPath, target);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    Deno.writeTextFileSync(target, "");
  }
  return target;
};

// Anything logged before the first phase (module load) is discarded.
try {
  Deno.removeSync(logPath);
} catch { /* absent */ }

interface Frame {
  dir: string;
  type?: string;
  bytes?: number;
  hash?: string;
  selector?: Json;
  watches?: Json[];
  query?: Json[];
  commit?: Json;
  sync?: { upserts: Json[] };
  entities?: Json[];
  effectType?: string;
}

/** One delivered document: its id, its scope, and its size as delivered. */
interface Delivered {
  id: string;
  scope: string;
  bytes: number;
}

const readFrames = (path: string): Frame[] =>
  Deno.readTextFileSync(path).split("\n").filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));

const docKey = (entry: Json) =>
  JSON.stringify([entry.id, entry.scope ?? "space", entry.scopeKey ?? null]);

/** What one phase's frames asked for and received. */
const summarizePhase = (path: string) => {
  const frames = readFrames(path);
  const selectors = new Map<string, Json>();
  let framesOut = 0, framesIn = 0, bytesOut = 0, bytesIn = 0;
  let watchRoots = 0, commits = 0, commitOps = 0, graphQueries = 0;
  const watchRootIds = new Set<string>();
  // Last delivered size per document, and every delivery's size.
  const delivered = new Map<string, Delivered>();
  let upserts = 0, upsertBytes = 0;
  for (const frame of frames) {
    if (frame.dir === "selector") {
      selectors.set(frame.hash!, frame.selector);
      continue;
    }
    if (frame.dir === "out") {
      framesOut++;
      bytesOut += frame.bytes ?? 0;
      if (frame.type === "transact") {
        commits++;
        commitOps += frame.commit?.operations?.length ?? 0;
      }
      if (frame.type === "graph.query") graphQueries++;
      for (const watch of frame.watches ?? []) {
        for (const root of watch.roots ?? []) {
          watchRoots++;
          watchRootIds.add(root.id);
        }
      }
    } else if (frame.dir === "in") {
      framesIn++;
      bytesIn += frame.bytes ?? 0;
      for (const upsert of frame.sync?.upserts ?? []) {
        upserts++;
        upsertBytes += upsert.bytes ?? 0;
        delivered.set(docKey(upsert), {
          id: upsert.id,
          scope: upsert.scope ?? "space",
          bytes: upsert.bytes ?? 0,
        });
      }
      for (const entity of frame.entities ?? []) {
        if (entity.absent) continue;
        delivered.set(docKey(entity), {
          id: entity.id,
          scope: entity.scope ?? "space",
          bytes: entity.bytes ?? 0,
        });
      }
    }
  }
  return {
    frames: frames.length,
    framesOut,
    framesIn,
    bytesOut,
    bytesIn,
    watchRoots,
    watchRootIds: watchRootIds.size,
    distinctSelectors: selectors.size,
    commits,
    commitOps,
    graphQueries,
    upserts,
    upsertBytes,
    delivered,
  };
};

const deref = (schema: Json): Json => {
  const ref = schema?.$ref;
  if (typeof ref !== "string" || !ref.startsWith("cid:")) return schema;
  return lookupSchemaDocument(ref.slice("cid:".length)) ?? schema;
};

const withoutAsCell = (schema: Json): Json => {
  if (schema === null || typeof schema !== "object") return schema;
  const { asCell: _a, asStream: _b, ...rest } = schema;
  return rest;
};

const git = async (...gitArgs: string[]) => {
  const output = await new Deno.Command("git", {
    args: gitArgs,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(output.stdout).trimEnd();
};

const newRuntime = (
  storageManager: EmulatedStorageManager,
  errors: string[],
) =>
  new Runtime(runtimePresets.patternTest({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: experimentalOptionsFromEnv(Deno.env.get),
    errorHandlers: [(error: Error) => {
      errors.push(error.message);
    }],
  }));

const compile = async (runtime: Runtime, space: string) => {
  const program = await resolveLocalProgram(
    (resolver) => runtime.harness.resolve(resolver),
    { main: `${PATTERNS_ROOT}${arm.board}`, root: PATTERNS_ROOT },
  );
  return await runtime.patternManager.compilePattern(program, {
    space: space as Json,
  });
};

const ms = (start: number) => Math.round(performance.now() - start);

const head = await git("rev-parse", "HEAD");
const status = (await git("status", "--short")) || "(no changes)";

const signer = await Identity.fromPassphrase(
  `own-entry probe ${armName} ${size} ${degree}`,
);
const space = signer.did();
const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });

// --- Runtime A: build the board -------------------------------------------

stage("build");
const buildStart = performance.now();
const storageA = EmulatedStorageManager.connectTo(server, { as: signer });
const errorsA: string[] = [];
const runtimeA = newRuntime(storageA, errorsA);
const factoryA = await compile(runtimeA, space);

const setupTx = runtimeA.edit();
const boardCell = runtimeA.getCell<Json>(
  space,
  { ownEntryProbe: armName, size, degree },
  factoryA.resultSchema,
  setupTx,
);
const board = runtimeA.run(
  setupTx,
  factoryA,
  arm.boardArgument ?? {},
  boardCell,
);
runtimeA.prepareTxForCommit(setupTx);
const setupCommit = await setupTx.commit();
if (setupCommit.error) throw setupCommit.error;
const cancelBoard = board.sink(() => {});
await runtimeA.idle();

const addTopic = board.key("addTopic");
const fileTopic = async (n: number) => {
  await addTopic.pull();
  await runtimeA.editWithRetry((tx) =>
    addTopic.withTx(tx).send({
      title: `Topic ${n}`,
      body: `Body of topic ${n}. ${"x".repeat(400)}`,
      agentName: "probe",
    })
  );
};
for (let n = 1; n < size; n++) await fileTopic(n);
await runtimeA.idle();

const topics = board.key("topics");
const topicAt = (index: number) => topics.key(index).resolveAsCell();

const mention = async (from: number, to: number) => {
  const stream = topicAt(from).key("mention");
  await stream.pull();
  await runtimeA.editWithRetry((tx) =>
    stream.withTx(tx).send({ topic: topicAt(to) })
  );
};
// Every mention but the last one: topic N-1 naming topic 0. Topic N-1 does
// not exist yet, so its mentions are made after the add below.
const pending: [number, number][] = [];
for (let from = 1; from < size; from++) {
  for (let step = 1; step <= degree; step++) {
    const to = (from + step) % size;
    if (to === from) continue;
    pending.push([from, to]);
  }
}
const lastMention = pending.find(([from, to]) => from === size - 1 && to === 0);
const early = pending.filter(([from]) => from < size - 1);
await topics.pull();
for (const [from, to] of early) {
  // A mention of topic N-1 waits for it to exist.
  if (to === size - 1) continue;
  await mention(from, to);
}
await runtimeA.idle();
await storageA.synced();
const buildMs = ms(buildStart);
const buildFile = rotate("build");

// --- op-add: the board's cost of one more topic ---------------------------

stage("op-add");
const addStart = performance.now();
await fileTopic(size);
await runtimeA.idle();
await storageA.synced();
const addMs = ms(addStart);
const addFile = rotate("op-add");

await topics.pull();
const listed = (topics.get() ?? []) as unknown[];
if (listed.length !== size) {
  throw new Error(`expected ${size} topics, board holds ${listed.length}`);
}
for (const [from, to] of early) {
  if (to === size - 1) await mention(from, to);
}
for (const [from, to] of pending) {
  if (from === size - 1 && !(to === 0 && lastMention !== undefined)) {
    await mention(from, to);
  }
}
await runtimeA.idle();
await storageA.synced();
rotate("build-2");

// --- op-mention: the board's cost of one mention change -------------------

stage("op-mention");
const mentionStart = performance.now();
if (lastMention !== undefined) await mention(lastMention[0], lastMention[1]);
await runtimeA.idle();
await storageA.synced();
const mentionMs = ms(mentionStart);
const mentionFile = rotate("op-mention");

// --- Ownership, and what runtime A computed for topic 0 -------------------

stage("ownership");
const topicCells = Array.from({ length: size }, (_, index) => topicAt(index));
const topic0 = topicCells[0];
const topic0Link = topic0.getAsNormalizedFullLink();
const owner = new Map<string, string>();
const note = (id: string, who: string) => {
  const known = owner.get(id);
  owner.set(id, known === undefined || known === who ? who : "shared");
};
const noteFamily = (cell: Json, who: string) => {
  note(cell.getAsNormalizedFullLink().id, who);
  for (const rail of ["argument", "pattern"] as const) {
    const link = getMetaLink(cell, rail);
    if (link !== undefined) note(link.id, who);
  }
};
noteFamily(boardCell, "board");
topicCells.forEach((cell, index) =>
  noteFamily(cell, index === 0 ? "self" : `other${index}`)
);
const resultIds = new Map<string, string>();
resultIds.set(boardCell.getAsNormalizedFullLink().id, "board");
topicCells.forEach((cell, index) =>
  resultIds.set(
    cell.getAsNormalizedFullLink().id,
    index === 0 ? "self" : `other${index}`,
  )
);
const sharedIds = [...owner.values()].filter((who) => who === "shared").length;

const readChecks = async (runtime: Runtime, cell: Json) => {
  const view = runtime.getCellFromLink({
    ...cell.getAsNormalizedFullLink(),
    schema: arm.checkSchema,
  });
  const value = view.get() as Json;
  return arm.checks(value);
};
const checksA = await readChecks(runtimeA, topic0);

// --- replay: the #7439 method ---------------------------------------------

stage("replay");
const argumentLink = getMetaLink(topic0, "argument");
if (argumentLink === undefined) throw new Error("topic 0 has no argument link");
const argumentCell = runtimeA.getCellFromLink(argumentLink);
await argumentCell.sync();
const storedArgument = argumentCell.getRawUntyped() as Record<string, Json>;
const recordedSchema = argumentLink.schema as Json;
const argumentSchema = deref(recordedSchema);

const replayClient = await MemoryV2Client.connect({
  transport: MemoryV2Client.loopback(server),
});
const replaySession = await replayClient.mount(
  space as Json,
  {},
  testPrincipalSessionOpenAuthFactory(signer),
);
rotate("pre-replay");

/**
 * A phase's delivered documents, by whose they are. `self`, `board` and
 * `other` count a document by its id alone; the `family` counts follow
 * `result` backlinks, so a topic's derived documents count as that topic's.
 * `schema` is a content-addressed schema document (`cid:`), which belongs to
 * no piece. `nonSpace` is a per-session or per-user document: the starting
 * runtime's own state, which another session cannot read to attribute.
 */
const classify = (ids: Iterable<Delivered>) => {
  const counts = {
    docs: 0,
    bytes: 0,
    selfDocs: 0,
    boardDocs: 0,
    otherDocs: 0,
    otherTopics: 0,
    otherBytes: 0,
    selfFamilyDocs: 0,
    selfFamilyBytes: 0,
    boardFamilyDocs: 0,
    boardFamilyBytes: 0,
    familyOtherDocs: 0,
    familyOtherTopics: 0,
    familyOtherBytes: 0,
    schemaDocs: 0,
    schemaBytes: 0,
    nonSpaceDocs: 0,
    nonSpaceBytes: 0,
    unattributedDocs: 0,
    unattributedBytes: 0,
  };
  const topicsSeen = new Set<string>();
  const familyTopicsSeen = new Set<string>();
  for (const { id, scope, bytes } of ids) {
    counts.docs++;
    counts.bytes += bytes;
    if (scope !== "space") {
      counts.nonSpaceDocs++;
      counts.nonSpaceBytes += bytes;
      continue;
    }
    const who = owner.get(id);
    if (who === "self") counts.selfDocs++;
    if (who === "board") counts.boardDocs++;
    if (who?.startsWith("other")) {
      counts.otherDocs++;
      counts.otherBytes += bytes;
      topicsSeen.add(who);
    }
    const family = familyOf(id);
    if (family === "self") {
      counts.selfFamilyDocs++;
      counts.selfFamilyBytes += bytes;
    } else if (family === "board") {
      counts.boardFamilyDocs++;
      counts.boardFamilyBytes += bytes;
    } else if (family?.startsWith("other")) {
      counts.familyOtherDocs++;
      counts.familyOtherBytes += bytes;
      familyTopicsSeen.add(family);
    } else if (id.startsWith("cid:")) {
      counts.schemaDocs++;
      counts.schemaBytes += bytes;
    } else {
      counts.unattributedDocs++;
      counts.unattributedBytes += bytes;
    }
  }
  counts.otherTopics = topicsSeen.size;
  counts.familyOtherTopics = familyTopicsSeen.size;
  return counts;
};

// The `result` backlink of each document, filled in by `learnBacklinks`.
const backlink = new Map<string, string>();
const learnBacklinks = async (ids: string[]) => {
  // Only space-scoped documents; see `classify`.
  const unknownIds = ids.filter((id) => !backlink.has(id) && !owner.has(id));
  const chunk = 200;
  for (let at = 0; at < unknownIds.length; at += chunk) {
    const frame = await replaySession.queryGraph({
      roots: unknownIds.slice(at, at + chunk).map((id) => ({
        id,
        selector: { path: [], schema: false },
      })),
    } as Json);
    for (const entity of frame.entities as Json[]) {
      const raw = entity.document?.result;
      if (raw === undefined) continue;
      const link = parseLink(raw, { ...argumentLink, id: entity.id, path: [] });
      if (link?.id !== undefined) backlink.set(entity.id, link.id);
    }
  }
};
function familyOf(id: string): string | undefined {
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current !== undefined && !seen.has(current)) {
    const byId = owner.get(current);
    if (byId !== undefined) return byId;
    seen.add(current);
    const parent = backlink.get(current);
    if (parent === undefined) return undefined;
    const byResult = resultIds.get(parent);
    if (byResult !== undefined) return byResult;
    current = parent;
  }
  return undefined;
}

const replayRoots: Record<string, Json> = {
  "whole as recorded": [{
    id: argumentLink.id,
    selector: { path: [], schema: recordedSchema },
  }],
};
for (
  const [name, propertySchema] of Object.entries(
    (argumentSchema?.properties ?? {}) as Record<string, Json>,
  )
) {
  if (!arm.replayInputs.includes(name)) continue;
  const raw = storedArgument?.[name];
  if (raw === undefined) continue;
  const link = parseLink(raw, argumentLink);
  if (link?.id === undefined) continue;
  replayRoots[`input ${name}`] = [{
    id: link.id,
    selector: {
      path: [...(link.path ?? []) as string[]],
      schema: withoutAsCell(deref(propertySchema)),
    },
  }];
}
const replayFiles: Record<string, string> = {};
const replayDelivered: Record<string, Map<string, Delivered>> = {};
for (const [name, roots] of Object.entries(replayRoots)) {
  await replaySession.queryGraph({ roots } as Json);
  const file = rotate(`replay-${name.replaceAll(" ", "-")}`);
  replayFiles[name] = file;
  replayDelivered[name] = summarizePhase(file).delivered;
}

cancelBoard();
const experimental = runtimeA.experimental;
await runtimeA.dispose();
await storageA.close();
rotate("dispose-a");

// --- Runtime B: start topic 0 ---------------------------------------------

stage("b-compile");
const storageB = EmulatedStorageManager.connectTo(server, { as: signer });
const errorsB: string[] = [];
const runtimeB = newRuntime(storageB, errorsB);
const compileStart = performance.now();
await compile(runtimeB, space);
const compileMs = ms(compileStart);
const compileFile = rotate("b-compile");

stage("start");
const topic0B = runtimeB.getCellFromLink({ ...topic0Link, schema: undefined });
const startStart = performance.now();
const started = await runtimeB.start(topic0B);
const startReturnedMs = ms(startStart);
await runtimeB.idle();
await storageB.synced();
const startMs = ms(startStart);
const startFile = rotate("start");

let pullMs: number | undefined;
let pullFile: string | undefined;
if (withPull) {
  stage("pull");
  const pullStart = performance.now();
  await topic0B.pull();
  await runtimeB.idle();
  await storageB.synced();
  pullMs = ms(pullStart);
  pullFile = rotate("pull");
}

stage("checks");
const checksB = await readChecks(runtimeB, topic0B);
rotate("checks");

// --- Attribution ----------------------------------------------------------

stage("attribution");
const phases: Record<string, ReturnType<typeof summarizePhase>> = {
  "op-add": summarizePhase(addFile),
  "op-mention": summarizePhase(mentionFile),
  "b-compile": summarizePhase(compileFile),
  start: summarizePhase(startFile),
};
if (pullFile !== undefined) phases.pull = summarizePhase(pullFile);
const allIds = new Set<string>();
for (const phase of Object.values(phases)) {
  for (const { id, scope } of phase.delivered.values()) {
    if (scope === "space") allIds.add(id);
  }
}
for (const delivered of Object.values(replayDelivered)) {
  for (const { id, scope } of delivered.values()) {
    if (scope === "space") allIds.add(id);
  }
}
await learnBacklinks([...allIds]);
await replayClient.close();
rotate("attribution");

const startAndPull = new Map(phases.start.delivered);
if (phases.pull !== undefined) {
  for (const [key, value] of phases.pull.delivered) {
    startAndPull.set(key, value);
  }
}

const phaseLine = (phase: ReturnType<typeof summarizePhase>) => {
  const { delivered, ...rest } = phase;
  return { ...rest, ...classify(delivered.values()) };
};

const buildSummary = (() => {
  const { delivered: _d, ...rest } = summarizePhase(buildFile);
  return rest;
})();
// The build phase's frame file is large at large N and carries nothing the
// summary does not; it is removed once summarized.
Deno.removeSync(buildFile);
for (const phase of ["build-2", "pre-replay", "dispose-a", "attribution"]) {
  try {
    Deno.removeSync(`${outDir}/${armName}-N${size}.${phase}.jsonl`);
  } catch { /* absent */ }
}

await runtimeB.dispose();
await storageB.close();
await server.close();

const resultFile = `${outDir}/${armName}-N${size}.result.json`;
Deno.writeTextFileSync(
  resultFile,
  JSON.stringify({
    head,
    status: status.split("\n"),
    deno: Deno.version.deno,
    arm: armName,
    base: arm.base,
    N: size,
    d: degree,
    experimental,
    sharedIds,
    started,
    runtimeErrorsA: errorsA,
    runtimeErrorsB: errorsB,
    checksA,
    checksB,
    ms: {
      build: buildMs,
      add: addMs,
      mention: mentionMs,
      compileB: compileMs,
      startReturned: startReturnedMs,
      start: startMs,
      pull: pullMs,
    },
    build: buildSummary,
    phases: Object.fromEntries(
      Object.entries(phases).map(([name, phase]) => [name, phaseLine(phase)]),
    ),
    startAndPull: classify(startAndPull.values()),
    replay: Object.fromEntries(
      Object.entries(replayDelivered).map((
        [name, delivered],
      ) => [name, classify(delivered.values())]),
    ),
    files: {
      start: startFile,
      pull: pullFile,
      compile: compileFile,
      add: addFile,
      mention: mentionFile,
      replay: replayFiles,
    },
  }) + "\n",
);
console.error(`# result: ${resultFile}`);
