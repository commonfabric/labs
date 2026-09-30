/**
 * Synthetic Topics data, and reach into the unmodified Topics sources, for
 * measuring the board's mention pivot and a topic's backlink, comment-count,
 * and activity lifts in one process with no browser and no server.
 *
 * A fixture is written straight to storage as one linked document per topic
 * and the board's list of links to them. Nothing goes through the board's
 * `addTopic`, so a fixture's size and mention graph are chosen by its options
 * rather than by what seeding a board can afford. The lifts are reached by
 * authored name through the runtime's artifact index, and each lift's runs are
 * attributed to it by the authored source the scheduler reports for them. A
 * measurement starts the lifts one demand workload names, and records reads
 * over its initialization, over each update written to it afterward, and over
 * reopening its storage in a fresh runtime.
 *
 * Every value is derived from the options, so fixtures built from equal
 * options hold equal data, and counts taken in separate runtimes compare.
 */

import { fromFileUrl } from "@std/path";

import { Identity } from "@commonfabric/identity";
import {
  type ActionReadStats,
  type Cell,
  type ExperimentalOptions,
  type IExtendedStorageTransaction,
  isModule,
  type MemorySpace,
  type Module,
  Runtime,
  type RuntimeProgram,
  RuntimeTelemetryEvent,
  type SchedulerGraphSnapshot,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

//
// Fixture data
//

/** Comments on each topic unless the options say otherwise. */
export const DEFAULT_COMMENTS_PER_TOPIC = 3;

/** Links on each topic unless the options say otherwise. */
export const DEFAULT_LINKS_PER_TOPIC = 3;

/**
 * The most comments or links one topic may carry. Each topic's timestamps sit
 * in a band of their own, and this bound keeps a topic's records inside it.
 */
export const MAX_RECORDS_PER_TOPIC = 10_000;

/**
 * The most mentions per source the `single-bucket` shape accepts. Its sources
 * repeat the bucket, so unlike the other shapes no topic count bounds them.
 */
export const MAX_SINGLE_BUCKET_MENTIONS_PER_SOURCE = 10_000;

/** Width of the timestamp band each topic's records occupy. */
const TOPIC_STAMP_BAND = 1_000_000;

/** Gap between successive sends, and successive additions, in one topic. */
const RECORD_STAMP_STEP = 10;

/**
 * How a fixture's topics mention one another.
 *
 * A shape's name says how the mentions are spread over their destinations, not
 * how many there are: `perSource` sets the count. `low-degree` and
 * `high-degree` both give each of the N topics `perSource` mentions, so N x
 * `perSource` in all. `low-degree` spreads each source's mentions over
 * distinct neighbors; `high-degree` concentrates them on the first `perSource`
 * topics, the hubs. The two meet at the extremes: at a `perSource` of N - 1
 * both are the complete graph, and at a `perSource` of one `high-degree`
 * differs from `single-bucket` only in the first topic mentioning the second.
 * A shape named in a measurement is therefore a spread, and its `perSource`
 * is what gives the degree.
 */
export type MentionGraph =
  /** No topic mentions anything. */
  | { readonly shape: "none" }
  /**
   * Each topic mentions the `perSource` topics after it, wrapping at the end of
   * the list, so every topic is mentioned by `perSource` others.
   */
  | { readonly shape: "low-degree"; readonly perSource: number }
  /**
   * Each topic mentions the first `perSource` topics other than itself, so
   * each of those hubs is mentioned by every other topic. A hub, which cannot
   * mention itself, mentions the topic after the hubs in its place.
   */
  | { readonly shape: "high-degree"; readonly perSource: number }
  /**
   * Every topic but the first mentions the first topic, `perSource` times
   * over, so one destination holds every inbound mention and a `perSource`
   * above one repeats it within each source. The first topic mentions
   * nothing: a mention of itself is what `selfMention` adds.
   */
  | { readonly shape: "single-bucket"; readonly perSource: number };

/** What a fixture is built from. */
export interface TopicsFixtureOptions {
  /** How many distinct topics the fixture holds. */
  readonly topicCount: number;

  /** How the topics mention one another. */
  readonly mentions: MentionGraph;

  /** Comments on every topic; {@link DEFAULT_COMMENTS_PER_TOPIC} if absent. */
  readonly commentsPerTopic?: number;

  /** Links on every topic; {@link DEFAULT_LINKS_PER_TOPIC} if absent. */
  readonly linksPerTopic?: number;

  /** A topic that also mentions itself, after the mentions its shape gives. */
  readonly selfMention?: number;

  /** A topic whose first mention appears a second time at the end of its list. */
  readonly repeatedMention?: number;

  /** A topic listed on the board a second time, after every other entry. */
  readonly duplicateBoardEntry?: number;
}

/** A comment's timestamps, which are what the reached lifts read of it. */
export interface FixtureComment {
  /** When the comment was sent. */
  readonly sentAt: number;

  /** When the comment was edited, absent on one never edited. */
  readonly editedAt?: number;

  /** When the comment was retracted, absent on one still present. */
  readonly removedAt?: number;
}

/** A link's timestamps, which are what the reached lifts read of it. */
export interface FixtureLink {
  /** When the link was added, absent on a link stored without the stamp. */
  readonly addedAt?: number;

  /** When the link was retracted, absent on one still present. */
  readonly removedAt?: number;
}

/** One topic of a fixture, with its mentions named by topic index. */
export interface FixtureTopic {
  /** The topic's title. */
  readonly title: string;

  /** Indices of the topics this one mentions, in order, repeats included. */
  readonly mentions: readonly number[];

  /** The topic's comments, in the order they were sent. */
  readonly comments: readonly FixtureComment[];

  /** The topic's links, in the order they were added. */
  readonly links: readonly FixtureLink[];

  /** When the topic was created. */
  readonly createdAt: number;

  /** When the topic's body was last saved. */
  readonly bodyUpdatedAt: number;

  /** When the topic was last renamed. */
  readonly titleUpdatedAt: number;
}

/** Synthetic Topics data, before anything is written to storage. */
export interface TopicsFixture {
  /** The distinct topics, by topic index. */
  readonly topics: readonly FixtureTopic[];

  /** The topic index at each board entry, in board order. */
  readonly board: readonly number[];
}

/**
 * Builds the fixture `options` describe.
 *
 * Each topic's comments and links carry edits, retractions, and a link stored
 * without an added stamp in a fixed rotation. Each topic's latest stamp is,
 * by topic index in turn, a comment retraction, a comment edit, and a link
 * retraction, for a topic with a comment, or for the last of the three a link,
 * to carry it.
 *
 * @throws RangeError when a count is out of range, or an option names a topic
 * index outside the fixture, or `repeatedMention` names a topic with nothing
 * to repeat.
 */
export function buildTopicsFixture(
  options: TopicsFixtureOptions,
): TopicsFixture {
  const { topicCount, mentions: graph } = options;
  const commentsPerTopic = options.commentsPerTopic ??
    DEFAULT_COMMENTS_PER_TOPIC;
  const linksPerTopic = options.linksPerTopic ?? DEFAULT_LINKS_PER_TOPIC;
  requireCount("topicCount", topicCount, 1, Number.MAX_SAFE_INTEGER);
  requireCount("commentsPerTopic", commentsPerTopic, 0, MAX_RECORDS_PER_TOPIC);
  requireCount("linksPerTopic", linksPerTopic, 0, MAX_RECORDS_PER_TOPIC);
  if (graph.shape === "low-degree" || graph.shape === "high-degree") {
    requireCount("mentions.perSource", graph.perSource, 1, topicCount - 1);
  } else if (graph.shape === "single-bucket") {
    requireCount(
      "mentions.perSource",
      graph.perSource,
      1,
      MAX_SINGLE_BUCKET_MENTIONS_PER_SOURCE,
    );
  }
  for (
    const name of [
      "selfMention",
      "repeatedMention",
      "duplicateBoardEntry",
    ] as const
  ) {
    const index = options[name];
    if (index !== undefined) requireCount(name, index, 0, topicCount - 1);
  }

  const topics = Array.from({ length: topicCount }, (_, index) => {
    const mentions = shapedMentions(graph, index, topicCount);
    if (options.selfMention === index) mentions.push(index);
    if (options.repeatedMention === index) {
      if (mentions.length === 0) {
        throw new RangeError(
          `\`repeatedMention\` names topic ${index}, which mentions nothing.`,
        );
      }
      mentions.push(mentions[0]);
    }
    return fixtureTopic(index, mentions, commentsPerTopic, linksPerTopic);
  });
  const board = topics.map((_, index) => index);
  if (options.duplicateBoardEntry !== undefined) {
    board.push(options.duplicateBoardEntry);
  }
  return { topics, board };
}

/**
 * Helper for {@link buildTopicsFixture}, which throws unless `value` is a safe
 * integer from `min` to `max` inclusive.
 */
function requireCount(name: string, value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(
      `\`${name}\` must be an integer from ${min} to ${max}: ${value}`,
    );
  }
}

