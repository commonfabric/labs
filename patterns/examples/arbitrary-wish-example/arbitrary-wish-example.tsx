import {
  computed,
  DID,
  NAME,
  pattern,
  UI,
  VNode,
  wish,
  Writable,
} from "commonfabric";

export default pattern<Record<string, never>>((_) => {
  const wishText = new Writable("#note");
  const searchHome = new Writable(false);
  const searchSpace = new Writable(true);
  const arbitraryDID = new Writable("");

  const wishResult = wish<{ [UI]: VNode }>({
    query: wishText,
    scope: computed(() => {
      const result: (DID | "~" | ".")[] = [];
      if (searchHome.get()) result.push("~");
      if (searchSpace.get()) result.push(".");
      const did = arbitraryDID.get()?.trim();
      if (did) result.push(did as DID);
      return result;
    }),
  });

  return {
    [NAME]: "Wish tester",
    [UI]: (
      <div>
        <cf-checkbox $checked={searchHome}>Search Home</cf-checkbox>
        <cf-checkbox $checked={searchSpace}>Search Space</cf-checkbox>
        <cf-input $value={arbitraryDID} placeholder="did:key:..." />
        <hr />
        <cf-textarea $value={wishText} />
        <hr />
        {wishResult[UI]}
      </div>
    ),
  };
});
