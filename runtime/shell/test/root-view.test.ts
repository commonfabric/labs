// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Task } from "@lit/task";
import { Identity } from "@commonfabric/identity";
import {
  type ErrorNotification,
  type EventAttentionNotice,
  NotificationType,
  RuntimeErrorCode,
} from "@commonfabric/runtime-client";
import { templateBindings, templateMarkup } from "./lit-template-markup.ts";

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
  // The document's listeners are real, so that a test can dispatch the events
  // the root view listens for there.
  const documentEvents = new EventTarget();
  setGlobal("document", {
    documentElement: { style: {} },
    visibilityState: "visible",
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(
      documentEvents,
    ),
    dispatchEvent: documentEvents.dispatchEvent.bind(documentEvents),
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

/**
 * Connects `view` with its render step stubbed out. Connecting enables
 * updating, which would otherwise schedule a real render this shim has no
 * DOM for; once the stubbed update has run, a committed state change
 * resolves.
 */
function connectWithoutRendering(
  view: object & { connectedCallback(): void },
) {
  (view as unknown as { performUpdate: () => void }).performUpdate = () => {};
  view.connectedCallback();
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

  it("keeps reload guidance and unconfirmed-write protection after an update refusal", async () => {
    const restore = installBrowserGlobals();
    const originalError = console.error;
    console.error = () => {};
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const generation = view.accessForTestingOnly.runtimeGeneration;
      const event: ErrorNotification = {
        type: NotificationType.ErrorReport,
        code: RuntimeErrorCode.ClientUpdateRequired,
        message: "This runtime must be updated",
        unconfirmedWrites: true,
      };
      view._handleRuntimeError(event, generation - 1);
      expect(templateMarkup(view.render())).not.toContain("Update required");
      view._handleRuntimeError(
        { ...event, unconfirmedWrites: false },
        generation,
      );
      expect(templateMarkup(view.render())).toContain("Update required");
      expect(templateMarkup(view.render())).toContain(
        "If the same message comes back after reloading, this site cannot open that space.",
      );
      expect(templateMarkup(view.render())).not.toContain(
        "Copy any recent edits",
      );
      const cleanUnload = new Event("beforeunload", { cancelable: true });
      view.accessForTestingOnly.onBeforeUnload(
        cleanUnload as BeforeUnloadEvent,
      );
      expect(cleanUnload.defaultPrevented).toBe(false);
      view._handleRuntimeError(event, generation);
      view._handleRuntimeError(
        { ...event, unconfirmedWrites: false },
        generation,
      );
      const markup = templateMarkup(view.render());
      expect(markup).toContain("Update required");
      expect(markup).toContain(event.message);
      expect(markup).toContain("Copy any recent edits");
      const unload = new Event("beforeunload", { cancelable: true });
      view.accessForTestingOnly.onBeforeUnload(unload as BeforeUnloadEvent);
      expect(unload.defaultPrevented).toBe(true);
    } finally {
      console.error = originalError;
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

  it("reports a runtime task's rejection only while that task is in error", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const previous = view.accessForTestingOnly.rt;
      const error = new Error("worker initialization failed");
      const resumed = Promise.withResolvers<typeof previous.value>();
      const task = new Task<
        [typeof view.app | undefined],
        typeof previous.value
      >(view, {
        task: ([app]) =>
          app === undefined ? resumed.promise : Promise.reject(error),
      });
      view.accessForTestingOnly.rt = task;
      await task.run([view.app]);
      expect(view.accessForTestingOnly.runtimeTaskError).toBe(error);

      const pending = task.run([undefined]);
      expect(view.accessForTestingOnly.runtimeTaskError).toBeUndefined();
      resumed.resolve(undefined);
      await pending;
      expect(view.accessForTestingOnly.runtimeTaskError).toBeUndefined();
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

  it("retries the runtime's unreachable spaces on the window's `online` and `focus` while connected, and not after disconnecting", async () => {
    const restore = installBrowserGlobals();
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
    const originalCreate = RuntimeInternals.create;
    let unreachableRetries = 0;
    RuntimeInternals.create = (() =>
      Promise.resolve({
        runtime: () => ({
          on: () => {},
          off: () => {},
          listEventAttention: () => Promise.resolve([]),
          retryUnreachableSpaces: () => {
            unreachableRetries++;
            return Promise.resolve();
          },
        }),
        dispose: () => Promise.resolve(),
      } as unknown as Awaited<
        ReturnType<typeof RuntimeInternals.create>
      >)) as typeof RuntimeInternals.create;

    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      // As above: no DOM for Lit to render into.
      (view as unknown as { performUpdate: () => void }).performUpdate =
        () => {};
      view.app = {
        ...view.app,
        identity: await Identity.fromPassphrase("root-view-online-test"),
      };
      const task = view.accessForTestingOnly.rt;
      task.run([view.app]);
      await task.taskComplete;

      view.connectedCallback();
      globalThis.dispatchEvent(new Event("online"));
      expect(unreachableRetries).toBe(1);
      globalThis.dispatchEvent(new Event("focus"));
      expect(unreachableRetries).toBe(2);

      view.disconnectedCallback();
      globalThis.dispatchEvent(new Event("online"));
      globalThis.dispatchEvent(new Event("focus"));
      expect(unreachableRetries).toBe(2);
    } finally {
      RuntimeInternals.create = originalCreate;
      delete (globalThis as { commonfabric?: unknown }).commonfabric;
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

  describe("application state", () => {
    it("routes each command event to the setter it names", async () => {
      const restore = installBrowserGlobals();
      const originalLog = console.log;
      const commits: string[] = [];
      const identityCommitted = Promise.withResolvers<void>();
      console.log = (message: unknown) => {
        const description = String(message).replace(/^\[app\] \S+ /, "");
        commits.push(description);
        if (description === "set-identity") identityCommitted.resolve();
      };
      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const { SHELL_COMMAND } = await import("../src/views/BaseView.ts");
        const view = new XRootView();
        connectWithoutRendering(view);
        const identity = await Identity.fromPassphrase(
          "root-view-command-routing-test",
        );
        const space = "did:key:z6Mk-shell-command-space";
        const send = (detail: unknown) =>
          view.dispatchEvent(new CustomEvent(SHELL_COMMAND, { detail }));

        send({ type: "set-view", view: { spaceDid: space } });
        expect(view.state().view).toEqual({ spaceDid: space });

        send({ type: "set-config", key: "showSidebar", value: true });
        expect(view.state().config.showSidebar).toBe(true);
        expect(view.state().config.showDebuggerView).toBeUndefined();

        // An identity is resolved before it is committed, so the command
        // lands asynchronously.
        send({ type: "set-identity", identity });
        await identityCommitted.promise;
        expect(view.state().identity?.did()).toBe(identity.did());

        expect(commits).toEqual([
          "set-view",
          "set-config showSidebar=true",
          "set-identity",
        ]);
        expect(view.serialize()).toEqual({
          view: { spaceDid: space },
          config: { showSidebar: true },
          identityDid: identity.did(),
          apiUrl: "http://localhost:8000/",
        });
      } finally {
        console.log = originalLog;
        restore();
      }
    });

    it("throws for a config key the state has no field for", async () => {
      const restore = installBrowserGlobals();
      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const { SHELL_COMMAND } = await import("../src/views/BaseView.ts");
        const view = new XRootView();
        const event = new CustomEvent(SHELL_COMMAND, {
          detail: { type: "set-config", key: "showEverything", value: true },
        });
        expect(() => view.onCommand(event)).toThrow(
          "Invalid config key: showEverything",
        );
        expect(view.state().config).toEqual({});
      } finally {
        restore();
      }
    });

    it("closes the shell's piece list for a view that addresses a piece, and not for a space's default view", async () => {
      const restore = installBrowserGlobals();
      const originalLog = console.log;
      console.log = () => {};
      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const view = new XRootView();
        connectWithoutRendering(view);
        const space = "did:key:z6Mk-shell-piece-list-space" as const;

        await view.setConfig("showShellPieceListView", true);
        await view.setView({ spaceDid: space });
        expect(view.state().config.showShellPieceListView).toBe(true);

        await view.setView({ spaceDid: space, pieceId: "piece-1" });
        expect(view.state().config.showShellPieceListView).toBe(false);
      } finally {
        console.log = originalLog;
        restore();
      }
    });

    it("refuses another identity while one is logged in, and takes it once logged out", async () => {
      const restore = installBrowserGlobals();
      const originalLog = console.log;
      console.log = () => {};
      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const view = new XRootView();
        connectWithoutRendering(view);
        const first = await Identity.fromPassphrase("root-view-first-identity");
        const second = await Identity.fromPassphrase(
          "root-view-second-identity",
        );

        await view.setIdentity(first);
        await expect(view.setIdentity(second)).rejects.toThrow(
          "Cannot change identity while logged in.",
        );
        expect(view.state().identity?.did()).toBe(first.did());

        await view.setIdentity(undefined);
        expect(view.state().identity).toBeUndefined();
        await view.setIdentity(second);
        expect(view.state().identity?.did()).toBe(second.did());
      } finally {
        console.log = originalLog;
        restore();
      }
    });

    it("reports a failed space-name lookup only while the view still names that space", async () => {
      const restore = installBrowserGlobals();
      const originalError = console.error;
      console.error = () => {};
      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const { resolveSpaceDid } = await import("@commonfabric/lib-shell");
        const view = new XRootView();
        const identity = await Identity.fromPassphrase(
          "root-view-stale-lookup-test",
        );
        const lifecycle = view as unknown as {
          willUpdate(changed: Map<string, unknown>): void;
        };
        const setView = (next: unknown) => {
          view.app = {
            ...view.app,
            identity,
            view: next as typeof view.app.view,
          };
          lifecycle.willUpdate(new Map([["app", undefined]]));
        };
        // A space name may not be a DID, so looking one up fails.
        const unresolvable = "did:key:z6Mk-not-a-space-name";
        const spaceError = 'spaceLoadError="{kind:"space"';

        setView({ spaceName: unresolvable });
        await view.spaceResolved();
        expect(templateMarkup(view.render())).toContain(spaceError);

        setView({ spaceName: unresolvable + "-again" });
        const failing = view.spaceResolved();
        setView({ spaceName: "atlas" });
        await failing;
        await view.spaceResolved();
        expect(view.getRuntimeSpaceDID()).toBe(
          await resolveSpaceDid(identity, "atlas"),
        );
        expect(templateMarkup(view.render())).not.toContain(spaceError);
      } finally {
        console.error = originalError;
        restore();
      }
    });
  });

  describe("runtime task", () => {
    it("runs the runtime task for the first state, and again only for a new identity or host", async () => {
      const restore = installBrowserGlobals();
      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const view = new XRootView();
        const runs: unknown[] = [];
        view.accessForTestingOnly.rt = {
          run: (args: unknown) => runs.push(args),
        } as never;
        const lifecycle = view as unknown as {
          updated(changed: Map<string, unknown>): void;
        };
        const identity = await Identity.fromPassphrase(
          "root-view-runtime-recreation-test",
        );
        const initial = view.app;

        lifecycle.updated(new Map([["app", undefined]]));
        expect(runs).toEqual([[initial]]);

        // Another view is view state, which the same runtime serves.
        view.app = { ...initial, view: { builtin: "home" } };
        lifecycle.updated(new Map([["app", initial]]));
        expect(runs).toHaveLength(1);

        // An update that leaves the state alone asks nothing of the runtime.
        lifecycle.updated(new Map([["space", undefined]]));
        expect(runs).toHaveLength(1);

        const before = view.app;
        view.app = { ...before, identity };
        lifecycle.updated(new Map([["app", before]]));
        expect(runs).toEqual([[initial], [view.app]]);

        const sameIdentity = view.app;
        view.app = { ...sameIdentity, apiUrl: new URL("http://other.test/") };
        lifecycle.updated(new Map([["app", sameIdentity]]));
        expect(runs).toEqual([[initial], [sameIdentity], [view.app]]);
      } finally {
        restore();
      }
    });

    it("drops the runtime and its console globals when the identity goes", async () => {
      const restore = installBrowserGlobals();
      const { RuntimeInternals } = await import("@commonfabric/lib-shell");
      const originalCreate = RuntimeInternals.create;
      let disposals = 0;
      const runtime = {
        on: () => {},
        off: () => {},
        listEventAttention: () => Promise.resolve([]),
      };
      RuntimeInternals.create = (() =>
        Promise.resolve({
          runtime: () => runtime,
          dispose: () => {
            disposals++;
            return Promise.resolve();
          },
        } as unknown as Awaited<
          ReturnType<typeof RuntimeInternals.create>
        >)) as typeof RuntimeInternals.create;
      const global = globalThis as { commonfabric?: { rt?: unknown } };

      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const view = new XRootView();
        const identity = await Identity.fromPassphrase(
          "root-view-logout-runtime-test",
        );
        const task = view.accessForTestingOnly.rt;

        task.run([{ ...view.app, identity }]);
        await task.taskComplete;
        expect(task.value).toBeDefined();
        expect(global.commonfabric?.rt).toBe(runtime);

        task.run([{ ...view.app, identity: undefined }]);
        await task.taskComplete;
        expect(task.value).toBeUndefined();
        expect(disposals).toBe(1);
        expect(global.commonfabric?.rt).toBeUndefined();
      } finally {
        RuntimeInternals.create = originalCreate;
        delete global.commonfabric;
        restore();
      }
    });

    it("waits on the rendered app view's pending work in the console's `viewSettled()`", async () => {
      const restore = installBrowserGlobals();
      const { RuntimeInternals } = await import("@commonfabric/lib-shell");
      const originalCreate = RuntimeInternals.create;
      const order: string[] = [];
      RuntimeInternals.create = (() =>
        Promise.resolve({
          runtime: () => ({
            on: () => {},
            off: () => {},
            listEventAttention: () => Promise.resolve([]),
            idle: () => {
              order.push("runtime idle");
              return Promise.resolve();
            },
          }),
          dispose: () => Promise.resolve(),
        } as unknown as Awaited<
          ReturnType<typeof RuntimeInternals.create>
        >)) as typeof RuntimeInternals.create;
      const global = globalThis as {
        commonfabric?: { viewSettled?: () => Promise<void> };
      };

      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const view = new XRootView();
        // The app view's `settling` is read each time it is asked for, so one
        // thenable, logging when it is awaited, stands for the same work.
        const settling = {
          then(resolve: () => void) {
            order.push("app view settled");
            resolve();
          },
        };
        Object.defineProperty(view, "renderRoot", {
          value: {
            querySelector: (selector: string) =>
              selector === "x-app-view" ? { settling } : null,
          },
        });
        const task = view.accessForTestingOnly.rt;
        task.run([{
          ...view.app,
          identity: await Identity.fromPassphrase("root-view-settled-test"),
        }]);
        await task.taskComplete;

        await global.commonfabric!.viewSettled!();
        expect(order).toEqual(["app view settled", "runtime idle"]);
      } finally {
        RuntimeInternals.create = originalCreate;
        delete global.commonfabric;
        restore();
      }
    });
  });

  describe("page events", () => {
    it("follows the theme preference the document announces", async () => {
      const restore = installBrowserGlobals();
      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const view = new XRootView();
        connectWithoutRendering(view);
        expect(templateMarkup(view.render())).not.toContain(
          'colorScheme:"dark"',
        );

        document.dispatchEvent(
          new CustomEvent("theme-preference-changed", { detail: "dark" }),
        );
        expect(templateMarkup(view.render())).toContain('colorScheme:"dark"');

        // A disconnected view hears no more of it.
        view.disconnectedCallback();
        document.dispatchEvent(
          new CustomEvent("theme-preference-changed", { detail: "light" }),
        );
        expect(templateMarkup(view.render())).toContain('colorScheme:"dark"');
      } finally {
        restore();
      }
    });

    it("retries unavailable spaces when the page becomes visible, and not while it is hidden", async () => {
      const restore = installBrowserGlobals();
      const { RuntimeInternals } = await import("@commonfabric/lib-shell");
      const originalCreate = RuntimeInternals.create;
      let unreachableRetries = 0;
      RuntimeInternals.create = (() =>
        Promise.resolve({
          runtime: () => ({
            on: () => {},
            off: () => {},
            listEventAttention: () => Promise.resolve([]),
            retryUnreachableSpaces: () => {
              unreachableRetries++;
              return Promise.resolve();
            },
          }),
          dispose: () => Promise.resolve(),
        } as unknown as Awaited<
          ReturnType<typeof RuntimeInternals.create>
        >)) as typeof RuntimeInternals.create;

      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const view = new XRootView();
        connectWithoutRendering(view);
        const task = view.accessForTestingOnly.rt;
        task.run([{
          ...view.app,
          identity: await Identity.fromPassphrase("root-view-visibility-test"),
        }]);
        await task.taskComplete;
        const page = document as unknown as { visibilityState: string };

        page.visibilityState = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
        expect(unreachableRetries).toBe(0);

        page.visibilityState = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
        expect(unreachableRetries).toBe(1);
        view.disconnectedCallback();
      } finally {
        RuntimeInternals.create = originalCreate;
        delete (globalThis as { commonfabric?: unknown }).commonfabric;
        restore();
      }
    });
  });

  describe("runtime load errors", () => {
    /** The runtime load errors the view hands the app view. */
    function loadErrorsOf(view: object): readonly ErrorNotification[] {
      return (view as unknown as {
        _runtimeLoadErrors: readonly ErrorNotification[];
      })._runtimeLoadErrors;
    }

    it("keeps the latest error of each piece of the space on screen, up to twenty", async () => {
      const restore = installBrowserGlobals();
      const originalError = console.error;
      console.error = () => {};
      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const view = new XRootView();
        const space = "did:key:z6Mk-shell-load-error-space";
        (view as unknown as { space: string }).space = space;
        const error = (
          message: string,
          context: { space?: string; pieceId?: string; patternId?: string },
        ): ErrorNotification => ({
          type: NotificationType.ErrorReport,
          message,
          ...context,
        });

        view._handleRuntimeError(error("other space", { space: "did:key:z" }));
        view._handleRuntimeError(error("no space", {}));
        expect(loadErrorsOf(view)).toEqual([]);

        const first = error("first", { space, pieceId: "p1" });
        const other = error("other piece", { space, pieceId: "p2" });
        const second = error("second", { space, pieceId: "p1" });
        const pattern = error("pattern", {
          space,
          pieceId: "p1",
          patternId: "pat",
        });
        view._handleRuntimeError(first);
        view._handleRuntimeError(other);
        view._handleRuntimeError(second);
        view._handleRuntimeError(pattern);
        expect(loadErrorsOf(view)).toEqual([other, second, pattern]);

        const many = Array.from(
          { length: 25 },
          (_, i) => error(`error ${i}`, { space, pieceId: `piece-${i}` }),
        );
        for (const each of many) view._handleRuntimeError(each);
        expect(loadErrorsOf(view)).toEqual(many.slice(-20));
      } finally {
        console.error = originalError;
        restore();
      }
    });

    it("keeps its errors through the one view change asked to preserve them", async () => {
      const restore = installBrowserGlobals();
      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const view = new XRootView();
        const internals = view as unknown as {
          _runtimeLoadErrors: readonly ErrorNotification[];
          willUpdate(changed: Map<string, unknown>): void;
        };
        const error: ErrorNotification = {
          type: NotificationType.ErrorReport,
          message: "the piece failed to load",
        };
        const moveTo = (pieceId: string) => {
          const previous = view.app;
          view.app = {
            ...previous,
            view: { spaceName: "atlas", pieceId } as typeof view.app.view,
          };
          internals.willUpdate(new Map([["app", previous]]));
        };
        moveTo("piece-1");
        internals._runtimeLoadErrors = [error];

        view.preserveRuntimeErrorsForNextViewChange();
        moveTo("piece-2");
        expect(loadErrorsOf(view)).toEqual([error]);

        moveTo("piece-3");
        expect(loadErrorsOf(view)).toEqual([]);
      } finally {
        restore();
      }
    });
  });

  describe("the history fork", () => {
    const space = "did:key:z6Mk-shell-history-fork";
    const otherSpace = "did:key:z6Mk-shell-history-fork-other";

    /** A fork the stand-in runtime handed out, and what was asked of it. */
    type Fork = {
      seq: number;
      space: string;
      runtime: { runtime(): object };
      discards: number;
      restores: number;
      discard(): Promise<void>;
      restore(): Promise<void>;
    };

    /**
     * A connected root view on `space` with the history panel showing, over
     * a runtime that hands out a fork for each one asked for. `how` settles
     * what a fork's opening, restoring and discarding wait on or fail with.
     * `restore` undoes what mounting replaced.
     */
    async function mounted(
      how: {
        opening?: () => Promise<void>;
        restoring?: () => Promise<void>;
        discarding?: () => Promise<void>;
      } = {},
    ) {
      const restoreGlobals = installBrowserGlobals();
      const errors = stub(console, "error");
      const logs = stub(console, "log");
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      connectWithoutRendering(view);
      const identity = await Identity.fromPassphrase(
        "root-view-history-fork-test",
      );
      const lifecycle = view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      };
      const show = (shown: object) => {
        const previous = view.app;
        view.app = {
          ...previous,
          identity,
          config: { ...previous.config, showHistoryView: true },
          view: shown as typeof view.app.view,
        };
        lifecycle.willUpdate(new Map([["app", previous]]));
      };
      show({ spaceDid: space });
      const forks: Fork[] = [];
      // The runtime task's value is all of the task these cases read, and a
      // fork is all they ask of the runtime.
      const asked: [string, number][] = [];
      const rt = {
        forkSpace: async (of: string, seq: number) => {
          asked.push([of, seq]);
          await how.opening?.();
          const fork: Fork = {
            seq,
            space: of,
            runtime: { runtime: () => ({}) },
            discards: 0,
            restores: 0,
            discard: () => {
              fork.discards++;
              return how.discarding?.() ?? Promise.resolve();
            },
            restore: () => {
              fork.restores++;
              return how.restoring?.() ?? Promise.resolve();
            },
          };
          forks.push(fork);
          return fork;
        },
      };
      view.accessForTestingOnly.rt = { value: rt } as never;
      const navigations: unknown[] = [];
      const navigated = (event: Event) => {
        navigations.push((event as CustomEvent).detail);
      };
      globalThis.addEventListener("cf-navigate", navigated);
      return {
        view,
        rt,
        /** The space and seq of each fork the runtime was asked for. */
        asked,
        forks,
        errors,
        navigations,
        show,
        /**
         * Sends `detail` as a command. A command returns nothing to wait
         * on, so a case reads what it did before its first suspension.
         */
        send: (detail: object) =>
          view.onCommand(new CustomEvent("command", { detail })),
        /** What the history panel is handed as its `open`, where rendered. */
        open: () => templateBindings(view.render(), "open"),
        /** What the history panel is handed as its `error`. */
        error: () => templateBindings(view.render(), "error")[0],
        /** The runtime the app view is handed. */
        shown: () => templateBindings(view.render(), "rt")[0],
        restore: () => {
          globalThis.removeEventListener("cf-navigate", navigated);
          view.disconnectedCallback();
          logs.restore();
          errors.restore();
          restoreGlobals();
        },
      };
    }

    describe("openHistory()", () => {
      it("asks the runtime for a fork of the space at the step, and shows the app view the fork's runtime", async () => {
        const { view, asked, forks, open, rt, shown, restore } =
          await mounted();
        try {
          expect(shown()).toBe(rt);

          await view.openHistory(3);

          expect(asked).toEqual([[space, 3]]);
          expect(open()).toEqual([{ seq: 3, busy: false }]);
          expect(shown()).toBe(forks[0].runtime);
        } finally {
          restore();
        }
      });

      it("starts opening the step an `open-history` command names", async () => {
        const { asked, open, send, restore } = await mounted({
          opening: () => Promise.withResolvers<void>().promise,
        });
        try {
          send({ type: "open-history", seq: 3 });

          expect(asked).toEqual([[space, 3]]);
          expect(open()).toEqual([{ seq: 3, busy: true }]);
        } finally {
          restore();
        }
      });

      it("hands the panel a busy fork until the runtime answers, and asks for no other meanwhile", async () => {
        const opening = Promise.withResolvers<void>();
        const { view, forks, open, restore } = await mounted({
          opening: () => opening.promise,
        });
        try {
          const opened = view.openHistory(3);
          expect(open()).toEqual([{ seq: 3, busy: true }]);

          await view.openHistory(5);
          opening.resolve();
          await opened;

          expect(forks.map((fork) => fork.seq)).toEqual([3]);
          expect(open()).toEqual([{ seq: 3, busy: false }]);
        } finally {
          restore();
        }
      });

      it("asks for no second fork of the step already open", async () => {
        const { view, forks, restore } = await mounted();
        try {
          await view.openHistory(3);
          await view.openHistory(3);

          expect(forks).toHaveLength(1);
          expect(forks[0].discards).toBe(0);
        } finally {
          restore();
        }
      });

      it("replaces the open fork with one of another step, discarding the one replaced", async () => {
        const { view, forks, open, shown, restore } = await mounted();
        try {
          await view.openHistory(3);
          await view.openHistory(5);

          expect(forks.map((fork) => [fork.seq, fork.discards])).toEqual([
            [3, 1],
            [5, 0],
          ]);
          expect(open()).toEqual([{ seq: 5, busy: false }]);
          expect(shown()).toBe(forks[1].runtime);
        } finally {
          restore();
        }
      });

      it("hands the panel the failure and no fork when the runtime rejects, and logs it", async () => {
        const { view, error, errors, open, restore } = await mounted({
          opening: () => Promise.reject(new Error("no such step")),
        });
        try {
          await view.openHistory(3);

          expect(error()).toBe("no such step");
          expect(open()).toEqual([undefined]);
          expect(errors.calls[0].args[0]).toBe(
            "[RootView] Failed to open history:",
          );
        } finally {
          restore();
        }
      });

      it("hands the panel the fork still open, and the failure, when a second fork cannot be opened", async () => {
        let failing = false;
        const { view, error, forks, open, shown, restore } = await mounted({
          opening: () =>
            failing
              ? Promise.reject(new Error("no such step"))
              : Promise.resolve(),
        });
        try {
          await view.openHistory(3);
          failing = true;

          await view.openHistory(5);

          expect(error()).toBe("no such step");
          expect(open()).toEqual([{ seq: 3, busy: false }]);
          expect(shown()).toBe(forks[0].runtime);
          expect(forks[0].discards).toBe(0);

          // The next attempt clears the failure as it starts.
          failing = false;
          await view.openHistory(5);
          expect(error()).toBeUndefined();
        } finally {
          restore();
        }
      });

      describe("when the view moves to another space while the fork is opening", () => {
        it("discards the fork once the runtime hands it over, and shows none", async () => {
          const opening = Promise.withResolvers<void>();
          const { view, forks, open, rt, show, shown, restore } = await mounted(
            { opening: () => opening.promise },
          );
          try {
            const opened = view.openHistory(3);
            show({ spaceDid: otherSpace });

            opening.resolve();
            await opened;

            expect(forks.map((fork) => fork.discards)).toEqual([1]);
            expect(open()).toEqual([undefined]);
            expect(shown()).toBe(rt);
          } finally {
            restore();
          }
        });

        it("hands the panel no failure when the runtime rejects, though it is logged", async () => {
          const opening = Promise.withResolvers<void>();
          const { view, error, errors, show, restore } = await mounted({
            opening: () => opening.promise,
          });
          try {
            const opened = view.openHistory(3);
            show({ spaceDid: otherSpace });

            opening.reject(new Error("no such step"));
            await opened;

            expect(error()).toBeUndefined();
            expect(errors.calls).toHaveLength(1);
          } finally {
            restore();
          }
        });
      });
    });

    describe("closeHistory()", () => {
      it("discards the open fork and shows the app view the space's own runtime again", async () => {
        const { view, forks, navigations, open, rt, send, shown, restore } =
          await mounted();
        try {
          await view.openHistory(3);

          // Closing lets go of the fork before it first suspends.
          send({ type: "close-history" });

          expect(forks[0].discards).toBe(1);
          expect(open()).toEqual([undefined]);
          expect(shown()).toBe(rt);
          // The view did not move while the fork was shown.
          expect(navigations).toEqual([]);
        } finally {
          restore();
        }
      });

      it("navigates back to the view the fork was opened from, where the view moved inside the fork", async () => {
        const { view, navigations, show, restore } = await mounted();
        try {
          await view.openHistory(3);
          show({ spaceDid: space, pieceId: "fid1:reached-in-fork" });

          await view.closeHistory();

          expect(navigations).toEqual([{ spaceDid: space }]);
        } finally {
          restore();
        }
      });

      it("discards nothing with no fork open, or while one is opening", async () => {
        const opening = Promise.withResolvers<void>();
        const { view, forks, open, restore } = await mounted({
          opening: () => opening.promise,
        });
        try {
          await view.closeHistory();
          const opened = view.openHistory(3);

          await view.closeHistory();

          expect(open()).toEqual([{ seq: 3, busy: true }]);
          opening.resolve();
          await opened;
          expect(forks[0].discards).toBe(0);
        } finally {
          restore();
        }
      });

      it("resolves, logging the failure, when the fork cannot be discarded", async () => {
        const { view, errors, open, restore } = await mounted({
          discarding: () => Promise.reject(new Error("the branch is in use")),
        });
        try {
          await view.openHistory(3);

          await view.closeHistory();

          expect(open()).toEqual([undefined]);
          expect(errors.calls).toHaveLength(1);
          expect(errors.calls[0].args[0]).toBe(
            "[RootView] Failed to discard a fork:",
          );
        } finally {
          restore();
        }
      });
    });

    describe("restoreHistory()", () => {
      it("restores the space from the open fork, then shows the space's own runtime with no fork, discarding nothing", async () => {
        const { view, forks, navigations, open, rt, shown, restore } =
          await mounted();
        try {
          await view.openHistory(3);

          await view.restoreHistory();

          expect([forks[0].restores, forks[0].discards]).toEqual([1, 0]);
          expect(open()).toEqual([undefined]);
          expect(shown()).toBe(rt);
          expect(navigations).toEqual([]);
        } finally {
          restore();
        }
      });

      it("starts restoring from the open fork on a `restore-history` command", async () => {
        const { view, forks, open, send, restore } = await mounted({
          restoring: () => Promise.withResolvers<void>().promise,
        });
        try {
          await view.openHistory(3);

          send({ type: "restore-history" });

          expect(forks[0].restores).toBe(1);
          expect(open()).toEqual([{ seq: 3, busy: true }]);
        } finally {
          restore();
        }
      });

      it("hands the panel a busy fork until the restore ends, and starts no second restore or close meanwhile", async () => {
        const restoring = Promise.withResolvers<void>();
        const { view, forks, open, restore } = await mounted({
          restoring: () => restoring.promise,
        });
        try {
          await view.openHistory(3);
          const restored = view.restoreHistory();
          expect(open()).toEqual([{ seq: 3, busy: true }]);

          await view.restoreHistory();
          await view.closeHistory();

          expect([forks[0].restores, forks[0].discards]).toEqual([1, 0]);
          restoring.resolve();
          await restored;
          expect(open()).toEqual([undefined]);
        } finally {
          restore();
        }
      });

      it("restores nothing with no fork open", async () => {
        const { view, forks, open, restore } = await mounted();
        try {
          await view.restoreHistory();

          expect(forks).toEqual([]);
          expect(open()).toEqual([undefined]);
        } finally {
          restore();
        }
      });

      it("navigates to the space where the view moved inside the fork, keeping an embedded view embedded", async () => {
        const { view, navigations, show, restore } = await mounted();
        try {
          await view.openHistory(3);
          show({ spaceDid: space, pieceId: "fid1:reached-in-fork" });
          await view.restoreHistory();

          await view.openHistory(4);
          show({
            spaceDid: space,
            pieceId: "fid1:reached-in-fork",
            mode: "embed",
          });
          await view.restoreHistory();

          expect(navigations).toEqual([
            { spaceDid: space },
            { spaceDid: space, mode: "embed" },
          ]);
        } finally {
          restore();
        }
      });

      it("hands the panel the failure and keeps the fork open when the restore rejects, and logs it", async () => {
        const { view, error, errors, forks, open, shown, restore } =
          await mounted({
            restoring: () => Promise.reject(new Error("the space moved on")),
          });
        try {
          await view.openHistory(3);

          await view.restoreHistory();

          expect(error()).toBe("the space moved on");
          expect(open()).toEqual([{ seq: 3, busy: false }]);
          expect(shown()).toBe(forks[0].runtime);
          expect(forks[0].discards).toBe(0);
          expect(errors.calls[0].args[0]).toBe(
            "[RootView] Failed to restore from history:",
          );

          // The fork is still there to return from.
          await view.closeHistory();
          expect(forks[0].discards).toBe(1);
          expect(error()).toBeUndefined();
        } finally {
          restore();
        }
      });

      describe("when the view moves to another space while the fork is restoring", () => {
        it("leaves the fork for the restore to end, discarding nothing, and shows none", async () => {
          const restoring = Promise.withResolvers<void>();
          const { view, forks, navigations, open, show, restore } =
            await mounted({ restoring: () => restoring.promise });
          try {
            await view.openHistory(3);
            const restored = view.restoreHistory();
            show({ spaceDid: otherSpace });
            expect(open()).toEqual([undefined]);

            restoring.resolve();
            await restored;

            expect(forks[0].discards).toBe(0);
            expect(open()).toEqual([undefined]);
            expect(navigations).toEqual([]);
          } finally {
            restore();
          }
        });

        it("discards the fork when the restore then rejects, and hands the panel no failure", async () => {
          const restoring = Promise.withResolvers<void>();
          const { view, error, forks, open, show, restore } = await mounted({
            restoring: () => restoring.promise,
          });
          try {
            await view.openHistory(3);
            const restored = view.restoreHistory();
            show({ spaceDid: otherSpace });

            restoring.reject(new Error("the space moved on"));
            await restored;

            expect(forks[0].discards).toBe(1);
            expect(error()).toBeUndefined();
            expect(open()).toEqual([undefined]);
          } finally {
            restore();
          }
        });
      });
    });

    describe("hiding the history panel", () => {
      it("discards the open fork and shows the space's own runtime", async () => {
        const { view, forks, navigations, rt, send, shown, restore } =
          await mounted();
        try {
          await view.openHistory(3);

          // Hiding the panel lets go of the fork before it first suspends.
          send({
            type: "set-config",
            key: "showHistoryView",
            value: false,
          });

          expect(forks[0].discards).toBe(1);
          expect(shown()).toBe(rt);
          expect(view.state().config.showHistoryView).toBe(false);
          expect(navigations).toEqual([]);
        } finally {
          restore();
        }
      });

      it("navigates back to the view the fork was opened from, where the view moved inside the fork", async () => {
        const { view, navigations, show, restore } = await mounted();
        try {
          await view.openHistory(3);
          show({ spaceDid: space, pieceId: "fid1:reached-in-fork" });

          await view.setConfig("showHistoryView", false);

          expect(navigations).toEqual([{ spaceDid: space }]);
        } finally {
          restore();
        }
      });

      it("discards nothing when the panel is shown, or another panel is hidden", async () => {
        const { view, forks, open, restore } = await mounted();
        try {
          await view.openHistory(3);

          await view.setConfig("showHistoryView", true);
          await view.setConfig("showDebuggerView", false);

          expect(forks[0].discards).toBe(0);
          expect(open()).toEqual([{ seq: 3, busy: false }]);
        } finally {
          restore();
        }
      });
    });
  });

  describe("the history panel's piece", () => {
    const space = "did:key:z6Mk-shell-history-piece";

    /**
     * Returns what a root view showing `shown` in `space`, with the history
     * panel open, hands the panel as its property `name`: one entry, the
     * panel being rendered once.
     */
    async function bound(shown: object, name: string): Promise<unknown[]> {
      const restore = installBrowserGlobals();
      try {
        const { XRootView } = await import("../src/views/RootView.ts");
        const view = new XRootView();
        view.app = {
          ...view.app,
          identity: await Identity.fromPassphrase("root-view-history-piece"),
          config: { ...view.app.config, showHistoryView: true },
          view: { spaceDid: space, ...shown } as typeof view.app.view,
        };
        return templateBindings(view.render(), name);
      } finally {
        restore();
      }
    }

    describe("pieceId", () => {
      it("is the piece a view names by id", async () => {
        expect(await bound({ pieceId: "fid1:viewed" }, "pieceId")).toEqual([
          "fid1:viewed",
        ]);
      });

      it("is none for a view that names its piece by slug, though it carries an id as well", async () => {
        expect(
          await bound(
            { pieceSlug: "lunch", pieceId: "fid1:viewed" },
            "pieceId",
          ),
        ).toEqual([undefined]);
        expect(await bound({ pieceSlug: "lunch" }, "pieceId")).toEqual([
          undefined,
        ]);
      });

      it("is none for a view of a space with no piece, or with an empty piece id", async () => {
        expect(await bound({}, "pieceId")).toEqual([undefined]);
        expect(await bound({ pieceId: "" }, "pieceId")).toEqual([undefined]);
      });
    });

    describe("pieceScope", () => {
      it("is the scope of a view that names its piece by id", async () => {
        expect(
          await bound(
            { pieceId: "fid1:viewed", pieceScope: "user" },
            "pieceScope",
          ),
        ).toEqual(["user"]);
      });

      it("is none for a view that names its piece by id with no scope", async () => {
        expect(await bound({ pieceId: "fid1:viewed" }, "pieceScope")).toEqual([
          undefined,
        ]);
      });

      it("is none for a view that names no piece by id, though it carries a scope", async () => {
        expect(
          await bound(
            { pieceSlug: "lunch", pieceId: "fid1:viewed", pieceScope: "user" },
            "pieceScope",
          ),
        ).toEqual([undefined]);
        expect(await bound({ pieceScope: "user" }, "pieceScope")).toEqual([
          undefined,
        ]);
      });
    });
  });

  describe("restorePattern()", () => {
    const space = "did:key:z6Mk-shell-restore-pattern";
    const otherSpace = "did:key:z6Mk-shell-restore-pattern-other";

    type RestoreAnswer = {
      compatibilityWarning?: string;
      confirmationToken?: string;
      executionWarning?: string;
    };

    /**
     * A root view on `space` with the history panel showing, over a runtime
     * that answers each pattern restore with what `answer` returns, and
     * records what it was asked. `restore` undoes what mounting replaced.
     */
    async function mounted(answer: () => Promise<RestoreAnswer>) {
      const restoreGlobals = installBrowserGlobals();
      const errors = stub(console, "error");
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const identity = await Identity.fromPassphrase(
        "root-view-restore-pattern-test",
      );
      const lifecycle = view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      };
      const showSpace = (did: string) => {
        const previous = view.app;
        view.app = {
          ...previous,
          identity,
          config: { ...previous.config, showHistoryView: true },
          view: { spaceDid: did } as typeof view.app.view,
        };
        lifecycle.willUpdate(new Map([["app", previous]]));
      };
      showSpace(space);
      const asked: unknown[][] = [];
      const forks: number[] = [];
      // The runtime task's value is all of the task these cases read, and a
      // pattern restore and a fork are all they ask of the runtime.
      view.accessForTestingOnly.rt = {
        value: {
          restorePiecePattern: (...args: unknown[]) => {
            asked.push(args);
            return answer();
          },
          forkSpace: (_space: string, seq: number) => {
            forks.push(seq);
            return Promise.resolve({
              seq,
              runtime: { runtime: () => ({}) },
              discard: () => Promise.resolve(),
            });
          },
        },
      } as never;
      return {
        view,
        asked,
        /** The seq of each fork the runtime was asked for. */
        forks,
        /** What the history panel is handed as its `open`. */
        openHistory: () => templateBindings(view.render(), "open")[0],
        errors,
        showSpace,
        /** What the history panel is handed as its `patternRestore`. */
        patternRestore: () =>
          templateBindings(view.render(), "patternRestore")[0],
        /** What the history panel is handed as its `changes`. */
        changes: () => templateBindings(view.render(), "changes")[0],
        restore: () => {
          errors.restore();
          restoreGlobals();
        },
      };
    }

    it("asks the runtime to restore the revision, then hands the panel no restore and one more change", async () => {
      const { view, asked, changes, patternRestore, restore } = await mounted(
        () => Promise.resolve({}),
      );
      try {
        expect(changes()).toBe(0);
        const change = { pieceId: "fid1:a", revisionId: "r1" };

        await view.restorePattern(change);

        expect(asked).toEqual([[space, change, undefined]]);
        expect(patternRestore()).toBeUndefined();
        expect(changes()).toBe(1);
      } finally {
        restore();
      }
    });

    it("hands the panel a busy restore of that revision until the runtime answers", async () => {
      const answer = Promise.withResolvers<RestoreAnswer>();
      const { view, changes, patternRestore, restore } = await mounted(
        () => answer.promise,
      );
      try {
        const restoring = view.restorePattern({
          pieceId: "fid1:a",
          revisionId: "r1",
        });

        expect(patternRestore()).toEqual({
          pieceId: "fid1:a",
          revisionId: "r1",
          busy: true,
        });
        expect(changes()).toBe(0);

        answer.resolve({});
        await restoring;
        expect(patternRestore()).toBeUndefined();
      } finally {
        restore();
      }
    });

    it("hands the panel the runtime's compatibility warning with its token and the scope, and counts no change", async () => {
      const { view, changes, patternRestore, restore } = await mounted(
        () =>
          Promise.resolve({
            compatibilityWarning: "The source does not fit the data.",
            confirmationToken: "token-1",
          }),
      );
      try {
        await view.restorePattern({
          pieceId: "fid1:a",
          revisionId: "r1",
          scope: "user",
        });

        expect(patternRestore()).toStrictEqual({
          pieceId: "fid1:a",
          revisionId: "r1",
          busy: false,
          scope: "user",
          warning: "The source does not fit the data.",
          confirmationToken: "token-1",
        });
        expect(changes()).toBe(0);
      } finally {
        restore();
      }
    });

    it("hands the panel a warning with no token or scope member where the runtime and the change gave none", async () => {
      const { view, patternRestore, restore } = await mounted(
        () => Promise.resolve({ compatibilityWarning: "It does not fit." }),
      );
      try {
        await view.restorePattern({ pieceId: "fid1:a", revisionId: "r1" });

        // `toStrictEqual` tells an absent member from one holding
        // `undefined`.
        expect(patternRestore()).toStrictEqual({
          pieceId: "fid1:a",
          revisionId: "r1",
          busy: false,
          warning: "It does not fit.",
        });
      } finally {
        restore();
      }
    });

    it("sends a second request carrying the token after a warning, and counts the change once that one lands", async () => {
      const confirmedAnswer = Promise.withResolvers<RestoreAnswer>();
      const answers: Promise<RestoreAnswer>[] = [
        Promise.resolve({
          compatibilityWarning: "It does not fit.",
          confirmationToken: "t1",
        }),
        confirmedAnswer.promise,
      ];
      const { view, asked, changes, patternRestore, restore } = await mounted(
        () => answers.shift()!,
      );
      try {
        const change = { pieceId: "fid1:a", revisionId: "r1" };
        await view.restorePattern(change);
        const confirmed = { ...change, confirmationToken: "t1" };

        // The panel's "Restore it anyway" arrives as a command, which
        // returns nothing to wait on.
        view.onCommand(
          new CustomEvent("command", {
            detail: { type: "restore-pattern", ...confirmed },
          }),
        );

        expect(asked).toEqual([
          [space, change, undefined],
          [space, { type: "restore-pattern", ...confirmed }, "t1"],
        ]);
        expect(patternRestore()).toEqual({ ...change, busy: true });

        confirmedAnswer.resolve({});
        // The restore was waiting on this promise before this case was, so
        // it has been resumed by the time this case is.
        await confirmedAnswer.promise;
        expect(patternRestore()).toBeUndefined();
        expect(changes()).toBe(1);
      } finally {
        restore();
      }
    });

    it("hands the panel the failure's message when the runtime rejects, logs it, and counts no change", async () => {
      const { view, changes, errors, patternRestore, restore } = await mounted(
        () => Promise.reject(new Error("the piece is gone")),
      );
      try {
        await view.restorePattern({ pieceId: "fid1:a", revisionId: "r1" });

        expect(patternRestore()).toEqual({
          pieceId: "fid1:a",
          revisionId: "r1",
          busy: false,
          error: "the piece is gone",
        });
        expect(changes()).toBe(0);
        expect(errors.calls).toHaveLength(1);
        expect(errors.calls[0].args[0]).toBe(
          "[RootView] Failed to restore a pattern:",
        );
      } finally {
        restore();
      }
    });

    it("hands the panel the runtime's execution warning as the restore's failure, and counts the change all the same", async () => {
      const { view, changes, errors, patternRestore, restore } = await mounted(
        () =>
          Promise.resolve({
            executionWarning: "The restored pattern threw as it started.",
          }),
      );
      try {
        await view.restorePattern({
          pieceId: "fid1:a",
          revisionId: "r1",
          scope: "user",
        });

        expect(patternRestore()).toStrictEqual({
          pieceId: "fid1:a",
          revisionId: "r1",
          busy: false,
          scope: "user",
          error: "The restored pattern threw as it started.",
        });
        expect(changes()).toBe(1);
        // The restore landed, so nothing is logged as a failure of it.
        expect(errors.calls).toHaveLength(0);

        // A restore that is not busy leaves the way open for another.
        await view.restorePattern({ pieceId: "fid1:a", revisionId: "r0" });
        expect(changes()).toBe(2);
      } finally {
        restore();
      }
    });

    it("hands the panel the change's scope with a busy restore and with a failed one", async () => {
      const answer = Promise.withResolvers<RestoreAnswer>();
      const { view, patternRestore, restore } = await mounted(
        () => answer.promise,
      );
      try {
        const restoring = view.restorePattern({
          pieceId: "fid1:a",
          revisionId: "r1",
          scope: "session",
        });
        expect(patternRestore()).toStrictEqual({
          pieceId: "fid1:a",
          revisionId: "r1",
          scope: "session",
          busy: true,
        });

        answer.reject(new Error("the piece is gone"));
        await restoring;

        expect(patternRestore()).toStrictEqual({
          pieceId: "fid1:a",
          revisionId: "r1",
          scope: "session",
          busy: false,
          error: "the piece is gone",
        });
      } finally {
        restore();
      }
    });

    it("hands the panel a busy restore and a failed one with no scope member where the change has none", async () => {
      const answer = Promise.withResolvers<RestoreAnswer>();
      const { view, patternRestore, restore } = await mounted(
        () => answer.promise,
      );
      try {
        const restoring = view.restorePattern({
          pieceId: "fid1:a",
          revisionId: "r1",
        });
        // `toStrictEqual` tells an absent member from one holding
        // `undefined`.
        expect(patternRestore()).toStrictEqual({
          pieceId: "fid1:a",
          revisionId: "r1",
          busy: true,
        });

        answer.reject(new Error("the piece is gone"));
        await restoring;

        expect(patternRestore()).toStrictEqual({
          pieceId: "fid1:a",
          revisionId: "r1",
          busy: false,
          error: "the piece is gone",
        });
      } finally {
        restore();
      }
    });

    it("sends a new request after a failure", async () => {
      let failing = true;
      const { view, asked, changes, patternRestore, restore } = await mounted(
        () =>
          failing ? Promise.reject(new Error("offline")) : Promise.resolve({}),
      );
      try {
        const change = { pieceId: "fid1:a", revisionId: "r1" };
        await view.restorePattern(change);
        failing = false;

        await view.restorePattern(change);

        expect(asked).toHaveLength(2);
        expect(patternRestore()).toBeUndefined();
        expect(changes()).toBe(1);
      } finally {
        restore();
      }
    });

    it("sends nothing for a restore asked for while another is busy, and leaves the busy one in place", async () => {
      const answer = Promise.withResolvers<RestoreAnswer>();
      const { view, asked, patternRestore, restore } = await mounted(
        () => answer.promise,
      );
      try {
        const first = view.restorePattern({
          pieceId: "fid1:a",
          revisionId: "r1",
        });

        await view.restorePattern({ pieceId: "fid1:b", revisionId: "r2" });

        expect(asked).toHaveLength(1);
        expect(patternRestore()).toEqual({
          pieceId: "fid1:a",
          revisionId: "r1",
          busy: true,
        });
        answer.resolve({});
        await first;
      } finally {
        restore();
      }
    });

    it("sends nothing while a fork is open, and sends again once it is closed", async () => {
      const { view, asked, patternRestore, restore } = await mounted(
        () => Promise.resolve({}),
      );
      try {
        const change = { pieceId: "fid1:a", revisionId: "r1" };
        await view.openHistory(3);

        await view.restorePattern(change);

        expect(asked).toEqual([]);
        expect(patternRestore()).toBeUndefined();

        await view.closeHistory();
        await view.restorePattern(change);
        expect(asked).toHaveLength(1);
      } finally {
        restore();
      }
    });

    it("sends nothing with no runtime, or with no space resolved", async () => {
      const { view, asked, showSpace, restore } = await mounted(
        () => Promise.resolve({}),
      );
      try {
        const change = { pieceId: "fid1:a", revisionId: "r1" };
        const task = view.accessForTestingOnly.rt;
        view.accessForTestingOnly.rt = { value: undefined } as never;
        await view.restorePattern(change);

        view.accessForTestingOnly.rt = task;
        const previous = view.app;
        view.app = { ...previous, view: { builtin: "settings" } as never };
        (view as unknown as {
          willUpdate(changed: Map<string, unknown>): void;
        }).willUpdate(new Map([["app", previous]]));
        expect(view.getRuntimeSpaceDID()).toBeUndefined();
        await view.restorePattern(change);

        expect(asked).toEqual([]);

        // The same view sends once it is on a space again.
        showSpace(space);
        await view.restorePattern(change);
        expect(asked).toHaveLength(1);
      } finally {
        restore();
      }
    });

    describe("openHistory() beside it", () => {
      it("asks for no fork while a restore is busy, and for one once the runtime has answered", async () => {
        const answer = Promise.withResolvers<RestoreAnswer>();
        const { view, forks, openHistory, patternRestore, restore } =
          await mounted(() => answer.promise);
        try {
          const restoring = view.restorePattern({
            pieceId: "fid1:a",
            revisionId: "r1",
          });

          await view.openHistory(3);

          expect(forks).toEqual([]);
          expect(openHistory()).toBeUndefined();
          expect(patternRestore()).toEqual({
            pieceId: "fid1:a",
            revisionId: "r1",
            busy: true,
          });

          answer.resolve({});
          await restoring;
          await view.openHistory(3);
          expect(forks).toEqual([3]);
          expect(openHistory()).toEqual({ seq: 3, busy: false });
        } finally {
          restore();
        }
      });

      it("hands the panel no restore once a fork starts opening over a compatibility warning", async () => {
        const { view, forks, patternRestore, restore } = await mounted(
          () =>
            Promise.resolve({
              compatibilityWarning: "It does not fit.",
              confirmationToken: "t1",
            }),
        );
        try {
          await view.restorePattern({ pieceId: "fid1:a", revisionId: "r1" });
          expect(patternRestore()).toBeDefined();

          const opening = view.openHistory(3);

          // The warning is gone as the fork starts opening, before the
          // runtime has answered with it.
          expect(patternRestore()).toBeUndefined();
          await opening;
          expect(forks).toEqual([3]);
          expect(patternRestore()).toBeUndefined();
        } finally {
          restore();
        }
      });

      it("hands the panel no restore once a fork starts opening over a failed restore", async () => {
        const { view, patternRestore, restore } = await mounted(
          () => Promise.reject(new Error("the piece is gone")),
        );
        try {
          await view.restorePattern({ pieceId: "fid1:a", revisionId: "r1" });
          expect(patternRestore()).toBeDefined();

          await view.openHistory(3);

          expect(patternRestore()).toBeUndefined();
        } finally {
          restore();
        }
      });

      it("leaves a warning in place for a step that opens no fork", async () => {
        const { view, forks, patternRestore, restore } = await mounted(
          () => Promise.resolve({ compatibilityWarning: "It does not fit." }),
        );
        try {
          await view.restorePattern({ pieceId: "fid1:a", revisionId: "r1" });

          await view.openHistory(1.5);

          expect(forks).toEqual([]);
          expect(patternRestore()).toEqual({
            pieceId: "fid1:a",
            revisionId: "r1",
            busy: false,
            warning: "It does not fit.",
          });
        } finally {
          restore();
        }
      });
    });

    describe("when the view moves to another space before the runtime answers", () => {
      it("drops a success: the panel is handed no restore, and no change is counted", async () => {
        const answer = Promise.withResolvers<RestoreAnswer>();
        const { view, changes, patternRestore, showSpace, restore } =
          await mounted(() => answer.promise);
        try {
          const restoring = view.restorePattern({
            pieceId: "fid1:a",
            revisionId: "r1",
          });
          showSpace(otherSpace);
          expect(patternRestore()).toBeUndefined();

          answer.resolve({ compatibilityWarning: "It does not fit." });
          await restoring;

          expect(patternRestore()).toBeUndefined();
          expect(changes()).toBe(0);
        } finally {
          restore();
        }
      });

      it("drops a failure: the panel is handed no restore, though the failure is logged", async () => {
        const answer = Promise.withResolvers<RestoreAnswer>();
        const { view, errors, patternRestore, showSpace, restore } =
          await mounted(() => answer.promise);
        try {
          const restoring = view.restorePattern({
            pieceId: "fid1:a",
            revisionId: "r1",
          });
          showSpace(otherSpace);

          answer.reject(new Error("the piece is gone"));
          await restoring;

          expect(patternRestore()).toBeUndefined();
          expect(errors.calls).toHaveLength(1);
        } finally {
          restore();
        }
      });
    });
  });

  it("shows what a refresh begun after a dismissal lists, though the dismissal was of the same event", async () => {
    // A dismissal made while another space was on screen is older than the
    // refresh that runs on returning, so the refresh's list is the newer word.

    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const identity = await Identity.fromPassphrase(
        "root-view-attention-older-dismissal-test",
      );
      const firstSpace = "did:key:z6Mk-shell-older-dismissal-a" as never;
      const secondSpace = "did:key:z6Mk-shell-older-dismissal-b" as never;
      const notice: EventAttentionNotice = {
        space: firstSpace,
        eventId: "evt-older-dismissal",
        seq: 3,
        sidecarId: "of:stream-events:older-dismissal",
        reason: "listed again after dismissal",
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
      const refreshOfFirst = Promise.withResolvers<
        readonly EventAttentionNotice[]
      >();
      (view as unknown as { runtime: unknown }).runtime = {
        listEventAttention: (space: string) =>
          space === firstSpace ? refreshOfFirst.promise : Promise.resolve([]),
        resolveEventAttention: () => Promise.resolve({ kind: "dismissed" }),
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

      setSpace(secondSpace);
      await view._resolveEventAttention(notice, "dismiss");
      setSpace(firstSpace);
      refreshOfFirst.resolve([notice]);
      await Promise.resolve();
      await Promise.resolve();
      expect(templateMarkup(view.render())).toContain(
        "listed again after dismissal",
      );
    } finally {
      restore();
    }
  });
});
