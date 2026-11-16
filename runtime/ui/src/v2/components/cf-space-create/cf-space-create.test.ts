// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import { CFSpaceCreate } from "./index.ts";

const SPACE = "did:key:z6MkCreatedSpace";

/** A runtime that creates spaces with `createSpace`, and offers nothing else. */
function runtimeCreatingWith(
  createSpace: RuntimeClient["createSpace"],
): RuntimeClient {
  const runtime: Partial<RuntimeClient> = { createSpace };
  return runtime as RuntimeClient;
}

/**
 * A mounted component that creates spaces with `createSpace`, and every
 * `cf-space-created` it fires.
 */
async function newCreator(
  createSpace: RuntimeClient["createSpace"],
): Promise<{ creator: CFSpaceCreate; events: unknown[] }> {
  const creator = new CFSpaceCreate();
  creator.runtime = runtimeCreatingWith(createSpace);
  const events: unknown[] = [];
  creator.addEventListener("cf-space-created", (event) => {
    if (event instanceof CustomEvent) events.push(event.detail);
  });
  return { creator: await mount(creator), events };
}

describe("cf-space-create", () => {
  afterEach(() => document.body.replaceChildren());

  it("creates a space labeled with the trimmed text and reports its DID", async () => {
    const labels: (string | undefined)[] = [];
    const { creator, events } = await newCreator((label) => {
      labels.push(label);
      return Promise.resolve(SPACE);
    });

    await creator.create("  Team lunch  ");

    expect(labels).toEqual(["Team lunch"]);
    expect(events).toEqual([{ did: SPACE, label: "Team lunch" }]);
    expect(creator.error).toBeUndefined();
    expect(creator.pending).toBe(false);
  });

  it("creates a space from its label input's `cf-send` and stops that event there", async () => {
    const labels: (string | undefined)[] = [];
    const { creator } = await newCreator((label) => {
      labels.push(label);
      return Promise.resolve(SPACE);
    });
    const escaped: Event[] = [];
    creator.addEventListener("cf-send", (event) => escaped.push(event));

    creator.shadowRoot!.querySelector("cf-message-input")!.dispatchEvent(
      new CustomEvent("cf-send", {
        detail: { message: "Team lunch" },
        bubbles: true,
        composed: true,
      }),
    );

    expect(labels).toEqual(["Team lunch"]);
    expect(escaped).toEqual([]);
  });

  it("creates nothing for blank text", async () => {
    let calls = 0;
    const { creator, events } = await newCreator(() => {
      calls++;
      return Promise.resolve(SPACE);
    });

    await creator.create("   ");

    expect(calls).toBe(0);
    expect(events).toEqual([]);
  });

  it("shows the failure and reports no space when creation fails", async () => {
    const { creator, events } = await newCreator(() =>
      Promise.reject(new Error("genesis refused"))
    );

    await creator.create("Team lunch");

    expect(creator.error).toBe("genesis refused");
    expect(events).toEqual([]);
    expect(creator.pending).toBe(false);
  });

  it("shows a failure in an alert, which it draws only after one", async () => {
    const { creator } = await newCreator(() =>
      Promise.reject(new Error("genesis refused"))
    );
    const alert = () => creator.shadowRoot!.querySelector('[role="alert"]');
    expect(alert()).toBe(null);

    await creator.create("Team lunch");
    await creator.updateComplete;
    expect(alert()?.textContent).toBe("genesis refused");
  });

  it("creates one space while a creation is pending", async () => {
    const release = Promise.withResolvers<typeof SPACE>();
    let calls = 0;
    const { creator, events } = await newCreator(() => {
      calls++;
      return release.promise;
    });

    const first = creator.create("One");
    await creator.create("Two");
    release.resolve(SPACE);
    await first;

    expect(calls).toBe(1);
    expect(events).toEqual([{ did: SPACE, label: "One" }]);
  });
});
