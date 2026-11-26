/// <cts-enable />
import { computed, NAME, pattern, UI, type VNode, wish } from "commonfabric";

// A view that reads the acting principal's profile through `wish`, as the
// Topics board reads it for "Acting as": the name is a value of the scope
// `user`, which each principal reads for itself. Its length and whether it
// is longer than 22 characters derive from it a count and a predicate, which
// differ between the principals of the gate.

interface Output {
  [NAME]: string;
  [UI]: VNode;
  name: string;
  size: number;
  long: boolean;
}

export default pattern<Record<string, never>, Output>(() => {
  const profile = wish<{ name: string }>({ query: "#profile" });
  const name = computed(() => profile.result?.name ?? "");
  const size = computed(() => (profile.result?.name ?? "").length);
  const long = computed(() => (profile.result?.name ?? "").length > 22);
  return {
    [NAME]: "Profile view",
    [UI]: <div>Acting as {name}</div>,
    name,
    size,
    long,
  };
});
