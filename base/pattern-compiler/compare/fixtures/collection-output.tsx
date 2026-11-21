/// <cts-enable />
import { computed, pattern, UI } from "commonfabric";

// A branch of a selector that is the result of a `map` over an array of
// plain values in place, named from outside the element body.
export default pattern<{ names: string[] }>(({ names }) => {
  const empty = computed(() => names.length === 0);
  return {
    [UI]: <div>{empty ? <i>none</i> : names.map((name) => <b>{name}</b>)}</div>,
  };
});
