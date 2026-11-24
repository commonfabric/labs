/**
 * Runs Topics (`patterns/apps/topics/`) at several sizes of the board on
 * the executor of `../../exec/` and on today's runtime, and measures the
 * board's load, the creation of one topic, and an edit of one topic.
 *
 * `deno run -A --no-check base/pattern-compiler/compare/topics/scale.ts <arm> [sizes | --seed <seed>]`
 *
 * `<arm>` is `executor`, `storage`, `runner`, `serving`, `serving-today`,
 * `today` or `today-labeled`, and each
 * run prints one line of JSON per measured step. The arms run in processes
 * of their own, one after the other, so that no two timed runs share a
 * machine at once.
 *
 * - `executor`: the executor with its documents in memory.
 * - `runner`: the board as a compiled piece in the runner
 *   (`startCompiledPiece` of `runtime/runner/src/compiled/piece.ts`), with
 *   the experimental option `compiledPatterns` on. Every call of the runtime
 *   is that of the arm `today-labeled`: the topics and the inputs are cells
 *   written with `Cell.set` under the same schemas, an edit is a `Cell.set`
 *   of a topic's title, a create is `Cell.send` on `addTopic`, and a step
 *   ends when the scheduler is idle with no commit pending.
 * - `storage`: the executor with its documents in the runtime's storage
 *   (`../runtime-transactions.ts`), in a runtime that serves the space with
 *   the experimental option `compiledPatterns` on. Each topic and each
 *   input of the board is a document under a schema that declares a
 *   clause, so every commit that reads one runs the preparation of
 *   Contextual Flow Control, and the paths the executor's write records
 *   cover store the labels of their templates. With `SCALE_TOPIC_LABELS`
 *   set to `distinct`, each topic has a clause of its own, and otherwise
 *   every topic has the clause of the input `topics`. With `SCALE_CHECK`
 *   set, each edit also checks the labels it stored (`StorageStep.checked`).
 *   With `SCALE_REORDER` set, a step `reorder` follows the edits: a writer
 *   outside the board writes the `lastActivityAt` of the topic filed first,
 *   which makes it the one last active.
 * - `serving` and `serving-today`: the board under the serving loop, as a
 *   compiled piece and as today's piece, timed on two clients
 *   (`./serving.ts`). With `SCALE_SERVING_LABELS` set, the topics and the
 *   inputs are written under the clauses the arm `runner` writes them
 *   under, in the space of the same identity.
 * - `today`: today's runtime, with no label stored.
 * - `today-labeled`: today's runtime with `cfcFlowLabels` at `persist` and
 *   the same clauses on the topics and the inputs.
 *
 * With `--seed`, the board is the one a seed of `board-seed.ts` holds: the
 * topics of a real board, with their mentions and its namespace, in place of
 * generated ones.
 *
 * A generated board holds `size` topics. Each is a document of its own that holds
 * what the board demands of a topic (`TopicDemand` in `main.tsx`): a title,
 * a body, the times, an author, a number, and references to the two
 * topics before it as its mentions. The board's argument holds a reference
 * to each, and the namespace holds each number with a reference to its
 * topic. The topics are documents and no running instances: the board
 * reads what a topic publishes, and nothing of the board runs a topic.
 *
 * The steps:
 *
 * - `load`: the board is started on that argument and brought up to date,
 *   and its result is read.
 * - `edit`: a writer outside the board writes the title of one topic, and
 *   the board is brought up to date. Three edits, of three topics.
 * - `create`: the board's `addTopic` is sent an event, which creates a
 *   topic, an instance of `topic.tsx` that runs, and appends it. Three
 *   creates.
 *
 * Each step after `load` is timed until the board is up to date
 * (`settle`), and the read of its result after that apart (`read`), since
 * the read is the reader's cost and grows with the board in both arms.
 * Each step also records what the board holds afterwards in a few facts
 * that the two arms are compared on (`facts`).
 *
 * Run with `--v8-flags=--expose-gc`, each step after its timed part also
 * records the heap in use after a full collection (`heap`), and the run
 * first prints a step `baseline` with the heap before any topic exists: the
 * program is compiled or emitted, and no document is seeded. The heap of a
 * step less the baseline is what the board and its documents keep. Without
 * the flag the field is absent. Run one size per process, since a process
 * that has run a larger board may keep more heap than one that has not.
 *
 * Every arm runs the program of the repository, which the crate emits for
 * the executor and today's runtime compiles.
 *
 * With `SCALE_MESSAGE_SLOTS` set to a number, the memory server of the arms
 * that use the runtime's storage takes client messages that stand for up
 * to that many array slots and record members, in place of its default of
 * 1,000,000 (`MAX_UNTRUSTED_MESSAGE_SLOTS` of `runtime/memory/v2.ts`).
 *
 * With `SCALE_BOARD` set to `filing-order` or `sorted-references`, every
 * arm runs that board in place of `main.tsx` (`BOARDS`): the board with a
 * card derived for each topic by a `map` over the array of topic
 * references, in filing order, or by a `map` over the result of a `lift`
 * that gives the references in the order of last activity.
 *
 * With `SCALE_LABEL_DUMP` set to the path of a file, the arm `storage`
 * appends to that file, after each step, one line of JSON for each document
 * the step's commits changed: the step, the kind of the document, its
 * entity, and every label entry it holds, each with its path, its class and
 * its label in place. The file grows with the square of the board where
 * each topic has a clause of its own, so it is for boards of a few topics.
 *
 * With `SCALE_CONSUMED` set to the path of a file, the arm `runner` appends
 * to that file, after each step, one line of JSON for each path of the
 * result document with the clauses a read of the value there consumes in
 * the runtime's own resolution. Two runs of one board and size, one with
 * `SCALE_ROWS=in-place`, are compared line by line: a clause that only the
 * rows in place give is an under-label of the rows as documents. The run
 * is a check of correctness and its times are no measurement.
 *
 * With `SCALE_WRITE_ALONE` set, the arms of the runtime's own calls
 * (`runner`, `today`, `today-labeled`) time, before each edit, a write of
 * a field of the same topic that the board does not read (`write alone`):
 * what the write itself costs, the memory server's handling included.
 *
 * With `SCALE_LISTS=in-place`, the arm `runner` and the arm `serving` store
 * the links to the row documents and to the bucket documents of the board
 * in the result document, and otherwise in documents of their own
 * (`CompiledPieceOptions.lists`). `SCALE_LIST_WHOLE` is the most rows whose
 * links one list document holds (`CompiledPieceOptions.listWhole`). With
 * `SCALE_LAYOUT` set, the arm `serving` writes to the error stream, for
 * each step, how the serving runtime holds the list the step waits on, once
 * that runtime is quiescent: the links of the list document, or the links
 * of each chunk.
 *
 * With `SCALE_LOAD_ROWS` set to a number, the arm `runner` loads the board
 * with at most that many row documents in one transaction
 * (`CompiledPieceOptions.loadRows`), and with `Infinity` in one transaction.
 *
 * With `SCALE_FIELD_EDITS` set, the arms of the runtime's own calls time,
 * after the edits of a title, an edit of the mentions, of the `shortName`
 * and of the `lastActivityAt` of the middle topic.
 *
 * With `SCALE_CPU_PROFILE` set to the path of a file, the run is sampled
 * every half millisecond and the profile of the whole process is written
 * there when the arm has run, in the format of the V8 inspector. With
 * `SCALE_PROFILE_STEP` naming a step, the profile is of that step alone;
 * naming several steps separated by commas, each has a profile of its own
 * at the path followed by the step's name and `.cpuprofile`.
 *
 * With `SCALE_COMMITS` set, each step of the arms of the runtime's own
 * calls lists its commits (`commitLog`): how many documents each changed,
 * the size of those documents as JSON after the commit, and the four
 * largest with the number of paths that changed in each.
 */
import { Identity } from "@commonfabric/identity";
import { fromFileUrl } from "@std/path";
// deno-lint-ignore no-external-import -- The sampling profiler is reached through this Node builtin alone.
import inspector from "node:inspector";
// deno-lint-ignore no-external-import -- Deno writes a heap snapshot through this Node builtin alone.
import v8 from "node:v8";

