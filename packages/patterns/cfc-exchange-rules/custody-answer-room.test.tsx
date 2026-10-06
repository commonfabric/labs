import { assert, pattern, TESTS } from "commonfabric";
import CustodyAnswerRoom, {
  type BoxEntry,
  NO_AGREEMENT,
  type Rating,
} from "./custody-answer-room.tsx";

// The answer room's projector over boxes given directly, as the seal would
// leave them. The seal, the release, and the published answer are exercised
// end to end in `integration/cfc-custody-projector.test.ts`.
const terms = (seats: number) =>
  JSON.stringify({ seats: Array.from({ length: seats }, (_, i) => `s${i}`) });
const entry = (seats: number, ratings: Rating[]): BoxEntry => ({
  instance: "i",
  terms: terms(seats),
  stance: { ratings },
});

export default pattern(() => {
  // The room's terms and policy are absent until `propose` writes them, and
  // each carries a writer claim that refuses a value supplied here, so a room
  // over a box given directly omits both.
  type Input = Parameters<typeof CustodyAnswerRoom>[0];
  // Pizza draws a `no`; tacos draws more `yes` than sushi, though sushi is
  // listed first.
  const agreed = CustodyAnswerRoom({
    box: {
      a: entry(2, ["yes", "maybe", "yes"]),
      b: entry(2, ["no", "yes", "yes"]),
    },
  } as Partial<Input> as Input);
  // Three seats and two entries: the room is incomplete.
  const incomplete = CustodyAnswerRoom({
    box: {
      a: entry(3, ["yes", "yes", "yes"]),
      b: entry(3, ["yes", "yes", "yes"]),
    },
  } as Partial<Input> as Input);
  // Two entries sealed under different terms.
  const mixed = CustodyAnswerRoom({
    box: {
      a: entry(2, ["yes", "yes", "yes"]),
      b: { ...entry(2, ["yes", "yes", "yes"]), terms: "{}" },
    },
  } as Partial<Input> as Input);
  // Terms that are not JSON, and terms that name no seats.
  const unreadable = CustodyAnswerRoom({
    box: {
      a: { ...entry(1, ["yes", "yes", "yes"]), terms: "not json" },
    },
  } as Partial<Input> as Input);
  const seatless = CustodyAnswerRoom({
    box: {
      a: { ...entry(1, ["yes", "yes", "yes"]), terms: "{}" },
    },
  } as Partial<Input> as Input);
  // Terms that parse to JSON `null` rather than an object.
  const nullTerms = CustodyAnswerRoom({
    box: {
      a: { ...entry(1, ["yes", "yes", "yes"]), terms: "null" },
    },
  } as Partial<Input> as Input);
  const empty = CustodyAnswerRoom({} as Input);

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
    unreadable.choice === NO_AGREEMENT && seatless.choice === NO_AGREEMENT &&
    nullTerms.choice === NO_AGREEMENT
  );
  const assert_first_rating_read = assert(() => agreed.rating === "yes");
  const assert_no_terms_before_proposal = assert(() =>
    empty.terms === undefined
  );
  const assert_proposal_writes_terms = assert(() =>
    empty.terms?.question === "Where should we eat?" &&
    empty.terms?.seats.length === 0 &&
    empty.terms?.answers.includes(NO_AGREEMENT) === true
  );
  // The terms are written once: proposing again, with a seat this time,
  // leaves them as the first proposal wrote them.
  const assert_second_proposal_writes_nothing = assert(() =>
    empty.terms?.seats.length === 0
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
      { action: empty.propose, event: { seats: ["another"] } },
      { assertion: assert_second_proposal_writes_nothing },
    ],
    agreed,
    incomplete,
    mixed,
    unreadable,
    seatless,
    nullTerms,
    empty,
  };
});