/**
 * Helper for {@link buildTopicsFixture}, which returns the mentions `graph`
 * gives the topic at `index`.
 */
function shapedMentions(
  graph: MentionGraph,
  index: number,
  topicCount: number,
): number[] {
  switch (graph.shape) {
    case "none":
      return [];
    case "low-degree":
      return Array.from(
        { length: graph.perSource },
        (_, k) => (index + 1 + k) % topicCount,
      );
    case "high-degree":
      return Array.from(
        { length: graph.perSource },
        (_, k) => k < index ? k : k + 1,
      );
    case "single-bucket":
      return index === 0 ? [] : Array(graph.perSource).fill(0);
  }
}

/**
 * Helper for {@link buildTopicsFixture}, which returns the topic at `index`
 * with its stamped comments and links.
 */
function fixtureTopic(
  index: number,
  mentions: number[],
  commentCount: number,
  linkCount: number,
): FixtureTopic {
  const createdAt = TOPIC_STAMP_BAND * (index + 1);
  const stampAt = (position: number) =>
    createdAt + RECORD_STAMP_STEP * (position + 1);
  // Later than every other stamp this topic's records carry, which is what
  // makes the record given it the topic's latest activity.
  const latest = stampAt(Math.max(commentCount, linkCount));

  const comments = Array.from({ length: commentCount }, (_, c) => {
    const sentAt = stampAt(c);
    const last = c === commentCount - 1;
    const editedAt = last && index % 3 === 1
      ? latest
      : c % 3 === 1
      ? sentAt + 1
      : undefined;
    const removedAt = last && index % 3 === 0
      ? latest
      : c % 3 === 2
      ? sentAt + 2
      : undefined;
    return {
      sentAt,
      ...(editedAt === undefined ? {} : { editedAt }),
      ...(removedAt === undefined ? {} : { removedAt }),
    };
  });
  const links = Array.from({ length: linkCount }, (_, l) => {
    const last = l === linkCount - 1;
    const addedAt = l % 3 === 2 ? undefined : stampAt(l) + 5;
    const removedAt = last && index % 3 === 2
      ? latest
      : l % 3 === 1
      ? stampAt(l) + 7
      : undefined;
    return {
      ...(addedAt === undefined ? {} : { addedAt }),
      ...(removedAt === undefined ? {} : { removedAt }),
    };
  });
  return {
    title: `Topic ${index}`,
    mentions,
    comments,
    links,
    createdAt,
    bodyUpdatedAt: createdAt + 3,
    titleUpdatedAt: createdAt + 4,
  };
}

//
// Reach into the Topics sources
//

/** The Topics lifts reached by authored name. */
export const TOPICS_LIFT_NAMES = [
  "crossrefTable",
  "backlinksOf",
  "presentCommentCountOf",
  "lastActivityOf",
] as const;

/** The authored name of one reached Topics lift. */
export type TopicsLiftName = typeof TOPICS_LIFT_NAMES[number];

/** Which module of a Topics program defines each lift. */
const LIFT_MODULES: Readonly<Record<TopicsLiftName, "board" | "topic">> = {
  crossrefTable: "board",
  backlinksOf: "topic",
  presentCommentCountOf: "topic",
  lastActivityOf: "topic",
};

