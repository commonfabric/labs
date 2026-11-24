/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

interface Prefs {
  color: string;
}

const pick = handler<
  { color: string },
  { prefs: Writable<Prefs | undefined> }
>((event, { prefs }) => {
  prefs.set({ color: event.color });
});

interface Output {
  chosen: Prefs;
  pick: Stream<{ color: string }>;
}

// PL §3.5 with a left operand of the scope `user`: the record a user
// picked, or the record of the space where the user picked none. The
// operand that `??` selects is passed on as the reference it is.
export default pattern<{ fallback: Prefs }, Output>(({ fallback }) => {
  const prefs = new Writable.perUser<Prefs | undefined>(undefined);
  const chosen = computed(() => prefs.get() ?? fallback);
  return { chosen, pick: pick({ prefs }) };
});