import {
  getTimingStatsBreakdown,
  resetAllTimingStats,
} from "../../../logger/src/logger.ts";
import type { JSONSchema } from "../../../../runtime/runner/src/builder/types.ts";
import {
  type MemorySpace,
  recordRelevantSchemaWritePolicyInput,
} from "../../../../runtime/runner/src/cell.ts";
import {
  consumedEntriesForRead,
  labelForConsumedEntries,
} from "../../../../runtime/runner/src/cfc/consumed-label.ts";
import { readStoredCfcMetadata } from "../../../../runtime/runner/src/cfc/metadata.ts";
import { deriveFlowJoin } from "../../../../runtime/runner/src/cfc/prepare.ts";
import { diffAndUpdate } from "../../../../runtime/runner/src/data-updating.ts";
import { resolveLocalProgram } from "../../../../runtime/runner/src/harness/local-program.deno.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../../../runtime/runner/src/compiled/piece.ts";
import type { NormalizedFullLink } from "../../../../runtime/runner/src/link-types.ts";
import { createSigilLinkFromParsedLink } from "../../../../runtime/runner/src/link-utils.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "../../../../runtime/runner/src/storage/cache.deno.ts";
import {
  type Artifact,
  Instance,
  type TransactionHooks,
} from "../../exec/executor.ts";
import { identifierOf, isLink, Ref } from "../../exec/store.ts";
import { generateInputs, inputClause } from "../generate.ts";
import { scenarioAudience } from "../harness.ts";
import { RuntimeTransactions } from "../runtime-transactions.ts";
import { runServing } from "./serving.ts";

const repository = fromFileUrl(new URL("../../../../", import.meta.url));

/**
 * The boards a run can take, by the name `SCALE_BOARD` gives, each as its
 * module relative to `patterns/`. They differ in how the cards are derived.
 */
const BOARDS: Record<string, string> = {
  // One `lift` over the whole list gives the rows of all cards, sorted.
  "main": "apps/topics/main.tsx",
  // A `map` over the array of topic references, in filing order.
  "filing-order": "apps/topics/board-filing-order.tsx",
  // A `lift` gives the references in order, and a `map` over its result.
  "sorted-references": "apps/topics/board-sorted-references.tsx",
};

/** The module of the board of this run. */
const BOARD = (() => {
  const name = Deno.env.get("SCALE_BOARD") ?? "main";
  const module = BOARDS[name];
  if (module === undefined) {
    throw new Error(
      `SCALE_BOARD names no board: ${name}. The boards are ${
        Object.keys(BOARDS).join(", ")
      }.`,
    );
  }
  return module;
})();

/** The files of the program of Topics, relative to `patterns/`. */
const TOPICS_FILES = [
  ...new Set([BOARD, "apps/topics/main.tsx"]),
  "apps/topics/card-text.ts",
  "apps/topics/crossref-index.ts",
  "apps/topics/topic.tsx",
  "product/collection-naming/mentionable.ts",
  "product/collection-naming/naming.ts",
  "product/collection-naming/allocator.ts",
  "system/profile-face/profile-face.ts",
];

/** What one topic of the board holds, with `mentions` as indexes. */
type TopicData = {
  $NAME: string;
  title: string;
  body: string;
  createdAt: number;
  createdBy: { kind: string; name: string; avatar?: string };
  commentCount: number;
  lastActivityAt: number;
  shortName?: string;
  mentions: number[];
};

/** The board both arms start on: its topics and its namespace. */
type Board = {
  topics: TopicData[];
  /** Each name with the index of the topic it names. */
  names: Record<string, number>;
};

/** One topic of a generated board. */
const topicOf = (index: number): TopicData => ({
  $NAME: `Topic ${index}`,
  title: `Topic ${index}`,
  body: `The body of topic ${index}, which says what it is about.`,
  createdAt: 1_000 + index,
  createdBy: { kind: "agent", name: "seed" },
  commentCount: index % 3,
  lastActivityAt: 1_000 + index,
  shortName: `${index + 1}`,
  mentions: [index - 1, index - 2].filter((target) => target >= 0),
});

/** A generated board of `size` topics, each named by its number. */
const generated = (size: number): Board => ({
  topics: Array.from({ length: size }, (_, index) => topicOf(index)),
  names: Object.fromEntries(
    Array.from({ length: size }, (_, index) => [`${index + 1}`, index]),
  ),
});

/** The board a seed of `board-seed.ts` holds. */
const seeded = async (path: string): Promise<Board> => {
  const { topics, names } = JSON.parse(await Deno.readTextFile(path)) as Board;
  return { topics, names };
};

const CREATED = (turn: number) => ({
  title: `Created ${turn}`,
  body: `The body of created topic ${turn}.`,
  agentName: "scale",
});

/** The topics whose titles the three edits write. */
const edited = (size: number) => [0, Math.floor(size / 2), size - 1];

/** What the board holds after a step, as both arms read it. */
export type Facts = {
  topicCount: unknown;
  names: number;
  index: number;
  firstTitles: unknown[];
  crossrefs: number;
  mentionedBy: number;
  mentionable: number;
  namesTable: number;
};

/** The arms of a run. */
type Arm = "executor" | "storage" | "runner" | "today" | "today-labeled";

/** One measured step. */
export type Step = {
  arm: Arm;
  size: number;
  step: string;
  /** Until the board is up to date, in milliseconds. */
  settle: number;
  /** The read of the board's result after that, in milliseconds. */
  read: number;
  /** The executor's evaluations, or today's runs of a scheduler action. */
  work: number;
  /** The executor's transactions, or today's commits. */
  commits: number;
  documents: number;
  facts: Facts;
  /** The heap in use after the step and a full collection, in bytes. */
  heap?: number;
};

/** A step `baseline`: the heap before any topic exists, in bytes. */
export type Baseline = {
  arm: Arm;
  size: number;
  step: "baseline";
  heap?: number;
};

const round = (milliseconds: number) => Math.round(milliseconds * 100) / 100;

/** Adds a step to those of a run and prints it, so a run that stops leaves what it measured. */
const record = <T>(steps: T[], step: T): void => {
  steps.push(step);
  console.log(JSON.stringify(step));
};

/**
 * The emulated storage of a run as `as`, and what closes it. With
 * `SCALE_MESSAGE_SLOTS` set, its memory server has the limit on the slots
 * of one client message raised to that number.
 */
const storageAs = (
  as: Identity,
): { storageManager: StorageManager; close: () => Promise<void> } => {
  const slots = Deno.env.get("SCALE_MESSAGE_SLOTS");
  if (slots === undefined) {
    const storageManager = StorageManager.emulate({ as });
    return { storageManager, close: () => storageManager.close() };
  }
  const server = newLoopbackServer({
    subscriptionRefreshDelayMs: 0,
    untrustedMessageSlots: Number(slots),
  });
  const storageManager = EmulatedStorageManager.connectTo(server, { as });
  return {
    storageManager,
    close: async () => {
      await storageManager.close();
      await server.close();
    },
  };
};

/** The steps after which `SCALE_HEAP_SNAPSHOTS` asks for a heap snapshot. */
const SNAPSHOT_STEPS = new Set(["baseline", "load", "create 2"]);

/**
 * The heap in use after a full collection, in bytes, or `undefined` when
 * the process was not started with `--v8-flags=--expose-gc`. With
 * `SCALE_HEAP_SNAPSHOTS` naming a directory, the baseline, the load and the
 * last create also write a V8 heap snapshot there, as
 * `<arm>-<size>-<step>.heapsnapshot`, for the heap tools of
 * `skills/perf-investigation/scripts/`.
 */
const heapAfterCollection = (
  arm: string,
  size: number,
  step: string,
): number | undefined => {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect === undefined) return undefined;
  collect();
  const heap = Deno.memoryUsage().heapUsed;
  const directory = Deno.env.get("SCALE_HEAP_SNAPSHOTS");
  if (directory !== undefined && SNAPSHOT_STEPS.has(step)) {
    v8.writeHeapSnapshot(
      `${directory}/${arm}-${size}-${step.replace(" ", "-")}.heapsnapshot`,
    );
  }
  return heap;
};

/** The facts of a board's result, read as plain values. */
const factsOf = (result: Record<string, unknown>): Facts => {
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const crossrefs = list(result.crossrefs) as { mentionedBy?: unknown }[];
  return {
    topicCount: result.topicCount,
    names: Object.keys((result.names as object | undefined) ?? {}).length,
    index: list(result.index).length,
    firstTitles: list(result.index).slice(0, 3).map((row) =>
      (row as { title?: unknown } | undefined)?.title
    ),
    crossrefs: crossrefs.length,
    mentionedBy: crossrefs.reduce(
      (sum, row) => sum + list(row?.mentionedBy).length,
      0,
    ),
    mentionable: list(result.mentionable).length,
    namesTable: list(result.namesTable).length,
  };
};

