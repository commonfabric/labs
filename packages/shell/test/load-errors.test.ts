// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Task } from "@lit/task";
import type { ReactiveController } from "lit";
import { type DID, Identity } from "@commonfabric/identity";
import { NAVIGATE_EVENT } from "@commonfabric/navigation";
import {
  NotificationType,
  RuntimeErrorCode,
} from "@commonfabric/runtime-client";
import { isObjectOrArray } from "@commonfabric/utils/types";

/** Install the browser globals Lit reads and return a restoration function. */
function installBrowserGlobals(
  overrides: Record<string, unknown> = {},
): () => void {
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
  });
  setGlobal("devicePixelRatio", 1);
  setGlobal("screen", { deviceXDPI: 1, logicalXDPI: 1 });
  setGlobal("navigator", { platform: "", userAgent: "deno" });
  setGlobal("location", {
    protocol: "http:",
    host: "localhost:8000",
    hostname: "localhost",
    href: "http://localhost:8000/did:key:z6Mk-shell-load-error",
  });
  for (const [name, value] of Object.entries(overrides)) {
    setGlobal(name, value);
  }

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

/** Return the rendered text of nested Lit template results. */
function templateText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(templateText).join("");
  if (typeof value !== "object") return String(value);
  const template = value as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  const strings = template.strings ?? [];
  const values = template.values ?? [];
  let text = "";
  for (let index = 0; index < strings.length; index++) {
    text += strings[index];
    if (index < values.length) text += templateText(values[index]);
  }
  return text;
}

/**
 * The value bound right after a template part ending in `marker`, which is how
 * an event handler is reached without a DOM to dispatch into.
 */
function findBinding(value: unknown, marker: string): unknown {
  if (!isObjectOrArray(value)) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBinding(item, marker);
      if (found) return found;
    }
    return undefined;
  }
  const template = value as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  if (!template.strings || !template.values) return undefined;
  const at = template.strings.findIndex((part) => part.endsWith(marker));
  if (at >= 0) return template.values[at];
  for (const item of template.values) {
    const found = findBinding(item, marker);
    if (found) return found;
  }
  return undefined;
}

/**
 * The value bound right after a template part ending in `marker`, falsy or not,
 * or `NOT_BOUND` when no part ends in `marker`.
 */
function boundValue(value: unknown, marker: string): unknown {
  if (!isObjectOrArray(value)) return NOT_BOUND;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = boundValue(item, marker);
      if (found !== NOT_BOUND) return found;
    }
    return NOT_BOUND;
  }
  const template = value as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  if (!template.strings || !template.values) return NOT_BOUND;
  const at = template.strings.findIndex((part) => part.endsWith(marker));
  if (at >= 0) return template.values[at];
  for (const item of template.values) {
    const found = boundValue(item, marker);
    if (found !== NOT_BOUND) return found;
  }
  return NOT_BOUND;
}

/** What {@link boundValue} returns when nothing is bound after the marker. */
const NOT_BOUND = Symbol("not bound");

/** Find the load-error value passed through a nested Lit template. */
function findLoadError(value: unknown): unknown {
  if (!isObjectOrArray(value)) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findLoadError(item);
      if (result) return result;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    (record.kind === "space" || record.kind === "piece") &&
    "error" in record
  ) {
    return value;
  }
  const values = record.values;
  if (!Array.isArray(values)) return undefined;
  for (const item of values) {
    const result = findLoadError(item);
    if (result) return result;
  }
  return undefined;
}

