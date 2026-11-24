// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * The labeled share (README, "readers of B"): the owner's window published
 * into a second space, into a store under that space's own policy rather than
 * an unlabeled one. Two shares, one publishing the blessed window and one a
 * plain copy, both land: the store has no ceiling, and an exchange rule
 * releases at a check (a ceiling, a display), not by rewriting what is stored.
 * Whether the share space's readers see the blessed window and not the plain
 * one is decided at their display, which `cf test` does not run (README).
 */
import {
  action,
  assert,
  pattern,
  spaceOf,
  TESTS,
  Writable,
} from "commonfabric";
import { type Fix, type OwnerLocation } from "./policy.tsx";
import ShareReaders, { type ShareReadersOutput } from "./share-readers.tsx";

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;

const FIXES: Fix[] = [
  { lat: 37.0, lon: -122.0, at: NOW - 20 * MINUTE },
  { lat: 37.1, lon: -122.1, at: NOW - 4 * MINUTE },
  { lat: 37.2, lon: -122.2, at: NOW - 1 * MINUTE },
];

interface Shares {
  blessed?: ShareReadersOutput;
  plain?: ShareReadersOutput;
}

const EVERYONE_READS = { grants: { "*": "READ" as const } };

export default pattern(() => {
  const policyFixes = new Writable<OwnerLocation<Fix[]>>().for("policyFixes");
  const shares = new Writable<Shares>({}).for("shares");
  const create = action(() =>
    shares.set({
      blessed: ShareReaders.inSpace(undefined, EVERYONE_READS)({
        fixes: policyFixes,
        now: NOW,
      }),
      plain: ShareReaders.inSpace(undefined, EVERYONE_READS)({
        fixes: policyFixes,
        now: NOW,
      }),
    })
  );

  return {
    [TESTS]: [
      { action: create },
      { action: action(() => policyFixes.set(FIXES as OwnerLocation<Fix[]>)) },
      { action: action(() => shares.get().blessed?.publish.send()) },
      { action: action(() => shares.get().plain?.publishPlain.send()) },
      {
        // Both shares are in spaces of their own, and both windows landed.
        assertion: assert(() => {
          const s = shares.get();
          const owner = spaceOf(policyFixes);
          return owner !== undefined && s.blessed?.space !== undefined &&
            s.plain?.space !== undefined && s.blessed.space !== owner &&
            s.plain.space !== owner && s.blessed.space !== s.plain.space &&
            (s.blessed.readers ?? []).length === 2 &&
            (s.plain.readers ?? []).length === 2;
        }),
      },
    ],
    allowConsoleWarnings: true,
    shares,
  };
});