//
// The executor
//

/** The board's artifact and that of a topic, emitted by the crate. */
const emitted = async (): Promise<{
  board: Artifact;
  artifacts: (id: string) => Artifact | undefined;
}> => {
  const { success, stdout, stderr } = await new Deno.Command(
    `${repository}base/pattern-compiler/target/release/pattern-compiler`,
    {
      args: ["emit", "--unchecked", ...TOPICS_FILES],
      cwd: `${repository}patterns`,
    },
  ).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
  const modules = JSON.parse(new TextDecoder().decode(stdout)) as {
    module: string;
    patterns: Artifact[];
  }[];
  const known = new Map<string, Artifact>();
  let board: Artifact | undefined;
  for (const { module, patterns } of modules) {
    for (const pattern of patterns) {
      const id = (pattern.plan as { patterns?: string[] }).patterns?.[0];
      if (id !== undefined) known.set(id, pattern);
      if (module.endsWith(BOARD)) board = pattern;
    }
  }
  if (board === undefined) throw new Error("the crate emitted no board");
  return { board, artifacts: (id) => known.get(id) };
};

const runExecutor = async (
  { topics, names }: Board,
): Promise<(Baseline | Step)[]> => {
  const size = topics.length;
  const { board, artifacts } = await emitted();
  const baseline: Baseline = {
    arm: "executor",
    size,
    step: "baseline",
    heap: heapAfterCollection("executor", size, "baseline"),
  };
  const link = (index: number) => ({
    $link: { doc: `topic-${index}`, path: [] },
  });
  const documents = topics.map(({ mentions, ...rest }, index) => ({
    id: `topic-${index}`,
    kind: "topic",
    value: { ...rest, mentions: mentions.map(link) },
  }));
  const argument = {
    topics: topics.map((_, index) => link(index)),
    names: Object.fromEntries(
      Object.entries(names).map(([name, index]) => [name, link(index)]),
    ),
  };
  const binding = board.plan.bindings.findIndex(({ name }) =>
    JSON.stringify(name).includes("addTopic")
  );
  if (binding < 0) throw new Error("the board has no binding `addTopic`");
  const steps: (Baseline | Step)[] = [];
  record(steps, baseline);
  let instance: Instance | undefined;
  const measure = (step: string, change: () => void) => {
    const before = instance === undefined
      ? { evaluations: 0, transactions: 0 }
      : {
        evaluations: instance.counts.evaluations,
        transactions: instance.transactions.length,
      };
    const began = performance.now();
    change();
    const settled = performance.now();
    // The result read under the board's result schema, as today's
    // runtime reads it: a reference at a position typed `unknown` is not
    // followed.
    const result = instance!.store.read(
      new Ref(instance!.id, []),
      undefined,
      false,
      instance!.schemaOf(board.plan.resultSchema),
    ) as Record<string, unknown>;
    const read = performance.now();
    const transactions = instance!.transactions.slice(before.transactions);
    record(steps, {
      arm: "executor",
      size,
      step,
      settle: round(settled - began),
      read: round(read - settled),
      work: instance!.counts.evaluations - before.evaluations,
      commits: transactions.length,
      documents: transactions.reduce(
        (sum, { written }) => sum + written.length,
        0,
      ),
      facts: factsOf(result),
      heap: heapAfterCollection("executor", size, step),
    });
  };
  measure("load", () => {
    instance = new Instance(board, argument, {
      documents,
      artifacts,
      now: 1_000_000,
      measure: "patches",
    });
  });
  for (const at of edited(size)) {
    measure(`edit topic ${at}`, () => {
      instance!.store.write(
        new Ref(`topic-${at}`, ["title"]),
        `Edited topic ${at}`,
      );
      instance!.settle();
    });
  }
  for (let turn = 0; turn < 3; turn++) {
    measure(`create ${turn}`, () => {
      const outcome = instance!.send(binding, CREATED(turn));
      if (!outcome.committed) {
        throw new Error(`addTopic was refused: ${JSON.stringify(outcome)}`);
      }
    });
  }
  return steps;
};

//
// The executor on the runtime's storage
//

/**
 * The identity whose space the runs with labels use: the clause of an
 * input names the audience of this space as an alternative
 * (`scenarioAudience`), which every store of the space admits.
 */
const labeledSigner = () => Identity.fromPassphrase("pattern-compiler-compare");

/** The schema a topic is written under: the clause of topic `index`. */
const topicSchemaOf = (index: number, audience: unknown): JSONSchema => ({
  // `SCALE_TOPIC_SCHEMA=mentions-as-cells` declares the mentions of a
  // topic as references. A schema that declares a label and no structure
  // has the memory server follow every link of a written topic when it
  // brings the queries that reach the topic up to date.
  ...(Deno.env.get("SCALE_TOPIC_SCHEMA") === "mentions-as-cells"
    ? {
      type: "object",
      properties: {
        mentions: { type: "array", items: { asCell: true } },
      },
    }
    : {}),
  ifc: {
    confidentiality: [
      inputClause(
        Deno.env.get("SCALE_TOPIC_LABELS") === "distinct"
          ? `topic-${index}`
          : "topics",
        audience,
      ),
    ],
  },
} as JSONSchema);

/** What the hooks of the storage cost one step, by hook, in milliseconds. */
type HookTimes = {
  begin: number;
  read: number;
  labelOf: number;
  change: number;
  unchanged: number;
  end: number;
};

/**
 * One measured step of the executor on the runtime's storage. `settle` is
 * from the start of the step, the write of the writer outside the board
 * included, to every commit settled.
 */
export type StorageStep = Step & {
  /** The write of the writer outside the board, in milliseconds. */
  outside: number;
  /** From the start of the executor's work to its last commit given. */
  local: number;
  /** The part of `local` spent in the hooks of the storage, by hook. */
  hooks: HookTimes;
  /** `local` less the hooks: the executor's own work. */
  executor: number;
  /** The preparations of Contextual Flow Control, and their time. */
  preparations: number;
  prepareMs: number;
  /** Positions read and writes staged through a transaction. */
  reads: number;
  writes: number;
  /** Write records the executor gave and the adapter recorded. */
  recordsGiven: number;
  recordsRecorded: number;
  /** The size of the recorded write records and input tables, as JSON. */
  recordBytes: number;
  unchangedRecords: number;
  labelEntriesChanged: number;
  /** Selections, picks and reads whose label was the bound. */
  planLabelBounds: number;
  /**
   * The documents the step's commits changed, the label entries they hold
   * after it, and the size of those entries as JSON with each label held
   * in place. With `SCALE_LABEL_PATHS` set, also how many entries there are
   * of each of the 16 most frequent forms of path.
   */
  labelEntries: {
    documents: number;
    entries: number;
    bytes: number;
    paths?: Record<string, number>;
  };
  /** The reason of each commit the storage refused. */
  refused: string[];
  /** The counters of the runtime's preparation that moved in the step. */
  cfc: Record<string, number>;
  /**
   * With `SCALE_CHECK` set, for an edit: the stored positions the step
   * changed outside the topic it wrote, and those among them whose stored
   * label lacks the clause of that topic.
   */
  checked?: {
    positions: number;
    unsound: string[];
    /**
     * The same check at the positions below those: each stored leaf that
     * changed, read alone and not with what is beside it, and how many of
     * them lack the clause, with the first eight.
     */
    leaves: { positions: number; lacking: number; first: string[] };
  };
};

/** The numeric members of `after` that differ from `before`, as the difference. */
const moved = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, number> => {
  const found: Record<string, number> = {};
  for (const [name, value] of Object.entries(after)) {
    const earlier = before[name];
    if (typeof value === "number" && typeof earlier === "number") {
      if (value !== earlier) found[name] = round(value - earlier);
    } else if (
      typeof value === "object" && value !== null &&
      typeof earlier === "object" && earlier !== null
    ) {
      for (
        const [inner, difference] of Object.entries(
          moved(
            earlier as Record<string, unknown>,
            value as Record<string, unknown>,
          ),
        )
      ) found[`${name}.${inner}`] = difference;
    }
  }
  return found;
};

