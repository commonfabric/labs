/**
 * Reports, from a realm of its own, what `value-debug-internal.ts` does there:
 * optionally loads one module first, as the first of this package the realm
 * evaluates beyond that module and the root class, and then says whether the
 * debug renderers are installed, what each forwarder returned or threw, and
 * how an instance of the root class inspects. A worker is what gives each
 * request a realm in which nothing else has been evaluated.
 *
 * Not a `*.test.ts` file, so the runner does not pick it up as a suite.
 */

import { BaseFabricSpecialObject } from "@/fabric-bases/BaseFabricSpecialObject.ts";
import * as internal from "@/value-debug-internal.ts";

/** What a test asks of the worker. */
export type InternalRequest = {
  /** The module to load before reporting, as a URL, or `null` for none. */
  load: string | null;
};

/** What one forwarder did when called. */
export type ForwarderOutcome = { returned: unknown } | { threw: string };

/** What the worker reports back. */
export type InternalReport = {
  /** Whether the debug renderers were installed. */
  installed: boolean;

  /** What each forwarder did, by name. */
  forwarders: Record<string, ForwarderOutcome>;

  /** What `Deno.inspect()` makes of an instance of the root class. */
  inspected: string;
} | {
  /** The failure message, when the load threw. */
  error: string;
};

/** A concrete subclass of the root class, to have something to inspect. */
class Probe extends BaseFabricSpecialObject {}

/**
 * Every renderer the module forwards, each called with the arguments
 * `FORWARDER_ARGUMENTS` in the test file calls the real one with.
 */
const FORWARDER_CALLS: Readonly<Record<string, () => unknown>> = {
  debugStr: () => internal.debugStr`a value: $quote${[1, 2]}`,
  toCompactDebugString: () => internal.toCompactDebugString({ a: 1 }),
  toDebugKindString: () => internal.toDebugKindString([1]),
  toIndentedDebugString: () => internal.toIndentedDebugString({ a: [1] }),
  toLongQuotedDebugString: () => internal.toLongQuotedDebugString("x"),
  toShortQuotedDebugString: () => internal.toShortQuotedDebugString("x"),
  toStructuredDebugValue: () => internal.toStructuredDebugValue(new Map()),
};

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<InternalRequest>) => void) | null;
  postMessage(report: InternalReport): void;
};

scope.onmessage = async (ev) => {
  try {
    if (ev.data.load !== null) {
      // The load is the thing under test, and which module it is arrives in
      // the message.
      await import(ev.data.load);
    }

    const forwarders: Record<string, ForwarderOutcome> = {};
    for (const [name, call] of Object.entries(FORWARDER_CALLS)) {
      try {
        forwarders[name] = { returned: call() };
      } catch (e) {
        forwarders[name] = {
          threw: e instanceof Error ? e.message : String(e),
        };
      }
    }

    scope.postMessage({
      installed: internal.areDebugRenderersInstalled(),
      forwarders,
      inspected: Deno.inspect(new Probe()),
    });
  } catch (e) {
    scope.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};
