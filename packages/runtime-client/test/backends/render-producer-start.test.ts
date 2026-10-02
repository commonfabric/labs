/** Embedded renders activate the referenced piece's local producer graph. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { newSharedServer } from "../../../runner/test/memory-v2-test-utils.ts";

import { NotificationType, RequestType } from "@/protocol/mod.ts";
import { createCellRef } from "@/backends/utils.ts";
import { buildProcessor } from "./build-processor.ts";

const program = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
      import { pattern, UI, Writable } from "commonfabric";
      export default pattern(() => {
        const text = new Writable.perSession("Session producer is running");
        return { [UI]: <span>{text}</span> };
      });
    `,
  }],
};

/** Persists executable targets elsewhere and mounts through the viewer's link. */
async function setup() {
  const owner = await Identity.fromPassphrase("render producer owner");
  const viewer = await Identity.fromPassphrase("render producer viewer");
  const server = newSharedServer();
  const ownerStorage = EmulatedStorageManager.connectTo(server, { as: owner });
  const storage = EmulatedStorageManager.connectTo(server, { as: viewer });
  const ownerRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: ownerStorage,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  const processor = buildProcessor({ runtime });
  const posted: unknown[] = [];
  const client = {
    id: 1,
    post: (message: unknown) => {
      posted.push(message);
      return true;
    },
  };
  const compiled = await ownerRuntime.patternManager.compilePattern(program, {
    space: owner.did(),
  });
  const tx = ownerRuntime.edit();
  const originals = ["first", "second"].map((name) => {
    const piece = ownerRuntime.getCell(owner.did(), name, undefined, tx);
    ownerRuntime.run(tx, compiled, {}, piece);
    return piece;
  });
  ownerRuntime.prepareTxForCommit(tx);
  expect((await tx.commit()).error).toBeUndefined();
  await ownerRuntime.idle();
  await ownerStorage.synced();
  const targets = originals.map((piece) =>
    runtime.getCellFromLink(piece.getAsNormalizedFullLink())
  );
  const host = runtime.getCell<{ selected: unknown }>(
    viewer.did(),
    "host-link",
  );
  const select = async (value: unknown) => {
    const edit = runtime.edit();
    host.withTx(edit).set({ selected: value });
    expect((await edit.commit()).error).toBeUndefined();
  };
  await select(targets[0]);
  return {
    runtime,
    processor,
    posted,
    targets,
    select,
    pendingTarget: (name: string) =>
      runtime.getCellFromLink(
        ownerRuntime.getCell(owner.did(), name).getAsNormalizedFullLink(),
      ),
    setPatternMetadata: async (name: string, value: FabricValue) => {
      const edit = ownerRuntime.edit();
      const piece = ownerRuntime.getCell(owner.did(), name, undefined, edit);
      piece.setMetaRaw("patternIdentity", value, rawMetaWriteAuthorization);
      expect((await edit.commit()).error).toBeUndefined();
      await ownerStorage.synced();
    },
    publish: async (name: string) => {
      const edit = ownerRuntime.edit();
      const piece = ownerRuntime.getCell(owner.did(), name, undefined, edit);
      ownerRuntime.run(edit, compiled, {}, piece);
      ownerRuntime.prepareTxForCommit(edit);
      expect((await edit.commit()).error).toBeUndefined();
      await ownerRuntime.idle();
      await ownerStorage.synced();
    },
    mount: () =>
      processor.handleVDomMount({
        type: RequestType.VDomMount,
        mountId: 1,
        cell: createCellRef(host.key("selected")),
      }, client),
    unmount: () =>
      processor.handleVDomUnmount(
        { type: RequestType.VDomUnmount, mountId: 1 },
        client,
      ),
    dispose: async () => {
      if (processor.accessForTestingOnly.vdomMounts.has("1 1")) {
        processor.handleVDomUnmount({
          type: RequestType.VDomUnmount,
          mountId: 1,
        }, client);
      }
      await runtime.dispose();
      await ownerRuntime.dispose();
      await storage.close();
      await ownerStorage.close();
      await server.close();
    },
  };
}

