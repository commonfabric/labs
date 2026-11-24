/**
 * The smallest example of `wish`: it looks up a note with the `#note` tag and
 * shows its content as text followed by the note's own rendered view.
 */

import {
  computed,
  hasError,
  hasSchemaMismatch,
  isObsolete,
  isPending,
  isSyncing,
  NAME,
  observeAvailability,
  pattern,
  resultOf,
  UI,
  VNode,
  wish,
} from "commonfabric";

export default pattern<Record<string, never>>((_) => {
  // bf: is this desirable to have to specify [UI] here if you want the UI
  const wishResult = wish<{ content: string; [UI]: VNode }>({ query: "#note" });
  const observedNote = observeAvailability(wishResult.result);
  const retirementGuidance = computed(() =>
    isObsolete(observedNote)
      ? observedNote.message || "This note output has been retired."
      : ""
  );
  const note = hasError(wishResult.result) || isPending(wishResult.result) ||
      isSyncing(wishResult.result) || hasSchemaMismatch(wishResult.result)
    ? undefined
    : resultOf(wishResult.result);

  return {
    [NAME]: "Wish tester",
    [UI]: (
      <div>
        {retirementGuidance ? <p role="status">{retirementGuidance}</p> : null}
        <pre>{note?.content ?? ""}</pre>
        <hr />
        {note}
      </div>
    ),
  };
});
