/// <cts-enable />
import {
  computed,
  currentPrincipal,
  eventKey,
  handler,
  pattern,
  spaceAccess,
  spaceMembers,
  type Stream,
  Writable,
} from "commonfabric";

// Built-ins that the runtime answers and the executor does not have: the
// acting principal and the key of the event in a handler, and the level
// the access list of the space grants, in a handler and in a `computed`.
// No per-element construct is here.

interface Stamp {
  by: string;
  key: string;
  level: string;
  text: string;
}

const record = handler<
  { text: string },
  { notes: Writable<string[]>; last: Writable<Stamp> }
>((event, { notes, last }) => {
  last.set({
    by: currentPrincipal() ?? "nobody",
    key: eventKey(),
    level: spaceAccess(notes) ?? "unknown",
    text: event.text,
  });
});

interface Output {
  last: Stamp;
  level: string;
  members: number;
  record: Stream<{ text: string }>;
}

export default pattern<{ notes: Writable<string[]> }, Output>(({ notes }) => {
  const last = Writable.of<Stamp>({ by: "", key: "", level: "", text: "" });
  const level = computed(() => spaceAccess(notes) ?? "unknown");
  const members = computed(() =>
    Object.keys(spaceMembers(notes)?.principals ?? {}).length
  );
  return { last, level, members, record: record({ notes, last }) };
});
