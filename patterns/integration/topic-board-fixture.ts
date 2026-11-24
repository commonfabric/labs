/**
 * Builds a topic board carrying enough synthetic material that opening it
 * exercises the parts of the runtime only large boards reach: a long card list,
 * a prose corpus wide enough for the crossref join to cost something, and one
 * child piece per topic for storage to load.
 *
 * Every topic's title and body are derived from its index, so two runs of the
 * same size produce the same board and their timings are comparable.
 *
 * Seeding holds the board's index live while it writes, and the board recomputes
 * its crossref join on each write, so peak memory rises with the topic count.
 * {@link seedTopicBoardOutOfProcess} runs the seed in a child Deno with a heap
 * of its own, which is how a benchmark gets a large board without carrying that
 * peak for the rest of its run.
 */

import type { JSONSchema } from "@commonfabric/api";
import { type DID, Identity } from "@commonfabric/identity";
import { createTestSpace } from "@commonfabric/integration/test-space";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { Cell } from "@commonfabric/runner";
import {
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { callVerb } from "@commonfabric/piece/verb-call";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import type { Immutable } from "@commonfabric/js-values/types";
import { join } from "@std/path";
import {
  initializePiecesController,
  PieceController,
} from "./pieces-controller.ts";

/** One seeded topic, addressed the way the board's links address it. */
export interface SeededTopic {
  /** The topic piece's tagged hash (`fid1:…`), as pasted into prose. */
  fid: string;
  title: string;
}

export interface TopicBoardFixture {
  /** The authoring subscription used while creating the board. */
  seedDemand: TopicBoardDemand;

  /** The space the board lives in, created for it. */
  spaceDid: DID;

  /** The board piece, for the shell's `/<space DID>/<pieceId>` route. */
  boardId: string;

  /** Seeded topics in creation order. */
  topics: SeededTopic[];
}

export interface SeedTopicBoardOptions {
  apiUrl: URL;

  /** Owner of the space the board is created in. */
  identity: Identity;

  /** How many topics the board carries. */
  topicCount: number;

  /** Index subscription by default; full-result demand is an explicit stress case. */
  demand?: TopicBoardDemand;

  /**
   * How many earlier topics a citing body cites. Every citation is an edge the
   * board's crossref join has to find, and a link its cards render.
   */
  crossrefsPerTopic?: number;

  /**
   * How many of the topics cite anything, counted back from the newest. See
   * {@link DEFAULT_CITING_TOPICS} for why this is not every topic.
   */
  citingTopics?: number;

  /** Words of prose in each topic body. */
  bodyWords?: number;

  /** Called after each topic lands, with its index. */
  onTopic?: (index: number) => void;
}

export const DEFAULT_CROSSREFS_PER_TOPIC = 2;
export const DEFAULT_BODY_WORDS = 120;

export type TopicBoardDemand = "index" | "full";

/** Validate a benchmark's demand setting before it creates a space. */
export function parseTopicBoardDemand(value = "index"): TopicBoardDemand {
  if (value !== "index" && value !== "full") {
    throw new Error(`Topic board demand must be index or full: ${value}`);
  }
  return value;
}

/** Hold the board's current list through the selected authoring subscription. */
export function demandTopicBoard(
  board: PieceController,
  demand: TopicBoardDemand = "index",
): () => void {
  if (demand === "full") {
    return board.pieces().getResult(board.getCell()).sink(() => {});
  }
  return topicBoardIndex(board).sink(() => {});
}

/**
 * Each board's durable result schema, read once. The schema does not change
 * while a board is seeded, and the stored metadata it is read from is not
 * always at hand: under server execution a frame can leave the replica
 * between the result document and the schema document it names.
 */
const durableSchemas = new WeakMap<PieceController, JSONSchema>();

/**
 * The board's `index` under its durable result schema: one bounded row per
 * topic, whose address is the topic's own. The schema has to be applied at the
 * result root, where it describes the value, for `key()` to select the row
 * schema under it.
 */
function topicBoardIndex(board: PieceController): Cell<unknown> {
  const result = board.pieces().getResult(board.getCell());
  let schema = durableSchemas.get(board);
  if (schema === undefined) {
    schema = result.getMetaRaw("schema") as JSONSchema | undefined;
    if (schema === undefined) {
      throw new Error("Topic board result has no durable schema.");
    }
    durableSchemas.set(board, schema);
  }
  return result.asSchema(schema).key("index");
}

/**
 * How many topics carry citations, counted back from the newest.
 *
 * Citations are what a board can least afford. The board recomputes its whole
 * crossref join on every write and the rows it builds carry cited siblings as
 * pieces, so each edge costs the seeding runtime far more than each topic does.
 * A thirty-topic board whose newest three topics cite two earlier ones each
 * seeds in about half a minute and peaks near two and a half gigabytes; six
 * citing topics doubles that peak, and citing from every topic exhausts an
 * eight-gigabyte heap around the twentieth topic. Keeping the citations few
 * leaves the prose corpus — the part that grows with the board — as large as
 * the board is.
 *
 * The newest topics are the ones that cite, because the board orders its cards
 * by last activity, so those are the cards a reader reaches first.
 */
export const DEFAULT_CITING_TOPICS = 3;

const AGENT_NAME = "Topic board benchmark";

/**
 * Vocabulary the generated prose draws from. Any list of words does; these
 * ones keep a generated body readable when a run is inspected by hand.
 */
const WORDS = [
  "attention",
  "boundary",
  "capture",
  "durable",
  "envelope",
  "fabric",
  "gather",
  "handoff",
  "interval",
  "journal",
  "kernel",
  "ledger",
  "moment",
  "notice",
  "outline",
  "pattern",
  "quorum",
  "record",
  "surface",
  "thread",
  "update",
  "vantage",
  "witness",
  "yield",
];

/** Title of the topic at `index`, the same for a board of any size. */
export function topicTitle(index: number): string {
  return `Topic ${String(index).padStart(4, "0")} ${
    WORDS[index % WORDS.length]
  }`;
}

/**
 * Indices of the topics the topic at `index` cites on a board of `topicCount`
 * topics, newest citation first. Only earlier topics can be cited: a body is
 * written at creation, when no later topic has a fid yet. Only the newest
 * `citingTopics` cite at all.
 *
 * The citations are spread evenly over everything earlier, so one reaches the
 * far end of the board as readily as it reaches the neighbour, and the crossref
 * join has to look at scattered entries rather than a run of adjacent ones. The
 * first is always the immediate predecessor, which is the link the navigation
 * benchmark follows.
 *
 * A topic cites `crossrefsPerTopic` siblings whenever it has that many earlier
 * ones to cite, and every earlier sibling when it does not. The count is
 * therefore bounded only by the board, and the shortfall near the start of one
 * is exact rather than incidental.
 */
export function crossrefTargets(
  index: number,
  {
    topicCount,
    crossrefsPerTopic = DEFAULT_CROSSREFS_PER_TOPIC,
    citingTopics = DEFAULT_CITING_TOPICS,
  }: {
    topicCount: number;
    crossrefsPerTopic?: number;
    citingTopics?: number;
  },
): number[] {
  if (index < topicCount - citingTopics) return [];
  const earlier = index;
  const count = Math.min(crossrefsPerTopic, earlier);
  const targets: number[] = [];
  for (let citation = 0; citation < count; citation++) {
    targets.push(index - 1 - Math.floor((citation * earlier) / count));
  }
  return targets;
}

/**
 * `wordCount` words of prose derived from `index`. The stride varies with the
 * index so successive topics do not share a prefix, and a body is not folded
 * away by a layer that stores repeated text once.
 */
function topicProse(index: number, wordCount: number): string {
  const stride = 1 + (index % (WORDS.length - 1));
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(WORDS[(index + i * stride) % WORDS.length]);
  }
  return words.join(" ");
}

