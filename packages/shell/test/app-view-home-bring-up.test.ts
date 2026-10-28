// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { defer } from "@commonfabric/utils/defer";

import { installBrowserGlobals } from "./browser-globals.ts";

const PAGE_HREF = "http://localhost:8000/home-bring-up";

/**
 * A runtime that answers the space's root with a piece, and records in `log`,
 * under `name`, each request to idle and each to bring Home up, marking one
 * that brings up only an existing Home. `ensured` resolves at the first
 * bring-up.
 */
function stubRuntime(log: string[], name: string) {
  const ensured = defer();
  let ensures = 0;
  const client = {
    idle: () => {
      log.push(`${name} idle`);
      return Promise.resolve();
    },
    ensureHomePatternRunning: (options?: { existingOnly?: boolean }) => {
      log.push(`${name} ensure${options?.existingOnly ? " existing" : ""}`);
      ensures++;
      ensured.resolve();
      return Promise.resolve({});
    },
    joinVisitedRoom: () => Promise.resolve(undefined),
  };
  const rt = {
    signal: new AbortController().signal,
    getSpaceRootPattern: () => Promise.resolve({ id: () => "root" }),
    runtime: () => client,
  };
  return {
    rt,
    ensured: ensured.promise,
    get ensures() {
      return ensures;
    },
  };
}

describe("XAppView Home bring-up", () => {
  it("asks its runtime to bring up an existing Home after its first piece is on screen and the view has settled", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const log: string[] = [];
      const runtime = stubRuntime(log, "rt");
      const view = new XAppView();
      view.app = {
        view: { spaceDid: "did:key:z6Mk-shell-home-bring-up" as DID },
      } as never;
      view.space = "did:key:z6Mk-shell-home-bring-up" as DID;
      view.rt = runtime.rt as never;

      // An update with no piece on screen yet.
      view.updated(new Map());

      log.push("shown");
      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._patterns.run();
      await view._patterns.taskComplete;
      view.updated(new Map());
      await runtime.ensured;

      expect(log).toEqual(["shown", "rt idle", "rt ensure existing"]);
    } finally {
      restore();
    }
  });

  it("returns from `homeBringUp` a bring-up started at the decision, which resolves once the worker has answered", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const log: string[] = [];
      const runtime = stubRuntime(log, "rt");
      const asked = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<Record<string, never>>();
      runtime.rt.runtime().ensureHomePatternRunning = (options) => {
        log.push(`rt ensure${options?.existingOnly ? " existing" : ""}`);
        asked.resolve();
        return answer.promise;
      };
      const view = new XAppView();
      view.app = {
        view: { spaceDid: "did:key:z6Mk-shell-home-bring-up-wait" as DID },
      } as never;
      view.space = "did:key:z6Mk-shell-home-bring-up-wait" as DID;
      view.rt = runtime.rt as never;

      view.updated(new Map());
      expect(view.homeBringUp).toBeUndefined();

      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._patterns.run();
      await view._patterns.taskComplete;
      view.updated(new Map());
      const bringUp = view.homeBringUp;
      expect(bringUp).toBeInstanceOf(Promise);

      // Once the worker is asked, draining the task queue (all microtasks, then
      // one macrotask) runs every continuation a bring-up that did not wait
      // for the answer would take to resolve.
      let done = false;
      const settling = bringUp!.then(() => {
        done = true;
      });
      await asked.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect({ log, done }).toEqual({
        log: ["rt idle", "rt ensure existing"],
        done: false,
      });

      answer.resolve({});
      await settling;
      expect(done).toBe(true);
    } finally {
      restore();
    }
  });

  it("asks each runtime to bring Home up once", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const log: string[] = [];
      const first = stubRuntime(log, "first");
      const second = stubRuntime(log, "second");
      const view = new XAppView();
      view.app = {
        view: { spaceDid: "did:key:z6Mk-shell-home-bring-up-twice" as DID },
      } as never;
      view.space = "did:key:z6Mk-shell-home-bring-up-twice" as DID;
      view.rt = first.rt as never;
      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._patterns.run();
      await view._patterns.taskComplete;

      view.updated(new Map());
      view.updated(new Map());
      await first.ensured;
      view.updated(new Map());

      // A replacement runtime is a worker of its own, so it is asked too. Any
      // second request to the first runtime would have been made by now.
      view.rt = second.rt as never;
      view.updated(new Map());
      await second.ensured;

      expect(first.ensures).toBe(1);
      expect(second.ensures).toBe(1);
    } finally {
      restore();
    }
  });
});
