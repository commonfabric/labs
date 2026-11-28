// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * The share pattern, placed in a share space of its own with `inSpace()`.
 * It reads the owner's fixes from the owner's space, computes the last five
 * minutes, and publishes them into `shared`, a store of the share space that
 * admits only values without a confidentiality label, so that the space's
 * access list alone decides who reads it.
 */
import {
  computed,
  handler,
  lift,
  type MaxConfidentiality,
  NAME,
  pattern,
  spaceOf,
  Stream,
  Writable,
} from "commonfabric";
import { type Fix, fixesWithin, recentFixes } from "./policy.tsx";

/** A store of the share space: anyone its access list admits may read it. */
export type InShareSpace<T> = MaxConfidentiality<T, readonly []>;

export interface ShareInput {
  /** The owner's fixes, a link into the owner's space. */
  fixes: Fix[];
  /** The instant the window ends at. */
  now: number;
}

export interface ShareOutput {
  [NAME]: string;
  /** The DID of the space the share was placed in. */
  space: string | undefined;
  /** The last five minutes, as published to the share space. */
  shared: InShareSpace<Fix[]>;
  /** Copies the window `recentFixes` computed into `shared`. */
  publish: Stream<void>;
  /** Copies the same window, computed by a function no rule names. */
  publishPlain: Stream<void>;
}

/** The same window as `recentFixes`, from a function no rule names. */
const plainRecentFixes = lift(
  ({ fixes, now }: { fixes: Fix[]; now: number }): Fix[] =>
    fixesWithin(fixes ?? [], now ?? 0),
);

const publishWindow = handler<
  void,
  { window: Fix[]; shared: Writable<InShareSpace<Fix[]>> }
>((_, { window, shared }) => {
  shared.set(window as InShareSpace<Fix[]>);
});

const Share = pattern<ShareInput, ShareOutput>(({ fixes, now }) => {
  const shared = new Writable<InShareSpace<Fix[]>>([] as InShareSpace<Fix[]>)
    .for("shared");
  const blessed = recentFixes({ fixes, now });
  const plain = plainRecentFixes({ fixes, now });
  return {
    [NAME]: "Shared location, last five minutes",
    space: computed(() => spaceOf(shared)),
    shared,
    publish: publishWindow({ window: blessed, shared }),
    publishPlain: publishWindow({ window: plain, shared }),
  };
});

export default Share;