describe("render-producer-start", () => {
  it("starts and retargets a persisted cross-space piece through a host link", async () => {
    const fixture = await setup();
    const { runtime, targets, posted } = fixture;
    try {
      expect(runtime.runner.pieceGraphIsInstalled(targets[0])).toBe(false);
      const started = targets.map(() => Promise.withResolvers<void>());
      const start = runtime.start.bind(runtime);
      using _startObserver = stub(runtime, "start", async (...args) => {
        const result = await start(...args);
        const index = targets.findIndex((target) => args[0].equals(target));
        if (index >= 0) started[index].resolve();
        return result;
      });
      await fixture.mount();
      await started[0].promise;
      await runtime.idle();
      expect(runtime.runner.pieceGraphIsInstalled(targets[0])).toBe(true);
      expect(posted.some((message) => {
        const batch = message as { type: string; ops?: { text?: string }[] };
        return batch.type === NotificationType.VDomBatch &&
          batch.ops?.some((op) => op.text === "Session producer is running");
      })).toBe(true);
      expect(runtime.runner.pieceGraphIsInstalled(targets[1])).toBe(false);
      await fixture.select(targets[1]);
      await started[1].promise;
      await runtime.idle();
      expect(runtime.runner.pieceGraphIsInstalled(targets[1])).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it("renders plain data without starting either executable target", async () => {
    const fixture = await setup();
    try {
      await fixture.select({
        type: "vnode",
        name: "span",
        props: {},
        children: ["Plain data"],
      });
      using starts = stub(fixture.runtime, "start");
      await fixture.mount();
      await fixture.runtime.idle();
      expect(starts.calls).toHaveLength(0);
      expect(fixture.posted.some((message) => {
        const batch = message as { type: string; ops?: { text?: string }[] };
        return batch.type === NotificationType.VDomBatch &&
          batch.ops?.some((op) => op.text === "Plain data");
      })).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  for (const initialMetadata of [undefined, { identity: 123 }] as const) {
    it(`starts a rendered target after ${initialMetadata === undefined ? "absent" : "malformed"} producer metadata becomes valid`, async () => {
      const fixture = await setup();
      try {
        const target = fixture.pendingTarget("late-piece");
        if (initialMetadata !== undefined) {
          await fixture.setPatternMetadata("late-piece", initialMetadata);
        }
        await fixture.select(target);
        const watching = Promise.withResolvers<void>();
        const { space, id } = target.getAsNormalizedFullLink();
        const subscribe = fixture.runtime.scheduler.resubscribe.bind(
          fixture.runtime.scheduler,
        );
        using _metadataObserver = stub(
          fixture.runtime.scheduler,
          "resubscribe",
          (...args) => {
            const result = subscribe(...args);
            if (args[0].name === `sink:${space}/${id}/patternIdentity`) {
              watching.resolve();
            }
            return result;
          },
        );
        const started = Promise.withResolvers<void>();
        const start = fixture.runtime.start.bind(fixture.runtime);
        using starts = stub(fixture.runtime, "start", async (...args) => {
          const result = await start(...args);
          if (args[0].equals(target)) started.resolve();
          return result;
        });
        await fixture.mount();
        await watching.promise;
        await fixture.runtime.idle();
        expect(starts.calls).toHaveLength(0);
        await fixture.publish("late-piece");
        await started.promise;
        await fixture.runtime.idle();
        expect(fixture.runtime.runner.pieceGraphIsInstalled(target)).toBe(true);
      } finally {
        await fixture.dispose();
      }
    });
  }

  for (const cancel of ["unmount", "retarget"] as const) {
    it(`prevents a late producer start after ${cancel} during pattern loading`, async () => {
      const fixture = await setup();
      const { runtime, targets } = fixture;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const loaded = Promise.withResolvers<void>();
      try {
        const load = runtime.patternManager.loadPatternByIdentity.bind(
          runtime.patternManager,
        );
        using _loading = stub(
          runtime.patternManager,
          "loadPatternByIdentity",
          async (...args) => {
            entered.resolve();
            await release.promise;
            try {
              return await load(...args);
            } finally {
              loaded.resolve();
            }
          },
        );
        using starts = stub(runtime, "start");
        await fixture.mount();
        await entered.promise;
        if (cancel === "unmount") fixture.unmount();
        else {await fixture.select({
            type: "vnode",
            name: "span",
            props: {},
            children: ["Replacement"],
          });}
        await runtime.idle();
        release.resolve();
        await loaded.promise;
        await runtime.idle();
        expect(starts.calls).toHaveLength(0);
        expect(runtime.runner.pieceGraphIsInstalled(targets[0])).toBe(false);
      } finally {
        release.resolve();
        await fixture.dispose();
      }
    });
  }
});
