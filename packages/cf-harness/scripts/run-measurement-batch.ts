#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * Run a list of console tasks unattended and write the measurement report.
 *
 * One task per session, one at a time. A fresh session per task is what the
 * measurement rests on — a session that has already searched the index is not
 * a session discovering it — and running them in sequence is what makes an
 * index change attributable to the task that caused it.
 *
 * Nothing here waits on a clock. A completed or failed turn settles on the
 * console's own `turn_completed` or `turn_failed` event, read off the
 * server-sent event stream. A canceled turn does not: the service emits
 * `turn_canceled` while the prompt loop is still unwinding, so the batch holds
 * that outcome and settles it on the session's own `status_changed` back to
 * idle, once the run's artifacts are on disk. A turn that never ends is a
 * batch that never ends, which is a hang an operator can see and cancel rather
 * than a bound that turns a slow run into a failed one.
 *
 * [The measurement protocol](../docs/pattern-index-measurement.md) is what
 * says which tasks belong in a suite and how they must be worded. Read it
 * before writing one: **a task must not mention the pattern index.** A task
 * that says "search the index for a counter" measures obedience rather than
 * discovery, and the finding this instrument exists to produce evaporates.
 *
 * Usage:
 *   deno task measure-batch suite.json
 *   deno task measure-batch suite.json --console=http://127.0.0.1:8103
 *   deno task measure-batch suite.json --out=./measurements/tonight
 *   deno task measure-batch suite.json --fabric-api-url=http://localhost:8040
 *   deno task measure-batch suite.json --expect-git-sha=<sha>
 *   deno task measure-batch suite.json --cell-spec=./cell.json
 *   deno task measure-batch suite.json --allow-diverged
 *
 * `--cell-spec` is what refuses a misconfigured console before the first task
 * spends anything: the file states the tools, subagent profiles, system
 * prompt, space and stores this experiment requires, and the batch checks them
 * against what the console says a session here would run under.
 */

import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs";
import { isAbsolute, join } from "@std/path";

import { debugStr } from "@commonfabric/data-model";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import type { ConsolePolicyReport } from "../console/policy.ts";
import type {
  HarnessChatEventEnvelope,
  HarnessChatSessionStatus,
} from "../src/contracts/interactive-chat.ts";
import {
  type CellSpec,
  type CellSpecPreflight,
  checkCellSpec,
  describeCellSpecMismatches,
  parseCellSpec,
} from "./cell-spec.ts";
import {
  foldTotals,
  measureRunFamily,
  renderRunLines,
  renderTotalsLines,
  type RunFamilyMeasurement,
} from "./measure-runs.ts";

const CHAT_SSE_EVENT = "chat";
const DEFAULT_CONSOLE_URL = "http://127.0.0.1:8100";
const DEFAULT_FABRIC_API_URL = "http://localhost:8000";

/**
 * What the pre-flight asks the index. Deliberately ordinary and unrelated to
 * any suite task: the question is whether the index answers this identity, not
 * what it holds, and an answer of no results passes.
 */
const PREFLIGHT_QUERY = "pattern";

/**
 * The events that close a turn, and what each one settles.
 *
 * `turn_completed` and `turn_failed` are emitted after the turn's store commit,
 * so the run behind one is on disk when it arrives. `turn_canceled` is not: the
 * service emits it the moment it aborts the turn, while the prompt loop is
 * still unwinding, and the run's artifacts land afterwards. So a cancel is
 * settled by the session's own `status_changed` back to idle, which the
 * service emits from the finalizer once the turn has actually stopped.
 *
 * That distinction matters because cancel is the documented way to release a
 * hung batch. Measuring on the cancel event alone would read whatever half of
 * the run had reached disk and report it as the run.
 */
const SETTLED_TERMINAL_EVENT_KINDS: ReadonlySet<string> = new Set([
  "turn_completed",
  "turn_failed",
]);

const CANCEL_EVENT_KIND = "turn_canceled";

/**
 * What went wrong, as a line for a report.
 *
 * One helper rather than the same ternary at every catch: a thrown value is
 * not always an `Error`, and a reader of a report should not be able to tell
 * which catch site produced a reading from how the message is shaped.
 */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** One task of a suite: an identifier to file it under, and its exact text. */
export interface MeasurementTask {
  id: string;
  text: string;
}

/** A suite of tasks, as a suite file holds it. */
export interface MeasurementSuite {
  label: string;
  notes?: string;
  tasks: readonly MeasurementTask[];

  /**
   * Patterns seeded into the index for this batch to find.
   *
   * A composition of one of these is a different claim from a composition of
   * an entry an earlier run happened to leave behind: the first says the loop
   * composes *what was seeded*, which is what seeding was for, and the second
   * only says the loop composes. Naming them here makes the report mark which
   * is which rather than leaving a reader to recognize identifiers by eye.
   */
  seededPatternIds?: readonly string[];

  /**
   * Seeded patterns superseded by a later publication of the same atom.
   *
   * Re-formatting a seed's source changes the bytes and so changes the
   * identity, which publishes a second entry for the same program. Both are
   * the seeder's work, so neither is pre-existing — but only one is
   * reproducible from the committed source, and a session that composed the
   * other composed a version the repository cannot rebuild. Marked apart for
   * that reason, not counted against the seeding.
   */
  supersededPatternIds?: readonly string[];

  /**
   * Why each superseded seed was superseded, keyed by identifier.
   *
   * Not every supersession is the same finding. A seed replaced because a
   * formatter rewrote its bytes is behaviourally identical to its replacement
   * and merely unreproducible from the committed source; a seed replaced
   * because a defect was fixed in it is a program that is known to be wrong.
   * A session composing one of each has done two different things, and a
   * single "superseded" mark would report them as one.
   */
  supersededReasons?: Readonly<Record<string, string>>;
}

/**
 * Reads a suite file's contents, or says what is wrong with it.
 *
 * A suite is validated whole before the first task runs. A batch that fails on
 * its fourth task at two in the morning because an entry had no `text` has
 * spent three runs to find out something readable up front.
 */
export const parseMeasurementSuite = (input: unknown): MeasurementSuite => {
  if (!isObjectOrArray(input)) {
    throw new Error("a task suite must be a JSON object");
  }
  const {
    label,
    notes,
    tasks,
    seededPatternIds,
    supersededPatternIds,
    supersededReasons,
  } = input as Record<string, unknown>;
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error("a task suite must carry a non-empty label");
  }
  if (notes !== undefined && typeof notes !== "string") {
    throw new Error("a task suite's notes must be a string");
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("a task suite must carry at least one task");
  }
  for (
    const [field, value] of [
      ["seededPatternIds", seededPatternIds],
      ["supersededPatternIds", supersededPatternIds],
    ] as const
  ) {
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((id) => typeof id !== "string"))
    ) {
      throw new Error(`a task suite's ${field} must be a list of strings`);
    }
  }
  // Provenance must not depend on which branch a classifier happens to test
  // first. An identifier in both lists is a suite that has not decided what it
  // is claiming, and taking the seeded branch would silently drop the
  // superseded reading — the misattribution the third category exists to stop.
  const bothLists = ((seededPatternIds ?? []) as readonly string[]).filter(
    (id) => ((supersededPatternIds ?? []) as readonly string[]).includes(id),
  );
  const declaredSuperseded = new Set(
    (supersededPatternIds ?? []) as readonly string[],
  );
  if (supersededReasons !== undefined) {
    if (!isObjectNotArray(supersededReasons)) {
      throw new Error("a task suite's supersededReasons must be a JSON object");
    }
    for (const [id, reason] of Object.entries(supersededReasons)) {
      if (typeof reason !== "string") {
        throw new Error(`a task suite's reason for ${id} must be a string`);
      }
      if (!declaredSuperseded.has(id)) {
        // A reason for an identifier the suite does not call superseded is a
        // claim about something the report will never mark, so it is a suite
        // that does not say what it means rather than a harmless extra.
        throw new Error(
          `a task suite gives a supersession reason for ${id}, which it does not name as superseded`,
        );
      }
    }
  }
  if (bothLists.length > 0) {
    throw new Error(
      `a task suite names ${
        bothLists.join(", ")
      } as both seeded and superseded; an identifier is one or the other`,
    );
  }
  const seen = new Set<string>();
  const parsed = tasks.map((task, index) => {
    if (!isObjectOrArray(task)) {
      throw new Error(`task ${index} is not a JSON object`);
    }
    const { id, text } = task as Record<string, unknown>;
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`task ${index} carries no id`);
    }
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error(`task ${id} carries no text`);
    }
    if (seen.has(id)) {
      throw new Error(`two tasks share the id ${id}`);
    }
    seen.add(id);
    return { id, text };
  });
  return {
    label,
    ...(notes !== undefined ? { notes } : {}),
    tasks: parsed,
    ...(seededPatternIds !== undefined
      ? { seededPatternIds: seededPatternIds as readonly string[] }
      : {}),
    ...(supersededPatternIds !== undefined
      ? { supersededPatternIds: supersededPatternIds as readonly string[] }
      : {}),
    ...(supersededReasons !== undefined
      ? {
        supersededReasons: supersededReasons as Readonly<
          Record<string, string>
        >,
      }
      : {}),
  };
};

