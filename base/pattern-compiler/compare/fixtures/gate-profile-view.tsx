/// <cts-enable />
import { computed, NAME, pattern, UI, type VNode, wish } from "commonfabric";

// A view that reads the acting principal's profile through `wish`, as the
// Topics board reads it for "Acting as": the name is a value of the scope
// `user`, which each principal reads for itself.

interface Output {
  [NAME]: string;
  [UI]: VNode;
  name: string;
}

export default pattern<Record<string, never>, Output>(() => {
  const profile = wish<{ name: string }>({ query: "#profile" });
  const name = computed(() => profile.result?.name ?? "");
  return {
    [NAME]: "Profile view",
    [UI]: <div>Acting as {name}</div>,
    name,
  };
});
