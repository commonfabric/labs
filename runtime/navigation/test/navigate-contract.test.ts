import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import type { DID } from "@commonfabric/identity";
import {
  navigate,
  replaceNavigation,
  updatePageTitle,
} from "@commonfabric/navigation";

// Host-embedding contract seam 3 (docs/features/host-embedding.md §3): a host
// embeds by listening on `globalThis` for the navigation CustomEvents these
// helpers dispatch. The contract an embedder binds to is the event *name* and
// the detail *shape* — both are asserted here so a rename or a detail reshape
// fails CI upstream in labs rather than silently in an embedder.
//
// The component-side `cf-navigate` detail is an `AppView` (spaceName|spaceDid +
// optional pieceId/pieceSlug/mode). The pattern-side `cf-navigate` emitter
// (`defaultNavigate` in runtime/lib-shell) produces `{spaceDid, pieceId}` and
// is already guarded by runtime/shell/test/runtime-navigation.test.ts.
//
// The cancellable `cf-open-external` new-tab hook is covered by its own file,
// navigate.test.ts, which exercises the cancellation contract end to end.

const spaceDid = "did:key:z6Mk-host-embedding-navigate-contract" as DID;

const listeners: Array<[string, EventListener]> = [];
function once(name: string): Promise<CustomEvent> {
  return new Promise((resolve) => {
    const handler = ((event: Event) => {
      globalThis.removeEventListener(name, handler);
      resolve(event as CustomEvent);
    }) as EventListener;
    listeners.push([name, handler]);
    globalThis.addEventListener(name, handler);
  });
}

afterEach(() => {
  for (const [name, handler] of listeners.splice(0)) {
    globalThis.removeEventListener(name, handler);
  }
});

describe("host embedding contract: navigation events", () => {
  it("navigate() dispatches 'cf-navigate' on globalThis with the AppView detail", async () => {
    const received = once("cf-navigate");
    const view = { spaceDid, pieceId: "piece-abc" };
    navigate(view);
    const event = await received;
    expect(event.type).toBe("cf-navigate");
    expect(event.detail).toEqual(view);
    // Dispatched on globalThis, not bubbled from the DOM.
    expect(event.bubbles).toBe(false);
    expect(event.composed).toBe(false);
  });

  it("navigate() carries the spaceName AppView variant faithfully", async () => {
    const received = once("cf-navigate");
    const view = { spaceName: "common-knowledge", pieceSlug: "demo" };
    navigate(view);
    const event = await received;
    expect(event.detail).toEqual(view);
  });

  it("replaceNavigation() dispatches 'cf-replace-navigation' with the AppView detail", async () => {
    const received = once("cf-replace-navigation");
    const view = { builtin: "home" } as const;
    replaceNavigation(view);
    const event = await received;
    expect(event.type).toBe("cf-replace-navigation");
    expect(event.detail).toEqual(view);
  });

  it("updatePageTitle() dispatches 'cf-update-page-title' with a string detail", async () => {
    const received = once("cf-update-page-title");
    updatePageTitle("My Profile");
    const event = await received;
    expect(event.type).toBe("cf-update-page-title");
    expect(event.detail).toBe("My Profile");
  });
});
