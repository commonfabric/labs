/**
 * What a DOM event costs to reach its handler, main thread to worker.
 *
 * Every `on*` a pattern puts on a rendered node installs a listener that runs
 * `serializeEvent()` and posts what it returns, so this is the inbound half of
 * the connection and the busiest one a user drives: it runs on every keystroke
 * an input reports and every click a handler is bound to.
 *
 * Nothing else measures it. `data-model`'s IPC benchmarks time the encoding
 * across a boundary with no application walk on either side; `html`'s reconciler
 * benchmark times the outbound render. What this adds is the walk at each end --
 * `serializeEvent()` before the send, and the decode plus the ingress strip
 * after it -- around the same crossing.
 *
 * One message is in flight at a time. That is what a `Deno.bench()` iteration
 * can measure, an iteration being one round trip, and it is the shape a DOM
 * event actually takes.
 *
 * **What this can and cannot resolve.** A round trip through a real `Worker`
 * costs about 12us before any payload, and run-to-run variance on that floor
 * runs to a fifth of the measurement. A subject sitting near it therefore
 * cannot separate a change worth a microsecond or two, and adding runs does not
 * help -- the spread is scheduling variance rather than sampling error, and
 * holds steady from three runs to six. The `200 records` subject is here
 * because it sits far enough above the floor to resolve one; the small subjects
 * are here to show what a change does *not* reach, which is most of what a user
 * generates. Attribute a difference to a phase before believing it: measure the
 * phase directly and check the trip moved by about what that predicts.
 *
 * Run with:
 *
 *     deno task bench
 */

import { BenchWorker } from "@commonfabric/test-support/bench-worker";

import type { FabricValue } from "@commonfabric/data-model";
import { realmFromFabricValue } from "@commonfabric/data-model/codecs";

import { serializeEvent } from "../src/main/events.ts";
import type { EventRequest } from "./fixtures/dom-event-far-side.ts";
const farSide = new BenchWorker<EventRequest>(
  import.meta.resolve("./fixtures/dom-event-far-side.ts"),
);

/** An event, as the applicator's listener receives one. */
class BenchEvent {
  isTrusted = false;
  constructor(readonly type: string, readonly target: unknown) {}
}

/** A custom event, whose `detail` is whatever a component chose to expose. */
class BenchCustomEvent extends BenchEvent {
  constructor(type: string, readonly detail: unknown, target: unknown = {}) {
    super(type, target);
  }
}

/** A detail of `items` records, each with a few scalar fields. */
function makeDetail(items: number): unknown {
  const list: unknown[] = [];

  for (let i = 0; i < items; i++) {
    list.push({ title: `item number ${i}`, count: i, done: (i % 3) === 0 });
  }

  return { items: list, total: items };
}

/**
 * A spread of the shapes a handler is actually bound to: a bare click, the
 * input event a keystroke produces, and a custom detail at two sizes.
 */
const SUBJECTS: readonly (readonly [string, BenchEvent])[] = [
  ["click", new BenchEvent("click", { value: "" })],
  [
    "input keystroke",
    new BenchEvent("input", { value: "hello world", name: "title" }),
  ],
  ["detail, 10 records", new BenchCustomEvent("cf-change", makeDetail(10))],
  ["detail, 200 records", new BenchCustomEvent("cf-change", makeDetail(200))],
];

for (const [name, event] of SUBJECTS) {
  Deno.bench({ name, group: name }, async () => {
    // Everything the main thread does for one event: the seam, then the
    // transport's encode, then the post.
    const serialized = serializeEvent(event as unknown as Event);
    const message = {
      type: "dom-event",
      handlerId: 1,
      nodeId: 1,
      event: serialized,
    } as unknown as FabricValue;

    await farSide.send({ payload: realmFromFabricValue(message) });
  });
}

globalThis.addEventListener("unload", () => farSide.close());
