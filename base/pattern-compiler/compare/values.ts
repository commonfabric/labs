/**
 * Compares the values the executor of `../exec/` computes for a compiled
 * plan with the values today's runtime computes for the same pattern, the
 * same argument, and the same events: the result after the instance
 * settled and after each event, and the state cells of the pattern's own
 * body at the same points.
 */
import type { Cell } from "../../../runtime/runner/src/cell.ts";
import { parseLink } from "../../../runtime/runner/src/link-utils.ts";
import type { NormalizedFullLink } from "../../../runtime/runner/src/link-types.ts";

import {
  type Artifact,
  type Completion,
  Instance,
  type Outstanding,
  Unsupported,
} from "../exec/executor.ts";
import { isErrorState, nameText } from "../exec/store.ts";
import { drawing, eventSeed, restoreRandom, seedRandom } from "./random.ts";
import {
  type EventOutcome,
  type Plan,
  type Probe,
  type Run,
  runScenario,
  type Scenario,
  type StreamRecord,
} from "./harness.ts";
import type { HomeStubs } from "./wish-home.ts";

/** The values of an instance at one point of a run. */
export type Snapshot = {
  result: unknown;
  /** The state cells of the pattern's own body, by name. */
  state: Record<string, unknown>;
};

/** The values of one run: after it settled, and after each event. */
export type Values = {
  /** The space the run was made in. */
  space?: string;
  /**
   * The documents today's run stored from the compile on, the cells the
   * scenario gives its inputs through included: after the instance
   * settled, and at the end.
   */
  documents?: { settled: number; end: number };
  settled?: Snapshot;
  /** One entry per event sent, in order. `undefined` for one not sent. */
  events: (Snapshot | undefined)[];
};

/** One value that differs, or that one side does not hold. */
export type Difference = {
  /** `settled`, or `event <n>` with the position of the event. */
  point: string;
  /** `result/<member>` or `state/<name>`. */
  value: string;
  /** Where below the value the first difference is. */
  path: string;
  runtime: string;
  executor: string;
};

/** The comparison of the values of one module. */
export type ValueComparison = {
  /** Why the executor did not run, by category, where it did not. */
  notExecuted?: { category: string; detail: string };
  /** The values compared: each member of the result and each state cell,
   * at each point. */
  compared: number;
  equal: number;
  differences: Difference[];
  /** The documents the executor stored at the end, by kind. */
  documents?: Record<string, number>;
  /**
   * The identifier of each document the executor stored at the end, in
   * the order of their text, without the constants held for a handle.
   */
  documentIds?: string[];
  /** The documents today's run stored at the end (`Values.documents`). */
  runtimeDocuments?: number;
  counts?: Instance["counts"];
  /**
   * The positions at which a reader of the executor's stored result
   * finds the link to a stream, at the end (`Instance.streams`).
   */
  storedStreams?: number;
  /** The events the executor's handler did not run to its end for. */
  failedEvents: string[];
  /**
   * For a run with stubbed answers: the requests the executor made, by
   * built-in, the requests that have no completion at the end, and the
   * state documents of its `wish` operations and effects.
   */
  requests?: Record<string, number>;
  outstanding?: number;
  /**
   * What the executor's transactions wrote, by cause: how many
   * transactions, the documents they wrote, and the bytes of those
   * documents.
   */
  /**
   * The wall time of the executor, in milliseconds: from the artifact
   * to the settled instance, which includes the evaluation of the
   * module texts, and for each event it handled, with the derivation
   * transaction behind it.
   */
  times?: { settle: number; events: number[] };
  written?: Record<
    string,
    { transactions: number; documents: number; bytes: number }
  >;
  /**
   * The evaluations of the executor that ended in an error state: the
   * cone and the message, each once.
   */
  failures?: string[];
  /**
   * The events the harness did not send to today's runtime, each with the
   * binding's name and the reason: neither side handled them.
   */
  notSent?: string[];
};

const DEPTH = 40;

/**
 * A copy of what a cell read gives, as plain data. A member past the
 * depth a tree of a pattern reaches is left out, which ends a cycle of
 * links.
 */
