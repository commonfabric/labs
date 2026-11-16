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

import { type Artifact, Instance, Unsupported } from "../exec/executor.ts";
import {
  type EventOutcome,
  type Plan,
  type Probe,
  runScenario,
  type Scenario,
} from "./harness.ts";

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
  /** The documents today's run stored at the end (`Values.documents`). */
  runtimeDocuments?: number;
  counts?: Instance["counts"];
  /** The stored positions of streams against `Binding.result`. */
  streams?: ReturnType<Instance["streamPositions"]>;
  /** The events the executor's handler did not run to its end for. */
  failedEvents: string[];
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
 * the node holds its members or the array.
 */
export const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  // The two runs read the clock at two times: a number within a day of
  // now, and a time written out in a string, are compared as `<time>`.
  if (typeof value === "number" && Math.abs(value - Date.now()) < 86_400_000) {
    return "<time>";
  }
  if (typeof value === "string") {
    return value.replace(
      /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g,
      "<time>",
    ).replace(/\b\d\d:\d\d:\d\d\b/g, "<time>");
  }
  if (!isRecord(value)) return value;
  const members: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(value)) {
    const kept = normalize(member);
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
    ) => isRecord(child) && child.type !== "vnode" && "$UI" in child
      ? child.$UI
      : child
    );
  }
  return members;
};

const show = (value: unknown): string =>
  (JSON.stringify(value) ?? "undefined").slice(0, 120);

/** The first place two normalized values differ at, or `undefined`. */
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
    return undefined;
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
          state[cell.name] = plain(
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
export const categoryOf = (error: unknown): { category: string; detail: string } => {
  const detail = `${(error as Error)?.message ?? error}`.split("\n")[0]
    .slice(0, 160);
  if (error instanceof Unsupported) {
    return { category: `the executor does not do: ${error.kind}`, detail };
  }
  if (error instanceof ReferenceError) {
    return { category: "the value code names something it does not bind", detail };
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
 * Runs the executor on the argument and the events of a run of today's
 * runtime, and compares the values at each point.
 */
export const compareValues = (
  artifact: Artifact,
  argument: Record<string, unknown>,
  events: { binding: number; event: unknown }[],
  outcomes: Pick<EventOutcome, "outcome" | "elements">[],
  runtime: Values,
): ValueComparison => {
  const comparison: ValueComparison = {
    compared: 0,
    equal: 0,
    differences: [],
    failedEvents: [],
  };
  if ((artifact.code.unsupported ?? []).length > 0) {
    const kind = artifact.code.unsupported[0].kind;
    comparison.notExecuted = {
      category: `no value code: ${kind}`,
      detail: `${artifact.code.unsupported[0].file}`,
    };
    return comparison;
  }
  const compare = (
    point: string,
    theirs: Snapshot | undefined,
    mine: Snapshot,
  ) => {
    if (theirs === undefined) return;
    const pairs: [string, unknown, unknown][] = [];
    const a = normalize(theirs.result);
    const b = normalize(mine.result);
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
        normalize(value),
        normalize(mine.state[name]),
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
  const snapshot = (instance: Instance): Snapshot => ({
    result: instance.result(),
    state: Object.fromEntries(
      instance.stateCells().filter(({ keys }) => keys.length === 0).map((
        { name, value },
      ) => [name, value]),
    ),
  });
  let instance: Instance;
  try {
    instance = new Instance(artifact, argument, { space: runtime.space });
    compare("settled", runtime.settled, snapshot(instance));
  } catch (error) {
    comparison.notExecuted = categoryOf(error);
    return comparison;
  }
  // The events the run sent, in order: `runtime.events` has an entry for
  // each one the harness sent, and none for one it did not send.
  let sent = 0;
  events.forEach(({ binding, event }, index) => {
    const outcome = outcomes[index];
    if (outcome === undefined || outcome.outcome === "not sent") return;
    const theirs = runtime.events[sent];
    sent += 1;
    // An event the runtime refused changed nothing, and the executor,
    // which checks no label, is not sent it.
    if (outcome.outcome !== "committed") return;
    try {
      const handled = instance.send(
        binding,
        event,
        (outcome.elements ?? []).map(({ key }) => Number(key)),
      );
      if (!handled.committed) {
        comparison.failedEvents.push(
          `${artifact.plan.bindings[binding].name}: ${handled.error}`,
        );
      }
      compare(`event ${index}`, theirs, snapshot(instance));
    } catch (error) {
      const { category, detail } = categoryOf(error);
      comparison.failedEvents.push(
        `${artifact.plan.bindings[binding].name}: ${category}: ${detail}`,
      );
    }
  });
  comparison.streams = instance.streamPositions();
  comparison.runtimeDocuments = runtime.documents?.end;
  comparison.documents = instance.documents();
  comparison.counts = instance.counts;
  return comparison;
};

/** Runs a scenario on today's runtime and on the executor, and compares. */
export const compareScenarioValues = async (
  scenario: Scenario,
  artifact: Artifact,
): Promise<ValueComparison> => {
  const { probe, values } = readingValues(scenario.plan);
  const run = await runScenario({ ...scenario, probe });
  const argument = {
    ...scenario.argument,
    ...Object.fromEntries(
      Object.entries(scenario.inputs ?? {}).map((
        [name, input],
      ) => [name, input.value]),
    ),
  };
  return compareValues(
    artifact,
    argument,
    scenario.events ?? [],
    run.events,
    values,
  );
};
