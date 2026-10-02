/** Unreadable profiles preserve the room without offering participant Chat controls. */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import {
  FabricDurationNsec,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { EntityDocument } from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import { type Cell, isCell, Runtime, UI } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { debugVDOMSchema } from "@commonfabric/runner/schemas";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA,
  SEED_ENVELOPE_SCHEMA_HASH,
} from "../../runner/test/cfc-seed-envelope.ts";

/** Finds a rendered element without dereferencing its profile binding. */
function elements(value: unknown, tag: string): Record<string, unknown>[] {
  if (isCell(value)) return elements(value.get(), tag);
  if (Array.isArray(value)) {
    return value.flatMap((child) => elements(child, tag));
  }
  if (!value || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  return [
    ...(node.name === tag ? [node] : []),
    ...elements(node.children, tag),
  ];
}

/** Reads one prop through the debug renderer's retained cell boundary. */
function prop(node: Record<string, unknown>, name: string): Cell<unknown> {
  const props = node.props as Record<string, Cell<unknown>>;
  return props[name];
}

describe("FabriChat participants", () => {
  it("keeps unreadable participant badges without enabling Chat or disrupting the room", async () => {
    const viewer = await Identity.fromPassphrase("chat participant viewer");
    const participant = await Identity.fromPassphrase("chat participant owner");
    const privateOwner = await Identity.fromPassphrase(
      "chat private participant",
    );
    const ownProfileSpace = await Identity.fromPassphrase(
      "chat viewer profile",
    );
    const service = await Identity.fromPassphrase(
      "chat participant seed service",
    );
    const server = new Server({
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:chat-participants-test" },
      acl: { mode: "enforce", serviceDids: [service.did()] },
      subscriptionRefreshDelayMs: 0,
    });
    const client = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
    });
    const storage = EmulatedStorageManager.connectTo(server, { as: viewer });
    const runtime = new Runtime({
      apiUrl: new URL("https://fabric.example/"),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    const stops: (() => void)[] = [];
    try {
      const writers = new Map<MemorySpace, MemoryClient.SpaceSession>();
      let localSeq = 0;
      const write = async (
        space: MemorySpace,
        id: URI,
        value: EntityDocument,
      ) => {
        let session = writers.get(space);
        if (!session) {
          session = await client.mount(
            space,
            {},
            (_space, _session, context) => ({
              invocation: {
                aud: context.audience,
                challenge: context.challenge.value,
              },
              authorization: { principal: service.did() },
            }),
          );
          writers.set(space, session);
        }
        await session.transact({
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id, value }],
        });
      };
      const profileSpace = participant.did();
      await write(viewer.did(), `of:${viewer.did()}`, {
        value: { [viewer.did()]: "OWNER" },
      });
      await write(profileSpace, `of:${profileSpace}`, {
        value: { [participant.did()]: "OWNER", [viewer.did()]: "READ" },
      });
      await write(profileSpace, `cid:${SEED_ENVELOPE_SCHEMA_HASH}`, {
        value: SEED_ENVELOPE_SCHEMA,
      });
      const profile = runtime.getCell(profileSpace, "participant-profile");
      await write(profileSpace, profile.getAsNormalizedFullLink().id, {
        value: { name: "Participant" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              origin: "declared",
              label: {
                integrity: [{
                  kind: "represents-principal",
                  subject: participant.did(),
                }],
              },
            }],
          },
        },
      });
      await write(privateOwner.did(), `of:${privateOwner.did()}`, {
        value: { [privateOwner.did()]: "OWNER" },
      });
      const privateProfile = runtime.getCell(
        privateOwner.did(),
        "private-profile",
      );
      await write(
        privateOwner.did(),
        privateProfile.getAsNormalizedFullLink().id,
        {
          value: { name: "Private participant" },
        },
      );
      await write(ownProfileSpace.did(), `of:${ownProfileSpace.did()}`, {
        value: { [viewer.did()]: "OWNER" },
      });
      const ownProfile = runtime.getCell(
        ownProfileSpace.did(),
        "viewer-profile",
      );
      await write(
        ownProfileSpace.did(),
        ownProfile.getAsNormalizedFullLink().id,
        {
          value: { name: "Viewer" },
        },
      );
      const root = join(import.meta.dirname!, "..");
      const program = await resolveLocalProgram(
        (request) => runtime.harness.resolve(request),
        { main: join(root, "fabrichat", "room.tsx"), root },
      );
      const managerProgram = await resolveLocalProgram(
        (request) => runtime.harness.resolve(request),
        { main: join(root, "fabrichat", "manager.tsx"), root },
      );
      const tx = runtime.edit();
      const managerPattern = await runtime.patternManager.compilePattern(
        managerProgram,
        {
          space: viewer.did(),
          tx,
        },
      );
      const chatManager = runtime.getCell(
        viewer.did(),
        "participant-manager",
        managerPattern.resultSchema,
        tx,
      );
      runtime.run(tx, managerPattern, {}, chatManager);

      const pattern = await runtime.patternManager.compilePattern(program, {
        space: viewer.did(),
        tx,
      });
      const room = runtime.getCell<Record<string, unknown>>(
        viewer.did(),
        "participant-room",
        pattern.resultSchema,
        tx,
      );
      const about = runtime.getCell(
        viewer.did(),
        "participant-room-about",
        undefined,
        tx,
      );
      const policy = runtime.getCell(
        viewer.did(),
        "participant-room-policy",
        undefined,
        tx,
      );
      policy.set({
        ownersMayObliterate: true,
        keepsHistory: true,
        deletionIsObliteration: false,
        proposedTimeMaxAgeNsec: new FabricDurationNsec(600_000_000_000n),
        proposedTimeMaxLeadNsec: new FabricDurationNsec(10_000_000_000n),
        recentActivityWindowNsec: new FabricDurationNsec(600_000_000_000n),
        maxWindowCount: 100,
        maxOpenWindows: 50,
      });
      about.set({
        kind: "group",
        policy,
        title: "Available conversation",
        createdAt: new FabricEpochNsec(0n),
      });
      const home = runtime.getCell(
        viewer.did(),
        "participant-room-home",
        undefined,
        tx,
      );
      home.set({
        participants: [profile, privateProfile],
        defaultProfile: ownProfile,
        profiles: [ownProfile],
        chatManager,
      });
      runtime.getHomeSpaceCell(tx).key("defaultPattern").set(home);
      runtime.run(tx, pattern, { about }, room);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await room.pull();
      await chatManager.pull();
      const view = room.key(UI).asSchema(debugVDOMSchema);
      stops.push(view.sink(() => {}));
      await runtime.idle();
      await view.pull();
      const starts = elements(view.get(), "div").filter((node) =>
        prop(node, "data-ui-pattern")?.get() === "ChatStartSurface"
      );
      expect(starts).toHaveLength(2);
      const readableDisplay = prop(starts[0], "style").key("display");
      await waitForCellValue(
        runtime,
        readableDisplay,
        (value) => value === "block",
        {
          stuckLabel: "readable attested participant to offer Chat",
        },
      );
      const readableButton = elements(starts[0], "cf-button")[0];
      expect(prop(readableButton, "data-chat-counterpart").get()).toBe(
        participant.did(),
      );
      const privateDisplay = prop(starts[1], "style").key("display");
      await waitForCellValue(
        runtime,
        privateDisplay,
        (value) => value === "none",
        {
          stuckLabel: "unreadable participant to omit Chat",
        },
      );
      const privateButton = elements(starts[1], "cf-button")[0];
      expect(prop(privateButton, "data-chat-counterpart").get())
        .toBeUndefined();
      expect(storage.spaceAccessError?.(privateOwner.did())?.name).toBe(
        "AuthorizationError",
      );
      expect(elements(view.get(), "cf-profile-badge")).toHaveLength(3);
      // Keep profile documents behind their handle boundary, as the renderer does.
      const participantRefs = await waitForCellValue<Cell<unknown>[]>(
        runtime,
        room.key("participants").asSchema({
          type: "array",
          items: { asCell: ["cell"] },
        }),
        (value) => value?.length === 2,
        { stuckLabel: "both participant links to remain readable" },
      );
      expect(participantRefs[0].resolveAsCell().equals(profile)).toBe(true);
      expect(participantRefs[1].resolveAsCell().equals(privateProfile)).toBe(
        true,
      );
      await waitForCellValue(
        runtime,
        room.key("canSend"),
        (value) => value === true,
        {
          stuckLabel: "room composer to remain available",
        },
      );
      expect(room.key("about").key("title").get()).toBe(
        "Available conversation",
      );
      expect(room.key("messages").key("count").get()).toBe(0);
    } finally {
      for (const stop of stops.reverse()) stop();
      await runtime.dispose();
      await storage.close();
      await client.close();
      await server.close();
    }
  });
});
