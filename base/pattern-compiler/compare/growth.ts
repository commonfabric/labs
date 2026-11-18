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
  bytes: number;
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
    );
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
    const milliseconds = Math.round(
      performance.now() - (instance === undefined ? began : at),
    );
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
      milliseconds,
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
    instance.writeArgument(["items"], [...held(instance), added(instance)]);
  });
  run("prepend", (instance) => {
    instance.writeArgument(["items"], [added(instance), ...held(instance)]);
  });
  run("edit one field", (instance) => {
    instance.writeArgument(
      references ? ["pool", "0", "title"] : ["items", "0", "title"],
      "edited",
    );
  });
  run("remove first", (instance) => {
    instance.writeArgument(["items"], held(instance).slice(1));
  });
  return measured;
};

if (import.meta.main) {
  const lengths = Deno.args.length > 0
    ? Deno.args.map(Number)
    : [100, 1_000, 10_000];
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/lists.emit.json", import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  for (const one of CASES) {
    const artifact = patterns.find(({ name }) => name === one.pattern);
    if (artifact === undefined) throw new Error(`no pattern ${one.pattern}`);
    for (const length of lengths) {
      for (const row of measure(artifact, one, length)) {
        console.log(JSON.stringify(row));
      }
    }
  }
}
