import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { SessionViewInterest } from "@commonfabric/memory/v2";

import { COMPONENT_READ_CONTRACT_VERSION } from "../src/component-read-contract.ts";
import { ViewPlanPublisher } from "../src/executor/view-plan-publisher.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import type { EventHandler } from "../src/scheduler/types.ts";
import { rendererVDOMSchema } from "../src/schemas.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { ViewExecutionNode } from "../src/view-replication.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("view plan invalidation");
const space = signer.did();

describe("view plan publisher", () => {
  let fixture: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    const root = runtime.getCell(space, "view", undefined);
    const output = runtime.getCell<number>(space, "output", { type: "number" });
    const input = runtime.getCell<number>(space, "input", { type: "number" });
    const hidden = runtime.getCell<number>(space, "hidden", { type: "number" });
    await runtime.editWithRetry((tx) => {
      input.withTx(tx).set(1);
      output.withTx(tx).set(2);
      hidden.withTx(tx).set(3);
      root.withTx(tx).set({
        $UI: { type: "vnode", name: "div", props: {}, children: [output] },
      });
    });
    await runtime.storageManager.synced();
    const interest: SessionViewInterest = {
      handle: {
        sessionId: "viewer",
        sessionEpoch: "session",
        viewEpoch: "view",
        viewId: "screen",
        revision: 0,
      },
      principal: signer.did(),
      attached: true,
      view: {
        id: "screen",
        revision: 0,
        mode: "speculate",
        componentContractVersion: COMPONENT_READ_CONTRACT_VERSION,
        query: {
          roots: [{
            id: root.getAsNormalizedFullLink().id,
            selector: { path: [] },
          }],
        },
      },
    };
    const nodes: ViewExecutionNode[] = [{
      id: "producer",
      kind: "computation",
      current: true,
      piece: root.getAsNormalizedFullLink(),
      writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      log: {
        reads: [toMemorySpaceAddress(input.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
    }];
    const interests = stub(server, "viewInterestsForSpace", () => [interest]);
    const observations = stub(
      runtime.scheduler,
      "viewExecutionNodes",
      () => nodes,
    );
    const publications = stub(
      server,
      "setViewSelection",
      () => Promise.resolve(true),
    );
    const reads = spy(runtime, "readTx");
    const links = spy(runtime, "getCellFromLink");
    return {
      server,
      runtime,
      root,
      output,
      input,
      hidden,
      interest,
      nodes,
      interests,
      observations,
      publications,
      reads,
      links,
      publisher: new ViewPlanPublisher(),
    };
  }

  beforeEach(async () => {
    fixture = await setup();
  });
  afterEach(async () => {
    fixture.publisher.dispose();
    fixture.reads.restore();
    fixture.links.restore();
    fixture.publications.restore();
    fixture.observations.restore();
    fixture.interests.restore();
    await fixture.runtime.storageManager.synced();
    await fixture.runtime.dispose();
    await fixture.server.close();
  });

  const publish = () =>
    fixture.publisher.publish(fixture.runtime, fixture.server, space);

  it("reuses the UI walk and certificates across quiet cycles and unrelated writes", async () => {
    await publish();
    const initialReads = fixture.reads.calls.length;
    expect(initialReads).toBeGreaterThan(0);
    await publish();
    expect(fixture.reads.calls).toHaveLength(initialReads);
    await fixture.runtime.editWithRetry((tx) =>
      fixture.hidden.withTx(tx).set(4)
    );
    const before = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls).toHaveLength(before);
    expect(fixture.publications.calls).toHaveLength(1);
  });

  it("refreshes producer currency without repeating the UI walk", async () => {
    await publish();
    expect(fixture.publications.calls.at(-1)!.args[2].producers?.[0].basis)
      .toBeDefined();
    fixture.nodes[0].current = false;
    const before = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls.length - before).toBe(1);
    expect(fixture.publications.calls.at(-1)!.args[2].producers?.[0].basis)
      .toBeUndefined();
  });

  it("refreshes fingerprints for upstream input changes while retaining the UI walk", async () => {
    await publish();
    const previous = fixture.publications.calls.at(-1)!.args[2].producers?.[0]
      .basis;
    await fixture.runtime.editWithRetry((tx) =>
      fixture.input.withTx(tx).set(5)
    );
    const before = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls.length - before).toBe(1);
    expect(fixture.publications.calls.at(-1)!.args[2].producers?.[0].basis).not
      .toEqual(previous);
  });

  it("incorporates a handler's new observations without repeating the UI walk", async () => {
    const stream = fixture.runtime.getCell<unknown>(space, "click", {
      asCell: ["stream"],
    });
    await fixture.runtime.editWithRetry((tx) => {
      fixture.root.withTx(tx).set({
        $UI: {
          type: "vnode",
          name: "button",
          props: { onClick: stream },
          children: [fixture.output],
        },
      });
    });
    await fixture.runtime.storageManager.synced();
    await publish();
    fixture.nodes.push({
      id: "click-handler",
      kind: "handler",
      piece: fixture.root.getAsNormalizedFullLink(),
      stream: stream.getAsNormalizedFullLink(),
      writes: [toMemorySpaceAddress(fixture.input.getAsNormalizedFullLink())],
      log: {
        reads: [toMemorySpaceAddress(fixture.hidden.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
    });
    const before = fixture.links.calls.length;
    await publish();
    expect(
      fixture.links.calls.slice(before).filter((call) =>
        call.args[1] === rendererVDOMSchema
      ),
    ).toHaveLength(0);
    const selection = fixture.publications.calls.at(-1)!.args[2];
    expect(selection.eligibleActions).toContain("click-handler");
    expect(selection.eligibleActions).toContain("producer");
    expect(selection.inputs?.map((input) => input.id)).toContain(
      fixture.hidden.getAsNormalizedFullLink().id,
    );
    fixture.nodes[1].log = { reads: [], shallowReads: [], writes: [] };
    await publish();
    expect(
      fixture.links.calls.slice(before).filter((call) =>
        call.args[1] === rendererVDOMSchema
      ),
    ).toHaveLength(0);
    expect(
      fixture.publications.calls.at(-1)!.args[2].inputs?.map((input) =>
        input.id
      ),
    )
      .not.toContain(fixture.hidden.getAsNormalizedFullLink().id);
  });

  it("retains invalidations received during publication and while disconnected", async () => {
    fixture.publications.restore();
    fixture.publications = stub(
      fixture.server,
      "setViewSelection",
      async () => {
        await fixture.runtime.editWithRetry((tx) =>
          fixture.input.withTx(tx).set(7)
        );
        return true;
      },
    );
    await publish();
    const previous = fixture.publications.calls.at(-1)!.args[2].producers?.[0]
      .basis;
    fixture.interest.attached = false;
    const before = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls).toHaveLength(before);
    fixture.interest.attached = true;
    await publish();
    expect(fixture.publications.calls).toHaveLength(2);
    expect(fixture.publications.calls.at(-1)!.args[2].producers?.[0].basis).not
      .toEqual(previous);
  });

  it("does not cache a selection the memory server rejected", async () => {
    fixture.publications.restore();
    let accepted = false;
    fixture.publications = stub(
      fixture.server,
      "setViewSelection",
      () => Promise.resolve(accepted),
    );
    await publish();
    accepted = true;
    await publish();
    expect(fixture.publications.calls).toHaveLength(2);
    await publish();
    expect(fixture.publications.calls).toHaveLength(2);
  });

  it("re-walks changed visible values and new view lifetimes", async () => {
    await publish();
    await fixture.runtime.editWithRetry((tx) =>
      fixture.output.withTx(tx).set(6)
    );
    const before = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls.length - before).toBeGreaterThan(1);
    fixture.interest.handle = {
      ...fixture.interest.handle,
      viewEpoch: "replacement",
    };
    const replaced = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls.length - replaced).toBeGreaterThan(1);
    expect(fixture.publications.calls).toHaveLength(3);
  });
  it("publishes a handler's first observation before the initial consumer snapshot", async () => {
    fixture.observations.restore();
    const stream = fixture.runtime.getCell<unknown>(space, "first event", {
      asCell: ["stream"],
    });
    const handler: EventHandler = Object.assign(() => {}, {
      viewPiece: fixture.root.getAsNormalizedFullLink(),
      viewNodeId: "first-handler",
    });
    const cancel = fixture.runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    try {
      await fixture.runtime.editWithRetry((tx) => {
        fixture.root.withTx(tx).set({
          $UI: {
            type: "vnode",
            name: "button",
            props: { onClick: stream },
            children: [fixture.output],
          },
        });
      });
      fixture.runtime.scheduler.recordViewHandlerLog(handler, {
        principal: signer.did(),
        sessionId: "viewer",
      }, {
        reads: [toMemorySpaceAddress(fixture.hidden.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      });
      await publish();
      expect(fixture.publications.calls.at(-1)!.args[2].eligibleActions)
        .toContain("first-handler");
      expect(
        fixture.publications.calls.at(-1)!.args[2].inputs?.map((input) =>
          input.id
        ),
      )
        .toContain(fixture.hidden.getAsNormalizedFullLink().id);
    } finally {
      cancel();
      fixture.observations = stub(
        fixture.runtime.scheduler,
        "viewExecutionNodes",
        () => fixture.nodes,
      );
    }
  });

  it("selects each guarded handler's observations and prunes them after viewer departure", async () => {
    fixture.observations.restore();
    const stream = fixture.runtime.getCell<unknown>(space, "guarded event", {
      asCell: ["stream"],
    });
    const choice = fixture.runtime.getCell<string>(space, "selected handler", {
      type: "string",
    });
    const actor = { principal: signer.did(), sessionId: "viewer" };
    const makeHandler = (key: string): EventHandler =>
      Object.assign(() => {}, {
        viewPiece: fixture.root.getAsNormalizedFullLink(),
        viewNodeId: "same-node-index",
        implementationSelection: {
          key,
          matches: (tx: Parameters<EventHandler>[0]) =>
            choice.withTx(tx).get() === key,
        },
      });
    const first = makeHandler("first");
    const second = makeHandler("second");
    const cancels = [first, second].map((handler) =>
      fixture.runtime.scheduler.addEventHandler(
        handler,
        stream.getAsNormalizedFullLink(),
      )
    );
    try {
      await fixture.runtime.editWithRetry((tx) => {
        choice.withTx(tx).set("first");
        fixture.root.withTx(tx).set({
          $UI: {
            type: "vnode",
            name: "button",
            props: { onClick: stream },
            children: [fixture.output],
          },
        });
      });
      fixture.runtime.scheduler.setViewConsumers(space, [actor]);
      for (
        const [handler, cell] of [[first, fixture.hidden], [
          second,
          fixture.input,
        ]] as const
      ) {
        fixture.runtime.scheduler.recordViewHandlerLog(handler, actor, {
          reads: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [],
        });
      }
      await publish();
      const inputs = () =>
        fixture.publications.calls.at(-1)!.args[2].inputs?.map((input) =>
          input.id
        );
      expect(fixture.publications.calls.at(-1)!.args[2].eligibleActions)
        .toContain("same-node-index");
      expect(inputs()).toContain(fixture.hidden.getAsNormalizedFullLink().id);
      expect(inputs()).not.toContain(
        fixture.input.getAsNormalizedFullLink().id,
      );
      await fixture.runtime.editWithRetry((tx) =>
        choice.withTx(tx).set("second")
      );
      await publish();
      expect(inputs()).toContain(fixture.input.getAsNormalizedFullLink().id);
      expect(inputs()).not.toContain(
        fixture.hidden.getAsNormalizedFullLink().id,
      );
      await fixture.runtime.editWithRetry((tx) =>
        choice.withTx(tx).set("neither")
      );
      await publish();
      expect(fixture.publications.calls.at(-1)!.args[2].eligibleActions).not
        .toContain("same-node-index");
      expect(inputs()).not.toContain(
        fixture.input.getAsNormalizedFullLink().id,
      );
      expect(inputs()).not.toContain(
        fixture.hidden.getAsNormalizedFullLink().id,
      );
      fixture.runtime.scheduler.setViewConsumers(space, []);
      fixture.runtime.scheduler.setViewConsumers(space, [actor]);
      await publish();
      expect(fixture.publications.calls.at(-1)!.args[2].eligibleActions).not
        .toContain("same-node-index");
      await fixture.runtime.editWithRetry((tx) =>
        choice.withTx(tx).set("first")
      );
      await publish();
      expect(fixture.publications.calls.at(-1)!.args[2].eligibleActions).not
        .toContain("same-node-index");
    } finally {
      for (const cancel of cancels) cancel();
      fixture.observations = stub(
        fixture.runtime.scheduler,
        "viewExecutionNodes",
        () => fixture.nodes,
      );
    }
  });

  it("replaces an argument root when only its metadata link changes", async () => {
    const first = fixture.runtime.getCell(space, "first argument", undefined);
    const second = fixture.runtime.getCell(space, "second argument", undefined);
    await fixture.runtime.editWithRetry((tx) => {
      first.withTx(tx).set({ count: 1 });
      second.withTx(tx).set({ count: 2 });
      fixture.root.withTx(tx).set({
        $UI: {
          type: "vnode",
          name: "div",
          props: {},
          children: [fixture.output, {
            type: "vnode",
            name: "cf-input",
            props: { $value: fixture.input },
            children: [],
          }],
        },
      });
      fixture.root.withTx(tx).setMetaRaw(
        "argument",
        first.getAsLink(),
        rawMetaWriteAuthorization,
      );
    });
    await publish();
    const inputs = () =>
      fixture.publications.calls.at(-1)!.args[2].inputs?.map((input) =>
        input.id
      );
    expect(inputs()).toContain(first.getAsNormalizedFullLink().id);
    expect(inputs()).not.toContain(second.getAsNormalizedFullLink().id);
    await fixture.runtime.editWithRetry((tx) => {
      fixture.root.withTx(tx).setMetaRaw(
        "argument",
        second.getAsLink(),
        rawMetaWriteAuthorization,
      );
    });
    await publish();
    expect(inputs()).toContain(second.getAsNormalizedFullLink().id);
    expect(inputs()).not.toContain(first.getAsNormalizedFullLink().id);
  });

  it("leaves unsupported component contracts and anonymous views unplanned", async () => {
    fixture.interest.view.componentContractVersion = "unsupported";
    await publish();
    expect(fixture.publications.calls).toHaveLength(0);
    expect(fixture.observations.calls).toHaveLength(0);
    fixture.interest.view.componentContractVersion =
      COMPONENT_READ_CONTRACT_VERSION;
    fixture.interest.principal = undefined;
    await publish();
    expect(fixture.publications.calls).toHaveLength(0);
    expect(fixture.observations.calls).toHaveLength(0);
  });

  it("retains a published selection when new observations have the same values", async () => {
    await publish();
    fixture.nodes[0].log = { ...fixture.nodes[0].log };
    await publish();
    expect(fixture.observations.calls).toHaveLength(2);
    expect(fixture.publications.calls).toHaveLength(1);
  });

  it("withdraws a failed selection and rebuilds it after observations recover", async () => {
    await publish();
    const original = fixture.publications.calls[0].args[2];
    fixture.observations.restore();
    fixture.observations = stub(
      fixture.runtime.scheduler,
      "viewExecutionNodes",
      () => {
        throw new Error("Observation unavailable");
      },
    );
    await publish();
    expect(fixture.publications.calls.at(-1)!.args[2]).toEqual({
      generation: 1,
      delivery: [],
      eligibleActions: [],
      pieces: [],
      inputs: [],
      producers: [],
    });
    fixture.observations.restore();
    fixture.observations = stub(
      fixture.runtime.scheduler,
      "viewExecutionNodes",
      () => fixture.nodes,
    );
    const reads = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls.length).toBeGreaterThan(reads);
    expect(fixture.publications.calls).toHaveLength(3);
    expect(fixture.publications.calls.at(-1)!.args[2]).toEqual(original);
  });

  it("omits unobserved computations and handlers outside the selected space", async () => {
    fixture.observations.restore();
    const other = await Identity.fromPassphrase("other observation space");
    const stream = fixture.runtime.getCell(
      space,
      "unannotated handler",
      undefined,
    ).getAsNormalizedFullLink();
    const foreignStream = { ...stream, space: other.did() };
    const cancelOrdinary = fixture.runtime.scheduler.addEventHandler(
      () => {},
      stream,
    );
    const actor = { principal: signer.did(), sessionId: "viewer" };
    const foreignHandler: EventHandler = Object.assign(() => {}, {
      viewPiece: {
        ...fixture.root.getAsNormalizedFullLink(),
        space: other.did(),
      },
      viewNodeId: "foreign-handler",
    });
    const cancelForeign = fixture.runtime.scheduler.addEventHandler(
      foreignHandler,
      foreignStream,
    );
    fixture.runtime.scheduler.recordViewHandlerLog(foreignHandler, actor, {
      reads: [{
        ...toMemorySpaceAddress(fixture.input.getAsNormalizedFullLink()),
        space: other.did(),
      }],
      shallowReads: [],
      writes: [],
    });
    fixture.runtime.scheduler.register(Object.assign(() => {}, {
      viewPiece: fixture.root.getAsNormalizedFullLink(),
      viewNodeId: "unobserved",
      writes: [fixture.output.getAsNormalizedFullLink()],
    }));
    try {
      expect(
        fixture.runtime.scheduler.viewExecutionNodes(space, {
          principal: signer.did(),
          sessionId: "viewer",
        }),
      ).toEqual([]);
      expect(
        fixture.runtime.scheduler.viewExecutionNodes(other.did(), actor).map((
          node,
        ) => node.id),
      ).toEqual(["foreign-handler"]);
    } finally {
      cancelOrdinary();
      cancelForeign();
      fixture.observations = stub(
        fixture.runtime.scheduler,
        "viewExecutionNodes",
        () => fixture.nodes,
      );
    }
  });

  it("omits inline documents from delivered view inputs", async () => {
    const inline = fixture.runtime.getImmutableCell(space, "constant label");
    await fixture.runtime.editWithRetry((tx) =>
      fixture.root.withTx(tx).set({
        $UI: { type: "vnode", name: "div", props: {}, children: [inline] },
      })
    );
    await publish();
    const selection = fixture.publications.calls.at(-1)!.args[2];
    expect(selection.inputs?.map((input) => input.id)).toContain(
      fixture.root.getAsNormalizedFullLink().id,
    );
    expect(selection.inputs?.map((input) => input.id)).not.toContain(
      inline.getAsNormalizedFullLink().id,
    );
    expect(selection.eligibleActions).toEqual([]);
  });
});
