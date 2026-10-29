import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import "../src/common-iframe-sandbox.ts";
import {
  assert,
  assertDeepEquals,
  assertEquals,
  cleanupFixtures,
  ContextShim,
  deepEquals,
  render,
  waitForContextValue,
} from "./utils.ts";

// Each guest document is one module script: this prolog, the test's own body,
// and `GUEST_EPILOG`. The prolog names the guest API's operations as the body
// uses them, so a body reads as the guest code it is.
const GUEST_PROLOG = `<script type="module">
import { connectFabric, reportGuestError } from "/guest.js";

const report = (description, error) => reportGuestError({
  description,
  source: "guest test",
  lineno: 0,
  colno: 0,
  stacktrace: error?.stack ?? String(error ?? description),
});
window.addEventListener("error", (event) => report(event.message, event.error));
window.addEventListener("unhandledrejection", (event) =>
  report(String(event.reason), event.reason));

let onUpdate = (key, value) => {};
const fabric = connectFabric();
const cells = new Map();
const subscriptions = new Map();
const cell = (key) => {
  if (!cells.has(key)) cells.set(key, fabric.cell(key));
  return cells.get(key);
};
const pull = async (key) => onUpdate(key, await cell(key).pull());
const set = (key, value) => cell(key).set(value);
const sink = (key) => {
  subscriptions.get(key)?.();
  subscriptions.set(key, cell(key).sink((value) => onUpdate(key, value)));
};
const unsink = (key) => {
  subscriptions.get(key)?.();
  subscriptions.delete(key);
};
`;

const GUEST_EPILOG = `
</script>`;

