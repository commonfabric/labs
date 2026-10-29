// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { TaskStatus } from "@lit/task";
import type { DID } from "@commonfabric/identity";

import { installBrowserGlobals } from "./browser-globals.ts";

const PAGE_HREF = "http://localhost:8000/load-recovery";
const SPACE = "did:key:z6Mk-shell-app-view-connection-restored" as DID;
const OTHER_SPACE = "did:key:z6Mk-shell-app-view-connection-other" as DID;

/**
 * A runtime whose loads fail while `failing` is set, whose next piece load
 * settles as `held` does when that is set, which records each piece load and
 * each root load it is asked for, and on which a test dispatches
 * `connectionrestored` as the real one does once a connection comes back,
 * and `spaceaccessrestored` as it does once a space admits its principal
 * again.
 */
function stubRuntime() {
  const target = new EventTarget();
  const pieceLoads: unknown[][] = [];
  let rootLoads = 0;
  const state: {
    failing: boolean;
    held?: PromiseWithResolvers<{ id: () => string }>;
  } = { failing: true };
  const rt = {
    signal: new AbortController().signal,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    getPattern: (...args: unknown[]) => {
      pieceLoads.push(args);
      const held = state.held;
      if (held) {
        state.held = undefined;
        return held.promise;
      }
      return state.failing
        ? Promise.reject(new Error("the socket went away"))
        : Promise.resolve({ id: () => "fid1:piece" });
    },
    getSlug: () => Promise.resolve(undefined),
    getSpaceRootPattern: () => {
      rootLoads++;
      return state.failing
        ? Promise.reject(new Error("the socket went away"))
        : Promise.resolve({ id: () => "root" });
    },
    // What handing a runtime to the view's debugger controller reads.
    telemetry: () => [],
    runtime: () => ({
      setTelemetryEnabled: () => Promise.resolve(),
      setBreakpoints: () => Promise.resolve(),
    }),
  };
  return {
    rt,
    state,
    pieceLoads,
    get rootLoads() {
      return rootLoads;
    },
    restore: () => target.dispatchEvent(new Event("connectionrestored")),
    grant: (space: DID) =>
      target.dispatchEvent(
        new CustomEvent("spaceaccessrestored", { detail: { space } }),
      ),
  };
}

/** A view of `view` under `runtime`, updated as Lit would on getting both. */
async function appViewOver(
  runtime: ReturnType<typeof stubRuntime>,
  view: Record<string, unknown>,
) {
  const { XAppView } = await import("../src/views/AppView.ts");
  const element = new XAppView();
  element.app = { identity: {}, config: {}, view } as never;
  element.space = SPACE;
  element.rt = runtime.rt as never;
  element.updated(new Map([["app", undefined], ["rt", undefined]]));
  return element;
}

