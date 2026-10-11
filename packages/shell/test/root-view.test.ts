// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  type ErrorNotification,
  type EventAttentionNotice,
  NotificationType,
  RuntimeErrorCode,
} from "@commonfabric/runtime-client";
import { templateMarkup } from "./lit-template-markup.ts";

// XRootView is a Lit element; load and exercise it under a minimal browser
// shim, mirroring login-view.test.ts. Constructing it runs its field
// initializers (including the runtime Task that reads
// isWorkerConsoleForwardingEnabled), and its pure methods render and report
// state without needing the reactive update lifecycle.
function installBrowserGlobals(): () => void {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  function setGlobal(name: string, value: unknown): void {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  class TestHTMLElement extends EventTarget {
    /**
     * Returns a minimal render root, so Lit's `connectedCallback`
     * (`createRenderRoot`, then `attachShadow`, then `adoptStyles`) runs
     * without a real DOM.
     */
    attachShadow() {
      return {
        adoptedStyleSheets: [],
        appendChild() {},
        append() {},
      };
    }
  }
  setGlobal("window", globalThis);
  setGlobal("HTMLElement", TestHTMLElement);
  setGlobal("customElements", {
    define() {},
    get() {},
    whenDefined: () => Promise.resolve(),
  });
  setGlobal("document", {
    documentElement: { style: {} },
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({
      style: {},
      setAttribute() {},
      append() {},
      appendChild() {},
    }),
    createTreeWalker: () => ({}),
    // The page publishes its deployment, as a toolshed with MEMORY_PUBLIC_URL
    // and sharing on serves it.
    querySelector: (selector: string) =>
      selector === 'meta[name="cf-deployment"]'
        ? {
          getAttribute: (name: string) =>
            name === "content"
              ? JSON.stringify({
                memoryUrl: "https://router.root-view.test",
                experimental: { sharedMemoryConnection: true },
              })
              : null,
        }
        : null,
  });
  setGlobal("devicePixelRatio", 1);
  setGlobal("screen", { deviceXDPI: 1, logicalXDPI: 1 });
  setGlobal("navigator", { platform: "", userAgent: "deno" });
  setGlobal("location", {
    protocol: "http:",
    host: "localhost:8000",
    hostname: "localhost",
    origin: "http://localhost:8000",
    href: "http://localhost:8000/common-knowledge",
  });

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  };
}

function templateStrings(value: unknown): string {
  const result = value as { strings?: readonly string[] };
  return (result?.strings ?? []).join("");
}

