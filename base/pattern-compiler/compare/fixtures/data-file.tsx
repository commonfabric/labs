/// <cts-enable />
import { computed, dataFile, pattern } from "commonfabric";

// The text of a file of the program, read once where the module is
// evaluated.
const WORDS = JSON.parse(dataFile("./data/words.json")) as string[];

const wordAt = (index: number): string => WORDS[index] ?? "";

// A constant of the program that a `dataFile` call gives: `first` reads
// it in the reactive tier, and `picked` in a function body.
export default pattern<{ index: number }>(({ index }) => {
  return {
    first: WORDS[0],
    count: WORDS.length,
    picked: computed(() => wordAt(index)),
  };
});