/** The patterns package, which the Topics sources resolve their imports within. */
const PATTERNS_ROOT = fromFileUrl(new URL("..", import.meta.url));

/** The board's entry module in this checkout. */
const BOARD_MAIN = fromFileUrl(new URL("../topics/main.tsx", import.meta.url));

/** The board's exported join, as the oracle calls it. */
export type MentionedBy = <T extends object>(
  topic: T,
  list: readonly T[],
  mentions: readonly (readonly (object | undefined)[] | undefined)[],
) => T[];

/** The Topics derivations a measurement runs, reached from a compiled program. */
export interface TopicsDerivations {
  /** The lifts, by authored name. */
  readonly lifts: Readonly<Record<TopicsLiftName, Module>>;

  /**
   * The authored source the scheduler reports for each lift's runs, as
   * `cf:module/<identity>/<path>:<line>:<col>`.
   */
  readonly sources: Readonly<Record<TopicsLiftName, string>>;

  /** The board's exported join, which its pivot applies to each topic. */
  readonly mentionedBy: MentionedBy;
}

/** Resolves the unmodified Topics board program from this checkout. */
export function resolveTopicsProgram(
  runtime: Runtime,
): Promise<RuntimeProgram> {
  return resolveLocalProgram(
    (resolver) => runtime.harness.resolve(resolver),
    { main: BOARD_MAIN, root: PATTERNS_ROOT },
  );
}

/**
 * Compiles `program`, a Topics board whose entry module imports its topic
 * from a sibling `topic.tsx`, and returns its lifts by authored name from the
 * runtime's artifact index, and `mentionedBy` from the board's exports.
 *
 * @throws Error naming the module `program` does not evaluate, or naming
 * every reached symbol the program does not define as a lift or, for
 * `mentionedBy`, as an exported function.
 */
