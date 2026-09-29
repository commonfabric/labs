/**
 * Fixture: an unapproved writer changes a protected cell after its default is
 * initialized. CFC refuses the change, and the run fails on that warning.
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

const forge = handler<void, { value: Writable<string> }>((_, { value }) => {
  value.set("forged");
});

export default pattern(() => {
  const note = new Writable<WriteAuthorizedBy<string, typeof approve>>("");
  return {
    [TESTS]: [{ action: forge({ value: note }) }],
    runApprove: approve({ value: note }),
  };
});
