/**
 * Finds, from values alone, which labeled inputs each value of a run
 * depends on: the scenario is run on the executor of `../exec/` with its
 * documents in memory, once as given and once for each labeled input with
 * that input's value alone changed, and a value that differs between the
 * two runs depends on the input.
 *
 * `stored-labels.ts` uses the result as a lower bound of the stored
 * labels: a value that depends on an input stores the input's clause. The
 * bound reads no write record, no slot binding and no template, so it
 * holds whatever computed the stored label.
 *
 * A labeled input is a member of the argument that the scenario writes as
 * a cell under a schema with a clause (`generateInputs`), or the profile of
 * the seeded home (`wish-home.ts`), which a `wish` reads.
 */
import { type Artifact, Instance } from "../exec/executor.ts";
import { linkedSchema, Ref } from "../exec/store.ts";
import { generateValue, type Schema } from "./generate.ts";
import type { LabeledInput } from "./harness.ts";
import type { instanceOptions, Sent } from "./integrated.ts";
import { drawing, eventSeed, restoreRandom, seedRandom } from "./random.ts";
import { hasWish, homeStubs, memoryHome } from "./wish-home.ts";

/** The name `perturbedRuns` gives the profile of the seeded home. */
export const PROFILE_SOURCE = "the seeded profile";

/** The document of the clock (`CLOCK` of `../exec/executor.ts`). */
const CLOCK = "clock";

const resolve = (schema: Schema, root: Schema): Schema => {
  let current = schema;
  for (let hops = 0; hops < 16; hops++) {
    if (typeof current !== "object" || current.$ref === undefined) break;
    const name = current.$ref.match(/^#\/\$defs\/(.+)$/)?.[1];
    const target = typeof root === "object" && name !== undefined
      ? root.$defs?.[name]
      : undefined;
    if (target === undefined) return true;
    current = target;
  }
  return current;
};

/**
 * A value of the same type as `value` that differs from it at every
 * position that can differ: a text has a mark appended, a number is one
 * more, a boolean is the other one, a member of an `enum` is the next
 * member, and a `const` stays. Each member of an object and of an array is
 * changed the same way, and an array has one member more, generated from
 * the schema of its items where there is one and a changed copy of its last
 * member otherwise, so that a value that depends on the array's length
 * alone differs too.
 */
export const perturbed = (
  value: unknown,
  schema: Schema = true,
  root: Schema = schema,
  name = "changed",
): unknown => {
  const resolved = resolve(schema, root);
  const typed = typeof resolved === "object" ? resolved : {};
  if ("const" in typed) return value;
  if (typed.enum !== undefined) {
    const at = typed.enum.findIndex((member) =>
      JSON.stringify(member) === JSON.stringify(value)
    );
    return typed.enum.length < 2
      ? value
      : typed.enum[(at + 1) % typed.enum.length];
  }
  // The variant a value was generated from is the first that has one
  // (`generateValue`), and a changed value keeps the variant.
  const variant = (typed.anyOf ?? typed.oneOf)?.map((each) =>
    resolve(each, root)
  ).find((each) =>
    typeof each === "object" && each.type !== "null" &&
    each.type !== "undefined"
  );
  const of = typeof variant === "object" ? variant : typed;
  if (typeof value === "string") return `${value}~`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (Array.isArray(value)) {
    const items = of.items ?? true;
    const members = value.map((member, index) =>
      perturbed(member, items, root, `${name}-${index}`)
    );
    const generated = of.items === undefined
      ? undefined
      : generateValue(of.items, root, `${name}-added`, 1);
    if (generated !== undefined && typeof generated !== "symbol") {
      members.push(generated);
    } else if (value.length > 0) {
      members.push(
        perturbed(members[members.length - 1], items, root, `${name}-added`),
      );
    }
    return members;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [
        key,
        perturbed(
          member,
          of.properties?.[key] ?? true,
          root,
          `${name}-${key}`,
        ),
      ]),
    );
  }
  return value;
};

/**
 * The events of a scenario three times over: in the reverse of the order
 * given, then in the order given with each value changed (`perturbed`,
 * under the schema the binding declares for its event), then in the reverse
 * order again with that value changed again. Every handler the scenario
 * runs then runs again on what its own earlier run and the runs of the
 * other handlers stored, with an event that differs from the earlier ones,
 * and both before and after each other handler.
 */
