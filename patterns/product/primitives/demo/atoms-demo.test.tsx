/**
 * Tests the atoms demo: that every atom embeds with the inputs this host
 * passes, and that the host's own computed reads through an embedded atom.
 *
 * This host is what proves the atoms are usable as parts. It passes only the
 * inputs it cares about and leaves the rest to their defaults, so an atom that
 * made any input mandatory would fail here rather than in whatever composes it
 * later — which is how that defect was caught in the first place.
 *
 * Run: deno task cf test patterns/product/primitives/demo/atoms-demo.test.tsx
 */
import { assert, pattern, TESTS } from "commonfabric";
import AtomsDemo from "./atoms-demo.tsx";

export default pattern(() => {
  // Instantiating runs the host body, which embeds all six atoms.
  const demo = AtomsDemo({});
  const withScore = AtomsDemo({ score: 10 });

  return {
    [TESTS]: [
      { assertion: assert(() => demo.score === 3) },
      // `statTotal` is the host's own computed over two embedded dice, so a
      // non-zero total is the host reading through the atoms it embedded.
      { assertion: assert(() => demo.statTotal === 2) },
      // The host's inputs are its own; a second instance does not share them.
      { assertion: assert(() => withScore.score === 10) },
      { assertion: assert(() => withScore.statTotal === 2) },
    ],
  };
});
