/**
 * Measures two things that follow from the rule that the key of a plain
 * value is formed from the value, on `fixtures/rows-state.tsx`, where
 * each row has a state cell, a handler binding with a stream, a `lift`
 * in the body and a child instance (plan questions 254 and 255).
 *
 * `deno run -A --no-check base/pattern-compiler/compare/rekey-cost.ts keystrokes [lengths]`
 * prints what one keystroke in the title of one row costs the executor:
 * an event whose handler writes one member through the element of the
 * row, twenty times, as the mean of one. The cases are an array of plain
 * values in place with no declared key, the same with a key field
 * declared with `ArrayByKey`, and an array of references.
 *
 * `deno run -A --no-check base/pattern-compiler/compare/rekey-cost.ts polled [length] [rounds]`
 * prints the documents that the executor holds, by kind, after a writer
 * outside the instance replaced every element of a list of plain values
 * with a new value that many times, as a polled list is replaced.
 */
import { type Artifact, Instance } from "../exec/executor.ts";
import { argumentOf } from "../exec/store.ts";

const ARGUMENT = argumentOf("result");
const KEYSTROKES = 20;

const item = (index: number, round = 0) => ({
  id: `i${index}`,
  title: round === 0 ? `t${index}` : `t${index} r${round}`,
  done: false,
});

type Case = { name: string; pattern: string; references: boolean };

export const CASES: Case[] = [
  {
    name: "plain values in place, no declared key",
    pattern: "Plain",
    references: false,
  },
  {
    name: "plain values in place, ArrayByKey",
    pattern: "Keyed",
    references: false,
  },
  { name: "references", pattern: "Plain", references: true },
];

export const artifacts = async (): Promise<Artifact[]> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/rows-state.emit.json", import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns;
};

export const start = (
  patterns: Artifact[],
  { pattern, references }: Case,
  length: number,
): Instance => {
  const items = Array.from({ length }, (_, index) => item(index));
  return new Instance(
    patterns.find(({ name }) => name === pattern)!,
    references
      ? {
        pool: Object.fromEntries(items.map((held, index) => [index, held])),
        items: items.map((_, index) => ({
          $link: { doc: ARGUMENT, path: ["pool", `${index}`] },
        })),
      }
      : { items },
    {
      artifacts: (id) => patterns.find(({ plan }) => plan.patterns?.[0] === id),
      // The bytes of whole documents are not counted: forming them
      // would be most of the time of a keystroke.
      measure: "patches",
    },
  );
};

/** What one keystroke costs: the mean over `KEYSTROKES` events. */
export const keystrokes = (
  patterns: Artifact[],
  one: Case,
  length: number,
) => {
  const instance = start(patterns, one, length);
  const rename = instance.plan.bindings.findIndex(({ name }) =>
    name === "rename"
  );
  const before = {
    transactions: instance.transactions.length,
    moves: instance.store.moves,
    hashes: instance.store.hashes,
    evaluations: instance.counts.evaluations,
    children: instance.childInstances().length,
    documents: instance.store.docs.size,
  };
  const row = Math.floor(length / 2);
  const began = performance.now();
  for (let stroke = 1; stroke <= KEYSTROKES; stroke++) {
    const outcome = instance.send(rename, { text: "x".repeat(stroke) }, [row]);
    if (!outcome.committed) throw new Error(outcome.error);
  }
  const milliseconds = (performance.now() - began) / KEYSTROKES;
  const transactions = instance.transactions.slice(before.transactions);
  const sum = (of: (transaction: typeof transactions[0]) => number) =>
    transactions.reduce((total, transaction) => total + of(transaction), 0) /
    KEYSTROKES;
  return {
    case: one.name,
    length,
    documentsWritten: sum(({ written }) => written.length),
    documentsMoved: (instance.store.moves - before.moves) / KEYSTROKES,
    patchBytes: sum(({ patchBytes }) => patchBytes),
    // The part documents written (provisional decision P20), and the
    // bytes that those hold.
    partedDocuments: sum(({ parted }) => parted?.written.length ?? 0),
    partedBytes: sum(({ parted }) => parted?.bytes ?? 0),
    partedCreated: sum(({ parted }) => parted?.created ?? 0),
    partedDeleted: sum(({ parted }) => parted?.deleted ?? 0),
    resultDocuments: sum(({ stored }) => stored.documents),
    partsCreated: sum(({ stored }) => stored.created),
    partsDeleted: sum(({ stored }) => stored.deleted),
    hashes: (instance.store.hashes - before.hashes) / KEYSTROKES,
    evaluations: (instance.counts.evaluations - before.evaluations) /
      KEYSTROKES,
    instancesMade: (instance.childInstances().length - before.children) /
      KEYSTROKES,
    documentsAdded: (instance.store.docs.size - before.documents) /
      KEYSTROKES,
    milliseconds: Math.round(milliseconds * 1000) / 1000,
  };
};

/** The documents held after each of some rounds of a polled list. */
export const polled = (
  patterns: Artifact[],
  one: Case,
  length: number,
  rounds: number,
  report: number[],
) => {
  const instance = start(patterns, one, length);
  const rows = [];
  for (let round = 0; round <= rounds; round++) {
    if (round > 0) {
      if (one.references) {
        for (let index = 0; index < length; index++) {
          instance.store.write(
            instance.store.locate(
              // deno-lint-ignore no-explicit-any
              { doc: ARGUMENT, path: ["pool", `${index}`] } as any,
              false,
            ).ref,
            item(index, round),
          );
        }
        instance.settle();
      } else {
        instance.writeArgument(
          ["items"],
          Array.from({ length }, (_, index) => item(index, round)),
        );
      }
    }
    if (!report.includes(round)) continue;
    rows.push({
      case: one.name,
      length,
      round,
      documents: instance.store.docs.size,
      partDocuments: instance.store.parts?.size ?? 0,
      byKind: instance.documents(),
      instances: instance.childInstances().length,
    });
  }
  return rows;
};

if (import.meta.main) {
  const [command, ...given] = Deno.args;
  const patterns = await artifacts();
  if (command === "keystrokes") {
    const lengths = given.length > 0 ? given.map(Number) : [100, 1_000, 10_000];
    for (const one of CASES) {
      for (const length of lengths) {
        console.log(JSON.stringify(keystrokes(patterns, one, length)));
      }
    }
  } else if (command === "polled") {
    const length = Number(given[0] ?? 100);
    const rounds = Number(given[1] ?? 100);
    for (const one of CASES) {
      for (
        const row of polled(patterns, one, length, rounds, [0, 1, 10, rounds])
      ) {
        console.log(JSON.stringify(row));
      }
    }
  } else {
    console.error(
      "rekey-cost.ts keystrokes [lengths] | polled [length] [rounds]",
    );
    Deno.exit(1);
  }
}
