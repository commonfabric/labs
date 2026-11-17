import { settle } from "./dom.ts";

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";
import { defer } from "@commonfabric/async/defer";
import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";

import type { FabricBridge } from "../src/bridge.ts";
import { CommonIframeSandboxElement } from "../src/index.ts";
import { connectFabric } from "../src/guest.ts";
import { guestDocument } from "../src/guest-document.ts";
import {
  GUEST_PORT_HANDOFF,
  GUEST_PORT_ORDERED,
  type GuestError,
} from "../src/ipc.ts";
import OuterFrame from "../src/outer-frame.ts";
import type { IframePresentation } from "../src/presentation.ts";

/** A message the element posted to the guest frame, with what it transferred. */
type GuestPost = { message: unknown; ports: MessagePort[] };

const PRESENTATION: IframePresentation = {
  css: "body { color: red; }",
  attributes: { "data-theme": "dark" },
  stylesheets: ["https://example.com/a.css"],
};

const ALARM: GuestError = {
  description: "boom",
  source: "guest.js",
  lineno: 3,
  colno: 7,
  stacktrace: "at guest.js:3:7",
};

/** Appends a new element to the document, after `setup` has configured it. */
async function mount(
  setup: (element: CommonIframeSandboxElement) => void = () => {},
): Promise<CommonIframeSandboxElement> {
  const element = new CommonIframeSandboxElement();
  setup(element);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function frameOf(element: CommonIframeSandboxElement): HTMLIFrameElement {
  const frame = element.accessForTestingOnly.iframeRef.value;
  if (!frame) throw new Error("The element rendered no frame.");
  return frame;
}

function outerWindowOf(element: CommonIframeSandboxElement): Window {
  const outer = frameOf(element).contentWindow;
  if (!outer) throw new Error("The element's frame has no window.");
  return outer;
}

/** Dispatches `data` on the page as a message from `source`. */
function postFrom(source: Window | null, data: unknown): void {
  globalThis.dispatchEvent(new MessageEvent("message", { data, source }));
}

/** Dispatches `data` on the page as a message from the element's frame. */
function postFromOuter(
  element: CommonIframeSandboxElement,
  data: unknown,
): void {
  postFrom(outerWindowOf(element), data);
}

/**
 * Collects what the element posts to its frame's window. A post is delivered
 * a task later, so a test reads the list once `settle()` resolves.
 */
function recordOuterPosts(element: CommonIframeSandboxElement): unknown[] {
  const posts: unknown[] = [];
  outerWindowOf(element).addEventListener(
    "message",
    (event: MessageEvent) => posts.push(event.data),
  );
  return posts;
}

/**
 * Gives the element's frame a guest frame that records what is posted to it
 * and passes it on to the page, where a client from `connectFabric()` hears
 * it as a guest would. A frame that loads nothing has no guest frame, and
 * happy-dom transfers nothing a post carries, so this stands in for both.
 */
function addGuestFrame(element: CommonIframeSandboxElement): GuestPost[] {
  const posts: GuestPost[] = [];
  const guest = {
    postMessage(
      message: unknown,
      _origin: string,
      transfer: Transferable[] = [],
    ) {
      const ports = transfer.filter((item) => item instanceof MessagePort);
      posts.push({ message, ports });
      globalThis.dispatchEvent(
        new MessageEvent("message", { data: message, ports }),
      );
    },
  };
  Object.defineProperty(outerWindowOf(element), "frames", {
    configurable: true,
    value: [guest],
  });
  return posts;
}

/** Returns the ports the element handed the guest, in order. */
function handedPorts(posts: readonly GuestPost[]): MessagePort[] {
  return posts.filter(({ message }) => message === GUEST_PORT_HANDOFF)
    .flatMap(({ ports }) => ports);
}

/** A bridge with one cell, `count`, which counts its open subscriptions. */
function countingBridge() {
  let open = 0;
  const cancelled = defer();
  const bridge: FabricBridge = {
    resources: {
      count: {
        kind: "cell",
        cell: {
          get: () => 1,
          pull: () => 1,
          sink: (listener) => {
            open++;
            listener(1);
            return () => {
              open--;
              cancelled.resolve();
            };
          },
        },
      },
    },
  };
  return { bridge, open: () => open, cancelled: cancelled.promise };
}

/** Resolves after every microtask queued before the call has run. */
function afterQueuedMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe("CommonIframeSandboxElement", () => {
  let consoleError: Stub<Console>;

  beforeEach(() => {
    consoleError = stub(console, "error");
  });

  afterEach(async () => {
    consoleError.restore();
    document.body.replaceChildren();
    await settle();
  });

  describe("instance members", () => {
    describe("presentation", () => {
      it("is `null` until one is assigned", async () => {
        const element = await mount();
        expect(element.presentation).toBe(null);
      });

      it("holds a frozen copy of what was assigned", async () => {
        const element = await mount();
        const attributes: Record<`data-${string}`, string> = {
          "data-theme": "dark",
        };
        const stylesheets = ["https://example.com/a.css"];
        element.presentation = { css: "p {}", attributes, stylesheets };
        attributes["data-theme"] = "light";
        stylesheets.push("https://example.com/b.css");

        expect(element.presentation).toEqual({
          css: "p {}",
          attributes: { "data-theme": "dark" },
          stylesheets: ["https://example.com/a.css"],
        });
        expect(Object.isFrozen(element.presentation)).toBe(true);
        expect(Object.isFrozen(element.presentation.attributes)).toBe(true);
        expect(Object.isFrozen(element.presentation.stylesheets)).toBe(true);
      });

      it("returns to `null` when `null` is assigned", async () => {
        const element = await mount((element) => {
          element.presentation = PRESENTATION;
        });
        element.presentation = null;
        expect(element.presentation).toBe(null);
      });

      for (
        const [what, value] of [
          ["a value that is not an object", "body {}"],
          ["an array", []],
          ["CSS that is not a string", { ...PRESENTATION, css: 1 }],
          ["attributes that are not an object", {
            ...PRESENTATION,
            attributes: [],
          }],
          ["an attribute not named `data-*`", {
            ...PRESENTATION,
            attributes: { style: "color: red" },
          }],
          ["an attribute named with capitals", {
            ...PRESENTATION,
            attributes: { "data-Theme": "dark" },
          }],
          ["an attribute whose value is not a string", {
            ...PRESENTATION,
            attributes: { "data-theme": 1 },
          }],
          ["stylesheets that are not an array", {
            ...PRESENTATION,
            stylesheets: "https://example.com/a.css",
          }],
          ["a stylesheet that is not a string", {
            ...PRESENTATION,
            stylesheets: [1],
          }],
        ] as const
      ) {
        it(`throws a \`TypeError\` given ${what}, keeping the one it had`, async () => {
          const element = await mount((element) => {
            element.presentation = PRESENTATION;
          });
          expect(() => Reflect.set(element, "presentation", value)).toThrow(
            TypeError,
          );
          expect(element.presentation).toEqual(PRESENTATION);
        });
      }
    });

    describe("outerFrameUrl", () => {
      it("renders the outer frame inlined as `srcdoc` while it is unset", async () => {
        const element = await mount();
        const frame = frameOf(element);
        expect(frame.srcdoc).toBe(OuterFrame);
        expect(frame.hasAttribute("src")).toBe(false);
        expect(frame.getAttribute("sandbox")).toBe(
          "allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox",
        );
      });

      it("renders the outer frame from the URL once one is set", async () => {
        const element = await mount((element) => {
          element.outerFrameUrl = "https://frames.example/outer.html";
        });
        const frame = frameOf(element);
        expect(frame.getAttribute("src")).toBe(
          "https://frames.example/outer.html",
        );
        expect(frame.srcdoc).toBe("");
        expect(frame.getAttribute("sandbox")).toBe(
          "allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox",
        );
      });

      it("replaces the frame and lets go of the loaded guest when it changes", async () => {
        const { bridge, open } = countingBridge();
        const element = await mount((element) => {
          element.src = "<p>guest</p>";
          element.bridge = bridge;
        });
        const first = frameOf(element);
        addGuestFrame(element);
        const client = connectFabric();
        postFromOuter(element, { type: "ready" });
        postFromOuter(element, { type: "load" });
        try {
          client.cell("count").sink(() => {});
          await client.describe();
          expect(open()).toBe(1);

          element.outerFrameUrl = "https://frames.example/outer.html";
          await element.updateComplete;

          expect(frameOf(element)).not.toBe(first);
          expect(element.loadState).toBe("");
          expect(element.accessForTestingOnly.readyWindow).toBe(undefined);
          expect(open()).toBe(0);
        } finally {
          client.disconnect();
        }
      });

      it("loads `src` into the replacement frame once that frame is ready", async () => {
        const element = await mount((element) => {
          element.src = "<p>guest</p>";
          element.outerFrameUrl = "https://frames.example/outer.html";
        });
        element.outerFrameUrl = undefined;
        await element.updateComplete;
        const posts = recordOuterPosts(element);

        postFromOuter(element, { type: "ready" });
        await settle();

        expect(element.loadState).toBe("loading");
        expect(posts).toEqual([{
          type: "load-document",
          data: "<p>guest</p>",
          presentation: null,
        }]);
      });
    });

    describe("accessForTestingOnly", () => {
      describe("onOuterReady()", () => {
        it("throws given the window it already acted on", async () => {
          const element = await mount();
          const outer = outerWindowOf(element);
          element.accessForTestingOnly.onOuterReady(outer);
          expect(() => element.accessForTestingOnly.onOuterReady(outer))
            .toThrow("common-iframe-sandbox: Already initialized.");
        });

        it("accepts a different window, which stands for a new frame", async () => {
          const element = await mount();
          element.accessForTestingOnly.onOuterReady(outerWindowOf(element));
          const replacement = await mount();
          const window = outerWindowOf(replacement);
          expect(() => element.accessForTestingOnly.onOuterReady(window)).not
            .toThrow();
          expect(element.accessForTestingOnly.readyWindow).toBe(window);
        });
      });
    });
  });

  describe("messages from the outer frame", () => {
    describe("`ready`", () => {
      it("asks the frame to load `src`, with `script` and the presentation", async () => {
        const element = await mount((element) => {
          element.src = "<p>guest</p>";
          element.script = "console.log(1);";
          element.presentation = PRESENTATION;
        });
        const posts = recordOuterPosts(element);

        postFromOuter(element, { type: "ready" });
        await settle();

        expect(element.loadState).toBe("loading");
        expect(element.accessForTestingOnly.readyWindow).toBe(
          outerWindowOf(element),
        );
        expect(posts).toEqual([{
          type: "load-document",
          data: guestDocument("<p>guest</p>", "console.log(1);"),
          presentation: PRESENTATION,
        }]);
      });

      it("loads nothing, and says nothing is loaded, without a `src`", async () => {
        const element = await mount((element) => {
          element.script = "console.log(1);";
        });
        const posts = recordOuterPosts(element);

        postFromOuter(element, { type: "ready" });
        await settle();

        expect(element.loadState).toBe("");
        expect(posts).toEqual([]);
      });
    });

    describe("`load`", () => {
      it("hands the guest a port serving the bridge, and dispatches `load`", async () => {
        const { bridge } = countingBridge();
        const element = await mount((element) => {
          element.src = "<p>guest</p>";
          element.bridge = bridge;
        });
        const guestPosts = addGuestFrame(element);
        postFromOuter(element, { type: "ready" });
        let loads = 0;
        element.addEventListener("load", () => loads++);
        const client = connectFabric();

        try {
          postFromOuter(element, { type: "load" });

          expect(element.loadState).toBe("loaded");
          await element.updateComplete;
          expect(element.getAttribute("load-state")).toBe("loaded");
          expect(loads).toBe(1);
          expect(guestPosts.map(({ message }) => message)).toEqual([
            GUEST_PORT_ORDERED,
            GUEST_PORT_HANDOFF,
          ]);
          expect(handedPorts(guestPosts)).toHaveLength(1);
          const manifest = await client.describe();
          expect(manifest.resources.map(({ name }) => name)).toEqual([
            "count",
          ]);
        } finally {
          client.disconnect();
        }
      });

      it("serves an empty bridge to a guest of an element given none", async () => {
        const element = await mount((element) => {
          element.src = "<p>guest</p>";
        });
        addGuestFrame(element);
        postFromOuter(element, { type: "ready" });
        const client = connectFabric();

        try {
          postFromOuter(element, { type: "load" });
          const manifest = await client.describe();
          expect(manifest.resources).toEqual([]);
        } finally {
          client.disconnect();
        }
      });

      it("reports that there is no guest frame, and still dispatches `load`", async () => {
        const element = await mount((element) => {
          element.src = "<p>guest</p>";
        });
        postFromOuter(element, { type: "ready" });
        let loads = 0;
        element.addEventListener("load", () => loads++);

        postFromOuter(element, { type: "load" });

        expect(loads).toBe(1);
        expect(element.loadState).toBe("loaded");
        expect(consoleError.calls.map(({ args }) => args)).toEqual([
          ["common-iframe-sandbox: No guest frame to open a port to."],
        ]);
      });
    });

    describe("`guest-error`", () => {
      it("dispatches `common-iframe-error` for an alarm", async () => {
        const element = await mount();
        const errors: CustomEvent[] = [];
        element.addEventListener(
          "common-iframe-error",
          (event) => {
            if (event instanceof CustomEvent) errors.push(event);
          },
        );

        postFromOuter(element, {
          type: "guest-error",
          data: { type: "error", data: ALARM },
        });

        expect(errors).toHaveLength(1);
        expect(errors[0].bubbles).toBe(true);
        expect(errors[0].composed).toBe(true);
        expect(errors[0].detail).toEqual({
          description: "boom",
          message: "boom",
          source: "guest.js",
          lineno: 3,
          colno: 7,
          stacktrace: "at guest.js:3:7",
          stack: "at guest.js:3:7",
        });
      });

      it("reports an alarm it cannot read, and dispatches nothing", async () => {
        const element = await mount();
        let errors = 0;
        element.addEventListener("common-iframe-error", () => errors++);
        const raised = { type: "error", data: { description: "boom" } };

        postFromOuter(element, { type: "guest-error", data: raised });

        expect(errors).toBe(0);
        expect(consoleError.calls.map(({ args }) => args)).toEqual([
          ["common-iframe-sandbox: Unreadable alarm from guest.", raised],
        ]);
      });

      it("acknowledges a flush marker over the guest's port, echoing its nonce", async () => {
        const element = await mount((element) => {
          element.src = "<p>guest</p>";
        });
        const guestPosts = addGuestFrame(element);
        postFromOuter(element, { type: "ready" });
        postFromOuter(element, { type: "load" });
        const [port] = handedPorts(guestPosts);
        const acknowledged = defer<unknown>();
        port.onmessage = (event) =>
          acknowledged.resolve(fabricFromRealmValue(event.data));

        try {
          postFromOuter(element, {
            type: "guest-error",
            data: { type: "flush", nonce: "nonce-1" },
          });

          expect(await acknowledged.promise).toEqual({
            protocol: "common-fabric-bridge",
            version: 2,
            type: "flush",
            nonce: "nonce-1",
          });
        } finally {
          port.close();
        }
      });

      it("hands a loaded guest that asks for a port another one", async () => {
        const element = await mount((element) => {
          element.src = "<p>guest</p>";
        });
        const guestPosts = addGuestFrame(element);
        postFromOuter(element, { type: "ready" });
        postFromOuter(element, { type: "load" });

        postFromOuter(element, {
          type: "guest-error",
          data: { type: "port-request" },
        });

        const ports = handedPorts(guestPosts);
        expect(ports).toHaveLength(2);
        expect(ports[0]).not.toBe(ports[1]);
        for (const port of ports) port.close();
      });

      it("hands no port to a guest that asks while a document is loading", async () => {
        const element = await mount((element) => {
          element.src = "<p>guest</p>";
        });
        const guestPosts = addGuestFrame(element);
        postFromOuter(element, { type: "ready" });

        postFromOuter(element, {
          type: "guest-error",
          data: { type: "port-request" },
        });

        expect(element.loadState).toBe("loading");
        expect(guestPosts).toEqual([]);
      });
    });

    describe("`outer-error`", () => {
      it("reports the error, and changes nothing", async () => {
        const element = await mount();

        postFromOuter(element, { type: "outer-error", data: "broken" });

        expect(element.loadState).toBe("");
        expect(consoleError.calls.map(({ args }) => args)).toEqual([
          ["common-iframe-sandbox: Error from outer frame:", "broken"],
        ]);
      });
    });

    it("reports a malformed message, and acts on nothing", async () => {
      const element = await mount((element) => {
        element.src = "<p>guest</p>";
      });

      postFromOuter(element, { type: "ready-ish" });

      expect(element.loadState).toBe("");
      expect(consoleError.calls.map(({ args }) => args)).toEqual([
        ["common-iframe-sandbox: Malformed message from guest.", {
          type: "ready-ish",
        }],
      ]);
    });

    it("ignores a message from any window but the element's frame", async () => {
      const element = await mount((element) => {
        element.src = "<p>guest</p>";
      });
      const other = await mount();

      postFrom(null, { type: "ready" });
      postFrom(outerWindowOf(other), { type: "ready" });

      expect(element.loadState).toBe("");
      expect(element.accessForTestingOnly.readyWindow).toBe(undefined);
      expect(other.accessForTestingOnly.readyWindow).toBe(
        outerWindowOf(other),
      );
    });
  });

  describe("property changes once the frame is ready", () => {
    async function readyElement(
      setup: (element: CommonIframeSandboxElement) => void = () => {},
    ) {
      const element = await mount(setup);
      postFromOuter(element, { type: "ready" });
      await settle();
      return { element, posts: recordOuterPosts(element) };
    }

    it("asks for no document while the frame has not reported ready", async () => {
      const element = await mount();
      const posts = recordOuterPosts(element);

      element.src = "<p>guest</p>";
      await element.updateComplete;
      await settle();

      expect(element.loadState).toBe("");
      expect(posts).toEqual([]);
    });

    it("asks for the new document when `src` changes", async () => {
      const { element, posts } = await readyElement();

      element.src = "<p>second</p>";
      await element.updateComplete;
      await settle();

      expect(element.src).toBe("<p>second</p>");
      expect(element.loadState).toBe("loading");
      expect(posts).toEqual([{
        type: "load-document",
        data: "<p>second</p>",
        presentation: null,
      }]);
    });

    it("asks for one document carrying every value assigned together", async () => {
      const { bridge } = countingBridge();
      const { element, posts } = await readyElement((element) => {
        element.src = "<p>first</p>";
      });

      element.src = "<p>second</p>";
      element.script = "go();";
      element.bridge = bridge;
      await element.updateComplete;
      await settle();

      expect(element.script).toBe("go();");
      expect(element.bridge).toBe(bridge);
      expect(posts).toEqual([{
        type: "load-document",
        data: guestDocument("<p>second</p>", "go();"),
        presentation: null,
      }]);
    });

    for (const property of ["script", "bridge"] as const) {
      it(`reloads the document when \`${property}\` changes`, async () => {
        const { element, posts } = await readyElement((element) => {
          element.src = "<p>guest</p>";
        });

        if (property === "script") element.script = "go();";
        else element.bridge = countingBridge().bridge;
        await element.updateComplete;
        await settle();

        expect(posts).toEqual([{
          type: "load-document",
          data: guestDocument("<p>guest</p>", element.script),
          presentation: null,
        }]);
      });

      it(`loads nothing when \`${property}\` changes without a \`src\``, async () => {
        const { element, posts } = await readyElement();

        if (property === "script") element.script = "go();";
        else element.bridge = countingBridge().bridge;
        await element.updateComplete;
        await settle();

        expect(element.loadState).toBe("");
        expect(posts).toEqual([]);
      });
    }

    it("sends a new presentation without reloading the document", async () => {
      const { element, posts } = await readyElement((element) => {
        element.src = "<p>guest</p>";
      });

      element.presentation = PRESENTATION;
      await element.updateComplete;
      await settle();

      expect(element.loadState).toBe("loading");
      expect(posts).toEqual([{ type: "presentation", data: PRESENTATION }]);
    });
  });

  describe("detaching", () => {
    async function loadedGuest() {
      const counting = countingBridge();
      const element = await mount((element) => {
        element.src = "<p>guest</p>";
        element.bridge = counting.bridge;
      });
      addGuestFrame(element);
      const client = connectFabric();
      postFromOuter(element, { type: "ready" });
      postFromOuter(element, { type: "load" });
      client.cell("count").sink(() => {});
      await client.describe();
      return { ...counting, element, client };
    }

    it("lets go of the guest once the element stays detached", async () => {
      const { element, client, open, cancelled } = await loadedGuest();
      try {
        expect(open()).toBe(1);

        element.remove();
        await cancelled;

        expect(open()).toBe(0);
      } finally {
        client.disconnect();
      }
    });

    it("keeps the guest when the element is reattached within the task", async () => {
      const { element, client, open } = await loadedGuest();
      try {
        const parent = document.createElement("div");
        document.body.append(parent);

        element.remove();
        parent.append(element);
        await afterQueuedMicrotasks();

        expect(open()).toBe(1);
        const errors: CustomEvent[] = [];
        element.addEventListener(
          "common-iframe-error",
          (event) => {
            if (event instanceof CustomEvent) errors.push(event);
          },
        );
        postFromOuter(element, {
          type: "guest-error",
          data: { type: "error", data: ALARM },
        });
        expect(errors).toHaveLength(1);
      } finally {
        client.disconnect();
      }
    });

    it("stops listening to its frame", async () => {
      const element = await mount((element) => {
        element.src = "<p>guest</p>";
      });
      const outer = outerWindowOf(element);

      element.remove();
      postFrom(outer, { type: "ready" });

      expect(element.loadState).toBe("");
      expect(element.accessForTestingOnly.readyWindow).toBe(undefined);
    });
  });
});
