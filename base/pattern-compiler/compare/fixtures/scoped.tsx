/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  wish,
  Writable,
} from "commonfabric";

// State of the scope `user` beside state of the space: the nickname of each
// user, a list every user reads, a value derived from the list alone, a
// value derived from the list and the nickname, and what `wish` resolves
// the profile of the acting user to. No per-element construct is here.

const rename = handler<{ name: string }, { nickname: Writable<string> }>(
  (event, { nickname }) => {
    nickname.set(event.name);
  },
);

const post = handler<{ text: string }, { notes: Writable<string[]> }>(
  (event, { notes }) => {
    notes.push(event.text);
  },
);

interface Output {
  nickname: string;
  count: number;
  summary: string;
  greeting: string;
  rename: Stream<{ name: string }>;
  post: Stream<{ text: string }>;
}

export default pattern<{ notes: Writable<string[]> }, Output>(({ notes }) => {
  const nickname = new Writable.perUser<string>("nobody");
  const profile = wish<{ name: string }>({ query: "#profile" });
  const count = computed(() => notes.get().length);
  const summary = computed(() =>
    `${nickname.get()} reads ${notes.get().length}`
  );
  const greeting = computed(() => `hello ${profile.result?.name ?? "nobody"}`);
  return {
    nickname,
    count,
    summary,
    greeting,
    rename: rename({ nickname }),
    post: post({ notes }),
  };
});
