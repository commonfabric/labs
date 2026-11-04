/**
 * Test Pattern: the phonetic speller
 *
 * The pattern's alphabet is a file that ships beside it rather than a table
 * written in code, so what this proves is that the file travelled: the code
 * words it asserts appear nowhere in the pattern's source. The pattern
 * compiles and type-checks whether or not the file is attached, and fails at
 * the read, so a run that reaches these assertions has already shown the
 * attachment happened.
 *
 * Nothing here names the file. `cf test` builds the program from this entry,
 * follows the import to the pattern, reads the `dataFile()` call out of it,
 * and attaches what the call resolves to.
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import PhoneticSpeller from "./phonetic-speller.tsx";

export default pattern(() => {
  const text = new Writable("Fabric");
  const speller = PhoneticSpeller({ text });

  const action_spell_a_different_word = action(() => {
    text.set("SOS!");
  });

  const assert_spells_the_default_text = assert(() =>
    speller.spelled === "Foxtrot Alfa Bravo Romeo India Charlie"
  );

  // A character the file gives no word for is passed through as itself.
  const assert_spells_around_unknown_characters = assert(() =>
    speller.spelled === "Sierra Oscar Sierra !"
  );

  const assert_holds_every_code_word = assert(() =>
    speller.codeWords.length === 26 &&
    speller.codeWords[0] === "Alfa" &&
    speller.codeWords[25] === "Zulu"
  );

  return {
    [TESTS]: [
      { assertion: assert_spells_the_default_text },
      { assertion: assert_holds_every_code_word },

      { action: action_spell_a_different_word },
      { assertion: assert_spells_around_unknown_characters },
    ],
    speller,
  };
});