/**
 * The body of the topic at `index`. Prose only: what this topic references is
 * recorded as references through `mention`, not written into the sentence.
 */
function topicBody(
  index: number,
  shape: { bodyWords: number },
): string {
  return topicProse(index, shape.bodyWords);
}

/**
 * The topic piece at `index` in the board's list.
 *
 * What is read is the board's index row at `index`, whose schema bounds the
 * read to that row's scalars. Reading the `topics` key with no schema, or the
 * result as a whole, walks every topic the board holds through its links, so
 * each call costs the whole board and the seed that calls it per topic grows
 * quadratically. The read waits for the row to be present: under server
 * execution the verb that files a topic can return before its consequence
 * lands in this replica.
 */
export async function topicAt(
  board: PieceController,
  index: number,
): Promise<PieceController> {
  const row = topicBoardIndex(board).key(index);
  await waitForCellValue(
    board.pieces().runtime,
    row,
    (value: { title?: string } | undefined) => value?.title !== undefined,
    { stuckLabel: `the board's index row for topic ${index}` },
  );
  return new PieceController(board.pieces(), row.resolveAsCell());
}

/**
 * Waits until the board's index lists `titles`, in that order. The index is a
 * query over the board's collection, which follows a topic's fields after the
 * write that changed them, so a board seeded a moment ago can still list a
 * topic under the name it had before it was named.
 */