export const repeatedEvents = (
  plan: { bindings?: readonly object[] },
  schemas: readonly { id: string; schema?: unknown }[],
  events: readonly { binding: number; event: unknown }[],
): { binding: number; event: unknown }[] => {
  const changed = (binding: number, event: unknown): unknown => {
    const declared = (plan.bindings?.[binding] as
      | { eventSchema?: string }
      | undefined)?.eventSchema;
    const schema = linkedSchema(
      schemas.find((entry) => entry.id === declared)?.schema as
        | Schema
        | undefined,
    ) ?? true;
    return perturbed(event, schema, schema, `event-${binding}`);
  };
  const once = events.map(({ binding, event }) => ({
    binding,
    event: changed(binding, event),
  }));
  const twice = once.map(({ binding, event }) => ({
    binding,
    event: changed(binding, event),
  }));
  return [
    ...events.map(({ binding, event }) => ({ binding, event })).reverse(),
    ...once,
    ...twice.reverse(),
  ];
};

/** One labeled input and the run with its value alone changed. */
export type Source = {
  /** The input's name, or `PROFILE_SOURCE`. */
  name: string;
  /** The run, where the changed value gave one. */
  instance?: Instance;
  /** Why there is no run: the value could not be changed, or the run threw. */
  failed?: string;
};

/** The runs of one scenario that `perturbedRuns` made. */
export type PerturbedRuns = {
  /** Why no dependency was determined, where none was. */
  skipped?: string;
  /** The run on the scenario as given. */
  baseline?: Instance;
  sources: Source[];
  /** The runs made, the two as given included. */
  runs: number;
  /** Milliseconds all the runs took. */
  ms: number;
};

const firstLine = (error: unknown): string =>
  `${(error as Error)?.message ?? error}`.split("\n")[0].slice(0, 120);

/**
 * The runs in memory of one scenario, advanced one event at a time: the
 * scenario as given, twice, and once for each labeled input with that
 * input alone changed (`perturbed`). `start` makes the runs with no event
 * sent, each call of `advance` sends the next event to every run, `finish`
 * sends the events left to each run, one run after the other, and `runs`
 * gives the runs as they then are. Where the two runs as given
 * differ when `runs` is called, or the scenario read the clock, there are no
 * determined dependencies from then on, and `runs` gives the reason.
 */