/** A timing counter of the runtime: how often it ran and for how long. */
const timed = (key: string): { count: number; ms: number } => {
  const [logger, ...rest] = key.split("/");
  const stats = getTimingStatsBreakdown()[logger]?.[rest.join("/")];
  return { count: stats?.count ?? 0, ms: stats?.totalTime ?? 0 };
};

const runStorage = async (
  { topics, names }: Board,
): Promise<(Baseline | StorageStep)[]> => {
  const size = topics.length;
  const { board, artifacts } = await emitted();
  const identity = await labeledSigner();
  const space = identity.did() as MemorySpace;
  const { storageManager, close } = storageAs(identity);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcFlowLabels: "persist",
    experimental: { compiledPatterns: true },
    servingPosture: true,
  });
  const id = identifierOf({ topics: "scale", size });
  const storage = new RuntimeTransactions(runtime, space, {
    owner: id,
    artifact: board,
    countRecordBytes: true,
  });
  // The entities each commit changed since `changed` was cleared.
  const changed = new Set<string>();
  storageManager.subscribe({
    // deno-lint-ignore no-explicit-any
    next(notification: any) {
      if (notification.type !== "commit") return undefined;
      for (const { address } of notification.changes) changed.add(address.id);
      return undefined;
    },
  });
  // With `SCALE_RECORDS` set: the write records of each commit, each with
  // its size as JSON with its inputs held in place and the size of each of
  // its members, on the error stream.
  if (Deno.env.get("SCALE_RECORDS") !== undefined) {
    storage.onCommitted((writes) => {
      for (const write of writes) {
        const { target, record, ...rest } = write;
        console.error(JSON.stringify({
          record,
          at: `${storage.documentOf(target.id).slice(0, 12)}/${
            target.path.join("/")
          }`,
          bytes: JSON.stringify(write).length,
          ...(Deno.env.get("SCALE_RECORDS") === "full" ? { write } : {}),
          members: Object.fromEntries(
            Object.entries(rest).map(([name, value]) => [
              name,
              JSON.stringify(value)?.length ?? 0,
            ]),
          ),
        }));
      }
    });
  }
  // The hooks, with the time each takes added up.
  const spent: HookTimes = {
    begin: 0,
    read: 0,
    labelOf: 0,
    change: 0,
    unchanged: 0,
    end: 0,
  };
  const within = <A extends unknown[], R>(
    hook: keyof HookTimes,
    call: (...given: A) => R,
  ) =>
  (...given: A): R => {
    const began = performance.now();
    try {
      return call(...given);
    } finally {
      spent[hook] += performance.now() - began;
    }
  };
  const hooks: TransactionHooks = {
    begin: within("begin", (cause) => storage.begin(cause)),
    read: within("read", (doc, path) => storage.read(doc, path)),
    labelOf: within(
      "labelOf",
      (doc, path, observes) => storage.labelOf(doc, path, observes),
    ),
    instantiated: (instance, artifact) =>
      storage.instantiated(instance, artifact),
    watchLabels: (heard) => storage.watchLabels(heard),
    change: within(
      "change",
      (doc, path, store, schema, writes, splice, inputs) =>
        storage.change(doc, path, store, schema, writes, splice, inputs),
    ),
    unchanged: within(
      "unchanged",
      (doc, path, store, schema, writes, inputs) =>
        storage.unchanged(doc, path, store, schema, writes, inputs),
    ),
    end: within("end", (ended) => storage.end(ended)),
  };
  const steps: (Baseline | StorageStep)[] = [];
  record(steps, {
    arm: "storage",
    size,
    step: "baseline",
    heap: heapAfterCollection("storage", size, "baseline"),
  });
  try {
    const audience = await scenarioAudience();
    const address = (doc: string, path: string[] = []): NormalizedFullLink => ({
      space,
      id: storage.entityOf(doc),
      path,
      scope: "space",
    });
    // A value of the executor as the runtime stores it: each link as the
    // runtime's link to the entity of its document.
    const stored = (value: unknown): unknown => {
      if (isLink(value)) {
        const { doc, path } = value.$link;
        return createSigilLinkFromParsedLink({
          id: storage.entityOf(doc),
          space,
          path,
        });
      }
      if (Array.isArray(value)) return value.map(stored);
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
          Object.entries(value).map(([name, member]) => [name, stored(member)]),
        );
      }
      return value;
    };
    const link = (index: number) => ({
      $link: { doc: `topic-${index}`, path: [] },
    });
    const documents: { id: string; kind: string; value: unknown }[] = topics
      .map(({ mentions, ...rest }, index) => ({
        id: `topic-${index}`,
        kind: "topic",
        value: { ...rest, mentions: mentions.map(link) },
      }));
    const argument: Record<string, unknown> = {
      topics: topics.map((_, index) => link(index)),
      names: Object.fromEntries(
        Object.entries(names).map(([name, index]) => [name, link(index)]),
      ),
    };
    // Each topic is written under its clause, and each input of the board
    // as a cell of its own under the schema of the input with a clause, as
    // `labeledInputs` of `../integrated.ts` writes an input.
    const inputs = generateInputs(
      board.plan as Parameters<typeof generateInputs>[0],
      board.schemas as Parameters<typeof generateInputs>[1],
      audience,
    );
    const seed = runtime.edit();
    documents.forEach(({ id: doc, value }, index) => {
      const schema = topicSchemaOf(index, audience);
      recordRelevantSchemaWritePolicyInput(seed, address(doc), schema);
      diffAndUpdate(runtime, seed, address(doc), stored(value));
      storage.external(doc);
    });
    const given: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(argument)) {
      const schema = (inputs[name]?.schema ?? {
        ifc: { confidentiality: [inputClause(name, audience)] },
      }) as JSONSchema;
      const cell = runtime.getCell(space, { scaleInput: name }, schema, seed)
        .getAsNormalizedFullLink();
      recordRelevantSchemaWritePolicyInput(seed, cell, schema);
      diffAndUpdate(runtime, seed, cell, stored(value));
      storage.external(cell.id);
      documents.push({ id: cell.id, kind: "input", value });
      given[name] = { $link: { doc: cell.id, path: [] } };
    }
    const { error: seeded } = await seed.commit().settled;
    if (seeded !== undefined) throw seeded;
    const binding = board.plan.bindings.findIndex(({ name }) =>
      JSON.stringify(name).includes("addTopic")
    );
    if (binding < 0) throw new Error("the board has no binding `addTopic`");
    // The label entries the documents of `entities` hold.
    const entriesOf = (step: string, entities: Iterable<string>) => {
      const dump = Deno.env.get("SCALE_LABEL_DUMP");
      const tx = runtime.edit();
      try {
        let found = 0;
        let bytes = 0;
        let held = 0;
        // The entries by the kind of their document, the first segments
        // of their path with each index as `#`, and their class.
        const shapes = new Map<string, number>();
        for (const entity of entities) {
          const metadata = readStoredCfcMetadata(tx, {
            space,
            id: entity,
            path: [],
            scope: "space",
          } as NormalizedFullLink);
          held += 1;
          if (metadata === undefined) continue;
          found += metadata.labelMap.entries.length;
          if (dump !== undefined) {
            Deno.writeTextFileSync(
              dump,
              JSON.stringify({
                step,
                kind:
                  instance?.store.docs.get(storage.documentOf(entity))?.kind ??
                    "input",
                entity,
                entries: metadata.labelMap.entries,
              }) + "\n",
              { append: true },
            );
          }
          bytes += JSON.stringify(metadata.labelMap.entries).length;
          for (const { path, observes } of metadata.labelMap.entries) {
            const kind =
              instance?.store.docs.get(storage.documentOf(entity))?.kind ??
                "input";
            const shape = `${kind} /${
              path.map((segment) => /^\d+$/.test(segment) ? "#" : segment)
                .slice(0, 4).join("/")
            } ${observes ?? "value"}`;
            shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
          }
        }
        return {
          documents: held,
          entries: found,
          bytes,
          ...(Deno.env.get("SCALE_LABEL_PATHS") === undefined ? {} : {
            paths: Object.fromEntries(
              [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 16),
            ),
          }),
        };
      } finally {
        tx.abort();
      }
    };
    // The stored positions that differ between two readings of the
    // storage, outside `except`, each with whether its stored label holds
    // `clause`: a value that changed with the topic depends on it.
    const check = (
      before: Map<string, string>,
      except: string,
      clause: unknown,
    ): NonNullable<StorageStep["checked"]> => {
      // A clause as text, with its alternatives in one order.
      const text = (held: unknown): string => {
        const alternatives = (held as { anyOf?: unknown[] } | null)?.anyOf;
        return Array.isArray(alternatives)
          ? JSON.stringify(
            alternatives.map((one) => JSON.stringify(one)).sort(),
          )
          : JSON.stringify(held);
      };
      const wanted = text(clause);
      const unsound: string[] = [];
      let positions = 0;
      const leaves = { positions: 0, lacking: 0, first: [] as string[] };
      // The paths of the leaves at which two stored values differ: a
      // position that holds no container on either side.
      const differing = (
        was: unknown,
        now: unknown,
        at: string[],
        found: string[][],
      ): string[][] => {
        const container = (held: unknown): held is Record<string, unknown> =>
          typeof held === "object" && held !== null && !isLink(held);
        if (container(was) && container(now)) {
          for (
            const name of new Set([...Object.keys(was), ...Object.keys(now)])
          ) {
            differing(was[name], now[name], [...at, name], found);
          }
        } else if (JSON.stringify(was) !== JSON.stringify(now)) found.push(at);
        return found;
      };
      const tx = runtime.edit();
      try {
        for (const [doc, value] of storage.stored()) {
          if (doc === except) continue;
          const earlier = before.get(doc);
          const now = JSON.stringify(value);
          if (earlier === now) continue;
          const was = earlier === undefined ? undefined : JSON.parse(earlier);
          const record = (held: unknown) =>
            typeof held === "object" && held !== null && !Array.isArray(held);
          const paths: string[][] = record(value) && record(was)
            ? Object.keys(value as object).filter((name) =>
              JSON.stringify((value as Record<string, unknown>)[name]) !==
                JSON.stringify((was as Record<string, unknown>)[name])
            ).map((name) => [name])
            : [[]];
          const metadata = readStoredCfcMetadata(tx, address(doc));
          const holdsAt = (path: string[]) => {
            const label = metadata === undefined
              ? undefined
              : labelForConsumedEntries(
                consumedEntriesForRead(metadata, path, {
                  nonRecursive: false,
                  consumes: "value",
                }),
                path,
                false,
              );
            return {
              label,
              holds: (label?.confidentiality ?? []).some((held) =>
                text(held) === wanted
              ),
            };
          };
          for (const leaf of differing(was, value, [], [])) {
            leaves.positions += 1;
            if (holdsAt(leaf).holds) continue;
            leaves.lacking += 1;
            if (leaves.first.length < 8) {
              leaves.first.push(
                `${instance?.store.docs.get(doc)?.kind ?? "?"} /${
                  leaf.join("/")
                }`,
              );
            }
          }
          for (const path of paths) {
            positions += 1;
            const { label, holds } = holdsAt(path);
            if (!holds) {
              const kind = instance?.store.docs.get(doc)?.kind ?? "?";
              unsound.push(
                `${kind} ${doc.slice(0, 16)} /${path.join("/")} ${
                  JSON.stringify(label?.confidentiality ?? null)
                }`,
              );
            }
          }
        }
      } finally {
        tx.abort();
      }
      return { positions, unsound, leaves };
    };
    let instance: Instance | undefined;
    const measure = async (
      step: string,
      work: () => void,
      outside?: { write: () => Promise<void>; doc: string; clause: unknown },
    ) => {
      const checking = outside !== undefined &&
        Deno.env.get("SCALE_CHECK") !== undefined;
      const snapshot = checking
        ? new Map(
          [...storage.stored()].map((
            [doc, value],
          ) => [doc, JSON.stringify(value)]),
        )
        : undefined;
      const before = {
        counts: storage.counts,
        cfc: runtime.getCfcStats() as unknown as Record<string, unknown>,
        evaluations: instance?.counts.evaluations ?? 0,
        transactions: instance?.transactions.length ?? 0,
        spent: { ...spent },
      };
      resetAllTimingStats();
      changed.clear();
      const began = performance.now();
      await outside?.write();
      const started = performance.now();
      work();
      const local = performance.now();
      const refused = await storage.settled();
      const settled = performance.now();
      // The result as the arm in memory reads it: the reader's cost.
      const result = instance!.store.read(
        new Ref(instance!.id, []),
        undefined,
        false,
        instance!.schemaOf(board.plan.resultSchema),
      ) as Record<string, unknown>;
      const read = performance.now();
      const after = storage.counts;
      const transactions = instance!.transactions.slice(before.transactions);
      const hookTimes = Object.fromEntries(
        Object.entries(spent).map(([hook, total]) => [
          hook,
          round(total - before.spent[hook as keyof HookTimes]),
        ]),
      ) as HookTimes;
      const inHooks = Object.values(hookTimes).reduce(
        (sum, part) => sum + part,
        0,
      );
      const preparations = timed("extended-storage-transaction/prepareCfc");
      record(steps, {
        arm: "storage",
        size,
        step,
        settle: round(settled - began),
        read: round(read - settled),
        work: instance!.counts.evaluations - before.evaluations,
        commits: timed("storage.v2.transaction/commit/commitNative").count,
        documents: transactions.reduce(
          (sum, { written }) => sum + written.length,
          0,
        ),
        facts: factsOf(result),
        heap: heapAfterCollection("storage", size, step),
        outside: round(started - began),
        local: round(local - started),
        hooks: hookTimes,
        executor: round(local - started - inHooks),
        preparations: preparations.count,
        prepareMs: round(preparations.ms),
        reads: after.reads - before.counts.reads,
        writes: after.writes - before.counts.writes,
        recordsGiven: after.recordsGiven - before.counts.recordsGiven,
        recordsRecorded: after.recordsRecorded - before.counts.recordsRecorded,
        recordBytes: after.recordBytes - before.counts.recordBytes,
        unchangedRecords: after.unchangedRecords -
          before.counts.unchangedRecords,
        labelEntriesChanged: after.labelEntriesChanged -
          before.counts.labelEntriesChanged,
        planLabelBounds: (runtime.getCfcStats().planLabelBounds ?? 0) -
          ((before.cfc.planLabelBounds as number | undefined) ?? 0),
        labelEntries: entriesOf(step, changed),
        refused,
        cfc: moved(
          before.cfc,
          runtime.getCfcStats() as unknown as Record<string, unknown>,
        ),
        ...(snapshot === undefined
          ? {}
          : { checked: check(snapshot, outside!.doc, outside!.clause) }),
      });
      // Every later step would run on documents the storage does not hold.
      if (refused.length > 0) {
        throw new Error(
          `The storage refused a commit of the step \`${step}\`.`,
        );
      }
    };
    await measure("load", () => {
      instance = new Instance(board, given, {
        space,
        id,
        secret: "the secret of the comparison",
        documents,
        artifacts,
        now: 1_000_000,
        measure: "patches",
        transactions: hooks,
      });
    });
    for (const at of edited(size)) {
      const doc = `topic-${at}`;
      const title = `Edited topic ${at}`;
      const schema = topicSchemaOf(at, audience);
      await measure(`edit topic ${at}`, () => {
        // The executor hears of the write as a change of a document it
        // was handed, and brings the board up to date.
        instance!.store.write(new Ref(doc, ["title"]), title);
        instance!.settle();
      }, {
        doc,
        clause: (schema as { ifc: { confidentiality: unknown[] } }).ifc
          .confidentiality[0],
        // The writer outside the board: a transaction of the runtime that
        // writes the title of the topic under the topic's schema.
        write: async () => {
          const tx = runtime.edit();
          recordRelevantSchemaWritePolicyInput(tx, address(doc), schema);
          diffAndUpdate(runtime, tx, address(doc, ["title"]), title);
          runtime.prepareTxForCommit(tx);
          const { error } = await tx.commit().settled;
          if (error !== undefined) throw error;
        },
      });
    }
    if (Deno.env.get("SCALE_REORDER") !== undefined) {
      // The topic filed first becomes the one last active: a writer
      // outside the board writes its `lastActivityAt`, which moves its card
      // to the first place on a board that orders its cards by activity,
      // and every card before it one place down.
      const doc = "topic-0";
      const at = 2_000_000;
      const schema = topicSchemaOf(0, audience);
      await measure("reorder topic 0", () => {
        instance!.store.write(new Ref(doc, ["lastActivityAt"]), at);
        instance!.settle();
      }, {
        doc,
        clause: (schema as { ifc: { confidentiality: unknown[] } }).ifc
          .confidentiality[0],
        write: async () => {
          const tx = runtime.edit();
          recordRelevantSchemaWritePolicyInput(tx, address(doc), schema);
          diffAndUpdate(runtime, tx, address(doc, ["lastActivityAt"]), at);
          runtime.prepareTxForCommit(tx);
          const { error } = await tx.commit().settled;
          if (error !== undefined) throw error;
        },
      });
    }
    for (let turn = 0; turn < 3; turn++) {
      await measure(`create ${turn}`, () => {
        const outcome = instance!.send(binding, CREATED(turn));
        if (!outcome.committed) {
          throw new Error(`addTopic was refused: ${JSON.stringify(outcome)}`);
        }
      });
    }
  } finally {
    storage.close();
    await runtime.dispose();
    await close();
  }
  return steps;
};

