import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { runtimeWritePolicyAuthorization } from "../src/cfc/types.ts";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import { runtimeSecretLink } from "../src/runtime-secret.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("runtime secret ensure");
const space = signer.did();

const NAME = "test-salt";
const link = runtimeSecretLink(space, NAME);

describe("ensureRuntimeSecret()", () => {
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

  /** Ensures the secret in a transaction of its own and returns what it did. */
  const ensure = async (): Promise<string> => {
    const tx = runtime.edit();
    const secret = tx.ensureRuntimeSecret(
      space,
      NAME,
      runtimeWritePolicyAuthorization,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    return secret;
  };

  /** The value stored for the secret, read below the read chokepoint. */
  const stored = (): unknown => {
    const tx = runtime.edit();
    try {
      return tx.tx.read(toMemorySpaceAddress(link)).ok?.value;
    } finally {
      tx.abort("stored read");
    }
  };

  it("returns the value it mints", async () => {
    const minted = await ensure();

    expect(typeof minted).toBe("string");
    expect(stored()).toBe(minted);
  });

  it("returns the value already stored, and mints none", async () => {
    const minted = await ensure();

    expect(await ensure()).toBe(minted);
    expect(stored()).toBe(minted);
  });

  it("returns a fresh value in place of one stored with no writer claim", async () => {
    // The fixture's privileged write stands in for a writer without the write
    // chokepoint: it lands the value and records no claim.

    const tx = runtime.edit();
    (tx as ExtendedStorageTransaction).accessForTestingOnly
      .privilegedSystemWrite(
        { ...link, type: "application/json", path: ["value"] },
        "planted",
      );
    expect((await tx.commit().settled).error).toBeUndefined();

    const minted = await ensure();

    expect(minted).not.toBe("planted");
    expect(stored()).toBe(minted);
  });
});