/** One frame off a server-sent event stream. */
export interface SseFrame {
  /** The `event:` name, or `undefined` for a comment frame. */
  event?: string;

  data: string;
  id?: number;
}

const decodeSseFrame = (block: string): SseFrame | undefined => {
  let event: string | undefined;
  let id: number | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).trimStart();
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = Number(value);
  }
  if (event === undefined && data.length === 0) return undefined;
  return {
    ...(event !== undefined ? { event } : {}),
    data: data.join("\n"),
    ...(id !== undefined && Number.isSafeInteger(id) ? { id } : {}),
  };
};

/**
 * The frames of a server-sent event stream, in order.
 *
 * A comment-only block — the `: connected` the console opens every stream with
 * — yields nothing, so a caller counting frames counts what the server said
 * rather than the fact that it answered at all.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = decodeSseFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frame !== undefined) yield frame;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // Cancelling rather than releasing the lock is what tears the connection
    // down when the consumer stops reading part way, which is the ordinary
    // case here: the terminal envelope arrives and nothing after it is wanted.
    await reader.cancel().catch(() => {});
  }
}

/**
 * What the fabric server reports about itself.
 *
 * Recorded on every report and never differenced against the console's own
 * posture line. The two describe different runtimes: `cfcFlowLabels` is
 * core-default off and the `MAX_ENFORCEMENT_CFC_OPTIONS` bundle is applied by
 * the `remoteClient` and `browserWorker` presets, which is what cf-harness's
 * fabric session is, while the toolshed runs a production-server preset. So
 * the server reporting a dial off while the console prints an enforcing
 * posture is the design rather than a contradiction, and a check that refused
 * on the difference would fail every correctly configured night. Two facts,
 * each labeled with whose it is.
 */
export interface ServerMeta {
  gitSha?: string;
  cfc?: Readonly<Record<string, unknown>>;
  experimentalFlags?: Readonly<Record<string, unknown>>;
}

/** Whether the server's commit is on the branch the measurement assumes. */
export type AncestryReading =
  | { kind: "ancestor"; base: string }
  | { kind: "diverged"; base: string }
  | { kind: "unchecked"; reason: string };

/**
 * What the server said it was running, taken before the first task.
 *
 * A known-diverged commit refuses unless the operator explicitly allows it.
 * An unchecked ancestry remains a reading because not knowing differs from
 * knowing the server is wrong.
 */
export type PosturePreflight =
  | { kind: "read"; meta: ServerMeta; ancestry: AncestryReading }
  | {
    kind: "refused";
    reason: string;
    meta?: ServerMeta;
    ancestry?: AncestryReading;
  };

/**
 * Whether the index answered a search at all, taken before the first task.
 *
 * An index that refuses every query answers a run exactly as an empty index
 * does: the run searches, gets nothing, and writes its own pattern. A whole
 * phase-2 run family did this against `403: DID is not allowlisted` and
 * recorded as an empty corpus, which nobody noticed. Unattended, that is six
 * runs of plausible-looking evidence for a discovery problem that is an
 * authorization problem, so the batch refuses to start rather than producing
 * it. A refusal here names the status; it is not retried and not warned past.
 */
export type IndexPreflight =
  | { kind: "answered"; results: number; candidates?: number }
  | { kind: "refused"; reason: string };

/** Whether the console exposes the fields the batch reads before any task. */
export type ConsolePreflight =
  | { kind: "ready"; artifactRoot: string }
  | { kind: "refused"; reason: string };

/**
 * Reads the fabric server's own report of what it is running.
 *
 * `/api/meta` is unauthenticated and outside the console, so this is read
 * directly rather than through the console's index proxy — the console cannot
 * answer for a server it merely talks to.
 */
