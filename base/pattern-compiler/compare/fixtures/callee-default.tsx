/// <cts-enable />
import {
  computed,
  type Default,
  handler,
  lift,
  pattern,
  Writable,
} from "commonfabric";

interface PriceInput {
  amount: number;
  symbol?: Default<string, "$">;
}

const spell = lift((x: { symbol: string }) => x.symbol.split("").join("-"));

// A handler of the callee whose state is the path.
const append = handler<unknown, { symbol: Writable<string> }>(
  (_, { symbol }) => {
    symbol.set(symbol.get() + "!");
  },
);

// The callee declares a default for `symbol`. Ruling Z4: a call that
// leaves the path out binds it to that default as a constant, and a call
// that binds it to a slot of the caller reads the default where nothing is
// stored at the slot. Ruling Z16: a sandboxed body finds the default
// through `Body.reads`.
const Price = pattern<PriceInput>(({ amount, symbol }) => {
  const shown = computed(() => symbol + amount);
  const spelled = spell({ symbol });
  return { shown, spelled };
});

// Ruling Z16: this callee reads nothing of `symbol`. It passes the path
// on by reference, and the reference carries the callee's default. The
// state of its handler is the path as well.
const Marked = pattern<{ symbol?: Default<string, "$"> }>(({ symbol }) => {
  return { symbol, append: append({ symbol }) };
});

interface Row {
  amount: number;
  sign?: string;
}

interface Input {
  amount: number;
  sign: string;
  mark?: Default<string, "#">;
  rows: Row[];
  words: string[];
}

export default pattern<Input>(({ amount, sign, mark, rows, words }) => {
  const omitted = Price({ amount });
  const bound = Price({ amount, symbol: sign });
  // The caller's place declares a default of its own.
  const defaulted = Price({ amount, symbol: mark });
  const marked = Marked({ symbol: sign });
  const markedDefaulted = Marked({ symbol: mark });
  return {
    omitted: omitted.shown,
    omittedSpelled: omitted.spelled,
    bound: bound.shown,
    boundSpelled: bound.spelled,
    // The result of the callee, whose `symbol` passes the path on.
    marked,
    defaulted: defaulted.shown,
    defaultedSpelled: defaulted.spelled,
    markedDefaulted,
    // The callee in an element body, with the path bound to a member of
    // the element.
    priced: rows.map((row) => {
      const price = Price({ amount: row.amount, symbol: row.sign });
      return { shown: price.shown, spelled: price.spelled };
    }),
    // The same over the result of another per-element construct.
    cheap: rows.filter((row) => row.amount < 10).map((row) => {
      const price = Price({ amount: row.amount, symbol: row.sign });
      return { shown: price.shown, spelled: price.spelled };
    }),
    // Over plain values in place, with the path bound to the caller's
    // slot outside the body.
    tagged: words.map((word) => {
      const price = Price({ amount, symbol: sign });
      return { word, shown: price.shown, spelled: price.spelled };
    }),
  };
});
