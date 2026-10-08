import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { runtimeWritePolicyAuthorization } from "../src/cfc/types.ts";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  readRuntimeSecret,
  runtimeSecretLink,
  RuntimeSecretUnresolvedError,
} from "../src/runtime-secret.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type {
  IExtendedStorageTransaction,
  Metadata,
} from "../src/storage/interface.ts";
import { internalVerifierRead } from "../src/storage/reactivity-log.ts";

const signer = await Identity.fromPassphrase("runner-runtime-secret");
const space = signer.did();

const NAME = "test-salt";
const link = runtimeSecretLink(space, NAME);

describe("runtime-secret", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Commits `edit` in a transaction of its own. */
  const commit = async (
    edit: (tx: IExtendedStorageTransaction) => void,
  ): Promise<void> => {
    const tx = runtime.edit();
    edit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /** Mints the secret in a transaction of its own. */
  const mint = () =>
    commit((tx) =>
      tx.ensureRuntimeSecret(space, NAME, runtimeWritePolicyAuthorization)
    );

  /** The value stored for the secret, read as the runtime reads it. */
  const stored = (): unknown => {
    const tx = runtime.edit();
    try {
      // Below the transaction layer, which is where the read chokepoint is.
      return tx.tx.read(toMemorySpaceAddress(link)).ok?.value;
    } finally {
      tx.abort("stored read");
    }
  };

  describe("ensureRuntimeSecret()", () => {
    it("mints one value and keeps it", async () => {
      await mint();
      const first = stored();
      expect(typeof first).toBe("string");

      await mint();
      expect(stored()).toBe(first);
    });

    it("replaces a value stored with no writer claim", async () => {
      // A value written into the namespace by a runtime without the write
      // chokepoint. The fixture's privileged write stands in for that writer:
      // it lands the value and records no claim.
      await commit((tx) =>
        (tx as ExtendedStorageTransaction).accessForTestingOnly
          .privilegedSystemWrite(
            { ...link, type: "application/json", path: ["value"] },
            "planted",
          )
      );
      expect(stored()).toBe("planted");

      await mint();
      expect(typeof stored()).toBe("string");
      expect(stored()).not.toBe("planted");
    });
  });

  describe("readRuntimeSecret()", () => {
    it("returns the minted value to the runtime", async () => {
      await mint();

      const tx = runtime.edit();
      try {
        expect(readRuntimeSecret(tx, space, NAME)).toBe(stored());
      } finally {
        tx.abort("runtime read");
      }
    });

    /**
     * A stand-in for a replica that holds the secret's document but not the
     * schema document its metadata names, which a frame delivering the
     * metadata without it leaves: `tx`, reading the stored metadata with its
     * schema hash swapped for one that neither the replica nor the schema
     * registry holds, and reading `held` as the secret's value when given.
     */
    const unresolvableReplica = (
      tx: IExtendedStorageTransaction,
      held?: unknown,
    ): IExtendedStorageTransaction => {
      const unresolvable = internSchemaAsTaggedHashString({
        type: "string",
        description: "a schema no replica and no registry holds",
      });
      return new Proxy(tx, {
        get(target, property) {
          if (property === "readOrThrow") {
            return (
              address: Parameters<
                IExtendedStorageTransaction["readOrThrow"]
              >[0],
              options: Parameters<
                IExtendedStorageTransaction["readOrThrow"]
              >[1],
            ) => {
              const value = target.readOrThrow(address, options);
              return address.id === link.id && address.path.length === 1 &&
                  address.path[0] === "cfc" && isObjectNotArray(value)
                ? { ...value, schemaHash: unresolvable }
                : value;
            };
          }
          if (property === "readValueOrThrow" && held !== undefined) {
            return (
              address: Parameters<
                IExtendedStorageTransaction["readValueOrThrow"]
              >[0],
              options: Parameters<
                IExtendedStorageTransaction["readValueOrThrow"]
              >[1],
            ) =>
              address.id === link.id
                ? held
                : target.readValueOrThrow(address, options);
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    it("throws, rather than returning `undefined`, when the stored schema cannot be resolved", async () => {
      // Reading that as "no writer claim" would have the mint write over a
      // trusted secret, and nothing in its commit would catch the overwrite.
      await mint();

      const tx = runtime.edit();
      try {
        expect(() => readRuntimeSecret(unresolvableReplica(tx), space, NAME))
          .toThrow(RuntimeSecretUnresolvedError);
      } finally {
        tx.abort("unresolvable schema");
      }
    });

    it("throws over a value that is not a string when the stored schema cannot be resolved", async () => {
      // No secret the runtime mints is anything but a string, and still a
      // value whose writer is unknown is never one the mint writes over.
      await mint();

      const tx = runtime.edit();
      try {
        expect(() =>
          readRuntimeSecret(unresolvableReplica(tx, 42), space, NAME)
        ).toThrow(RuntimeSecretUnresolvedError);
      } finally {
        tx.abort("unresolvable schema over a number");
      }
    });
  });

  describe("the namespace", () => {
    it("refuses a write from outside the runtime", async () => {
      await mint();

      const tx = runtime.edit();
      try {
        expect(() => runtime.getCellFromLink(link, undefined, tx).set("known"))
          .toThrow(/runtime secret/);
      } finally {
        tx.abort("refused write");
      }
    });

    it("refuses a read from outside the runtime", async () => {
      await mint();

      const tx = runtime.edit();
      try {
        expect(() => runtime.getCellFromLink(link, undefined, tx).get())
          .toThrow(/runtime secret/);
        expect(() => tx.readValueOrThrow(link)).toThrow(/runtime secret/);
        expect(() => tx.readValueOrThrow(link, { meta: internalVerifierRead }))
          .toThrow(/runtime secret/);
      } finally {
        tx.abort("refused read");
      }
    });

    it("refuses a read whose metadata answers every lookup", async () => {
      // A cell read hands its caller's metadata to the transaction, so code
      // holding a cell chooses it, a proxy included.
      await mint();

      const forged = new Proxy({}, { get: () => true }) as Metadata;
      const tx = runtime.edit();
      try {
        expect(() => tx.readValueOrThrow(link, { meta: forged })).toThrow(
          /runtime secret/,
        );
      } finally {
        tx.abort("forged read");
      }
    });

    it("refuses a tracked read of the value among other paths", async () => {
      await mint();

      const tx = runtime.edit();
      try {
        expect(() =>
          tx.trackReadPaths?.(
            { space, id: link.id, type: "application/json" },
            [["cfc"], ["value"]],
          )
        ).toThrow(/runtime secret/);
      } finally {
        tx.abort("refused tracked read");
      }
    });

    it("admits a read of the label envelope", async () => {
      await mint();

      const tx = runtime.edit();
      try {
        expect(
          tx.readOrThrow({
            space,
            id: link.id,
            type: "application/json",
            path: ["cfc"],
          }),
        ).toBeDefined();
      } finally {
        tx.abort("envelope read");
      }
    });
  });
});