export const readServerMeta = async (
  fabricApiUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ServerMeta | { error: string }> => {
  try {
    const response = await fetchImpl(
      `${fabricApiUrl.replace(/\/$/, "")}/api/meta`,
    );
    if (!response.ok) {
      await response.body?.cancel();
      return { error: `/api/meta answered ${response.status}` };
    }
    const body = await response.json() as Record<string, unknown>;
    return {
      ...(typeof body.gitSha === "string" ? { gitSha: body.gitSha } : {}),
      ...(isObjectOrArray(body.cfc)
        ? { cfc: body.cfc as Record<string, unknown> }
        : {}),
      ...(isObjectOrArray(body.experimentalFlags)
        ? {
          experimentalFlags: body.experimentalFlags as Record<string, unknown>,
        }
        : {}),
    };
  } catch (error) {
    return {
      error: `the fabric server at ${fabricApiUrl} could not be reached: ${
        describeError(error)
      }`,
    };
  }
};

/**
 * Whether the server's commit is on `base`, asked of the local repository.
 *
 * A commit the local clone does not hold is reported unchecked rather than
 * diverged: not knowing a commit and knowing it is off the branch are
 * different readings, and only one of them is a fault in the server.
 */
export const readAncestry = async (
  gitSha: string | undefined,
  base: string,
  run: (
    args: readonly string[],
  ) => Promise<{ success: boolean; code: number }> = defaultGitRun,
): Promise<AncestryReading> => {
  if (gitSha === undefined) {
    return { kind: "unchecked", reason: "the server reported no gitSha" };
  }
  try {
    const known = await run(["cat-file", "-e", `${gitSha}^{commit}`]);
    if (!known.success) {
      return {
        kind: "unchecked",
        reason:
          `this clone does not hold ${gitSha}, so whether it is on ${base} cannot be decided here`,
      };
    }
    const ancestor = await run(["merge-base", "--is-ancestor", gitSha, base]);
    if (ancestor.success) return { kind: "ancestor", base };
    // Exit 1 is the answer "not an ancestor". Any other nonzero code is git
    // failing to answer at all — an unknown base, a broken repository — and
    // reporting that as `diverged` would assert something about the server's
    // commit that nothing established.
    return ancestor.code === 1 ? { kind: "diverged", base } : {
      kind: "unchecked",
      reason:
        `git could not compare ${gitSha} with ${base}: it exited ${ancestor.code}`,
    };
  } catch (error) {
    // A git that cannot be run at all is an unchecked reading, not a batch
    // that stops: whether the server's commit is on the branch is context for
    // the report rather than a condition the batch depends on.
    return {
      kind: "unchecked",
      reason: `git could not be run here: ${describeError(error)}`,
    };
  }
};

/**
 * Runs one `git` command, reporting only whether it succeeded.
 *
 * A `git` that cannot be run at all throws, and {@link readAncestry} turns
 * that into an unchecked reading. Swallowing it here as well would make "git
 * is missing" indistinguishable from "this clone does not hold that commit",
 * which are different things to tell a reader.
 */
const defaultGitRun = async (
  args: readonly string[],
): Promise<{ success: boolean; code: number }> => {
  const output = await new Deno.Command("git", {
    args: [...args],
    stdout: "null",
    stderr: "null",
  }).output();
  return { success: output.success, code: output.code };
};

/**
 * Reads what the server is running. An expected-commit mismatch always
 * refuses; a known-diverged commit refuses unless explicitly allowed.
 */
export const preflightPosture = async (
  fabricApiUrl: string,
  base: string,
  expectGitSha?: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  run: (
    args: readonly string[],
  ) => Promise<{ success: boolean; code: number }> = defaultGitRun,
  allowDiverged = false,
): Promise<PosturePreflight> => {
  const meta = await readServerMeta(fabricApiUrl, fetchImpl);
  if ("error" in meta) return { kind: "refused", reason: meta.error };
  if (expectGitSha !== undefined && meta.gitSha !== expectGitSha) {
    return {
      kind: "refused",
      reason:
        `this batch was told to expect the fabric server on ${expectGitSha}, and it reports ${
          meta.gitSha ?? "no commit at all"
        }. It is not running the code this measurement would report on.`,
      meta,
    };
  }
  const ancestry = await readAncestry(meta.gitSha, base, run);
  if (ancestry.kind === "diverged" && !allowDiverged) {
    return {
      kind: "refused",
      reason: `the fabric server reports ${
        meta.gitSha ?? "no commit"
      }, which is off ${base}; pass --allow-diverged only when that mismatch is intentional`,
      meta,
      ancestry,
    };
  }
  return { kind: "read", meta, ancestry };
};

/**
 * Where a composed pattern came from, one dependency hop deep.
 *
 * A bare re-export of a seeded atom is a different pattern with a different
 * identifier, so it would read as pre-existing while being seeded work at one
 * hop — and the current corpus holds exactly that shape, outranking the entry
 * it re-exports. Resolving each imported pattern's own `dependencies` once
 * closes it. Anything that could not be resolved says so rather than falling
 * to `pre-existing`, which would count a composition of seeded work as
 * evidence against the seeding.
 */
export type ImportedPatternOrigin =
  | { kind: "seeded" }
  | { kind: "seeded-superseded" }
  | {
    kind: "seeded-via-alias";

    /** Seeded patterns this one depends on. */
    through: readonly string[];

    /**
     * Superseded seeds it depends on. Kept apart from `through` because an
     * alias of a superseded copy inherits the fact that the committed source
     * cannot rebuild it, and folding the two loses exactly that.
     */
    throughSuperseded: readonly string[];
  }
  | { kind: "pre-existing" }
  | { kind: "unresolved"; reason: string };

/** Where one imported pattern came from, given what the index says it needs. */
export const classifyImportedPattern = (
  patternId: string,
  seeded: ReadonlySet<string>,
  superseded: ReadonlySet<string>,
  dependencies: readonly string[] | undefined,
): ImportedPatternOrigin => {
  if (seeded.has(patternId)) return { kind: "seeded" };
  if (superseded.has(patternId)) return { kind: "seeded-superseded" };
  if (dependencies === undefined) {
    return {
      kind: "unresolved",
      reason: "the index did not say what this pattern depends on",
    };
  }
  const through = dependencies.filter((dependency) => seeded.has(dependency));
  const throughSuperseded = dependencies.filter((dependency) =>
    superseded.has(dependency)
  );
  return through.length > 0 || throughSuperseded.length > 0
    ? { kind: "seeded-via-alias", through, throughSuperseded }
    : { kind: "pre-existing" };
};

/** What the console answered a started task with. */
export interface StartedTask {
  sessionId: string;
  turnId: string;
}

/** How a turn ended, or why nobody can say. */
export type TurnOutcome =
  | { kind: "turn_completed" | "turn_failed" | "turn_canceled"; detail: string }
  | { kind: "unwitnessed"; reason: string };

/**
 * The field a `listPatterns` row carries to say whether the index offers that
 * entry in search results. Recording a pattern and surfacing it are separate —
 * an entry can be published and withheld, and `getPattern` serves it either
 * way — so a report that treats the two as one misreads the corpus.
 *
 * An entry published before the field existed carries nothing here, and that
 * reads as unknown rather than as findable.
 */
const DISCOVERABILITY_FIELD = "discoverable";

/** One pattern as the index lists it. */
export interface IndexedPattern {
  patternId: string;
  description: string;
  score: number;
  events: Readonly<Record<string, number>>;

  /** Whether the index offers this entry in search results, if it says. */
  discoverable?: boolean;
}

/** What the index held at one moment, or why it could not be read. */
export type IndexSnapshot =
  | {
    kind: "read";
    patterns: readonly IndexedPattern[];

    /**
     * Entries the index holds and left out of this listing, as it counted
     * them. A listing asks for the discoverable entries by default, so this
     * is the rest of the corpus — recorded, resolvable by specifier, and not
     * offered to a searching run.
     */
    nonDiscoverableCount?: number;
  }
  | { kind: "unread"; reason: string };

/** What changed in the index between two snapshots. */
export interface IndexChange {
  added: readonly IndexedPattern[];
  removed: readonly IndexedPattern[];
  rescored: readonly { patternId: string; before: number; after: number }[];
}

/**
 * The difference between two index snapshots, or `undefined` when either end
 * was not read. A diff against a reading nobody took is not a small diff, it
 * is no diff, and reporting it as "nothing changed" would be a lie.
 */
export const indexChangeOf = (
  before: IndexSnapshot,
  after: IndexSnapshot,
): IndexChange | undefined => {
  if (before.kind === "unread" || after.kind === "unread") return undefined;
  const beforeById = new Map(
    before.patterns.map((pattern) => [pattern.patternId, pattern]),
  );
  const afterById = new Map(
    after.patterns.map((pattern) => [pattern.patternId, pattern]),
  );
  const rescored: { patternId: string; before: number; after: number }[] = [];
  for (const [patternId, entry] of afterById) {
    const previous = beforeById.get(patternId);
    if (previous !== undefined && previous.score !== entry.score) {
      rescored.push({
        patternId,
        before: previous.score,
        after: entry.score,
      });
    }
  }
  return {
    added: after.patterns.filter((pattern) =>
      !beforeById.has(pattern.patternId)
    ),
    removed: before.patterns.filter((pattern) =>
      !afterById.has(pattern.patternId)
    ),
    rescored,
  };
};

const indexSnapshotOf = (answer: unknown): IndexSnapshot => {
  if (!isObjectOrArray(answer)) {
    return { kind: "unread", reason: "the index answered with no object" };
  }
  const patterns = (answer as Record<string, unknown>).patterns;
  if (!Array.isArray(patterns)) {
    return {
      kind: "unread",
      reason: "the index answered with no pattern list",
    };
  }
  return {
    kind: "read",
    patterns: patterns.map((entry) => {
      const pattern = entry as Record<string, unknown>;
      const discoverable = pattern[DISCOVERABILITY_FIELD];
      return {
        patternId: String(pattern.patternId ?? "(unnamed)"),
        description: String(pattern.description ?? ""),
        score: typeof pattern.score === "number" ? pattern.score : Number.NaN,
        events: isObjectOrArray(pattern.events)
          ? pattern.events as Record<string, number>
          : {},
        ...(typeof discoverable === "boolean" ? { discoverable } : {}),
      };
    }),
    ...(typeof (answer as Record<string, unknown>).nonDiscoverableCount ===
        "number"
      ? {
        nonDiscoverableCount:
          (answer as Record<string, number>).nonDiscoverableCount,
      }
      : {}),
  };
};

/**
 * One console server, driven the way its own page drives it.
 *
 * `/api` carries no credential, so opening one is a liveness question rather
 * than a handshake: `open` asks health, which is the cheapest answer that
 * distinguishes a console from nothing listening.
 */
export class ConsoleClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  /**
   * The sequence of the newest envelope this client has read. Every stream it
   * opens resumes from here, so an envelope emitted between one read and the
   * next arrives in the next stream's backfill rather than being missed.
   */
  #sequence = 0;

  private constructor(
    baseUrl: string,
    fetchImpl: typeof globalThis.fetch,
  ) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#fetch = fetchImpl;
  }

  static async open(
    baseUrl: string,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<ConsoleClient> {
    const url = baseUrl.replace(/\/$/, "");
    const response = await fetchImpl(`${url}/api/health`);
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(
        `${url}/api/health answered ${response.status}; is a console server listening there?`,
      );
    }
    return new ConsoleClient(url, fetchImpl);
  }

  async #json(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${path} answered ${response.status}: ${text}`);
    }
    return JSON.parse(text);
  }

  /** Starts one task in a new session. */
  async startTask(text: string): Promise<StartedTask> {
    const answer = await this.#json("/api/task", {
      method: "POST",
      body: JSON.stringify({ text }),
    }) as Record<string, unknown>;
    if (
      typeof answer.sessionId !== "string" || typeof answer.turnId !== "string"
    ) {
      throw new Error(
        `/api/task answered without a session and turn: ${
          JSON.stringify(answer)
        }`,
      );
    }
    return { sessionId: answer.sessionId, turnId: answer.turnId };
  }

  /** One session's status, or `undefined` for a session it does not know. */
  async session(
    sessionId: string,
  ): Promise<HarnessChatSessionStatus | undefined> {
    const answer = await this.#json(
      `/api/status?sessionId=${encodeURIComponent(sessionId)}`,
    ) as { sessions?: readonly HarnessChatSessionStatus[] };
    return answer.sessions?.[0];
  }

  /** Checks the status response fields the batch reads before starting work. */
  async preflightStatus(): Promise<ConsolePreflight> {
    let answer: unknown;
    try {
      answer = await this.#json("/api/status");
    } catch (error) {
      return {
        kind: "refused",
        reason: `/api/status could not be read: ${describeError(error)}`,
      };
    }
    if (!isObjectOrArray(answer)) {
      return {
        kind: "refused",
        reason: "/api/status did not return a JSON object",
      };
    }
    const { artifactRoot, sessions } = answer as Record<string, unknown>;
    if (typeof artifactRoot !== "string") {
      return {
        kind: "refused",
        reason: "/api/status is missing the top-level artifactRoot field",
      };
    }
    if (!isAbsolute(artifactRoot)) {
      return {
        kind: "refused",
        reason:
          `/api/status returned a non-absolute artifactRoot: ${artifactRoot}`,
      };
    }
    if (!Array.isArray(sessions)) {
      return {
        kind: "refused",
        reason: "/api/status is missing the top-level sessions array",
      };
    }
    return { kind: "ready", artifactRoot };
  }

  /**
   * What a new session here would run under, or why nobody can say.
   *
   * `/api/status` carries a session's policy and can only describe sessions
   * that exist, so it cannot answer this before the first task — which is the
   * only place the answer is worth anything.
   */
  async policy(): Promise<ConsolePolicyReport | { error: string }> {
    let answer: unknown;
    try {
      answer = await this.#json("/api/policy");
    } catch (error) {
      return {
        error: `/api/policy could not be read: ${describeError(error)}`,
      };
    }
    if (!isObjectOrArray(answer)) {
      return { error: "/api/policy did not return a JSON object" };
    }
    // Every field is required, and the two nullable ones have to arrive as an
    // explicit `null`. Reading a field the console never sent as "it has none"
    // would pass a spec asserting `null` against a console that disclosed
    // nothing, which is the vacuous check this pre-flight exists to remove.
    const report = answer as Record<string, unknown>;
    for (const field of ["allowedToolIds", "allowedSubagentProfiles"]) {
      const value = report[field];
      if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string")
      ) {
        return {
          error: `/api/policy did not report ${field} as a list of strings`,
        };
      }
    }
    for (const field of ["fabricSpace", "artifactRoot"]) {
      if (typeof report[field] !== "string") {
        return { error: `/api/policy did not report ${field} as a string` };
      }
    }
    for (const field of ["systemPromptSha256", "sessionDbPath"]) {
      if (report[field] !== null && typeof report[field] !== "string") {
        return {
          error:
            `/api/policy did not report ${field} as a string or null, so this console said nothing about it`,
        };
      }
    }
    return {
      systemPromptSha256: report.systemPromptSha256 as string | null,
      allowedToolIds: report.allowedToolIds as readonly string[],
      allowedSubagentProfiles: report
        .allowedSubagentProfiles as readonly string[],
      fabricSpace: report.fabricSpace as string,
      artifactRoot: report.artifactRoot as string,
      sessionDbPath: report.sessionDbPath as string | null,
    };
  }

  /** What the index holds, read through the console's own signed proxy. */
  async indexSnapshot(): Promise<IndexSnapshot> {
    try {
      return indexSnapshotOf(
        await this.#json("/api/index/call", {
          method: "POST",
          body: JSON.stringify({ fn: "listPatterns", body: {} }),
        }),
      );
    } catch (error) {
      return {
        kind: "unread",
        reason: describeError(error),
      };
    }
  }

  /**
   * Asks the index one search, to establish that it answers this identity at
   * all before a night of runs rests on what it says.
   *
   * Any well-formed answer passes, an empty result included: "the index
   * answered and held nothing matching" is a real reading and a legitimate
   * state to measure. What fails is an index that did not answer — a refusal,
   * an unreachable host, a console started without one — and a body carrying
   * no results array, which is an answer this reader cannot count.
   */
  async preflightIndex(text: string): Promise<IndexPreflight> {
    let answer: unknown;
    try {
      answer = await this.#json("/api/index/call", {
        method: "POST",
        body: JSON.stringify({ fn: "searchPatterns", body: { text } }),
      });
    } catch (error) {
      return {
        kind: "refused",
        reason: describeError(error),
      };
    }
    const results = (answer as Record<string, unknown>)?.results;
    if (!Array.isArray(results)) {
      return {
        kind: "refused",
        reason:
          debugStr`the index answered with no results array: $quote,long${answer}`,
      };
    }
    const candidates = (answer as Record<string, unknown>).candidates;
    return {
      kind: "answered",
      results: results.length,
      ...(typeof candidates === "number" ? { candidates } : {}),
    };
  }

  /**
   * Whether the index offers one named pattern in search results, or
   * `undefined` when it would not say.
   *
   * `listPatterns` leaves a withheld entry out of its listing entirely, so a
   * report built from that listing cannot tell a withheld entry from one that
   * was never published. Asking for the entry by name is the only way to say
   * which.
   */
  async patternDiscoverable(patternId: string): Promise<boolean | undefined> {
    const pattern = await this.#pattern(patternId);
    return typeof pattern?.discoverable === "boolean"
      ? pattern.discoverable
      : undefined;
  }

  async #pattern(
    patternId: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const answer = await this.#json("/api/index/call", {
        method: "POST",
        body: JSON.stringify({ fn: "getPattern", body: { patternId } }),
      }) as Record<string, unknown>;
      return (answer.pattern ?? answer) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  /**
   * What the index says one pattern depends on, or `undefined` when it would
   * not say. `getPattern` is called without source, exactly as the console's
   * own proxy always calls it.
   */
  async dependenciesOf(
    patternId: string,
  ): Promise<readonly string[] | undefined> {
    const pattern = await this.#pattern(patternId);
    return Array.isArray(pattern?.dependencies)
      ? pattern.dependencies.filter((entry): entry is string =>
        typeof entry === "string"
      )
      : undefined;
  }

  /**
   * Waits for the turn to end, and returns how it ended.
   *
   * The stream is opened after the turn is started rather than before, which
   * is safe because the console backfills every envelope past the sequence the
   * request names: an envelope emitted in the gap arrives in the backfill.
   *
   * A stream that ends or faults before the turn does is reopened, and what
   * bounds that is progress rather than a count or a clock. A reconnection
   * that reads no frame at all is a server that is not going to answer, and
   * the turn is reported unwitnessed. A server that is answering delivers
   * frames — its own liveness ticks if the turn itself is quiet — so a healthy
   * quiet turn is never mistaken for one. A fault is treated the same as an
   * end: an unattended batch that lost a socket should reopen it and carry on,
   * not abort the night with no report written.
   *
   * The stream is scoped to the session, so a console holding months of turns
   * does not replay all of them into the first read of a batch.
   */
  async awaitTurn(started: StartedTask): Promise<TurnOutcome> {
    let canceled: TurnOutcome | undefined;
    for (;;) {
      // Progress is the sequence advancing, not frames arriving. A reconnect
      // that replays envelopes this client has already seen delivers frames
      // and advances nothing, and counting those as progress reopens the
      // stream forever — the same defect as a stand-in that never stops
      // talking, on the client side of the same conversation.
      const sequenceBefore = this.#sequence;
      try {
        const response = await this.#fetch(
          `${this.#baseUrl}/api/events?sessionId=${
            encodeURIComponent(started.sessionId)
          }&afterSequence=${this.#sequence}`,
          { headers: { accept: "text/event-stream" } },
        );
        if (!response.ok || response.body === null) {
          return {
            kind: "unwitnessed",
            reason: `/api/events answered ${response.status}`,
          };
        }
        for await (const frame of readSseFrames(response.body)) {
          if (frame.event !== CHAT_SSE_EVENT) continue;
          const envelope = JSON.parse(frame.data) as HarnessChatEventEnvelope;
          this.#sequence = Math.max(this.#sequence, envelope.sequence);
          if (envelope.sessionId !== started.sessionId) continue;
          const event = envelope.event as { kind: string; turnId?: string };
          if (
            canceled !== undefined && event.kind === "status_changed" &&
            this.#isIdle(envelope)
          ) {
            return canceled;
          }
          if (event.turnId !== undefined && event.turnId !== started.turnId) {
            continue;
          }
          if (SETTLED_TERMINAL_EVENT_KINDS.has(event.kind)) {
            return {
              kind: event.kind as "turn_completed" | "turn_failed",
              detail: describeTerminalEvent(
                envelope.event as Parameters<typeof describeTerminalEvent>[0],
              ),
            };
          }
          if (event.kind === CANCEL_EVENT_KIND) {
            // Hold the outcome and keep reading: the run is not on disk yet.
            canceled = {
              kind: "turn_canceled",
              detail: describeTerminalEvent(
                envelope.event as Parameters<typeof describeTerminalEvent>[0],
              ),
            };
          }
        }
      } catch (error) {
        if (this.#sequence === sequenceBefore) {
          return {
            kind: "unwitnessed",
            reason:
              `the event stream faulted without advancing past ${sequenceBefore}: ${
                describeError(error)
              }`,
          };
        }
        continue;
      }
      if (this.#sequence === sequenceBefore) {
        return {
          kind: "unwitnessed",
          reason: canceled === undefined
            ? `the console closed the event stream without advancing past ${sequenceBefore}`
            : "the turn was canceled and the console never reported the session idle, so its run may be half written",
        };
      }
    }
  }

  /** Whether a `status_changed` envelope reports the session at rest. */
  #isIdle(envelope: HarnessChatEventEnvelope): boolean {
    const event = envelope.event as { session?: { activeTurnId?: string } };
    return event.session?.activeTurnId === undefined;
  }
}

