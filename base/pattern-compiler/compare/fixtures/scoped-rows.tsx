/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

// A per-element construct over an array of plain values in place, a list
// of the space, whose body reads state of the scope `user`: each note says
// whether the acting user picked it. A second per-element construct over
// the same array reads nothing of a user.

const pick = handler<{ text: string }, { picked: Writable<string> }>(
  (event, { picked }) => {
    picked.set(event.text);
  },
);

const post = handler<
  { text: string },
  { notes: Writable<{ text: string }[]> }
>(
  (event, { notes }) => {
    notes.push({ text: event.text });
  },
);

interface Row {
  text: string;
  mine: boolean;
}

interface Output {
  rows: Row[];
  plain: string[];
  pick: Stream<{ text: string }>;
  post: Stream<{ text: string }>;
}

export default pattern<{ notes: Writable<{ text: string }[]> }, Output>(
  ({ notes }) => {
    const picked = new Writable.perUser<string>("");
    const rows = notes.map((note) => ({
      text: note.text,
      mine: computed(() => note.text === picked.get()),
    }));
    const plain = notes.map((note) => note.text);
    return { rows, plain, pick: pick({ picked }), post: post({ notes }) };
  },
);
