import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ConsoleRunDetail } from "../../../console/run-store.ts";
import { ConsoleRunView } from "../../../console/src/run-view.ts";

const realFetch = globalThis.fetch;

/**
 * A fetch whose answers the test releases by hand, in whatever order it likes.
 * Nothing here waits on a span of time: each read is resolved explicitly, and
 * the promise the view returned is what the test awaits.
 */
const heldFetch = (): readonly PromiseWithResolvers<Response>[] => {
  const held: PromiseWithResolvers<Response>[] = [];
  globalThis.fetch = () => {
    const pending = Promise.withResolvers<Response>();
    held.push(pending);
    return pending.promise;
  };
  return held;
};

const detailOf = (runId: string): Response =>
  Response.json(
    {
      summary: { runId },
      steps: [],
      handles: [],
      artifactNames: [],
      toolOutputNames: [],
    } as unknown as ConsoleRunDetail,
  );

describe("console/src/run-view", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe("refresh", () => {
    it("keeps the run that was asked for last when an earlier read answers after it", async () => {
      const held = heldFetch();
      const view = new ConsoleRunView();
      view.runId = "run-first";
      const first = view.refresh();
      view.runId = "run-second";
      const second = view.refresh();

      held[1].resolve(detailOf("run-second"));
      await second;
      held[0].resolve(detailOf("run-first"));
      await first;

      expect(view.detail?.summary.runId).toBe("run-second");
    });

    it("leaves the newest run showing when an earlier read fails after it", async () => {
      const held = heldFetch();
      const view = new ConsoleRunView();
      view.runId = "run-first";
      const first = view.refresh();
      view.runId = "run-second";
      const second = view.refresh();

      held[1].resolve(detailOf("run-second"));
      await second;
      held[0].resolve(new Response("not found", { status: 404 }));
      await first;

      expect(view.error).toBeUndefined();
      expect(view.detail?.summary.runId).toBe("run-second");
    });

    it("clears the detail rather than adopting a read of the run that was closed", async () => {
      const held = heldFetch();
      const view = new ConsoleRunView();
      view.runId = "run-first";
      const first = view.refresh();
      view.runId = undefined;
      await view.refresh();

      held[0].resolve(detailOf("run-first"));
      await first;

      expect(view.detail).toBeUndefined();
    });
  });
});
