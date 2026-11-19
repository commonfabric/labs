/**
 * Runs Topics (`patterns/apps/topics/`) at several sizes of the board on
 * the executor of `../../exec/` and on today's runtime, and measures the
 * board's load, the creation of one topic, and an edit of one topic.
 *
 * `deno run -A --no-check base/pattern-compiler/compare/topics/scale.ts <arm> [sizes | --seed <seed>]`
 *
 * `<arm>` is `executor` or `today`, and each run prints one line of JSON
 * per measured step. The two arms run in processes of their own, one after
 * the other, so that no two timed runs share a machine at once.
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
 * Both arms run the program of the repository, which the crate emits for
 * the executor and today's runtime compiles.
 */
import { Identity } from "@commonfabric/identity";
import { fromFileUrl } from "@std/path";

import {
  getTimingStatsBreakdown,
  resetAllTimingStats,
} from "../../../logger/src/logger.ts";
import { resolveLocalProgram } from "../../../../runtime/runner/src/harness/local-program.deno.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../../runtime/runner/src/storage/cache.deno.ts";
import { type Artifact, Instance } from "../../exec/executor.ts";
import { Ref } from "../../exec/store.ts";

const repository = fromFileUrl(new URL("../../../../", import.meta.url));

/** The files of the program of Topics, relative to `patterns/`. */
const TOPICS_FILES = [
  "apps/topics/main.tsx",
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

/** One measured step. */
export type Step = {
  arm: "executor" | "today";
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
  arm: "executor" | "today";
  size: number;
  step: "baseline";
  heap?: number;
};

const round = (milliseconds: number) => Math.round(milliseconds * 100) / 100;

/**
 * The heap in use after a full collection, in bytes, or `undefined` when
 * the process was not started with `--v8-flags=--expose-gc`.
 */
const heapAfterCollection = (): number | undefined => {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect === undefined) return undefined;
  collect();
  return Deno.memoryUsage().heapUsed;
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
    { args: ["emit", ...TOPICS_FILES], cwd: `${repository}patterns` },
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
      if (module.endsWith("apps/topics/main.tsx")) board = pattern;
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
    heap: heapAfterCollection(),
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
  const steps: (Baseline | Step)[] = [baseline];
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
    steps.push({
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
      heap: heapAfterCollection(),
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

const runToday = async (
  { topics, names }: Board,
): Promise<(Baseline | Step)[]> => {
  const size = topics.length;
  const signer = await Identity.fromPassphrase(`topics-scale ${size}`);
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const changed = new Set<string>();
  storageManager.subscribe({
    // deno-lint-ignore no-explicit-any
    next(notification: any) {
      if (notification.type !== "commit") return undefined;
      for (const { address } of notification.changes) {
        changed.add(JSON.stringify([address.id, address.scope]));
      }
      return undefined;
    },
  });
  const steps: (Baseline | Step)[] = [];
  try {
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: `${repository}patterns/apps/topics/main.tsx`,
        root: repository,
      },
    );
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
    });
    steps.push({
      arm: "today",
      size,
      step: "baseline",
      heap: heapAfterCollection(),
    });
    const seed = runtime.edit();
    // Every cell exists before any is set, since a topic may mention one
    // after it.
    // deno-lint-ignore no-explicit-any
    const cells: any[] = topics.map((_, index) =>
      runtime.getCell(space, `topic ${index}`, undefined, seed)
    );
    topics.forEach(({ mentions, ...rest }, index) => {
      cells[index].set({
        ...rest,
        mentions: mentions.map((target) => cells[target]),
      });
    });
    const { error: seeded } = await seed.commit().settled;
    if (seeded !== undefined) throw seeded;
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "topics scale",
      compiled.resultSchema,
    );
    const settle = async () => {
      await result.pull();
      await runtime.settled();
    };
    const read = () => {
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
    const measure = async (step: string, change: () => Promise<void>) => {
      resetAllTimingStats();
      changed.clear();
      const began = performance.now();
      await change();
      await settle();
      const settled = performance.now();
      read();
      const done = performance.now();
      steps.push({
        arm: "today",
        size,
        step,
        settle: round(settled - began),
        read: round(done - settled),
        work: count("scheduler/scheduler/run/action"),
        commits: count("storage.v2.transaction/commit/commitNative"),
        documents: changed.size,
        facts: facts(),
        heap: heapAfterCollection(),
      });
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
        runtime.run(tx, compiled, {
          topics: cells,
          names: Object.fromEntries(
            Object.entries(names).map(([name, index]) => [name, cells[index]]),
          ),
        }, result.withTx(tx));
      }));
    for (const at of edited(size)) {
      await measure(`edit topic ${at}`, () =>
        commit((tx) => {
          cells[at].withTx(tx).key("title").set(`Edited topic ${at}`);
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
    await runtime.dispose();
    await storageManager.close();
  }
  return steps;
};

if (import.meta.main) {
  const [arm, ...given] = Deno.args;
  const boards = given[0] === "--seed" && given[1] !== undefined
    ? [await seeded(given[1])]
    : (given.length > 0 ? given.map(Number) : [100, 1_000, 2_000]).map(
      generated,
    );
  for (const board of boards) {
    const steps = arm === "executor"
      ? await runExecutor(board)
      : arm === "today"
      ? await runToday(board)
      : undefined;
    if (steps === undefined) {
      console.error("usage: scale.ts executor|today [sizes | --seed <seed>]");
      Deno.exit(2);
    }
    for (const step of steps) console.log(JSON.stringify(step));
  }
}