const plain = (value: unknown, depth = 0): unknown => {
  if (depth > DEPTH) return undefined;
  if (typeof value === "function") return undefined;
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    return Array.from(value, (member) => plain(member, depth + 1));
  }
  const members: Record<string, unknown> = {};
  for (const name of Object.keys(value)) {
    let member: unknown;
    try {
      member = (value as Record<string, unknown>)[name];
    } catch {
      continue;
    }
    const copy = plain(member, depth + 1);
    if (copy !== undefined) members[name] = copy;
  }
  return members;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A value in the form two runs are compared in: a member that holds
 * nothing is left out, and the children of a view node are one flat list.
 * A child that is an array is a list the renderer shows in place, whether
 * the node holds its members or the array. `now` is what the clock held
 * when the two runs were made.
 */
export const normalize = (value: unknown, now = Date.now()): unknown => {
  if (Array.isArray(value)) {
    return value.map((member) => normalize(member, now));
  }
  // The two runs read the clock at two times: a number within a day of
  // `now`, and a time written out in a string, are compared as `<time>`.
  if (typeof value === "number" && Math.abs(value - now) < 86_400_000) {
    return "<time>";
  }
  if (typeof value === "string") {
    return value.replace(
      /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g,
      "<time>",
    ).replace(/\b\d{1,2}:\d\d:\d\d\b( [AP]M)?/g, "<time>");
  }
  if (!isRecord(value)) return value;
  // An output whose cone instance failed holds the error state in the
  // executor, and nothing in today's runtime, where a node that throws
  // stores nothing (PL §5.2, "Storage").
  if (isErrorState(value)) return undefined;
  const members: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(value)) {
    const kept = normalize(member, now);
    if (kept !== undefined) members[name] = kept;
  }
  // The stream of a binding reads as an empty record in today's runtime.
  if (members.$stream === true && Object.keys(members).length === 1) return {};
  if (members.type === "vnode" && Array.isArray(members.children)) {
    // Today's run holds the result of a pattern at a child position, with
    // its tree under `$UI`, where the compiled path holds the tree in
    // place (PL §1.1, assumed there under question 53). Both render as
    // the tree.
    members.children = (members.children as unknown[]).flat(Infinity).map((
      child,
    ) =>
      isRecord(child) && child.type !== "vnode" && "$UI" in child
        ? child.$UI
        : child
    );
  }
  return members;
};

/** What stands for a member or a position that holds nothing in a file. */
const NOTHING = "$nothing";

/**
 * A value in the form a results file holds it. JSON leaves out a member
 * that holds `undefined` and writes a position of an array that holds it
 * as `null`, so the values of a run read from a file would differ from
 * the values the run compared: each `undefined` is written as a record
 * that stands for it.
 */
export const inFileForm = (value: unknown): unknown => {
  if (value === undefined) return { [NOTHING]: true };
  if (Array.isArray(value)) return Array.from(value, inFileForm);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, member]) => [name, inFileForm(member)]),
  );
};

/** The value that a results file holds in the form of `inFileForm`. */
export const outOfFileForm = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(outOfFileForm);
  if (!isRecord(value)) return value;
  if (value[NOTHING] === true && Object.keys(value).length === 1) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).map((
      [name, member],
    ) => [name, outOfFileForm(member)]),
  );
};

const show = (value: unknown): string =>
  (JSON.stringify(value) ?? "undefined").slice(0, 120);

/**
 * The first place two normalized values differ at, or `undefined`. Two
 * arrays whose positions are equal differ at `length` where one has more
 * positions than the other, which is the case where the further positions
 * hold nothing.
 */
