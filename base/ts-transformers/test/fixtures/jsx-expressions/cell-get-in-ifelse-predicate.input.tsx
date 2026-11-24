import { Cell, ifElse, pattern, UI } from "commonfabric";

// Reproduction of bug: .get() called on Cell inside ifElse predicate
// The transformer wraps predicates in a lift-applied computation, which unwraps Cells,
// but fails to remove the .get() calls
// FIXTURE: cell-get-in-ifelse-predicate
// Verifies: .get() calls on Cell refs inside ifElse predicates are preserved within the lift-applied computation
//   showHistory && messageCount !== dismissedIndex.get() → lift(({...}) => showHistory && messageCount !== dismissedIndex.get())(...)
// Context: Bug repro -- predicate wrapped in a lift-applied computation which unwraps Cells, but .get() must remain
export default pattern<{
  showHistory: boolean;
  messageCount: number;
  dismissedIndex: Cell<number>;
}>(({ showHistory, messageCount, dismissedIndex }) => {
  return {
    [UI]: (
      <div>
        {ifElse(
          showHistory && messageCount !== dismissedIndex.get(),
          <div>Show notification</div>,
          <div>Hide notification</div>
        )}
      </div>
    ),
  };
});
