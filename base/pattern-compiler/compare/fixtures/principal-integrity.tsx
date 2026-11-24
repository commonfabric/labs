/// <cts-enable />
import {
  type AuthoredByCurrentUser,
  handler,
  pattern,
  type Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

const sign = handler<{ text: string }, { signed: Writable<string> }>(
  (event, { signed }) => {
    signed.set(event.text);
  },
);

/**
 * A text that the handler `sign` alone may write, with the integrity of the
 * principal whose event wrote it.
 */
export type Signed = AuthoredByCurrentUser<
  WriteAuthorizedBy<string, typeof sign>
>;

// A state cell whose write adds integrity of the current principal.
export default pattern<
  Record<string, never>,
  { signed: Signed; sign: Stream<{ text: string }> }
>(() => {
  const signed = new Writable<Signed>("");
  return { signed, sign: sign({ signed }) };
});
