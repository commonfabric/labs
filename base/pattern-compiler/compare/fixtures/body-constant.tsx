/// <cts-enable />
import { computed, Default, pattern, Writable } from "commonfabric";

interface ListInput {
  show?: Writable<boolean | Default<true>>;
  hide?: Writable<boolean | Default<false>>;
  mark: string;
  words: string[];
}

// A pattern that is compiled into its caller. The body of `shown` is no
// promoted `computed`, and it reads `show` and `hide` through their
// handles.
const List = pattern<ListInput>(({ show, hide, mark, words }) => {
  const shown = computed(() => {
    let text = mark;
    if (show.get() && !hide.get()) text = words.join(",");
    return text;
  });
  return { shown };
});

// The first call leaves `show` and `hide` out, so each is the default of
// the callee, a constant, at a position of handle type. The second call
// writes `hide` as a literal.
export default pattern<{ words: string[] }>(({ words }) => {
  const open = List({ words, mark: "?" });
  const closed = List({ words, mark: "-", hide: true });
  return { open: open.shown, closed: closed.shown };
});
