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
const deferDemand = args["defer-demand"] === "true";
// `--forward` models a topic whose document has moved and left a forwarding
// link: the board's list entry for topic 0 is rewritten to a new document
// whose only content is a link to topic 0, so the board holds the old address
// and every reader of the list reaches the topic through one more hop.
const forward = args.forward === "true";
// `--synthesize` writes the topics past the measured few straight to storage
// rather than filing them through `addTopic`: one document per topic, one
// namespace entry, and one entry slot each, appended to the board's own
// inputs. What it buys is a size a verb-filed build cannot reach; what it
// costs is that those topics are documents rather than pieces, so the board's
// derivations run over them but nothing runs them. The measured topic and the
// topics that mention it are filed through the verb either way.
const synthesize = args.synthesize === "true";
// `--adopt` measures how a topic filed before the design is handed its entry.
// The board's create hands nothing in the `r4-adopt` arm, so the topics start
// without one: `backfillEntries` mints the entries, and then either the topic
// takes its own through a verb of its own (`verb`), or an operator writes the
// reference into the topic's argument from outside (`operator`).
const adopt = args.adopt;
if (adopt !== undefined && adopt !== "verb" && adopt !== "operator") {
  throw new Error(`--adopt must be verb or operator, not \`${adopt}\``);
}
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
// Held live: only the board outputs the arm's topics read, each under its
// property of the board's result schema. A sink on the whole result would
// also demand the board's rendered cards, one sub-pattern per topic, which no
// topic reads.
//
// `--defer-demand` holds nothing live while the topics are filed and demands
// the same outputs once at the end of the build instead. The board's
// derivations then run over the finished list rather than once per file,
// which is what makes a large board affordable; the measured phases below
// (`op-add`, `op-mention`, `start`) all run with the demand in place, and the
// figures at a size measured both ways agree.
const cancels: (() => void)[] = [];
const demandBoard = () => {
  for (const key of arm.demand) cancels.push(board.key(key).sink(() => {}));
};
const cancelBoard = () => cancels.forEach((cancel) => cancel());
if (!deferDemand) demandBoard();
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
// Filed through the verb: every topic, or — when the remainder is
// synthesized — the measured topic and the topics that mention it.
const filedInBuild = synthesize ? 1 + degree : size - 1;
for (let n = 1; n <= filedInBuild; n++) await fileTopic(n);
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
if (synthesize) {
  // The topics that mention the measured one are the ones the verb filed.
  for (let from = 1; from <= degree; from++) pending.push([from, 0]);
} else {
  for (let from = 1; from < size; from++) {
    for (let step = 1; step <= degree; step++) {
      const to = (from + step) % size;
      if (to === from) continue;
      pending.push([from, to]);
    }
  }
}
const lastMention = synthesize
  ? pending[pending.length - 1]
  : pending.find(([from, to]) => from === size - 1 && to === 0);
// A verb-filed build defers every mention made BY the topic the add files;
// a synthesized one defers only the last mention, which is what `op-mention`
// measures.
const early = synthesize
  ? pending.filter((entry) => entry !== lastMention)
  : pending.filter(([from]) => from < size - 1);
await topics.pull();
for (const [from, to] of early) {
  // A mention of a topic the add below files waits for it to exist.
  if (!synthesize && to === size - 1) continue;
  await mention(from, to);
}
// --- The synthesized remainder, where one is asked for --------------------

