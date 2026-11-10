/**
 * Reads room-list metadata from an independent runtime that has opened no
 * piece, and checks the documents delivered as well as the returned value.
 * Uses Deno workers and an in-process storage server, with no browser.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { isPlainObject } from "@commonfabric/js-values/types";
import { idStringForEntityAddress } from "@commonfabric/runner";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const ROOT = join(import.meta.dirname!, "..");
const PROGRAM = join(
  import.meta.dirname!,
  "fixtures/fabrichat-add-offer/main.tsx",
);
const START = { surface: "ChatStartSurface", action: "ChatStart" };
const SEND = { surface: "ChatSendSurface", action: "ChatSend" };
const RETITLE = { surface: "ChatRetitleSurface", action: "ChatRetitle" };
const METADATA_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string" },
    title: { type: "string" },
    room: {
      type: "object",
      properties: { space: { type: "string" }, id: { type: "string" } },
    },
    roster: {
      type: "array",
      items: { type: "object", properties: {}, asCell: ["cell"] },
    },
  },
};

/** Returns the room-space document count without reading any document. */
async function roomDocuments(
  session: MultiRuntimeSession,
  space: string,
): Promise<number> {
  const sizes = await session.client().call("memorySizes", {});
  if (
    !isPlainObject(sizes) || !isPlainObject(sizes.storage) ||
    !Array.isArray(sizes.storage.bySpace)
  ) {
    throw new TypeError("The runtime did not report per-space storage sizes.");
  }
  const entry = sizes.storage.bySpace.find((item) =>
    isPlainObject(item) && item.space === space
  );
  if (entry === undefined) return 0;
  if (!isPlainObject(entry) || typeof entry.documents !== "number") {
    throw new TypeError("The space did not report its document count.");
  }
  return entry.documents;
}

/** Validates the result of the worker's explicitly addressed subscription. */
function metadataRecord(value: FabricValue): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new TypeError("The metadata subscription returned no record.");
  }
  return value;
}

describe("fabrichat room metadata across runtimes", () => {
  it("delivers current metadata without the room result or its messages", async () => {
    const harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM,
      rootPath: ROOT,
      sessions: ["room-metadata-owner"],
      aclMode: "enforce",
      watchPaths: [],
    });
    try {
      const owner = harness.sessions[0];
      await owner.send("createProfile", { name: "Ada" });
      await harness.settle();
      await owner.client().call("linkHomeRoot", {});
      await harness.settle();
      await owner.send("createGroup", {
        requestId: "room",
        title: "Small summary",
        members: [],
      }, START);
      await harness.settleUntil(async () =>
        (await owner.read(["requests", "room", "status"])) === "done"
      );
      const room = await owner.link(["requests", "room", "entry", "room"]);
      for (let index = 0; index < 20; index++) {
        await owner.send("sendMessage", { body: `Message ${index}` }, SEND, {
          piece: room,
        });
        await harness.settle();
      }
      expect(await owner.read(["messages", "count"], { piece: room })).toBe(20);
      const messages = await Promise.all(
        Array.from(
          { length: 20 },
          (_, index) =>
            owner.link(["messages", "latest", "messages", index], {
              piece: room,
            }),
        ),
      );
      const metadata = await owner.link(["metadata"], { piece: room });
      expect(metadata.space).toBe(room.space);
      expect(metadata.id).not.toBe(room.id);
      expect(metadata.scope).toBe("space");
      console.log("Owner materialized metadata", {
        present: (await owner.rawRead(metadata)).value !== undefined,
      });

      const reader = await harness.addSession({
        label: "room-metadata-reader",
        identity: owner.identity,
        unattached: true,
      });
      expect(await roomDocuments(reader, room.space)).toBe(0);
      await reader.client().call("watchAddress", {
        link: { "/": { "link@1": { ...metadata, schema: METADATA_SCHEMA } } },
      });
      await harness.settleUntil(async () => {
        const value = await reader.client().call("watchedAddress", {});
        return isPlainObject(value) && value.title === "Small summary";
      });
      const first = metadataRecord(
        await reader.client().call("watchedAddress", {}),
      );
      expect(first.title).toBe("Small summary");
      expect(first.kind).toBe("group");
      expect(Array.isArray(first.roster)).toBe(true);
      expect(await reader.rawRead(room)).toMatchObject({
        ok: true,
        value: undefined,
      });
      for (const message of messages) {
        expect(await reader.rawRead(message)).toMatchObject({
          ok: true,
          value: undefined,
        });
      }
      const initialDocuments = await roomDocuments(reader, room.space);
      expect(initialDocuments).toBeGreaterThan(0);
      expect(initialDocuments).toBeLessThan(100);
      console.log("Initial room metadata", {
        initialDocuments,
        title: first.title,
      });

      await owner.send("sendMessage", { body: "Another message" }, SEND, {
        piece: room,
      });
      await harness.settle();
      const updated = metadataRecord(
        await reader.client().call("watchedAddress", {}),
      );
      expect(updated).toEqual(first);
      expect(await reader.rawRead(room)).toMatchObject({
        ok: true,
        value: undefined,
      });
      for (const message of messages) {
        expect(await reader.rawRead(message)).toMatchObject({
          ok: true,
          value: undefined,
        });
      }
      const updatedDocuments = await roomDocuments(reader, room.space);
      expect(updatedDocuments).toBe(initialDocuments);

      await owner.send(
        "setTitle",
        {
          requestId: "rename",
          title: "Changed summary",
        },
        RETITLE,
        { piece: room },
      );
      await harness.settleUntil(async () => {
        const value = await reader.client().call("watchedAddress", {});
        return isPlainObject(value) && value.title === "Changed summary";
      });
      const renamed = metadataRecord(
        await reader.client().call("watchedAddress", {}),
      );
      expect(renamed.title).toBe("Changed summary");
      expect(await reader.rawRead(room)).toMatchObject({
        ok: true,
        value: undefined,
      });
      for (const message of messages) {
        expect(await reader.rawRead(message)).toMatchObject({
          ok: true,
          value: undefined,
        });
      }
      expect(await roomDocuments(reader, room.space)).toBe(initialDocuments);

      const destination = first.room;
      if (
        !isPlainObject(destination) ||
        typeof destination.id !== "string" ||
        typeof destination.space !== "string"
      ) {
        throw new TypeError("The metadata does not name its room.");
      }
      const navigation = {
        id: idStringForEntityAddress(destination.id),
        space: destination.space,
      };
      expect(navigation.space).toBe(room.space);

      // Navigation consumes the metadata's entity id through the ordinary
      // piece-opening API. This also controls the replica absence assertion.
      expect(
        await reader.readAs(["$NAME"], { type: "string" }, {
          piece: navigation,
        }),
      ).toBe("Changed summary");
      await harness.settle();
      expect((await reader.rawRead(room)).value).toBeDefined();
      const rootDocuments = await roomDocuments(reader, room.space);
      expect(rootDocuments).toBeGreaterThan(updatedDocuments);
      expect(await reader.link([], { piece: navigation })).toEqual(room);
      console.log("Room metadata document counts", {
        messages: 20,
        initialDocuments,
        updatedDocuments,
        rootDocuments,
      });
    } finally {
      await harness.dispose();
    }
  });
});
