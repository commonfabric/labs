/**
 * Creates a profile through the real create pattern on a memory server that
 * enforces access-control lists, then runs that profile from a second user's
 * runtime. A runtime showing a profile writes into the profile's space, so
 * what the space grants a visitor decides whether the visit works at all, and
 * what the visitor's writes reach decides what the owner sees afterwards.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import * as Engine from "@commonfabric/memory/v2/engine";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import { TestStorageManager } from "./memory-v2-test-utils.ts";
import {
  createProfileThroughHome,
  PrincipalSessionFactory,
} from "./support/profile-create-host.ts";

const owner = await Identity.fromPassphrase("profile space access owner");
const visitor = await Identity.fromPassphrase("profile space access visitor");

describe("profile-space-access", () => {
  let server: MemoryV2Server.Server;
  let serverCount = 0;
  const factory = () => new PrincipalSessionFactory(server);
  const memoryHost = new URL("memory://");
  const runtimeAs = (as: Identity) =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: TestStorageManager.create(
        { as, memoryHost },
        factory(),
      ),
    });

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      store: new URL(`memory://profile-space-access-${++serverCount}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-profile-space-access" },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it("creates a profile space a visitor's runtime can write to, keeping the visitor's view state out of the owner's", async () => {
    const ownerRuntime = runtimeAs(owner);
    const visitorRuntime = runtimeAs(visitor);
    const readerRuntime = runtimeAs(owner);
    let ownerDisposed = false;
    const disposeOwner = async () => {
      if (ownerDisposed) return;
      ownerDisposed = true;
      await ownerRuntime.dispose();
    };
    try {
      const profileLink = await createProfileThroughHome(ownerRuntime, "Ada");
      const profileSpace = profileLink.space as MemorySpace;
      expect(
        (await server.readDocument(profileSpace, aclDocId(profileSpace) as URI))
          ?.value,
      ).toEqual({ "*": "WRITE", [owner.did()]: "OWNER" });

      // The owner's runtime is gone before the visitor arrives, so every
      // commit the profile space takes from here on is the visitor's.
      await disposeOwner();
      const profileEngine = await server.engineForSpace(profileSpace);
      const seqBeforeVisit = Engine.serverSeq(profileEngine);

      // The visitor runs the profile and flips its view mode, the one stream
      // of the profile a visitor is free to send to.
      const visited = visitorRuntime.getCellFromLink(profileLink);
      await visited.sync();
      expect(await visitorRuntime.start(visited)).toBe(true);
      await visitorRuntime.idle();
      const toggleTx = visitorRuntime.edit();
      visited.withTx(toggleTx).key("toggleEditing").send(undefined);
      visitorRuntime.prepareTxForCommit(toggleTx);
      expect((await toggleTx.commit().settled).error).toBeUndefined();
      await visitorRuntime.idle();
      const booleanSchema = { type: "boolean" } as const;
      const visitorIsEditing = visited.key("isEditing").asSchema<boolean>(
        booleanSchema,
      );
      expect(await visitorIsEditing.pull()).toBe(true);
      await visitorRuntime.idle();
      await visitorRuntime.storageManager.synced();
      expect(Engine.serverSeq(profileEngine)).toBeGreaterThan(seqBeforeVisit);

      // The view state the visitor flipped is the visitor's own, and so is
      // `isEditing`, which is computed from it: a runtime of the owner's that
      // has run nothing holds no value for either, and reads the profile as
      // not being edited through the default the profile declares.
      const ownerIsEditing = readerRuntime.getCellFromLink(profileLink)
        .key("isEditing").asSchema<boolean>({
          ...booleanSchema,
          default: false,
        });
      await ownerIsEditing.sync();
      expect(ownerIsEditing.get()).toBe(false);
    } finally {
      await readerRuntime.dispose();
      await visitorRuntime.dispose();
      await disposeOwner();
    }
  });
});