Deno.test("pulls and sets", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({ a: 1 });

    const body = `${GUEST_PROLOG}
onUpdate = (key, value) => {
  if (key === "a" && value === 1) {
    set(key, value + 1);
  }
};
pull('a');
${GUEST_EPILOG}`;
    const iframe = await render(body, context);

    await waitForContextValue(context, iframe, "a", (value) => value === 2);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("subscribes", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({ a: 1 }, [
      "barrier",
      "barrier-seen",
      "ready",
      "unsubscribed",
      "updates",
    ]);

    // "barrier" stays subscribed after "a" is unsubscribed, so a write to it
    // can be used to mark a point in the update stream. It reports arrivals
    // under its own key to leave `updates` holding only what the test asserts
    // on.
    const body = `${GUEST_PROLOG}
const updates = [];
onUpdate = (key, value) => {
  if (key === "barrier") {
    set("barrier-seen", value);
    return;
  }
  updates.push([key, value]);
  set("updates", updates);
  if (key === "a" && value === 3) {
    unsink("a");
    set("unsubscribed", true);
  }
};
sink("a");
sink("barrier");
set("ready", true);
${GUEST_EPILOG}`;
    const iframe = await render(body, context);
    await waitForContextValue(
      context,
      iframe,
      "ready",
      (value) => value === true,
    );
    context.set(iframe, "b", 1);
    context.set(iframe, "a", 2);
    context.set(iframe, "a", 3);
    context.set(iframe, "b", 2);
    await waitForContextValue(
      context,
      iframe,
      "updates",
      (value) =>
        deepEquals(value, [
          ["a", undefined],
          ["a", 1],
          ["a", 2],
          ["a", 3],
        ]),
    );
    await waitForContextValue(
      context,
      iframe,
      "unsubscribed",
      (value) => value === true,
    );

    // Writes to "a" after the unsubscribe must not reach the guest. Write to
    // the still-subscribed "barrier" afterwards and wait for the guest to
    // report it: messages are delivered in order, so once the barrier has been
    // seen, an "a" update would already have arrived had one been sent.
    context.set(iframe, "a", 4);
    context.set(iframe, "a", 5);
    context.set(iframe, "barrier", 1);
    await waitForContextValue(
      context,
      iframe,
      "barrier-seen",
      (value) => value === 1,
    );
    assertDeepEquals(context.get(iframe, "updates"), [
      ["a", undefined],
      ["a", 1],
      ["a", 2],
      ["a", 3],
    ]);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("handles multiple iframes", async () => {
  cleanupFixtures();
  try {
    const context1 = new ContextShim({ a: 1 }, ["b"]);
    const context2 = new ContextShim({ b: 100 }, ["a"]);

    const body1 = `${GUEST_PROLOG}
set("b", 1);
${GUEST_EPILOG}`;

    const body2 = `${GUEST_PROLOG}
onUpdate = (key, value) => {
  if (key === "b" && value === 100) {
    set("a", 200);
  }
};
pull("b");
${GUEST_EPILOG}`;
    const iframe1 = await render(body1, context1);
    const iframe2 = await render(body2, context2);
    // Each frame writes one key: iframe1 writes "b" into context1, and iframe2
    // answers its read of "b" by writing "a" into context2. Waiting for both
    // writes puts each frame past the point where a write to the wrong context
    // would have happened, so the untouched keys can then be checked for the
    // value they started with.
    await waitForContextValue(context1, iframe1, "b", (value) => value === 1);
    await waitForContextValue(context2, iframe2, "a", (value) => value === 200);
    assertEquals(context1.get(iframe1, "a"), 1);
    assertEquals(context2.get(iframe2, "b"), 100);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("handles loading new documents", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({ a: 1 }, ["b", "c"]);

    const body1 = `${GUEST_PROLOG}
set("b", 1);
${GUEST_EPILOG}`;
    const body2 = `${GUEST_PROLOG}
set("c", 1);
${GUEST_EPILOG}`;
    const iframe = await render(body1, context);
    await waitForContextValue(context, iframe, "b", (value) => value === 1);
    iframe.src = body2;
    await waitForContextValue(context, iframe, "c", (value) => value === 1);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("loads the last document asked for when a second is asked for before the first has loaded", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({}, ["ran"]);
    const body = (label: string) =>
      `${GUEST_PROLOG}
set("ran", ${JSON.stringify(label)});
${GUEST_EPILOG}`;
    const iframe = await render(body("first"), context);
    await waitForContextValue(
      context,
      iframe,
      "ran",
      (value) => value === "first",
    );

    // Two documents asked for in one turn, so the second request reaches the
    // outer frame while the first is still loading. Whichever document loads
    // gets the port and writes its label, so the wait accepts either label
    // and the assertion names the right one, which fails a wrong document at
    // once rather than by the harness timeout.
    iframe.src = body("second");
    iframe.src = body("third");
    await waitForContextValue(
      context,
      iframe,
      "ran",
      (value) => value === "second" || value === "third",
    );
    assertEquals(context.get(iframe, "ran"), "third");
  } finally {
    cleanupFixtures();
  }
});

Deno.test("cancels subscriptions between documents", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({ a: 1 }, [
      "b",
      "got-a-update",
      "got-b-update",
      "ready1",
      "ready2",
    ]);

    const body1 = `${GUEST_PROLOG}
sink("a");
set("ready1", true);
${GUEST_EPILOG}`;
    const body2 = `${GUEST_PROLOG}
onUpdate = (key, value) => {
  if (key === "b") {
    set("got-b-update", true);
  }
  if (key === "a") {
    set("got-a-update", true);
  }
};
sink("b");
set("ready2", true);
${GUEST_EPILOG}`;
    const iframe = await render(body1, context);
    await waitForContextValue(
      context,
      iframe,
      "ready1",
      (value) => value === true,
    );
    iframe.src = body2;
    await waitForContextValue(
      context,
      iframe,
      "ready2",
      (value) => value === true,
    );
    // "a" is written first, so by the time the guest reports the "b" update it
    // subscribed to, an "a" update from the previous document's subscription
    // would already have arrived had it survived the load.
    context.set(iframe, "a", 1000);
    context.set(iframe, "b", 1000);
    await waitForContextValue(
      context,
      iframe,
      "got-b-update",
      (value) => value === true,
    );
    assertEquals(context.get(iframe, "got-a-update"), undefined);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("what a guest posts outside its port raises an alarm, not a write", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({}, ["after"]);
    const errors: string[] = [];
    const onError = (event: Event) =>
      errors.push((event as CustomEvent).detail.description);
    document.addEventListener("common-iframe-error", onError);

    // The first post is a protocol message sent the way a guest reaches its
    // parent rather than over its port. Nothing routes it there any more, so
    // it cannot become a write; it is an alarm whose contents are not an
    // error, and it is dropped. The second is the alarm a guest with no
    // working port has, which is the whole reason that route still exists.
    // The third is an ordinary write, and it lands last.
    const body = `${GUEST_PROLOG}
parent.postMessage({ type: "write", data: ["relayed", 1] }, "*");
parent.postMessage({ type: "error", data: {
  description: "raised without a port",
  source: "", lineno: 0, colno: 0, stacktrace: "",
} }, "*");
set("after", 1);
${GUEST_EPILOG}`;
    const iframe = await render(body, context);

    try {
      await waitForContextValue(
        context,
        iframe,
        "after",
        (value) => value === 1,
      );
      assertEquals(context.get(iframe, "relayed"), undefined);
      assertDeepEquals(errors, ["raised without a port"]);
    } finally {
      document.removeEventListener("common-iframe-error", onError);
    }
  } finally {
    cleanupFixtures();
  }
});

Deno.test("an alarm raised before a write is dispatched before the write lands", async () => {
  cleanupFixtures();

  // The alarm route and the port are separate channels. An alarm crosses two
  // window hops -- guest to outer frame, outer frame to host -- while port
  // traffic reaches the host directly, and no task ordering holds one channel
  // behind the other. The guarantee under test is the rendezvous that closes
  // that race: a guest taking its port posts a flush marker up the parent
  // chain, behind everything it posted there before, and holds its port
  // traffic until the host answers -- so by the time any port operation
  // lands, every earlier parent post has been handled. This test drives the
  // schedule the rendezvous exists for: every relayed guest message is
  // withheld, standing for a relay running behind the port, and released in
  // arrival order once the third arrives. The third is the marker, which is
  // the last thing the relay carries before port traffic can land.
  const held: MessageEvent[] = [];
  let releasing = false;
  const release = () => {
    releasing = true;
    for (const event of held.splice(0)) {
      globalThis.dispatchEvent(
        new MessageEvent("message", {
          data: event.data,
          source: event.source,
          origin: event.origin,
        }),
      );
    }
  };
  const withhold = (event: MessageEvent) => {
    if (releasing) return;
    const data = event.data as { type?: unknown } | null;
    if (!data || data.type !== "guest-error") return;
    event.stopImmediatePropagation();
    held.push(event);
    if (held.length >= 3) release();
  };
  // Registered before the element is, so it hears each message first and can
  // withhold it from the element.
  globalThis.addEventListener("message", withhold);
  try {
    const context = new ContextShim({}, ["after"]);
    const errors: string[] = [];
    const onError = (event: Event) =>
      errors.push((event as CustomEvent).detail.description);
    document.addEventListener("common-iframe-error", onError);
    try {
      // The same three posts as the test above: a dropped protocol message, an
      // alarm, a write. Here the write is only allowed to land after the
      // withheld relay is released, and the alarm must already have been
      // dispatched when it does.
      const body = `${GUEST_PROLOG}
parent.postMessage({ type: "write", data: ["relayed", 1] }, "*");
parent.postMessage({ type: "error", data: {
  description: "raised without a port",
  source: "", lineno: 0, colno: 0, stacktrace: "",
} }, "*");
set("after", 1);
${GUEST_EPILOG}`;
      const iframe = await render(body, context);
      await waitForContextValue(
        context,
        iframe,
        "after",
        (value) => value === 1,
      );
      assertEquals(context.get(iframe, "relayed"), undefined);
      assertDeepEquals(errors, ["raised without a port"]);
    } finally {
      document.removeEventListener("common-iframe-error", onError);
    }
  } finally {
    globalThis.removeEventListener("message", withhold);
    cleanupFixtures();
  }
});

Deno.test("a reattached element loads its document into the frame it gets", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({}, ["ran"]);
    const body = `${GUEST_PROLOG}
set("ran", 1);
${GUEST_EPILOG}`;
    const iframe = await render(body, context);
    await waitForContextValue(context, iframe, "ran", (value) => value === 1);

    // Detaching destroys the frame the element rendered, and reattaching gets
    // it a new one -- which reports itself ready, as the first one did. The
    // teardown lands on a later task than the removal, so the two have to be
    // told apart by a turn of the event loop rather than by adjacency.
    const parent = iframe.parentElement!;
    context.set(iframe, "ran", undefined);
    parent.remove();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    document.body.appendChild(parent);

    // The guest in the new frame runs the same document, so its write is what
    // says the element found its way back rather than going quietly mute.
    await waitForContextValue(context, iframe, "ran", (value) => value === 1);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("same-task reparenting keeps the bridge host alive", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({}, ["ready", "seen", "value"]);
    const body = `${GUEST_PROLOG}
onUpdate = (key, value) => {
  if (key === "value") set("seen", value);
};
sink("value");
set("ready", true);
${GUEST_EPILOG}`;
    const iframe = await render(body, context);
    await waitForContextValue(
      context,
      iframe,
      "ready",
      (value) => value === true,
    );
    assertEquals(context.callbacks.length, 1);
    const newParent = document.createElement("div");
    iframe.parentElement!.append(newParent);
    newParent.append(iframe);
    await Promise.resolve();
    assertEquals(context.callbacks.length, 1);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("a second ready from the frame already in hand is refused", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({}, ["ran"]);
    const body = `${GUEST_PROLOG}
set("ran", 1);
${GUEST_EPILOG}`;
    const iframe = await render(body, context);
    await waitForContextValue(context, iframe, "ran", (value) => value === 1);

    // Reached into rather than driven, because the outer frame reports itself
    // ready once and nothing outside it can send that message: the element
    // takes it only from the window it rendered. So the refusal is asserted
    // where it is made.
    const inner = iframe.accessForTestingOnly;
    const reporting = inner.iframeRef.value!.contentWindow!;
    assertEquals(inner.readyWindow, reporting);

    let refusal = "";
    try {
      inner.onOuterReady(reporting);
    } catch (error) {
      refusal = String(error);
    }
    assert(refusal.includes("Already initialized"));
  } finally {
    cleanupFixtures();
  }
});

Deno.test("a repeated load report does not unseat the guest holding its port", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({ watched: 1 }, ["ready", "echo"]);
    const body = `${GUEST_PROLOG}
onUpdate = (key, value) => {
  if (key === "watched" && value === 2) set("echo", 2);
};
sink("watched");
set("ready", true);
${GUEST_EPILOG}`;
    const iframe = await render(body, context);
    await waitForContextValue(
      context,
      iframe,
      "ready",
      (value) => value === true,
    );
    assertEquals(context.callbacks.length, 1);

    // The outer frame reports a load per completed navigation of its inner
    // frame, and it cannot tell whose navigation a load event was: the
    // initial `about:blank` one can complete after a document was asked for,
    // in which case one asked-for document yields two reports. The element
    // offers a fresh port on each report, and a session is retired only once
    // a successor shows activity -- so a guest refusing the extra offer keeps
    // the session it has, subscriptions included. The repeat is synthesized,
    // as the real one turns on navigation timing inside the frame.
    const inner = iframe.accessForTestingOnly;
    globalThis.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "load" },
        source: inner.iframeRef.value!.contentWindow!,
        origin: "null",
      }),
    );
    assertEquals(context.callbacks.length, 1);

    // The subscription staying registered is half of it; the guest writing
    // through the port it kept is the other half.
    context.set(iframe, "watched", 2);
    await waitForContextValue(
      context,
      iframe,
      "echo",
      (value) => value === 2,
    );
  } finally {
    cleanupFixtures();
  }
});

