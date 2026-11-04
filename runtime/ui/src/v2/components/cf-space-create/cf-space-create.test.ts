import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import { CFSpaceCreate } from "./cf-space-create.ts";

const SPACE = "did:key:z6MkCreatedSpace";

/** A component whose state changes schedule no Lit update. */
function newCreator(
  createSpace: (label?: string) => Promise<string>,
): { creator: CFSpaceCreate; events: unknown[] } {
  const creator = new CFSpaceCreate();
  (creator as unknown as { performUpdate(): void }).performUpdate = () => {};
  creator.runtime = { createSpace } as unknown as RuntimeClient;
  const events: unknown[] = [];
  creator.addEventListener(
    "cf-space-created",
    (event) => events.push((event as CustomEvent).detail),
  );
  return { creator, events };
}

describe("cf-space-create", () => {
  it("creates a space labeled with the trimmed text and reports its DID", async () => {
    const labels: (string | undefined)[] = [];
    const { creator, events } = newCreator((label) => {
      labels.push(label);
      return Promise.resolve(SPACE);
    });

    await creator.create("  Team lunch  ");

    expect(labels).toEqual(["Team lunch"]);
    expect(events).toEqual([{ did: SPACE, label: "Team lunch" }]);
    expect(creator.error).toBeUndefined();
    expect(creator.pending).toBe(false);
  });

  it("creates a space from its label input's `cf-send` and stops that event there", () => {
    const labels: (string | undefined)[] = [];
    const { creator } = newCreator((label) => {
      labels.push(label);
      return Promise.resolve(SPACE);
    });
    const template = creator.render();
    const handler = template.values[
      template.strings.findIndex((part) => part.endsWith('@cf-send="'))
    ];
    const send = new CustomEvent("cf-send", {
      detail: { message: "Team lunch" },
      bubbles: true,
      composed: true,
    });

    expect(typeof handler).toBe("function");
    if (typeof handler === "function") handler.call(creator, send);

    expect(send.cancelBubble).toBe(true);
    expect(labels).toEqual(["Team lunch"]);
  });

  it("creates nothing for blank text", async () => {
    let calls = 0;
    const { creator, events } = newCreator(() => {
      calls++;
      return Promise.resolve(SPACE);
    });

    await creator.create("   ");

    expect(calls).toBe(0);
    expect(events).toEqual([]);
  });

  it("shows the failure and reports no space when creation fails", async () => {
    const { creator, events } = newCreator(() =>
      Promise.reject(new Error("genesis refused"))
    );

    await creator.create("Team lunch");

    expect(creator.error).toBe("genesis refused");
    expect(events).toEqual([]);
    expect(creator.pending).toBe(false);
  });

  it("creates one space while a creation is pending", async () => {
    const release = Promise.withResolvers<string>();
    let calls = 0;
    const { creator, events } = newCreator(() => {
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
