// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { DID } from "@commonfabric/identity";

import { installBrowserGlobals } from "./browser-globals.ts";

const PAGE_HREF = "http://localhost:8000/visit-join";

const FIRST_SPACE = "did:key:z6Mk-shell-visit-join-first" as DID;
const SECOND_SPACE = "did:key:z6Mk-shell-visit-join-second" as DID;

/**
 * A runtime that answers the space's root with a piece, and records in `log`
 * each request to idle, each to bring Home up, and each to join a visited
 * room, with its space. Each join is answered by the next of `answers`, a
 * thrown error rejecting the request, and by `sent` once they run out. The
 * runtime's signal is `controller`'s.
 */
function stubRuntime(
  log: string[],
  answers: (string | Error)[] = [],
  controller = new AbortController(),
) {
  const client = {
    idle: () => {
      log.push("idle");
      return Promise.resolve();
    },
    ensureHomePatternRunning: () => {
      log.push("ensure");
      return Promise.resolve({});
    },
    joinVisitedRoom: (space: DID) => {
      log.push(`join ${space}`);
      const answer = answers.shift() ?? "sent";
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
  return {
    signal: controller.signal,
    getSpaceRootPattern: () => Promise.resolve({ id: () => "root" }),
    runtime: () => client,
  };
}

describe("XAppView visit join", () => {
  it("asks its runtime to join the shown space's room once Home's bring-up has answered and the view has settled", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const log: string[] = [];
      const view = new XAppView();
      view.app = { view: { spaceDid: FIRST_SPACE } } as never;
      view.space = FIRST_SPACE;
      view.rt = stubRuntime(log) as never;

      // An update with no piece on screen yet asks nothing, and leaves the view
      // nothing to settle for.
      view.updated(new Map());
      expect(view.visitJoin).toBeUndefined();
      expect(view.settling).toBeUndefined();

      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._patterns.run();
      await view._patterns.taskComplete;
      view.updated(new Map());
      // A settle of the view waits for the join, which waits for Home's
      // bring-up.
      expect(view.settling).toBe(view.visitJoin);
      await view.settling;

      expect(log).toEqual(["idle", "ensure", "idle", `join ${FIRST_SPACE}`]);
    } finally {
      restore();
    }
  });

  it("asks again for each new space shown, and not again for the same one", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const log: string[] = [];
      const view = new XAppView();
      view.app = { view: { spaceDid: FIRST_SPACE } } as never;
      view.space = FIRST_SPACE;
      view.rt = stubRuntime(log) as never;
      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._patterns.run();
      await view._patterns.taskComplete;
      view.updated(new Map());
      await view.visitJoin;
      view.updated(new Map());
      await view.visitJoin;

      view.space = SECOND_SPACE;
      view.updated(new Map());
      await view.visitJoin;
      view.space = FIRST_SPACE;
      view.updated(new Map());
      await view.visitJoin;

      expect(log.filter((entry) => entry.startsWith("join "))).toEqual([
        `join ${FIRST_SPACE}`,
        `join ${SECOND_SPACE}`,
        `join ${FIRST_SPACE}`,
      ]);
    } finally {
      restore();
    }
  });

  it("asks again at the next update after a join fails, and not after one the worker refuses", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    const error = stub(console, "error", () => {});
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const log: string[] = [];
      const view = new XAppView();
      view.app = { view: { spaceDid: FIRST_SPACE } } as never;
      view.space = FIRST_SPACE;
      view.rt = stubRuntime(log, [
        new Error("the worker went away"),
        "recipient-access-refused",
      ]) as never;
      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._patterns.run();
      await view._patterns.taskComplete;
      view.updated(new Map());
      await view.visitJoin;
      view.updated(new Map());
      await view.visitJoin;
      view.updated(new Map());
      await view.visitJoin;

      expect({
        joins: log.filter((entry) => entry.startsWith("join ")),
        errors: error.calls.length,
      }).toEqual({
        joins: [`join ${FIRST_SPACE}`, `join ${FIRST_SPACE}`],
        errors: 1,
      });
    } finally {
      error.restore();
      restore();
    }
  });

  it("asks nothing of a runtime torn down while the view settles", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const log: string[] = [];
      const controller = new AbortController();
      const runtime = stubRuntime(log, [], controller);
      // The runtime is torn down while the view settles.
      runtime.runtime().idle = () => {
        log.push("idle");
        controller.abort();
        return Promise.resolve();
      };
      const view = new XAppView();
      view.app = { view: { spaceDid: FIRST_SPACE } } as never;
      view.space = FIRST_SPACE;
      view.rt = runtime as never;
      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._patterns.run();
      await view._patterns.taskComplete;
      view.updated(new Map());
      await view.visitJoin;

      expect(log.filter((entry) => entry.startsWith("join "))).toEqual([]);
    } finally {
      restore();
    }
  });

  it("reports nothing, and asks nothing more, when a join fails once its runtime is torn down", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    const error = stub(console, "error", () => {});
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const log: string[] = [];
      const controller = new AbortController();
      const runtime = stubRuntime(log, [], controller);
      // The join fails because its runtime was torn down under it.
      runtime.runtime().joinVisitedRoom = (space: DID) => {
        log.push(`join ${space}`);
        controller.abort();
        return Promise.reject(new Error("the runtime is gone"));
      };
      const view = new XAppView();
      view.app = { view: { spaceDid: FIRST_SPACE } } as never;
      view.space = FIRST_SPACE;
      view.rt = runtime as never;
      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._patterns.run();
      await view._patterns.taskComplete;
      view.updated(new Map());
      await view.visitJoin;
      view.updated(new Map());
      await view.visitJoin;

      expect({
        joins: log.filter((entry) => entry.startsWith("join ")),
        errors: error.calls.length,
      }).toEqual({ joins: [`join ${FIRST_SPACE}`], errors: 0 });
    } finally {
      error.restore();
      restore();
    }
  });
});
