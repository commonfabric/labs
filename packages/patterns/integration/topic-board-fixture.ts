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
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
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
  const result = board.pieces().getResult(board.getCell());
  if (demand === "full") return result.sink(() => {});
  const schema = result.getMetaRaw("schema") as JSONSchema | undefined;
  if (schema === undefined) {
    throw new Error(
      "Topic board result has no durable schema for index demand.",
    );
  }
  // The durable schema describes the result root. key() needs it on that root
  // to select the index row schema for the subscription.
  return result.asSchema(schema).key("index").sink(() => {});
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
 * Only the `topics` key is pulled. The board's result also carries `crossrefs`,
 * whose rows are piece-valued and expand through each topic's view of every
 * sibling; pulling the whole result grows without bound as the board fills.
 */
export async function topicAt(
  board: PieceController,
  index: number,
): Promise<PieceController> {
  const topics = (await board.result.getCell()).key("topics");
  await topics.pull();
  return new PieceController(
    board.pieces(),
    topics.key(index).resolveAsCell(),
  );
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
    cfcFlowLabels: "persist",
    apiUrl: options.apiUrl,
    identity: options.identity,
  });
  let releaseBoard: (() => void) | undefined;
  try {
    await cc.ensureDefaultPattern();

    const sourcePath = join(import.meta.dirname!, "..", "topics", "main.tsx");
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    const board = await cc.create(program, { start: true });

    const demand = options.demand ?? "index";
    releaseBoard = demandTopicBoard(board, demand);

    const topics: SeededTopic[] = [];
    // The created pieces themselves, because a mention is a reference: the
    // fid is what the fixture reports, not what it seeds an edge with.
    const pieces: PieceController[] = [];
    for (let index = 0; index < options.topicCount; index++) {
      const title = topicTitle(index);
      await board.result.set({
        title,
        body: topicBody(index, shape),
        agentName: AGENT_NAME,
      }, ["addTopic"]);
      const created = await topicAt(board, index);
      // Each citation is a REFERENCE, recorded through the topic's own verb.
      // Writing `See also fid1:…` into the body used to make an edge; nothing
      // reads prose for addresses now, so a seeded board built that way would
      // carry the sentences and none of the graph — and every benchmark over it
      // would quietly measure a board with no crossrefs at all.
      for (const target of crossrefTargets(index, shape)) {
        await created.result.set({ topic: pieces[target].getCell() }, [
          "mention",
        ]);
      }
      pieces.push(created);
      topics.push({ fid: created.id, title });
      options.onTopic?.(index);
    }

    return {
      spaceDid,
      boardId: board.id,
      seedDemand: demand,
      topics,
    };
  } finally {
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

const REPO_ROOT = join(import.meta.dirname!, "..", "..", "..");

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
