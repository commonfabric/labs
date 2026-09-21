/**
 * Tests for the main-thread DOM applicator.
 *
 * Note: Some tests are still omitted because the mock document here only
 * covers the DOM surface the applicator needs in unit tests.
 */

// `assertExists` stays where `expect()` has no equal: it asserts neither
// `null` nor `undefined` in one call, and narrows the value's type for the
// lines that follow. `toBeDefined()` does neither.
import { describe, it } from "@std/testing/bdd";
import { assertExists } from "@std/assert";
import { expect } from "@std/expect";

import { $conn, type CellRef } from "@commonfabric/runtime-client";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { DomApplicator } from "../src/main/applicator.ts";
import type { DomEventMessage } from "../src/main/events.ts";
import { getPieceBoundary } from "../src/main/space-context.ts";
import type { VDomBatch } from "../src/vdom-ops.ts";

// Mock RuntimeClient for testing
const createMockRuntimeClient = () => {
  const conn = {
    request: () => Promise.resolve({}),
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
  };
  return {
    [$conn]: () => conn,
    getConnection: () => ({
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
    }),
  } as any;
};

// Create a minimal DOM environment for testing
// Note: This doesn't fully replicate HTMLElement behavior
function createMockDocument() {
  let idCounter = 0;

  const createElement = (tagName: string) => {
    const attributes = new Map<string, string>();
    const eventListeners = new Map<string, ((event: unknown) => void)[]>();
    const childNodes: any[] = [];

    const element: Record<string, any> = {
      tagName: tagName.toUpperCase(),
      _id: `mock-${idCounter++}`,
      nodeType: 1, // ELEMENT_NODE
      parentNode: null,
      childNodes,
      get dataset() {
        const dataset: Record<string, string> = {};
        for (const [name, value] of attributes.entries()) {
          if (!name.startsWith("data-")) {
            continue;
          }
          const key = name.slice(5).replace(
            /-([a-z])/g,
            (_, char: string) => char.toUpperCase(),
          );
          dataset[key] = value;
        }
        return dataset;
      },

      setAttribute(name: string, value: string) {
        attributes.set(name, value);
      },
      getAttribute(name: string) {
        return attributes.get(name) ?? null;
      },
      hasAttribute(name: string) {
        return attributes.has(name);
      },
      removeAttribute(name: string) {
        attributes.delete(name);
      },
      appendChild(child: any) {
        // Remove from current position if already a child (handles move)
        const existingIndex = childNodes.indexOf(child);
        if (existingIndex >= 0) {
          childNodes.splice(existingIndex, 1);
        }

        child.parentNode = this;
        childNodes.push(child);
        return child;
      },
      insertBefore(child: any, reference: any) {
        // Remove from current parent if already attached (handles move)
        const existingIndex = childNodes.indexOf(child);
        if (existingIndex >= 0) {
          childNodes.splice(existingIndex, 1);
        }

        child.parentNode = this;
        if (reference === null) {
          childNodes.push(child);
        } else {
          const index = childNodes.indexOf(reference);
          if (index >= 0) {
            childNodes.splice(index, 0, child);
          } else {
            childNodes.push(child);
          }
        }
        return child;
      },
      removeChild(child: any) {
        const index = childNodes.indexOf(child);
        if (index >= 0) {
          childNodes.splice(index, 1);
          child.parentNode = null;
        }
        return child;
      },
      addEventListener(type: string, listener: (event: unknown) => void) {
        if (!eventListeners.has(type)) {
          eventListeners.set(type, []);
        }
        eventListeners.get(type)!.push(listener);
      },
      removeEventListener(type: string, listener: (event: unknown) => void) {
        const listeners = eventListeners.get(type);
        if (listeners) {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        }
      },
      dispatchEvent(event: any) {
        const listeners = eventListeners.get(event.type) ?? [];
        listeners.forEach((listener) => listener(event));
      },
    };

    return element;
  };

  const createTextNode = (text: string) => {
    return {
      _id: `text-${idCounter++}`,
      nodeType: 3, // TEXT_NODE
      textContent: text,
      parentNode: null,
    };
  };

  return {
    createElement,
    createTextNode,
  } as unknown as Document;
}