describe("XRootView", () => {
  it("throws naming the value, given a command event carrying a non-command", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const event = new CustomEvent("command", { detail: { type: "bogus" } });
      expect(() => view.onCommand(event)).toThrow(
        'Received a non-command: `{type:"bogus"}`',
      );
    } finally {
      restore();
    }
  });

  it("constructs with default app state and renders the app view", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();

      // A fresh root has no resolved space yet, and state() clones out the
      // default app state.
      expect(view.getRuntimeSpaceDID()).toBeUndefined();
      const state = view.state();
      expect(state).toBeDefined();
      expect(state).not.toBe(view.app);

      // render() builds the themed app-view template without a live DOM.
      const markup = templateStrings(view.render());
      expect(markup).toContain("cf-theme");
      expect(markup).toContain("x-app-view");
    } finally {
      restore();
    }
  });

  it("replaces the current worker after a compiler chunk load failure", async () => {
    const restore = installBrowserGlobals();
    const originalError = console.error;
    console.error = () => {};
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const runs: unknown[] = [];
      view.accessForTestingOnly.rt = {
        run: (args: unknown) => runs.push(args),
      } as never;
      const failedGeneration = view.accessForTestingOnly.runtimeGeneration;
      const event: ErrorNotification = {
        type: NotificationType.ErrorReport,
        message: "Failed to load the compiler stack",
        code: RuntimeErrorCode.CompilerStackLoadFailed,
      };

      view._handleRuntimeError(event, failedGeneration);
      expect(runs).toEqual([[view.app]]);

      // A second signal from the worker being replaced is stale and ignored.
      view._handleRuntimeError(event, failedGeneration);
      expect(runs).toHaveLength(1);

      // Ordinary runtime errors remain diagnostics, not lifecycle events.
      view._handleRuntimeError({
        type: NotificationType.ErrorReport,
        message: "ordinary runtime error",
      });
      expect(runs).toHaveLength(1);
    } finally {
      console.error = originalError;
      restore();
    }
  });

  it("passes the page's memory URL and flags to RuntimeInternals", async () => {
    const restore = installBrowserGlobals();
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
    const originalCreate = RuntimeInternals.create;
    const captured: {
      apiUrl?: URL;
      memoryUrl?: URL;
      sharedMemoryConnection?: boolean;
    }[] = [];
    RuntimeInternals.create = ((options) => {
      captured.push({
        apiUrl: options.apiUrl,
        memoryUrl: options.memoryUrl,
        sharedMemoryConnection: options.experimental?.sharedMemoryConnection,
      });
      return Promise.resolve({
        runtime: () => ({
          on: () => {},
          off: () => {},
          listEventAttention: () => Promise.resolve([]),
        }),
        dispose: () => Promise.resolve(),
      } as unknown as Awaited<ReturnType<typeof RuntimeInternals.create>>);
    }) as typeof RuntimeInternals.create;

    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      view.app = {
        ...view.app,
        identity: await Identity.fromPassphrase("root-view-memory-url-test"),
      };
      const task = view.accessForTestingOnly.rt;
      task.run([view.app]);
      await task.taskComplete;
      expect(
        captured.map(({ apiUrl, memoryUrl, sharedMemoryConnection }) => [
          apiUrl?.href,
          memoryUrl?.href,
          sharedMemoryConnection,
        ]),
      ).toEqual([[
        "http://localhost:8000/",
        "https://router.root-view.test/",
        // Adopted from the page: no define is set in a test run.
        true,
      ]]);
    } finally {
      RuntimeInternals.create = originalCreate;
      delete (globalThis as { commonfabric?: unknown }).commonfabric;
      restore();
    }
  });

  it("passes a generation-bound error callback to RuntimeInternals", async () => {
    const restore = installBrowserGlobals();
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
    const originalCreate = RuntimeInternals.create;
    let capturedOnError: ((event: ErrorNotification) => void) | undefined;
    let capturedWorkerUrl: URL | undefined;
    const offCalls: unknown[] = [];
    const fakeRuntime = {
      on: () => {},
      off: (...args: unknown[]) => offCalls.push(args),
      listEventAttention: () => Promise.resolve([]),
    };
    RuntimeInternals.create = ((options) => {
      capturedOnError = options.onError;
      capturedWorkerUrl = options.workerUrl;
      return Promise.resolve({
        runtime: () => fakeRuntime,
        dispose: () => Promise.resolve(),
      } as unknown as Awaited<ReturnType<typeof RuntimeInternals.create>>);
    }) as typeof RuntimeInternals.create;

    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      view.app = {
        ...view.app,
        identity: await Identity.fromPassphrase(
          "root-view-runtime-error-callback-test",
        ),
      };
      const task = view.accessForTestingOnly.rt;

      task.run([view.app]);
      await task.taskComplete;
      expect(capturedOnError).toBeDefined();
      expect(capturedWorkerUrl?.pathname).toBe("/scripts/worker-runtime.js");

      const event: ErrorNotification = {
        type: NotificationType.ErrorReport,
        message: "ordinary runtime error",
      };
      capturedOnError!(event);
      expect(errors).toContainEqual(["[RuntimeClient Error]", event]);

      // Replacing a live runtime removes the old attention listener before
      // disposing the worker internals.
      task.run([view.app]);
      await task.taskComplete;
      expect(offCalls).toContainEqual([
        "eventneedsattention",
        view._handleEventNeedsAttention,
      ]);
    } finally {
      RuntimeInternals.create = originalCreate;
      console.error = originalError;
      delete (globalThis as { commonfabric?: unknown }).commonfabric;
      restore();
    }
  });

  it("drops the previous space before a differently named view renders", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const { resolveSpaceDid } = await import("@commonfabric/lib-shell");
      const view = new XRootView();
      const identity = await Identity.fromPassphrase(
        "root-view-named-space-transition-test",
      );
      // willUpdate runs before render, which is the point of the test: what
      // it leaves behind is what the app view is handed.
      const lifecycle = view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      };
      const appChanged = new Map<string, unknown>([["app", undefined]]);
      const setView = (next: unknown) => {
        view.app = {
          ...view.app,
          identity,
          view: next as typeof view.app.view,
        };
        lifecycle.willUpdate(appChanged);
      };

      const atlas = await resolveSpaceDid(identity, "atlas");
      const notebook = await resolveSpaceDid(identity, "notebook");
      expect(atlas).not.toBe(notebook);

      // A name is looked up asynchronously, so the view has no space yet.
      setView({ spaceName: "atlas" });
      expect(view.getRuntimeSpaceDID()).toBeUndefined();
      await view.spaceResolved();
      expect(view.getRuntimeSpaceDID()).toBe(atlas);

      // Moving between pieces of one space keeps the space already resolved.
      setView({ spaceName: "atlas", pieceId: "piece-1" });
      expect(view.getRuntimeSpaceDID()).toBe(atlas);

      // Naming a different space drops the old DID in the same step that
      // adopts the new view, so the two are never rendered together.
      setView({ spaceName: "notebook" });
      expect(view.getRuntimeSpaceDID()).toBeUndefined();
      await view.spaceResolved();
      expect(view.getRuntimeSpaceDID()).toBe(notebook);

      // A view addressing its space by DID needs no lookup at all.
      setView({ spaceDid: atlas });
      expect(view.getRuntimeSpaceDID()).toBe(atlas);

      // The home view addresses the identity's own space.
      setView({ builtin: "home" });
      expect(view.getRuntimeSpaceDID()).toBe(identity.did());
    } finally {
      restore();
    }
  });

  it("keeps runtime load errors across a view rebuilt in another key order", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const root = new XRootView();
      const internals = root as unknown as {
        _runtimeLoadErrors: readonly ErrorNotification[];
        willUpdate(changed: Map<string, unknown>): void;
      };
      const error: ErrorNotification = {
        type: NotificationType.ErrorReport,
        message: "the piece failed to load",
      };
      const stateAt = (next: unknown) => ({
        ...root.app,
        view: next as typeof root.app.view,
      });

      // A route parsed from a URL names the space first; a navigation mapped
      // from a space DID back onto the current space name rebuilds the view
      // with the piece first. Both address the same piece, so an error that
      // piece raised is still the error of the piece on screen.
      root.app = stateAt({ pieceId: "piece-1", spaceName: "atlas" });
      internals._runtimeLoadErrors = [error];
      internals.willUpdate(
        new Map([["app", stateAt({ spaceName: "atlas", pieceId: "piece-1" })]]),
      );
      expect(internals._runtimeLoadErrors).toEqual([error]);

      // Another piece is another view, and its errors are not this one's.
      root.app = stateAt({ spaceName: "atlas", pieceId: "piece-2" });
      internals.willUpdate(
        new Map([["app", stateAt({ spaceName: "atlas", pieceId: "piece-1" })]]),
      );
      expect(internals._runtimeLoadErrors).toEqual([]);
    } finally {
      restore();
    }
  });

  it("starts one lookup per name, whatever else changes in the app state", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const { resolveSpaceDid } = await import("@commonfabric/lib-shell");
      const view = new XRootView();
      const first = await Identity.fromPassphrase("root-view-one-lookup-first");
      const second = await Identity.fromPassphrase(
        "root-view-one-lookup-second",
      );
      const lifecycle = view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      };
      const appChanged = new Map<string, unknown>([["app", undefined]]);

      // A named space is keyed off the name and a fixed passphrase, so it is
      // the same space for everyone. Identity has no say in the answer.
      const atlas = await resolveSpaceDid(first, "atlas");
      expect(await resolveSpaceDid(second, "atlas")).toBe(atlas);
      expect(first.did()).not.toBe(second.did());

      view.app = {
        ...view.app,
        identity: first,
        view: { spaceName: "atlas" } as typeof view.app.view,
      };
      lifecycle.willUpdate(appChanged);
      // The promise handed back identifies the lookup now in flight.
      const lookup = view.spaceResolved();

      // An unrelated change while the lookup is still running leaves it be,
      // rather than abandoning it and starting the same lookup over.
      view.app = { ...view.app, config: { showDebuggerView: true } };
      lifecycle.willUpdate(appChanged);
      expect(view.spaceResolved()).toBe(lookup);

      await lookup;
      expect(view.getRuntimeSpaceDID()).toBe(atlas);

      // Switching identity on the same name keeps the space, and asks again
      // for nothing: the answer cannot have changed.
      view.app = { ...view.app, identity: second };
      lifecycle.willUpdate(appChanged);
      expect(view.getRuntimeSpaceDID()).toBe(atlas);
      expect(view.spaceResolved()).toBe(lookup);

      // Logging out drops the space; logging back in looks it up afresh.
      view.app = { ...view.app, identity: undefined };
      lifecycle.willUpdate(appChanged);
      expect(view.getRuntimeSpaceDID()).toBeUndefined();

      view.app = { ...view.app, identity: second };
      lifecycle.willUpdate(appChanged);
      expect(view.spaceResolved()).not.toBe(lookup);
      await view.spaceResolved();
      expect(view.getRuntimeSpaceDID()).toBe(atlas);
    } finally {
      restore();
    }
  });

  it("keeps the view's space when a superseded runtime creation unwinds", async () => {
    const restore = installBrowserGlobals();
    const originalError = console.error;
    console.error = () => {};
    const { RuntimeInternals, resolveSpaceDid } = await import(
      "@commonfabric/lib-shell"
    );
    const originalCreate = RuntimeInternals.create;
    // The abandoned creation disposes the runtime it built. Resolving off that
    // call lands after the whole abandonment block has run.
    let abandoned!: () => void;
    const disposed = new Promise<void>((resolve) => {
      abandoned = resolve;
    });
    RuntimeInternals.create = (() =>
      Promise.resolve({
        runtime: () => ({
          on: () => {},
          off: () => {},
          listEventAttention: () => Promise.resolve([]),
        }),
        dispose: () => {
          abandoned();
          return Promise.resolve();
        },
      } as unknown as Awaited<
        ReturnType<typeof RuntimeInternals.create>
      >)) as typeof RuntimeInternals.create;

    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const identity = await Identity.fromPassphrase(
        "root-view-superseded-runtime-test",
      );
      const atlas = await resolveSpaceDid(identity, "atlas");
      const lifecycle = view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      };

      view.app = {
        ...view.app,
        identity,
        view: { spaceName: "atlas" } as typeof view.app.view,
      };
      lifecycle.willUpdate(new Map([["app", undefined]]));
      await view.spaceResolved();
      expect(view.getRuntimeSpaceDID()).toBe(atlas);

      const task = view.accessForTestingOnly.rt;

      // One runtime creation starts and a second supersedes it, which is what
      // a compiler stack reload does to a creation already under way.
      task.run([view.app]);
      task.run([view.app]);
      await task.taskComplete;
      await disposed;

      // The abandoned creation says nothing about which space the view
      // addresses, so the space it resolved has to survive. Nothing would
      // restore it: the view still names atlas, so no lookup runs again.
      expect(view.getRuntimeSpaceDID()).toBe(atlas);
    } finally {
      RuntimeInternals.create = originalCreate;
      console.error = originalError;
      delete (globalThis as { commonfabric?: unknown }).commonfabric;
      restore();
    }
  });

  it("guards a browser reload only while the runtime reports pending writes", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      // Stub Lit's render step: connectedCallback enables updating, which would
      // otherwise schedule a real render (createComment etc.) this shim has no
      // DOM for. We exercise the listener registration, not Lit rendering.
      (view as unknown as { performUpdate: () => void }).performUpdate =
        () => {};

      // connect/disconnect register and remove the beforeunload listener.
      view.connectedCallback();
      view.disconnectedCallback();

      const handler = view.accessForTestingOnly.onBeforeUnload;
      // A cancelable event records the prompt as `defaultPrevented`.
      const unload = () => {
        const event = new Event("beforeunload", { cancelable: true });
        handler(event as BeforeUnloadEvent);
        return event.defaultPrevented;
      };
      const setRuntime = (runtime: unknown) =>
        (view as unknown as { runtime: unknown }).runtime = runtime;

      // No runtime yet: nothing to lose, so no prompt.
      expect(unload()).toBe(false);

      // A runtime with no unconfirmed writes: no prompt.
      setRuntime({ hasPendingWrites: () => false });
      expect(unload()).toBe(false);

      // Unconfirmed writes in flight: prompt the user before unload.
      setRuntime({ hasPendingWrites: () => true });
      expect(unload()).toBe(true);
    } finally {
      restore();
    }
  });

  it("keeps a complete attention card visible until Retry or Dismiss resolves it", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const resolutions: unknown[] = [];
      (view as unknown as { runtime: unknown }).runtime = {
        resolveEventAttention: (
          notice: EventAttentionNotice,
          action: "retry" | "dismiss",
        ) => {
          resolutions.push({ notice, action });
          return Promise.resolve({
            kind: action === "retry" ? "retried" : "dismissed",
            ...(action === "retry" ? { eventId: "evt-retry" } : {}),
          });
        },
      };
      const notice: EventAttentionNotice = {
        space: "did:key:z6Mk-shell-attention" as never,
        eventId: "evt-original",
        seq: 1,
        sidecarId: "of:stream-events:attention",
        reason: "This event could not be delivered.",
        attention: {
          phase: "dispatch-load",
          failureClass: "session-revoked",
          code: "permanent-delivery-failure",
          firstFailureAt: 10,
          lastFailureAt: 10,
          accumulatedFailureMs: 0,
          failureCount: 1,
          recovery: "explicit-retry",
        },
      };
      (view as unknown as { space: string }).space = notice.space;
      view._handleEventNeedsAttention(notice);

      const markup = templateMarkup(view.render());
      expect(markup).toContain("Events needing attention");
      expect(markup).toContain("Event needs attention");
      expect(markup).toContain(notice.reason);
      expect(markup).toContain("Dismiss");
      expect(markup).toContain("Retry");
      expect(markup).toContain('role="status"');
      expect(markup).toContain('aria-live="polite"');
      const styles = (XRootView.styles as { cssText: string }).cssText;
      expect(styles).toContain("var(--shell-surface");
      expect(styles).toContain("var(--cf-theme-color-surface");
      expect(styles).not.toContain("var(--background, #fff)");
      expect(styles).toContain("max-height: calc(100dvh - 2rem)");
      expect(styles).toContain("overflow-y: auto");
      expect(styles).toMatch(
        /#event-attention\s*\{[^}]*pointer-events:\s*none/s,
      );
      expect(styles).toMatch(
        /\.attention-card\s*\{[^}]*pointer-events:\s*auto/s,
      );

      await view._resolveEventAttention(notice, "retry");
      expect(resolutions).toEqual([{ notice, action: "retry" }]);
      expect(templateMarkup(view.render())).not.toContain(
        "Event needs attention",
      );

      const dismissNotice = { ...notice, eventId: "evt-dismiss" };
      view._handleEventNeedsAttention(dismissNotice);
      await view._resolveEventAttention(dismissNotice, "dismiss");
      expect(resolutions).toEqual([
        { notice, action: "retry" },
        { notice: dismissNotice, action: "dismiss" },
      ]);
      expect(templateMarkup(view.render())).not.toContain(
        "Event needs attention",
      );

      const userlessNotice = {
        ...notice,
        eventId: "evt-userless",
        retryable: false,
      };
      view._handleEventNeedsAttention(userlessNotice);
      const userlessMarkup = templateMarkup(view.render());
      expect(userlessMarkup).toContain("Dismiss");
      expect(userlessMarkup).not.toContain("Retry");
    } finally {
      restore();
    }
  });

  it("keeps equal event IDs from different sidecars independently actionable", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const resolved: EventAttentionNotice[] = [];
      (view as unknown as { runtime: unknown }).runtime = {
        resolveEventAttention: (notice: EventAttentionNotice) => {
          resolved.push(notice);
          return Promise.resolve({ kind: "dismissed" });
        },
      };
      const space = "did:key:z6Mk-shell-shared-event" as never;
      const notice = (
        sidecarId: string,
        reason: string,
      ): EventAttentionNotice => ({
        space,
        eventId: "evt-shared",
        seq: 7,
        sidecarId,
        reason,
        attention: {
          phase: "dispatch-load",
          failureClass: "connection",
          code: "delivery-failure-budget-exhausted",
          firstFailureAt: 10,
          lastFailureAt: 70_000,
          accumulatedFailureMs: 60_000,
          failureCount: 2,
          recovery: "explicit-retry",
        },
      });
      const first = notice("of:stream-events:first", "first stream");
      const second = notice("of:stream-events:second", "second stream");
      (view as unknown as { space: unknown }).space = space;
      view._handleEventNeedsAttention(first);
      view._handleEventNeedsAttention(second);

      expect(templateMarkup(view.render())).toContain("first stream");
      expect(templateMarkup(view.render())).toContain("second stream");
      await view._resolveEventAttention(first, "dismiss");
      expect(resolved).toEqual([first]);
      expect(templateMarkup(view.render())).not.toContain("first stream");
      expect(templateMarkup(view.render())).toContain("second stream");
    } finally {
      restore();
    }
  });

  it("shows attention only for the active space and ignores stale refreshes", async () => {
    const restore = installBrowserGlobals();
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const identity = await Identity.fromPassphrase(
        "root-view-attention-space-test",
      );
      const firstSpace = "did:key:z6Mk-shell-attention-first" as never;
      const secondSpace = "did:key:z6Mk-shell-attention-second" as never;
      const firstRefresh = Promise.withResolvers<
        readonly EventAttentionNotice[]
      >();
      (view as unknown as { runtime: unknown }).runtime = {
        listEventAttention: (space: string) =>
          space === firstSpace
            ? firstRefresh.promise
            : Promise.reject(new Error("second-space refresh failed")),
      };
      const lifecycle = view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      };
      const setSpace = (space: string) => {
        const previous = view.app;
        view.app = {
          ...view.app,
          identity,
          view: { spaceDid: space } as typeof view.app.view,
        };
        lifecycle.willUpdate(
          new Map([[
            "app",
            previous,
          ]]),
        );
      };
      const notice = (
        space: string,
        eventId: string,
        reason: string,
      ): EventAttentionNotice => ({
        space: space as never,
        eventId,
        seq: 1,
        sidecarId: `of:stream-events:${eventId}`,
        reason,
        attention: {
          phase: "dispatch-load",
          failureClass: "connection",
          code: "delivery-failure-budget-exhausted",
          firstFailureAt: 10,
          lastFailureAt: 70_000,
          accumulatedFailureMs: 60_000,
          failureCount: 2,
          recovery: "explicit-retry",
        },
      });
      const firstNotice = notice(firstSpace, "evt-first", "first-space");
      const secondNotice = notice(
        secondSpace,
        "evt-second",
        "second-space",
      );

      setSpace(firstSpace);
      view._handleEventNeedsAttention(firstNotice);
      expect(templateMarkup(view.render())).toContain("first-space");

      setSpace(secondSpace);
      await Promise.resolve();
      view._handleEventNeedsAttention(firstNotice);
      view._handleEventNeedsAttention(secondNotice);
      firstRefresh.resolve([firstNotice]);
      await Promise.resolve();
      await Promise.resolve();

      const markup = templateMarkup(view.render());
      expect(markup).toContain("second-space");
      expect(markup).not.toContain("first-space");
      expect(errors[0]?.[0]).toBe(
        "[RootView] Failed to load event attention:",
      );
    } finally {
      console.error = originalError;
      restore();
    }
  });

  it("preserves a live notice that arrives during its retained-list refresh", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const identity = await Identity.fromPassphrase(
        "root-view-attention-live-refresh-test",
      );
      const space = "did:key:z6Mk-shell-live-refresh" as never;
      const refresh = Promise.withResolvers<readonly EventAttentionNotice[]>();
      (view as unknown as { runtime: unknown }).runtime = {
        listEventAttention: () => refresh.promise,
      };
      const previous = view.app;
      view.app = {
        ...view.app,
        identity,
        view: { spaceDid: space } as typeof view.app.view,
      };
      (view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      }).willUpdate(new Map([["app", previous]]));
      const notice: EventAttentionNotice = {
        space,
        eventId: "evt-live-refresh",
        seq: 8,
        sidecarId: "of:stream-events:live-refresh",
        reason: "live during refresh",
        attention: {
          phase: "dispatch-load",
          failureClass: "connection",
          code: "delivery-failure-budget-exhausted",
          firstFailureAt: 10,
          lastFailureAt: 70_000,
          accumulatedFailureMs: 60_000,
          failureCount: 2,
          recovery: "explicit-retry",
        },
      };
      view._handleEventNeedsAttention(notice);
      refresh.resolve([]);
      await Promise.resolve();
      await Promise.resolve();
      expect(templateMarkup(view.render())).toContain("live during refresh");
    } finally {
      restore();
    }
  });

  it("does not restore a resolved card from an older retained-list result", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const identity = await Identity.fromPassphrase(
        "root-view-attention-resolved-refresh-test",
      );
      const space = "did:key:z6Mk-shell-resolved-refresh" as never;
      const refresh = Promise.withResolvers<readonly EventAttentionNotice[]>();
      (view as unknown as { runtime: unknown }).runtime = {
        listEventAttention: () => refresh.promise,
        resolveEventAttention: () => Promise.resolve({ kind: "dismissed" }),
      };
      const previous = view.app;
      view.app = {
        ...view.app,
        identity,
        view: { spaceDid: space } as typeof view.app.view,
      };
      (view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      }).willUpdate(new Map([["app", previous]]));
      const notice: EventAttentionNotice = {
        space,
        eventId: "evt-resolved-refresh",
        seq: 9,
        sidecarId: "of:stream-events:resolved-refresh",
        reason: "must stay resolved",
        attention: {
          phase: "dispatch-load",
          failureClass: "connection",
          code: "delivery-failure-budget-exhausted",
          firstFailureAt: 10,
          lastFailureAt: 70_000,
          accumulatedFailureMs: 60_000,
          failureCount: 2,
          recovery: "explicit-retry",
        },
      };
      view._handleEventNeedsAttention(notice);
      await view._resolveEventAttention(notice, "dismiss");
      refresh.resolve([notice]);
      await Promise.resolve();
      await Promise.resolve();
      expect(templateMarkup(view.render())).not.toContain("must stay resolved");
    } finally {
      restore();
    }
  });

  it("lets the newest same-space refresh own an A to B to A navigation", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const identity = await Identity.fromPassphrase(
        "root-view-attention-refresh-owner-test",
      );
      const firstSpace = "did:key:z6Mk-shell-refresh-owner-a" as never;
      const secondSpace = "did:key:z6Mk-shell-refresh-owner-b" as never;
      const oldA = Promise.withResolvers<readonly EventAttentionNotice[]>();
      const b = Promise.withResolvers<readonly EventAttentionNotice[]>();
      const newA = Promise.withResolvers<readonly EventAttentionNotice[]>();
      const refreshes = [oldA.promise, b.promise, newA.promise];
      (view as unknown as { runtime: unknown }).runtime = {
        listEventAttention: () => refreshes.shift()!,
      };
      const setSpace = (space: string) => {
        const previous = view.app;
        view.app = {
          ...view.app,
          identity,
          view: { spaceDid: space } as typeof view.app.view,
        };
        (view as unknown as {
          willUpdate(changed: Map<string, unknown>): void;
        }).willUpdate(new Map([["app", previous]]));
      };
      const notice = (reason: string): EventAttentionNotice => ({
        space: firstSpace,
        eventId: `evt-${reason}`,
        seq: 10,
        sidecarId: `of:stream-events:${reason}`,
        reason,
        attention: {
          phase: "dispatch-load",
          failureClass: "connection",
          code: "delivery-failure-budget-exhausted",
          firstFailureAt: 10,
          lastFailureAt: 70_000,
          accumulatedFailureMs: 60_000,
          failureCount: 2,
          recovery: "explicit-retry",
        },
      });

      setSpace(firstSpace);
      setSpace(secondSpace);
      setSpace(firstSpace);
      newA.resolve([notice("new A")]);
      b.resolve([]);
      await Promise.resolve();
      await Promise.resolve();
      oldA.resolve([notice("old A")]);
      await Promise.resolve();
      await Promise.resolve();
      const markup = templateMarkup(view.render());
      expect(markup).toContain("new A");
      expect(markup).not.toContain("old A");
    } finally {
      restore();
    }
  });

  it("coalesces duplicate attention actions and keeps a failed action visible", async () => {
    const restore = installBrowserGlobals();
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const notice: EventAttentionNotice = {
        space: "did:key:z6Mk-shell-attention-failure" as never,
        eventId: "evt-action-failure",
        seq: 1,
        sidecarId: "of:stream-events:action-failure",
        reason: "still needs attention",
        attention: {
          phase: "dispatch-load",
          failureClass: "connection",
          code: "delivery-failure-budget-exhausted",
          firstFailureAt: 10,
          lastFailureAt: 70_000,
          accumulatedFailureMs: 60_000,
          failureCount: 2,
          recovery: "explicit-retry",
        },
      };

      // No runtime is a harmless no-op.
      await view._resolveEventAttention(notice, "retry");

      const deferred = Promise.withResolvers<never>();
      let calls = 0;
      (view as unknown as { runtime: unknown; space: unknown }).runtime = {
        resolveEventAttention: () => {
          calls++;
          return deferred.promise;
        },
      };
      (view as unknown as { space: unknown }).space = notice.space;
      view._handleEventNeedsAttention(notice);

      const first = view._resolveEventAttention(notice, "retry");
      await view._resolveEventAttention(notice, "retry");
      expect(calls).toBe(1);
      deferred.reject(new Error("retry failed"));
      await first;

      expect(templateMarkup(view.render())).toContain("still needs attention");
      expect(errors[0]?.[0]).toBe("[RootView] Failed to retry event:");
    } finally {
      console.error = originalError;
      restore();
    }
  });

  it("keeps an in-flight attention action owned across A to B to A navigation", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const identity = await Identity.fromPassphrase(
        "root-view-attention-navigation-test",
      );
      const firstSpace = "did:key:z6Mk-shell-attention-nav-first" as never;
      const secondSpace = "did:key:z6Mk-shell-attention-nav-second" as never;
      const resolution = Promise.withResolvers<{ kind: "dismissed" }>();
      let calls = 0;
      (view as unknown as { runtime: unknown }).runtime = {
        listEventAttention: () => Promise.resolve([]),
        resolveEventAttention: () => {
          calls++;
          return resolution.promise;
        },
      };
      const lifecycle = view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      };
      const setSpace = (space: string) => {
        const previous = view.app;
        view.app = {
          ...view.app,
          identity,
          view: { spaceDid: space } as typeof view.app.view,
        };
        lifecycle.willUpdate(new Map([["app", previous]]));
      };
      const notice: EventAttentionNotice = {
        space: firstSpace,
        eventId: "evt-navigation",
        seq: 1,
        sidecarId: "of:stream-events:navigation",
        reason: "navigation guard",
        attention: {
          phase: "dispatch-load",
          failureClass: "connection",
          code: "delivery-failure-budget-exhausted",
          firstFailureAt: 10,
          lastFailureAt: 70_000,
          accumulatedFailureMs: 60_000,
          failureCount: 2,
          recovery: "explicit-retry",
        },
      };

      setSpace(firstSpace);
      const first = view._resolveEventAttention(notice, "dismiss");
      setSpace(secondSpace);
      setSpace(firstSpace);
      await view._resolveEventAttention(notice, "dismiss");
      expect(calls).toBe(1);

      resolution.resolve({ kind: "dismissed" });
      await first;
      await view._resolveEventAttention(notice, "dismiss");
      expect(calls).toBe(2);
    } finally {
      restore();
    }
  });
});
