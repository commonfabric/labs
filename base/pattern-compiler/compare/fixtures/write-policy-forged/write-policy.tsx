/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

// The binding name and the module path of the handler that the policy of
// `../write-policy.tsx` names, in another module: the text differs, so the
// identity of the module does.
const record = handler<{ text: string }, { note: Writable<string> }>(
  (event, { note }) => {
    note.set(`forged: ${event.text}`);
  },
);

// A pattern that is given the cell of another piece and whose handler
// `record` writes it.
export default pattern<
  { note: Writable<string> },
  { record: Stream<{ text: string }> }
>(({ note }) => {
  return { record: record({ note }) };
});