/**
 * What a turn's closing event says for itself, for the three kinds that close
 * one. The parameter is narrowed to those three rather than accepting any
 * envelope with a fallback, because a fallback here would be a branch no call
 * can reach and no test can cover — which reads as untested code rather than
 * as the impossibility it is.
 */
const describeTerminalEvent = (
  event: Extract<
    HarnessChatEventEnvelope["event"],
    { kind: "turn_completed" | "turn_failed" | "turn_canceled" }
  >,
): string => {
  if (event.kind === "turn_completed") {
    return event.finalText ?? "(the turn completed with no final text)";
  }
  if (event.kind === "turn_failed") {
    return event.error.message ?? JSON.stringify(event.error);
  }
  return event.reason ?? "(canceled with no reason given)";
};

/**
 * What the console was configured with, as one session reports it. Two
 * batches are comparable only if these agree, so the report carries them
 * rather than leaving a reader to remember how the server was started.
 */
export interface SessionConfiguration {
  model?: string;
  cfcEnforcementMode?: string;

  /**
   * The skills tree the run scanned, read from the run's own
   * `skill-registry.json`. The console exposes the root over no route, and a
   * turn whose run carries no registry authors patterns without the authoring
   * guides — a misconfiguration that changes what the runs do for a reason
   * unrelated to the index, and that is invisible in every other artifact.
   */
  skillsRoot?: string;

