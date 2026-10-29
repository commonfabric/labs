/**
 * Finite reads through a self-reference consume its restrictions on every hop
 * and the reached leaf's current labels (CFC §8.2.4 and §8.2.7).
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-finite-self-traversal");
const space = signer.did();
const path = [...Array<string>(8).fill("self"), "leaf"];

describe("cfc-finite-self-traversal", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      experimental: { serverExecution: false },
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  for (
    const { route, labels } of [
      { route: "keyed", labels: ["neither", "reference", "leaf", "both"] },
      {
        route: "schema-selected",
        labels: ["neither", "reference", "leaf", "both"],
      },
    ] as const
  ) {
    describe(route, () => {
      for (const labeled of labels) {
        const behavior = {
          neither: "permits an unlabeled leaf",
          reference: "enforces reference confidentiality",
          leaf: "enforces leaf confidentiality",
          both: "enforces reference and leaf confidentiality",
        }[labeled];
        it(`${behavior} after eight self hops`, async () => {
          const entries: LabelMapEntry[] = [];
          if (labeled === "reference" || labeled === "both") {
            entries.push({
              path: ["self"],
              origin: "link",
              label: { confidentiality: ["reference-secret"] },
            });
          }
          if (labeled === "leaf" || labeled === "both") {
            entries.push({
              path: ["leaf"],
              label: { confidentiality: ["leaf-secret"] },
            });
          }

          const expectedConfidentiality = entries.flatMap((entry) =>
            entry.label.confidentiality ?? []
          );
          const seed = runtime.edit();
          writeSeedEnvelopeDoc(seed, space);
          const source = runtime.getCell(space, "source", undefined, seed);
          const link = source.getAsNormalizedFullLink();
          seedStoredEnvelope(seed, link, {
            value: { self: source.getAsLink(), leaf: "reached leaf" },
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: { version: 1, entries },
            },
          });
          expect((await seed.commit().settled).ok).toBeDefined();

          const tx = runtime.edit();
          const input = source.withTx(tx);
          let value: unknown;
          if (route === "keyed") {
            value = input.key(...path).get();
          } else {
            let schema: JSONSchema = { type: "string" };
            for (const part of path.toReversed()) {
              schema = { type: "object", properties: { [part]: schema } };
            }
            value = input.asSchema(schema).get();
            for (const part of path) {
              value = (value as Record<string, unknown>)[part];
            }
          }
          expect(value).toBe("reached leaf");
          expect(deriveFlowJoin(tx).confidentiality).toEqual(
            expectedConfidentiality,
          );

          const output = runtime.getCell(space, "public-output", undefined, tx);
          output.set(value);
          tx.prepareCfc();
          const result = await tx.commit().settled;
          if (labeled === "neither") {
            expect(result.ok).toBeDefined();
            expect(output.withTx(undefined).get()).toBe("reached leaf");
          } else {
            expect(isCfcEnforcementRejection(result.error)).toBe(true);
            expect(result.error?.message).toContain(
              "writer-fit confidentiality misfit",
            );
            expect(output.withTx(undefined).get()).toBeUndefined();
          }
        });
      }
    });
  }
});
