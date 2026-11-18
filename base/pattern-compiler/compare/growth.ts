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
import { argumentOf } from "../exec/store.ts";

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
  milliseconds: number;
};

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
  const timed = (change: (instance: Instance) => void): number => {
    const times: number[] = [];
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
      change(instance);
      times.push(performance.now() - at);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  };
  const run = (operation: string, change: (instance: Instance) => void) => {
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
    if (instance !== undefined) change(instance);
    const milliseconds = instance === undefined || repeats === 1
      ? performance.now() - (instance === undefined ? began : at)
      : timed(change);
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
    });
  };
  const held = (instance: Instance) =>
    (instance.store.docs.get(ARGUMENT)?.value as { items: unknown[] }).items;
  const added = (instance: Instance) => {
    if (!references) return item(length);
    instance.store.write(
      new (Object.getPrototypeOf(
        instance.store.locate(
          // deno-lint-ignore no-explicit-any
          { doc: ARGUMENT, path: [] } as any,
          false,
        ).ref,
      ).constructor)(ARGUMENT, ["pool", `${length}`]),
      item(length),
    );
    return link(length);
  };
  run("settle", () => {});
  run("append", (instance) => {
    instance.spliceArgument(["items"], length, 0, [added(instance)]);
  });
  run("append, array written whole", (instance) => {
    instance.writeArgument(["items"], [...held(instance), added(instance)]);
  });
  run("prepend", (instance) => {
    instance.spliceArgument(["items"], 0, 0, [added(instance)]);
  });
  run("edit one field", (instance) => {
    instance.writeArgument(
      references ? ["pool", "0", "title"] : ["items", "0", "title"],
      "edited",
    );
  });
  run("remove first", (instance) => {
    instance.spliceArgument(["items"], 0, 1, []);
  });
  run("remove last", (instance) => {
    instance.spliceArgument(["items"], length - 1, 1, []);
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
