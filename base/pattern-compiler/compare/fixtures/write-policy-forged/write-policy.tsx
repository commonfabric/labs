/// <cts-enable />
import {
  handler,
  pattern,
  type Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

// The binding name and the module path of the handler that the policy of
// `../write-policy.tsx` names, in another module: the text differs, so the
// identity of the module does.
const record = handler<{ text: string }, { note: Writable<string> }>(
  (event, { note }) => {
    note.set(`forged: ${event.text}`);
  },
);

// A claim of this module names the handler, so the handler has the
// identity a claim is checked by: a handler no claim names has none.
type Own = WriteAuthorizedBy<string, typeof record>;

// A pattern that is given the cell of another piece and whose handler
// `record` writes it.
export default pattern<
  { note: Writable<string> },
  { own: Own; record: Stream<{ text: string }> }
>(({ note }) => {
  const own = new Writable<Own>("");
  return { own, record: record({ note }) };
});
