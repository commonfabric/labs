/**
 * Test Pattern: CFC input-cell demo seed
 *
 * The seed's whole job is to put two named cells in front of a run, so what a
 * test holds it to is that both are exposed and that each reads back what the
 * operator seeded: the declared default when nothing was passed, and the cell
 * itself when one was. The confidentiality atom `secret` declares is a fact
 * about that cell in the space rather than about this pattern's output, so
 * nothing here asserts on it.
 *
 * Run: deno task cf test patterns/examples/cfc-input-cell-demo/seed.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Seed from "./seed.tsx";

export default pattern(() => {
  // `seed.tsx` declares both inputs as required properties, so a bare `{}` is
  // not assignable to the factory's argument even though each input carries a
  // `Default<>`. Naming the argument type is what lets a test observe the
  // declared defaults at all.
  const unseeded = Seed({} as Parameters<typeof Seed>[0]);

  const secretCell = new Writable("codeword kestrel");
  const cityCell = new Writable("Porto");
  const seeded = Seed({ secret: secretCell, city: cityCell });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_reseed_city = action(() => {
    cityCell.set("Reykjavik");
  });

  const action_reseed_secret = action(() => {
    secretCell.set("codeword petrel");
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_default_secret = assert(() =>
    unseeded.secret === "codeword osprey"
  );
  const assert_default_city = assert(() => unseeded.city === "Lisbon");

  const assert_seeded_secret = assert(() =>
    seeded.secret === "codeword kestrel"
  );
  const assert_seeded_city = assert(() => seeded.city === "Porto");

  // Each cell is exposed as itself, not as a copy taken at instantiation, so a
  // write through the cell an operator holds is what the run reads back.
  const assert_city_follows_its_cell = assert(() =>
    seeded.city === "Reykjavik"
  );
  const assert_secret_follows_its_cell = assert(() =>
    seeded.secret === "codeword petrel"
  );

  // Seeding one instantiation leaves another's defaults where they were.
  const assert_defaults_are_independent = assert(() =>
    unseeded.secret === "codeword osprey" && unseeded.city === "Lisbon"
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      { assertion: assert_default_secret },
      { assertion: assert_default_city },
      { assertion: assert_seeded_secret },
      { assertion: assert_seeded_city },
      { action: action_reseed_city },
      { assertion: assert_city_follows_its_cell },
      { action: action_reseed_secret },
      { assertion: assert_secret_follows_its_cell },
      { assertion: assert_defaults_are_independent },
    ],
    unseeded,
    seeded,
  };
});
