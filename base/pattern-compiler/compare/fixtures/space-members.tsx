/// <cts-enable />
import { computed, pattern, spaceMembers, Writable } from "commonfabric";

// A built-in the runtime answers from a document the executor does not
// read, the access list of the space, and that answers the same for every
// principal: how many members the space of a list has. Nothing here is of
// a scope narrower than the space.
export default pattern<{ notes: Writable<string[]> }>(({ notes }) => {
  const members = computed(() =>
    Object.keys(spaceMembers(notes)?.principals ?? {}).length
  );
  return { members };
});
