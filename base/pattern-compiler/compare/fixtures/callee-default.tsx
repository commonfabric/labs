/// <cts-enable />
import { computed, type Default, lift, pattern } from "commonfabric";

interface PriceInput {
  amount: number;
  symbol?: Default<string, "$">;
}

const spell = lift((x: { symbol: string }) => x.symbol.split("").join("-"));

// The callee declares a default for `symbol`. Ruling Z4: a call that
// leaves the path out binds it to that default as a constant, and a call
// that binds it to a slot of the caller reads the default where nothing is
// stored at the slot.
const Price = pattern<PriceInput>(({ amount, symbol }) => {
  const shown = computed(() => symbol + amount);
  const spelled = spell({ symbol });
  return { shown, spelled };
});

interface Input {
  amount: number;
  sign: string;
}

export default pattern<Input>(({ amount, sign }) => {
  const omitted = Price({ amount });
  const bound = Price({ amount, symbol: sign });
  return {
    omitted: omitted.shown,
    omittedSpelled: omitted.spelled,
    bound: bound.shown,
    boundSpelled: bound.spelled,
  };
});
