/// <cts-enable />
import { computed, pattern, wish } from "commonfabric";

// `wish` in the reactive tier (`builtin-inventory.md`, `wish`): a target
// of the space, the clock read once, and the clock that ticks. No
// per-element construct is here.
export default pattern<{ note: string }>(({ note }) => {
  const profile = wish<{ name: string }>({ query: "#profile" });
  const started = wish<number>({ query: "#now" });
  const ticking = wish<number>({ query: "#now/1" });
  const greeting = computed(() => `hello ${profile.result?.name ?? "nobody"}`);
  return {
    note,
    greeting,
    profile: profile.result,
    problem: profile.error,
    started: started.result,
    time: ticking.result,
  };
});