Deno.test("a guest that starts listening after its handoff went by still gets a port", async () => {
  cleanupFixtures();
  try {
    // The host hands a port over once the guest's document has loaded, and
    // module scripts can still be running then. This guest makes that
    // certain: a classic script, which runs while the document is parsed,
    // waits for the handoff to go by, and only then does the guest connect.
    const context = new ContextShim({ a: 1 });
    const body = `<script>
globalThis.handedOff = new Promise((resolve) =>
  addEventListener("message", (event) => {
    if (event.data === "common-iframe-sandbox:port") resolve();
  }));
</script>
<script type="module">
import { connectFabric } from "/guest.js";
await globalThis.handedOff;
const cell = connectFabric().cell("a");
cell.set((await cell.pull()) + 1);
</script>`;
    const iframe = await render(body, context);
    await waitForContextValue(context, iframe, "a", (value) => value === 2);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("an element that gets a frame and has no source says nothing is loaded", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({}, ["ran"]);
    const body = `${GUEST_PROLOG}
set("ran", 1);
${GUEST_EPILOG}`;
    const iframe = await render(body, context);
    await waitForContextValue(context, iframe, "ran", (value) => value === 1);

    // Driven rather than staged, for the reason the refusal test gives: a
    // frame reports itself ready once, and the report cannot be sent from
    // anywhere else. A window this element has not seen stands for the frame a
    // reattach would bring.
    const inner = iframe.accessForTestingOnly;
    iframe.src = "";
    inner.onOuterReady({} as Window);
    assertEquals(iframe.loadState, "");
  } finally {
    cleanupFixtures();
  }
});

Deno.test("a subscription is cancelled against the bridge that issued it", async () => {
  cleanupFixtures();
  try {
    const first = new ContextShim({ watched: 1 }, ["ready"]);
    const body = `${GUEST_PROLOG}
sink("watched");
set("ready", true);
${GUEST_EPILOG}`;
    const iframe = await render(body, first);
    await waitForContextValue(
      first,
      iframe,
      "ready",
      (value) => value === true,
    );
    assertEquals(first.callbacks.length, 1);

    // A subscription belongs to one bridge session, and `bridge` is a property
    // a consumer may reassign. Swapping it here and then asking for a new
    // document distinguishes cancelling the old session from touching the new
    // bridge.
    const second = new ContextShim({}, ["second-ran"]);
    iframe.bridge = second.bridge;
    iframe.src = `${GUEST_PROLOG}
set("second-ran", true);
${GUEST_EPILOG}`;

    await waitForContextValue(
      second,
      iframe,
      "second-ran",
      (value) => value === true,
    );
    assertEquals(first.callbacks.length, 0);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("carries a value structured cloning would flatten", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({
      payload: new FabricBytes(new Uint8Array([1, 2, 3])),
    }, ["bytes-seen", "echo"]);

    // The guest reports the bytes it can read out of what arrived, and echoes
    // the value back. Reading them takes a live `FabricBytes`, which is what
    // separates a value that crossed whole from one structured cloning
    // stripped to a bare object; the echo asks the same of the other
    // direction. The report names the flattened case rather than throwing on
    // it, so that case fails an assertion instead of going silent.
    const body = `${GUEST_PROLOG}
onUpdate = (key, value) => {
  if (key !== "payload") return;
  set("bytes-seen", typeof value?.slice === "function"
    ? [...value.slice()]
    : "not a FabricBytes");
  set("echo", value);
};
pull("payload");
${GUEST_EPILOG}`;
    const iframe = await render(body, context);

    // `echo` is written last and writes arrive in order, so waiting on its
    // arrival puts both reports in hand. Waiting on arrival rather than on the
    // class leaves a value that crossed flattened to fail an assertion below
    // rather than never satisfy the wait.
    await waitForContextValue(
      context,
      iframe,
      "echo",
      (value) => value !== undefined,
    );
    assertDeepEquals(context.get(iframe, "bytes-seen"), [1, 2, 3]);
    assert(context.get(iframe, "echo") instanceof FabricBytes);
  } finally {
    cleanupFixtures();
  }
});
