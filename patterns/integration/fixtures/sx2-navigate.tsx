/// <cts-enable />
// The sx2-effect-channel gate's fixture (server-execution v2 Phase 4;
// docs/specs/server-side-execution/testing.md §5): a handler that bumps
// a counter and returns navigateTo — the canonical split-contract
// journey (builtins.md §4). The target page is a pattern instantiation
// so the navigation target is a real piece link.
import { handler, navigateTo, pattern, Stream, Writable } from "commonfabric";

const TargetPage = pattern<{ label: string }, { label: string }>(
  ({ label }) => ({ label }),
);

const go = handler<unknown, { value: Writable<number> }>(
  (_ev, { value }) => {
    value.set((value.get() ?? 0) + 1);
    return navigateTo(TargetPage({ label: "sx2 navigate target" }));
  },
);

export default pattern<
  { value: Writable<number> },
  { value: number; go: Stream<unknown> }
>(({ value }) => ({ value, go: go({ value }) }));