//
// Today's runtime
//

const count = (name: string): number => {
  let found = 0;
  for (const [logger, keys] of Object.entries(getTimingStatsBreakdown())) {
    for (const [key, stats] of Object.entries(keys)) {
      if (`${logger}/${key}`.startsWith(name)) found += stats.count;
    }
  }
  return found;
};

/** A step of today's runtime, with its preparations where it stores labels. */
export type TodayStep = Step & {
  /**
   * On the arm `runner`: the time of a pull of the result behind the step,
   * until the runtime is settled again, in milliseconds. It is no part of
   * `settle`.
   */
  pull?: number;
  /** On the arm `runner`: what the compiled piece did in the step. */
  compiled?: Record<string, number>;
  /** On the arm `runner`: the cones the step evaluated, where asked for. */
  evaluated?: Record<string, number>;
  /** The preparations of Contextual Flow Control, and their time. */
  preparations: number;
  prepareMs: number;
  /**
   * The documents the step's commits changed, the label entries they hold
   * after it, and the size of those entries as JSON.
   */
  labelEntries?: { documents: number; entries: number; bytes: number };
  /** With `SCALE_COMMITS` set: the commits of the step. */
  commitLog?: CommitOfStep[];
};

/** A document one commit changed, as `SCALE_COMMITS` reports it. */
type DocumentOfCommit = {
  id: string;
  paths: number;
  bytes: number;
  /** The first three paths that changed. */
  at?: string[];
};

