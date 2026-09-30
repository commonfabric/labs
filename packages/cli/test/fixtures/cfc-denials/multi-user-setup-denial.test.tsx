/// <cts-enable />

/**
 * Fixture: a multi-user run in which one participant's own pattern writes a
 * cell whose policy names a handler as its only writer, so CFC denies that
 * participant's setup commit and the run fails on the warning it logs.
 */

import {
  handler,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

const approve = handler<void, { value: Writable<string> }>((_, { value }) => {
  value.set("approved");
});

export const setup = pattern<Record<string, never>>(() => ({}));

export const alice = pattern(() => {
  const note = new Writable<WriteAuthorizedBy<string, typeof approve>>("");
  return { [TESTS]: [], runApprove: approve({ value: note }) };
});

export default multiUserTest({ setup, participants: { alice } });