if (synthesize) {
  stage("synthesize");
  const argumentMeta = getMetaLink(boardCell, "argument");
  if (argumentMeta === undefined) throw new Error("board has no argument");
  // deno-lint-ignore no-explicit-any
  const argumentOf = (tx: any) =>
    runtimeA.getCellFromLink({ ...argumentMeta, schema: undefined }).withTx(tx);
  const filed = 1 + degree;
  const chunk = 100;
  for (let from = filed; from < size - 1; from += chunk) {
    const upto = Math.min(from + chunk, size - 1);
    await runtimeA.editWithRetry((tx) => {
      const argument = argumentOf(tx);
      const listed = [
        ...(argument.key("topics").getRaw() as Json[] ?? []),
      ];
      const named = {
        ...(argument.key("names").getRaw() as Record<string, Json> ?? {}),
      };
      const slots = [
        ...(argument.key("entrySlots").getRaw() as Json[] ?? []),
      ];
      for (let index = from; index < upto; index++) {
        const name = String(index + 1);
        const topic = runtimeA.getCell<Json>(
          space,
          { syntheticTopic: index },
          undefined,
          tx,
        );
        topic.setRaw({
          title: `Topic ${index + 1}`,
          body: `Body of topic ${index + 1}. ${"x".repeat(400)}`,
          createdAt: 1_700_000_000_000 + index,
          createdBy: { kind: "agent", name: "probe" },
          shortName: name,
          mentions: [],
          mentioned: [],
          comments: [],
          links: [],
          references: {},
          commentCount: 0,
          lastActivityAt: 1_700_000_000_000 + index,
        });
        const entry = runtimeA.getCell<Json>(
          space,
          { syntheticEntry: index },
          undefined,
          tx,
        );
        entry.setRaw({ name, mentionedBy: [] });
        listed.push(topic.getAsLink());
        named[name] = topic.getAsLink();
        slots.push({ name, entry: entry.getAsLink() });
      }
      argument.key("topics").setRaw(listed);
      argument.key("names").setRaw(named);
      argument.key("entrySlots").setRaw(slots);
    });
  }
  await runtimeA.idle();
  await storageA.synced();
  rotate("synthesize");
}

