/**
 * Spells text out in the NATO phonetic alphabet, reading the alphabet from a
 * file that ships with the pattern.
 *
 * `dataFile` resolves its path against this module, the way an import
 * specifier does, so `./data/phonetic-alphabet.json` is the file in the `data`
 * directory beside this one whichever directory the program was assembled
 * from. Its bytes are stored verbatim: never parsed as TypeScript, never
 * compiled, never importable.
 *
 * That call is the whole declaration. Every command that builds a pattern from
 * local files reads it out of the source and attaches the file, so the test
 * beside this one and a deployment both get it without naming it.
 */
import {
  computed,
  dataFile,
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface PhoneticLetter {
  letter: string;
  word: string;
}

interface PhoneticAlphabet {
  letters: PhoneticLetter[];
}

// `dataFile` returns text, so parsing it yields `any`. Naming the shape is
// what gives the result schema below something to describe.
const ALPHABET = JSON.parse(
  dataFile("./data/phonetic-alphabet.json"),
) as PhoneticAlphabet;

function spell(text: string): string {
  return [...text.toUpperCase()]
    .map((character) =>
      ALPHABET.letters.find((entry) => entry.letter === character)?.word ??
        character
    )
    .join(" ");
}

interface PhoneticSpellerInput {
  text: Writable<string | Default<"Fabric">>;
}

export interface PhoneticSpellerOutput {
  [NAME]: string;
  [UI]: VNode;

  /** `text` spelled out, one code word per letter it recognizes. */
  spelled: string;

  /** Every code word the file holds, in the order the file stores them. */
  codeWords: string[];
}

export const PhoneticSpeller = pattern<
  PhoneticSpellerInput,
  PhoneticSpellerOutput
>(({ text }) => {
  const spelled = computed(() => spell(text.get()));

  return {
    [NAME]: "Phonetic speller",
    [UI]: (
      <cf-vstack gap="2" style={{ padding: "1rem" }}>
        <h3>Phonetic speller</h3>
        <cf-input $value={text} placeholder="Text to spell" />
        <p>{spelled}</p>
      </cf-vstack>
    ),
    spelled,
    codeWords: ALPHABET.letters.map((entry) => entry.word),
  };
});

export default PhoneticSpeller;
