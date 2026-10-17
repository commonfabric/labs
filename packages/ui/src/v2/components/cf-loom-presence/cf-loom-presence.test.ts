import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { nothing } from "lit";
import type { DID } from "@commonfabric/identity";
import {
  type CellHandle,
  type PresenceEvent,
  type PresenceRecord,
  type PresenceRoomHandle,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import { CFLoomPresence } from "./index.ts";

const SPACE = "did:key:z6Mk-loom-space" as DID;
const SELF = "did:key:z6Mk-ada" as DID;

const peer = (
  overrides: Partial<PresenceRecord> & { participantId: string },
): PresenceRecord => ({
  principal: "did:key:z6Mk-bob",
  revision: 1,
  name: "Bob",
  facets: {},
  ...overrides,
});

/** A room handle that records what the element does to it. */
class FakePresenceHandle implements PresenceRoomHandle {
  participantId = "participant:self";
  participants: PresenceRecord[] = [];
  readonly room = "room-0123456789abcdefghijklmnop";
  readonly names: string[] = [];
  leaves = 0;
  readonly #listeners = new Set<(event: PresenceEvent) => void>();

  setName(name: string): void {
    this.names.push(name);
  }

  setFacet(): void {}

  clearFacet(): void {}

  setFocused(): void {}

  subscribe(listener: (event: PresenceEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  leave(): Promise<void> {
    this.leaves++;
    return Promise.resolve();
  }

  /** Applies `participants` as the room's and delivers `event` for it. */
  deliver(participants: PresenceRecord[], event: PresenceEvent): void {
    this.participants = participants;
    for (const listener of [...this.#listeners]) listener(event);
  }
}

type Join = { cause: unknown; anchor: CellHandle };

/**
 * A runtime that derives the anchor and joins its room, recording each
 * derivation, and refusing the first `refusals` joins with `refusal`.
 */
const fakeRuntime = (
  options: { refusals?: number; refusal?: Error } = {},
) => {
  const handles: FakePresenceHandle[] = [];
  const joins: Join[] = [];
  let refusals = options.refusals ?? 0;
  const anchor = {
    ref: () => ({ space: SPACE, id: "of:anchor", path: [] }),
  } as unknown as CellHandle;
  const runtime = {
    getCell: (space: DID, cause: unknown) => {
      expect(space).toBe(SPACE);
      joins.push({ cause, anchor });
      return Promise.resolve(anchor);
    },
    joinPresenceRoom: (cell: CellHandle) => {
      expect(cell).toBe(anchor);
      if (refusals > 0) {
        refusals--;
        return Promise.reject(options.refusal ?? new Error("socket closed"));
      }
      const handle = new FakePresenceHandle();
      handles.push(handle);
      return Promise.resolve(handle);
    },
    actingPrincipalDid: () => SELF,
  } as unknown as RuntimeClient;
  return { runtime, handles, joins };
};

/** A cell in the Loom's space whose value changes a test can deliver. */
const fakeCell = (runtime: RuntimeClient) => {
  const subscribers = new Set<() => void>();
  const cell = {
    runtime: () => runtime,
    space: () => SPACE,
    subscribe: (callback: () => void) => {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  } as unknown as CellHandle;
  return {
    cell,
    change: () => {
      for (const callback of [...subscribers]) callback();
    },
  };
};

/** Lets a join settle: the derivation, then the join, then the handle. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** Tells the element `property` changed, as Lit does before an update. */
const changed = (el: CFLoomPresence, property: "cell" | "name") =>
  el.accessForTestingOnly.willUpdate(new Map([[property, undefined]]));

/**
 * A connected element bound to `cell`, with the events it fires recorded.
 * Deno has no document for Lit to make a render root in, so the element is
 * marked connected and told of its binding the way Lit tells it before its
 * first update, rather than through `connectedCallback()`.
 */
const mount = (cell: CellHandle, name = "") => {
  const el = new CFLoomPresence();
  const events: string[] = [];
  const categories: string[] = [];
  el.addEventListener("cf-presence-join", () => events.push("join"));
  el.addEventListener("cf-presence-error", (event) => {
    events.push("error");
    categories.push(
      (event as CustomEvent<{ category: string }>).detail.category,
    );
  });
  Object.defineProperty(el, "isConnected", { configurable: true, value: true });
  el.cell = cell;
  el.name = name;
  changed(el, "cell");
  return { el, events, categories };
};

const rendered = (el: CFLoomPresence) => JSON.stringify(el.render());

describe("CFLoomPresence", () => {
  it("registers the custom element", () => {
    expect(customElements.get("cf-loom-presence")).toBe(CFLoomPresence);
  });

  it("joins the Loom's room of the bound cell's space and publishes the viewer's name", async () => {
    const { runtime, handles, joins } = fakeRuntime();
    const { el, events } = mount(fakeCell(runtime).cell, "Ada");
    await settle();
    expect(joins.map(({ cause }) => cause)).toEqual([{ loomPresence: SPACE }]);
    expect(handles[0].names).toEqual(["Ada"]);
    expect(events).toEqual(["join"]);
    el.disconnectedCallback();
  });

  it("publishes no name while the viewer has none", async () => {
    const { runtime, handles } = fakeRuntime();
    const { el } = mount(fakeCell(runtime).cell);
    await settle();
    expect(handles[0].names).toEqual([]);
    el.disconnectedCallback();
  });

  it("publishes the name again when it changes", async () => {
    const { runtime, handles } = fakeRuntime();
    const { el } = mount(fakeCell(runtime).cell, "Ada");
    await settle();
    el.name = "Ada Lovelace";
    changed(el, "name");
    expect(handles[0].names).toEqual(["Ada", "Ada Lovelace"]);
    el.disconnectedCallback();
  });

  it("shows the others present, one per principal, as they come and go", async () => {
    const { runtime, handles } = fakeRuntime();
    const { el } = mount(fakeCell(runtime).cell, "Ada");
    await settle();
    expect(el.render()).toBe(nothing);
    const handle = handles[0];
    const bob = peer({ participantId: "p-bob" });
    const bobAgain = peer({ participantId: "p-bob-phone", revision: 3 });
    const self = peer({
      participantId: "p-ada-phone",
      principal: SELF,
      name: "Ada",
    });
    const carol = peer({
      participantId: "p-carol",
      principal: "did:key:z6Mk-carol",
      name: "Carol",
    });
    handle.deliver([bob, bobAgain, self], {
      kind: "upsert",
      participant: bobAgain,
    });
    let html = rendered(el);
    // Bob holds the room through two sessions and shows once.
    expect(html.split('"Bob"').length - 1).toBe(1);
    expect(html).not.toContain("Ada");
    handle.deliver([bob, bobAgain, self, carol], {
      kind: "upsert",
      participant: carol,
    });
    html = rendered(el);
    expect(html).toContain("Bob");
    expect(html).toContain("Carol");
    handle.deliver([self, carol], { kind: "remove", participantId: "p-bob" });
    html = rendered(el);
    expect(html).not.toContain("Bob");
    expect(html).toContain("Carol");
    el.disconnectedCallback();
  });

  it("renders nothing while nobody else is present", async () => {
    const { runtime, handles } = fakeRuntime();
    const { el } = mount(fakeCell(runtime).cell, "Ada");
    await settle();
    handles[0].deliver([peer({ participantId: "p-ada", principal: SELF })], {
      kind: "snapshot",
      participantId: "participant:self",
      participants: [],
    });
    expect(el.render()).toBe(nothing);
    el.disconnectedCallback();
  });

  it("leaves the room when disconnected", async () => {
    const { runtime, handles } = fakeRuntime();
    const { el } = mount(fakeCell(runtime).cell, "Ada");
    await settle();
    el.disconnectedCallback();
    expect(handles[0].leaves).toBe(1);
  });

  it("lets a join that lands after a disconnect go", async () => {
    const { runtime, handles } = fakeRuntime();
    const { el, events } = mount(fakeCell(runtime).cell, "Ada");
    el.disconnectedCallback();
    await settle();
    expect(handles[0].leaves).toBe(1);
    expect(events).toEqual([]);
  });

  it("reports a refused join once, and asks again on the next change", async () => {
    const { runtime, handles } = fakeRuntime({ refusals: 1 });
    const { cell, change } = fakeCell(runtime);
    const { el, events, categories } = mount(cell, "Ada");
    await settle();
    expect(events).toEqual(["error"]);
    expect(categories).toEqual(["connection"]);
    expect(handles).toHaveLength(0);
    change();
    await settle();
    expect(events).toEqual(["error", "join"]);
    expect(handles[0].names).toEqual(["Ada"]);
    el.disconnectedCallback();
  });

  it("asks again on a name change after a refused join", async () => {
    const { runtime, handles } = fakeRuntime({ refusals: 1 });
    const { el, events } = mount(fakeCell(runtime).cell, "Ada");
    await settle();
    el.name = "Ada Lovelace";
    changed(el, "name");
    await settle();
    expect(events).toEqual(["error", "join"]);
    expect(handles[0].names).toEqual(["Ada Lovelace"]);
    el.disconnectedCallback();
  });

  it("does not ask again after a configuration failure until the cell changes", async () => {
    const { runtime, handles, joins } = fakeRuntime({
      refusals: 1,
      refusal: new Error("The runtime's storage does not support presence"),
    });
    const { cell, change } = fakeCell(runtime);
    const { el, events, categories } = mount(cell, "Ada");
    await settle();
    expect(categories).toEqual(["configuration"]);
    change();
    el.name = "Ada Lovelace";
    changed(el, "name");
    await settle();
    expect(joins).toHaveLength(1);
    expect(events).toEqual(["error"]);
    el.cell = fakeCell(runtime).cell;
    changed(el, "cell");
    await settle();
    expect(events).toEqual(["error", "join"]);
    expect(handles).toHaveLength(1);
    el.disconnectedCallback();
  });

  it("drops the roster and reports the room's failure, then joins again on the next change", async () => {
    const { runtime, handles } = fakeRuntime();
    const { cell, change } = fakeCell(runtime);
    const { el, events, categories } = mount(cell, "Ada");
    await settle();
    const handle = handles[0];
    handle.deliver([peer({ participantId: "p-bob" })], {
      kind: "upsert",
      participant: peer({ participantId: "p-bob" }),
    });
    expect(rendered(el)).toContain("Bob");
    handle.deliver([], {
      kind: "failure",
      error: Object.assign(new Error("refused"), { name: "PresenceError" }),
    });
    expect(rendered(el)).not.toContain("Bob");
    expect(events).toEqual(["join", "error"]);
    expect(categories).toEqual(["protocol"]);
    expect(handle.leaves).toBe(1);
    change();
    await settle();
    expect(events).toEqual(["join", "error", "join"]);
    expect(handles).toHaveLength(2);
    el.disconnectedCallback();
  });

  it("leaves one room and joins another when the bound cell changes", async () => {
    const { runtime, handles } = fakeRuntime();
    const { el } = mount(fakeCell(runtime).cell, "Ada");
    await settle();
    el.cell = fakeCell(runtime).cell;
    changed(el, "cell");
    await settle();
    expect(handles).toHaveLength(2);
    expect(handles[0].leaves).toBe(1);
    expect(handles[1].leaves).toBe(0);
    el.disconnectedCallback();
    expect(handles[1].leaves).toBe(1);
  });
});
