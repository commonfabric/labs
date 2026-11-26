/**
 * Measures what one change of a list costs in part documents
 * (`../exec/parts.ts`, provisional decision P20), at several lengths of
 * the list and two sizes of a row, on `fixtures/lists.tsx`: the
 * documents that the change wrote and their bytes, the documents that a
 * reader passes through for one row of the result and for its first 20
 * rows, the documents stored in all, and the time.
 *
 * `deno run -A --no-check base/pattern-compiler/compare/parts-growth.ts [--counts=none] [--identity=minted] [--max=bytes] [--min=bytes] [--wide] [lengths]`
 *
 * The cases are a `map` over an array of references, each to a cell that
 * is a document of its own; over an array of plain values in place with
 * no declared key; the same with a key field declared with `ArrayByKey`;
 * and over the result of a `filter` of plain values in place. No case is
 * of a plain array generated from scratch, and none of a `flatMap`.
 */
import { type Artifact, Instance } from "../exec/executor.ts";
import type { PartsOptions } from "../exec/parts.ts";
import { argumentOf, Ref } from "../exec/store.ts";

const ARGUMENT = argumentOf("result");

/** A row of about 23 bytes of title and flags, or of about 2,000. */
const item = (index: number, wide: boolean) => ({
  id: `i${index}`,
  title: wide ? `t${index}`.padEnd(1_960, "x") : `t${index}`,
  done: false,
});

type Case = { name: string; pattern: string; references: boolean };

export const CASES: Case[] = [
  { name: "references", pattern: "Plain", references: true },
  { name: "plain values, no key", pattern: "Plain", references: false },
  { name: "plain values, ArrayByKey", pattern: "Keyed", references: false },
  { name: "result of a filter", pattern: "Chained", references: false },
];

export const OPERATIONS = [
  "append",
  "prepend",
  "edit one field",
  "remove first",
  "remove last",
] as const;

/** One measured change. */
export type PartsMeasured = {
  case: string;
  length: number;
  wide: boolean;
  operation: string;
  /** The part documents written, and the bytes that they hold. */
  documents: number;
  bytes: number;
  /**
   * The bytes that the change put into the documents: what the writer
   * of the argument wrote, and what the derivation wrote of the result.
   * It is what a store that takes a patch below a path would be sent.
   */
  patchBytes: number;
  created: number;
  deleted: number;
  /** The documents read for row `length / 2` of the result, and for its
   * first 20 rows. */
  readOne: number;
  readTwenty: number;
  /** The documents stored, and those of the argument's and the
   * result's arrays: chunks and lists, and parts. */
  total: number;
  argumentChunks: number;
  resultChunks: number;
  resultParts: number;
  /** The mean time of `LATER` such changes on one instance. */
  milliseconds: number;
};

const LATER = 20;

const cell = (index: number) => `cell-${index}`;

/** An instance of a case, settled, with its part documents. */
export const start = (
  artifact: Artifact,
  { references }: Case,
  length: number,
  wide: boolean,
  parts: PartsOptions = {},
): Instance => {
  const items = Array.from({ length }, (_, index) => item(index, wide));
  const instance = new Instance(
    artifact,
    references
      ? {
        items: items.map((_, index) => ({
          $link: { doc: cell(index), path: [] },
        })),
      }
      : { items },
    { measure: "patches", parts },
  );
  if (references) {
    items.forEach((held, index) =>
      instance.store.create(cell(index), "cell", held)
    );
  }
  instance.settle();
  return instance;
};