describe("load-errors", () => {
  describe("XRootView", () => {
    describe("instance members", () => {
      describe("render()", () => {
        it("passes a named-space resolution error to the app view", async () => {
          const error = new Error("The named space could not be resolved");
          const restore = installBrowserGlobals({
            crypto: {
              subtle: {
                digest: () => Promise.reject(error),
              },
            },
          });
          const originalError = console.error;
          console.error = () => {};
          try {
            const { XRootView } = await import("../src/views/RootView.ts");
            const view = new XRootView();
            view.app = {
              ...view.app,
              identity: {} as never,
              view: { spaceName: "unavailable-space" },
            };
            const lifecycle = view as unknown as {
              willUpdate(changed: Map<string, unknown>): void;
            };

            lifecycle.willUpdate(new Map([["app", undefined]]));
            await view.spaceResolved();

            expect(findLoadError(view.render())).toEqual({
              kind: "space",
              error,
            });
          } finally {
            console.error = originalError;
            restore();
          }
        });

        it("passes a runtime startup error to the app view", async () => {
          const restore = installBrowserGlobals();
          const originalError = console.error;
          console.error = () => {};
          const { RuntimeInternals } = await import("@commonfabric/lib-shell");
          const originalCreate = RuntimeInternals.create;
          const error = new Error("The runtime could not start");
          RuntimeInternals.create =
            (() => Promise.reject(error)) as typeof RuntimeInternals.create;
          try {
            const { XRootView } = await import("../src/views/RootView.ts");
            const view = new XRootView();
            view.app = {
              ...view.app,
              identity: await Identity.generate({ implementation: "noble" }),
            };
            const task = view.accessForTestingOnly.rt;

            task.run([view.app]);
            await task.taskComplete.catch(() => undefined);

            expect(findLoadError(view.render())).toEqual({
              kind: "space",
              error,
            });
          } finally {
            RuntimeInternals.create = originalCreate;
            console.error = originalError;
            restore();
          }
        });
      });
    });
  });

  describe("XBodyView", () => {
    describe("instance members", () => {
      it("keeps completed sidebar work when pointer keys are unchanged", async () => {
        const restore = installBrowserGlobals();
        try {
          const { XBodyView } = await import("../src/views/BodyView.ts");
          const controllers: ReactiveController[] = [];
          class ObservedBodyView extends XBodyView {
            override addController(controller: ReactiveController): void {
              controllers.push(controller);
              super.addController(controller);
            }
          }
          const view = new ObservedBodyView();
          const task = controllers.find((controller) =>
            controller instanceof Task
          );
          if (!(task instanceof Task)) {
            throw new Error("Sidebar task unavailable.");
          }
          task.hostUpdate();
          await task.taskComplete;
          const first = task.value;

          view.piecePath = [];
          task.hostUpdate();
          await task.taskComplete;
          expect(task.value).toBe(first);

          view.piecePath = ["detail"];
          task.hostUpdate();
          await task.taskComplete;
          const detail = task.value;
          expect(detail).not.toBe(first);

          view.piecePath = ["detail"];
          task.hostUpdate();
          await task.taskComplete;
          expect(task.value).toBe(detail);
        } finally {
          restore();
        }
      });

      describe("render()", () => {
        it("opens the piece menu over the surface a piece failed to load into", async () => {
          const openings: unknown[] = [];
          const panel = {
            isConnected: false,
            style: { setProperty() {}, removeProperty() {} },
            open(opening: unknown) {
              openings.push(opening);
            },
          };
          const restore = installBrowserGlobals({
            getComputedStyle: () => ({ getPropertyValue: () => "" }),
          });
          // The menu mounts itself, so stand in for the document it mounts on.
          const document = globalThis.document as unknown as Record<
            string,
            unknown
          >;
          document.createElement = () => panel;
          document.body = {
            // CodeMirror reads `document.body.style` when its module loads,
            // and this case can be the first in the process to load it.
            style: {},
            appendChild(node: { isConnected: boolean }) {
              node.isConnected = true;
            },
          };
          try {
            const { XBodyView } = await import("../src/views/BodyView.ts");
            const space = "did:key:z6Mk-shell-body-space" as DID;
            const runtime = { name: "runtime-client" };
            const view = new XBodyView();
            view.space = space;
            view.rt = { runtime: () => runtime } as never;
            view.loadError = { kind: "piece", error: new Error("no piece") };

            let prevented = false;
            const handler = findBinding(view.render(), '@contextmenu="') as (
              event: MouseEvent,
            ) => void;
            handler(
              {
                preventDefault: () => {
                  prevented = true;
                },
                clientX: 12,
                clientY: 34,
              } as unknown as MouseEvent,
            );

            expect(prevented).toBe(true);
            expect(openings).toEqual([{
              cell: undefined,
              space,
              runtime,
              x: 12,
              y: 34,
              highlightedPiece: undefined,
              highlightTarget: undefined,
            }]);

            // Shift is how the browser's own menu is reached over piece
            // content, and the error text under this surface is copied
            // through it.
            let shiftPrevented = false;
            handler(
              {
                preventDefault: () => {
                  shiftPrevented = true;
                },
                shiftKey: true,
                clientX: 12,
                clientY: 34,
              } as unknown as MouseEvent,
            );

            expect(shiftPrevented).toBe(false);
            expect(openings).toHaveLength(1);
          } finally {
            panel.isConnected = false;
            restore();
          }
        });
      });
    });
  });

  describe("XAppView", () => {
    describe("instance members", () => {
      describe("render()", () => {
        it("passes a space root load error to the body view", async () => {
          const restore = installBrowserGlobals();
          const originalError = console.error;
          console.error = () => {};
          try {
            const { XAppView } = await import("../src/views/AppView.ts");
            const space = "did:key:z6Mk-shell-space-load-error" as DID;
            const error = new Error("Space storage is unavailable");
            const view = new XAppView();
            view.app = {
              identity: {},
              config: {},
              view: { spaceDid: space },
            } as never;
            view.space = space;
            view.rt = {
              signal: new AbortController().signal,
              getSpaceRootPattern: () => Promise.reject(error),
            } as never;

            view._spaceRootPattern.run();
            await view._spaceRootPattern.taskComplete.catch(() => undefined);

            expect(findLoadError(view.render())).toEqual({
              kind: "space",
              error,
            });
          } finally {
            console.error = originalError;
            restore();
          }
        });

        describe("when the space root lookup returns no root", () => {
          /** An app view on the space home of `space`, over `rt`. */
          const spaceHome = async (space: DID, rt: unknown) => {
            const { XAppView } = await import("../src/views/AppView.ts");
            const view = new XAppView();
            view.app = {
              identity: {},
              config: {},
              view: { spaceDid: space },
            } as never;
            view.space = space;
            view.rt = rt as never;
            return view;
          };

          it("tells the body view the space has no root once the lookup completes, and not while it is pending", async () => {
            const restore = installBrowserGlobals();
            try {
              const lookup = Promise.withResolvers<undefined>();
              const view = await spaceHome(
                "did:key:z6Mk-shell-space-no-root" as DID,
                {
                  signal: new AbortController().signal,
                  getSpaceRootPattern: () => lookup.promise,
                },
              );

              view._spaceRootPattern.run();
              const pending = boundValue(view.render(), '.spaceHasNoRoot="');
              lookup.resolve(undefined);
              await view._spaceRootPattern.taskComplete;

              expect(pending).toBe(false);
              expect(boundValue(view.render(), '.spaceHasNoRoot="')).toBe(true);
              expect(findLoadError(view.render())).toBeUndefined();
            } finally {
              restore();
            }
          });

          it("does not tell the body view the space has no root when there is no runtime to look it up with", async () => {
            const restore = installBrowserGlobals();
            try {
              const view = await spaceHome(
                "did:key:z6Mk-shell-space-no-runtime" as DID,
                undefined,
              );

              view._spaceRootPattern.run();
              await view._spaceRootPattern.taskComplete;

              expect(boundValue(view.render(), '.spaceHasNoRoot="')).toBe(
                false,
              );
            } finally {
              restore();
            }
          });
        });

        it("passes a selected piece load error to the body view", async () => {
          const restore = installBrowserGlobals();
          const originalError = console.error;
          console.error = () => {};
          try {
            const { XAppView } = await import("../src/views/AppView.ts");
            const space = "did:key:z6Mk-shell-piece-load-error" as DID;
            const error = new Error("Piece data could not be read");
            const view = new XAppView();
            view.app = {
              identity: {},
              config: {},
              view: { spaceDid: space, pieceId: "fid1:missing-piece" },
            } as never;
            view.space = space;
            view.rt = {
              signal: new AbortController().signal,
              getPattern: () => Promise.reject(error),
            } as never;

            view._selectedPattern.run();
            await view._selectedPattern.taskComplete.catch(() => undefined);

            expect(findLoadError(view.render())).toEqual({
              kind: "piece",
              error,
            });
          } finally {
            console.error = originalError;
            restore();
          }
        });

        it("passes an earlier space load error to the body view", async () => {
          const restore = installBrowserGlobals();
          try {
            const { XAppView } = await import("../src/views/AppView.ts");
            const error = new Error("The space address could not be resolved");
            const view = new XAppView();
            view.app = {
              identity: {},
              config: {},
              view: { spaceName: "unavailable-space" },
            } as never;
            view.spaceLoadError = { kind: "space", error };

            expect(findLoadError(view.render())).toEqual({
              kind: "space",
              error,
            });
          } finally {
            restore();
          }
        });

        it("passes a runtime error for the selected piece to the body view", async () => {
          const restore = installBrowserGlobals();
          try {
            const { XAppView } = await import("../src/views/AppView.ts");
            const space = "did:key:z6Mk-shell-runtime-piece-error" as DID;
            const view = new XAppView();
            view.app = {
              identity: {},
              config: {},
              view: { spaceDid: space, pieceId: "fid1:broken-piece" },
            } as never;
            view.space = space;
            view.runtimeLoadErrors = [{
              type: NotificationType.ErrorReport,
              message: "The piece failed while it was starting",
              space,
              pieceId: "of:fid1:broken-piece",
            }];

            expect(findLoadError(view.render())).toEqual({
              kind: "piece",
              error: view.runtimeLoadErrors[0],
            });
          } finally {
            restore();
          }
        });

        it("ignores a runtime error from another piece", async () => {
          const restore = installBrowserGlobals();
          try {
            const { XAppView } = await import("../src/views/AppView.ts");
            const space = "did:key:z6Mk-shell-other-piece-error" as DID;
            const view = new XAppView();
            view.app = {
              identity: {},
              config: {},
              view: { spaceDid: space, pieceId: "fid1:working-piece" },
            } as never;
            view.space = space;
            view.runtimeLoadErrors = [{
              type: NotificationType.ErrorReport,
              message: "A background piece failed",
              space,
              pieceId: "of:fid1:background-piece",
            }];

            expect(findLoadError(view.render())).toBeUndefined();
          } finally {
            restore();
          }
        });

        it("keeps a matching error when a background piece fails later", async () => {
          const restore = installBrowserGlobals();
          try {
            const { XAppView } = await import("../src/views/AppView.ts");
            const space = "did:key:z6Mk-shell-preserved-piece-error" as DID;
            const view = new XAppView();
            view.app = {
              identity: {},
              config: {},
              view: { spaceDid: space, pieceId: "fid1:selected-piece" },
            } as never;
            view.space = space;
            const selectedError = {
              type: NotificationType.ErrorReport,
              message: "The selected piece failed",
              space,
              pieceId: "of:fid1:selected-piece",
            } as const;
            view.runtimeLoadErrors = [selectedError, {
              type: NotificationType.ErrorReport,
              message: "A background piece failed later",
              space,
              pieceId: "of:fid1:background-piece",
            }];

            expect(findLoadError(view.render())).toEqual({
              kind: "piece",
              error: selectedError,
            });
          } finally {
            restore();
          }
        });

        it("resolves a slug reference before starting the piece it names", async () => {
          const restore = installBrowserGlobals();
          try {
            const { XAppView } = await import("../src/views/AppView.ts");
            const space = "did:key:z6Mk-shell-slug-target-error" as DID;
            // One log, so the ORDER the name claims is what is checked;
            // two arrays would prove both calls happened and nothing about
            // which came first.
            const calls: Array<{ call: string; args: unknown[] }> = [];
            const view = new XAppView();
            view.app = {
              identity: {},
              config: {},
              view: { spaceDid: space, pieceSlug: "broken-piece" },
            } as never;
            view.space = space;
            view.rt = {
              signal: new AbortController().signal,
              resolveSlug: (...args: unknown[]) => {
                calls.push({ call: "resolveSlug", args });
                return Promise.resolve({
                  pieceId: "fid1:slug-target",
                  pathAfter: [],
                  scope: "space",
                });
              },
              getPattern: (...args: unknown[]) => {
                calls.push({ call: "getPattern", args });
                return Promise.resolve({ id: () => "fid1:slug-target" });
              },
            } as never;

            view._selectedPattern.run();
            await view._selectedPattern.taskComplete;

            expect(calls).toEqual([
              {
                call: "resolveSlug",
                args: [space, "broken-piece", undefined],
              },
              {
                call: "getPattern",
                args: [space, "fid1:slug-target", { scope: "space" }],
              },
            ]);
          } finally {
            restore();
          }
        });

        it("ignores a runtime error without space context", async () => {
          const restore = installBrowserGlobals();
          try {
            const { XAppView } = await import("../src/views/AppView.ts");
            const space = "did:key:z6Mk-shell-context-free-error" as DID;
            const view = new XAppView();
            view.app = {
              identity: {},
              config: {},
              view: { spaceDid: space, pieceId: "fid1:working-piece" },
            } as never;
            view.space = space;
            view.runtimeLoadErrors = [{
              type: NotificationType.ErrorReport,
              message: "An unrelated renderer failed",
            }];

            expect(findLoadError(view.render())).toBeUndefined();
          } finally {
            restore();
          }
        });
      });
    });
  });

  describe("XBodyView", () => {
    describe("instance members", () => {
      describe("render()", () => {
        it("shows a clear space error with the reported detail", async () => {
          const restore = installBrowserGlobals();
          try {
            const { XBodyView } = await import("../src/views/BodyView.ts");
            const view = new XBodyView();
            Object.assign(view, {
              loadError: {
                kind: "space",
                error: new Error("Access to the space was denied"),
              },
            });

            const text = templateText(view.render());
            expect(text).toContain("We could not load this space");
            expect(text).toContain("Try reloading the page");
            expect(text).toContain("Error details");
            expect(text).toContain("Access to the space was denied");
          } finally {
            restore();
          }
        });

        it("shows a clear piece error with a string detail", async () => {
          const restore = installBrowserGlobals();
          try {
            const { XBodyView } = await import("../src/views/BodyView.ts");
            const view = new XBodyView();
            Object.assign(view, {
              loadError: {
                kind: "piece",
                error: "The piece does not exist",
              },
            });

            const text = templateText(view.render());
            expect(text).toContain("We could not load this piece");
            expect(text).toContain("The piece does not exist");
          } finally {
            restore();
          }
        });

        it("shows a runtime error without replacing the main content", async () => {
          const restore = installBrowserGlobals();
          try {
            const { XBodyView } = await import("../src/views/BodyView.ts");
            const view = new XBodyView();
            Object.assign(view, {
              activePattern: {
                id: () => "fid1:partly-working-piece",
                cell: () => ({}),
              },
              runtimeError: {
                kind: "piece",
                error: new Error("A computed value failed"),
              },
            });

            const text = templateText(view.render());
            expect(text).toContain("This piece encountered an error");
            expect(text).toContain("A computed value failed");
            expect(text).toContain("cf-piece");
          } finally {
            restore();
          }
        });

        it("falls back when an error cannot be inspected", async () => {
          const restore = installBrowserGlobals();
          try {
            const { XBodyView } = await import("../src/views/BodyView.ts");
            const view = new XBodyView();
            Object.assign(view, {
              loadError: {
                kind: "space",
                error: new Proxy({}, {
                  getPrototypeOf: () => {
                    throw new Error("The error object cannot be inspected");
                  },
                }),
              },
            });

            expect(templateText(view.render())).toContain(
              "No additional error details were provided.",
            );
          } finally {
            restore();
          }
        });

        describe("when no space answers to the address", () => {
          /** A space load error as the worker reports a space with no history. */
          const spaceNotFound = () => ({
            kind: "space" as const,
            error: Object.assign(new Error("No space at this DID"), {
              code: RuntimeErrorCode.SpaceNotFound,
            }),
          });

          it("says so for the name typed, and offers to create a space under it", async () => {
            const restore = installBrowserGlobals();
            try {
              const { XBodyView } = await import("../src/views/BodyView.ts");
              const view = new XBodyView();
              view.loadError = spaceNotFound();
              view.spaceName = "team-lunch";

              const text = templateText(view.render());
              expect(text).toContain(
                'No space answers to the name "team-lunch"',
              );
              expect(text).toContain('Create a new space called "team-lunch"');
              expect(text).not.toContain("We could not load this space");
            } finally {
              restore();
            }
          });

          it("says so for an address with no name, and offers to create a space", async () => {
            const restore = installBrowserGlobals();
            try {
              const { XBodyView } = await import("../src/views/BodyView.ts");
              const view = new XBodyView();
              view.loadError = spaceNotFound();

              const text = templateText(view.render());
              expect(text).toContain("No space answers to this address");
              expect(text).toContain("Create a new space");
              expect(text).not.toContain("called");
            } finally {
              restore();
            }
          });

          it("creates a space labeled with the name, then navigates to it by DID", async () => {
            const restore = installBrowserGlobals();
            const created = "did:key:z6Mk-shell-created-space" as DID;
            const labels: Array<string | undefined> = [];
            const navigations: unknown[] = [];
            const onNavigate = (event: Event) =>
              navigations.push((event as CustomEvent).detail);
            globalThis.addEventListener(NAVIGATE_EVENT, onNavigate);
            try {
              const { XBodyView } = await import("../src/views/BodyView.ts");
              const view = new XBodyView();
              view.loadError = spaceNotFound();
              view.spaceName = "team-lunch";
              view.rt = {
                createSpace: (label?: string) => {
                  labels.push(label);
                  return Promise.resolve(created);
                },
              } as never;

              const create = findBinding(view.render(), '@click="') as () =>
                Promise<void>;
              await create();

              expect(labels).toEqual(["team-lunch"]);
              expect(navigations).toEqual([{ spaceDid: created }]);
            } finally {
              globalThis.removeEventListener(NAVIGATE_EVENT, onNavigate);
              restore();
            }
          });

          it("creates nothing and navigates nowhere without a runtime", async () => {
            const restore = installBrowserGlobals();
            const navigations: unknown[] = [];
            const onNavigate = (event: Event) =>
              navigations.push((event as CustomEvent).detail);
            globalThis.addEventListener(NAVIGATE_EVENT, onNavigate);
            try {
              const { XBodyView } = await import("../src/views/BodyView.ts");
              const view = new XBodyView();
              view.loadError = spaceNotFound();
              view.spaceName = "team-lunch";

              const create = findBinding(view.render(), '@click="') as () =>
                Promise<void>;
              await create();

              expect(navigations).toEqual([]);
              expect(templateText(view.render())).toContain(
                'Create a new space called "team-lunch"',
              );
            } finally {
              globalThis.removeEventListener(NAVIGATE_EVENT, onNavigate);
              restore();
            }
          });

          it("shows why a space could not be created, and navigates nowhere", async () => {
            const restore = installBrowserGlobals();
            const navigations: unknown[] = [];
            const onNavigate = (event: Event) =>
              navigations.push((event as CustomEvent).detail);
            globalThis.addEventListener(NAVIGATE_EVENT, onNavigate);
            try {
              const { XBodyView } = await import("../src/views/BodyView.ts");
              const view = new XBodyView();
              view.loadError = spaceNotFound();
              view.rt = {
                createSpace: () =>
                  Promise.reject(new Error("The genesis commit was refused")),
              } as never;

              const create = findBinding(view.render(), '@click="') as () =>
                Promise<void>;
              await create();

              expect(templateText(view.render())).toContain(
                "The genesis commit was refused",
              );
              expect(navigations).toEqual([]);
            } finally {
              globalThis.removeEventListener(NAVIGATE_EVENT, onNavigate);
              restore();
            }
          });

          it("shows the ordinary error for a space error of another kind", async () => {
            const restore = installBrowserGlobals();
            try {
              const { XBodyView } = await import("../src/views/BodyView.ts");
              const view = new XBodyView();
              view.loadError = {
                kind: "space",
                error: Object.assign(new Error("The compiler did not load"), {
                  code: RuntimeErrorCode.CompilerStackLoadFailed,
                }),
              };
              view.spaceName = "team-lunch";

              const text = templateText(view.render());
              expect(text).toContain("We could not load this space");
              expect(text).not.toContain("No space answers");
            } finally {
              restore();
            }
          });

          it("shows the ordinary error for a piece that failed with that code", async () => {
            const restore = installBrowserGlobals();
            try {
              const { XBodyView } = await import("../src/views/BodyView.ts");
              const view = new XBodyView();
              view.loadError = { ...spaceNotFound(), kind: "piece" };

              const text = templateText(view.render());
              expect(text).toContain("We could not load this piece");
              expect(text).not.toContain("No space answers");
            } finally {
              restore();
            }
          });
        });

        describe("when the space has no root", () => {
          it("says the space has nothing in it yet", async () => {
            const restore = installBrowserGlobals();
            try {
              const { XBodyView } = await import("../src/views/BodyView.ts");
              const view = new XBodyView();
              const before = templateText(view.render());
              view.spaceHasNoRoot = true;

              const text = templateText(view.render());
              expect(text).toContain("Nothing is in this space yet");
              expect(before).not.toContain("Nothing is in this space yet");
            } finally {
              restore();
            }
          });
        });
      });
    });
  });
});
