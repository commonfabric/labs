import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { wishStateSchemaForResult } from "../src/builtins/wish-schema.ts";
import { Runtime } from "../src/runtime.ts";
import { validateAndTransformResult } from "../src/schema.ts";
import { UnresolvedInputError } from "../src/schema-view.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isInternalVerifierRead } from "../src/storage/reactivity-log.ts";
import { assertValidUnavailableInputPolicy } from "../src/unavailable-input-policy.ts";

const signer = await Identity.fromPassphrase(
  "availability schema support coverage",
);
const space = signer.did();
const foreignSpace = (await Identity.fromPassphrase("absent linked document"))
  .did();

describe("availability schema support coverage", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  });

  it("rejects availability policy entries with missing or extra keys", () => {
    for (
      const policy of [
        [{ path: [] }],
        [{ path: [], reasons: ["pending"], extra: true }],
      ]
    ) {
      expect(() => assertValidUnavailableInputPolicy(policy)).toThrow(
        /must contain only path and reasons/,
      );
    }
  });

  it("wraps boolean wish result schemas as cells", () => {
    expect(wishStateSchemaForResult(true)).toMatchObject({
      properties: {
        result: {
          anyOf: [
            { type: "undefined" },
            { type: "FabricUnavailable" },
            { asCell: ["cell"] },
          ],
        },
        candidates: {
          items: { asCell: ["cell"] },
        },
      },
    });
  });

  it("uses a fallback error when linked synchronization has no detail", () => {
    const source = runtime.getCell(space, "missing-link-source", undefined, tx);
    const target = runtime.getCell<number>(
      foreignSpace,
      "missing-link-target",
      { type: "number" },
    );
    source.set(42);

    runtime.ensureLinkedDocLoaded = (_link) => "error";
    runtime.linkedDocLoadError = (_link) => undefined;

    const originalReadOrThrow = tx.readOrThrow.bind(tx);
    const unresolved = new UnresolvedInputError(
      target.getAsNormalizedFullLink(),
    );
    tx.readOrThrow = ((address, options) => {
      if (isInternalVerifierRead(options?.meta)) throw unresolved;
      return originalReadOrThrow(address, options);
    }) as IExtendedStorageTransaction["readOrThrow"];
    try {
      const result = validateAndTransformResult(runtime, tx, {
        ...source.getAsNormalizedFullLink(),
        schema: { type: "number" },
      });
      expect(result).toMatchObject({
        error: unresolved,
        unavailableReason: "error",
        unavailableError: new Error("Linked document synchronization failed"),
      });
    } finally {
      tx.readOrThrow = originalReadOrThrow;
    }
  });

  it("throws unexpected storage errors from the verifier read", () => {
    const source = runtime.getCell<number>(
      space,
      "unexpected-read-error",
      { type: "number" },
      tx,
    );
    source.set(42);

    const originalReadOrThrow = tx.readOrThrow.bind(tx);
    tx.readOrThrow = ((address, options) => {
      if (isInternalVerifierRead(options?.meta)) {
        throw new Error("unexpected verifier failure");
      }
      return originalReadOrThrow(address, options);
    }) as IExtendedStorageTransaction["readOrThrow"];

    expect(() =>
      validateAndTransformResult(
        runtime,
        tx,
        source.getAsNormalizedFullLink(),
      )
    ).toThrow(/unexpected verifier failure/);
    tx.readOrThrow = originalReadOrThrow;
  });
});
