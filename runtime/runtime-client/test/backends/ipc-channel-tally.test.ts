import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { approximateJsonSize } from "@commonfabric/utils/approximate-json-size";

import {
  IPC_SAMPLE_STRIDE,
  IpcChannelTally,
} from "@/backends/ipc-channel-tally.ts";

describe("IpcChannelTally", () => {
  describe("instance members", () => {
    describe("note()", () => {
      it("measures the first message and one in every stride after, and counts the rest", () => {
        const tally = new IpcChannelTally();
        const encoded = ["marker", { text: "hello" }];
        const { bytes } = approximateJsonSize(encoded);
        for (let sent = 0; sent < IPC_SAMPLE_STRIDE + 1; sent++) {
          tally.note(encoded);
        }

        expect(tally.snapshot()).toEqual({
          messages: IPC_SAMPLE_STRIDE + 1,
          sampledMessages: 2,
          sampledBytes: bytes * 2,
          approxBytes: bytes * (IPC_SAMPLE_STRIDE + 1),
        });
      });
    });

    describe("add()", () => {
      it("adds another channel's counts and its own estimate to this one's", () => {
        const tally = new IpcChannelTally();
        tally.note("one");
        tally.add({
          messages: 10,
          sampledMessages: 1,
          sampledBytes: 95,
          approxBytes: 950,
        });

        expect(tally.snapshot()).toEqual({
          messages: 11,
          sampledMessages: 2,
          sampledBytes: 100,
          approxBytes: 955,
        });
      });

      it("keeps each added channel's estimate whatever fraction of its traffic it sampled", () => {
        // A long-lived channel sampled one message in sixteen; a short-lived
        // one sampled its only message. Pooling the two samples would weigh
        // the small message as heavily as the large ones.
        const large = new IpcChannelTally();
        const message = "x".repeat(1_000_000);
        for (let sent = 0; sent < IPC_SAMPLE_STRIDE; sent++) {
          large.note(message);
        }
        const small = new IpcChannelTally();
        small.note("y");
        const departed = new IpcChannelTally();

        departed.add(large.snapshot());
        const withLarge = departed.snapshot().approxBytes;
        departed.add(small.snapshot());

        expect(withLarge).toBe(
          approximateJsonSize(message).bytes * IPC_SAMPLE_STRIDE,
        );
        expect(departed.snapshot().approxBytes).toBe(
          withLarge + approximateJsonSize("y").bytes,
        );
      });
    });

    describe("snapshot()", () => {
      it("returns zero bytes for a channel that carried nothing", () => {
        expect(new IpcChannelTally().snapshot()).toEqual({
          messages: 0,
          sampledMessages: 0,
          sampledBytes: 0,
          approxBytes: 0,
        });
      });

      it("scales the sampled bytes to every message, measured or not", () => {
        const tally = new IpcChannelTally();
        const large = "x".repeat(1_000);
        tally.note(large);
        for (let sent = 1; sent < IPC_SAMPLE_STRIDE; sent++) tally.note("y");

        const sizes = tally.snapshot();
        expect(sizes.sampledMessages).toBe(1);
        expect(sizes.approxBytes).toBe(
          approximateJsonSize(large).bytes * IPC_SAMPLE_STRIDE,
        );
      });
    });
  });
});
