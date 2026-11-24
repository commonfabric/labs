import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import {
  type CfcConfClause,
  clauseReleasableBy,
} from "@commonfabric/memory/v2/cfc-release-authority";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { releaseCellConfidentiality } from "../src/cfc/confidentiality-release.ts";
import {
  CONFIDENTIALITY_RELEASE_WRITER,
  planConfidentialityRelease,
} from "../src/cfc/confidentiality-release-plan.ts";
import { commitCfcFieldValue } from "../src/cfc/label-representation.ts";
import { cfcLabelViewForResolvedCell } from "../src/cfc/label-view.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { labelMetadataTemplatesFor } from "../src/cfc/prepare.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { isAllowedAuthoredImportSpecifier } from "../src/sandbox/runtime-module-policy.ts";
import { getRuntimeModuleExports } from "../src/sandbox/runtime-modules.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-confidentiality-release",
);
const actor = signer.did();
const other = (await Identity.fromPassphrase("runner-cfc-release-other")).did();
const owner = cfcAtom.personalSpace(actor);

/** A document's schema without labels, as a reader that declares none sees it. */
const PLAIN = {
  type: "object",
  properties: { text: { type: "string" } },
} as const satisfies JSONSchema;

/** `PLAIN`, declaring `confidentiality` at the root. */
const declaring = (confidentiality: CfcConfClause[]) => ({
  ...PLAIN,
  ifc: { confidentiality },
});

