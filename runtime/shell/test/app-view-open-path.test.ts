// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { TaskStatus } from "@lit/task";
import type { DID } from "@commonfabric/identity";

import { installBrowserGlobals } from "./browser-globals.ts";

const PAGE_HREF = "http://localhost:8000/open-path";
const SPACE = "did:key:z6Mk-shell-app-view-open-path" as DID;

/**
 * A runtime whose every piece exports an `openPath` stream, or whose read of
 * the export fails with `failure` when one is given. `reads` counts the reads
 * of the export, `sends` the values sent to the stream, and `sent` resolves
 * with the first of them. Where `held`, each read waits for `answerReads()`.
 */
function stubRuntime(
  { failure, held = false }: { failure?: Error; held?: boolean } = {},
) {
  const sent = Promise.withResolvers<unknown>();
  const sends: unknown[] = [];
  const waiting: (() => void)[] = [];
  let reads = 0;
  const cell = {
    asSchema: () => ({
      sync: () => {
        reads++;
        if (failure) return Promise.reject(failure);
        const answer = { openPath: { $stream: true } };
        if (!held) return Promise.resolve(answer);
        return new Promise((resolve) => waiting.push(() => resolve(answer)));
      },
      key: () => ({
        send: (value: unknown) => {
          sends.push(value);
          sent.resolve(value);
          return Promise.resolve();
        },
      }),
    }),
  };
  return {
    sent: sent.promise,
    sends,
    get reads() {
      return reads;
    },
    answerReads: () => waiting.splice(0).forEach((answer) => answer()),
    rt: {
      signal: new AbortController().signal,
      getPattern: () =>
        Promise.resolve({ id: () => "fid1:piece", cell: () => cell }),
      getSlug: () => Promise.resolve(undefined),
    },
  };
}

/** A view of `view` under `runtime`. */
async function appViewOver(
  runtime: ReturnType<typeof stubRuntime>,
  view: Record<string, unknown>,
) {
  const { XAppView } = await import("../src/views/AppView.ts");
  const element = new XAppView();
  element.app = { identity: {}, config: {}, view } as never;
  element.space = SPACE;
  element.rt = runtime.rt as never;
  return element;
}

describe("XAppView deep link", () => {
  it("delivers the deep link it was opened with into the piece it loads, once", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const runtime = stubRuntime();
      const view = await appViewOver(runtime, {
        spaceDid: SPACE,
        pieceId: "fid1:piece",
        openPath: "/cabinet/drawer",
      });

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;
      const sent = await runtime.sent;
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      // The second run is asked nothing at all: the link was delivered.
      expect({ sent, reads: runtime.reads }).toEqual({
        sent: { path: "/cabinet/drawer" },
        reads: 1,
      });
    } finally {
      restore();
    }
  });

  it("sends the deep link once when a second run asked before the first had its answer", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const runtime = stubRuntime({ held: true });
      const view = await appViewOver(runtime, {
        spaceDid: SPACE,
        pieceId: "fid1:piece",
        openPath: "/cabinet/drawer",
      });

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;
      runtime.answerReads();
      await runtime.sent;

      // Both runs asked, and whichever answer is in first claims the link.
      expect({ reads: runtime.reads, sends: runtime.sends }).toEqual({
        reads: 2,
        sends: [{ path: "/cabinet/drawer" }],
      });
    } finally {
      restore();
    }
  });

  it("asks nothing of a piece opened without a deep link", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const runtime = stubRuntime();
      const view = await appViewOver(runtime, {
        spaceDid: SPACE,
        pieceId: "fid1:piece",
      });

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      expect(runtime.reads).toBe(0);
    } finally {
      restore();
    }
  });

  it("reports a deep link it fails to deliver, and shows the piece all the same", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    const reported = Promise.withResolvers<unknown[]>();
    const error = stub(console, "error", (...args: unknown[]) => {
      reported.resolve(args);
    });
    try {
      const runtime = stubRuntime({
        failure: new Error("the piece went away"),
      });
      const view = await appViewOver(runtime, {
        spaceDid: SPACE,
        pieceId: "fid1:piece",
        openPath: "/cabinet/drawer",
      });

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;
      const [message, cause] = await reported.promise;

      expect({
        status: view._selectedPattern.status,
        message,
        cause: String(cause),
      }).toEqual({
        status: TaskStatus.COMPLETE,
        message: "[AppView] Failed to deliver the deep link:",
        cause: "Error: the piece went away",
      });
    } finally {
      error.restore();
      restore();
    }
  });
});