export async function topicIndexTitles(
  board: PieceController,
  titles: readonly string[],
): Promise<void> {
  await waitForCellValue(
    board.pieces().runtime,
    topicBoardIndex(board),
    (rows: readonly { title?: string }[] | undefined) =>
      rows !== undefined && rows.length === titles.length &&
      rows.every((row, at) => row?.title === titles[at]),
    { stuckLabel: "the board's index in filing order" },
  );
}

/** A topic read for its title and nothing else. */
const TITLE_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
} as const satisfies JSONSchema;

/**
 * Returns the cell `cell` resolves to, loading each document on the way. A
 * link is followed only through documents this replica holds, and a receipt
 * names the piece its handler made through a cell of the handler's own, which
 * holds the link to the piece.
 */
async function resolveLoaded(cell: Cell<unknown>): Promise<Cell<unknown>> {
  let current = cell;
  for (;;) {
    await current.sync();
    const next = current.resolveAsCell();
    if (next.equals(current)) return next;
    current = next;
  }
}

/** What a topic stores of the references its `mention` verb records. */
export interface TopicMentionState {
  /** The topic's `mentioned` list, raw: one link per referenced piece. */
  mentioned: unknown;

  /**
   * The durable entries of the topic's `mention` stream under server
   * execution, each with whether the server has applied it (`consequenced`)
   * or ended it another way (`status`, `error`). Absent where the stream holds
   * no entries.
   */
  mentionEvents: Immutable<StreamEventsDocValue["entries"]>;
}

/**
 * Read what the topic `pieceId` in `spaceDid` stores of its mentions, through a
 * runtime of its own rather than any page's. A topic whose references never
 * render either never had the `mention` applied, which its stream entry shows,
 * or had it applied and lost it on the way to the page, which `mentioned`
 * shows.
 */
export async function readTopicMentionState(options: {
  apiUrl: URL;
  identity: Identity;
  spaceDid: DID;
  pieceId: string;
}): Promise<TopicMentionState> {
  const cc = await initializePiecesController({
    space: options.spaceDid,
    apiUrl: options.apiUrl,
    identity: options.identity,
  });
  try {
    const topic = await cc.get(options.pieceId);
    const result = await topic.result.getCell();
    // The result holds links rather than values: the list and the stream are
    // the topic's own cells, which those links resolve to.
    const mentionedLink = result.key("mentioned");
    const mentionLink = result.key("mention");
    await Promise.all([mentionedLink.pull(), mentionLink.pull()]);
    const mentioned = mentionedLink.resolveAsCell();
    await mentioned.sync();
    // The stream's entries live in a sidecar doc addressed by the stream's
    // cell.
    const stream = mentionLink.resolveAsCell().getAsNormalizedFullLink();
    const entries = cc.runtime.getCellFromEntityId<StreamEventsDocValue>(
      options.spaceDid,
      streamEntriesDocId({
        id: stream.id,
        path: stream.path,
        ...(stream.scope === undefined ? {} : { scope: stream.scope }),
      }),
    );
    await entries.sync();
    return {
      mentioned: mentioned.getRaw(),
      mentionEvents: entries.getRaw()?.entries,
    };
  } finally {
    await cc.dispose();
  }
}

/**
 * Create a space owned by `identity`, create a board in it, and fill the board
 * with `topicCount` topics. The controller that authors the board is disposed
 * before this returns, so the seeded space is left to whatever reads it next
 * with no connection of ours still open.
 */
