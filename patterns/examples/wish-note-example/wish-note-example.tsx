import { NAME, pattern, UI, VNode, wish } from "commonfabric";

export default pattern<Record<string, never>>((_) => {
  // bf: is this desirable to have to specify [UI] here if you want the UI
  const wishResult = wish<{ content: string; [UI]: VNode }>({ query: "#note" });

  return {
    [NAME]: "Wish tester",
    [UI]: (
      <div>
        <pre>{wishResult.result!.content}</pre>
        <hr />
        {wishResult.result}
      </div>
    ),
  };
});
