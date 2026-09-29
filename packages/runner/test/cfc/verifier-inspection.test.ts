import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import {
  loadStoredCfcEnvelope,
  prepareBoundaryCommit,
} from "../../src/cfc/prepare.ts";
import type { CfcMetadata } from "../../src/cfc/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-verifier-inspection");
const secret = "verifier-inspection-secret";
const intermediateSchema = {
  type: "object",
  ifc: { confidentiality: [secret] },
  properties: { value: { type: "string" } },
  required: ["value"],
} as const satisfies JSONSchema;
const closedSinkSchema = {
  type: "object",
  ifc: { maxConfidentiality: [] },
  properties: { value: { type: "string" } },
  required: ["value"],
} as const satisfies JSONSchema;

/** Exposes a backend with neither native nor journal write inspection. */
const withoutWriteInspection = (
  tx: IExtendedStorageTransaction,
): IExtendedStorageTransaction => {
  const raw = new Proxy(tx.tx, {
    get(target, property) {
      if (property === "getWriteAttemptLog") return undefined;
      if (property === "journal") {
        return {
          activity: () => {
            throw new Error("write inspection unavailable");
          },
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return new Proxy(tx, {
    get(target, property) {
      if (property === "tx") return raw;
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
};

describe("prepareBoundaryCommit()", () => {
  for (const inspectWrites of [true, false]) {
    it(`rederives labels from reused backend objects with write inspection ${inspectWrites ? "available" : "unavailable"}`, async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcFlowLabels: "off",
      });
      try {
        const metadata: CfcMetadata = {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["entry"],
              label: { confidentiality: ["old-root"] },
            }, {
              path: ["entry", "old"],
              label: { confidentiality: ["old-detail"] },
            }],
          },
        };
        const seed = runtime.edit();
        const source = runtime.getCell(signer.did(), "mutable-source")
          .getAsNormalizedFullLink();
        writeSeedEnvelopeDoc(seed, signer.did());
        seedStoredEnvelope(seed, { ...source, path: [] }, {
          value: { entry: { old: "a", new: "b" } },
          cfc: metadata,
        });
        expect((await seed.commit()).error).toBeUndefined();
        const tx = runtime.edit();
        try {
          const targets = ["first", "second"].map((name) =>
            runtime.getCell(signer.did(), `mutable-${name}`, undefined, tx)
              .getAsNormalizedFullLink()
          );
          for (const target of targets) {
            tx.writeValueOrThrow({ ...target, path: ["field"] }, "v");
            tx.recordCfcWritePolicyInput({
              kind: "link-write",
              target: { ...target, path: ["field"] },
              source: { ...source, path: ["entry"] },
              cfcLabelView: {
                version: 1,
                entries: [{
                  path: ["probe"],
                  label: { confidentiality: ["hint"] },
                }],
              },
            });
          }
          let inspections = 0;
          const backend = inspectWrites ? tx : withoutWriteInspection(tx);
          const view = new Proxy(backend, {
            get(target, property) {
              if (property === "getPotentiallyExternalReadActivities") {
                return () => {
                  if (++inspections === 2) {
                    metadata.labelMap.entries = [{
                      path: ["entry"],
                      label: { confidentiality: ["new-root"] },
                    }, {
                      path: ["entry", "new"],
                      label: { confidentiality: ["new-detail"] },
                    }];
                    expect(
                      tx.tx.write({ ...source, path: ["cfc"] }, metadata).ok,
                    )
                      .toBeDefined();
                  }
                  return target.getPotentiallyExternalReadActivities?.() ?? [];
                };
              }
              if (property === "readOrThrow") {
                return (
                  ...args: Parameters<
                    IExtendedStorageTransaction["readOrThrow"]
                  >
                ) => {
                  if (args[0].id === source.id && args[0].path[0] === "cfc") {
                    return metadata;
                  }
                  return target.readOrThrow(...args);
                };
              }
              const member = Reflect.get(target, property, target);
              return typeof member === "function"
                ? member.bind(target)
                : member;
            },
          });
          expect(prepareBoundaryCommit(view)).toEqual([]);
          expect(inspections).toBe(2);
          const envelope = loadStoredCfcEnvelope(tx, targets[1]);
          expect(envelope.status).toBe("loaded");
          if (envelope.status !== "loaded") throw new Error(envelope.status);
          const entries = envelope.metadata.labelMap.entries;
          expect(entries.some((entry) =>
            entry.path.join("/") === "field/new" &&
            entry.label.confidentiality?.includes("new-detail")
          )).toBe(true);
          expect(entries.flatMap((entry) => entry.label.confidentiality ?? []))
            .not.toContain("old-root");
          expect(entries.flatMap((entry) => entry.label.confidentiality ?? []))
            .not.toContain("old-detail");
        } finally {
          tx.abort();
        }
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });
  }

  it("clears metadata reuse when write inspection is unavailable", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    try {
      const tx = runtime.edit();
      const intermediate = runtime.getCell(
        signer.did(),
        "inspection-a-intermediate",
        intermediateSchema,
        tx,
      );
      intermediate.set({ value: "derived" });
      runtime.getCell(
        signer.did(),
        "inspection-b-sink",
        closedSinkSchema,
        tx,
      ).set(intermediate);

      try {
        // .set() records the value and schema; target A's preparation persists
        // the confidential envelope. Target B must then re-read that envelope
        // instead of reusing the absent metadata cached while checking A.
        expect(tx.readOrThrow({
          ...intermediate.getAsNormalizedFullLink(),
          path: ["cfc"],
        })).toBeUndefined();
        const reasons = prepareBoundaryCommit(withoutWriteInspection(tx));
        expect(reasons.some((reason) => reason.includes("maxConfidentiality")))
          .toBe(true);
      } finally {
        tx.abort();
      }
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });
});
