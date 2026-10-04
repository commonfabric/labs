import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

const PRODUCER_MODULE = "producer-module-identity";
const PRODUCER_FILE = "/patterns/producer.tsx";
const CONSUMER_MODULE = "consumer-module-identity";
const CONSUMER_FILE = "/patterns/consumer.tsx";

const signer = await Identity.fromPassphrase(
  "cfc-link-crossing-write-authority",
);

/** The module the producer document's claim names. */
const asProducer: ImplementationIdentity = {
  kind: "verified",
  moduleIdentity: PRODUCER_MODULE,
  sourceFile: PRODUCER_FILE,
  bindingPath: ["setBio"],
};

/** A second verified module, which no claim in this space names. */
const asConsumer: ImplementationIdentity = {
  kind: "verified",
  moduleIdentity: CONSUMER_MODULE,
  sourceFile: CONSUMER_FILE,
  bindingPath: ["setBio"],
};

/** The linked-to document: its `bio` authorizes writes by the producer. */
const producerSchema: JSONSchema = {
  type: "object",
  properties: {
    bio: {
      type: "string",
      ifc: {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: {
            moduleIdentity: PRODUCER_MODULE,
            file: PRODUCER_FILE,
            path: ["setBio"],
          },
        },
      },
    },
  },
};

/** The document holding the link, which declares no claim of its own. */
const consumerSchema: JSONSchema = {
  type: "object",
  properties: { slot: { type: "object" } },
};

describe("cfc-link-crossing-write-authority", () => {
  // A write below a link records its schema write-policy input at the document
  // the link resolves to, carrying the schema the crossed link holds, so the
  // claim that gates the write is the one that schema declares. Both cases
  // below cross a link the consumer wrote from a schema-bearing producer cell,
  // which carries the producer's own schema; a link carrying a schema the
  // consumer authored is a different case, and neither measures it.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    storageManager = undefined;
    runtime = undefined;
  });

  /**
   * Builds a space holding a producer document whose `bio` authorizes the
   * producer module, and a consumer document whose `slot` holds a handle to
   * the producer.
   */
  const linkedSpace = async (): Promise<Runtime> => {
    storageManager = StorageManager.emulate({ as: signer });
    const rt = runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "cfc-link-crossing-write-authority",
        actingPrincipal: signer.did(),
      }),
    });

    const seedTx = rt.edit();
    const producer = rt.getCell(
      signer.did(),
      "link-crossing-producer",
      producerSchema,
      seedTx,
    );
    setCfcImplementationIdentity(seedTx, asProducer);
    producer.set({ bio: "seed" });
    seedTx.prepareCfc();
    expect((await seedTx.commit()).error).toBeUndefined();
    await rt.idle();

    const linkTx = rt.edit();
    const consumer = rt.getCell(
      signer.did(),
      "link-crossing-consumer",
      consumerSchema,
      linkTx,
    );
    setCfcImplementationIdentity(linkTx, asConsumer);
    consumer.key("slot").set(producer.withTx(linkTx));
    linkTx.prepareCfc();
    expect((await linkTx.commit()).error).toBeUndefined();
    await rt.idle();

    return rt;
  };

  /**
   * Writes `value` at the consumer document's `slot/bio`, which the link sends
   * to the producer document's `bio`, and returns the commit's error message.
   */
  const writeThroughLink = async (
    rt: Runtime,
    identity: ImplementationIdentity,
    value: string,
  ): Promise<string | undefined> => {
    const tx = rt.edit();
    const consumer = rt.getCell(
      signer.did(),
      "link-crossing-consumer",
      consumerSchema,
      tx,
    );
    await consumer.sync();
    setCfcImplementationIdentity(tx, identity);
    consumer.key("slot").key("bio").set(value);
    tx.prepareCfc();
    const error = (await tx.commit()).error?.message;
    await rt.idle();
    return error;
  };

  /** The producer document's `bio` as it now stands. */
  const producerBio = async (rt: Runtime): Promise<unknown> => {
    const producer = rt.getCell(
      signer.did(),
      "link-crossing-producer",
      producerSchema,
      rt.edit(),
    );
    await producer.sync();
    return producer.key("bio").get();
  };

  it("commits a write below a link made by the module the crossed link's claim names", async () => {
    const rt = await linkedSpace();
    expect(await writeThroughLink(rt, asProducer, "written")).toBeUndefined();
    expect(await producerBio(rt)).toBe("written");
  });

  it("refuses a write below a link made by a module that claim does not name, naming the linked-to coordinate", async () => {
    // `/bio` is the producer document's own coordinate, not the `slot/bio` the
    // write was addressed to, so the entry the check ran over is the one the
    // crossed link's schema declares.
    const rt = await linkedSpace();
    expect(await writeThroughLink(rt, asConsumer, "written")).toMatch(
      /writeAuthorizedBy failed at \/bio/,
    );
    expect(await producerBio(rt)).toBe("seed");
  });
});