/** Makes one change of a kind, the `turn`-th on its instance. */
export const change = (
  instance: Instance,
  { references }: Case,
  operation: typeof OPERATIONS[number],
  length: number,
  wide: boolean,
  turn: number,
): number => {
  const bytes = (value: unknown) => JSON.stringify(value).length;
  const added = () => {
    const index = length + turn;
    if (!references) return item(index, wide);
    instance.store.create(cell(index), "cell", item(index, wide));
    return { $link: { doc: cell(index), path: [] } };
  };
  if (operation === "append") {
    const { items } = instance.store.docs.get(ARGUMENT)?.value as {
      items: unknown[];
    };
    const member = added();
    instance.spliceArgument(["items"], items.length, 0, [member]);
    return bytes(member);
  } else if (operation === "prepend") {
    const member = added();
    instance.spliceArgument(["items"], 0, 0, [member]);
    return bytes(member);
  } else if (operation === "edit one field") {
    const at = (length >> 1) + turn;
    // The edit keeps the size of the row.
    const title = wide ? `edited${turn}`.padEnd(1_960, "y") : `edited${turn}`;
    if (references) {
      instance.store.write(new Ref(cell(at), ["title"]), title);
      instance.settle();
    } else {
      instance.writeArgument(["items", `${at}`, "title"], title);
    }
    return bytes(title);
  } else if (operation === "remove first") {
    instance.spliceArgument(["items"], 0, 1, []);
    return 0;
  } else {
    const { items } = instance.store.docs.get(ARGUMENT)?.value as {
      items: unknown[];
    };
    instance.spliceArgument(["items"], items.length - 1, 1, []);
    return 0;
  }
};

/** Measures the five changes of one case at one length. */
export const measure = (
  artifact: Artifact,
  one: Case,
  length: number,
  wide: boolean,
  parts: PartsOptions = {},
): PartsMeasured[] =>
  OPERATIONS.map((operation) => {
    const instance = start(artifact, one, length, wide, parts);
    const stored = instance.store.parts!;
    const before = instance.transactions.length;
    let patchBytes = change(instance, one, operation, length, wide, 0);
    const written = new Map<string, number>();
    let created = 0;
    let deleted = 0;
    for (
      const { parted, patchBytes: put } of instance.transactions.slice(before)
    ) {
      patchBytes += put;
      for (const { id, bytes } of parted?.written ?? []) written.set(id, bytes);
      created += parted?.created ?? 0;
      deleted += parted?.deleted ?? 0;
    }
    const began = performance.now();
    for (let turn = 1; turn <= LATER; turn++) {
      change(instance, one, operation, length, wide, turn);
    }
    const milliseconds = (performance.now() - began) / LATER;
    const rows = stored.describe(instance.id, ["rows"]);
    return {
      case: one.name,
      length,
      wide,
      operation,
      documents: written.size,
      bytes: [...written.values()].reduce((sum, bytes) => sum + bytes, 0),
      patchBytes,
      created,
      deleted,
      readOne: stored.counting(() =>
        stored.read(instance.id, ["rows", `${length >> 1}`])
      ).documents,
      readTwenty: stored.counting(() =>
        stored.rows(instance.id, ["rows"], 0, 20)
      ).documents,
      total: stored.size,
      argumentChunks: stored.describe(ARGUMENT, ["items"]).chunks,
      resultChunks: rows.chunks,
      resultParts: rows.parts,
      milliseconds: Math.round(milliseconds * 1000) / 1000,
    };
  });

export const artifactsOf = async (): Promise<Artifact[]> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/lists.emit.json", import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns;
};

if (import.meta.main) {
  const flags = Deno.args.filter((argument) => argument.startsWith("--"));
  const given = Deno.args.filter((argument) => !argument.startsWith("--"));
  const lengths = given.length > 0
    ? given.map(Number)
    : [100, 1_000, 10_000, 100_000];
  const parts: PartsOptions = {
    counts: flags.includes("--counts=none") ? "none" : "stored",
    identity: flags.includes("--identity=minted") ? "minted" : "key",
  };
  for (const flag of flags) {
    const [name, value] = flag.split("=");
    if (name === "--max") parts.documentMaxBytes = Number(value);
    if (name === "--min") parts.partMinBytes = Number(value);
  }
  const patterns = await artifactsOf();
  for (const one of CASES) {
    const artifact = patterns.find(({ name }) => name === one.pattern)!;
    for (const length of lengths) {
      for (
        const row of measure(
          artifact,
          one,
          length,
          flags.includes("--wide"),
          parts,
        )
      ) {
        console.log(JSON.stringify({ ...parts, ...row }));
      }
    }
  }
}
