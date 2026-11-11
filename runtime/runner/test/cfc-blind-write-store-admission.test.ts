import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-blind-write-admission",
);
const other = (await Identity.fromPassphrase(
  "runner-cfc-blind-write-admission other",
)).did();

/** A schema declaring a confidentiality clause on `secret`. */
const LABELED = {
  type: "object",
  properties: {
    secret: {
      type: "string",
      ifc: {
        confidentiality: [{
          type: "https://commonfabric.org/cfc/atom/PersonalSpace",
          owner: other,
        }],
      },
    },
  },
} as const satisfies JSONSchema;

describe("cfc-blind-write-store-admission", () => {
  // The store refuses a commit that leaves a stored declared label path with
  // no declared entry. A runtime writes blind when its session never loaded
  // the document it writes, so its transaction can't see the stored
  // envelope. Each case seeds a document whose stored envelope declares a
  // clause, then writes it from a second session that never synced it,
  // through the runtime's own write paths rather than a hand-built envelope:
  // the UI input's blind leaf overwrite, and a compare-and-set write retried.

  const withSeededDocument = async (
    name: string,
    body: (context: {
      server: MemoryV2Server.Server;
      cause: string;
    }) => Promise<void>,
  ): Promise<void> => {
    const server = await newSharedServer();
    try {
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: storage,
      });
      try {
        const tx = runtime.edit();
        runtime.getCell(signer.did(), name, LABELED, tx).set({
          secret: "one",
        });
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await storage.synced();
      } finally {
        await runtime.dispose();
        await storage.close();
      }
      await body({ server, cause: name });
    } finally {
      await server.close?.();
    }
  };

  const blindWrite = async (
    server: MemoryV2Server.Server,
    cause: string,
    schema: JSONSchema | undefined,
    blind: boolean,
  ) => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
    });
    try {
      const cell = runtime.getCell<{ secret: string }>(
        signer.did(),
        cause,
        schema,
      );
      // A blind write is the UI-input leaf overwrite, which retries; any
      // other write is a compare-and-set, retried here as a caller does.
      const result = blind
        ? await runtime.commitUiCellWrite(cell.key("secret"), "two", {
          blind,
        })
        : await runtime.editWithRetry((tx) => {
          cell.withTx(tx).key("secret").set("two");
        });
      await storage.synced();
      return result;
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  };

  const storedEnvelope = async (
    server: MemoryV2Server.Server,
    cause: string,
  ) => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
    });
    try {
      const cell = runtime.getCell(signer.did(), cause, LABELED);
      await cell.sync();
      const tx = runtime.edit();
      const stored = tx.readOrThrow({
        ...cell.getAsNormalizedFullLink(),
        type: "application/json",
        path: [],
      } as never) as {
        value?: unknown;
        cfc?: { labelMap?: { entries?: { origin?: string }[] } };
      };
      await tx.commit().settled;
      return stored;
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  };

  it("commits a blind UI write through a cell whose schema declares the clause from a session that never loaded the document, keeping the declared entry", async () => {
    await withSeededDocument(
      "blind-labeled",
      async ({ server, cause }) => {
        const result = await blindWrite(server, cause, LABELED, true);
        expect(result.error).toBeUndefined();
        const stored = await storedEnvelope(server, cause);
        expect(stored.value).toEqual({ secret: "two" });
        expect(
          (stored.cfc?.labelMap?.entries ?? []).some((entry) =>
            entry.origin === "declared"
          ),
        ).toBe(true);
      },
    );
  });

  it("commits a blind UI write through a cell with no schema from a session that never loaded the document, keeping the declared entry", async () => {
    await withSeededDocument(
      "blind-unschemad",
      async ({ server, cause }) => {
        const result = await blindWrite(server, cause, undefined, true);
        expect(result.error).toBeUndefined();
        const stored = await storedEnvelope(server, cause);
        expect(stored.value).toEqual({ secret: "two" });
        expect(
          (stored.cfc?.labelMap?.entries ?? []).some((entry) =>
            entry.origin === "declared"
          ),
        ).toBe(true);
      },
    );
  });

  it("commits a retried compare-and-set write through a cell whose schema declares the clause from a session that never loaded the document, keeping the declared entry", async () => {
    await withSeededDocument(
      "cas-labeled",
      async ({ server, cause }) => {
        const result = await blindWrite(server, cause, LABELED, false);
        expect(result.error).toBeUndefined();
        const stored = await storedEnvelope(server, cause);
        expect(stored.value).toEqual({ secret: "two" });
        expect(
          (stored.cfc?.labelMap?.entries ?? []).some((entry) =>
            entry.origin === "declared"
          ),
        ).toBe(true);
      },
    );
  });

  it("commits a retried compare-and-set write through a cell with no schema from a session that never loaded the document, keeping the declared entry", async () => {
    await withSeededDocument(
      "cas-unschemad",
      async ({ server, cause }) => {
        const result = await blindWrite(server, cause, undefined, false);
        expect(result.error).toBeUndefined();
        const stored = await storedEnvelope(server, cause);
        expect(stored.value).toEqual({ secret: "two" });
        expect(
          (stored.cfc?.labelMap?.entries ?? []).some((entry) =>
            entry.origin === "declared"
          ),
        ).toBe(true);
      },
    );
  });
});
