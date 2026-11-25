/**
 * What a pattern derives from a released value is as released as the value.
 *
 * `blessed-computation.tsx` releases the tally its `tallyBallot` computes: its
 * rule drops the policy's clause where the value read carries
 * `TransformedBy{tallyBallot}`. That evidence is about the tally and about
 * nothing computed from it, so the rule has to be applied where the tally is
 * read into the next computation, and what that computation writes carries
 * the clause as the rule left it (CFC §5.3, a value-intrinsic rule). A room
 * that admits only public values shows which derivations got that.
 *
 * Pattern under test: ./blessed-computation.tsx
 */
import {
  assert,
  computed,
  type Default,
  handler,
  lift,
  pattern,
  TESTS,
  type Writable,
} from "commonfabric";
import BlessedComputation, {
  type Brief,
  type PrivateBrief,
  type RoomText,
} from "./blessed-computation.tsx";

const UNTOUCHED = "untouched";

/** `from` into `to`, a store that admits only public values. */
const publish = handler<void, { from: string; to: Writable<RoomText> }>(
  (_, { from, to }) => {
    to.set(from);
  },
);

/** A module-scope lift over the released tally, named by no rule. */
const headline = lift(({ tally }: { tally: string }): string =>
  `Result: ${tally}`
);

/** The released tally beside a note no rule releases. */
const tallyWithNote = lift((
  { tally, briefs }: { tally: string; briefs: Brief[] | undefined },
): string => `${tally} ${briefs?.[0]?.note ?? ""}`);

interface Rooms {
  briefs: Writable<Default<PrivateBrief[], []>>;
  roomComputed: Writable<Default<RoomText, typeof UNTOUCHED>>;
  roomLifted: Writable<Default<RoomText, typeof UNTOUCHED>>;
  roomChained: Writable<Default<RoomText, typeof UNTOUCHED>>;
  roomMixed: Writable<Default<RoomText, typeof UNTOUCHED>>;
}

export default pattern<Rooms>(
  ({ briefs, roomComputed, roomLifted, roomChained, roomMixed }) => {
    const ballot = BlessedComputation(
      { briefs } as Parameters<typeof BlessedComputation>[0],
    );
    const shouted = computed(() => `${ballot.tally}!`);
    const titled = headline({ tally: ballot.tally });
    const chained = computed(() => `${titled} (final)`);
    const mixed = tallyWithNote({ tally: ballot.tally, briefs });
    return {
      [TESTS]: [
        { action: ballot.submit, event: { vote: "approve", note: "first" } },
        { action: ballot.submit, event: { vote: "reject", note: "second" } },
        { assertion: assert(() => ballot.tally === "1-1") },

        // A `computed` over the released tally is public.
        { action: publish({ from: shouted, to: roomComputed }) },
        { assertion: assert(() => roomComputed.get() === "1-1!") },

        // So is a module-scope lift no rule names.
        { action: publish({ from: titled, to: roomLifted }) },
        { assertion: assert(() => roomLifted.get() === "Result: 1-1") },

        // And a derivation of that derivation.
        { action: publish({ from: chained, to: roomChained }) },
        {
          assertion: assert(() => roomChained.get() === "Result: 1-1 (final)"),
        },

        // A derivation that also read the briefs is as private as they are.
        { assertion: assert(() => mixed === "1-1 first") },
        { action: publish({ from: mixed, to: roomMixed }) },
        { assertion: assert(() => roomMixed.get() === UNTOUCHED) },
      ],
      // The refused publish logs a CFC refusal.
      allowConsoleWarnings: true,
      ballot,
    };
  },
);