export async function reachTopicsDerivations(
  runtime: Runtime,
  program: RuntimeProgram,
): Promise<TopicsDerivations> {
  const { patternManager } = runtime;
  const evaluated = await patternManager.compileAndRegisterModules(program);
  const identityOf = (path: string) => {
    for (const [identity, source] of evaluated.sourcePathByIdentity ?? []) {
      if (source === path) return identity;
    }
    throw new Error(`The Topics program evaluated no module \`${path}\`.`);
  };
  const boardPath = program.main;
  const identities = {
    board: identityOf(boardPath),
    topic: identityOf(
      `${boardPath.slice(0, boardPath.lastIndexOf("/") + 1)}topic.tsx`,
    ),
  };

  const missing: string[] = [];
  const lifts: Partial<Record<TopicsLiftName, Module>> = {};
  const sources: Partial<Record<TopicsLiftName, string>> = {};
  for (const name of TOPICS_LIFT_NAMES) {
    const artifact = patternManager.artifactFromIdentitySync(
      identities[LIFT_MODULES[name]],
      name,
    );
    const source = isModule(artifact) ? authoredSourceOf(artifact) : undefined;
    if (!isModule(artifact) || source === undefined) {
      missing.push(name);
      continue;
    }
    lifts[name] = artifact;
    sources[name] = source;
  }
  const mentionedBy: unknown = evaluated.main?.mentionedBy;
  if (typeof mentionedBy !== "function") missing.push("mentionedBy");
  if (missing.length > 0) {
    throw new Error(
      `The Topics program \`${boardPath}\` does not define ${
        missing.map((name) => `\`${name}\``).join(", ")
      }.`,
    );
  }
  return {
    lifts: lifts as Record<TopicsLiftName, Module>,
    sources: sources as Record<TopicsLiftName, string>,
    mentionedBy: mentionedBy as MentionedBy,
  };
}

/**
 * Helper for {@link reachTopicsDerivations}, which returns the authored source
 * of a lift, or `undefined` for a module with no verified implementation.
 *
 * The builder installs a `src` accessor on a lift's implementation, and it
 * resolves through the same record the scheduler reads when it reports a run's
 * `src`, so the two agree by construction.
 */
function authoredSourceOf(module: Module): string | undefined {
  const { implementation } = module;
  if (typeof implementation !== "function") return undefined;
  const src: unknown = (implementation as { src?: unknown }).src;
  return typeof src === "string" ? src : undefined;
}

//
// Measurement
//

/** Completed-body reads, summed over the runs attributed to one bucket. */
export interface BodyReads extends ActionReadStats {
  /** Completed runs. */
  runs: number;

  /** The scheduler actions those runs belong to, by action ID. */
  readonly actions: Set<string>;

  /** The most proxy accesses any one of those runs made. */
  maxRunProxyAccesses: number;
}

/**
 * Transaction-attempt reads, summed over the attempts attributed to one
 * bucket.
 */
export interface AttemptReads {
  /** Attempts recorded. */
  attempts: number;

  /** Proxy accesses across those attempts. */
  proxyAccesses: number;

  /** Link resolutions across those attempts. */
  linkResolutions: number;
}

/** Reads recorded over one measurement. */
export interface TopicsReads {
  /**
   * Body reads per reached lift, attributed by the authored source each run
   * reports. Every other run, builtins and sinks included, is under `other`.
   */
  readonly bodies: Readonly<Record<TopicsLiftName | "other", BodyReads>>;

  /**
   * Attempt reads per reached lift, attributed when recording stops by the
   * action each attempt names: an attempt belongs to a lift when its action
   * completed a run of that lift while recording, and to `other` when its
   * action completed some other run or it names no action, as the
   * initialization attempt does. An attempt whose action completed no run
   * while recording, such as one aborted because a read was unavailable, is
   * under `unattributed`.
   */
  readonly attempts: Readonly<
    Record<TopicsLiftName | "other" | "unattributed", AttemptReads>
  >;
}

/** A fixture written to storage. */
export interface SeededTopicsFixture {
  /** Each topic's document, by topic index. */
  readonly topics: readonly Cell<unknown>[];

  /** The board's list: one link to a topic document per board entry. */
  readonly board: Cell<unknown[]>;
}

/**
 * One row of the board's pivot, as a reader of the table sees it: links it
 * compares and follows, never values it expands.
 */
export interface PivotRow {
  /** The topic the row describes. */
  topic: unknown;

  /** The topics that mention it. */
  mentionedBy: unknown[];
}

/** The flags every mode pins, and so the flags a mode is recognized by. */
const MODE_FLAGS = ["lazyMaterialization", "serverExecution"] as const;

/**
 * The experimental postures a measurement runs under, by the name that labels
 * its samples. Each pins every flag in {@link MODE_FLAGS}, so that a
 * measurement keeps those semantics whatever the runtime's defaults become:
 * left unset, `lazyMaterialization` takes the built-in default, and
 * `serverExecution` takes process-wide state that another runtime in the same
 * process can change.
 *
 * Every posture here holds `serverExecution` off. A measurement's runtime has
 * nothing to serve — it runs over an emulated storage manager in one process,
 * with no memory server and no serving loop, where the ON posture needs a
 * toolshed carrying an `ExecutorHost` over its memory server, as
 * `docs/development/EXPERIMENTAL_OPTIONS.md` describes — so a measurement
 * labeled as having server execution on would name a posture that nothing
 * here engages.
 */
export const TOPICS_FIXTURE_MODES = {
  /** Lazy materialization on, the posture a runtime takes by default. */
  "lazy-materialization-on": {
    lazyMaterialization: true,
    serverExecution: false,
  },

  /** Lazy materialization off, where a lift's body reads its whole argument. */
  "lazy-materialization-off": {
    lazyMaterialization: false,
    serverExecution: false,
  },
} as const satisfies Record<string, Record<typeof MODE_FLAGS[number], boolean>>;

/** Names one of {@link TOPICS_FIXTURE_MODES}. */
export type TopicsFixtureMode = keyof typeof TOPICS_FIXTURE_MODES;

/** The mode a measurement runs under when it is given no other. */
export const DEFAULT_TOPICS_FIXTURE_MODE: TopicsFixtureMode =
  "lazy-materialization-on";

/**
 * Returns the mode whose flags `experimental` holds, as a runtime reports them
 * back once it has resolved what it was given. Deriving a sample's label from
 * the runtime's own report is what keeps the label reading the same field the
 * runner acts on.
 *
 * It reads the flags {@link TOPICS_FIXTURE_MODES} names and no others, so two
 * runtimes it calls the same mode may still differ in a flag no mode pins.
 *
 * @throws Error when no mode holds those flags.
 */
export function topicsFixtureModeOf(
  experimental: ExperimentalOptions,
): TopicsFixtureMode {
  const names = Object.keys(TOPICS_FIXTURE_MODES) as TopicsFixtureMode[];
  const found = names.find((name) =>
    MODE_FLAGS.every((flag) =>
      experimental[flag] === TOPICS_FIXTURE_MODES[name][flag]
    )
  );
  if (found === undefined) {
    const flags = MODE_FLAGS
      .map((flag) => `${flag}=${experimental[flag]}`)
      .join(", ");
    throw new Error(`No measurement mode runs with ${flags}.`);
  }
  return found;
}

/**
 * Which of the reached lifts a measurement starts and holds demanded.
 *
 * The `board` and `topic-open` workloads follow what a browser ran on one small
 * board with client execution, lazy materialization on, and card values
 * already stored. Loading the board, before any topic was opened, ran none of
 * the reached lifts; opening a topic ran the pivot and that topic's backlinks
 * and comment count but not its last activity; and returning to the board
 * afterward ran that topic's last activity once. That return is not one of
 * these workloads. It is one small sample, and server execution and lazy
 * materialization off were not measured.
 */
export type TopicsDemand =
  /** A board loaded before any topic is opened: none of the reached lifts. */
  | { readonly workload: "board" }
  /**
   * The board with one topic open: the pivot, and that topic's backlinks and
   * comment count.
   */
  | { readonly workload: "topic-open"; readonly topic: number }
  /**
   * The pivot, and every topic's backlinks: a scaling probe, not what a board
   * in use demands.
   */
  | { readonly workload: "all-backlinks" }
  /**
   * Every topic's comment count and last activity, and nothing else: the lifts
   * that read a topic's comments, and of those the last activity reads its
   * links as well. A browser ran them only for the topic it opened, the
   * comment count on opening that topic and its last activity on returning to
   * the board, so every topic's at once is not what a board in use demands.
   */
  | { readonly workload: "aggregates" };

/** The demanded lifts' outputs over a seeded fixture. */
export interface TopicsOutputs {
  /**
   * The board's pivot over the fixture's board, a link to a row per distinct
   * topic, when the demand starts the pivot.
   */
  readonly table?: Cell<PivotRow[]>;

  /** Each demanded topic's backlinks, by topic index. */
  readonly backlinks: ReadonlyMap<number, Cell<unknown[]>>;

  /** Each demanded topic's present comment count, by topic index. */
  readonly commentCounts: ReadonlyMap<number, Cell<number>>;

  /** Each demanded topic's last activity, by topic index. */
  readonly lastActivity: ReadonlyMap<number, Cell<number>>;
}

/**
 * What a regression variant starts its actions from: the transaction that
 * starts the demanded lifts, and the fixture they run over.
 */
export interface TopicsVariantStart {
  /** The transaction starting the demanded lifts, which the actions join. */
  readonly tx: IExtendedStorageTransaction;

  /** The fixture as written to storage. */
  readonly seeded: SeededTopicsFixture;

  /**
   * Returns the cell for the variant's output called `name`, apart from every
   * output the demanded lifts write.
   */
  output<T>(name: string): Cell<T>;

  /**
   * Starts another instance of each demanded lift over the same inputs, each
   * writing an output named with `name` apart from the first instance's, and
   * returns those outputs.
   */
  startDemandedLifts(name: string): readonly Cell<unknown>[];
}

/**
 * Extra work a measurement starts beside the lifts its demand names, which a
 * read-budget test uses as a regression variant. It is called once for each
 * runtime a measurement opens, after the Topics sources are compiled and
 * before reads are recorded, so work it does then, such as compiling a module
 * of its own, is not measured. The function it resolves to starts the
 * variant's actions in the transaction that starts the demanded lifts and
 * returns their outputs, which the measurement holds demanded as it holds the
 * lifts' own. Those outputs are not among the measurement's `outputs`.
 */
export type TopicsVariant = (
  runtime: Runtime,
  derivations: TopicsDerivations,
) => Promise<(start: TopicsVariantStart) => readonly Cell<unknown>[]>;

/** An operation on a measurement, recorded through settlement. */
export interface TopicsOperation {
  /** Reads from the start of the operation through settlement. */
  readonly reads: TopicsReads;

  /** The scheduler's graph once settled. */
  readonly graph: SchedulerGraphSnapshot;

  /**
   * Wall-clock milliseconds from the start of the operation through
   * settlement.
   */
  readonly elapsedMs: number;
}

/**
 * A settled measurement, holding a runtime over the fixture's storage open
 * until disposed. That is the runtime the measurement started, until
 * `reopen()` replaces it; `runtime`, `mode`, `derivations`, `seeded`, and
 * `outputs` always describe the current one.
 */
export interface TopicsMeasurement extends AsyncDisposable {
  /** The runtime running the demanded lifts. */
  readonly runtime: Runtime;

  /** The experimental posture `runtime` reports itself running under. */
  readonly mode: TopicsFixtureMode;

  /** The derivations `runtime` reached. */
  readonly derivations: TopicsDerivations;

  /** The fixture as written to storage, addressed through `runtime`. */
  readonly seeded: SeededTopicsFixture;

  /** The lifts the measurement starts and holds demanded. */
  readonly demand: TopicsDemand;

  /** The outputs `runtime` holds demanded until the measurement is disposed. */
  readonly outputs: TopicsOutputs;

  /** Reads from the start of the lifts through settlement, at initialization. */
  readonly reads: TopicsReads;

  /**
   * Wall-clock milliseconds from the start of the lifts through settlement, at
   * initialization.
   */
  readonly elapsedMs: number;

  /** The scheduler's graph once initialization settled. */
  readonly graph: SchedulerGraphSnapshot;

  /** Errors any of the measurement's runtimes reported, in the order reported. */
  readonly errors: readonly string[];

  /**
   * Writes `edit` in one transaction, commits it, and returns once the runtime
   * has settled, with the reads recorded from the start of the edit through
   * settlement. The edit's own transaction is not a read attempt; the reactive
   * runs its commit causes are. Every run completed before settlement is
   * recorded, whatever caused it, so operations must not overlap.
   *
   * @throws Error when the commit fails.
   */
  update(
    edit: (tx: IExtendedStorageTransaction) => void,
  ): Promise<TopicsOperation>;

  /**
   * Disposes `runtime` without closing its storage, opens a fresh runtime over
   * the same storage manager, reaches the Topics lifts again, and starts the
   * lifts `demand` names over the stored fixture and the outputs already written
   * for them, returning once the new runtime has settled.
   *
   * Reads are recorded from the transaction that starts the lifts through
   * settlement, as at initialization; disposing the old runtime and compiling
   * the sources precede it and are not recorded. Both runtimes share one
   * storage manager, so this reopens storage the process holds open rather than
   * connecting a new client to it.
   *
   * @throws Error when starting the lifts fails to commit.
   */
  reopen(): Promise<TopicsOperation>;
}

/** How {@link measureTopicsFixture} runs the lifts it measures. */
export interface TopicsMeasurementOptions {
  /**
   * The experimental posture every runtime the measurement opens is given.
   * Defaults to {@link DEFAULT_TOPICS_FIXTURE_MODE}.
   */
  readonly mode?: TopicsFixtureMode;

  /** Extra work every runtime the measurement opens starts beside its lifts. */
  readonly variant?: TopicsVariant;
}

/**
 * Runs the reached Topics lifts `demand` names over `fixture` in a fresh
 * runtime, holding their outputs demanded, and returns once the runtime has
 * settled. Given a `variant`, every runtime the measurement opens starts the
 * variant's actions beside the lifts, in the same transaction.
 *
 * Reads are recorded from the transaction that starts the lifts, which is
 * accounted as initialization, through settlement; compiling the sources and
 * writing the fixture precede it and are not recorded. The fixture's storage
 * stays open until the measurement is disposed, which is what lets `reopen()`
 * start the lifts again over it.
 *
 * @throws RangeError when `demand` opens a topic outside the fixture.
 * @throws Error when a runtime it opens resolves the flags of a mode other
 * than the one it was given.
 */
export async function measureTopicsFixture(
  fixture: TopicsFixture,
  passphrase: string,
  demand: TopicsDemand = { workload: "all-backlinks" },
  { mode = DEFAULT_TOPICS_FIXTURE_MODE, variant }: TopicsMeasurementOptions =
    {},
): Promise<TopicsMeasurement> {
  const demanded = demandedLiftsOf(demand, fixture.topics.length);
  await using stack = new AsyncDisposableStack();
  const identity = await Identity.fromPassphrase(passphrase);
  const space: MemorySpace = identity.did();
  const storage = EmulatedStorageManager.emulate({ as: identity });
  stack.defer(() => storage.close());
  const errors: string[] = [];
  const open = (seed?: TopicsFixture) =>
    openTopicsSession(
      storage,
      space,
      errors,
      { topicCount: fixture.topics.length, demanded, mode, seed, variant },
    );

  // Unset only while `reopen()` is between disposing one session and opening
  // the next, so a measurement whose reopen failed holds no runtime.
  let session: TopicsSession | undefined = await open(fixture);
  stack.defer(() => session?.[Symbol.asyncDispose]());
  const { start } = session;
  const current = (): TopicsSession => {
    if (session === undefined) {
      throw new Error(
        "The measurement holds no runtime: its `reopen()` did not complete.",
      );
    }
    return session;
  };

  const update = async (
    edit: (tx: IExtendedStorageTransaction) => void,
  ): Promise<TopicsOperation> => {
    const { runtime, derivations } = current();
    const recording = recordTopicsReads(runtime, derivations.sources);
    let elapsedMs: number;
    let graph: SchedulerGraphSnapshot;
    try {
      const started = performance.now();
      const tx = runtime.edit();
      edit(tx);
      const { error } = await tx.commit();
      if (error !== undefined) {
        throw new Error(`Committing a Topics update failed: ${error.name}`, {
          cause: error,
        });
      }
      await runtime.settled(Infinity);
      elapsedMs = performance.now() - started;
      graph = runtime.scheduler.getGraphSnapshot();
    } finally {
      recording[Symbol.dispose]();
    }
    return { reads: recording.reads, graph, elapsedMs };
  };

  const reopen = async (): Promise<TopicsOperation> => {
    const previous = current();
    session = undefined;
    await previous[Symbol.asyncDispose]();
    session = await open();
    return session.start;
  };

  const cleanup = stack.move();
  return {
    get runtime() {
      return current().runtime;
    },
    get mode() {
      return current().mode;
    },
    get derivations() {
      return current().derivations;
    },
    get seeded() {
      return current().seeded;
    },
    demand,
    get outputs() {
      return current().outputs;
    },
    reads: start.reads,
    elapsedMs: start.elapsedMs,
    graph: start.graph,
    errors,
    update,
    reopen,
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}

/** One runtime running the demanded lifts over a fixture's storage. */
interface TopicsSession extends AsyncDisposable {
  /** The runtime. */
  readonly runtime: Runtime;

  /** The experimental posture `runtime` reports itself running under. */
  readonly mode: TopicsFixtureMode;

  /** The derivations the runtime reached. */
  readonly derivations: TopicsDerivations;

  /** The fixture's documents, addressed through the runtime. */
  readonly seeded: SeededTopicsFixture;

  /** The outputs, each held demanded until the session is disposed. */
  readonly outputs: TopicsOutputs;

  /** What starting the lifts recorded, from their start through settlement. */
  readonly start: TopicsOperation;
}

/**
 * Helper for {@link measureTopicsFixture}, which opens a runtime over `storage`
 * under the posture `mode` names, reaches the Topics lifts, writes `seed` into
 * `space` or, absent one, addresses the fixture already written there, and
 * starts the lifts `demanded` names, with `variant`'s actions when given,
 * recording reads from that start through settlement. Disposing the session
 * disposes its runtime and leaves `storage` open.
 *
 * @throws Error when the runtime resolves the flags of another mode, which is
 * what a flag the runtime refused or took from ambient state looks like.
 */
async function openTopicsSession(
  storage: EmulatedStorageManager,
  space: MemorySpace,
  errors: string[],
  { topicCount, demanded, mode, seed, variant }: {
    readonly topicCount: number;
    readonly demanded: DemandedLifts;
    readonly mode: TopicsFixtureMode;
    readonly seed?: TopicsFixture;
    readonly variant?: TopicsVariant;
  },
): Promise<TopicsSession> {
  await using stack = new AsyncDisposableStack();
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: TOPICS_FIXTURE_MODES[mode],
    errorHandlers: [(error) => errors.push(String(error))],
  });
  stack.defer(() => runtime.dispose({ closeStorage: false }));

  // The label comes from the runtime's own report of its flags rather than
  // from the name asked for, so a sample says what ran. Every mode sets both
  // flags explicitly and the runtime keeps an explicit value, so today the two
  // always agree and this guard cannot fire; it is here for a flag that later
  // resolves against an ambient control point, where they could part.
  const resolved = topicsFixtureModeOf(runtime.experimental);
  if (resolved !== mode) {
    throw new Error(
      `A runtime given the \`${mode}\` mode runs \`${resolved}\`.`,
    );
  }

  const derivations = await reachTopicsDerivations(
    runtime,
    await resolveTopicsProgram(runtime),
  );
  const startVariant = await variant?.(runtime, derivations);
  const seeded = seed === undefined
    ? storedTopicsFixture(runtime, space, topicCount)
    : await seedTopicsFixture(runtime, space, seed);
  const recorder = recordTopicsReads(runtime, derivations.sources);
  let outputs: TopicsOutputs;
  let elapsedMs: number;
  try {
    const started = performance.now();
    const lifts = await startTopicsLifts(
      runtime,
      space,
      derivations,
      seeded,
      demanded,
      startVariant,
    );
    outputs = lifts.outputs;
    for (
      const cell of [...outputCellsOf(outputs), ...lifts.variantOutputs]
    ) {
      stack.defer(cell.sink(() => {}));
    }
    await runtime.settled(Infinity);
    elapsedMs = performance.now() - started;
  } finally {
    recorder[Symbol.dispose]();
  }
  const start = {
    reads: recorder.reads,
    graph: runtime.scheduler.getGraphSnapshot(),
    elapsedMs,
  };

  const cleanup = stack.move();
  return {
    runtime,
    mode: resolved,
    derivations,
    seeded,
    outputs,
    start,
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}