export const steppedRuns = (
  artifact: Artifact,
  argument: Record<string, unknown>,
  events: readonly Sent[],
  options: ReturnType<typeof instanceOptions>,
  inputs: Record<string, LabeledInput>,
): {
  start(whole?: boolean): Promise<void>;
  advance(): void;
  finish(): void;
  runs(): PerturbedRuns;
} => {
  const began = performance.now();
  let runs = 0;
  let sent = 0;
  const wishes = hasWish(artifact.plan);
  const start = async (
    given: Record<string, unknown>,
    profile?: (value: unknown) => unknown,
  ): Promise<Instance> => {
    runs += 1;
    const home = wishes ? await memoryHome() : undefined;
    if (home !== undefined && profile !== undefined) {
      home.profile.value = profile(home.profile.value);
    }
    const stubs = home === undefined ? undefined : homeStubs(home);
    // The draws of the start are seeded as those of each event are, so
    // that two runs draw alike.
    seedRandom(eventSeed(-1));
    try {
      const instance = drawing(() =>
        new Instance(artifact, structuredClone(given), {
          ...options,
          // The clock holds one time in every run.
          now: 0,
          ...(stubs === undefined
            ? {}
            : { documents: stubs.documents, wishes: stubs.wishes }),
        })
      );
      // From here on the store keeps which members of each array the
      // events appended (`appendedElsewhere`).
      instance.store.appended = new Map();
      return instance;
    } finally {
      restoreRandom();
    }
  };
  const send = (instance: Instance, { index, binding, event, at }: Sent) => {
    seedRandom(eventSeed(index));
    try {
      drawing(() => instance.send(binding, structuredClone(event), at));
    } finally {
      restoreRandom();
    }
  };
  const done = (result: Omit<PerturbedRuns, "runs" | "ms">) => ({
    ...result,
    runs,
    ms: performance.now() - began,
  });
  let baseline: Instance | undefined;
  let again: Instance | undefined;
  let skipped: string | undefined;
  // Whether the two runs as given handled every event at their start.
  let advanced = false;
  const sources: Source[] = [];
  const current = (): PerturbedRuns => {
    if (skipped === undefined && baseline !== undefined) {
      if (baseline.store.docs.has(CLOCK)) skipped = "reads the clock";
      else if (
        JSON.stringify(baseline.result()) !== JSON.stringify(again?.result())
      ) skipped = "two runs on one scenario give different values";
    }
    return skipped !== undefined
      ? done({ skipped, sources: [] })
      : done({ baseline, sources: sources.map((source) => ({ ...source })) });
  };
  return {
    start: async (whole = false) => {
      try {
        // Two runs that `advance` takes through each event one after the
        // other handle the event within the same millisecond, and so agree
        // on a value made from the time of day. So two runs handle every
        // event one run after the other first, and where they differ no
        // dependency is determined. With `whole`, they are the two runs as
        // given, and `finish` sends the events to the other runs alone.
        const first = await start(argument);
        for (const event of events) send(first, event);
        const second = await start(argument);
        for (const event of events) send(second, event);
        if (first.store.docs.has(CLOCK)) {
          skipped = "reads the clock";
          return;
        }
        if (
          JSON.stringify(first.result()) !== JSON.stringify(second.result())
        ) {
          skipped = "two runs on one scenario give different values";
          return;
        }
        advanced = whole;
        baseline = whole ? first : await start(argument);
        again = whole ? second : await start(argument);
      } catch (error) {
        skipped = `the run in memory fails: ${firstLine(error)}`;
        return;
      }
      const attempt = async (
        name: string,
        given: Record<string, unknown> | undefined,
        profile?: (value: unknown) => unknown,
      ) => {
        if (given === undefined) {
          sources.push({ name, failed: "no value of the type differs" });
          return;
        }
        try {
          sources.push({ name, instance: await start(given, profile) });
        } catch (error) {
          sources.push({ name, failed: firstLine(error) });
        }
      };
      for (const [name, input] of Object.entries(inputs)) {
        if (!(name in argument)) continue;
        const schema = input.schema as Schema;
        const changed = perturbed(argument[name], schema, schema, name);
        await attempt(
          name,
          JSON.stringify(changed) === JSON.stringify(argument[name])
            ? undefined
            : { ...argument, [name]: changed },
        );
      }
      if (wishes) {
        await attempt(PROFILE_SOURCE, argument, (value) => perturbed(value));
      }
    },
    advance: () => {
      const next = events[sent];
      sent += 1;
      if (next === undefined || skipped !== undefined) return;
      try {
        send(baseline!, next);
        send(again!, next);
      } catch (error) {
        skipped = `the run in memory fails: ${firstLine(error)}`;
        return;
      }
      for (const source of sources) {
        if (source.instance === undefined) continue;
        try {
          send(source.instance, next);
        } catch (error) {
          source.instance = undefined;
          source.failed = firstLine(error);
        }
      }
    },
    finish: () => {
      const rest = events.slice(sent);
      sent = events.length;
      if (skipped !== undefined) return;
      try {
        if (!advanced) {
          for (const event of rest) send(baseline!, event);
          for (const event of rest) send(again!, event);
        }
      } catch (error) {
        skipped = `the run in memory fails: ${firstLine(error)}`;
        return;
      }
      for (const source of sources) {
        if (source.instance === undefined) continue;
        try {
          for (const event of rest) send(source.instance, event);
        } catch (error) {
          source.instance = undefined;
          source.failed = firstLine(error);
        }
      }
    },
    runs: current,
  };
};

/**
 * Runs the scenario in memory as given, twice, and once for each labeled
 * input with that input alone changed (`perturbed`), with every event sent
 * (`steppedRuns`). A scenario whose two runs as given differ, or that reads
 * the clock, has no determined dependencies and is skipped with the reason.
 */
export const perturbedRuns = async (
  artifact: Artifact,
  argument: Record<string, unknown>,
  events: readonly Sent[],
  options: ReturnType<typeof instanceOptions>,
  inputs: Record<string, LabeledInput>,
): Promise<PerturbedRuns> => {
  const stepped = steppedRuns(artifact, argument, events, options, inputs);
  await stepped.start(true);
  stepped.finish();
  return stepped.runs();
};

/**
 * The events of a scenario, each with the elements it is sent at: where the
 * binding of an event is in an element body, the event is sent to the
 * stream of the last element that a run in memory holds one for when the
 * events before it were handled.
 */
