import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { encodeDagCbor } from "@commonfabric/identity/dag-cbor";
import type { URI } from "@commonfabric/memory/interface";
import { cfcCanonicalClauseDigest } from "@commonfabric/memory/v2/cfc-clause-identity";
import {
  ownerReleaseByIntentRecord,
  ownerReleaseByIntentRecordId,
  type OwnerReleaseByIntentRequest,
  ownerReleaseByIntentRequest,
  ownerReleaseByIntentRequestDigest,
  ownerReleaseByIntentSignature,
  ownerReleaseByIntentSignedBytes,
  type SignedOwnerReleaseByIntentRequest,
} from "@commonfabric/memory/v2/cfc-owner-release-by-intent";
import type { CfcConfClause } from "@commonfabric/memory/v2/cfc-release-authority";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import {
  releaseCellConfidentiality,
  releaseConfidentialityByIntent,
  storedClausesForRelease,
} from "../src/cfc/confidentiality-release.ts";
import {
  clausesStoredForRelease,
  OWNER_RELEASE_BY_INTENT_WRITER,
  planConfidentialityReleaseByIntent,
} from "../src/cfc/confidentiality-release-plan.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { labelMetadataTemplatesFor } from "../src/cfc/prepare.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-owner-release-by-intent",
);
const actor = signer.did();
const intruder = await Identity.fromPassphrase(
  "runner-cfc-release-by-intent-intruder",
);
const own = cfcAtom.personalSpace(actor);

/** Ten other principals' clauses, as an earlier setup stamps them. */
const TEN: CfcConfClause[] = Array.from(
  { length: 10 },
  (_, index) => cfcAtom.personalSpace(`did:key:z6MkTenPrincipal${index}`),
);
const tenDigests = TEN.map(cfcCanonicalClauseDigest);

const entry = (
  path: string[],
  origin: LabelMapEntry["origin"],
  label: LabelMapEntry["label"],
  observes?: LabelMapEntry["observes"],
): LabelMapEntry => ({
  path,
  label,
  origin,
  ...(observes === undefined ? {} : { observes }),
});

/** Signs `request` as `as`, over `bytes` when given rather than its own. */
const sign = async (
  request: OwnerReleaseByIntentRequest,
  as = signer,
  bytes = ownerReleaseByIntentSignedBytes(request),
): Promise<SignedOwnerReleaseByIntentRequest> => {
  const signed = await as.sign(bytes as never);
  if (signed.error) throw signed.error;
  return {
    request,
    signature: ownerReleaseByIntentSignature(new Uint8Array(signed.ok)),
  };
};