/** The cause of topic `index`'s document. */
function topicCause(index: number): string {
  return `topics-fixture-topic-${index}`;
}

/** The cause of the board's list of topic links. */
const BOARD_CAUSE = "topics-fixture-board";

/**
 * Helper for {@link openTopicsSession}, which addresses the first
 * `topicCount` topic documents and the board already written into `space`.
 */
function storedTopicsFixture(
  runtime: Runtime,
  space: MemorySpace,
  topicCount: number,
): SeededTopicsFixture {
  return {
    topics: Array.from(
      { length: topicCount },
      (_, index) => runtime.getCell<unknown>(space, topicCause(index)),
    ),
    board: runtime.getCell<unknown[]>(space, BOARD_CAUSE),
  };
}

/** The reached lifts a demand starts, with the topics each topic lift runs for. */
interface DemandedLifts {
  /**
   * Present when the pivot runs, with the topics whose backlinks run: backlinks
   * read the pivot's result, so no demand runs them without it.
   */
  readonly pivot?: { readonly backlinks: readonly number[] };

  /** The topics whose present comment count runs. */
  readonly commentCounts: readonly number[];

  /** The topics whose last activity runs. */
  readonly lastActivity: readonly number[];
}

/**
 * Helper for {@link measureTopicsFixture}, which returns the lifts `demand`
 * starts over `topicCount` topics.
 *
 * @throws RangeError when `demand` opens a topic outside the fixture.
 */
