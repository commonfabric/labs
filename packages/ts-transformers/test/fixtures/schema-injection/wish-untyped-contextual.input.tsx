import { pattern, wish, type WishState } from "commonfabric";

// FIXTURE: wish-untyped-contextual
// Verifies: an untyped wish() takes the schema of the T inferred for it, never of the WishState<T> it returns
//   { profile: wish({ query }) } in a pattern's result → T is unknown → { type: "unknown" }, as wish<unknown>() gets
//   const bare = wish({ query }) → no contextual type → no schema
// The result type is written out, since an inferred one holding WishState<unknown> is refused.
export default pattern<
  Record<string, never>,
  { profile: WishState<unknown>; bare: WishState<unknown> }
>(() => {
  const bare = wish({ query: "#bare" });
  return {
    profile: wish({ query: "#profile" }),
    bare,
  };
});