export const firstDifference = (
  a: unknown,
  b: unknown,
  path: string[] = [],
): { path: string; a: string; b: string } | undefined => {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const found = firstDifference(a[index], b[index], [...path, `${index}`]);
      if (found !== undefined) return found;
    }
    return firstDifference(a.length, b.length, [...path, "length"]);
  }
  if (isRecord(a) && isRecord(b)) {
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const found = firstDifference(a[name], b[name], [...path, name]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return Object.is(a, b)
    ? undefined
    : { path: path.join("/"), a: show(a), b: show(b) };
};

/**
 * A probe that reads, after the instance settled and after each event,
 * the result of today's run and the state cells of the pattern's own
 * body, which the `internal` metadata of the result document names.
 */
export const readingValues = (
  plan: Plan,
): { probe: Probe; values: Values } => {
  const values: Values = { events: [] };
  // The documents a commit wrote, and those the compile wrote.
  const written = new Set<string>();
  let compiled = new Set<string>();
  const probe: Probe = {
    at: async (point, { runtime, space, storageManager }) => {
      values.space = space;
      if (point === "created") {
        storageManager.subscribe({
          // deno-lint-ignore no-explicit-any
          next(notification: any) {
            if (notification.type !== "commit") return undefined;
            for (const change of notification.changes) {
              const { id, scope } = change.address;
              written.add(JSON.stringify([id, scope]));
            }
            return undefined;
          },
        });
      }
      if (point === "compiled") compiled = new Set(written);
      const stored = [...written].filter((key) => !compiled.has(key)).length;
      if (point === "settled") {
        values.documents = { settled: stored, end: stored };
      } else if (values.documents !== undefined) {
        values.documents.end = stored;
      }
      if (point !== "settled" && point !== "after event") return;
      if (point === "after event") {
        // The harness reads the root of the result again after an event.
        // A value below it that nothing demands is computed when it is
        // read: each kept output is read here, as the harness reads each
        // one after the instance settled.
        const result = runtime.getCell(
          space as `did:${string}:${string}`,
          "compare",
        ) as Cell<unknown>;
        for (const entry of plan.outputs) {
          if (entry.kept === false || entry.interim !== undefined) continue;
          const star = entry.path.indexOf("*");
          const path = star < 0 ? entry.path : entry.path.slice(0, star);
          try {
            await path.reduce(
              (cell, key) => cell.key(key as never) as Cell<unknown>,
              result,
            ).pull();
          } catch {
            // A path the run does not hold has no value to compare.
          }
        }
        await runtime.idle();
      }
      const read = runtime.edit();
      try {
        const result = runtime.getCell(
          space as `did:${string}:${string}`,
          "compare",
          undefined,
          read,
        ) as Cell<unknown>;
        const state: Record<string, unknown> = {};
        const manifest = result.getMetaRaw("internal") as unknown;
        const entries = (Array.isArray(manifest) ? manifest : []) as {
          partialCause?: unknown;
          link?: unknown;
        }[];
        for (const cell of plan.stateCells ?? []) {
          if ((cell.within ?? []).length > 0) continue;
          const named = entries.filter((entry) =>
            entry.partialCause === cell.name
          );
          if (named.length !== 1) continue;
          const link = parseLink(named[0].link, result) as
            | NormalizedFullLink
            | undefined;
          if (link === undefined) continue;
          state[nameText(cell.name)] = plain(
            runtime.getCellFromLink(link, undefined, read).get(),
          );
        }
        const snapshot = { result: plain(result.get()), state };
        if (point === "settled") values.settled = snapshot;
        else values.events.push(snapshot);
      } finally {
        read.abort();
      }
    },
  };
  return { probe, values };
};

/** How an error of the executor is counted. */
export const categoryOf = (
  error: unknown,
): { category: string; detail: string } => {
  const detail = `${(error as Error)?.message ?? error}`.split("\n")[0]
    .slice(0, 160);
  if (error instanceof Unsupported) {
    return { category: `the executor does not do: ${error.kind}`, detail };
  }
  if (error instanceof ReferenceError) {
    return {
      category: "the value code names something it does not bind",
      detail,
    };
  }
  if (error instanceof SyntaxError) {
    return { category: "the value code does not parse", detail };
  }
  if (error instanceof RangeError) {
    return { category: "the executor does not end", detail };
  }
  return { category: "the value code throws", detail };
};

/**
 * The answers a run of the executor gets in place of the network: the
 * completion of each request, and what the clock holds.
 */
export type Stubs = {
  completion: (request: Outstanding) => Completion | undefined;
  now: number;
  /** What the `wish` operations resolve in (`wish-home.ts`). */
  home?: HomeStubs;
};

/** The outcome of an event of today's run, as a comparison reads it. */
type Outcome = Pick<EventOutcome, "outcome" | "elements"> & {
  reason?: string;
};

/**
 * The executor's side of a comparison: an instance of the compiled
 * pattern that handles the events today's run committed, with its
 * values after it settled and after each event. It is the record of
 * where each stream is stored that the harness sends an event by
 * (`StreamRecord`; ruling Z43), so it runs beside today's run, one event
 * behind it. An executor that does not start holds no stream, and the
 * harness then sends no event.
 */
export class ExecutorRun implements StreamRecord {
  readonly #artifact: Artifact;
  readonly #argument: Record<string, unknown>;
  readonly #artifacts: ((id: string) => Artifact | undefined) | undefined;
  readonly #stubs: Stubs | undefined;
  readonly #requests: Record<string, number> = {};
  #instance: Instance | undefined;
  #notExecuted: { category: string; detail: string } | undefined;
  #settled: Snapshot | undefined;
  /** The values after each event the executor handled, by its index. */
  readonly #events = new Map<number, Snapshot>();
  readonly #failedEvents: string[] = [];

  /**
   * Constructs an instance which runs `artifact` on `argument`.
   * `artifacts` gives the artifact of a pattern by its identity, for a
   * pattern that a function body instantiates.
   */
  constructor(
    artifact: Artifact,
    argument: Record<string, unknown>,
    artifacts?: (id: string) => Artifact | undefined,
    stubs?: Stubs,
  ) {
    this.#artifact = artifact;
    this.#argument = argument;
    this.#artifacts = artifacts;
    this.#stubs = stubs;
  }

  /**
   * Answers the requests of the instance from the table of the stubs,
   * until none is outstanding that the table answers.
   */
  #answer(instance: Instance): void {
    const stubs = this.#stubs;
    if (stubs === undefined) return;
    instance.answer((request) => {
      this.#requests[request.builtin] = (this.#requests[request.builtin] ?? 0) +
        1;
      return stubs.completion(request);
    });
  }

  readonly #times = { settle: 0, events: [] as number[] };

  /** @inheritDoc */
  start(space: string | undefined): void {
    if ((this.#artifact.code.unsupported ?? []).length > 0) {
      const { kind, file } = this.#artifact.code.unsupported[0];
      this.#notExecuted = {
        category: `no value code: ${kind}`,
        detail: `${file}`,
      };
      return;
    }
    try {
      const began = performance.now();
      this.#instance = new Instance(this.#artifact, this.#argument, {
        space,
        // One secret for every run, so that the keys of plain values in
        // a results file are those of the next run.
        secret: "the secret of the comparison",
        artifacts: this.#artifacts,
        ...(this.#stubs === undefined ? {} : { now: this.#stubs.now }),
        ...(this.#stubs?.home === undefined ? {} : {
          documents: this.#stubs.home.documents,
          wishes: this.#stubs.home.wishes,
        }),
        // For a run that is timed: the bytes of whole documents are
        // not counted, which is a pass over each document written.
        ...(Deno.env.get("PATTERN_COMPILER_MEASURE") === "patches"
          ? { measure: "patches" as const }
          : {}),
      });
      this.#answer(this.#instance);
      this.#times.settle = performance.now() - began;
      this.#settled = this.#snapshot(this.#instance);
    } catch (error) {
      this.#notExecuted = categoryOf(error);
    }
  }

  /**
   * The query of each `wish` the executor resolved so far that the home of
   * the stubs does not simulate.
   */
  get unsimulated(): readonly string[] {
    return this.#stubs?.home?.unsimulated ?? [];
  }

  /** @inheritDoc */
  held(binding: number): { path: string[]; elements: number[] }[] {
    // A stream of an instance that a function body made, and one whose
    // key is in no collection, is none an event of the scenario is for.
    return (this.#instance?.streams() ?? []).flatMap((stream) =>
      stream.binding === binding && stream.instance === undefined &&
        stream.elements !== undefined
        ? [{ path: stream.path, elements: stream.elements }]
        : []
    );
  }

  /** @inheritDoc */
  result(): unknown {
    return this.#instance?.result();
  }

  /** @inheritDoc */
  committed(
    index: number,
    binding: number,
    event: unknown,
    elements: readonly number[],
  ): void {
    const instance = this.#instance;
    if (instance === undefined) return;
    const name = this.#nameOf(binding);
    // The seed today's run had for this event (`random.ts`).
    seedRandom(eventSeed(index));
    try {
      const began = performance.now();
      const handled = drawing(() =>
        instance.send(binding, event, [...elements])
      );
      this.#times.events.push(performance.now() - began);
      if (!handled.committed) {
        this.#failedEvents.push(`${name}: ${handled.error}`);
      }
      this.#answer(instance);
      this.#events.set(index, this.#snapshot(instance));
    } catch (error) {
      const { category, detail } = categoryOf(error);
      this.#failedEvents.push(`${name}: ${category}: ${detail}`);
    } finally {
      restoreRandom();
    }
  }

  /**
   * Compares the executor's values with those of today's run at each
   * point. `outcomes` has what became of each event of `events` in
   * today's run. An event the runtime refused changed nothing, and the
   * executor, which checks no label, was not sent it.
   */
  compare(
    events: { binding: number; event: unknown }[],
    outcomes: Outcome[],
    runtime: Values,
  ): ValueComparison {
    const comparison: ValueComparison = {
      compared: 0,
      equal: 0,
      differences: [],
      failedEvents: [...this.#failedEvents],
    };
    const instance = this.#instance;
    if (instance === undefined || this.#settled === undefined) {
      comparison.notExecuted = this.#notExecuted ??
        { category: "the executor was not started", detail: "" };
      return comparison;
    }
    // A run with stubs was made when the clock of the stubs held `now`,
    // which is earlier than now for a run that a results file holds.
    const now = this.#stubs?.now ?? Date.now();
    const compare = (
      point: string,
      theirs: Snapshot | undefined,
      mine: Snapshot,
    ) => {
      if (theirs === undefined) return;
      const pairs: [string, unknown, unknown][] = [];
      const a = normalize(theirs.result, now);
      const b = normalize(mine.result, now);
      if (isRecord(a) && isRecord(b)) {
        for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
          pairs.push([`result/${name}`, a[name], b[name]]);
        }
      } else {
        pairs.push(["result", a, b]);
      }
      for (const [name, value] of Object.entries(theirs.state)) {
        pairs.push([
          `state/${name}`,
          normalize(value, now),
          normalize(mine.state[name], now),
        ]);
      }
      for (const [value, left, right] of pairs) {
        comparison.compared += 1;
        const found = firstDifference(left, right);
        if (found === undefined) {
          comparison.equal += 1;
        } else {
          comparison.differences.push({
            point,
            value,
            path: found.path,
            runtime: found.a,
            executor: found.b,
          });
        }
      }
    };
    compare("settled", runtime.settled, this.#settled);
    // The events the run sent, in order: `runtime.events` has an entry
    // for each one the harness sent, and none for one it did not send.
    let sent = 0;
    events.forEach(({ binding }, index) => {
      const outcome = outcomes[index];
      if (outcome?.outcome === "not sent") {
        (comparison.notSent ??= []).push(
          `${this.#nameOf(binding)}: ${outcome.reason ?? ""}`,
        );
      }
      if (outcome === undefined || outcome.outcome === "not sent") return;
      const theirs = runtime.events[sent];
      sent += 1;
      const mine = this.#events.get(index);
      if (mine !== undefined) compare(`event ${index}`, theirs, mine);
    });
    if (this.#stubs !== undefined) {
      comparison.requests = { ...this.#requests };
      comparison.outstanding = instance.outbox.length;
    }
    comparison.times = this.#times;
    comparison.written = {};
    for (const { cause, written, bytes } of instance.transactions) {
      const sum = comparison.written[cause] ??= {
        transactions: 0,
        documents: 0,
        bytes: 0,
      };
      sum.transactions += 1;
      sum.documents += written.length;
      sum.bytes += bytes;
    }
    if (instance.failed.length > 0) {
      comparison.failures = [
        ...new Set(
          instance.failed.map(({ cone, message }) => `${cone}: ${message}`),
        ),
      ];
    }
    comparison.storedStreams = instance.streams().length;
    comparison.runtimeDocuments = runtime.documents?.end;
    comparison.documents = instance.documents();
    comparison.documentIds = [...instance.store.docs].flatMap((
      [id, { kind }],
    ) => kind === "held constant" ? [] : [id]).sort();
    comparison.counts = instance.counts;
    return comparison;
  }

  /** The name of a binding as a report has it, and `undefined` for none. */
  #nameOf(binding: number): string {
    const name = this.#artifact.plan.bindings[binding]?.name;
    return name === undefined ? "undefined" : nameText(name);
  }

  /**
   * The values of the instance now, as a copy that a later write to the
   * store does not change.
   */
  #snapshot(instance: Instance): Snapshot {
    return structuredClone({
      result: instance.result(),
      state: Object.fromEntries(
        instance.stateCells().filter(({ keys }) => keys.length === 0).map((
          { name, value },
        ) => [nameText(name), value]),
      ),
    });
  }
}