describe("owner release by intent", () => {
  describe("planConfidentialityReleaseByIntent()", () => {
    it("removes the named clauses from every entry at the path, whoever they stand for, and from no other path", () => {
      const other = entry(["rooms"], "declared", { confidentiality: TEN });
      const plan = planConfidentialityReleaseByIntent({
        path: [],
        entries: [
          entry([], "derived", { confidentiality: [own, TEN[0]] }, "shape"),
          entry([], "structure", {
            confidentiality: [own, ...TEN],
            integrity: ["i"],
          }, "enumerate"),
          other,
        ],
        schema: undefined,
        releasedClauseDigests: tenDigests,
      });

      expect(plan.released).toEqual(TEN);
      expect(plan.entries).toEqual([
        entry([], "derived", { confidentiality: [own] }, "shape"),
        entry([], "structure", {
          confidentiality: [own],
          integrity: ["i"],
        }, "enumerate"),
        other,
      ]);
    });

    it("throws for a digest naming no clause stored at the path", () => {
      expect(() =>
        planConfidentialityReleaseByIntent({
          path: ["rooms"],
          entries: [entry([], "derived", { confidentiality: TEN })],
          schema: undefined,
          releasedClauseDigests: [tenDigests[0]],
        })
      ).toThrow("no clause stored there has the digest");
    });

    it("throws for a `*` segment, and leaves a wildcard entry to its own path", () => {
      const wildcard = entry(["*"], "structure", { confidentiality: TEN });
      expect(() =>
        planConfidentialityReleaseByIntent({
          path: ["*"],
          entries: [wildcard],
          schema: undefined,
          releasedClauseDigests: tenDigests,
        })
      ).toThrow("names one concrete path");
      expect(
        clausesStoredForRelease({
          path: ["a"],
          entries: [wildcard],
          schema: undefined,
        }),
      ).toEqual([]);
    });
  });

  describe("clausesStoredForRelease()", () => {
    it("returns each clause once, with its digest and every position holding it", () => {
      expect(
        clausesStoredForRelease({
          path: [],
          entries: [
            entry([], "derived", { confidentiality: [own] }, "shape"),
            entry([], "structure", { confidentiality: [own] }, "enumerate"),
          ],
          schema: {
            type: "object",
            ifc: { confidentiality: [TEN[0]] },
          } as JSONSchema,
        }),
      ).toEqual([
        {
          clause: own,
          digest: cfcCanonicalClauseDigest(own),
          positions: [
            { origin: "derived", observes: "shape" },
            { origin: "structure", observes: "enumerate" },
          ],
        },
        {
          clause: TEN[0],
          digest: tenDigests[0],
          positions: [{ origin: "declared" }],
        },
      ]);
    });
  });

  describe("releasing a stored label", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    /** The envelope `cell`'s document stores, its label references resolved. */
    const storedMetadata = (cell: Cell<unknown>) => {
      const tx = runtime.edit();
      try {
        return readStoredCfcMetadata(tx, cell.getAsNormalizedFullLink());
      } finally {
        tx.abort();
      }
    };

    /** The value `cell`'s document stores. */
    const storedValue = (cell: Cell<unknown>) => {
      const tx = runtime.edit();
      try {
        return cell.withTx(tx).getRaw();
      } finally {
        tx.abort();
      }
    };

    /** The value the document at `id` stores, read through a fresh `tx`. */
    const documentValue = (id: string) => {
      const tx = runtime.edit();
      try {
        return tx.readOrThrow({
          space: actor,
          id: id as URI,
          scope: "space",
          type: "application/json",
          path: ["value"],
        });
      } finally {
        tx.abort();
      }
    };

    /**
     * Stores the document `cause` names with `value` and the payload label
     * entries `entries`, its label-metadata templates derived from them, and
     * returns its cell.
     */
    const seedDocument = async (
      cause: string,
      value: unknown,
      entries: LabelMapEntry[],
    ) => {
      const cell = runtime.getCell<unknown>(actor, cause);
      const tx = runtime.edit();
      writeSeedEnvelopeDoc(tx, actor);
      seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
        value,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [...entries, ...labelMetadataTemplatesFor(entries)],
          },
        },
      } as never);
      expect((await tx.commit().settled).error).toBeUndefined();
      return cell;
    };

    /** The request releasing `digests` at `path` of `cell`, as stored now. */
    const requestAt = (
      cell: Cell<unknown>,
      path: string[],
      digests: readonly string[],
      overrides: Partial<Parameters<typeof ownerReleaseByIntentRequest>[0]> =
        {},
    ) => {
      const id = cell.getAsNormalizedFullLink().id;
      return ownerReleaseByIntentRequest({
        space: actor,
        document: id,
        path,
        releasedClauseDigests: digests,
        envelopeDigest: storedClausesForRelease(runtime, {
          space: actor,
          id,
          path,
        }).envelopeDigest,
        signer: actor,
        ...overrides,
      });
    };

    describe("a result whose membership carries ten other principals' clauses", () => {
      // The links-only result an earlier setup stamped: the existence entry
      // holds the owner's clause alone, the membership the owner's and the
      // ten, and the slot templates the same.

      const ROOT_ENTRIES = [
        entry([], "derived", { confidentiality: [own] }, "shape"),
        entry([], "structure", {
          confidentiality: [own, ...TEN],
          integrity: ["wired"],
        }, "enumerate"),
      ];
      const ELSEWHERE = [
        entry(["*"], "structure", { confidentiality: [own, ...TEN] }, "shape"),
        entry(["rooms"], "derived", { confidentiality: TEN }, "value"),
      ];
      const VALUE = { rooms: [], title: "result" };

      let result: Cell<unknown>;

      beforeEach(async () => {
        result = await seedDocument("runner-cfc-intent-result", VALUE, [
          ...ROOT_ENTRIES,
          ...ELSEWHERE,
        ]);
      });

      it("lists the ten among the clauses stored at the root", () => {
        const { clauses } = storedClausesForRelease(runtime, {
          space: actor,
          id: result.getAsNormalizedFullLink().id,
          path: [],
        });
        expect(clauses.map((clause) => clause.digest)).toEqual([
          cfcCanonicalClauseDigest(own),
          ...tenDigests,
        ]);
      });

      it("removes the ten at the root, keeps every other path, the value and integrity, and re-derives the templates", async () => {
        const signed = await sign(requestAt(result, [], tenDigests));

        const release = await releaseConfidentialityByIntent(runtime, signed);

        expect([...release.releasedDigests].sort()).toEqual(
          [...tenDigests].sort(),
        );
        expect(release.released).toHaveLength(TEN.length);
        expect(release.released).toEqual(expect.arrayContaining(TEN));
        expect(release.paths).toEqual([[]]);
        const remaining = [
          entry([], "derived", { confidentiality: [own] }, "shape"),
          entry([], "structure", {
            confidentiality: [own],
            integrity: ["wired"],
          }, "enumerate"),
          ...ELSEWHERE,
        ];
        const metadata = storedMetadata(result);
        expect(metadata?.labelMap.entries).toEqual(remaining);
        expect(metadata?.labelMap.documentEntries).toEqual(
          labelMetadataTemplatesFor(remaining),
        );
        expect(storedValue(result)).toEqual(VALUE);
      });

      it("writes the record of the release, readable by the owner alone", async () => {
        const signed = await sign(requestAt(result, [], tenDigests));
        const before = signed.request.envelopeDigest;

        const release = await releaseConfidentialityByIntent(runtime, signed);

        const recordId = ownerReleaseByIntentRecordId(
          result.getAsNormalizedFullLink().id,
          ownerReleaseByIntentRequestDigest(signed.request),
        );
        expect(release.record.id).toBe(recordId);
        expect(documentValue(recordId)).toEqual(
          ownerReleaseByIntentRecord(signed, release.envelopeDigest),
        );
        expect(release.priorEnvelopeDigest).toBe(before);
        expect(release.envelopeDigest).not.toBe(before);
        const tx = runtime.edit();
        expect(
          readStoredCfcMetadata(tx, release.record)?.labelMap.entries
            .filter((entry) => entry.path.length === 0)
            .map((entry) => entry.label.confidentiality),
        ).toContainEqual([cfcAtom.user(actor)]);
        tx.abort();
      });

      it("refuses the same request again, once the envelope it names is back, and writes nothing", async () => {
        const signed = await sign(requestAt(result, [], tenDigests));
        await releaseConfidentialityByIntent(runtime, signed);
        // The stamp comes back, so the envelope is again the one the request
        // names, and only the record's presence refuses the replay.
        await seedDocument("runner-cfc-intent-result", VALUE, [
          ...ROOT_ENTRIES,
          ...ELSEWHERE,
        ]);
        expect(
          storedClausesForRelease(runtime, {
            space: actor,
            id: result.getAsNormalizedFullLink().id,
            path: [],
          }).envelopeDigest,
        ).toBe(signed.request.envelopeDigest);
        const before = storedMetadata(result);

        await expect(releaseConfidentialityByIntent(runtime, signed)).rejects
          .toThrow("the request has already been used");
        expect(storedMetadata(result)).toEqual(before);
      });

      it("refuses a route-2c owner release of the ten, which keeps them", async () => {
        await expect(releaseCellConfidentiality(result, [own])).rejects
          .toThrow(`is not ${actor}'s alone to release`);
        expect(storedMetadata(result)?.labelMap.entries).toEqual([
          ...ROOT_ENTRIES,
          ...ELSEWHERE,
        ]);
      });

      describe("refusals", () => {
        /** Expects `signed` refused for `reason`, and the document untouched. */
        const expectRefused = async (
          signed: SignedOwnerReleaseByIntentRequest,
          reason: string | RegExp,
        ) => {
          const before = storedMetadata(result);
          await expect(releaseConfidentialityByIntent(runtime, signed))
            .rejects.toThrow(reason);
          expect(storedMetadata(result)).toEqual(before);
        };

        it("refuses a signature that does not verify", async () => {
          const signed = await sign(requestAt(result, [], tenDigests));
          await expectRefused(
            { ...signed, signature: signed.signature.slice(4) },
            "signature does not verify",
          );
        });

        it("refuses a request signed under another purpose", async () => {
          const request = requestAt(result, [], tenDigests);
          const { purpose: _, ...rest } = request;
          await expectRefused(
            await sign(
              request,
              signer,
              encodeDagCbor({ ...rest, purpose: "cfc.other/1" } as never),
            ),
            "signature does not verify",
          );
          await expectRefused(
            {
              ...(await sign(request)),
              request: { ...request, purpose: "cfc.other/1" as never },
            },
            "not a well-formed signed release request",
          );
        });

        it("refuses a request signed by someone other than the space's owner", async () => {
          await expectRefused(
            await sign(
              requestAt(result, [], tenDigests, { signer: intruder.did() }),
              intruder,
            ),
            "is not the owner the space's access list names",
          );
        });

        it("refuses a request naming another space, document or path", async () => {
          await expectRefused(
            await sign(
              requestAt(result, [], tenDigests, { space: intruder.did() }),
            ),
            "is not the owner",
          );
          await expectRefused(
            await sign(
              requestAt(result, [], tenDigests, {
                document: "of:runner-cfc-intent-elsewhere",
              }),
            ),
            "changed since the request was made",
          );
          await expectRefused(
            await sign(requestAt(result, ["title"], tenDigests)),
            "no clause stored there has the digest",
          );
        });

        it("refuses a clause not stored at the path", async () => {
          await expectRefused(
            await sign(
              requestAt(result, [], [
                ...tenDigests,
                cfcCanonicalClauseDigest(cfcAtom.user(intruder.did())),
              ]),
            ),
            "no clause stored there has the digest",
          );
        });

        it("refuses a request made against an envelope that has changed since", async () => {
          const signed = await sign(requestAt(result, [], tenDigests));
          const reseeded = await seedDocument(
            "runner-cfc-intent-result",
            VALUE,
            [
              ...ROOT_ENTRIES,
            ],
          );
          const before = storedMetadata(reseeded);
          await expect(releaseConfidentialityByIntent(runtime, signed)).rejects
            .toThrow("changed since the request was made");
          expect(storedMetadata(reseeded)).toEqual(before);
        });

        it("refuses a `*` path in a request, signed or not", async () => {
          const request = requestAt(result, [], tenDigests);
          expect(() => ownerReleaseByIntentRequest({ ...request, path: ["*"] }))
            .toThrow("`*` segment");
          const wildcard = { ...request, path: ["*"] };
          await expectRefused(
            await sign(wildcard as OwnerReleaseByIntentRequest),
            "not a well-formed signed release request",
          );
        });

        it("refuses a transaction without the release-by-intent writer's identity", async () => {
          const signed = await sign(requestAt(result, [], tenDigests));
          const tx = runtime.edit();
          expect(() => tx.releaseCfcConfidentialityByIntent({ signed }))
            .toThrow(OWNER_RELEASE_BY_INTENT_WRITER);
          tx.abort();
        });

        it("refuses a record committed with no release, at the store", async () => {
          const signed = await sign(requestAt(result, [], tenDigests));
          const recordId = ownerReleaseByIntentRecordId(
            signed.request.document,
            ownerReleaseByIntentRequestDigest(signed.request),
          );
          const tx = runtime.edit();
          setCfcImplementationIdentity(tx, {
            kind: "builtin",
            builtinId: OWNER_RELEASE_BY_INTENT_WRITER,
          });
          runtime.getCellFromLink(
            {
              space: actor,
              id: recordId as URI,
              path: [],
              scope: "space",
            },
            undefined,
            tx,
          ).set(
            ownerReleaseByIntentRecord(signed, signed.request.envelopeDigest),
          );
          const committed = await tx.commit().settled;
          expect(committed.error?.message).toMatch(
            /release record .* which the store refuses/,
          );
          expect(documentValue(recordId)).toBeUndefined();
        });
      });
    });

    describe("at a declared, existence or link-carried label", () => {
      it("removes another principal's declared clause and the frozen existence entry's", async () => {
        const other = cfcAtom.user(intruder.did());
        const cell = await seedDocument("runner-cfc-intent-declared", {
          rooms: ["a"],
        }, [
          entry(["rooms"], "declared", { confidentiality: [other] }),
          entry(["rooms"], "derived", { confidentiality: [other] }, "shape"),
          entry([], "declared", { confidentiality: [other] }),
        ]);

        await releaseConfidentialityByIntent(
          runtime,
          await sign(
            requestAt(cell, ["rooms"], [cfcCanonicalClauseDigest(other)]),
          ),
        );

        expect(storedMetadata(cell)?.labelMap.entries).toEqual([
          entry([], "declared", { confidentiality: [other] }),
        ]);
      });

      it("removes a clause the stored schema declares, rewriting the schema", async () => {
        const other = cfcAtom.user(intruder.did());
        const declaring = {
          type: "object",
          properties: { text: { type: "string" } },
          ifc: { confidentiality: [other] },
        } as const satisfies JSONSchema;
        const tx = runtime.edit();
        const cell = runtime.getCell<{ text: string }>(
          actor,
          "runner-cfc-intent-schema",
          declaring,
        );
        cell.withTx(tx).set({ text: "mine" });
        expect((await tx.commit().settled).error).toBeUndefined();
        const plain = runtime.getCell<unknown>(
          actor,
          "runner-cfc-intent-schema",
        );
        const schemaBefore = storedMetadata(plain)?.schemaHash;

        await releaseConfidentialityByIntent(
          runtime,
          await sign(
            requestAt(plain, [], [cfcCanonicalClauseDigest(other)]),
          ),
        );

        const metadata = storedMetadata(plain);
        expect(metadata?.schemaHash).not.toBe(schemaBefore);
        expect(
          storedClausesForRelease(runtime, {
            space: actor,
            id: plain.getAsNormalizedFullLink().id,
            path: [],
          }).clauses,
        ).toEqual([]);
      });

      it("lowers a link slot's own label and leaves its target's", async () => {
        const other = cfcAtom.user(intruder.did());
        const target = await seedDocument("runner-cfc-intent-target", {
          text: "t",
        }, [entry([], "derived", { confidentiality: [other] })]);
        const targetEntries = storedMetadata(target)?.labelMap.entries;
        const cell = await seedDocument("runner-cfc-intent-slot", {
          profile: target.getAsLink(),
        }, [
          entry(["profile"], "link", { confidentiality: [other] }, "followRef"),
        ]);

        await releaseConfidentialityByIntent(
          runtime,
          await sign(
            requestAt(cell, ["profile"], [cfcCanonicalClauseDigest(other)]),
          ),
        );

        expect(storedMetadata(cell)?.labelMap.entries).toEqual([]);
        expect(storedMetadata(target)?.labelMap.entries).toEqual(targetEntries);
      });
    });
  });
});
