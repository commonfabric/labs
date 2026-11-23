/// <cts-enable />
/**
 * A handler that makes an instance of a pattern with state of the scope
 * `session`, and adds it to a list that a `map` reads: `add` instantiates
 * `Note`, whose `shown` is computed from its label and the draft of the
 * session that reads it, and `labels` is a `map` over the list, an array
 * of references, that reads the label of each member. The pattern reads
 * state of the scope `session` of its own, so that a serving loop derives it
 * for each session from its start.
 */
import {
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

interface NoteResult {
  label: string;
  shown: string;
}

const Note = pattern<{ label: string }, NoteResult>(({ label }) => {
  const draft = new Writable.perSession("");
  return {
    label,
    shown: computed(() => label + ":" + draft.get()),
  };
});

const add = handler<
  { label: string },
  { members: Writable<NoteResult[]> }
>((event, { members }) => {
  members.push(Note({ label: event.label }));
});

interface Input {
  members: Writable<NoteResult[]>;
}

interface Output {
  members: NoteResult[];
  labels: string[];
  filtered: string;
  add: Stream<{ label: string }>;
}

export default pattern<Input, Output>(({ members }) => {
  const filter = new Writable.perSession("");
  return {
    members,
    labels: members.map((member) => member.label + "!"),
    filtered: computed(() => `filter ${filter.get()}`),
    add: add({ members }),
  };
});
