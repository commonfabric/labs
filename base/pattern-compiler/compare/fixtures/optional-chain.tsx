/// <cts-enable />
import { computed, pattern } from "commonfabric";

// `state.result?.picks ?? []`: the condition of the selector reads the shape
// of `state.result`, a position no value code reads apart from the read
// through it to `picks`.
export default pattern<{ state: { result?: { picks: string[] } } }>((
  { state },
) => ({
  picks: computed(() => state.result?.picks ?? []),
}));
