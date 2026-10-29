import { Cell, computed, lift, pattern, Writable } from "commonfabric";

const liftSummary = lift<
  { primary: Writable<number>; secondary: Writable<number> }
>(({ primary, secondary }) => {
  const primaryValue = primary.get();
  const secondaryValue = secondary.get();
  return {
    primary: primaryValue,
    secondary: secondaryValue,
    difference: primaryValue - secondaryValue,
  };
});

// FIXTURE: context-lift-result-property-projection
// Verifies: a reactive builder preserves projected property schemas when the captured
// input comes from a typed lift() result rather than falling back to unknown
//   computed(() => summary.difference) → captures { difference: number } and outputs number
//   (KEEP computed: baring to `summary.difference` lowers to a plain .key() access with NO
//    captured-input schema, defeating this fixture's projection-shrink coverage — verified)
export default pattern<{ primary: Cell<number>; secondary: Cell<number> }>(
  ({ primary, secondary }) => {
    const summary = liftSummary({ primary, secondary });
    const difference = computed(() => summary.difference);

    return {
      summary,
      difference,
    };
  },
);
