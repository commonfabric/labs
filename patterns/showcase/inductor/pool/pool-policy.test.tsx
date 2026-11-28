/**
 * `submitContribution` copies the first stored contribution's seal into every
 * later one, so it refuses a list whose first entry carries a seal the pool
 * could not have minted. Other code plants an entry in a list of its own and
 * binds the handler to it: under a seal below `MIN_SEALED_THRESHOLD` the
 * submission is refused and the list keeps only the planted entry; under a
 * seal at the floor the submission lands, carrying the planted seal.
 *
 * Pattern under test: ./pool-policy.tsx
 */
import {
  assert,
  type Default,
  handler,
  NAME,
  pattern,
  type Stream,
  TESTS,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";
import { type Contribution, MIN_SEALED_THRESHOLD } from "./consensus.ts";
import { INVOICE } from "./inductor-pool-test-fixture.ts";
import { type ContributionEvent, submitContribution } from "./pool-policy.tsx";

/** One entry under `thresholdCenter`, with no jitter, into `to`. */
const plant = handler<
  void,
  { thresholdCenter: number; to: Writable<Required<Contribution>[]> }
>((_, { thresholdCenter, to }) => {
  to.set([{
    contributor: "planter",
    pseudonym: "planted",
    rules: [INVOICE],
    seal: { secret: "chosen", thresholdCenter, jitter: 0 },
  }]);
});

interface PlantedListInput {
  /** The threshold the planted entry's seal carries. */
  plantedThreshold: number;
  contributions: Writable<Default<Required<Contribution>[], []>>;
}

interface PlantedListOutput {
  [NAME]: string;
  [UI]: VNode;
  contributions: Required<Contribution>[];
  plant: Stream<void>;
  submit: Stream<ContributionEvent>;
}

/** The pool's submit handler, bound to a list other code filled first. */
const PlantedList = pattern<PlantedListInput, PlantedListOutput>(
  ({ plantedThreshold, contributions }) => ({
    [NAME]: "Planted list",
    [UI]: <div />,
    contributions,
    plant: plant({ thresholdCenter: plantedThreshold, to: contributions }),
    submit: submitContribution({
      contributions,
      thresholdCenter: 15,
      jitter: 0,
    }),
  }),
);

export default pattern(() => {
  const below = PlantedList({
    plantedThreshold: MIN_SEALED_THRESHOLD - 1,
    contributions: [],
  });
  const atFloor = PlantedList({
    plantedThreshold: MIN_SEALED_THRESHOLD,
    contributions: [],
  });
  return {
    [TESTS]: [
      { action: below.plant },
      { action: atFloor.plant },
      {
        assertion: assert(() =>
          below.contributions.length === 1 &&
          atFloor.contributions.length === 1
        ),
      },
      // A seal under the floor is refused, and nothing is stored.
      {
        action: below.submit,
        event: { pseudonym: "contributor", rules: [INVOICE] },
      },
      {
        assertion: assert(() =>
          below.contributions.map((entry) => entry?.pseudonym).join() ===
            "planted"
        ),
      },
      // A seal at the floor is one the pool could mint, so the submission is
      // stored under it.
      {
        action: atFloor.submit,
        event: { pseudonym: "contributor", rules: [INVOICE] },
      },
      {
        assertion: assert(() =>
          atFloor.contributions.map((entry) => entry?.pseudonym).join() ===
            "planted,contributor" &&
          atFloor.contributions[1]?.seal?.secret === "chosen" &&
          atFloor.contributions[1]?.seal?.thresholdCenter ===
            MIN_SEALED_THRESHOLD
        ),
      },
    ],
    expectRuntimeErrors: ["not one this pool could mint"],
    below,
    atFloor,
  };
});