/** One commit of a step, as `SCALE_COMMITS` reports it. */
type CommitOfStep = {
  documents: number;
  /** The size as JSON, after the commit, of the documents it changed. */
  bytes: number;
  largest: DocumentOfCommit[];
};

const runToday = async (
  { topics, names }: Board,
  labeled: boolean,
  /**
   * Whether the board runs as a compiled piece (`startCompiledPiece`), in
   * place of today's piece (`Runtime.run`): the arm `runner`. Every other
   * call of the runtime is the same.
   */
  asCompiledPiece = false,
): Promise<(Baseline | TodayStep)[]> => {
  const size = topics.length;
  const arm = asCompiledPiece ? "runner" : labeled ? "today-labeled" : "today";
  const signer = labeled
    ? await labeledSigner()
    : await Identity.fromPassphrase(`topics-scale ${size}`);
  const space = signer.did();
  const audience = labeled ? await scenarioAudience() : undefined;
  const { storageManager, close } = storageAs(signer);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    ...(labeled ? { cfcFlowLabels: "persist" as const } : {}),
    ...(asCompiledPiece
      ? { experimental: { compiledPatterns: true }, servingPosture: true }
      : {}),
  });
  let piece: CompiledPiece | undefined;
  const changed = new Set<string>();
  // With `SCALE_COMMITS` set: for each commit since `commitLog` was
  // cleared, each document it changed, with the paths that changed and
  // the size of the document as JSON after the commit.
  const logCommits = Deno.env.get("SCALE_COMMITS") !== undefined;
  const commitLog: CommitOfStep[] = [];
  storageManager.subscribe({
    // deno-lint-ignore no-explicit-any
    next(notification: any) {
      if (notification.type !== "commit") return undefined;
      const documents = new Map<string, DocumentOfCommit>();
      for (const { address, after } of notification.changes) {
        changed.add(JSON.stringify([address.id, address.scope]));
        if (!logCommits) continue;
        const document = documents.get(address.id) ?? {
          id: address.id,
          paths: 0,
          bytes: after === undefined ? 0 : JSON.stringify(after).length,
        };
        document.paths++;
        if (document.paths <= 3) {
          (document.at ??= []).push((address.path ?? []).join("/"));
        }
        documents.set(address.id, document);
      }
      if (logCommits) {
        commitLog.push({
          documents: documents.size,
          bytes: [...documents.values()].reduce(
            (sum, { bytes }) => sum + bytes,
            0,
          ),
          largest: [...documents.values()].sort((a, b) => b.bytes - a.bytes)
            .slice(0, 4),
        });
      }
      return undefined;
    },
  });
  const steps: (Baseline | TodayStep)[] = [];
  try {
    const emittedBoard = asCompiledPiece ? await emitted() : undefined;
    const compiled = asCompiledPiece
      ? undefined
      : await runtime.patternManager.compilePattern(
        await resolveLocalProgram(
          (resolver) => runtime.harness.resolve(resolver),
          {
            main: `${repository}patterns/${BOARD}`,
            root: repository,
          },
        ),
        { space },
      );
    record(steps, {
      arm,
      size,
      step: "baseline",
      heap: heapAfterCollection(arm, size, "baseline"),
    });
    const seed = runtime.edit();
    // Every cell exists before any is set, since a topic may mention one
    // after it.
    // deno-lint-ignore no-explicit-any
    const cells: any[] = topics.map((_, index) =>
      runtime.getCell(
        space,
        `topic ${index}`,
        labeled ? topicSchemaOf(index, audience) : undefined,
        seed,
      )
    );
    topics.forEach(({ mentions, ...rest }, index) => {
      cells[index].set({
        ...rest,
        mentions: mentions.map((target) => cells[target]),
      });
    });
    // The argument: the topics and the names, and with labels each as a
    // cell of its own under a schema with the clause of the input.
    const held: Record<string, unknown> = {
      topics: cells,
      names: Object.fromEntries(
        Object.entries(names).map(([name, index]) => [name, cells[index]]),
      ),
    };
    const argument = !labeled ? held : Object.fromEntries(
      Object.entries(held).map(([name, value]) => {
        const input = runtime.getCell(
          space,
          { scaleInput: name },
          {
            ifc: { confidentiality: [inputClause(name, audience)] },
          } as JSONSchema,
          seed,
        );
        input.set(value);
        return [name, input];
      }),
    );
    const { error: seeded } = await seed.commit().settled;
    if (seeded !== undefined) throw seeded;
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "topics scale",
      compiled?.resultSchema,
    );
    // Today's piece computes what a reader demands, so the step pulls the
    // result, which reads all of it. The compiled piece derives without a
    // reader, and the pull of its result is timed apart (`TodayStep.pull`).
    const settle = async (pull = piece === undefined) => {
      if (pull) await result.pull();
      await runtime.settled();
      // The commits the scheduler made are counted to the step that
      // caused them, on every arm of this function.
      await runtime.scheduler.idleWithPendingCommits();
      if (piece !== undefined && piece.refusals.length > 0) {
        throw new Error(
          `The storage refused a commit of the piece: ${piece.refusals[0]}`,
        );
      }
    };
    // The result of the compiled piece as the executor holds it, under the
    // schema of the result: the runtime's own read does not follow a link
    // whose path crosses an array by key.
    const heldByExecutor = () =>
      piece!.instance.store.read(
        new Ref(piece!.instance.id, []),
        undefined,
        false,
        piece!.instance.schemaOf(emittedBoard!.board.plan.resultSchema),
      ) as Record<string, unknown>;
    const read = () => {
      if (piece !== undefined) {
        const value = heldByExecutor();
        JSON.stringify(value);
        return value;
      }
      const tx = runtime.edit();
      try {
        const value = result.withTx(tx).get();
        JSON.stringify(value);
        return value;
      } finally {
        tx.abort();
      }
    };
    const facts = (): Facts => {
      if (piece !== undefined) return factsOf(heldByExecutor());
      const tx = runtime.edit();
      try {
        const plain = (path: string) => result.withTx(tx).key(path).get();
        return factsOf({
          topicCount: plain("topicCount"),
          names: plain("names"),
          index: plain("index"),
          crossrefs: plain("crossrefs"),
          mentionable: plain("mentionable"),
          namesTable: plain("namesTable"),
        });
      } finally {
        tx.abort();
      }
    };
    // The label entries the documents the step's commits changed hold.
    const labelEntries = () => {
      const tx = runtime.edit();
      try {
        let entries = 0;
        let bytes = 0;
        for (const key of changed) {
          const [id, scope] = JSON.parse(key) as [string, string];
          const metadata = readStoredCfcMetadata(
            tx,
            { space, id, path: [], scope } as NormalizedFullLink,
          );
          if (metadata === undefined) continue;
          entries += metadata.labelMap.entries.length;
          bytes += JSON.stringify(metadata.labelMap.entries).length;
        }
        return { documents: changed.size, entries, bytes };
      } finally {
        tx.abort();
      }
    };
    const measure = async (step: string, change: () => Promise<void>) => {
      resetAllTimingStats();
      changed.clear();
      commitLog.length = 0;
      const before = piece === undefined ? undefined : {
        transactions: piece.instance.transactions.length,
        records: piece.transactions.counts,
        piece: piece.counts,
        evaluations: piece.instance.counts.evaluations,
      };
      // `SCALE_PROFILE_STEP` names the one step that `SCALE_CPU_PROFILE` is
      // a profile of, in place of the whole run.
      const profiledSteps = Deno.env.get("SCALE_PROFILE_STEP")?.split(",") ??
        [];
      const stopStepProfile = profiledSteps.includes(step)
        ? await startProfile(
          profiledSteps.length === 1
            ? Deno.env.get("SCALE_CPU_PROFILE") ?? ""
            : `${Deno.env.get("SCALE_CPU_PROFILE")}.${
              step.replaceAll(" ", "-")
            }.cpuprofile`,
        )
        : undefined;
      const began = performance.now();
      await change();
      await settle();
      const settled = performance.now();
      await stopStepProfile?.();
      read();
      const done = performance.now();
      const preparations = timed("extended-storage-transaction/prepareCfc");
      const after = piece?.transactions.counts;
      const commitsOfStep = count("storage.v2.transaction/commit/commitNative");
      const documentsOfStep = changed.size;
      const workOfStep = count("scheduler/scheduler/run/action");
      // A reader of the whole result of the compiled piece, as the pull of
      // today's piece is one: its time, apart from the step's.
      let pull: number | undefined;
      if (piece !== undefined && Deno.env.get("SCALE_NO_PULL") === undefined) {
        const began = performance.now();
        await settle(true);
        pull = round(performance.now() - began);
      }
      record(steps, {
        arm,
        size,
        step,
        settle: round(settled - began),
        read: round(done - settled),
        ...(piece === undefined || after === undefined ? {} : {
          compiled: {
            evaluations: piece.instance.counts.evaluations -
              (before?.evaluations ?? 0),
            events: piece.counts.events - (before?.piece.events ?? 0),
            derivations: piece.counts.derivations -
              (before?.piece.derivations ?? 0),
            changesByOthers: piece.counts.changesByOthers -
              (before?.piece.changesByOthers ?? 0),
            ownMs: round(piece.counts.ownMs - (before?.piece.ownMs ?? 0)),
            reads: after.reads - (before?.records.reads ?? 0),
            writes: after.writes - (before?.records.writes ?? 0),
            recordsGiven: after.recordsGiven -
              (before?.records.recordsGiven ?? 0),
            recordsRecorded: after.recordsRecorded -
              (before?.records.recordsRecorded ?? 0),
            recordBytes: after.recordBytes -
              (before?.records.recordBytes ?? 0),
          },
          // With `SCALE_EVALUATED` set: the cones the step evaluated, each
          // with how many times.
          ...(Deno.env.get("SCALE_EVALUATED") === undefined ? {} : {
            evaluated: piece.instance.transactions.slice(
              before?.transactions ?? 0,
            ).flatMap(({ evaluated }) => evaluated).reduce(
              (counts, cone) => ({
                ...counts,
                [cone]: (counts[cone] ?? 0) + 1,
              }),
              {} as Record<string, number>,
            ),
          }),
        }),
        ...(pull === undefined ? {} : { pull }),
        ...(logCommits ? { commitLog: commitLog.slice() } : {}),
        work: workOfStep,
        commits: commitsOfStep,
        documents: documentsOfStep,
        facts: facts(),
        heap: heapAfterCollection(arm, size, step),
        preparations: preparations.count,
        prepareMs: round(preparations.ms),
        ...(labeled ? { labelEntries: labelEntries() } : {}),
      });
      consumedAfter(step);
      if (Deno.env.get("SCALE_RESULT_SHAPE") === "entries") {
        const tx = runtime.edit();
        try {
          const { space, id, scope } = result.getAsNormalizedFullLink();
          const metadata = readStoredCfcMetadata(
            tx,
            { space, id, path: [], scope } as NormalizedFullLink,
          );
          for (const entry of metadata?.labelMap.entries ?? []) {
            console.error(
              JSON.stringify({ entryAfter: step, entry }),
            );
          }
        } finally {
          tx.abort();
        }
      }
    };
    // With `SCALE_CONSUMED` naming a file, on the arm `runner`: after each
    // step, one line of JSON for each path of the result document, down to
    // each leaf and each link, with the clauses of the inputs that a read
    // of the value at that path consumes. The read is made through a cell
    // in a transaction of its own, every link followed, and the clauses are
    // those of the join the runtime derives from what the transaction read.
    const consumedAfter = (step: string) => {
      const file = Deno.env.get("SCALE_CONSUMED");
      if (piece === undefined || file === undefined) return;
      const paths: string[][] = [];
      const walk = (value: unknown, path: string[]) => {
        paths.push(path);
        if (isLink(value) || typeof value !== "object" || value === null) {
          return;
        }
        for (const [name, member] of Object.entries(value)) {
          walk(member, [...path, name]);
        }
      };
      walk(piece.instance.store.docs.get(piece.instance.id)?.value, []);
      const lines = paths.map((path) => {
        const tx = runtime.edit();
        try {
          // deno-lint-ignore no-explicit-any
          let cell: any = result.withTx(tx);
          for (const segment of path) cell = cell.key(segment);
          JSON.stringify(cell.get());
          const text = JSON.stringify(deriveFlowJoin(tx).confidentiality);
          return JSON.stringify({
            step,
            path: path.join("/"),
            clauses: [...new Set(text.match(/input:[A-Za-z0-9-]+/g) ?? [])]
              .sort(),
          });
        } finally {
          tx.abort();
        }
      });
      // The label entries the result document stores at its root and one
      // or two segments below it, which a read of any path below consumes
      // where no entry nearer to the path replaces them.
      const reader = runtime.edit();
      try {
        const { space, id, scope } = result.getAsNormalizedFullLink();
        const metadata = readStoredCfcMetadata(
          reader,
          { space, id, scope },
        );
        for (const entry of metadata?.labelMap.entries ?? []) {
          if (entry.path.length > 2) continue;
          lines.push(JSON.stringify({
            step,
            entry: entry.path.join("/"),
            origin: entry.origin,
            observes: entry.observes,
            clauses: [
              ...new Set(
                JSON.stringify(entry.label).match(/input:[A-Za-z0-9-]+/g) ??
                  [],
              ),
            ].sort(),
          }));
        }
      } finally {
        reader.abort();
      }
      Deno.writeTextFileSync(file, `${lines.join("\n")}\n`, { append: true });
    };
    const commit = async (write: (tx: ReturnType<Runtime["edit"]>) => void) => {
      const tx = runtime.edit();
      write(tx);
      runtime.prepareTxForCommit(tx);
      const { error } = await tx.commit().settled;
      if (error !== undefined) throw error;
    };
    await measure("load", () =>
      commit((tx) => {
        if (emittedBoard === undefined) {
          runtime.run(tx, compiled, argument, result.withTx(tx));
          return;
        }
        piece = startCompiledPiece(
          runtime,
          tx,
          emittedBoard.board,
          argument,
          result.withTx(tx),
          {
            artifacts: emittedBoard.artifacts,
            now: 1_000_000,
            secret: "the secret of the comparison",
            countRecordBytes: true,
            // `SCALE_ROWS=in-place` keeps the rows of every collection in
            // the result; otherwise the rows of a `map` over references
            // are documents of their own.
            ...(Deno.env.get("SCALE_ROWS") === "in-place"
              ? { rows: "in-place" as const }
              : {}),
            // `SCALE_LISTS=in-place` stores the links to the rows and to
            // the buckets in the result document, and `SCALE_LIST_WHOLE`
            // is the most rows whose links one list document holds.
            ...(Deno.env.get("SCALE_LISTS") === "in-place"
              ? { lists: "in-place" as const }
              : {}),
            ...(Deno.env.get("SCALE_LIST_WHOLE") === undefined
              ? {}
              : { listWhole: Number(Deno.env.get("SCALE_LIST_WHOLE")) }),
            // `SCALE_LOAD_ROWS` is the most row documents one transaction
            // of the load holds; `Infinity` loads in one transaction.
            ...(Deno.env.get("SCALE_LOAD_ROWS") === undefined
              ? {}
              : { loadRows: Number(Deno.env.get("SCALE_LOAD_ROWS")) }),
          },
        );
      }));
    // With `SCALE_RECORDS` set: the write records of each commit of the
    // piece after the load, each with the document and path it names and
    // its size as JSON, on the error stream.
    if (Deno.env.get("SCALE_RECORDS") !== undefined && piece !== undefined) {
      const { transactions } = piece as CompiledPiece;
      transactions.onRecorded((writes) => {
        for (const write of writes) {
          console.error(JSON.stringify({
            step: steps.length,
            record: write.record,
            ...(write.unchanged ? { unchanged: true } : {}),
            ...(write.relabel ? { relabel: true } : {}),
            at: `${transactions.documentOf(write.target.id).slice(0, 12)}/${
              write.target.path.join("/")
            }`,
            bytes: JSON.stringify(write).length,
            ...(Deno.env.get("SCALE_RECORDS") === "full" ? { write } : {}),
          }));
        }
      });
    }
    // With `SCALE_RESULT_SHAPE` set: the size as JSON of each member of the
    // result document, and how many label entries it stores below each, on
    // the error stream.
    if (Deno.env.get("SCALE_RESULT_SHAPE") !== undefined) {
      const tx = runtime.edit();
      try {
        const { space, id, scope } = result.getAsNormalizedFullLink();
        const metadata = readStoredCfcMetadata(
          tx,
          { space, id, path: [], scope } as NormalizedFullLink,
        );
        const entries: Record<string, { entries: number; bytes: number }> = {};
        for (const entry of metadata?.labelMap.entries ?? []) {
          const member = String(entry.path[0] ?? "(root)");
          entries[member] ??= { entries: 0, bytes: 0 };
          entries[member].entries++;
          entries[member].bytes += JSON.stringify(entry).length;
        }
        const value = tx.readValueOrThrow(
          { space, id, path: [], scope } as NormalizedFullLink,
        ) as Record<string, unknown>;
        console.error(JSON.stringify({
          resultShape: Object.fromEntries(
            Object.entries(value ?? {}).map(([name, member]) => [
              name,
              JSON.stringify(member)?.length ?? 0,
            ]),
          ),
          labelEntries: entries,
        }));
      } finally {
        tx.abort();
      }
    }
    // With `SCALE_WRITE_ALONE` set, a step `write alone` precedes each
    // edit: the same writer writes a field of the same topic that the
    // board does not read, so the step is what the write itself costs on
    // this arm, with no derivation behind it.
    const writeAlone = Deno.env.get("SCALE_WRITE_ALONE") !== undefined;
    for (const at of edited(size)) {
      if (writeAlone) {
        await measure(`write alone ${at}`, () =>
          commit((tx) => {
            cells[at].withTx(tx).key("unreadByTheBoard").set(`Written ${at}`);
          }));
      }
      await measure(`edit topic ${at}`, () =>
        commit((tx) => {
          cells[at].withTx(tx).key("title").set(`Edited topic ${at}`);
        }));
    }
    // With `SCALE_FIELD_EDITS` set, a writer outside the board then writes,
    // on the middle topic, each field that a whole-list `lift` of the board
    // reads: its mentions (to the first topic alone), its `shortName` and
    // its `lastActivityAt`.
    if (Deno.env.get("SCALE_FIELD_EDITS") !== undefined) {
      const at = Math.floor(size / 2);
      await measure(`edit mentions ${at}`, () =>
        commit((tx) => {
          cells[at].withTx(tx).key("mentions").set([cells[0]]);
        }));
      await measure(`edit shortName ${at}`, () =>
        commit((tx) => {
          cells[at].withTx(tx).key("shortName").set(`renamed-${at}`);
        }));
      await measure(`edit lastActivityAt ${at}`, () =>
        commit((tx) => {
          cells[at].withTx(tx).key("lastActivityAt").set(4_000_000_000_000);
        }));
    }
    for (let turn = 0; turn < 3; turn++) {
      await measure(`create ${turn}`, () =>
        commit((tx) => {
          // deno-lint-ignore no-explicit-any
          (result.withTx(tx).key("addTopic") as any).send(CREATED(turn));
        }));
    }
  } finally {
    piece?.stop();
    await runtime.dispose();
    await close();
  }
  return steps;
};

