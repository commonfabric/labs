import { assert, pattern, TESTS } from "commonfabric";
import CustodyProjector, {
  type BoxEntry,
  NO_AGREEMENT,
  type Rating,
} from "./custody-projector.tsx";

// The projector over boxes given directly, as the seal would leave them. The
// seal and the release are exercised end to end in
// `integration/cfc-custody-projector.test.ts`.
const terms = (seats: number) =>
  JSON.stringify({ seats: Array.from({ length: seats }, (_, i) => `s${i}`) });
const entry = (seats: number, ratings: Rating[]): BoxEntry => ({
  instance: "i",
  terms: terms(seats),
  stance: { ratings },
});

export default pattern(() => {
  type Input = Parameters<typeof CustodyProjector>[0];
  // Pizza draws a `no`; tacos draws more `yes` than sushi, though sushi is
  // listed first.
  const agreed = CustodyProjector({
    terms: null,
    policy: true,
    box: {
      a: entry(2, ["yes", "maybe", "yes"]),
      b: entry(2, ["no", "yes", "yes"]),
    },
  });
  // Three seats and two entries: the room is incomplete.
  const incomplete = CustodyProjector({
    terms: null,
    policy: true,
    box: {
      a: entry(3, ["yes", "yes", "yes"]),
      b: entry(3, ["yes", "yes", "yes"]),
    },
  });
  // Two entries sealed under different terms.
  const mixed = CustodyProjector({
    terms: null,
    policy: true,
    box: {
      a: entry(2, ["yes", "yes", "yes"]),
      b: { ...entry(2, ["yes", "yes", "yes"]), terms: "{}" },
    },
  });
  // Terms that are not JSON, and terms that name no seats.
  const unreadable = CustodyProjector({
    terms: null,
    policy: true,
    box: {
      a: { ...entry(1, ["yes", "yes", "yes"]), terms: "not json" },
    },
  });
  const seatless = CustodyProjector({
    terms: null,
    policy: true,
    box: {
      a: { ...entry(1, ["yes", "yes", "yes"]), terms: "{}" },
    },
  });
  const empty = CustodyProjector({} as Input);

  const assert_most_yes_without_a_no = assert(() => agreed.choice === "tacos");
  const assert_incomplete_room_agrees_on_nothing = assert(() =>
    incomplete.choice === NO_AGREEMENT
  );
  const assert_mixed_terms_agree_on_nothing = assert(() =>
    mixed.choice === NO_AGREEMENT
  );
  const assert_empty_box_agrees_on_nothing = assert(() =>
    empty.choice === NO_AGREEMENT
  );
  const assert_unreadable_terms_agree_on_nothing = assert(() =>
    unreadable.choice === NO_AGREEMENT && seatless.choice === NO_AGREEMENT
  );
  const assert_first_rating_read = assert(() => agreed.rating === "yes");
  const assert_no_terms_before_proposal = assert(() => empty.terms === null);
  const assert_proposal_writes_terms = assert(() =>
    empty.terms?.question === "Where should we eat?" &&
    empty.terms?.seats.length === 0 &&
    empty.terms?.answers.includes(NO_AGREEMENT) === true
  );

  return {
    [TESTS]: [
      { assertion: assert_most_yes_without_a_no },
      { assertion: assert_incomplete_room_agrees_on_nothing },
      { assertion: assert_mixed_terms_agree_on_nothing },
      { assertion: assert_empty_box_agrees_on_nothing },
      { assertion: assert_unreadable_terms_agree_on_nothing },
      { assertion: assert_first_rating_read },
      { assertion: assert_no_terms_before_proposal },
      { action: empty.propose, event: { seats: [] } },
      { assertion: assert_proposal_writes_terms },
    ],
    agreed,
    incomplete,
    mixed,
    unreadable,
    seatless,
    empty,
  };
});