describe("DomApplicator", () => {
  describe("instance members", () => {
    describe("applyBatch()", () => {
      it("removes an ARIA attribute when its property is dropped", () => {
        const doc = createMockDocument();
        const applicator = new DomApplicator({
          document: doc,
          onEvent: () => {},
        });
        applicator.applyBatch({
          batchId: 1,
          ops: [{ op: "create-element", nodeId: 1, tagName: "button" }],
        });
        const element = applicator.getNode(1) as Element;
        element.setAttribute("aria-label", "Edit name");
        applicator.applyBatch({
          batchId: 2,
          ops: [{ op: "remove-prop", nodeId: 1, key: "aria-label" }],
        });
        expect(element.hasAttribute("aria-label")).toBe(false);
      });
      describe("create elements", () => {
        it("creates an element from create-element op", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          const batch: VDomBatch = {
            batchId: 1,
            ops: [{ op: "create-element", nodeId: 1, tagName: "div" }],
          };

          applicator.applyBatch(batch);

          const node = applicator.getNode(1);
          assertExists(node);
          expect((node as any).tagName).toBe("DIV");
        });

        it("creates a text node from create-text op", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          const batch: VDomBatch = {
            batchId: 1,
            ops: [{ op: "create-text", nodeId: 1, text: "Hello World" }],
          };

          applicator.applyBatch(batch);

          const node = applicator.getNode(1);
          assertExists(node);
          expect((node as any).textContent).toBe("Hello World");
        });

        it("creates multiple elements in one batch", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "div" },
              { op: "create-element", nodeId: 2, tagName: "span" },
              { op: "create-text", nodeId: 3, text: "Hello" },
            ],
          });

          assertExists(applicator.getNode(1));
          assertExists(applicator.getNode(2));
          assertExists(applicator.getNode(3));
          expect((applicator.getNode(1) as any).tagName).toBe("DIV");
          expect((applicator.getNode(2) as any).tagName).toBe("SPAN");
          expect((applicator.getNode(3) as any).textContent).toBe("Hello");
        });

        it("updates text nodes without DOM globals", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "span" },
              { op: "create-text", nodeId: 2, text: "0" },
              { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
            ],
          });

          applicator.applyBatch({
            batchId: 2,
            ops: [{ op: "update-text", nodeId: 2, text: "1" }],
          });

          const textNode = applicator.getNode(2) as any;
          assertExists(textNode);
          expect(textNode.textContent).toBe("1");
        });
      });

      describe("child operations", () => {
        it("inserts child at end", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "div" },
              { op: "create-element", nodeId: 2, tagName: "span" },
              { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
            ],
          });

          const parent = applicator.getNode(1) as any;
          const child = applicator.getNode(2) as any;
          expect(parent.childNodes.length).toBe(1);
          expect(parent.childNodes[0]).toStrictEqual(child);
          expect(child.parentNode).toStrictEqual(parent);
        });

        it("inserts child before another", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "div" },
              { op: "create-element", nodeId: 2, tagName: "span" },
              { op: "create-element", nodeId: 3, tagName: "p" },
              { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
              { op: "insert-child", parentId: 1, childId: 3, beforeId: 2 },
            ],
          });

          const parent = applicator.getNode(1) as any;
          expect(parent.childNodes.length).toBe(2);
          expect(parent.childNodes[0].tagName).toBe("P");
          expect(parent.childNodes[1].tagName).toBe("SPAN");
        });

        it(
          "replays insert when child is created later in the batch",
          () => {
            const doc = createMockDocument();
            const applicator = new DomApplicator({
              document: doc,
              runtimeClient: createMockRuntimeClient(),
              onEvent: () => {},
            });

            applicator.applyBatch({
              batchId: 1,
              ops: [
                { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
                { op: "create-element", nodeId: 1, tagName: "div" },
                { op: "create-element", nodeId: 2, tagName: "span" },
              ],
            });

            const parent = applicator.getNode(1) as unknown as {
              childNodes: Array<{ tagName: string }>;
            };
            expect(parent.childNodes.length).toBe(1);
            expect(parent.childNodes[0].tagName).toBe("SPAN");
          },
        );

        it(
          "does not replay stale placement after child moves elsewhere",
          () => {
            const doc = createMockDocument();
            const applicator = new DomApplicator({
              document: doc,
              runtimeClient: createMockRuntimeClient(),
              onEvent: () => {},
            });

            applicator.applyBatch({
              batchId: 1,
              ops: [
                { op: "create-element", nodeId: 1, tagName: "section" },
                { op: "insert-child", parentId: 2, childId: 3, beforeId: null },
                { op: "create-element", nodeId: 3, tagName: "span" },
                { op: "insert-child", parentId: 1, childId: 3, beforeId: null },
                { op: "create-element", nodeId: 2, tagName: "div" },
              ],
            });

            const laterParent = applicator.getNode(1) as unknown as {
              childNodes: Array<{ tagName: string }>;
            };
            const staleParent = applicator.getNode(2) as unknown as {
              childNodes: Array<{ tagName: string }>;
            };
            expect(laterParent.childNodes.map((child) => child.tagName))
              .toStrictEqual([
                "SPAN",
              ]);
            expect(staleParent.childNodes).toStrictEqual([]);
          },
        );

        it(
          "waits for beforeId to attach before replaying placement",
          () => {
            const doc = createMockDocument();
            const applicator = new DomApplicator({
              document: doc,
              runtimeClient: createMockRuntimeClient(),
              onEvent: () => {},
            });

            applicator.applyBatch({
              batchId: 1,
              ops: [
                { op: "create-element", nodeId: 1, tagName: "div" },
                { op: "create-element", nodeId: 4, tagName: "c" },
                { op: "insert-child", parentId: 1, childId: 4, beforeId: null },
                { op: "create-element", nodeId: 2, tagName: "a" },
                { op: "insert-child", parentId: 1, childId: 2, beforeId: 3 },
                { op: "create-element", nodeId: 3, tagName: "b" },
                { op: "insert-child", parentId: 1, childId: 3, beforeId: 4 },
              ],
            });

            const parent = applicator.getNode(1) as unknown as {
              childNodes: Array<{ tagName: string }>;
            };
            expect(parent.childNodes.map((child) => child.tagName))
              .toStrictEqual([
                "A",
                "B",
                "C",
              ]);
          },
        );

        it(
          "does not replay insert after child is removed before creation",
          () => {
            const doc = createMockDocument();
            const applicator = new DomApplicator({
              document: doc,
              runtimeClient: createMockRuntimeClient(),
              onEvent: () => {},
            });

            applicator.applyBatch({
              batchId: 1,
              ops: [
                { op: "create-element", nodeId: 1, tagName: "div" },
                { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
                { op: "remove-node", nodeId: 2 },
                { op: "create-element", nodeId: 2, tagName: "span" },
              ],
            });

            const parent = applicator.getNode(1) as unknown as {
              childNodes: Array<{ tagName: string }>;
            };
            expect(parent.childNodes).toStrictEqual([]);
            expect(
              (applicator.getNode(2) as unknown as { tagName: string }).tagName,
            )
              .toBe("SPAN");
          },
        );

        it("drops pending inserts that target removed descendants", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "section" },
              { op: "create-element", nodeId: 2, tagName: "div" },
              { op: "create-element", nodeId: 3, tagName: "b" },
              { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
              { op: "insert-child", parentId: 2, childId: 3, beforeId: null },
              { op: "create-element", nodeId: 4, tagName: "a" },
              { op: "insert-child", parentId: 1, childId: 4, beforeId: 3 },
              { op: "remove-node", nodeId: 1 },
              { op: "create-element", nodeId: 5, tagName: "footer" },
            ],
          });

          expect(applicator.getNode(1)).toBe(undefined);
          expect(applicator.getNode(2)).toBe(undefined);
          expect(applicator.getNode(3)).toBe(undefined);
          const pendingChild = applicator.getNode(4) as unknown as {
            parentNode: unknown;
            tagName: string;
          };
          expect(pendingChild.tagName).toBe("A");
          expect(pendingChild.parentNode).toBe(null);
        });

        it(
          "appends pending insert when only beforeId anchor is removed",
          () => {
            const doc = createMockDocument();
            const applicator = new DomApplicator({
              document: doc,
              runtimeClient: createMockRuntimeClient(),
              onEvent: () => {},
            });

            applicator.applyBatch({
              batchId: 1,
              ops: [
                { op: "create-element", nodeId: 1, tagName: "section" },
                { op: "create-element", nodeId: 2, tagName: "a" },
                { op: "create-element", nodeId: 3, tagName: "b" },
                { op: "insert-child", parentId: 1, childId: 2, beforeId: 3 },
              ],
            });

            const parent = applicator.getNode(1) as unknown as {
              childNodes: Array<{ tagName: string }>;
            };
            const pendingChild = applicator.getNode(2) as unknown as {
              parentNode: unknown;
              tagName: string;
            };
            expect(parent.childNodes).toStrictEqual([]);
            expect(pendingChild.parentNode).toBe(null);

            applicator.applyBatch({
              batchId: 2,
              ops: [{ op: "remove-node", nodeId: 3 }],
            });

            expect(parent.childNodes.map((child) => child.tagName))
              .toStrictEqual([
                "A",
              ]);
            expect(pendingChild.parentNode).toStrictEqual(parent);
          },
        );

        it("re-inserting an attached child moves it", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "div" },
              { op: "create-element", nodeId: 2, tagName: "a" },
              { op: "create-element", nodeId: 3, tagName: "b" },
              { op: "create-element", nodeId: 4, tagName: "c" },
              { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
              { op: "insert-child", parentId: 1, childId: 3, beforeId: null },
              { op: "insert-child", parentId: 1, childId: 4, beforeId: null },
            ],
          });

          // Move first child to end
          applicator.applyBatch({
            batchId: 2,
            ops: [{
              op: "insert-child",
              parentId: 1,
              childId: 2,
              beforeId: null,
            }],
          });

          const parent = applicator.getNode(1) as any;
          expect(parent.childNodes.length).toBe(3);
          expect(parent.childNodes[0].tagName).toBe("B");
          expect(parent.childNodes[1].tagName).toBe("C");
          expect(parent.childNodes[2].tagName).toBe("A");
        });

        it("removes a node", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "div" },
              { op: "create-element", nodeId: 2, tagName: "span" },
              { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
            ],
          });

          applicator.applyBatch({
            batchId: 2,
            ops: [{ op: "remove-node", nodeId: 2 }],
          });

          const parent = applicator.getNode(1) as any;
          expect(parent.childNodes.length).toBe(0);
          expect(applicator.getNode(2)).toBe(undefined);
        });

        it("removes listeners from removed descendants", () => {
          const doc = createMockDocument();
          const events: DomEventMessage[] = [];
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: (msg) => events.push(msg),
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "section" },
              { op: "create-element", nodeId: 2, tagName: "button" },
              { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
              { op: "set-event", nodeId: 1, eventType: "click", handlerId: 11 },
              { op: "set-event", nodeId: 2, eventType: "click", handlerId: 22 },
            ],
          });

          const parentNode = applicator.getNode(1) as unknown as {
            dispatchEvent(event: {
              type: string;
              target: unknown;
              isTrusted: boolean;
            }): void;
          };
          const childNode = applicator.getNode(2) as unknown as {
            dispatchEvent(event: {
              type: string;
              target: unknown;
              isTrusted: boolean;
            }): void;
          };

          applicator.applyBatch({
            batchId: 2,
            ops: [{ op: "remove-node", nodeId: 1 }],
          });

          parentNode.dispatchEvent({
            type: "click",
            target: parentNode,
            isTrusted: true,
          });
          childNode.dispatchEvent({
            type: "click",
            target: childNode,
            isTrusted: true,
          });

          expect(events).toStrictEqual([]);
          expect(applicator.getNode(1)).toBe(undefined);
          expect(applicator.getNode(2)).toBe(undefined);
        });
      });

      describe("event handling", () => {
        it("sets event listener and dispatches events", () => {
          const doc = createMockDocument();
          const events: DomEventMessage[] = [];
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: (msg) => events.push(msg),
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "button" },
              { op: "set-event", nodeId: 1, eventType: "click", handlerId: 42 },
            ],
          });

          // Simulate a click
          const node = applicator.getNode(1) as any;
          node.dispatchEvent({ type: "click", target: node, isTrusted: true });

          expect(events.length).toBe(1);
          expect(events[0].type).toBe("dom-event");
          expect(events[0].handlerId).toBe(42);
          expect(events[0].nodeId).toBe(1);
          expect(events[0].event.type).toBe("click");
          expect(events[0].event.provenance).toStrictEqual({
            origin: "dom",
            trusted: true,
          });
        });

        it("serializes data-ui dataset markers with trusted events", () => {
          const doc = createMockDocument();
          const events: DomEventMessage[] = [];
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: (msg) => events.push(msg),
            setProp: (target, key, value) => {
              if (
                key.startsWith("data-") &&
                isObjectOrArray(target) &&
                "setAttribute" in target &&
                typeof target.setAttribute === "function"
              ) {
                target.setAttribute(key, String(value));
                return;
              }
              (target as Record<string, unknown>)[key] = value;
            },
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "button" },
              {
                op: "set-prop",
                nodeId: 1,
                key: "data-ui-action",
                value: "SubmitDirectCommand",
              },
              { op: "set-event", nodeId: 1, eventType: "click", handlerId: 42 },
            ],
          });

          const node = applicator.getNode(1) as any;
          node.dispatchEvent({ type: "click", target: node, isTrusted: true });

          expect(events[0].event.target?.dataset).toStrictEqual({
            uiAction: "SubmitDirectCommand",
          });
        });

        it("attests nearest trusted UI pattern provenance", () => {
          const doc = createMockDocument();
          const events: DomEventMessage[] = [];
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: (msg) => events.push(msg),
            setProp: (target, key, value) => {
              if (
                key.startsWith("data-") &&
                isObjectOrArray(target) &&
                "setAttribute" in target &&
                typeof target.setAttribute === "function"
              ) {
                target.setAttribute(key, String(value));
                return;
              }
              (target as Record<string, unknown>)[key] = value;
            },
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "section" },
              {
                op: "set-prop",
                nodeId: 1,
                key: "data-ui-pattern",
                value: "TrustedDirectCommandSurface",
              },
              {
                op: "set-prop",
                nodeId: 1,
                key: "data-ui-event-integrity",
                value: "TrustedDirectCommandSurface",
              },
              { op: "create-element", nodeId: 2, tagName: "button" },
              {
                op: "set-prop",
                nodeId: 2,
                key: "data-ui-action",
                value: "SubmitDirectCommand",
              },
              {
                op: "insert-child",
                parentId: 1,
                childId: 2,
                beforeId: null,
              },
              { op: "set-event", nodeId: 2, eventType: "click", handlerId: 42 },
            ],
          });

          const node = applicator.getNode(2) as any;
          node.dispatchEvent({ type: "click", target: node, isTrusted: true });

          expect(events[0].event.provenance).toStrictEqual({
            origin: "dom",
            trusted: true,
            ui: {
              pattern: "TrustedDirectCommandSurface",
              eventIntegrity: ["TrustedDirectCommandSurface"],
              uiContractDataset: {
                uiAction: "SubmitDirectCommand",
              },
            },
          });
        });

        it("removes event listener", () => {
          const doc = createMockDocument();
          const events: DomEventMessage[] = [];
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: (msg) => events.push(msg),
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "button" },
              { op: "set-event", nodeId: 1, eventType: "click", handlerId: 42 },
            ],
          });

          applicator.applyBatch({
            batchId: 2,
            ops: [{ op: "remove-event", nodeId: 1, eventType: "click" }],
          });

          // Simulate a click - should not trigger event
          const node = applicator.getNode(1) as any;
          node.dispatchEvent({ type: "click", target: node });

          expect(events.length).toBe(0);
        });

        it("replaces event handler when setting same event type", () => {
          const doc = createMockDocument();
          const events: DomEventMessage[] = [];
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: (msg) => events.push(msg),
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "button" },
              { op: "set-event", nodeId: 1, eventType: "click", handlerId: 1 },
            ],
          });

          applicator.applyBatch({
            batchId: 2,
            ops: [{
              op: "set-event",
              nodeId: 1,
              eventType: "click",
              handlerId: 2,
            }],
          });

          const node = applicator.getNode(1) as any;
          node.dispatchEvent({ type: "click", target: node });

          // Should only have one event with the new handler ID
          expect(events.length).toBe(1);
          expect(events[0].handlerId).toBe(2);
        });
      });

      describe("cell bindings", () => {
        const cellRef: CellRef = {
          id: "of:test-cell" as CellRef["id"],
          space: "did:key:test-space" as CellRef["space"],
          scope: "space",
          path: ["value"],
          schema: { type: "string" },
        };

        it("does not replace a binding for the same cell ref", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "cf-cell-link" },
              { op: "set-binding", nodeId: 1, propName: "cell", cellRef },
            ],
          });

          const node = applicator.getNode(1) as any;
          const firstHandle = node.cell;
          assertExists(firstHandle);

          applicator.applyBatch({
            batchId: 2,
            ops: [{ op: "set-binding", nodeId: 1, propName: "cell", cellRef }],
          });

          expect(node.cell).toBe(firstHandle);

          applicator.applyBatch({
            batchId: 3,
            ops: [{
              op: "set-binding",
              nodeId: 1,
              propName: "cell",
              cellRef: { ...cellRef, schema: { type: "number" } },
            }],
          });

          expect(node.cell).not.toBe(firstHandle);
        });

        it(
          "keeps a nested pattern binding out of authored properties",
          () => {
            const doc = createMockDocument();
            const applicator = new DomApplicator({
              document: doc,
              runtimeClient: createMockRuntimeClient(),
              onEvent: () => {},
            });

            applicator.applyBatch({
              batchId: 1,
              ops: [
                { op: "create-element", nodeId: 1, tagName: "section" },
                { op: "set-piece-boundary", nodeId: 1, cellRef },
              ],
            });

            const node = applicator.getNode(1) as
              & Element
              & Record<string, unknown>;
            assertExists(getPieceBoundary(node));

            applicator.applyBatch({
              batchId: 2,
              ops: [{ op: "clear-piece-boundary", nodeId: 1 }],
            });
            expect(getPieceBoundary(node)).toBe(undefined);

            applicator.applyBatch({
              batchId: 3,
              ops: [{
                op: "set-binding",
                nodeId: 1,
                propName: "__commonFabricPieceBoundary",
                cellRef,
              }],
            });
            expect(getPieceBoundary(node)).toBe(undefined);

            applicator.applyBatch({
              batchId: 4,
              ops: [{ op: "set-piece-boundary", nodeId: 1, cellRef }],
            });
            assertExists(getPieceBoundary(node));
            applicator.applyBatch({
              batchId: 5,
              ops: [{ op: "remove-node", nodeId: 1 }],
            });
            expect(getPieceBoundary(node)).toBe(undefined);
          },
        );
      });

      describe("batch with rootId", () => {
        it("tracks root node ID", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [{ op: "create-element", nodeId: 5, tagName: "div" }],
            rootId: 5,
          });

          const root = applicator.getRootNode();
          assertExists(root);
          expect((root as any).tagName).toBe("DIV");
        });

        it("updates root when rootId changes", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [{ op: "create-element", nodeId: 1, tagName: "div" }],
            rootId: 1,
          });

          applicator.applyBatch({
            batchId: 2,
            ops: [{ op: "create-element", nodeId: 2, tagName: "span" }],
            rootId: 2,
          });

          const root = applicator.getRootNode();
          expect((root as any).tagName).toBe("SPAN");
        });

        it("keeps the root when a batch omits rootId", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          applicator.applyBatch({
            batchId: 1,
            ops: [{ op: "create-element", nodeId: 1, tagName: "div" }],
            rootId: 1,
          });

          applicator.applyBatch({ batchId: 2, ops: [] });

          const root = applicator.getRootNode();
          expect((root as any).tagName).toBe("DIV");
        });

        it("clears the root when a batch says rootId is null", () => {
          const doc = createMockDocument();
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
          });

          // Registering a container makes `CONTAINER_NODE_ID` a node that resolves,
          // as it does in every applicator outside a test. Without it, a root
          // coerced to 0 reads back as no root at all -- `getRootNode()` returning
          // `null` from a lookup that missed rather than from the field being
          // cleared -- and this step would pass for an implementation that puts the
          // container on the root.
          applicator.setContainer(
            doc.createElement("section") as unknown as HTMLElement,
          );

          applicator.applyBatch({
            batchId: 1,
            ops: [{ op: "create-element", nodeId: 1, tagName: "div" }],
            rootId: 1,
          });

          applicator.applyBatch({ batchId: 2, ops: [], rootId: null });

          // Node 1 outlives the batch, so a root still reported here would be the
          // stale one rather than a lookup that happened to miss.
          assertExists(applicator.getNode(1));
          expect(applicator.getRootNode()).toBe(null);
        });
      });

      describe("error handling", () => {
        it("continues processing batch after operation error", () => {
          const doc = createMockDocument();
          const errors: Error[] = [];
          const applicator = new DomApplicator({
            document: doc,
            runtimeClient: createMockRuntimeClient(),
            onEvent: () => {},
            onError: (err) => errors.push(err),
          });

          // This should not crash even with invalid operations
          applicator.applyBatch({
            batchId: 1,
            ops: [
              { op: "update-text", nodeId: 999, text: "test" }, // Non-existent node
              { op: "create-element", nodeId: 1, tagName: "div" }, // Valid
            ],
          });

          // Second op should still have worked
          assertExists(applicator.getNode(1));
        });
      });

      describe("bindings", () => {
        it(
          "requests a custom element update after assigning a CellHandle",
          async () => {
            const customElementsDescriptor = Object.getOwnPropertyDescriptor(
              globalThis,
              "customElements",
            );
            Object.defineProperty(globalThis, "customElements", {
              configurable: true,
              value: {
                whenDefined: () => Promise.resolve(undefined),
              },
            });

            const doc = createMockDocument();
            const applicator = new DomApplicator({
              document: doc,
              runtimeClient: createMockRuntimeClient(),
              onEvent: () => {},
            });

            applicator.applyBatch({
              batchId: 1,
              ops: [{
                op: "create-element",
                nodeId: 1,
                tagName: "cf-cfc-label",
              }],
            });

            const node = applicator.getNode(1) as any;
            const requested: PropertyKey[] = [];
            node.localName = "cf-cfc-label";
            node.requestUpdate = (name?: PropertyKey) => {
              if (name !== undefined) {
                requested.push(name);
              }
            };

            try {
              applicator.applyBatch({
                batchId: 2,
                ops: [{
                  op: "set-binding",
                  nodeId: 1,
                  propName: "value",
                  cellRef: {
                    space: "did:key:test",
                    scope: "space",
                    id: "of:test",
                    path: [],
                  },
                }],
              });

              await Promise.resolve();

              expect(node.value.constructor.name).toBe("CellHandle");
              expect(requested).toStrictEqual(["value"]);
            } finally {
              if (customElementsDescriptor) {
                Object.defineProperty(
                  globalThis,
                  "customElements",
                  customElementsDescriptor,
                );
              } else {
                Reflect.deleteProperty(globalThis, "customElements");
              }
            }
          },
        );
      });
    });

    describe("setContainer()", () => {
      it("registers container element with CONTAINER_NODE_ID (0)", () => {
        const doc = createMockDocument();
        const applicator = new DomApplicator({
          document: doc,
          runtimeClient: createMockRuntimeClient(),
          onEvent: () => {},
        });

        const container = doc.createElement(
          "section",
        ) as unknown as HTMLElement;
        applicator.setContainer(container);

        // Verify container is registered with ID 0
        expect(applicator.getNode(0)).toStrictEqual(container);
      });

      it("allows inserting children directly into container", () => {
        const doc = createMockDocument();
        const applicator = new DomApplicator({
          document: doc,
          runtimeClient: createMockRuntimeClient(),
          onEvent: () => {},
        });

        const container = doc.createElement(
          "section",
        ) as unknown as HTMLElement;
        applicator.setContainer(container);

        // Insert a child directly into the container (node 0)
        applicator.applyBatch({
          batchId: 1,
          ops: [
            { op: "create-element", nodeId: 1, tagName: "div" },
            { op: "insert-child", parentId: 0, childId: 1, beforeId: null },
          ],
        });

        expect((container as any).childNodes.length).toBe(1);
        expect((container as any).childNodes[0].tagName).toBe("DIV");
      });
    });

    describe("dispose()", () => {
      it("cleans up all nodes and listeners", () => {
        const doc = createMockDocument();
        const events: DomEventMessage[] = [];
        const applicator = new DomApplicator({
          document: doc,
          runtimeClient: createMockRuntimeClient(),
          onEvent: (msg) => events.push(msg),
        });

        applicator.applyBatch({
          batchId: 1,
          ops: [
            { op: "create-element", nodeId: 1, tagName: "div" },
            { op: "create-element", nodeId: 2, tagName: "button" },
            { op: "insert-child", parentId: 1, childId: 2, beforeId: null },
            { op: "set-event", nodeId: 2, eventType: "click", handlerId: 1 },
          ],
          rootId: 1,
        });

        applicator.dispose();

        expect(applicator.getNode(1)).toBe(undefined);
        expect(applicator.getNode(2)).toBe(undefined);
        expect(applicator.getRootNode()).toBe(null);
      });
    });
  });

  // Note: The following tests require a real DOM environment because the applicator
  // uses `instanceof HTMLElement` checks. They are documented here for completeness
  // but would need to be run in a browser or with jsdom/happy-dom.
  //
  // Skipped tests:
  // - "sets properties" - requires HTMLElement instanceof check
  // - "sets style attribute" - requires HTMLElement instanceof check
  // - "sets data attributes" - requires HTMLElement instanceof check
  // - "removes properties" - requires HTMLElement instanceof check
  // - "updates text content" - requires Node.TEXT_NODE constant
  // - "sets bidirectional binding" - requires HTMLElement instanceof check
});
