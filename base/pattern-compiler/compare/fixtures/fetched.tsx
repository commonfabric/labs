/// <cts-enable />
import { computed, fetchJson, pattern } from "commonfabric";

// One effect written in the reactive tier, whose request holds an input,
// and two values that read its result. No per-element construct is here.

interface Item {
  title: string;
}

export default pattern<{ url: string }>(({ url }) => {
  const fetched = fetchJson<Item>({ url });
  const title = computed(() => fetched.result?.title ?? "none");
  const status = computed(() =>
    fetched.pending ? "pending" : fetched.error ? "failed" : "settled"
  );
  return { title, status };
});