await runtimeA.idle();
if (deferDemand) {
  demandBoard();
  await runtimeA.idle();
}
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
if (!synthesize) {
  for (const [from, to] of early) {
    if (to === size - 1) await mention(from, to);
  }
  for (const [from, to] of pending) {
    if (from === size - 1 && !(to === 0 && lastMention !== undefined)) {
      await mention(from, to);
    }
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

// --- Adoption, where one is asked for ------------------------------------

let adoption: Json;
if (adopt !== undefined) {
  // The entry has to exist before a topic can be handed it. The board's own
  // `backfillEntries` verb mints one per named topic in a single
  // transaction, and it does NOT settle: see the broken run recorded in
  // COMMANDS.md. So the entry is minted here, in one transaction, which is
  // what an operator's tooling does — and what the board verb would do once
  // it settles.
  stage("adopt: mint one entry");
  const mintStart = performance.now();
  const boardArgumentMeta = getMetaLink(boardCell, "argument");
  if (boardArgumentMeta === undefined) throw new Error("board has no argument");
  let mintedId: string | undefined;
  await runtimeA.editWithRetry((tx) => {
    const argument = runtimeA
      .getCellFromLink({ ...boardArgumentMeta, schema: undefined })
      .withTx(tx);
    const slots = [...(argument.key("entrySlots").getRaw() as Json[] ?? [])];
    const entry = runtimeA.getCell<Json>(
      space,
      { adoptedEntryFor: "1" },
      undefined,
      tx,
    );
    entry.setRaw({ name: "1", mentionedBy: [] });
    mintedId = entry.getAsNormalizedFullLink().id;
    slots.push({ name: "1", entry: entry.getAsLink() });
    argument.key("entrySlots").setRaw(slots);
  });
  await runtimeA.idle();
  await storageA.synced();
  const mintMs = ms(mintStart);
  const mintFile = rotate("op-mint");

  const entryCell = runtimeA.getCellFromLink({
    space: space as Json,
    id: mintedId!,
    path: [],
    type: "application/json",
  } as Json);

  stage(`adopt: ${adopt}`);
  const adoptStart = performance.now();
  if (adopt === "verb") {
    // The topic's own verb writes the reference into its own input.
    const adoptEntry = topicAt(0).key("adoptEntry");
    await adoptEntry.pull();
    await runtimeA.editWithRetry((tx) =>
      adoptEntry.withTx(tx).send({ entry: entryCell })
    );
  } else {
    // An operator writes the topic's argument from outside, which is what a
    // one-time link-bind through the CLI does.
    const argumentMeta = getMetaLink(topicAt(0), "argument");
    if (argumentMeta === undefined) throw new Error("topic has no argument");
    await runtimeA.editWithRetry((tx) => {
      runtimeA.getCellFromLink({ ...argumentMeta, schema: undefined })
        .withTx(tx)
        .key("ownEntry")
        .setRaw(entryCell.withTx(tx).getAsLink());
    });
  }
  await runtimeA.idle();
  await storageA.synced();
  const adoptMs = ms(adoptStart);
  const adoptFile = rotate("op-adopt");
  adoption = {
    route: adopt,
    mintedEntry: mintedId,
    mintMs,
    adoptMs,
    mintFile,
    adoptFile,
  };
}

// --- The move, where one is asked for ------------------------------------

const topic0Before = topicAt(0).getAsNormalizedFullLink();
let forwarderId: string | undefined;
if (forward) {
  stage("forward");
  const argumentMeta = getMetaLink(boardCell, "argument");
  if (argumentMeta === undefined) throw new Error("board has no argument");
  await runtimeA.editWithRetry((tx) => {
    const forwarder = runtimeA.getCell<Json>(
      space,
      { forwarderFor: topic0Before.id },
      undefined,
      tx,
    );
    forwarder.setRaw(
      runtimeA.getCellFromLink(topic0Before).withTx(tx).getAsLink(),
    );
    forwarderId = forwarder.getAsNormalizedFullLink().id;
    const argument = runtimeA.getCellFromLink({
      ...argumentMeta,
      schema: undefined,
    }).withTx(tx);
    argument.key("topics").key(0).setRaw(forwarder.getAsLink());
  });
  await runtimeA.idle();
  await storageA.synced();
  rotate("forward");
}

// --- Ownership, and what runtime A computed for topic 0 -------------------

stage("ownership");
const topicCells = Array.from({ length: size }, (_, index) => topicAt(index));
// After a move the list entry resolves through the forwarder, so the cell the
// list hands back is the topic itself either way.
const topic0 = topicCells[0];
const topic0Link = topic0.getAsNormalizedFullLink();
// What the move produced: the address the board's list now holds (the
// forwarder), the document the topic is at (unchanged), and the raw value the
// list entry carries, which must be a link to the forwarder.
const listEntryRaw = forward
  ? (() => {
    const argumentMeta = getMetaLink(boardCell, "argument")!;
    return runtimeA.getCellFromLink({ ...argumentMeta, schema: undefined })
      .key("topics").getRaw() as Json;
  })()
  : undefined;
const movedTo = forward
  ? {
    topicWasAt: topic0Before.id,
    topicIsAt: topic0Link.id,
    forwarderId,
    listEntry0: Array.isArray(listEntryRaw)
      ? JSON.stringify(listEntryRaw[0]).slice(0, 220)
      : JSON.stringify(listEntryRaw).slice(0, 220),
  }
  : undefined;
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
// The document the topic moved out of is the topic's own.
if (forwarderId !== undefined) note(forwarderId, "self");
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
if (adoption !== undefined) {
  phases["op-mint"] = summarizePhase(adoption.mintFile);
  phases["op-adopt"] = summarizePhase(adoption.adoptFile);
}
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

/** The largest documents a phase delivered, with whose each is. */
const largest = (delivered: Iterable<Delivered>, count = 8) =>
  [...delivered]
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, count)
    .map(({ id, scope, bytes }) => ({
      id: id.slice(0, 26),
      scope,
      bytes,
      whose: owner.get(id) ?? familyOf(id) ??
        (id.startsWith("cid:") ? "schema" : "unattributed"),
    }));

const phaseLine = (phase: ReturnType<typeof summarizePhase>) => {
  const { delivered, ...rest } = phase;
  return {
    ...rest,
    ...classify(delivered.values()),
    largest: largest(delivered.values()),
  };
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
    what: arm.what,
    N: size,
    d: degree,
    deferDemand,
    forward,
    movedTo,
    synthesize,
    adoption,
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