  /** How many skills that scan found, from the same registry. */
  skillsFound?: number;

  /** Why the registry could not be read, when it could not be. */
  skillsUnread?: string;

  /**
   * Runs of this family that wrote no registry. A `delegate_task` child is
   * where authoring happens, so a parent that scanned a root while its
   * children did not is the shape that matters, and a parent-only reading
   * would report it as healthy.
   */
  runsWithoutSkillRegistry?: number;

  runsInFamily?: number;
}

/** What one task did, as the report records it. */
export interface TaskResult {
  task: MeasurementTask;
  sessionId: string;
  turnId: string;
  outcome: TurnOutcome;
  runId?: string;
  artifactRoot?: string;
  configuration: SessionConfiguration;
  measurement?: RunFamilyMeasurement;
  measurementUnread?: string;
}

/** The whole batch, as the report records it. */
export interface BatchResult {
  suite: MeasurementSuite;
  consoleUrl: string;
  indexUrl: string | null;
  startedAt: string;
  endedAt: string;
  consolePreflight: ConsolePreflight;
  cellSpec: CellSpecPreflight;
  preflight: IndexPreflight;
  posture: PosturePreflight;

  /** Where each pattern the batch composed came from, one hop deep. */
  importedPatternOrigins: Readonly<Record<string, ImportedPatternOrigin>>;

  /**
   * Whether each superseded seed was still offered in search when the batch
   * started, read entry by entry. A batch that ran while the superseded copies
   * were findable measured a different corpus from one that ran after they
   * were withheld, and the listing alone cannot say which: a withheld entry is
   * simply absent from it.
   */
  supersededVisibility?: Readonly<Record<string, boolean | undefined>>;

  indexBefore: IndexSnapshot;
  indexAfter: IndexSnapshot;
  results: readonly TaskResult[];
}

/**
 * What the run's skill registry says, or why it says nothing. A run that
 * scanned no skills root wrote no registry, and that is the reading to record
 * rather than an absent field nobody notices.
 */
const readSkillRegistry = async (
  runRoot: string,
): Promise<
  { skillsRoot?: string; skillsFound?: number; skillsUnread?: string }
> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await Deno.readTextFile(join(runRoot, "skill-registry.json")),
    );
  } catch (error) {
    return {
      skillsUnread: error instanceof Deno.errors.NotFound
        ? "the run wrote no skill-registry.json, so it scanned no skills root"
        : `skill-registry.json could not be read: ${describeError(error)}`,
    };
  }
  const registry = parsed as { skillsRoot?: unknown; skills?: unknown };
  if (typeof registry.skillsRoot !== "string") {
    return { skillsUnread: "skill-registry.json names no skills root" };
  }
  return {
    skillsRoot: registry.skillsRoot,
    skillsFound: Array.isArray(registry.skills) ? registry.skills.length : 0,
  };
};

/** The root run identified by the console's returned turn id. */
interface RunCandidate {
  runId: string;
}

/** Candidates found and in-scope artifacts the scan could not read. */
interface RunCandidateScan {
  candidates: readonly RunCandidate[];
  directories: readonly string[];
  unread: readonly string[];
}

/**
 * Finds the console turn's root artifact. The console assigns its turn id to
 * the harness run, so task text and transcript ordering play no part in this
 * join. Other turns may carry the same task or unreadable artifacts.
 */
const runCandidates = async (
  artifactRoot: string,
  turnId: string,
  batchStartedAt: string,
): Promise<RunCandidateScan> => {
  const candidates: RunCandidate[] = [];
  const directories: string[] = [];
  const unread: string[] = [];
  for await (const entry of Deno.readDir(artifactRoot)) {
    if (!entry.isDirectory) continue;
    directories.push(entry.name);
    if (entry.name !== turnId) continue;
    const runStatePath = join(artifactRoot, entry.name, "run-state.json");
    let runState: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await Deno.readTextFile(runStatePath));
      if (!isObjectNotArray(parsed)) {
        unread.push(`${entry.name}/run-state.json was not an object`);
        continue;
      }
      runState = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      unread.push(
        `${entry.name}/run-state.json could not be read: ${
          describeError(error)
        }`,
      );
      continue;
    }
    const createdAt = typeof runState.createdAt === "string"
      ? Date.parse(runState.createdAt)
      : Number.NaN;
    if (
      runState.runId !== entry.name ||
      !Number.isFinite(createdAt) ||
      createdAt < Date.parse(batchStartedAt) ||
      (runState.lineage as { role?: unknown } | undefined)?.role === "subagent"
    ) {
      continue;
    }
    candidates.push({ runId: entry.name });
  }
  return {
    candidates: candidates.sort((left, right) =>
      left.runId.localeCompare(right.runId)
    ),
    directories,
    unread,
  };
};

/** Fields the batch supplies to locate the run one task created. */
export interface RunTaskOptions {
  batchStartedAt: string;
  artifactRoot: string;
}

/**
 * Where each pattern the batch composed came from, resolved one hop through
 * the index. Called once per distinct identifier, after the tasks have run.
 */
export const resolveImportedPatternOrigins = async (
  client: ConsoleClient,
  importedPatternIds: readonly string[],
  seeded: readonly string[],
  superseded: readonly string[] = [],
): Promise<Readonly<Record<string, ImportedPatternOrigin>>> => {
  const isSeeded = new Set(seeded);
  const isSuperseded = new Set(superseded);
  const origins: Record<string, ImportedPatternOrigin> = {};
  for (const patternId of importedPatternIds) {
    const known = isSeeded.has(patternId) || isSuperseded.has(patternId);
    origins[patternId] = classifyImportedPattern(
      patternId,
      isSeeded,
      isSuperseded,
      known ? undefined : await client.dependenciesOf(patternId),
    );
  }
  return origins;
};

/**
 * Whether the console is the cell the batch was told to measure.
 *
 * A console that will not say what it runs under refuses the batch as surely
 * as one that says the wrong thing: a spec was named, and nothing here can
 * report it as satisfied.
 */
export const preflightCellSpec = async (
  client: ConsoleClient,
  spec: CellSpec | undefined,
): Promise<CellSpecPreflight> => {
  if (spec === undefined) return { kind: "unasked" };
  const policy = await client.policy();
  if ("error" in policy) {
    return {
      kind: "refused",
      reason:
        `this batch was given a cell spec, and the console would not say what a session here runs under: ${policy.error}`,
      spec,
    };
  }
  const mismatches = checkCellSpec(spec, policy);
  return mismatches.length === 0 ? { kind: "matched", spec, policy } : {
    kind: "refused",
    reason: describeCellSpecMismatches(mismatches),
    spec,
    mismatches,
  };
};

/** Whether each named pattern was findable, asked of the index by name. */
export const readSupersededVisibility = async (
  client: ConsoleClient,
  patternIds: readonly string[],
): Promise<Readonly<Record<string, boolean | undefined>>> => {
  const visibility: Record<string, boolean | undefined> = {};
  for (const patternId of patternIds) {
    visibility[patternId] = await client.patternDiscoverable(patternId);
  }
  return visibility;
};

/** Runs one task and measures the run it left behind. */
export const runTask = async (
  client: ConsoleClient,
  task: MeasurementTask,
  log: (line: string) => void,
  options: RunTaskOptions,
): Promise<TaskResult> => {
  log(`task ${task.id}: starting`);
  const started = await client.startTask(task.text);
  const outcome = await client.awaitTurn(started);
  log(`task ${task.id}: ${outcome.kind}`);
  const session = await client.session(started.sessionId);
  const artifactRoot = session?.artifactRoot ?? options.artifactRoot;
  const base = {
    task,
    sessionId: started.sessionId,
    turnId: started.turnId,
    outcome,
    artifactRoot,
    configuration: {
      ...(session?.model !== undefined ? { model: session.model } : {}),
      ...(session?.policy?.cfcEnforcementMode !== undefined
        ? { cfcEnforcementMode: session.policy.cfcEnforcementMode }
        : {}),
    },
  } satisfies Omit<TaskResult, "runId" | "measurement" | "measurementUnread">;
  let scan: RunCandidateScan;
  try {
    scan = await runCandidates(
      artifactRoot,
      started.turnId,
      options.batchStartedAt,
    );
  } catch (error) {
    return {
      ...base,
      measurementUnread: `the artifact root could not be listed: ${
        describeError(error)
      }`,
    };
  }
  if (scan.candidates.length !== 1 || scan.unread.length > 0) {
    const reason = scan.unread.length > 0
      ? `the run lookup could not read ${scan.unread.join("; ")}`
      : `no root run ${started.turnId} created after ${options.batchStartedAt} exists for this console turn`;
    return {
      ...base,
      configuration: {
        ...base.configuration,
        skillsUnread: "no run was selected, so no skill registry could be read",
      },
      measurementUnread: reason,
    };
  }
  const runId = scan.candidates[0].runId;
  const located = { ...base, runId };
  const members = scan.directories.filter((name) =>
    name === runId || name.startsWith(`${runId}.`)
  );
  const registries = await Promise.all(
    members.map((member) => readSkillRegistry(join(artifactRoot, member))),
  );
  const scanned = registries.filter((registry) =>
    registry.skillsRoot !== undefined
  );
  const configuration: SessionConfiguration = {
    ...located.configuration,
    ...(scanned[0] ?? {}),
    ...(scanned.length === 0
      ? { skillsUnread: registries[0]?.skillsUnread ?? "no run was read" }
      : {}),
    runsWithoutSkillRegistry: registries.length - scanned.length,
    runsInFamily: registries.length,
  };
  return {
    ...located,
    configuration,
    measurement: await measureRunFamily(artifactRoot, runId, members.sort()),
  };
};