export async function seedTopicBoard(
  options: SeedTopicBoardOptions,
): Promise<TopicBoardFixture> {
  const shape = {
    topicCount: options.topicCount,
    crossrefsPerTopic: options.crossrefsPerTopic ?? DEFAULT_CROSSREFS_PER_TOPIC,
    citingTopics: options.citingTopics ?? DEFAULT_CITING_TOPICS,
    bodyWords: options.bodyWords ?? DEFAULT_BODY_WORDS,
  };

  const spaceDid = await createTestSpace(options.identity, {
    apiUrl: options.apiUrl,
  });
  const cc = await initializePiecesController({
    space: spaceDid,
    apiUrl: options.apiUrl,
    identity: options.identity,
  });
  const failedIntents: string[] = [];
  const stopOutcomes = cc.runtime.subscribeEventIntentOutcomes((outcome) => {
    failedIntents.push(
      `${outcome.eventId}: ${outcome.kind}: ${outcome.reason}`,
    );
  });
  let releaseBoard: (() => void) | undefined;
  try {
    await cc.ensureDefaultPattern();

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "apps",
      "topics",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    const board = await cc.create(program, { start: true });

    const demand = options.demand ?? "index";
    releaseBoard = demandTopicBoard(board, demand);
    // Who derives what a topic publishes decides what the seed reads. With
    // client execution the seed's runtime is the only runtime running the
    // board and its topics, so what it never reads is never derived, and a
    // board opened elsewhere would find no published summaries and an empty
    // crossref table. Under server execution the serving runtime derives a
    // published value when a reader demands it, so the seed sends its events
    // and reads none of it: every read here would be demand for the serving
    // runtime to derive, and a wait for it to do so, per topic.
    const served = cc.runtime.experimental.serverExecution === true;

    const topics: SeededTopic[] = [];
    // The created pieces themselves, because a mention is a reference: the
    // fid is what the fixture reports, not what it seeds an edge with.
    const pieces: PieceController[] = [];
    for (let index = 0; index < options.topicCount; index++) {
      const title = topicTitle(index);
      // The create's receipt names the topic it made, which is how the
      // Topics tooling addresses a new topic too. The board lists a topic
      // only once its collection has it, so the board's list is not where a
      // topic created a moment ago is found.
      const call = await callVerb(
        cc.runtime,
        board.getCell().getAsNormalizedFullLink(),
        "addTopic",
        { title, body: topicBody(index, shape), agentName: AGENT_NAME },
      );
      if (call.status !== "settled" || call.receipt === undefined) {
        throw new Error(
          `addTopic for topic ${index} did not settle with a receipt: ` +
            JSON.stringify(call),
        );
      }
      // The receipt holds a link to the topic, which resolves to the topic's
      // own address only once the receipt is in this replica.
      // Confirmed before it is addressed, as the tooling confirms a create:
      // the receipt can arrive in this replica ahead of the topic it names.
      const named = cc.runtime.getCellFromLink(call.receipt).key("topic");
      await waitForCellValue(
        cc.runtime,
        named.asSchema(TITLE_SCHEMA),
        (value: { title?: string } | undefined) => value?.title === title,
        { stuckLabel: `the topic addTopic created for index ${index}` },
      );
      const created = new PieceController(
        board.pieces(),
        await resolveLoaded(named),
      );
      // Each citation is a REFERENCE, recorded through the topic's own verb.
      // Nothing reads prose for addresses, so a board seeded with
      // `See also fid1:…` sentences would carry the sentences and none of the
      // graph, and every benchmark over it would measure a board with no
      // references at all.
      const targets = crossrefTargets(index, shape);
      for (const target of targets) {
        await created.result.set({ topic: pieces[target].getCell() }, [
          "mention",
        ]);
      }
      // What a topic publishes — its summary, and the mentions the board's
      // collection mirrors into its relation tables — is derived by a running
      // topic: a reader that opens another topic reads this one's published
      // result and runs nothing of it. So each topic is read once here,
      // rather than once per write.
      if (served) {
        // Only the two values a topic computes, read once so that the
        // serving runtime derives them: who filed it, and what it points at,
        // which is what reaches the collection's `topics_mentions` table.
        // The rest of the result, the backlinks the topic asks the collection
        // for among it, is not read. A topic filed through the board's page
        // is read by that page, and the Topics tooling reads the topic it
        // created to confirm it landed.
        await created.result.get(["createdBy"]);
        await created.result.get(["mentions"]);
      } else {
        // The whole result, which also runs the topic's backlink query
        // against the board's collection.
        await created.result.get();
      }
      pieces.push(created);
      topics.push({ fid: created.id, title });
      options.onTopic?.(index);
    }
    if (served) {
      // A send returns with its event committed and the served run of the
      // handler ahead. The board is handed on once every event sent above
      // has its consequence stored, which is one wait at the end rather than
      // one per send.
      await cc.runtime.speculationOverlay?.waitForIntentQuiescence();
      if (failedIntents.length > 0) {
        throw new Error(
          `Topic seed events failed:\n${failedIntents.join("\n")}`,
        );
      }
    } else {
      // This runtime is what keeps the board's collection current, there
      // being no serving one, and a reader that opens the board later hears
      // of no write made before it arrived. So the collection is brought up
      // to every write above before the runtime that made them goes away.
      await cc.runtime.settled();
      await board.result.get(["crossrefs"]);
    }

    return {
      spaceDid,
      boardId: board.id,
      seedDemand: demand,
      topics,
    };
  } finally {
    stopOutcomes();
    releaseBoard?.();
    await cc.dispose();
  }
}

