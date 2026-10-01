import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { InboxMessage } from "@commonfabric/memory/inbox";

import { sentNoticesOf } from "../lib/space-access-notices.ts";

const ALICE = "did:key:z6MkfXnSkGc27B8ahD4GEgW7egL6kYfu7kpNiUV9ESpMRHAk";
const BOB = "did:key:z6MkiT3dKXX5dqUcbnpf1Ejp8hFVuMM9MN9eftydT9T4uurE";
const SPACE = "did:key:z6MkspaceSpaceSpaceSpaceSpaceSpaceSpaceSpaceSpa";

/** A message `sender` sent `recipient` carrying `payload`. */
function message(
  sender: string,
  recipient: string,
  payload: InboxMessage["payload"],
): InboxMessage {
  return {
    receipt: {
      recipientDid: recipient,
      senderDid: sender,
      operationId: "notice-1",
      payloadHash: "hash",
      receivedAt: 1,
    },
    payload,
  };
}

describe("space-access-notices", () => {
  describe("sentNoticesOf()", () => {
    it("returns one record per notice, in order, naming its sender, recipient, space, and entry", () => {
      const notices = sentNoticesOf([
        message(ALICE, BOB, {
          type: "space-access-notice",
          v: 1,
          space: SPACE,
          entry: "of:room",
        }),
        message(BOB, ALICE, {
          type: "space-access-notice",
          v: 1,
          space: SPACE,
          entry: "of:other",
        }),
      ]);
      expect(notices).toEqual([
        { sender: ALICE, recipient: BOB, space: SPACE, entry: "of:room" },
        { sender: BOB, recipient: ALICE, space: SPACE, entry: "of:other" },
      ]);
    });

    it("returns no record for a message that is not a version-1 notice", () => {
      expect(sentNoticesOf([
        message(ALICE, BOB, { type: "something-else", space: SPACE }),
        message(ALICE, BOB, {
          type: "space-access-notice",
          space: SPACE,
          entry: "of:room",
        }),
        message(ALICE, BOB, {
          type: "space-access-notice",
          v: 2,
          space: SPACE,
          entry: "of:room",
        }),
        message(ALICE, BOB, "hello"),
        message(ALICE, BOB, null),
      ])).toEqual([]);
    });
  });
});
