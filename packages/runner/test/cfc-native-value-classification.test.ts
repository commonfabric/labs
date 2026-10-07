/**
 * CFC content classification labels native unavailable primitives and refuses
 * codec-held instances whose references are not structurally walkable.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import {
  isUnavailable,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
} from "@commonfabric/data-model/availability";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";

import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-native-value-classification");
const space = signer.did();
const secret = "native-classification-private";

describe("CFC native value classification", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const seed = async () => {
    const tx = runtime.edit();
    const source = runtime.getCell<FabricValue>(space, "source", undefined, tx);
    const output = runtime.getCell<FabricValue>(space, "output", undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, {
      ...toMemorySpaceAddress(source.getAsNormalizedFullLink()),
      path: [],
    }, {
      value: "private source",
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [secret] } }],
        },
      },
    });
    output.set("previous");
    expect((await tx.commit().settled).ok).toBeDefined();
    return { source: source.withTx(), output: output.withTx() };
  };

  for (const nested of [false, true]) {
    for (const writeKind of ["transaction", "cell"] as const) {
      it(`refuses a ${nested ? "nested" : "root"} link-bearing instance written through a ${writeKind}`, async () => {
        const { source, output } = await seed();
        const tx = runtime.edit();
        try {
          expect(source.withTx(tx).getRaw()).toBe("private source");
          const failure = new FabricError({
            type: "Error",
            message: "codec-held reference",
            stack: undefined,
            cause: source.getAsLink(),
          });
          const value = nested ? { failure } : failure;
          if (writeKind === "cell") output.withTx(tx).set(value);
          else {
            tx.writeOrThrow({
              ...toMemorySpaceAddress(output.getAsNormalizedFullLink()),
              path: ["value"],
            }, value);
          }
          tx.prepareCfc();
          expect(tx.getCfcState().prepare.status).toBe("invalidated");
          const settled = await tx.commit().settled;
          expect(settled.ok).toBeUndefined();
          expect(settled.error?.name).toBe("CommitPreparationError");
          expect(settled.error?.message).toContain(
            "Cannot yet handle `FabricError` (a `FabricInstance`) in a structural walk.",
          );
        } finally {
          tx.abort();
        }
        expect(output.getRaw()).toBe("previous");
      });
    }

    for (
      const [name, marker] of [
        ["pending", UNAVAILABLE_PENDING],
        ["syncing", UNAVAILABLE_SYNCING],
        ["error", unavailableError("provider unavailable", "provider")],
      ] as const
    ) {
      it(`labels a ${nested ? "nested" : "root"} native ${name} marker as content`, async () => {
        const { source, output } = await seed();
        const tx = runtime.edit();
        expect(source.withTx(tx).getRaw()).toBe("private source");
        output.withTx(tx).set(nested ? { marker } : marker);
        tx.prepareCfc();
        expect((await tx.commit().settled).ok).toBeDefined();
        const replica = storageManager.open(space).replica as unknown as {
          getDocument(id: string): {
            cfc?: {
              labelMap?: {
                entries: {
                  path: string[];
                  origin?: string;
                  label: { confidentiality?: string[] };
                }[];
              };
            };
          } | undefined;
        };
        const entries = replica.getDocument(
          output.getAsNormalizedFullLink().id,
        )?.cfc?.labelMap?.entries ?? [];
        const expectedPath = nested ? ["marker"] : [];
        expect(
          entries.some((entry) =>
            entry.path.length === expectedPath.length &&
            entry.path.every((part, index) => part === expectedPath[index]) &&
            entry.origin === "derived" &&
            entry.label.confidentiality?.includes(secret)
          ),
        ).toBe(true);
        const value = output.getRaw();
        const actual = nested
          ? (value as { marker: FabricValue }).marker
          : value;
        expect(isUnavailable(actual)).toBe(true);
        if (!isUnavailable(actual)) throw new Error("Expected native marker");
        expect(actual.reason).toBe(marker.reason);
        if (actual.reason === "error") {
          expect(actual.errorKind).toBe(marker.errorKind);
          expect(actual.errorMessage).toBe(marker.errorMessage);
        }
      });
    }
  }
});