const bullet = (lines: readonly string[]): string =>
  lines.length === 0
    ? "- none\n"
    : lines.map((line) => `- ${line}`).join("\n") +
      "\n";

const renderIndexSnapshot = (snapshot: IndexSnapshot): string =>
  snapshot.kind === "unread"
    ? `NOT READ — ${snapshot.reason}`
    : `${snapshot.patterns.length} patterns`;

/**
 * How much of the index is offered in search, when the index says.
 *
 * An index answer with no such field leaves this reading untaken, and it says
 * so: "every entry is findable" and "the answer does not carry the flag" are
 * different readings, and only the second is true of an answer that never
 * mentioned it.
 */
const renderDiscoverability = (snapshot: IndexSnapshot): string => {
  if (snapshot.kind === "unread") {
    return `NOT READ — ${snapshot.reason}\n`;
  }
  const flagged = snapshot.patterns.filter((pattern) =>
    pattern.discoverable !== undefined
  );
  if (flagged.length === 0) {
    return "NOT RECORDED — this index answer carries no discoverability " +
      "flag, so nothing here separates an entry that is recorded from one " +
      "that is offered in search results. Recording and surfacing are " +
      "separate, so do not read the count above as a count of what a run " +
      "could find.\n";
  }
  const findable = flagged.filter((pattern) => pattern.discoverable).length;
  const withheld = snapshot.nonDiscoverableCount;
  return `Read from each entry's \`${DISCOVERABILITY_FIELD}\` field: ${findable} of ${snapshot.patterns.length} listed entries are offered in search results, ${
    flagged.length - findable
  } are listed and withheld, and ${
    snapshot.patterns.length - flagged.length
  } carry no flag either way. ${
    withheld === undefined
      ? "The index did not say how many further entries it holds outside this listing."
      : `The index holds ${withheld} further entries it did not list, recorded and withheld from search.`
  }\n`;
};

const renderIndexChange = (change: IndexChange | undefined): string => {
  if (change === undefined) {
    return "NOT READ — one end of the comparison was never taken, so nothing " +
      "here says the index did or did not change.\n";
  }
  return [
    "Added during the batch:\n",
    bullet(
      change.added.map((pattern) =>
        `\`${pattern.patternId}\` (score ${pattern.score}) — ${pattern.description}`
      ),
    ),
    "\nRemoved during the batch:\n",
    bullet(change.removed.map((pattern) => `\`${pattern.patternId}\``)),
    "\nRescored during the batch:\n",
    bullet(
      change.rescored.map((entry) =>
        `\`${entry.patternId}\`: ${entry.before} → ${entry.after}`
      ),
    ),
  ].join("");
};

/**
 * The standing statement of what a batch report is evidence of.
 *
 * It is fixed text rather than a per-run judgement because the limit is a
 * property of the instrument, not of the night: this reads transcripts, and a
 * transcript records what a run did. No part of this opens a piece, so no
 * number below is a claim that anything the runs built works.
 */
export const REPORT_SCOPE = `## What this report does and does not show

It **counts what each run did**: the searches it issued and what the index
answered them with, whether it ran a published pattern by id or compiled
source of its own, which published patterns that source imported, how much it
delegated, and what it named at the end.

It **does not say whether what a run built works.** Nothing in this report
renders a piece or opens one in a browser. \`run_pattern\` reporting \`ok\`
means the pattern compiled and its result matched the schema it declared — a
pattern whose every cell renders as \`[object Object]\` reports \`ok\` and
publishes clean. Whether a published pattern works is CT-2107's subject, and a
count that is read as answering it is worse than no count at all.

It **does not establish why** a run did what it did. A search that found
nothing and a search the index refused are counted apart here for exactly that
reason: the second says nothing about the corpus.

It **does not say whether a run found what it asked for.** A search hit is a
hit against a *description*, and a description in this index is not reliably a
description of the program behind it: entries advertising a grocery checklist
and a reading list have turned out to be a counter and a program with no
interface at all. So a hit counted here is a hit, not a match.

It **does not read a bare re-export as composition.** Source that imports a
published pattern and exports it unchanged is counted apart from source that
puts one to work, because the index holds entries that are exactly that and
they would otherwise inflate the reading.

**These numbers are comparable to another batch's only if the index readings
above match.** The corpus changes underneath a measurement — entries are
seeded, archived, and rescored between runs — and a change in what the runs did
is as easily an effect of that as of anything in the harness.

A run this could not read is counted as not read, never as a run that did
nothing.
`;

/**
 * What the console was running under, as the sessions reported it.
 *
 * The skills root is deliberately named as not recorded rather than left out.
 * The console scans it before every turn and exposes it over no route, so a
 * batch run against a server started without one is a batch whose runs
 * authored without the authoring guides — a difference that would otherwise be
 * invisible in the report and indistinguishable from an index effect.
 */
const renderConfiguration = (
  results: readonly TaskResult[],
): readonly string[] => {
  const models = new Set(
    results.map((result) => result.configuration.model).filter((model) =>
      model !== undefined
    ),
  );
  const postures = new Set(
    results.map((result) => result.configuration.cfcEnforcementMode).filter((
      mode,
    ) => mode !== undefined),
  );
  const named = (values: ReadonlySet<string>): string =>
    values.size === 0
      ? "NOT RECORDED — no session reported one"
      : [...values].sort().join(", ");
  return [
    "## The console this ran against",
    "",
    `- Model: ${named(models)}`,
    `- CFC enforcement: ${named(postures)}`,
    `- Skills root: ${skillsRoot(results)}`,
    "",
  ];
};

/**
 * The skills tree the runs scanned, read from each run's own
 * `skill-registry.json` — the only place it is recorded, since the console
 * exposes the root over no route.
 *
 * A run that scanned none says so here rather than leaving the line blank: it
 * authored without the authoring guides, which changes what the runs did for a
 * reason that has nothing to do with the index. The reading covers the whole
 * run family, because a parent that scanned a root while its children did not
 * is the case that matters and a parent-only reading calls it healthy.
 */
const skillsRoot = (results: readonly TaskResult[]): string => {
  const roots = new Set(
    results.map((result) => result.configuration.skillsRoot).filter((
      root,
    ): root is string => root !== undefined),
  );
  const unread = results.filter((result) =>
    result.configuration.skillsRoot === undefined
  );
  const found = new Set(
    results.map((result) => result.configuration.skillsFound).filter((
      count,
    ): count is number => count !== undefined),
  );
  const scanned = roots.size === 0
    ? "NOT RECORDED"
    : `${[...roots].sort().join(", ")} (${
      [...found].sort((left, right) => left - right).join("/")
    } skills)`;
  return unread.length === 0
    ? scanned
    : `${scanned}; ${unread.length} of ${results.length} runs scanned none — ${
      unread[0].configuration.skillsUnread ?? "no reason recorded"
    }`;
};

const renderBlock = (
  block: Readonly<Record<string, unknown>> | undefined,
): string =>
  block === undefined ? "NOT REPORTED" : Object.entries(block)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .sort()
    .join(" ");

/**
 * What the fabric server said it was running.
 *
 * Reported as the **server's** reading, beside the console's as the console's,
 * and never differenced. The two describe different runtimes under different
 * presets, so a difference between them is ordinarily the design; a reader who
 * needs to compare them has both, and nothing here decides for them.
 */
const renderPosture = (posture: PosturePreflight): string => {
  const meta = posture.meta;
  const reading = posture.ancestry;
  const ancestry = reading === undefined
    ? "not reached"
    : reading.kind === "ancestor"
    ? `on ${reading.base}`
    : reading.kind === "diverged"
    ? `NOT on ${reading.base} — this server is not running the code on that branch`
    : `NOT CHECKED — ${reading.reason}`;
  const header = posture.kind === "refused"
    ? `**The fabric server did not satisfy the batch's commit contract, and the batch refused to start.** ${posture.reason}\n\nNothing below ran.`
    : "Read from the fabric server's own `/api/meta`. These are the **server's** dials, under its production-server preset; the console's line below is its own runtime's, under a remoteClient preset. The two are different runtimes and a difference between them is ordinarily the design, not a fault — they are recorded side by side and never differenced.";
  return `${header}\n\n- Server commit: ${
    meta?.gitSha ?? "NOT REPORTED"
  } (${ancestry})\n- Server CFC block: ${
    renderBlock(meta?.cfc)
  }\n- Server experimental flags: ${renderBlock(meta?.experimentalFlags)}\n`;
};

