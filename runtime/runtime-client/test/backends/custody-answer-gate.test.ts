/**
 * A custody room's answer, from the seals that fill its box to what a host
 * holding the default display ceiling is sent: the runner's seal, its answer
 * watch, and the worker's host read gate, none of them stood in for. Each has
 * tests of its own; this runs them as the worker composes them.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { defaultDisplayCeiling } from "@commonfabric/runner/cfc/default-display-ceiling";

import { createCellRef } from "@/backends/utils.ts";
import type { WorkerClient } from "@/backends/worker-client.ts";
import {
  type CustodyAnswerState,
  NotificationType,
  RequestType,
} from "@/protocol/mod.ts";

import {
  alice,
  bob,
  custodyRoom,
  mallory,
  S,
} from "../../../runner/test/support/custody-room.ts";
import { buildProcessor } from "./build-processor.ts";

describe("custody-answer-gate", () => {
  it("is sent as the gate admits it once the last seat seals, though the projected answer does not change", async () => {
    // The room's rule requires the seal's witness and releases only to the
    // seal, so the projected answer is the seal's alone to read, and the
    // published slot is what the host may be shown. The projector answers
    // before the last seat seals and its answer is the same after, so only
    // the box filling says the room is ready.

    const fixture = await custodyRoom();
    try {
      const room = fixture.runtimes.get(alice)!;
      const box = room.getCell(S, "room-cells").key("box");
      const output = room.getCell(S, "custody-room-choice");
      await fixture.seal(alice, "sushi", box);
      expect(await fixture.project(alice, box, output)).toBe("sushi");

      // The host is a member who has not sealed, so nothing the gate
      // consults has been loaded in its runtime before the watch starts. It
      // names the room's policy through a cell, as a pattern's `PolicyOf`
      // binding does.
      const runtime = fixture.runtimes.get(mallory)!;
      const tx = runtime.edit();
      const policy = runtime.getCell(
        mallory.did(),
        "room-policy",
        undefined,
        tx,
      );
      policy.set(fixture.policy as never);
      expect((await tx.commit().settled).error).toBeUndefined();

      const processor = buildProcessor({
        runtime,
        identity: mallory,
        space: mallory.did(),
      });
      processor.accessForTestingOnly.renderConfidentialityCeiling =
        defaultDisplayCeiling(mallory.did()) as never;

      // What the worker sends the host, each state resolving the wait for it.
      const sent: CustodyAnswerState[] = [];
      let waiting:
        | {
          test: (state: CustodyAnswerState) => boolean;
          resolve: (state: CustodyAnswerState) => void;
        }
        | undefined;
      const host: WorkerClient = {
        id: 1,
        post: (message) => {
          const update = message as {
            type?: string;
            watchId?: string;
            state?: CustodyAnswerState;
          };
          if (
            update.type !== NotificationType.CustodyAnswerUpdate ||
            update.watchId !== "room"
          ) return true;
          sent.push(update.state!);
          if (waiting?.test(update.state!)) {
            waiting.resolve(update.state!);
            waiting = undefined;
          }
          return true;
        },
      };
      const until = (test: (state: CustodyAnswerState) => boolean) => {
        const { promise, resolve } = Promise.withResolvers<
          CustodyAnswerState
        >();
        waiting = { test, resolve };
        return promise;
      };

      const pending = until((state) => state.status === "pending");
      await processor.handleRequest({
        type: RequestType.CustodyAnswerWatch,
        watchId: "room",
        terms: createCellRef(fixture.terms),
        policy: createCellRef(policy.withTx(undefined)),
        output: createCellRef(output),
      }, host);
      try {
        expect(await pending).toEqual({ status: "pending" });

        const published = until((state) => state.status === "published");
        await fixture.seal(bob, "sushi", box);

        // The first answer the host is sent is the gate's decision made on
        // what it consults, loaded: the answer itself.
        expect(await published).toEqual({
          status: "published",
          instance: expect.any(String),
          publishedHere: true,
          answer: { value: "sushi" },
        });
        expect(sent.map((state) => state.status)).toEqual([
          "pending",
          "published",
        ]);
      } finally {
        await processor.handleRequest({
          type: RequestType.CustodyAnswerUnwatch,
          watchId: "room",
        }, host);
      }
    } finally {
      await fixture.dispose();
    }
  });
});
