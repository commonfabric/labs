/**
 * Test Pattern: CFC input-cell demo briefing
 *
 * The pair of results is the point of the pattern: `briefing` reads both cells
 * and `climate` reads only `city`. A test can hold that to the data it can
 * see — `briefing` carries both operands, `climate` is unmoved by the secret
 * and takes each of its branches — while the labels the two results carry are
 * store state a pattern never returns, and are covered where that state lives.
 *
 * Run: deno task cf test patterns/examples/cfc-input-cell-demo/briefing.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Briefing from "./briefing.tsx";

export default pattern(() => {
  const lisbon = Briefing({ secret: "codeword osprey", city: "Lisbon" });
  // Same city, different secret: `climate` must not move, `briefing` must.
  const lisbonOtherSecret = Briefing({
    secret: "codeword kestrel",
    city: "Lisbon",
  });
  // Odd-length city, for `climate`'s other branch.
  const porto = Briefing({ secret: "codeword osprey", city: "Porto" });

  // A city held in a cell, so both results can be watched across a rewrite.
  const cityCell = new Writable("Lisbon");
  const reseeded = Briefing({ secret: "codeword petrel", city: cityCell });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_move_to_an_odd_length_city = action(() => {
    cityCell.set("Porto");
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_briefing_composes_both_inputs = assert(() =>
    lisbon.briefing === "Agent stationed in Lisbon; codeword is codeword osprey"
  );
  const assert_briefing_names_the_city = assert(() =>
    lisbon.briefing.includes("Lisbon")
  );
  const assert_briefing_carries_the_secret = assert(() =>
    lisbon.briefing.includes("codeword osprey")
  );
  const assert_briefing_follows_the_secret = assert(() =>
    lisbonOtherSecret.briefing ===
      "Agent stationed in Lisbon; codeword is codeword kestrel"
  );

  const assert_climate_ignores_the_secret = assert(() =>
    lisbon.climate === lisbonOtherSecret.climate
  );
  const assert_climate_omits_the_secret = assert(() =>
    !lisbon.climate.includes("osprey")
  );
  const assert_even_length_city_is_coastal = assert(() =>
    lisbon.climate === "coastal"
  );
  const assert_odd_length_city_is_inland = assert(() =>
    porto.climate === "inland"
  );

  const assert_reseeded_starts_coastal = assert(() =>
    reseeded.climate === "coastal"
  );
  const assert_reseeded_turns_inland = assert(() =>
    reseeded.climate === "inland"
  );
  const assert_reseeded_briefing_follows_the_city = assert(() =>
    reseeded.briefing ===
      "Agent stationed in Porto; codeword is codeword petrel"
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      { assertion: assert_briefing_composes_both_inputs },
      { assertion: assert_briefing_names_the_city },
      { assertion: assert_briefing_carries_the_secret },
      { assertion: assert_briefing_follows_the_secret },

      { assertion: assert_climate_ignores_the_secret },
      { assertion: assert_climate_omits_the_secret },
      { assertion: assert_even_length_city_is_coastal },
      { assertion: assert_odd_length_city_is_inland },

      { assertion: assert_reseeded_starts_coastal },
      { action: action_move_to_an_odd_length_city },
      { assertion: assert_reseeded_turns_inland },
      { assertion: assert_reseeded_briefing_follows_the_city },
    ],
    lisbon,
    lisbonOtherSecret,
    porto,
    reseeded,
  };
});
