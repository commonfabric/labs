// deno-lint-ignore-file cf-imports/no-inline-module-import -- the service
// worker registers its handlers on `self` as it loads, so it can only load once
// the test has put a stand-in there.

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

/** What the service worker did to its global scope as it ran. */
const calls: string[] = [];

/** The handlers it registered, by event type. */
const handlers = new Map<string, (event: unknown) => unknown>();

describe("sw", () => {
  // The handlers read `self` when they run, so the stand-in stays in place
  // until every case is done.
  const original = Object.getOwnPropertyDescriptor(globalThis, "self");
  beforeAll(async () => {
    Object.defineProperty(globalThis, "self", {
      configurable: true,
      value: {
        addEventListener: (type: string, handler: (event: unknown) => void) => {
          handlers.set(type, handler);
        },
        skipWaiting: () => {
          calls.push("skipWaiting()");
          return Promise.resolve();
        },
        clients: {
          claim: () => {
            calls.push("clients.claim()");
            return "claimed";
          },
        },
      },
    });
    await import("../public/sw.js");
  });
  afterAll(() => {
    if (original) Object.defineProperty(globalThis, "self", original);
  });

  it("registers handlers for exactly `install`, `activate` and `fetch`", () => {
    expect([...handlers.keys()].sort()).toEqual([
      "activate",
      "fetch",
      "install",
    ]);
  });

  it("skips waiting on `install`, so a new worker takes over at once", () => {
    calls.length = 0;

    handlers.get("install")!({});

    expect(calls).toEqual(["skipWaiting()"]);
  });

  it("claims the open pages on `activate`, holding the event until it is done", () => {
    calls.length = 0;
    const waitedOn: unknown[] = [];

    handlers.get("activate")!({
      waitUntil: (work: unknown) => waitedOn.push(work),
    });

    expect(calls).toEqual(["clients.claim()"]);
    expect(waitedOn).toEqual(["claimed"]);
  });

  it("leaves every fetch to the network, responding to none", () => {
    calls.length = 0;
    const responses: unknown[] = [];

    handlers.get("fetch")!({ respondWith: (r: unknown) => responses.push(r) });

    expect(responses).toEqual([]);
    expect(calls).toEqual([]);
  });
});
