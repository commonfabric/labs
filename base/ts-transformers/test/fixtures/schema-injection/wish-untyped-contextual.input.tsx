import { pattern, wish } from "commonfabric";

// FIXTURE: wish-untyped-contextual
// Verifies: an untyped wish() takes the schema of the T inferred for it, never of the WishState<T> it returns
//   { profile: wish({ query }) } in a pattern's result → T is unknown → { type: "unknown" }, as wish<unknown>() gets
//   const bare = wish({ query }) → no contextual type → no schema
export default pattern(() => {
  const bare = wish({ query: "#bare" });
  return {
    profile: wish({ query: "#profile" }),
    bare,
  };
});
