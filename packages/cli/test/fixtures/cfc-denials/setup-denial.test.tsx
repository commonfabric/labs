/**
 * Fixture: the pattern's own setup writes a cell whose policy names a handler
 * as its only writer, so CFC denies the setup commit and the run fails on the
 * warning that denial logs.
 */

import {
  handler,
  pattern,
  TESTS,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

const approve = handler<void, { value: Writable<string> }>((_, { value }) => {
  value.set("approved");
});

export default pattern(() => {
  const note = new Writable<WriteAuthorizedBy<string, typeof approve>>("");
  return { [TESTS]: [], runApprove: approve({ value: note }) };
});
