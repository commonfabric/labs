import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
  streamEntriesDocId,
} from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { type CapturedLogs, captureLogs } from "./support/captured-logs.ts";

const signer = await Identity.fromPassphrase(
  "storage-v2 event append schema docs cov",
);
const space = signer.did();
const stream = { id: "of:storage-v2-event-append-stream", path: [] };
const sidecarId = streamEntriesDocId(stream);

const registeredSchema = {
  type: "string",
  title: "storage-v2-event-append-registered",
} as const;
const registeredHash = internSchemaAsTaggedHashString(registeredSchema);

/** A hash no schema document in the realm registry verifies against. */
const missingHash = internSchemaAsTaggedHashString({
  type: "number",
  title: "storage-v2-event-append-never-registered",
});

/** A payload holding one link whose schema references `hash`. */
const payloadNaming = (hash: string): FabricValue => ({
  target: {
    "/": {
      [LINK_V1_TAG]: {
        id: "of:storage-v2-event-append-target",
        path: [],
        schema: { $ref: `cid:${hash}` },
      },
    },
  },
});

describe("storage/v2", () => {
  let server: MemoryV2Server.Server;
  let storage: EmulatedStorageManager;
  let logs: CapturedLogs;

  beforeEach(() => {
    setServerExecutionConfig(true);
    setContentAddressedSchemasConfig(true);
    logs = captureLogs("storage.v2");
    server = newSharedServer();
    storage = EmulatedStorageManager.connectTo(server, { as: signer });
    registerSchemaDocument(registeredHash, registeredSchema);
  });

  afterEach(async () => {
    await storage.close();
    await server.close();
    logs[Symbol.dispose]();
    resetContentAddressedSchemasConfig();
    resetServerExecutionConfig();
  });

  const append = (eventId: string, hash: string) =>
    storage.open(space).replica.enqueueEventAppend?.({
      sidecarId,
      stream,
      eventId,
      payload: payloadNaming(hash),
    });

  it("logs each schema document an event payload's links name that the registry cannot supply", async () => {
    expect(await append("evt:missing", missingHash)).toEqual({
      delivered: false,
      refused:
        `memory v2 commit references schema document cid:${missingHash} ` +
        "that is neither included in the commit nor stored in the space",
    });
    expect(logs.messagesOf("event-append-schema-doc-missing")).toEqual([[
      "An event payload's link names a schema document the registry " +
      "cannot supply:",
      `cid:${missingHash}`,
    ]]);
    expect(await server.readDocument(space, `cid:${missingHash}`))
      .toBeNull();
  });

  it("carries a schema document the registry supplies with the append, logging nothing", async () => {
    expect(await append("evt:registered", registeredHash)).toEqual({
      delivered: true,
    });
    expect(logs.messagesOf("event-append-schema-doc-missing")).toEqual([]);
    expect(await server.readDocument(space, `cid:${registeredHash}`))
      .toEqual({ value: registeredSchema });
  });
});