function demandedLiftsOf(
  demand: TopicsDemand,
  topicCount: number,
): DemandedLifts {
  const every = Array.from({ length: topicCount }, (_, index) => index);
  switch (demand.workload) {
    case "board":
      return { commentCounts: [], lastActivity: [] };
    case "topic-open":
      requireCount("demand.topic", demand.topic, 0, topicCount - 1);
      return {
        pivot: { backlinks: [demand.topic] },
        commentCounts: [demand.topic],
        lastActivity: [],
      };
    case "all-backlinks":
      return {
        pivot: { backlinks: every },
        commentCounts: [],
        lastActivity: [],
      };
    case "aggregates":
      return { commentCounts: every, lastActivity: every };
  }
}

/**
 * Helper for {@link measureTopicsFixture}, which writes `fixture` into `space`
 * in one commit, each mention as a link to the topic it names.
 */
async function seedTopicsFixture(
  runtime: Runtime,
  space: MemorySpace,
  fixture: TopicsFixture,
): Promise<SeededTopicsFixture> {
  const tx = runtime.edit();
  const topics = fixture.topics.map((_, index) =>
    runtime.getCell<unknown>(space, topicCause(index), undefined, tx)
  );
  fixture.topics.forEach((topic, index) =>
    topics[index].set({
      ...topic,
      mentions: topic.mentions.map((target) => topics[target]),
    })
  );
  const board = runtime.getCell<unknown[]>(space, BOARD_CAUSE, undefined, tx);
  board.set(fixture.board.map((index) => topics[index]));
  const { error } = await tx.commit();
  if (error !== undefined) {
    throw new Error(`Writing the Topics fixture failed: ${error.name}`, {
      cause: error,
    });
  }
  return { topics: topics.map((cell) => cell.withTx()), board: board.withTx() };
}