/**
 * Whether the superseded seeds could be found when the batch began.
 *
 * Reported because it decides how a composition of one reads: a session that
 * found a superseded copy was offered it, and a session that could not find
 * one was not. Both are legitimate runs and they are not the same run.
 */
const renderSupersededVisibility = (
  visibility: Readonly<Record<string, boolean | undefined>> | undefined,
): string => {
  const entries = Object.entries(visibility ?? {});
  if (entries.length === 0) {
    return "The suite named no superseded seeds, so there was nothing to ask about.\n";
  }
  const findable = entries.filter(([, seen]) => seen === true);
  const withheld = entries.filter(([, seen]) => seen === false);
  const unread = entries.filter(([, seen]) => seen === undefined);
  const lines = [
    `Of ${entries.length} superseded seeds, ${findable.length} were still offered in search when this batch started, ${withheld.length} were withheld, and ${unread.length} could not be read.`,
  ];
  if (findable.length > 0) {
    lines.push(
      "",
      "**Still findable when the batch started**, so a session could have composed a version the committed source cannot rebuild:",
      ...findable.map(([id]) => `- \`${id}\``),
    );
  }
  if (unread.length > 0) {
    lines.push(
      "",
      "NOT READ, so nothing here says whether these were findable:",
      ...unread.map(([id]) => `- \`${id}\``),
    );
  }
  return `${lines.join("\n")}\n`;
};

/** What the index answered the pre-flight search with. */
const renderPreflight = (preflight: IndexPreflight): string =>
  preflight.kind === "refused"
    ? `**The batch refused to start, so no task ran.** ${preflight.reason}\n\nNothing below ran. A failed pre-flight is not measured through: doing so would spend a batch producing evidence for a different system than the report names.\n`
    : `The index answered a search before the first task: ${preflight.results} results${
      preflight.candidates === undefined
        ? ""
        : ` over ${preflight.candidates} candidates examined`
    }. So a run that found nothing below was answered and found nothing, rather than refused.\n`;

/** What the console status contract answered before the first task. */
const renderConsolePreflight = (preflight: ConsolePreflight): string =>
  preflight.kind === "ready"
    ? `The console reported an absolute artifact root before the first task: \`${preflight.artifactRoot}\`. Its \`sessions\` field was an array.\n`
    : `**The console status contract was refused, so no task ran.** ${preflight.reason}\n`;

/**
 * Whether the console satisfied the cell spec, before the first task.
 *
 * A batch that named no spec says so rather than leaving the section out: an
 * experiment whose policy structurally could not offer the tool it exists to
 * test reads, in every other part of this report, exactly like one whose model
 * chose not to use it.
 */
const renderCellSpec = (preflight: CellSpecPreflight): string => {
  if (preflight.kind === "unasked") {
    return "This batch named no cell spec, so nothing here says the console " +
      "offered the tools, subagent profiles, system prompt, space, or stores " +
      "this experiment depends on. What the sessions ran under is recorded " +
      "below; it is not checked against anything.\n";
  }
  if (preflight.kind === "matched") {
    const asserted = Object.keys(preflight.spec).filter((field) =>
      field !== "label"
    ).sort();
    return `Checked against the cell spec${
      preflight.spec.label === undefined ? "" : ` \`${preflight.spec.label}\``
    } before the first task, and every field it names held: ${
      asserted.join(", ")
    }. Fields the spec does not name are unchecked.\n`;
  }
  const lines = [
    `**The console was not the cell this batch was told to measure, so no task ran.** ${preflight.reason}`,
  ];
  if (preflight.mismatches !== undefined) {
    lines.push(
      "",
      ...preflight.mismatches.map((mismatch) =>
        `- \`${mismatch.field}\`: expected ${mismatch.expected}, and this console reports ${mismatch.actual}`
      ),
    );
  }
  return `${lines.join("\n")}\n`;
};

/**
 * Which task imported which published pattern.
 *
 * The count alone cannot tell one claim from another: composing a pattern an
 * earlier run happened to leave in the index says the loop composes, and
 * composing a curated, seeded atom says the loop composes *what was seeded*,
 * which is the stronger claim and the one the seeding was for. Only the
 * identifiers separate them, and only a per-task listing shows whether several
 * compositions are several tasks or one task repeating itself.
 */
const renderComposition = (
  results: readonly TaskResult[],
  seeded: readonly string[] = [],
  origins: Readonly<Record<string, ImportedPatternOrigin>> = {},
  superseded: readonly string[] = [],
  supersededReasons: Readonly<Record<string, string>> = {},
): readonly string[] => {
  const isSeeded = new Set(seeded);
  // A suite may declare only superseded seeds, and the marks still mean
  // something: an identifier is then pre-existing or a superseded duplicate.
  const marksSuperseded = superseded.length > 0;
  const mark = (id: string): string => {
    if (isSeeded.size === 0 && !marksSuperseded) return `\`${id}\``;
    const origin = origins[id] ?? {
      kind: "unresolved" as const,
      reason: "this batch resolved no origin for it",
    };
    switch (origin.kind) {
      case "seeded":
        return `\`${id}\` **(seeded)**`;
      case "seeded-superseded":
        return `\`${id}\` **(seeded, superseded — ${
          supersededReasons[id] ?? "not reproducible from the committed source"
        })**`;
      case "seeded-via-alias": {
        const parts = [
          ...(origin.through.length > 0
            ? [`via alias of ${origin.through.join(", ")}`]
            : []),
          ...(origin.throughSuperseded.length > 0
            ? [
              `via alias of superseded ${
                origin.throughSuperseded.join(", ")
              }, which the committed source cannot rebuild`,
            ]
            : []),
        ];
        return `\`${id}\` **(seeded, ${parts.join("; ")})**`;
      }
      case "pre-existing":
        return `\`${id}\` (pre-existing)`;
      case "unresolved":
        return `\`${id}\` (ORIGIN NOT RESOLVED — ${origin.reason})`;
    }
  };
  const composed = results
    .map((result) => ({
      id: result.task.id,
      totals: result.measurement?.totals,
    }))
    .filter((entry) =>
      entry.totals !== undefined && entry.totals.composedPatternIds.length > 0
    );
  const lines = [
    "## What composed what",
    "",
  ];
  if (composed.length === 0) {
    const referenced = results.some((result) =>
      (result.measurement?.totals.importedPatternIds.length ?? 0) > 0
    );
    lines.push(
      referenced
        ? "No task composed a published pattern. Some task did reference one — by a bare import or a bare re-export — and neither puts a pattern to work; the per-task blocks name which."
        : "No task imported a published pattern at all. Every `run_pattern` call either named a pattern by id or carried source of its own.",
      "",
    );
    return lines;
  }
  for (const entry of composed) {
    const totals = entry.totals!;
    lines.push(
      `- **${entry.id}** — ${totals.runPatternsComposing} composing, ${totals.runPatternsReexporting} bare re-export, importing ${
        totals.composedPatternIds.map(mark).join(", ")
      }`,
    );
  }
  lines.push(
    "",
    `That is ${composed.length} of ${results.length} tasks. Several compositions in one task are one task, not several — read the list, not the total.`,
  );
  if (isSeeded.size === 0 && !marksSuperseded) {
    lines.push(
      "",
      "The suite named no seeded patterns, so nothing here separates composing a seeded atom from composing an entry an earlier run left behind.",
    );
  } else {
    lines.push(
      "",
      "Each identifier is resolved one dependency hop, because a bare re-export of a seeded atom carries its own identifier and would otherwise read as pre-existing. Hops beyond the first are not resolved.",
    );
  }
  lines.push("");
  return lines;
};