export interface SeedTopicBoardOutOfProcessOptions {
  apiUrl: URL;

  /** Passphrase the child derives the seeding identity from. */
  passphrase: string;
  topicCount: number;
  demand?: TopicBoardDemand;
  crossrefsPerTopic?: number;
  citingTopics?: number;
  bodyWords?: number;

  /** Heap ceiling for the child, in megabytes. */
  heapMegabytes?: number;
}

/**
 * Peak heap while seeding rises with the topic count, so a board large enough
 * to be worth measuring is seeded well above the heap a benchmark process
 * otherwise needs. Raising the ceiling for one child costs the parent nothing.
 */
export const DEFAULT_SEED_HEAP_MEGABYTES = 8192;

const REPO_ROOT = join(import.meta.dirname!, "..", "..");

/**
 * Seed a board in a child Deno and return what it wrote. The child exits when
 * the board is complete, so its peak heap is gone before the caller reads the
 * fixture.
 */
export async function seedTopicBoardOutOfProcess(
  options: SeedTopicBoardOutOfProcessOptions,
): Promise<TopicBoardFixture> {
  const script = join(import.meta.dirname!, "topic-board-seed.ts");
  const outputDirectory = await Deno.makeTempDir({
    prefix: "commonfabric-topic-board-",
  });
  const output = join(outputDirectory, "fixture.json");
  try {
    const heap = options.heapMegabytes ?? DEFAULT_SEED_HEAP_MEGABYTES;
    const result = await runDenoCommandWithTemporaryLock({
      root: REPO_ROOT,
      args: (lockPath) => [
        "run",
        "--lock",
        lockPath,
        "--no-check",
        `--v8-flags=--max-old-space-size=${heap}`,
        "-A",
        script,
        `--api-url=${options.apiUrl.href}`,
        `--passphrase=${options.passphrase}`,
        `--topics=${options.topicCount}`,
        `--demand=${options.demand ?? "index"}`,
        `--crossrefs=${
          options.crossrefsPerTopic ?? DEFAULT_CROSSREFS_PER_TOPIC
        }`,
        `--citing-topics=${options.citingTopics ?? DEFAULT_CITING_TOPICS}`,
        `--body-words=${options.bodyWords ?? DEFAULT_BODY_WORDS}`,
        `--out=${output}`,
      ],
    });
    if (!result.success) {
      throw new Error(
        `Seeding a ${options.topicCount}-topic board failed (exit ${result.code}):\n${
          new TextDecoder().decode(result.stderr)
        }`,
      );
    }
    return JSON.parse(await Deno.readTextFile(output)) as TopicBoardFixture;
  } finally {
    await Deno.remove(outputDirectory, { recursive: true });
  }
}

/** The identity a seeded board is authored by, and read back with. */
export function seedIdentity(passphrase: string): Promise<Identity> {
  return Identity.fromPassphrase(passphrase, { implementation: "noble" });
}
