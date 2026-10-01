/**
 * How `cf test` reports the notices a run sent to the test pattern. A handler's
 * `noticeSpaceAccess()` sends to the inbox at the runtime's `apiUrl`, which in
 * the test lane is a `FakeInbox` the runtime's `fetch` answers in-process. What
 * that inbox accepted is written, as `SentSpaceAccessNotice` records, into a
 * cell the test pattern receives as its `spaceAccessNotices` input, so an
 * assertion can read what was sent, to whom, and by whom.
 *
 * A send is a post-commit effect, which only `Runtime.settled()` is the
 * barrier for, so the cell is brought up to date at a `{ settle: true }` step
 * and nowhere else: the list a test reads is deterministic rather than a race
 * against the send.
 */

import type { SentSpaceAccessNotice } from "@commonfabric/api";
import type { InboxMessage } from "@commonfabric/memory/inbox";
import type { FakeInbox } from "@commonfabric/runner/for-testing-only";
import {
  type Cell,
  type IExtendedStorageTransaction,
  type MemorySpace,
  type Runtime,
  SPACE_ACCESS_NOTICE_TYPE,
  type SpaceAccessNotice,
} from "@commonfabric/runner";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** The input key under which a test pattern receives the notices cell. */
export const SPACE_ACCESS_NOTICES_INPUT = "spaceAccessNotices";

/** The schema of the notices cell: a list of records, empty until written. */
export const sentNoticesSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      sender: { type: "string" },
      recipient: { type: "string" },
      space: { type: "string" },
      entry: { type: "string" },
    },
    required: ["sender", "recipient", "space", "entry"],
  },
  default: [],
} as const;

/**
 * Returns the cell holding a run's sent notices, in `space` under `cause`,
 * bound to `tx` where one is given.
 */
export function sentNoticesCell(
  runtime: Runtime,
  space: MemorySpace,
  cause: string,
  tx?: IExtendedStorageTransaction,
): Cell<SentSpaceAccessNotice[]> {
  return runtime.getCell<SentSpaceAccessNotice[]>(
    space,
    cause,
    sentNoticesSchema,
    tx,
  );
}

/** Whether `payload` is the payload of a space-access notice. */
function isSpaceAccessNotice(payload: unknown): payload is SpaceAccessNotice {
  return isObjectNotArray(payload) &&
    payload.type === SPACE_ACCESS_NOTICE_TYPE &&
    typeof payload.space === "string" && typeof payload.entry === "string";
}

/**
 * Returns the records of the space-access notices among `messages`, in
 * order. A message carrying anything else is not reported, since the records
 * describe notices and nothing a handler can send reaches the inbox but one.
 */
export function sentNoticesOf(
  messages: readonly InboxMessage[],
): SentSpaceAccessNotice[] {
  const notices: SentSpaceAccessNotice[] = [];
  for (const { receipt, payload } of messages) {
    if (!isSpaceAccessNotice(payload)) continue;
    notices.push({
      sender: receipt.senderDid as SentSpaceAccessNotice["sender"],
      recipient: receipt.recipientDid as SentSpaceAccessNotice["recipient"],
      space: payload.space,
      entry: payload.entry,
    });
  }
  return notices;
}

/**
 * Writes the notices `inbox` has accepted into `cell`, where it holds fewer,
 * and settles the runtime's reaction to the write. Returns the records the
 * cell holds afterwards.
 *
 * @throws Error when the write's commit is refused.
 */
export async function publishSentNotices(
  runtime: Runtime,
  cell: Cell<SentSpaceAccessNotice[]>,
  inbox: FakeInbox,
): Promise<SentSpaceAccessNotice[]> {
  const notices = sentNoticesOf(inbox.messages);
  if ((cell.get() ?? []).length === notices.length) return notices;
  const tx = runtime.edit();
  cell.withTx(tx).set(notices);
  runtime.prepareTxForCommit?.(tx);
  const result = await tx.commit();
  if (result.error) {
    throw new Error(
      `Reporting the run's space-access notices failed: ${result.error.message}`,
    );
  }
  await runtime.idle();
  return notices;
}
