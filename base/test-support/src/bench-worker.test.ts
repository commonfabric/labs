import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { BenchWorker } from "./bench-worker.ts";

/** A far side that acknowledges whatever it is sent. */
const ACKS =
  `data:application/javascript,self.onmessage=()=>self.postMessage({ok:true});`;

/** A far side that refuses whatever it is sent. */
const REFUSES =
  `data:application/javascript,self.onmessage=()=>self.postMessage({ok:false,error:"no"});`;

/** A far side that never answers, so a send stays in flight. */
const SILENT = `data:application/javascript,self.onmessage=()=>{};`;

/** A far side that fails on startup, before any request can be in flight. */
const DIES_AT_ONCE =
  `data:application/javascript,throw new Error("dead on arrival");`;

describe("BenchWorker", () => {
  describe("send()", () => {
    it("resolves when the far side acknowledges", async () => {
      const worker = new BenchWorker<number>(ACKS);

      try {
        await worker.send(1);
      } finally {
        worker.close();
      }
    });

    it("rejects when the far side refuses", async () => {
      const worker = new BenchWorker<number>(REFUSES);

      try {
        await expect(worker.send(1)).rejects.toThrow("Far side refused");
      } finally {
        worker.close();
      }
    });

    it("rejects a send made while another is in flight", async () => {
      // The first send is still outstanding, so the second would take its
      // acknowledgement and leave it unsettled.
      const worker = new BenchWorker<number>(SILENT);

      try {
        const first = worker.send(1);

        await expect(worker.send(2)).rejects.toThrow("already in flight");

        // `close()` settles the first, which is what lets this end.
        worker.close();
        await expect(first).rejects.toThrow("closed");
      } finally {
        worker.close();
      }
    });

    it("rejects a send made after the far side has already failed", async () => {
      // The failure that arrives with nothing in flight is the one a benchmark
      // cannot survive unrecorded: nothing is there to reject, so a later send
      // would wait for an acknowledgement that cannot come.
      //
      // Awaiting the first send is what puts this one after the failure rather
      // than in a race with it -- the failure is what settles that send, so by
      // the time it has, the record exists.
      const worker = new BenchWorker<number>(DIES_AT_ONCE);

      try {
        await expect(worker.send(1)).rejects.toThrow("Far side failed");
        await expect(worker.send(2)).rejects.toThrow("Far side failed");
      } finally {
        worker.close();
      }
    });
    it("does not latch when a request cannot be cloned", () => {
      // The request never reaches the far side, so nothing is in flight and the
      // refusal above must not treat it as though something were. A worker
      // stuck refusing every later send would end the run, not the request.
      const worker = new BenchWorker<unknown>(ACKS);

      return (async () => {
        try {
          await expect(worker.send(() => {})).rejects.toThrow(
            "could not be cloned",
          );
          await worker.send(1);
        } finally {
          worker.close();
        }
      })();
    });
  });

  describe("close()", () => {
    it("settles a request left in flight", async () => {
      // Terminating leaves an acknowledgement unable to arrive, so a request
      // still pending would wait for one forever.
      const worker = new BenchWorker<number>(SILENT);
      const pending = worker.send(1);

      worker.close();

      await expect(pending).rejects.toThrow("Far side was closed");
    });
  });
});