/**
 * Helper for {@link openTopicsSession}, which starts the lifts `demanded`
 * names over the seeded fixture, and `startVariant`'s actions when given, in
 * one transaction begun as an initialization attempt, and returns the lifts'
 * outputs apart from the variant's.
 */
async function startTopicsLifts(
  runtime: Runtime,
  space: MemorySpace,
  { lifts }: TopicsDerivations,
  seeded: SeededTopicsFixture,
  demanded: DemandedLifts,
  startVariant?: (start: TopicsVariantStart) => readonly Cell<unknown>[],
): Promise<{
  readonly outputs: TopicsOutputs;
  readonly variantOutputs: readonly Cell<unknown>[];
}> {
  const tx = runtime.edit();
  runtime.scheduler.beginReadAttempt(tx, "initialization");
  const output = <T>(cause: string) =>
    runtime.getCell<T>(space, cause, undefined, tx);
  const withBacklinks = new Set(demanded.pivot?.backlinks);
  const withCommentCount = new Set(demanded.commentCounts);
  const withLastActivity = new Set(demanded.lastActivity);
  // Starts one instance of each demanded lift, with `prefix` opening the cause
  // of every output it writes.
  const start = (prefix: string): TopicsOutputs => {
    const table = demanded.pivot === undefined ? undefined : runtime.run(
      tx,
      lifts.crossrefTable,
      { sources: seeded.board },
      output<PivotRow[]>(`${prefix}crossrefs`),
    );
    const backlinks = new Map<number, Cell<unknown[]>>();
    const commentCounts = new Map<number, Cell<number>>();
    const lastActivity = new Map<number, Cell<number>>();
    seeded.topics.forEach((topic, index) => {
      if (table !== undefined && withBacklinks.has(index)) {
        backlinks.set(
          index,
          runtime.run(
            tx,
            lifts.backlinksOf,
            { table, self: topic },
            output<unknown[]>(`${prefix}backlinks-${index}`),
          ),
        );
      }
      if (withCommentCount.has(index)) {
        commentCounts.set(
          index,
          runtime.run(
            tx,
            lifts.presentCommentCountOf,
            { comments: topic.key("comments") },
            output<number>(`${prefix}comment-count-${index}`),
          ),
        );
      }
      if (withLastActivity.has(index)) {
        lastActivity.set(
          index,
          runtime.run(
            tx,
            lifts.lastActivityOf,
            {
              comments: topic.key("comments"),
              links: topic.key("links"),
              createdAt: topic.key("createdAt"),
              bodyUpdatedAt: topic.key("bodyUpdatedAt"),
              titleUpdatedAt: topic.key("titleUpdatedAt"),
            },
            output<number>(`${prefix}last-activity-${index}`),
          ),
        );
      }
    });
    return table === undefined
      ? { backlinks, commentCounts, lastActivity }
      : { table, backlinks, commentCounts, lastActivity };
  };
  const outputs = start("topics-fixture-");
  const variantOutputs = startVariant?.({
    tx,
    seeded,
    output: <T>(name: string) => output<T>(`topics-fixture-variant-${name}`),
    startDemandedLifts: (name) =>
      outputCellsOf(start(`topics-fixture-variant-${name}-`)),
  }) ?? [];
  runtime.prepareTxForCommit(tx);
  const { error } = await tx.commit();
  if (error !== undefined) {
    throw new Error(`Starting the Topics lifts failed: ${error.name}`, {
      cause: error,
    });
  }
  return { outputs, variantOutputs };
}

/** Returns every output cell `outputs` holds, the pivot's first when held. */
function outputCellsOf(outputs: TopicsOutputs): Cell<unknown>[] {
  const { table, backlinks, commentCounts, lastActivity } = outputs;
  return [
    ...(table === undefined ? [] : [table]),
    ...backlinks.values(),
    ...commentCounts.values(),
    ...lastActivity.values(),
  ];
}

/**
 * Helper for {@link measureTopicsFixture}, which enables body and attempt read
 * accounting on `runtime` and records each completed run, and each attempt,
 * under the lift it belongs to, until disposed.
 */
