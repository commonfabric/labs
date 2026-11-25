/// <cts-enable />
import {
  computed,
  handler,
  NAME,
  pattern,
  type PerSession,
  type PerUser,
  type Stream,
  UI,
  Writable,
} from "commonfabric";

// The Topics board's composer reduced to its reads: a draft of the scope
// `session` that an input's `$value` binding writes, a name of the scope
// `user` read through a `computed` as the board reads the profile's name,
// and a handler that reads both, returns where either is blank, and
// otherwise appends the draft to a list of the space and clears it.

const submit = handler<
  void,
  { draft: Writable<string>; author: string; notes: Writable<string[]> }
>((_, { draft, author, notes }) => {
  const text = draft.get().trim();
  if (!text || !author) return;
  notes.push(`${author}: ${text}`);
  draft.set("");
});

interface Output {
  draft?: PerSession<Writable<string>>;
  nickname?: PerUser<Writable<string>>;
  author: string;
  notes: string[];
  count: number;
  submit: Stream<void>;
}

export default pattern<{ notes: Writable<string[]> }, Output>(({ notes }) => {
  const draft = new Writable.perSession("");
  const nickname = new Writable.perUser("");
  const author = computed(() => nickname.get().trim());
  const count = computed(() => notes.get().length);
  const send = submit({ draft, author, notes });
  return {
    [NAME]: computed(() => `Notes (${count})`),
    [UI]: (
      <div>
        <cf-input $value={nickname} />
        <cf-input $value={draft} />
        <cf-button onClick={send}>Start</cf-button>
      </div>
    ),
    draft,
    nickname,
    author,
    notes,
    count,
    submit: send,
  };
});