describe("XAppView recovering a failed load", () => {
  describe("once a lost connection is restored", () => {
    it("runs a selection showing a failed load again, and shows the piece", async () => {
      const restore = installBrowserGlobals(PAGE_HREF);
      const errors = stub(console, "error", () => {});
      try {
        const runtime = stubRuntime();
        const view = await appViewOver(runtime, { pieceId: "fid1:piece" });
        view._selectedPattern.run();
        await view._selectedPattern.taskComplete.catch(() => {});
        expect(view._selectedPattern.status).toBe(TaskStatus.ERROR);
        const loadsAfterFailure = runtime.pieceLoads.length;

        runtime.state.failing = false;
        runtime.restore();
        await view._selectedPattern.taskComplete;

        expect(view._selectedPattern.status).toBe(TaskStatus.COMPLETE);
        expect(view._selectedPattern.value?.id()).toBe("fid1:piece");
        expect(runtime.pieceLoads.length).toBeGreaterThan(loadsAfterFailure);
      } finally {
        errors.restore();
        restore();
      }
    });

    it("runs a space root showing a failed load again, and shows the root", async () => {
      const restore = installBrowserGlobals(PAGE_HREF);
      const errors = stub(console, "error", () => {});
      try {
        const runtime = stubRuntime();
        const view = await appViewOver(runtime, { spaceDid: SPACE });
        view._spaceRootPattern.run();
        await view._spaceRootPattern.taskComplete.catch(() => {});
        expect(view._spaceRootPattern.status).toBe(TaskStatus.ERROR);
        expect(runtime.rootLoads).toBe(1);

        runtime.state.failing = false;
        runtime.restore();
        await view._spaceRootPattern.taskComplete;

        expect(view._spaceRootPattern.status).toBe(TaskStatus.COMPLETE);
        expect(view._spaceRootPattern.value?.id()).toBe("root");
        expect(runtime.rootLoads).toBe(2);
      } finally {
        errors.restore();
        restore();
      }
    });

    it("runs a selection whose load was in flight when the connection was restored again, once that load fails", async () => {
      const restore = installBrowserGlobals(PAGE_HREF);
      const errors = stub(console, "error", () => {});
      try {
        const runtime = stubRuntime();
        runtime.state.failing = false;
        const held = Promise.withResolvers<{ id: () => string }>();
        runtime.state.held = held;
        const view = await appViewOver(runtime, { pieceId: "fid1:piece" });
        view._selectedPattern.run();
        expect(view._selectedPattern.status).toBe(TaskStatus.PENDING);

        runtime.restore();
        held.reject(new Error("the socket went away"));
        await view._selectedPattern.taskComplete.catch(() => {});
        await view._selectedPattern.taskComplete;

        expect(view._selectedPattern.status).toBe(TaskStatus.COMPLETE);
        expect(view._selectedPattern.value?.id()).toBe("fid1:piece");
      } finally {
        errors.restore();
        restore();
      }
    });

    it("runs nothing again for a selection showing its piece", async () => {
      const restore = installBrowserGlobals(PAGE_HREF);
      try {
        const runtime = stubRuntime();
        runtime.state.failing = false;
        const view = await appViewOver(runtime, { pieceId: "fid1:piece" });
        view._selectedPattern.run();
        await view._selectedPattern.taskComplete;
        const loadsShown = runtime.pieceLoads.length;

        runtime.restore();
        await view._selectedPattern.taskComplete;

        expect(view._selectedPattern.status).toBe(TaskStatus.COMPLETE);
        expect(runtime.pieceLoads).toHaveLength(loadsShown);
      } finally {
        restore();
      }
    });

    it("runs nothing again for a runtime it no longer shows, nor once it has left the document", async () => {
      const restore = installBrowserGlobals(PAGE_HREF);
      const errors = stub(console, "error", () => {});
      try {
        const replaced = stubRuntime();
        const view = await appViewOver(replaced, { spaceDid: SPACE });
        const current = stubRuntime();
        view.rt = current.rt as never;
        view.updated(new Map([["rt", replaced.rt]]));
        view._spaceRootPattern.run();
        await view._spaceRootPattern.taskComplete.catch(() => {});
        expect(current.rootLoads).toBe(1);

        replaced.restore();
        await view._spaceRootPattern.taskComplete.catch(() => {});
        expect(current.rootLoads).toBe(1);

        view.disconnectedCallback();
        current.restore();
        await view._spaceRootPattern.taskComplete.catch(() => {});
        expect(current.rootLoads).toBe(1);
        expect(view._spaceRootPattern.status).toBe(TaskStatus.ERROR);
      } finally {
        errors.restore();
        restore();
      }
    });
  });

  describe("once its space admits the runtime's principal again", () => {
    it("runs a selection showing a failed load again, and shows the piece", async () => {
      const restore = installBrowserGlobals(PAGE_HREF);
      const errors = stub(console, "error", () => {});
      try {
        const runtime = stubRuntime();
        const view = await appViewOver(runtime, { pieceId: "fid1:piece" });
        view._selectedPattern.run();
        await view._selectedPattern.taskComplete.catch(() => {});
        expect(view._selectedPattern.status).toBe(TaskStatus.ERROR);

        runtime.state.failing = false;
        runtime.grant(SPACE);
        await view._selectedPattern.taskComplete;

        expect(view._selectedPattern.status).toBe(TaskStatus.COMPLETE);
        expect(view._selectedPattern.value?.id()).toBe("fid1:piece");
      } finally {
        errors.restore();
        restore();
      }
    });

    it("runs a space root showing a failed load again, and shows the root", async () => {
      const restore = installBrowserGlobals(PAGE_HREF);
      const errors = stub(console, "error", () => {});
      try {
        const runtime = stubRuntime();
        const view = await appViewOver(runtime, { spaceDid: SPACE });
        view._spaceRootPattern.run();
        await view._spaceRootPattern.taskComplete.catch(() => {});
        expect(view._spaceRootPattern.status).toBe(TaskStatus.ERROR);

        runtime.state.failing = false;
        runtime.grant(SPACE);
        await view._spaceRootPattern.taskComplete;

        expect(view._spaceRootPattern.status).toBe(TaskStatus.COMPLETE);
        expect(runtime.rootLoads).toBe(2);
      } finally {
        errors.restore();
        restore();
      }
    });

    it("runs nothing again when another space admits it", async () => {
      const restore = installBrowserGlobals(PAGE_HREF);
      const errors = stub(console, "error", () => {});
      try {
        const runtime = stubRuntime();
        const view = await appViewOver(runtime, { spaceDid: SPACE });
        view._spaceRootPattern.run();
        await view._spaceRootPattern.taskComplete.catch(() => {});

        runtime.grant(OTHER_SPACE);
        await view._spaceRootPattern.taskComplete.catch(() => {});

        expect(view._spaceRootPattern.status).toBe(TaskStatus.ERROR);
        expect(runtime.rootLoads).toBe(1);
      } finally {
        errors.restore();
        restore();
      }
    });
  });
});