describe("confidentiality release", () => {
  describe("clauseReleasableBy()", () => {
    it("returns `true` for a clause whose every alternative stands for the actor", () => {
      const clauses: CfcConfClause[] = [
        cfcAtom.user(actor),
        owner,
        cfcAtom.space(actor),
        { type: CFC_ATOM_TYPE.Resource, class: "Record", subject: actor },
        { type: owner.type, owner: commitCfcFieldValue(actor) },
        actor,
        { anyOf: [cfcAtom.user(actor), owner] },
      ];
      for (const clause of clauses) {
        expect(clauseReleasableBy(clause, actor)).toBe(true);
      }
    });

    it("returns `false` for a clause with any other alternative", () => {
      const clauses: CfcConfClause[] = [
        cfcAtom.user(other),
        cfcAtom.personalSpace(other),
        { anyOf: [cfcAtom.user(actor), cfcAtom.user(other)] },
        cfcAtom.space(other),
        { type: CFC_ATOM_TYPE.Space, id: commitCfcFieldValue(actor) },
        { type: owner.type, owner: commitCfcFieldValue(other) },
        { ...cfcAtom.user(actor), scope: "session" },
        cfcAtom.expires(1),
        "team",
        { anyOf: [] },
      ];
      for (const clause of clauses) {
        expect(clauseReleasableBy(clause, actor)).toBe(false);
      }
    });
  });

  describe("planConfidentialityRelease()", () => {
    const entry = (
      path: string[],
      label: LabelMapEntry["label"],
      extra: Partial<LabelMapEntry> = {},
    ): LabelMapEntry => ({ path, label, origin: "derived", ...extra });

    it("removes the released clauses from every entry at the path, whatever its origin or class", () => {
      const elsewhere = entry(["x"], { confidentiality: [owner] }, {
        origin: "declared",
      });
      const plan = planConfidentialityRelease({
        actor,
        path: [],
        entries: [
          entry([], { confidentiality: [owner] }, { observes: "shape" }),
          entry([], { confidentiality: [owner, "team"] }, {
            observes: "value",
          }),
          entry([], { confidentiality: [owner] }, { origin: "link" }),
          elsewhere,
        ],
        schema: undefined,
        keep: ["team"],
      });

      expect(plan.released).toEqual([owner]);
      expect(plan.entries).toEqual([
        entry([], { confidentiality: ["team"] }, { observes: "value" }),
        elsewhere,
      ]);
      expect(plan.entries[1]).toBe(elsewhere);
    });

    it("keeps an entry's integrity when its confidentiality is all released", () => {
      const plan = planConfidentialityRelease({
        actor,
        path: ["a"],
        entries: [entry(["a"], { confidentiality: [owner], integrity: ["i"] })],
        schema: undefined,
        keep: [],
      });

      expect(plan.entries).toEqual([entry(["a"], { integrity: ["i"] })]);
    });

    it("leaves an ancestor's entry that covers the path as it is", () => {
      const ancestor = entry([], { confidentiality: [owner] });
      const plan = planConfidentialityRelease({
        actor,
        path: ["a"],
        entries: [ancestor, entry(["a"], { confidentiality: [owner] })],
        schema: undefined,
        keep: [],
      });

      expect(plan.released).toEqual([owner]);
      expect(plan.entries).toEqual([ancestor]);
    });

    it("removes the released clauses from every entry a `*` segment matches at its depth, and from no other", () => {
      const others = [
        entry([], { confidentiality: [owner] }),
        entry(["a"], { confidentiality: [owner] }, { observes: "shape" }),
        entry(["a", "x", "y"], { confidentiality: [owner] }),
        entry(["b", "x"], { confidentiality: [owner] }),
      ];
      const plan = planConfidentialityRelease({
        actor,
        path: ["a", "*"],
        entries: [
          ...others,
          entry(["a", "*"], { confidentiality: [owner] }, {
            observes: "followRef",
          }),
          entry(["a", "*"], { confidentiality: [owner] }, {
            observes: "value",
          }),
          entry(["a", "x"], { confidentiality: [owner] }),
        ],
        schema: undefined,
        keep: [],
      });

      expect(plan.released).toEqual([owner]);
      expect(plan.paths).toEqual([["a", "*"], ["a", "x"]]);
      expect(plan.entries).toEqual(others);
    });

    it("leaves a wildcard entry that covers a concrete path as it is", () => {
      const wildcard = entry(["a", "*"], { confidentiality: [owner] });
      const plan = planConfidentialityRelease({
        actor,
        path: ["a", "x"],
        entries: [wildcard, entry(["a", "x"], { confidentiality: [owner] })],
        schema: undefined,
        keep: [],
      });

      expect(plan.paths).toEqual([["a", "x"]]);
      expect(plan.entries).toEqual([wildcard]);
    });

    it("keeps a stored commitment the input names in plaintext", () => {
      const committed = { type: owner.type, owner: commitCfcFieldValue(actor) };
      const entries = [entry([], { confidentiality: [committed] })];
      const plan = planConfidentialityRelease({
        actor,
        path: [],
        entries,
        schema: undefined,
        keep: [owner],
      });

      expect(plan.released).toEqual([]);
      expect(plan.entries).toBe(entries);
    });

    it("throws for a kept clause the path does not store", () => {
      expect(() =>
        planConfidentialityRelease({
          actor,
          path: [],
          entries: [
            entry([], { confidentiality: [owner] }),
            entry(["x"], { confidentiality: ["team"] }),
          ],
          schema: undefined,
          keep: ["team"],
        })
      ).toThrow("the path stores no such clause");
    });

    it("throws for a released clause the actor may not release", () => {
      expect(() =>
        planConfidentialityRelease({
          actor,
          path: [],
          entries: [entry([], { confidentiality: [owner, "team"] })],
          schema: undefined,
          keep: [],
        })
      ).toThrow(`is not ${actor}'s alone to release`);
    });

    it("returns the stored schema when it declares nothing released at the path", () => {
      const schema = {
        type: "object",
        properties: {
          a: { type: "string", ifc: { confidentiality: [owner] } },
        },
      } as const satisfies JSONSchema;
      const plan = planConfidentialityRelease({
        actor,
        path: [],
        entries: [entry([], { confidentiality: [owner] })],
        schema,
        keep: [],
      });

      expect(plan.schema).toBe(schema);
    });

    it("removes a declaration reached through properties, with its `observes`", () => {
      const schema = {
        type: "object",
        properties: {
          a: {
            type: "string",
            ifc: { confidentiality: [owner], observes: "value" },
          },
          b: { type: "string", ifc: { confidentiality: [owner] } },
        },
      } as const satisfies JSONSchema;
      const plan = planConfidentialityRelease({
        actor,
        path: ["a"],
        entries: [],
        schema,
        keep: [],
      });

      expect(plan.released).toEqual([owner]);
      expect(plan.schema).toEqual({
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "string", ifc: { confidentiality: [owner] } },
        },
      });
    });

    it("removes a declaration reached through `items` at a `*` segment", () => {
      const schema = {
        type: "object",
        properties: {
          list: {
            type: "array",
            items: { type: "string", ifc: { confidentiality: [owner] } },
          },
        },
      } as const satisfies JSONSchema;
      const plan = planConfidentialityRelease({
        actor,
        path: ["list", "*"],
        entries: [],
        schema,
        keep: [],
      });

      expect(plan.released).toEqual([owner]);
      expect(plan.paths).toEqual([["list", "*"]]);
      expect(plan.schema).toEqual({
        type: "object",
        properties: { list: { type: "array", items: { type: "string" } } },
      });
    });

    it("removes a declaration reached through `additionalProperties` at a `*` segment of a record naming no property", () => {
      const schema = {
        type: "object",
        properties: {
          record: {
            type: "object",
            additionalProperties: {
              type: "string",
              ifc: { confidentiality: [owner] },
            },
          },
        },
      } as const satisfies JSONSchema;
      const plan = planConfidentialityRelease({
        actor,
        path: ["record", "*"],
        entries: [],
        schema,
        keep: [],
      });

      expect(plan.released).toEqual([owner]);
      expect(plan.schema).toEqual({
        type: "object",
        properties: {
          record: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      });
    });

    it("removes the declaration at the one tuple position a concrete segment names", () => {
      const secret = {
        type: "string",
        ifc: { confidentiality: [owner] },
      } as const satisfies JSONSchema;
      const schema = {
        type: "object",
        properties: {
          tuple: { type: "array", prefixItems: [secret, secret] },
        },
      } as const satisfies JSONSchema;
      const plan = planConfidentialityRelease({
        actor,
        path: ["tuple", "1"],
        entries: [],
        schema,
        keep: [],
      });

      expect(plan.paths).toEqual([["tuple", "1"]]);
      expect(plan.schema).toEqual({
        type: "object",
        properties: {
          tuple: { type: "array", prefixItems: [secret, { type: "string" }] },
        },
      });
    });

    it("removes the declarations at every named property and tuple position a `*` segment matches", () => {
      const secret = {
        type: "string",
        ifc: { confidentiality: [owner] },
      } as const satisfies JSONSchema;
      const schema = {
        type: "object",
        properties: {
          record: {
            type: "object",
            properties: { a: secret, b: { type: "string" } },
          },
          tuple: { type: "array", prefixItems: [secret], items: secret },
        },
      } as const satisfies JSONSchema;
      const lower = (path: string[]) =>
        planConfidentialityRelease({
          actor,
          path,
          entries: [],
          schema,
          keep: [],
        });

      expect(lower(["record", "*"]).schema).toEqual({
        ...schema,
        properties: {
          ...schema.properties,
          record: {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "string" } },
          },
        },
      });
      expect(lower(["tuple", "*"]).paths).toEqual([
        ["tuple", "*"],
        ["tuple", "0"],
      ]);
      expect(lower(["tuple", "*"]).schema).toEqual({
        ...schema,
        properties: {
          ...schema.properties,
          tuple: {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "string" },
          },
        },
      });
    });

    it("throws for a declaration a `*` segment reaches through a reference", () => {
      const schema = {
        type: "object",
        $defs: {
          Secret: { type: "string", ifc: { confidentiality: [owner] } },
        },
        properties: {
          a: { $ref: "#/$defs/Secret" },
          b: { type: "string", ifc: { confidentiality: [owner] } },
        },
      } as const satisfies JSONSchema;

      expect(() =>
        planConfidentialityRelease({
          actor,
          path: ["*"],
          entries: [],
          schema,
          keep: [],
        })
      ).toThrow("which a release does not rewrite");
    });

    it("throws for a declaration reached through a reference", () => {
      const schema = {
        type: "object",
        $defs: {
          Secret: { type: "string", ifc: { confidentiality: [owner] } },
        },
        properties: {
          a: { $ref: "#/$defs/Secret" },
          b: { $ref: "#/$defs/Secret" },
        },
      } as const satisfies JSONSchema;

      expect(() =>
        planConfidentialityRelease({
          actor,
          path: ["a"],
          entries: [],
          schema,
          keep: [],
        })
      ).toThrow("which a release does not rewrite");
    });
  });

  describe("releasing a stored label", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let secret: Cell<{ text: string }>;

    /**
     * Writes a document through a schema declaring `confidentiality`, and
     * returns a handle on it whose own schema declares nothing, so what a
     * release finds is what the document stores.
     */
    const seed = async (
      rt: Runtime,
      cause: string,
      confidentiality: CfcConfClause[],
    ) => {
      const tx = rt.edit();
      rt.getCell<{ text: string }>(actor, cause, declaring(confidentiality))
        .withTx(tx).set({ text: "personal" });
      expect((await tx.commit().settled).error).toBeUndefined();
      return rt.getCell<{ text: string }>(actor, cause, PLAIN);
    };

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      secret = await seed(runtime, "runner-cfc-release-secret", [owner]);
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    /** The payload label-map entries `cell`'s document stores. */
    const storedEntries = (cell: Cell<unknown>) => {
      const tx = runtime.edit();
      try {
        return readStoredCfcMetadata(tx, cell.getAsNormalizedFullLink())
          ?.labelMap.entries;
      } finally {
        tx.abort();
      }
    };

    describe("releaseCellConfidentiality()", () => {
      it("commits the release with a receipt only the actor may read", async () => {
        const release = await releaseCellConfidentiality(secret, []);

        expect(release.released).toEqual([owner]);
        expect(storedEntries(secret)).toEqual([]);
        const tx = runtime.edit();
        const receipt = runtime.getCellFromLink(
          release.receipt!,
          undefined,
          tx,
        );
        expect(receipt.get()).toMatchObject({
          actor,
          space: actor,
          id: secret.getAsNormalizedFullLink().id,
          path: [],
          released: [owner],
          releasedDigests: release.releasedDigests,
          priorEnvelopeDigest: release.priorEnvelopeDigest,
          envelopeDigest: release.envelopeDigest,
        });
        expect(
          readStoredCfcMetadata(tx, release.receipt!)?.labelMap.entries
            .filter((entry) => entry.path.length === 0)
            .map((entry) => entry.label.confidentiality),
        ).toContainEqual([cfcAtom.user(actor)]);
        tx.abort();
      });

      it("derives the label-metadata templates again from the entries the release leaves", async () => {
        const kept: LabelMapEntry = {
          path: [],
          label: { confidentiality: [cfcAtom.personalSpace(other)] },
          origin: "derived",
          observes: "value",
        };
        const released: LabelMapEntry = {
          path: [],
          label: { confidentiality: [owner] },
          origin: "derived",
          observes: "shape",
        };
        const cell = runtime.getCell<unknown>(
          actor,
          "runner-cfc-release-templates",
        );
        const tx = runtime.edit();
        writeSeedEnvelopeDoc(tx, actor);
        seedStoredEnvelope(
          tx,
          { ...cell.getAsNormalizedFullLink(), path: [] },
          {
            value: { text: "t" },
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [
                  kept,
                  released,
                  ...labelMetadataTemplatesFor([kept, released]),
                ],
              },
            },
          } as never,
        );
        expect((await tx.commit().settled).error).toBeUndefined();
        const metadataOf = () => {
          const read = runtime.edit();
          try {
            return readStoredCfcMetadata(read, cell.getAsNormalizedFullLink());
          } finally {
            read.abort();
          }
        };
        expect(metadataOf()?.labelMap.documentEntries).toEqual(
          labelMetadataTemplatesFor([kept, released]),
        );

        await releaseCellConfidentiality(cell, [cfcAtom.personalSpace(other)]);

        expect(metadataOf()?.labelMap.entries).toEqual([kept]);
        expect(metadataOf()?.labelMap.documentEntries).toEqual(
          labelMetadataTemplatesFor([kept]),
        );
      });

      it("throws when the storage layer refuses the commit, and writes nothing", async () => {
        const before = storedEntries(secret);
        const edit = runtime.edit.bind(runtime);
        try {
          runtime.edit = (...args: Parameters<typeof runtime.edit>) => {
            const tx = edit(...args);
            const commit = tx.commit.bind(tx);
            tx.commit = (options) => {
              tx.abort(new Error("the space refused the write"));
              return commit(options);
            };
            return tx;
          };
          await expect(releaseCellConfidentiality(secret, [])).rejects
            .toThrow("Lowering confidentiality failed:");
        } finally {
          runtime.edit = edit;
        }
        expect(storedEntries(secret)).toEqual(before);
      });

      it("releases and records nothing when every stored clause is kept", async () => {
        const before = storedEntries(secret);

        const release = await releaseCellConfidentiality(secret, [owner]);

        expect(release.released).toEqual([]);
        expect(release.receipt).toBeUndefined();
        expect(release.envelopeDigest).toBe(release.priorEnvelopeDigest);
        expect(storedEntries(secret)).toEqual(before);
      });

      it("releases a clause stored as a digest commitment to the actor", async () => {
        const committed = {
          type: owner.type,
          owner: commitCfcFieldValue(actor),
        };
        const cell = await seed(
          runtime,
          "runner-cfc-release-committed",
          [committed],
        );

        const release = await releaseCellConfidentiality(cell, []);

        expect(release.released).toEqual([committed]);
        expect(storedEntries(cell)).toEqual([]);
      });

      it("refuses a clause the cell's own schema declares, and writes nothing", async () => {
        const before = storedEntries(secret);
        const declared = runtime.getCell<{ text: string }>(
          actor,
          "runner-cfc-release-secret",
          declaring([owner]),
        );

        await expect(releaseCellConfidentiality(declared, [])).rejects
          .toThrow("from a position a release does not rewrite");
        expect(storedEntries(secret)).toEqual(before);
      });

      it("refuses a clause the path shows from a wildcard position, and writes nothing", async () => {
        const list = runtime.getCell<{ items: string[] }>(
          actor,
          "runner-cfc-release-wildcard",
          {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: { type: "string", ifc: { confidentiality: [owner] } },
              },
            },
          },
        );
        const seed = runtime.edit();
        list.withTx(seed).set({ items: ["personal"] });
        expect((await seed.commit().settled).error).toBeUndefined();
        const before = storedEntries(list);

        await expect(
          releaseCellConfidentiality(list.key("items").key(0), []),
        ).rejects.toThrow("from a position a release does not rewrite");
        expect(storedEntries(list)).toEqual(before);
      });

      describe("at a wildcard entry", () => {
        // A catalog record whose wildcard entry labels every field, as a
        // derivation stamps one, with one field also labeled on its own.
        const committed = {
          type: owner.type,
          owner: commitCfcFieldValue(actor),
        };
        const record = ["rooms", "r"];
        const recordEntry: LabelMapEntry = {
          path: record,
          label: { confidentiality: [committed] },
          origin: "derived",
          observes: "shape",
        };

        /**
         * Stores the record with `recordEntry`, a wildcard entry under it
         * holding `wildcard`, and an entry at its `host` field, and returns
         * the document's cell.
         */
        const seedRecord = async (wildcard: CfcConfClause[]) => {
          const cell = runtime.getCell<unknown>(
            actor,
            "runner-cfc-release-rooms",
          );
          const tx = runtime.edit();
          writeSeedEnvelopeDoc(tx, actor);
          seedStoredEnvelope(tx, {
            ...cell.getAsNormalizedFullLink(),
            path: [],
          }, {
            value: { rooms: { r: { host: "h", title: "t" } } },
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [
                  recordEntry,
                  ...(["followRef", "shape", "value"] as const).map((
                    observes,
                  ) => ({
                    path: [...record, "*"],
                    label: { confidentiality: wildcard },
                    origin: "derived",
                    observes,
                  })),
                  {
                    path: [...record, "host"],
                    label: { confidentiality: [committed] },
                    origin: "derived",
                    observes: "value",
                  },
                ],
              },
            },
          } as never);
          expect((await tx.commit().settled).error).toBeUndefined();
          return cell;
        };

        /** The confidentiality `cell` shows at `path`. */
        const shownAt = (cell: Cell<unknown>, path: string[]) =>
          cfcLabelViewForResolvedCell(cell.key(...path))?.entries
            .filter((entry) => entry.path.length === 0)
            .flatMap((entry) => entry.label.confidentiality ?? []) ?? [];

        it("lowers the wildcard entry and every position it matches, with a receipt naming each", async () => {
          const cell = await seedRecord([committed]);
          expect(shownAt(cell, [...record, "title"])).toContainEqual(committed);

          const release = await releaseCellConfidentiality(
            cell.key(...record, "*"),
            [],
          );

          expect(release.released).toEqual([committed]);
          expect(release.paths).toEqual([
            [...record, "*"],
            [...record, "host"],
          ]);
          expect(storedEntries(cell)).toEqual([recordEntry]);
          expect(shownAt(cell, [...record, "title"])).toEqual([]);
          expect(shownAt(cell, [...record, "host"])).toEqual([]);
          const tx = runtime.edit();
          expect(
            runtime.getCellFromLink(release.receipt!, undefined, tx).get(),
          ).toMatchObject({
            path: [...record, "*"],
            paths: [[...record, "*"], [...record, "host"]],
            released: [committed],
          });
          tx.abort();
        });

        it("refuses a concrete path the wildcard entry covers, and writes nothing", async () => {
          const cell = await seedRecord([committed]);
          const before = storedEntries(cell);

          await expect(
            releaseCellConfidentiality(cell.key(...record, "host"), []),
          ).rejects.toThrow("from a position a release does not rewrite");
          expect(storedEntries(cell)).toEqual(before);
        });

        it("refuses a wildcard entry holding a clause anyone else shares, and writes nothing", async () => {
          const cell = await seedRecord([committed, cfcAtom.user(other)]);
          const before = storedEntries(cell);

          await expect(
            releaseCellConfidentiality(cell.key(...record, "*"), []),
          ).rejects.toThrow(`is not ${actor}'s alone to release`);
          expect(storedEntries(cell)).toEqual(before);
        });
      });

      describe("at a link slot", () => {
        // A document whose `profile` slot holds a link to `secret`, with the
        // slot's own label, as a write after a labeled read stamps one,
        // holding a clause `secret` does not.
        const slotEntry: LabelMapEntry = {
          path: ["profile"],
          label: { confidentiality: [cfcAtom.user(actor)] },
          origin: "link",
          observes: "followRef",
        };

        /** Stores the document with `link` in its slot, and returns its cell. */
        const seedSlot = async (cause: string, link: unknown) => {
          const cell = runtime.getCell<unknown>(actor, cause);
          const tx = runtime.edit();
          writeSeedEnvelopeDoc(tx, actor);
          seedStoredEnvelope(tx, {
            ...cell.getAsNormalizedFullLink(),
            path: [],
          }, {
            value: { profile: link },
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: { version: 1, entries: [slotEntry] },
            },
          } as never);
          expect((await tx.commit().settled).error).toBeUndefined();
          return cell;
        };

        it("lowers the slot's own label and leaves its target's", async () => {
          const cell = await seedSlot(
            "runner-cfc-release-slot-link",
            secret.getAsLink(),
          );
          const target = storedEntries(secret);

          const release = await releaseCellConfidentiality(
            cell.key("profile"),
            [],
          );

          expect(release.released).toEqual([cfcAtom.user(actor)]);
          expect(release.paths).toEqual([["profile"]]);
          expect(storedEntries(cell)).toEqual([]);
          expect(storedEntries(secret)).toEqual(target);
        });

        it("lowers a write redirect's own label and leaves its target's, as a link slot", async () => {
          const cell = await seedSlot(
            "runner-cfc-release-slot-redirect",
            secret.getAsWriteRedirectLink(),
          );
          const target = storedEntries(secret);

          const release = await releaseCellConfidentiality(
            cell.key("profile"),
            [],
            { linkSlot: true },
          );

          expect(release.released).toEqual([cfcAtom.user(actor)]);
          expect(release.paths).toEqual([["profile"]]);
          expect(storedEntries(cell)).toEqual([]);
          expect(storedEntries(secret)).toEqual(target);
        });

        it("refuses a write redirect's own label when following it, and writes nothing", async () => {
          const cell = await seedSlot(
            "runner-cfc-release-slot-followed",
            secret.getAsWriteRedirectLink(),
          );
          const target = storedEntries(secret);

          await expect(releaseCellConfidentiality(cell.key("profile"), []))
            .rejects.toThrow("the label of a write redirect the path follows");
          expect(storedEntries(cell)).toEqual([slotEntry]);
          expect(storedEntries(secret)).toEqual(target);
        });
      });

      describe("through a write redirect in an unlabeled slot", () => {
        // A document whose `profile` slot holds a write redirect to `secret`
        // and no label of its own, so the release lowers `secret`.

        /**
         * Stores the document with `link` in its slot, in an envelope of
         * `version`, and returns its cell.
         */
        const seedRedirect = async (
          cause: string,
          link: unknown,
          version = 1,
        ) => {
          const cell = runtime.getCell<unknown>(actor, cause);
          const tx = runtime.edit();
          writeSeedEnvelopeDoc(tx, actor);
          seedStoredEnvelope(tx, {
            ...cell.getAsNormalizedFullLink(),
            path: [],
          }, {
            value: { profile: link },
            cfc: {
              version,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: { version: 1, entries: [] },
            },
          } as never);
          expect((await tx.commit().settled).error).toBeUndefined();
          return cell;
        };

        it("lowers the document the redirect leads to", async () => {
          const cell = await seedRedirect(
            "runner-cfc-release-redirect",
            secret.getAsWriteRedirectLink(),
          );

          const release = await releaseCellConfidentiality(
            cell.key("profile"),
            [],
          );

          expect(release.released).toEqual([owner]);
          expect(storedEntries(secret)).toEqual([]);
        });

        it("fails at the commit when the slot is retargeted as it commits, and writes nothing", async () => {
          // Nothing yields between the release resolving the path and its
          // commit, so the retargeting lands as the commit begins, as another
          // client's would reach the store first.

          const cause = "runner-cfc-release-redirect-retargeted";
          const cell = await seedRedirect(
            cause,
            secret.getAsWriteRedirectLink(),
          );
          const elsewhere = await seed(
            runtime,
            "runner-cfc-release-elsewhere",
            [owner],
          );
          const target = storedEntries(secret);
          const edit = runtime.edit.bind(runtime);
          try {
            runtime.edit = (...args: Parameters<typeof runtime.edit>) => {
              const tx = edit(...args);
              const commit = tx.commit.bind(tx);
              tx.commit = (options) =>
                createTransactionCommitReceipt((async () => {
                  runtime.edit = edit;
                  await seedRedirect(cause, elsewhere.getAsWriteRedirectLink());
                  return await commit(options).settled;
                })());
              return tx;
            };
            await expect(releaseCellConfidentiality(cell.key("profile"), []))
              .rejects.toThrow("Lowering confidentiality failed");
          } finally {
            runtime.edit = edit;
          }
          expect(storedEntries(secret)).toEqual(target);
        });

        it("throws when the labels of the document holding the slot cannot be read, and writes nothing", async () => {
          const cell = await seedRedirect(
            "runner-cfc-release-redirect-unreadable",
            secret.getAsWriteRedirectLink(),
            3,
          );
          const target = storedEntries(secret);

          await expect(releaseCellConfidentiality(cell.key("profile"), []))
            .rejects.toThrow(
              "Cannot lower confidentiality: the labels at the path could not be read.",
            );
          expect(storedEntries(secret)).toEqual(target);
        });
      });

      it("keeps a version-2 envelope at version 2", async () => {
        const v2Storage = StorageManager.emulate({ as: signer });
        const v2 = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager: v2Storage,
          cfcContentAddressedLabels: true,
        });
        try {
          const cell = await seed(v2, "runner-cfc-v2", [
            owner,
            cfcAtom.user(actor),
          ]);
          const stored = () => {
            const tx = v2.edit();
            try {
              return readStoredCfcMetadata(tx, cell.getAsNormalizedFullLink());
            } finally {
              tx.abort();
            }
          };
          expect(stored()?.version).toBe(2);

          await releaseCellConfidentiality(cell, [cfcAtom.user(actor)]);

          expect(stored()?.version).toBe(2);
          expect(
            stored()?.labelMap.entries.map((entry) =>
              entry.label.confidentiality
            ),
          ).toEqual([[cfcAtom.user(actor)]]);
        } finally {
          await v2.dispose();
          await v2Storage.close();
        }
      });
    });

    describe("releaseCfcConfidentiality()", () => {
      const input = () => {
        const link = secret.getAsNormalizedFullLink();
        return { space: link.space, id: link.id, path: [], keep: [] };
      };

      it("throws without the release writer's identity, and writes nothing", () => {
        const tx = runtime.edit();
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: "some-other-builtin",
        });

        expect(() => tx.releaseCfcConfidentiality(input())).toThrow(
          CONFIDENTIALITY_RELEASE_WRITER,
        );
        expect(
          readStoredCfcMetadata(tx, secret.getAsNormalizedFullLink())
            ?.labelMap.entries.map((entry) => entry.label.confidentiality),
        ).toEqual([[owner]]);
        tx.abort();
      });

      it("throws for a document outside the acting principal's own space", () => {
        const tx = runtime.edit();
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: CONFIDENTIALITY_RELEASE_WRITER,
        });

        expect(() => tx.releaseCfcConfidentiality({ ...input(), space: other }))
          .toThrow("only in their own space");
        tx.abort();
      });

      it("throws for a transaction with no authenticated acting principal", async () => {
        const anonymousStorage = StorageManager.emulate({ as: signer });
        const anonymous = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager: anonymousStorage,
          trustSnapshotProvider: () => ({
            id: "no-actor",
            actingPrincipal: "",
          }),
        });
        try {
          const tx = anonymous.edit();
          setCfcImplementationIdentity(tx, {
            kind: "builtin",
            builtinId: CONFIDENTIALITY_RELEASE_WRITER,
          });

          expect(() => tx.releaseCfcConfidentiality(input())).toThrow(
            "authenticated acting principal",
          );
          tx.abort();
        } finally {
          await anonymous.dispose();
          await anonymousStorage.close();
        }
      });
    });
  });

  it("is not importable from a pattern", () => {
    expect(
      isAllowedAuthoredImportSpecifier(
        "@commonfabric/runner/cfc/confidentiality-release",
      ),
    ).toBe(false);
    const { runtimeExports } = getRuntimeModuleExports();
    expect(Object.keys(runtimeExports)).toContain("commonfabric/cfc");
    for (const namespace of Object.values(runtimeExports)) {
      for (const [name, value] of Object.entries(namespace)) {
        expect(name).not.toMatch(/ConfidentialityRelease|ReleaseCfc/);
        expect([releaseCellConfidentiality, planConfidentialityRelease]).not
          .toContain(value);
      }
    }
  });
});