/**
 * Runs the executor on the argument and the events of a run of today's
 * runtime that is over, and compares the values at each point. The
 * events are sent for the elements the run recorded.
 */
export const compareValues = (
  artifact: Artifact,
  argument: Record<string, unknown>,
  events: { binding: number; event: unknown }[],
  outcomes: Outcome[],
  runtime: Values,
  /**
   * The artifact of a pattern by its identity, for a pattern that a
   * function body instantiates.
   */
  artifacts?: (id: string) => Artifact | undefined,
  stubs?: Stubs,
): ValueComparison => {
  const run = new ExecutorRun(artifact, argument, artifacts, stubs);
  run.start(runtime.space);
  events.forEach(({ binding, event }, index) => {
    const outcome = outcomes[index];
    if (outcome?.outcome !== "committed") return;
    run.committed(
      index,
      binding,
      event,
      (outcome.elements ?? []).map(({ key }) => Number(key)),
    );
  });
  return run.compare(events, outcomes, runtime);
};

/** The argument of a scenario with each input in place of its link. */
export const argumentOf = (
  scenario: Pick<Scenario, "argument" | "inputs">,
): Record<string, unknown> => ({
  ...scenario.argument,
  ...Object.fromEntries(
    Object.entries(scenario.inputs ?? {}).map((
      [name, input],
    ) => [name, input.value]),
  ),
});

/**
 * Runs a scenario on today's runtime with the executor of `artifact`
 * beside it, which gives the harness the position of each stream
 * (`Scenario.streams`): a scenario with events is run this way.
 */
export const runBesideExecutor = (
  artifact: Artifact,
  scenario: Scenario,
  artifacts?: (id: string) => Artifact | undefined,
): Promise<Run> =>
  runScenario({
    ...scenario,
    streams: new ExecutorRun(artifact, argumentOf(scenario), artifacts),
  });

/**
 * Runs a scenario on today's runtime and on the executor, which runs
 * beside it and gives the harness the position of each stream, and
 * compares.
 */
export const compareScenarioValues = async (
  scenario: Scenario,
  artifact: Artifact,
  artifacts?: (id: string) => Artifact | undefined,
): Promise<ValueComparison> => {
  const { probe, values } = readingValues(scenario.plan);
  const executor = new ExecutorRun(artifact, argumentOf(scenario), artifacts);
  const run = await runScenario({ ...scenario, probe, streams: executor });
  return executor.compare(scenario.events ?? [], run.events, values);
};