/** The batch report, as Markdown. */
export const renderBatchReport = (batch: BatchResult): string => {
  const lines: string[] = [
    `# Pattern index measurement — ${batch.suite.label}`,
    "",
    `- Started: ${batch.startedAt}`,
    `- Ended: ${batch.endedAt}`,
    `- Console: ${batch.consoleUrl}`,
    `- Pattern index: ${
      batch.indexUrl ??
        "not recorded by this runner (the console was started with its own)"
    }`,
    `- Index before: ${renderIndexSnapshot(batch.indexBefore)}`,
    `- Index after: ${renderIndexSnapshot(batch.indexAfter)}`,
    "",
  ];
  if (batch.suite.notes !== undefined) {
    lines.push(batch.suite.notes, "");
  }
  lines.push(
    "## Did the console expose the measurement contract",
    "",
    renderConsolePreflight(batch.consolePreflight),
    "## Was this the cell the batch was told to measure",
    "",
    renderCellSpec(batch.cellSpec),
    "## What the fabric server reported it was running",
    "",
    renderPosture(batch.posture),
    "## Did the index answer at all",
    "",
    renderPreflight(batch.preflight),
    REPORT_SCOPE,
    "",
    ...renderConfiguration(batch.results),
    "## Batch totals",
    "",
    "```text",
    ...renderTotalsLines(
      foldTotals(
        batch.results.map((result) => result.measurement?.totals).filter((
          totals,
        ): totals is NonNullable<typeof totals> => totals !== undefined),
      ),
    ),
    "```",
    "",
    `Tasks: ${batch.results.length}, of which ${
      batch.results.filter((result) => result.measurement === undefined).length
    } were not measured.`,
    "",
    ...renderComposition(
      batch.results,
      batch.suite.seededPatternIds,
      batch.importedPatternOrigins,
      batch.suite.supersededPatternIds,
      batch.suite.supersededReasons,
    ),
    "## The index, before and after",
    "",
    "How much of it a run could find, going in:",
    "",
    renderDiscoverability(batch.indexBefore),
    "Superseded seeds, asked for by name because a withheld entry is absent",
    "from the listing rather than marked in it:",
    "",
    renderSupersededVisibility(batch.supersededVisibility),
    renderIndexChange(indexChangeOf(batch.indexBefore, batch.indexAfter)),
    "## The tasks",
    "",
    "Each task ran in a fresh session, one at a time, and none of them names",
    "the pattern index. The text below is what the session was given, exactly.",
    "",
  );
  for (const result of batch.results) {
    lines.push(
      `### ${result.task.id}`,
      "",
      "```text",
      result.task.text,
      "```",
      "",
      `- Session: \`${result.sessionId}\``,
      `- Run: ${result.runId === undefined ? "none" : `\`${result.runId}\``}`,
      `- Ended: **${result.outcome.kind}** — ${
        result.outcome.kind === "unwitnessed"
          ? result.outcome.reason
          : result.outcome.detail.split("\n")[0]
      }`,
      "",
    );
    if (result.measurement === undefined) {
      lines.push(
        `NOT MEASURED — ${result.measurementUnread ?? "no reason recorded"}`,
        "",
      );
      continue;
    }
    lines.push("```text");
    for (const run of result.measurement.runs) {
      lines.push(...renderRunLines(run));
    }
    lines.push(...renderTotalsLines(result.measurement.totals));
    lines.push("```", "");
  }
  return lines.join("\n");
};

export const main = async (
  args: readonly string[],
  log: (line: string) => void = console.log,
  postureReader: typeof preflightPosture = preflightPosture,
): Promise<number> => {
  const flags = parseArgs([...args], {
    string: [
      "console",
      "out",
      "fabric-api-url",
      "base",
      "expect-git-sha",
      "cell-spec",
    ],
    boolean: ["allow-diverged"],
    default: {
      console: DEFAULT_CONSOLE_URL,
      "fabric-api-url": Deno.env.get("CF_HARNESS_FABRIC_API_URL") ??
        DEFAULT_FABRIC_API_URL,
      base: "origin/main",
    },
  });
  const suitePath = flags._.map(String)[0];
  if (suitePath === undefined) {
    log(
      "usage: measure-batch <suite.json> [--console=URL] [--out=DIR] [--cell-spec=FILE] [--allow-diverged]",
    );
    return 2;
  }
  const suite = parseMeasurementSuite(
    JSON.parse(await Deno.readTextFile(suitePath)),
  );
  // Both files are read and validated before a socket is opened, so a
  // malformed spec costs nothing and a console that is not running is the only
  // thing a reachability failure can mean.
  const spec = flags["cell-spec"] === undefined
    ? undefined
    : parseCellSpec(JSON.parse(await Deno.readTextFile(flags["cell-spec"])));
  const client = await ConsoleClient.open(flags.console);
  const startedAt = new Date().toISOString();
  const consolePreflight = await client.preflightStatus();
  if (consolePreflight.kind === "refused") {
    log(
      `the console status contract was refused, so no task ran: ${consolePreflight.reason}`,
    );
  }
  // Asked of the console before anything else it knows, because a cell whose
  // policy cannot offer the tool an experiment exists to test spends every
  // task producing evidence about a different experiment.
  const cellSpec = consolePreflight.kind === "refused"
    ? {
      kind: "refused" as const,
      reason:
        "the console status pre-flight refused first, so the cell spec was not checked",
      ...(spec !== undefined ? { spec } : {}),
    }
    : await preflightCellSpec(client, spec);
  if (cellSpec.kind === "refused" && consolePreflight.kind !== "refused") {
    log(
      `the console is not the cell this batch names, so no task ran: ${cellSpec.reason}`,
    );
  }
  // The server's CFC block is recorded rather than differenced against the
  // console's because the two runtimes use different presets. A known commit
  // divergence refuses unless the operator explicitly allows it.
  const posture = await postureReader(
    flags["fabric-api-url"],
    flags.base,
    flags["expect-git-sha"],
    undefined,
    undefined,
    flags["allow-diverged"],
  );
  if (posture.kind === "refused") {
    log(
      `the fabric server was not the expected one, so no task ran: ${posture.reason}`,
    );
  } else {
    log(
      `fabric server at ${flags["fabric-api-url"]}: ${
        posture.meta.gitSha ?? "no commit reported"
      } (${posture.ancestry.kind})`,
    );
  }
  // The index pre-flight is the unambiguous one: an index that does not answer
  // reads to a run exactly as an empty corpus does, so a batch that started
  // into one would spend the night producing evidence for the wrong problem.
  const preflight = consolePreflight.kind === "refused"
    ? {
      kind: "refused" as const,
      reason:
        "the console status pre-flight refused first, so the index was not asked",
    }
    : cellSpec.kind === "refused"
    ? {
      kind: "refused" as const,
      reason:
        "the cell spec pre-flight refused first, so the index was not asked",
    }
    : posture.kind === "refused"
    ? {
      kind: "refused" as const,
      reason: "the commit pre-flight refused first, so the index was not asked",
    }
    : await client.preflightIndex(PREFLIGHT_QUERY);
  const indexBefore = preflight.kind === "refused"
    ? { kind: "unread" as const, reason: "the pre-flight search was refused" }
    : await client.indexSnapshot();
  // Taken before the tasks run: whether the superseded copies were findable is
  // a fact about the corpus this batch measured, and it changes underneath.
  const supersededVisibility = preflight.kind === "refused"
    // Declared but never asked about: recorded as unread rather than dropped,
    // which would report a suite that named superseded seeds as one that did
    // not.
    ? Object.fromEntries(
      (suite.supersededPatternIds ?? []).map((id) => [id, undefined]),
    )
    : await readSupersededVisibility(client, suite.supersededPatternIds ?? []);
  const results: TaskResult[] = [];
  if (consolePreflight.kind === "refused" || cellSpec.kind === "refused") {
    // Both refusals were logged where they were read, and each names what it
    // found rather than the index question it stopped short of.
  } else if (preflight.kind === "refused") {
    log(`the index did not answer, so no task ran: ${preflight.reason}`);
  } else {
    log(
      `index answered the pre-flight search with ${preflight.results} results`,
    );
    log(`index before: ${renderIndexSnapshot(indexBefore)}`);
    for (const task of suite.tasks) {
      results.push(
        await runTask(client, task, log, {
          batchStartedAt: startedAt,
          artifactRoot: consolePreflight.artifactRoot,
        }),
      );
    }
  }
  const importedPatternIds = [
    ...new Set(
      results.flatMap((result) =>
        result.measurement?.totals.importedPatternIds ?? []
      ),
    ),
  ].sort();
  const importedPatternOrigins = await resolveImportedPatternOrigins(
    client,
    importedPatternIds,
    suite.seededPatternIds ?? [],
    suite.supersededPatternIds ?? [],
  );
  const indexAfter = preflight.kind === "refused"
    ? indexBefore
    : await client.indexSnapshot();
  if (preflight.kind === "answered") {
    log(`index after: ${renderIndexSnapshot(indexAfter)}`);
  }
  const batch: BatchResult = {
    suite,
    consoleUrl: flags.console,
    indexUrl: Deno.env.get("CF_HARNESS_PATTERN_INDEX_URL") ?? null,
    startedAt,
    endedAt: new Date().toISOString(),
    consolePreflight,
    cellSpec,
    preflight,
    posture,
    importedPatternOrigins,
    supersededVisibility,
    indexBefore,
    indexAfter,
    results,
  };
  const outDir = flags.out ??
    join(
      ".cf-harness-console",
      "measurements",
      `${startedAt.replace(/[:.]/g, "-")}`,
    );
  await ensureDir(outDir);
  await Deno.writeTextFile(
    join(outDir, "report.md"),
    renderBatchReport(batch),
  );
  await Deno.writeTextFile(
    join(outDir, "report.json"),
    `${JSON.stringify(batch, null, 2)}\n`,
  );
  log(`report written to ${join(outDir, "report.md")}`);
  // A refused pre-flight is a distinct exit code from a batch whose tasks ran
  // and did not all complete: the first is a machine to fix before trying
  // again, the second is a result to read.
  if (consolePreflight.kind === "refused") return 5;
  if (cellSpec.kind === "refused") return 6;
  if (posture.kind === "refused") return 4;
  if (preflight.kind === "refused") return 3;
  return results.every((result) => result.outcome.kind === "turn_completed")
    ? 0
    : 1;
};

// deno-coverage-ignore-start -- the entrypoint guard is false under every test
// that imports this module, which is what it is for
if (import.meta.main) Deno.exit(await main(Deno.args));
// deno-coverage-ignore-stop
