/// <cts-enable />
import {
  type AuthoredByCurrentUser,
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

const set = handler<{ text: string }, { text: Writable<string> }>(
  (event, { text }) => {
    text.set(event.text);
  },
);

/** A text that claims the integrity of the principal who wrote it. */
export type Signed = AuthoredByCurrentUser<
  WriteAuthorizedBy<string, typeof set>
>;

// A derived output whose declared type claims integrity of the current
// principal: a derivation computes `shouted`, and no principal's event
// writes it.
export default pattern<
  Record<string, never>,
  { shouted: Signed; set: Stream<{ text: string }> }
>(() => {
  const text = Writable.of("quiet");
  const shouted = computed(() => text.get().toUpperCase());
  return { shouted, set: set({ text }) };
});
