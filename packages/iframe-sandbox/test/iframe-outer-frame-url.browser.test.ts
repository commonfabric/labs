import "../src/common-iframe-sandbox.ts";
import type { CommonIframeSandboxElement } from "../src/common-iframe-sandbox.ts";
import {
  assert,
  assertEquals,
  cleanupFixtures,
  ContextShim,
  waitForContextValue,
} from "./utils.ts";

// The outer frame, as a host serves it from a URL of its own: the outer
// frame's script as it stands, loaded by URL, and no `data-host-origin`, so
// the script has to take the host's origin from where the document was served.
// `deno-web-test.config.ts` puts both files on the test server.
const OUTER_FRAME_URL = "/outer-frame.html";

const SANDBOX =
  "allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox";

// A guest that reads `key` and writes back one more, which it can only do once
// the outer frame has loaded it and the host has handed it a port.
const guest = (key: string) =>
  `<script type="module">
import { connectFabric } from "/guest.js";
const cell = connectFabric().cell(${JSON.stringify(key)});
cell.set((await cell.pull()) + 1);
</script>`;

/** Adds an element to the page, its outer frame's URL set before it renders. */
function place(
  src: string,
  context: ContextShim,
  outerFrameUrl: string | undefined,
): CommonIframeSandboxElement {
  const parent = document.createElement("div");
  parent.id = `common-iframe-csp-fixture-container-${crypto.randomUUID()}`;
  const element = document.createElement(
    "common-iframe-sandbox",
  ) as CommonIframeSandboxElement;
  element.bridge = context.bridge;
  element.outerFrameUrl = outerFrameUrl;
  element.src = src;
  parent.appendChild(element);
  document.body.appendChild(parent);
  return element;
}

const frameOf = (element: CommonIframeSandboxElement) =>
  element.accessForTestingOnly.iframeRef.value!;

Deno.test("an outer frame served from a URL loads the guest and carries its port", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({ a: 1 });
    const element = place(guest("a"), context, OUTER_FRAME_URL);
    await waitForContextValue(context, element, "a", (value) => value === 2);

    const frame = frameOf(element);
    assertEquals(frame.getAttribute("src"), OUTER_FRAME_URL);
    assert(!frame.hasAttribute("srcdoc"));
    assertEquals(frame.getAttribute("sandbox"), SANDBOX);
    assertEquals(element.loadState, "loaded");
  } finally {
    cleanupFixtures();
  }
});

Deno.test("without a URL the outer frame is inlined as srcdoc", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({ a: 1 });
    const element = place(guest("a"), context, undefined);
    await waitForContextValue(context, element, "a", (value) => value === 2);

    const frame = frameOf(element);
    assert(!frame.hasAttribute("src"));
    assert(frame.srcdoc.includes("data-host-origin"));
    assertEquals(frame.getAttribute("sandbox"), SANDBOX);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("a URL that arrives after the frame was inlined replaces the frame and loads the guest again", async () => {
  cleanupFixtures();
  try {
    // Each load of the guest adds one, so the count is the number of frames
    // that have run it: one inlined, then one served.
    const context = new ContextShim({ a: 1 });
    const element = place(guest("a"), context, undefined);
    await waitForContextValue(context, element, "a", (value) => value === 2);
    const inlined = frameOf(element);
    const inlinedWindow = inlined.contentWindow;

    element.outerFrameUrl = OUTER_FRAME_URL;
    // The frame is replaced in the update this asks for, and a frame loads
    // no sooner than a task later. In between there is no guest, which is
    // what the element says.
    await element.updateComplete;
    assert(frameOf(element) !== inlined);
    assertEquals(element.loadState, "");
    assertEquals(element.accessForTestingOnly.readyWindow, undefined);

    await waitForContextValue(context, element, "a", (value) => value === 3);

    const served = frameOf(element);
    assert(served !== inlined);
    assert(!inlined.isConnected);
    assertEquals(served.getAttribute("src"), OUTER_FRAME_URL);
    assert(!served.hasAttribute("srcdoc"));
    assert(element.accessForTestingOnly.readyWindow === served.contentWindow);
    assert(element.accessForTestingOnly.readyWindow !== inlinedWindow);
    assertEquals(element.loadState, "loaded");
  } finally {
    cleanupFixtures();
  }
});

Deno.test("the outer frame's URL cannot be set from markup", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({ a: 1 });
    const element = place(guest("a"), context, undefined);
    element.setAttribute("outerframeurl", OUTER_FRAME_URL);
    element.setAttribute("outer-frame-url", OUTER_FRAME_URL);
    element.setAttribute("outerFrameUrl", OUTER_FRAME_URL);
    await waitForContextValue(context, element, "a", (value) => value === 2);
    await element.updateComplete;

    assertEquals(element.outerFrameUrl, undefined);
    assert(!frameOf(element).hasAttribute("src"));
  } finally {
    cleanupFixtures();
  }
});
