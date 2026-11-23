/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

const GLAZES = ["plain", "sugar"];
const MENU = { sizes: [1, 2, 3] };
const PRICES = new Map([["plain", 2], ["sugar", 3]]);
const SEASONAL = new Set(["pumpkin"]);

function labelOf(glaze: string): string {
  return `${glaze} donut`;
}

const priceOf = (glaze: string): number => PRICES.get(glaze) ?? 0;

const summaryOf = (glaze: string): string =>
  [
    labelOf(glaze),
    priceOf(glaze),
    GLAZES.length,
    MENU.sizes.length,
    SEASONAL.size,
  ].join();

const record = handler<{ glaze: string }, { last: Writable<string> }>(
  (event, { last }) => {
    last.set(summaryOf(event.glaze));
  },
);

interface Output {
  last: string;
  record: Stream<{ glaze: string }>;
}

export default pattern<Record<string, never>, Output>(() => {
  const last = Writable.of("");
  return { last, record: record({ last }) };
});
