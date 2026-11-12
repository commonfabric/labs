/**
 * A host's watch of a custody room's answer.
 *
 * Whether the seal can publish is decided by cells only the seal may read,
 * so the runner's watch (`watchCustodyAnswer`) follows them in the worker,
 * publishes once the seal can, and reports what the room's instance has
 * published. The host shows the answer, which makes it a display sink like
 * any read a host makes, so what the host is sent of it is the host-read
 * gate's decision on a read of the answer, under the display ceiling, decided
 * again whenever what it consulted changes.
 */

import { fabricAwareEqual, type FabricValue } from "@commonfabric/data-model";
import type { Cancel, Cell } from "@commonfabric/runner";
import {
  type CustodyRoom,
  watchCustodyAnswer,
} from "@commonfabric/runner/cfc/custody-seal";

import type { CustodyAnswerState } from "@/protocol/mod.ts";
import type { HostReadGate } from "./host-read-gate.ts";
import { createCellRef } from "./utils.ts";

/** What the host is told when the slot holds what the seal did not verify. */
const UNVERIFIED_SLOT = "Custody answer refuses a slot the seal did not write";

/**
 * Watches `room`'s answer for a host, calling `send` with each change in what
 * the host is to show: nothing published yet, with the reason an attempt
 * failed where one did, or the published answer as `gate` decides a read of
 * it. A state equal to the one last sent is not sent again. `watch` is the
 * seal's watch, which a test replaces to report what it chooses.
 */
export function watchCustodyAnswerForHost(
  gate: HostReadGate,
  room: CustodyRoom,
  output: Cell<unknown>,
  send: (state: CustodyAnswerState) => void,
  watch: typeof watchCustodyAnswer = watchCustodyAnswer,
): Cancel {
  let sent: CustodyAnswerState | undefined;
  const deliver = (state: CustodyAnswerState): void => {
    if (
      sent !== undefined &&
      fabricAwareEqual(sent as FabricValue, state as FabricValue)
    ) return;
    sent = state;
    send(state);
  };
  // The instance whose answer is shown, and the gate's subscription that
  // decides it again.
  let shown: { instance: string; cancel: Cancel } | undefined;
  const stopShowing = (): void => {
    shown?.cancel();
    shown = undefined;
  };
  const cancelWatch = watch(room, output, (update) => {
    if (update.status === "pending") {
      stopShowing();
      deliver(update);
      return;
    }
    // The answer published for an instance never changes, so an instance
    // already shown is decided by the subscription already standing.
    if (shown?.instance === update.instance) return;
    stopShowing();
    const { instance, publishedHere, answer, value } = update;
    const showing = { ended: false, cancel: (() => {}) as Cancel };
    shown = {
      instance,
      cancel: () => {
        showing.ended = true;
        showing.cancel();
      },
    };
    // The access lists and policy manifests the decision consults are
    // loaded first, so that the first decision the host is sent is made on
    // them rather than refusing on one not yet synced. The subscription then
    // decides the read again when a label it consumed, or the membership or
    // policy those labels name, changes; each decision it makes is answered
    // by a read the gate builds, which is what the host is sent.
    void gate.settle(answer).then(() => {
      if (showing.ended) return;
      showing.cancel = gate.subscribe(
        answer,
        createCellRef(answer),
        {},
        () => {},
        () => {
          const read = gate.read(answer);
          // The slot is create-only and the seal's, so a value other than
          // the one the seal's watch verified is not the seal's write.
          if (!("refused" in read) && !fabricAwareEqual(read.value, value)) {
            deliver({ status: "pending", error: UNVERIFIED_SLOT });
            return;
          }
          deliver({
            status: "published",
            instance,
            publishedHere,
            answer: read,
          });
        },
      );
    });
  });
  return () => {
    cancelWatch();
    stopShowing();
  };
}
