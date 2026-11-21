/**
 * Measures what one change of a list costs the executor of `../exec/`,
 * at several lengths of the list (`fixtures/lists.tsx`): the evaluations,
 * the formations of the keys of an array, the salted hashes, the checks
 * of memo entries, the documents and the bytes written, and the wall
 * time of one run.
 *
 * `deno run -A --no-check base/pattern-compiler/compare/growth.ts [lengths]`
 *
 * The cases are an array of references, an array of plain values in
 * place with no declared key, the same with a key field declared with
 * `ArrayByKey`, and the result of a `filter` over plain values in place.
 * Each change is a write to the argument document by a writer outside
 * the instance, with the derivation transaction that follows it.
 */
import { type Artifact, Instance } from "../exec/executor.ts";
import { argumentOf, Ref } from "../exec/store.ts";

const ARGUMENT = argumentOf("result");

const item = (index: number) => ({
  id: `i${index}`,
  title: `t${index}`,
  done: false,
});

type Case = {
  name: string;
  pattern: string;
  references: boolean;
};

const CASES: Case[] = [
  { name: "references", pattern: "Plain", references: true },
  { name: "plain values, no key", pattern: "Plain", references: false },
  { name: "plain values, ArrayByKey", pattern: "Keyed", references: false },
  { name: "result of a filter", pattern: "Chained", references: false },
];

/** One measured change. */
export type Measured = {
  case: string;
  length: number;
  operation: string;
  evaluations: number;
  keyings: number;
  hashes: number;
  checks: number;
  documents: number;
  /** The bytes of the documents written, each whole. */
  bytes: number;
  /** The bytes of what the changes put into the documents. */
  patchBytes: number;
  /**
   * The time of the change as the first one after the instance
   * settled, and for a change the mean time of the `LATER` changes of
   * the same kind that follow it on one instance.
   */
  milliseconds: number;
  later?: number;
};

/** How many further changes of a kind are timed on one instance. */
const LATER = 40;

const link = (index: number) => ({
  $link: { doc: ARGUMENT, path: ["pool", `${index}`] },
});

/** Measures the four changes of one case at one length. */
export const measure = (
  artifact: Artifact,
  { name, references }: Case,
  length: number,
  options: ConstructorParameters<typeof Instance>[2] = {},
  /** How many times each change is made for its time, each on an
   * instance of its own; the time is the median. */
  repeats = 1,
): Measured[] => {
  const measured: Measured[] = [];
  const start = () => {
    const items = Array.from({ length }, (_, index) => item(index));
    return new Instance(
      artifact,
      references
        ? {
          pool: Object.fromEntries(items.map((held, index) => [index, held])),
          items: items.map((_, index) => link(index)),
        }
        : { items },
      options,
    );
  };
  // The time of a change, without the counts: on an instance that
  // does not count the bytes of whole documents.
  const timed = (
    change: (instance: Instance, turn: number) => void,
  ): { first: number; later: number } => {
    const times: number[] = [];
    let later = 0;
    for (let repeat = 0; repeat < repeats; repeat++) {
      const items = Array.from({ length }, (_, index) => item(index));
      const instance = new Instance(
        artifact,
        references
          ? {
            pool: Object.fromEntries(
              items.map((held, index) => [index, held]),
            ),
            items: items.map((_, index) => link(index)),
          }
          : { items },
        { ...options, measure: "patches" },
      );
      const at = performance.now();
      change(instance, 0);
      times.push(performance.now() - at);
      if (repeat < repeats - 1) continue;
      const began = performance.now();
      for (let turn = 1; turn <= LATER; turn++) change(instance, turn);
      later = (performance.now() - began) / LATER;
    }
    times.sort((a, b) => a - b);
    return { first: times[Math.floor(times.length / 2)], later };
  };
  const run = (
    operation: string,
    change: (instance: Instance, turn: number) => void,
  ) => {
    const began = performance.now();
    const instance = operation === "settle" ? undefined : start();
    const before = instance === undefined
      ? { evaluations: 0, keyings: 0, hashes: 0, checks: 0, transactions: 0 }
      : {
        evaluations: instance.counts.evaluations,
        keyings: instance.store.keyings,
        hashes: instance.store.hashes,
        checks: instance.checks,
        transactions: instance.transactions.length,
      };
    const at = performance.now();
    const after = instance ?? start();
    if (instance !== undefined) change(instance, 0);
    const once = performance.now() - (instance === undefined ? began : at);
    const times = instance === undefined || repeats === 1
      ? undefined
      : timed(change);
    const milliseconds = times?.first ?? once;
    const transactions = after.transactions.slice(before.transactions);
    measured.push({
      case: name,
      length,
      operation,
      evaluations: after.counts.evaluations - before.evaluations,
      keyings: after.store.keyings - before.keyings,
      hashes: after.store.hashes - before.hashes,
      checks: after.checks - before.checks,
      documents: transactions.reduce(
        (sum, { written }) => sum + written.length,
        0,
      ),
      bytes: transactions.reduce((sum, { bytes }) => sum + bytes, 0),
      patchBytes: transactions.reduce(
        (sum, { patchBytes }) => sum + patchBytes,
        0,
      ),
      milliseconds: Math.round(milliseconds * 1000) / 1000,
      ...(times === undefined
        ? {}
        : { later: Math.round(times.later * 1000) / 1000 }),
    });
  };
  const held = (instance: Instance) =>
    (instance.store.docs.get(ARGUMENT)?.value as { items: unknown[] }).items;
  const added = (instance: Instance, turn: number) => {
    const index = length + turn;
    if (!references) return item(index);
    instance.store.write(
      new Ref(ARGUMENT, ["pool", `${index}`]),
      item(index),
    );
    return link(index);
  };
  run("settle", () => {});
  run("append", (instance, turn) => {
    instance.spliceArgument(["items"], length + turn, 0, [
      added(instance, turn),
    ]);
  });
  run("append, array written whole", (instance, turn) => {
    instance.writeArgument(["items"], [
      ...held(instance),
      added(instance, turn),
    ]);
  });
  run("prepend", (instance, turn) => {
    instance.spliceArgument(["items"], 0, 0, [added(instance, turn)]);
  });
  run("edit one field", (instance, turn) => {
    instance.writeArgument(
      references ? ["pool", `${turn}`, "title"] : ["items", `${turn}`, "title"],
      "edited",
    );
  });
  run("remove first", (instance) => {
    instance.spliceArgument(["items"], 0, 1, []);
  });
  run("remove last", (instance, turn) => {
    instance.spliceArgument(["items"], length - 1 - turn, 1, []);
  });
  return measured;
};

if (import.meta.main) {
  const flags = Deno.args.filter((argument) => argument.startsWith("--"));
  const given = Deno.args.filter((argument) => !argument.startsWith("--"));
  const lengths = given.length > 0 ? given.map(Number) : [100, 1_000, 10_000];
  // `--formed`: the keys of an array are formed again after each write
  // to it, and an assembly is formed whole.
  const options = flags.includes("--formed")
    ? { keys: "formed" as const, assembly: "formed" as const }
    : {};
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/lists.emit.json", import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  for (const one of CASES) {
    const artifact = patterns.find(({ name }) => name === one.pattern);
    if (artifact === undefined) throw new Error(`no pattern ${one.pattern}`);
    for (const length of lengths) {
      for (const row of measure(artifact, one, length, options, 7)) {
        console.log(JSON.stringify(row));
      }
    }
  }
}
