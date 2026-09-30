import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  ComparableCell,
  Default,
  LiftFunction,
  ReadonlyCell,
} from "@commonfabric/api";
import type { Same } from "@commonfabric/utils/types";

// `lift` is ambient in this package — the callable lives in the runner's
// builder — so every probe below sits inside a function that is never called.
// The assertions are the type checker's, and `deno check` is what runs them.
// They are value-position guards rather than `MustBeTrue<...>` type aliases: a
// failed `Same` evaluates to `false`, and assigning `false` to a `true`-typed
// const is the error that makes an assertion bite. `MustBeTrue<T extends true>`
// accepts a failing assertion whose result is `never`, and so can pass
// vacuously.
declare const lift: LiftFunction;

interface Summary {
  title: string;
  body: string;
}

interface Row {
  key: string;
  payload: Summary;
}

interface Item {
  title: string;
  mentions: ComparableCell<unknown>[] | Default<[]>;
}

declare const rows: Row[];
declare const items: Item[];

// A generic implementation states that its result IS its input: the body reads
// `.key` and forwards the element whole. Nothing in the body can mint a `T`, so
// the only value it can return is one it was handed — which is what makes the
// declaration a claim the compiler checks rather than an assertion it takes on
// trust.
function _passesTheCallersElementThrough() {
  const keyed = lift(<T extends { key: string }>(
    { rows }: { rows: T[] | Default<[]> },
  ): T[] => rows.filter((row) => row.key !== ""));

  const kept = keyed({ rows });
  const _keptIsTheCallersRow: Same<typeof kept, Row[]> = true;
  // Reading a field the implementation never declared is the same statement
  // said the other way around.
  const _payloadIsReadable: Same<typeof kept[number]["payload"], Summary> =
    true;
  return [_keptIsTheCallersRow, _payloadIsReadable];
}

// The type parameter under a cell wrapper: how a derivation declares that it
// compares references without reading through them.
function _passesThroughACellWrapper() {
  const pivot = lift(<T extends { mentions: unknown[] }>(
    { sources }: { sources: ReadonlyCell<T>[] | Default<[]> },
  ): { source: ReadonlyCell<T>; count: number }[] =>
    sources.map((source) => ({
      source,
      count: source.get().mentions.length,
    }))
  );

  const table = pivot({ sources: items });
  const _rowsKeepTheCallersItem: Same<
    typeof table,
    { source: ReadonlyCell<Item>; count: number }[]
  > = true;
  return [_rowsKeepTheCallersItem];
}

// An implementation with no type parameter declares its own result and carries
// nothing through, which is the ordinary case and stays what it was.
function _declaresItsOwnResult() {
  const lastActivity = lift((
    { createdAt, comments }: { createdAt: number; comments: { at: number }[] },
  ): number => Math.max(createdAt, ...comments.map((comment) => comment.at)));

  const at = lastActivity({ createdAt: 0, comments: [] });
  const _resultIsTheDeclaredNumber: Same<typeof at, number> = true;
  return [_resultIsTheDeclaredNumber];
}

describe("lift-passthrough-types", () => {
  it("holds its assertions at compile time", () => {
    // Every assertion above is a value-position type guard settled by
    // `deno check`. This case keeps the file a test module, so a file that
    // stops being type-checked stops counting as a passing test too.
    expect([
      typeof _passesTheCallersElementThrough,
      typeof _passesThroughACellWrapper,
      typeof _declaresItsOwnResult,
    ]).toEqual(["function", "function", "function"]);
  });
});