function recordTopicsReads(
  runtime: Runtime,
  sources: Readonly<Record<TopicsLiftName, string>>,
): { readonly reads: TopicsReads } & Disposable {
  const liftBySource = new Map<string, TopicsLiftName>(
    TOPICS_LIFT_NAMES.map((name) => [sources[name], name]),
  );
  const emptyBody = (): BodyReads => ({
    runs: 0,
    actions: new Set(),
    proxyAccesses: 0,
    linkResolutions: 0,
    distinctDocuments: 0,
    registeredDependencies: 0,
    maxRunProxyAccesses: 0,
  });
  const emptyAttempts = (): AttemptReads => ({
    attempts: 0,
    proxyAccesses: 0,
    linkResolutions: 0,
  });
  const reads = {
    bodies: {
      crossrefTable: emptyBody(),
      backlinksOf: emptyBody(),
      presentCommentCountOf: emptyBody(),
      lastActivityOf: emptyBody(),
      other: emptyBody(),
    },
    attempts: {
      crossrefTable: emptyAttempts(),
      backlinksOf: emptyAttempts(),
      presentCommentCountOf: emptyAttempts(),
      lastActivityOf: emptyAttempts(),
      other: emptyAttempts(),
      unattributed: emptyAttempts(),
    },
  };
  // An attempt names its action, and an action's lift is known only from the
  // body runs reported for it, which need not arrive before the attempt. So
  // attempts are held by action here and attributed when recording stops.
  const attemptsByAction = new Map<string | undefined, AttemptReads>();
  const listener = (event: Event) => {
    if (!(event instanceof RuntimeTelemetryEvent)) return;
    const { marker } = event;
    if (marker.type === "scheduler.read-attempt") {
      const held = attemptsByAction.get(marker.actionId) ?? emptyAttempts();
      held.attempts++;
      held.proxyAccesses += marker.reads.proxyAccesses;
      held.linkResolutions += marker.reads.linkResolutions;
      attemptsByAction.set(marker.actionId, held);
    } else if (marker.type === "scheduler.run.complete") {
      const lift = marker.src === undefined
        ? undefined
        : liftBySource.get(marker.src);
      const body = reads.bodies[lift ?? "other"];
      const run = marker.reads;
      body.runs++;
      body.actions.add(marker.actionId);
      body.proxyAccesses += run?.proxyAccesses ?? 0;
      body.linkResolutions += run?.linkResolutions ?? 0;
      body.distinctDocuments += run?.distinctDocuments ?? 0;
      body.registeredDependencies += run?.registeredDependencies ?? 0;
      body.maxRunProxyAccesses = Math.max(
        body.maxRunProxyAccesses,
        run?.proxyAccesses ?? 0,
      );
    }
  };
  runtime.telemetry.addEventListener("telemetry", listener);
  runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
  return {
    reads,
    [Symbol.dispose]: () => {
      runtime.scheduler.setReadStatsEnabled(false);
      runtime.telemetry.removeEventListener("telemetry", listener);
      for (const [actionId, held] of attemptsByAction) {
        const lift = actionId === undefined
          ? undefined
          : TOPICS_LIFT_NAMES.find((name) =>
            reads.bodies[name].actions.has(actionId)
          );
        const bucket = reads.attempts[
          lift ??
            (actionId === undefined || reads.bodies.other.actions.has(actionId)
              ? "other"
              : "unattributed")
        ];
        bucket.attempts += held.attempts;
        bucket.proxyAccesses += held.proxyAccesses;
        bucket.linkResolutions += held.linkResolutions;
      }
      attemptsByAction.clear();
    },
  };
}

//
// Reading outputs back
//

/** One pivot entry, with its topics named by topic index. */
export interface PivotEntry {
  /** The row document the entry links to. */
  readonly row: string;

  /** The topic the row describes. */
  readonly topic: number;

  /** The topics the row says mention it, in the row's order. */
  readonly mentionedBy: readonly number[];
}

/**
 * Returns the topic index of each element of `list`, a list of links to the
 * seeded topic documents, and `-1` for an element that names none of them.
 */
export function topicIndicesOf(
  seeded: SeededTopicsFixture,
  list: Cell<unknown[]>,
): number[] {
  const ids = seeded.topics.map(documentIdOf);
  const length = list.get()?.length ?? 0;
  return Array.from(
    { length },
    (_, position) => ids.indexOf(documentIdOf(list.key(position))),
  );
}

/** Returns each entry of the board's pivot, in the pivot's order. */
export function pivotEntriesOf(
  seeded: SeededTopicsFixture,
  table: Cell<PivotRow[]>,
): PivotEntry[] {
  const ids = seeded.topics.map(documentIdOf);
  const length = table.get()?.length ?? 0;
  return Array.from({ length }, (_, position) => {
    const entry = table.key(position);
    return {
      row: documentIdOf(entry),
      topic: ids.indexOf(documentIdOf(entry.key("topic"))),
      mentionedBy: topicIndicesOf(seeded, entry.key("mentionedBy")),
    };
  });
}

/** Helper for the readers above, which returns the document a cell resolves to. */
function documentIdOf(cell: Cell<unknown>): string {
  return cell.resolveAsCell().getAsNormalizedFullLink().id;
}

//
// Expected outputs
//
// Computed from fixture data alone, outside any runtime, for checking what the
// reached lifts return.
//

/**
 * Returns the index of each topic on the board, other than `topic` itself,
 * whose mention list names `topic`: once each, in the order of each one's first
 * board entry.
 */
export function mentionersOf(fixture: TopicsFixture, topic: number): number[] {
  return [...new Set(fixture.board)].filter((source) =>
    source !== topic && fixture.topics[source].mentions.includes(topic)
  );
}

/** Returns how many of `topic`'s comments carry no retraction stamp. */
export function presentCommentCount(topic: FixtureTopic): number {
  return topic.comments.filter((comment) => comment.removedAt === undefined)
    .length;
}

/**
 * Returns the latest stamp anywhere on `topic`, edit and retraction stamps
 * included.
 */
export function latestStamp(topic: FixtureTopic): number {
  let latest = Math.max(
    topic.createdAt,
    topic.bodyUpdatedAt,
    topic.titleUpdatedAt,
  );
  for (const comment of topic.comments) {
    latest = Math.max(
      latest,
      comment.sentAt,
      comment.editedAt ?? 0,
      comment.removedAt ?? 0,
    );
  }
  for (const link of topic.links) {
    latest = Math.max(latest, link.addedAt ?? 0, link.removedAt ?? 0);
  }
  return latest;
}
