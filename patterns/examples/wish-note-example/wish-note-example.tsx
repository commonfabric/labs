import {
  hasError,
  hasSchemaMismatch,
  isPending,
  isSyncing,
  NAME,
  pattern,
  resultOf,
  UI,
  VNode,
  wish,
} from "commonfabric";

export default pattern<Record<string, never>>((_) => {
  // bf: is this desirable to have to specify [UI] here if you want the UI
  const wishResult = wish<{ content: string; [UI]: VNode }>({ query: "#note" });
  const note = hasError(wishResult.result) || isPending(wishResult.result) ||
      isSyncing(wishResult.result) || hasSchemaMismatch(wishResult.result)
    ? undefined
    : resultOf(wishResult.result);

  return {
    [NAME]: "Wish tester",
    [UI]: (
      <div>
        <pre>{note?.content ?? ""}</pre>
        <hr />
        {note}
      </div>
    ),
  };
});