/**
 * Starts the sampling profiler of the process where `SCALE_CPU_PROFILE`
 * names a file, and returns what stops it and writes the profile there.
 */
const profiled = (): Promise<() => Promise<void>> => {
  const file = Deno.env.get("SCALE_CPU_PROFILE");
  if (file === undefined || Deno.env.get("SCALE_PROFILE_STEP") !== undefined) {
    return Promise.resolve(() => Promise.resolve());
  }
  return startProfile(file);
};

/** Starts the sampling profiler and returns what writes its profile. */
const startProfile = async (file: string): Promise<() => Promise<void>> => {
  const session = new inspector.Session();
  session.connect();
  const post = (method: string, params?: object) =>
    new Promise<unknown>((resolve, reject) =>
      session.post(
        method,
        params,
        (error: Error | null, result?: unknown) =>
          error === null ? resolve(result) : reject(error),
      )
    );
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 500 });
  await post("Profiler.start");
  return async () => {
    const { profile } = await post("Profiler.stop") as { profile: unknown };
    await Deno.writeTextFile(file, JSON.stringify(profile));
  };
};

if (import.meta.main) {
  const [arm, ...given] = Deno.args;
  const stopProfile = await profiled();
  // With `SCALE_SERVING_LABELS` set, the serving arms write the topics and
  // the inputs under the labels the arm `runner` writes them under.
  const servingAudience = Deno.env.get("SCALE_SERVING_LABELS") === undefined
    ? undefined
    : await scenarioAudience();
  const servingLabels = servingAudience === undefined ? undefined : {
    signer: await labeledSigner(),
    topic: (index: number) => topicSchemaOf(index, servingAudience),
    input: (name: string) =>
      ({
        ifc: { confidentiality: [inputClause(name, servingAudience)] },
      }) as JSONSchema,
  };
  const boards = given[0] === "--seed" && given[1] !== undefined
    ? [await seeded(given[1])]
    : (given.length > 0 ? given.map(Number) : [100, 1_000, 2_000]).map(
      generated,
    );
  for (const board of boards) {
    const steps = arm === "executor"
      ? await runExecutor(board)
      : arm === "storage"
      ? await runStorage(board)
      : arm === "today" || arm === "today-labeled"
      ? await runToday(board, arm === "today-labeled")
      : arm === "runner"
      ? await runToday(board, true, true)
      : arm === "serving" || arm === "serving-today"
      ? await runServing(
        {
          module: BOARD,
          files: TOPICS_FILES,
          topics: board.topics,
          names: board.names,
          created: CREATED,
          edited: edited(board.topics.length),
          ...(servingLabels === undefined ? {} : { labels: servingLabels }),
        },
        arm,
        (step) => console.log(JSON.stringify(step)),
      ).then(() => [])
      : undefined;
    if (steps === undefined) {
      console.error(
        "usage: scale.ts executor|storage|runner|serving|serving-today|today|today-labeled [sizes | --seed <seed>]",
      );
      Deno.exit(2);
    }
  }
  await stopProfile();
}