export const sentEvents = (
  artifact: Artifact,
  argument: Record<string, unknown>,
  events: readonly { binding: number; event: unknown }[],
  options: ReturnType<typeof instanceOptions>,
): Sent[] => {
  const instance = new Instance(artifact, structuredClone(argument), {
    ...options,
    now: 0,
  });
  return events.map(({ binding, event }, index) => {
    const at = instance.streams().findLast((stream) =>
      stream.binding === binding && stream.elements !== undefined
    )?.elements ?? [];
    seedRandom(eventSeed(index));
    try {
      drawing(() =>
        instance.send(binding, structuredClone(event), at)
      );
    } finally {
      restoreRandom();
    }
    return { index, binding, event, at };
  });
};

/** The value at `path` of a value read with every link followed. */
export const valueAt = (value: unknown, path: readonly string[]): unknown => {
  let at = value;
  for (const segment of path) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string, unknown>)[segment];
  }
  return at;
};

/**
 * The paths of `value` that `pattern` names, with each `*` of it replaced
 * by each index of the array, or each name of the object, the value holds
 * there.
 */
export const concretePaths = (
  pattern: readonly string[],
  value: unknown,
): string[][] => {
  let found: { path: string[]; at: unknown }[] = [{ path: [], at: value }];
  for (const segment of pattern) {
    found = found.flatMap(({ path, at }) => {
      if (segment !== "*") {
        return [{ path: [...path, segment], at: valueAt(at, [segment]) }];
      }
      if (typeof at !== "object" || at === null) return [];
      return Object.keys(at).map((key) => ({
        path: [...path, key],
        at: (at as Record<string, unknown>)[key],
      }));
    });
  }
  return found.map(({ path }) => path);
};

/**
 * Whether the member that the run `checked` holds at a position on the way
 * to `path` stands at another position of the same array in the run
 * `other`, and appends alone put it where it stands in both.
 *
 * `path` is a path below a root that `valueOf` reads in a run, with every
 * link followed, and that `refOf` names in the run's store. For each
 * segment of `path` that is a position `p` of an array `L` of `checked`,
 * the answer is yes where all of these hold:
 *
 * - `L` is an array in both runs;
 * - `p` is at or behind the first position that the store of `checked`
 *   records for `L` as placed by additions at its end, with no member of
 *   `L` removed, moved or replaced at or behind that position since
 *   (`Store.appendedFrom`);
 * - the member at `p` equals the member at a position `q` of `L` in
 *   `other`, `q` differs from `p`, and `q` is at or behind the first such
 *   position that the store of `other` records for `L`.
 *
 * A removal or a reorder in either run takes the record of the array away
 * in that run, so a member one of them moved is never found this way: the
 * criterion reads what the stores recorded of each change, and not the
 * values alone, which a removal and a missing addition can leave the same.
 * A member appended after such a change is found: `afterOtherChange` of
 * the answer says that one of the two runs made a change of `L` other than
 * an addition at its end, so the position of the member differs for that
 * change too and not for additions alone.
 */
export const appendedElsewhere = (
  checked: Instance,
  other: Instance,
  path: readonly string[],
  valueOf: (run: Instance, path: readonly string[]) => unknown,
  refOf: (run: Instance, path: readonly string[]) => Ref,
): { afterOtherChange: boolean } | undefined => {
  for (let at = 0; at < path.length; at++) {
    if (!/^(0|[1-9][0-9]*)$/.test(path[at])) continue;
    const list = path.slice(0, at);
    const position = Number(path[at]);
    const here = valueOf(checked, list);
    const there = valueOf(other, list);
    if (
      !Array.isArray(here) || !Array.isArray(there) ||
      position >= here.length
    ) continue;
    const from = checked.store.appendedFrom(refOf(checked, list));
    const otherFrom = other.store.appendedFrom(refOf(other, list));
    if (
      from === undefined || otherFrom === undefined || position < from
    ) continue;
    const member = JSON.stringify(here[position]);
    for (let found = otherFrom; found < there.length; found++) {
      if (found !== position && JSON.stringify(there[found]) === member) {
        return {
          afterOtherChange:
            checked.store.changedOtherwiseAt(refOf(checked, list)) ||
            other.store.changedOtherwiseAt(refOf(other, list)),
        };
      }
    }
  }
  return undefined;
};
