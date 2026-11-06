import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import { encodeDagCbor } from "@commonfabric/identity/dag-cbor";

import { cfcCanonicalClauseDigest } from "../v2/cfc-clause-identity.ts";
import {
  clauseDigestsStoredAt,
  OWNER_RELEASE_BY_INTENT_PURPOSE,
  ownerReleaseByIntentEnvelopeDigest,
  ownerReleaseByIntentRecord,
  ownerReleaseByIntentRecordId,
  type OwnerReleaseByIntentRequest,
  ownerReleaseByIntentRequest,
  ownerReleaseByIntentRequestDigest,
  ownerReleaseByIntentSignature,
  ownerReleaseByIntentSignedBytes,
  ownerReleaseByIntentSpaceOwner,
  parseOwnerReleaseByIntentRecord,
  type SignedOwnerReleaseByIntentRequest,
  verifyOwnerReleaseByIntentSignature,
} from "../v2/cfc-owner-release-by-intent.ts";
import { applyCommit, close, type Engine, open, read } from "../v2/engine.ts";
import { ProtocolError } from "../v2.ts";

const owner = await Identity.fromPassphrase("memory-owner-release-by-intent");
const other = await Identity.fromPassphrase("memory-release-by-intent-other");
const OWNER = owner.did();
const OTHER = other.did();

const personalSpace = (did: string) => ({
  type: CFC_ATOM_TYPE.PersonalSpace,
  owner: did,
});

/** Ten other principals' clauses, the way an earlier setup stamps them. */
const FOREIGN = Array.from(
  { length: 10 },
  (_, index) => personalSpace(`did:key:z6MkForeign${index}`),
);

const schema = { type: "object" } as const;
const schemaHash = internSchemaAsTaggedHashString(schema);

const envelope = (entries: unknown[]) => ({
  version: 1,
  schemaHash,
  labelMap: { version: 1, entries },
});

const entry = (
  path: string[],
  origin: string,
  confidentiality: unknown[],
  observes?: string,
) => ({
  path,
  origin,
  ...(observes === undefined ? {} : { observes }),
  label: { confidentiality },
});

const digest = (clause: unknown) => cfcCanonicalClauseDigest(clause as never);

/** Signs `request` as `signer`, over `bytes` when given rather than its own. */
const sign = async (
  signer: Identity,
  request: OwnerReleaseByIntentRequest,
  bytes = ownerReleaseByIntentSignedBytes(request),
): Promise<SignedOwnerReleaseByIntentRequest> => {
  const signed = await signer.sign(bytes as never);
  if (signed.error) throw signed.error;
  return {
    request,
    signature: ownerReleaseByIntentSignature(new Uint8Array(signed.ok)),
  };
};

describe("cfc-owner-release-by-intent", () => {
  describe("ownerReleaseByIntentRequest()", () => {
    const fields = {
      space: OWNER,
      document: "of:doc",
      path: ["rooms"],
      releasedClauseDigests: ["b", "a"],
      envelopeDigest: "e",
      signer: OWNER,
    };

    it("returns the request with its purpose and its digests in ascending order", () => {
      expect(ownerReleaseByIntentRequest(fields)).toEqual({
        purpose: OWNER_RELEASE_BY_INTENT_PURPOSE,
        ...fields,
        releasedClauseDigests: ["a", "b"],
      });
    });

    it("returns a request naming a wildcard position as its literal path", () => {
      expect(ownerReleaseByIntentRequest({ ...fields, path: ["a", "*"] }).path)
        .toEqual(["a", "*"]);
    });

    it("throws on a repeated digest, no digest, or a document under the record scheme", () => {
      expect(() =>
        ownerReleaseByIntentRequest({
          ...fields,
          releasedClauseDigests: ["a", "a"],
        })
      ).toThrow("each named once");
      expect(() =>
        ownerReleaseByIntentRequest({ ...fields, releasedClauseDigests: [] })
      ).toThrow("releases no clause");
      expect(() =>
        ownerReleaseByIntentRequest({
          ...fields,
          document: ownerReleaseByIntentRecordId("of:doc", "x"),
        })
      ).toThrow("not one a release can name");
    });
  });

  describe("verifyOwnerReleaseByIntentSignature()", () => {
    const request = ownerReleaseByIntentRequest({
      space: OWNER,
      document: "of:doc",
      path: [],
      releasedClauseDigests: ["a"],
      envelopeDigest: "e",
      signer: OWNER,
    });

    it("returns `true` for the signer's signature over the request", async () => {
      expect(verifyOwnerReleaseByIntentSignature(await sign(owner, request)))
        .toBe(true);
    });

    it("returns `false` for another key's signature, or a signature over another request", async () => {
      expect(verifyOwnerReleaseByIntentSignature(await sign(other, request)))
        .toBe(false);
      const signed = await sign(owner, request);
      expect(verifyOwnerReleaseByIntentSignature({
        ...signed,
        request: { ...request, path: ["other"] },
      })).toBe(false);
    });

    it("returns `false` for the same fields signed under another purpose", async () => {
      const { purpose: _, ...rest } = request;
      const bytes = encodeDagCbor({ ...rest, purpose: "cfc.other/1" } as never);
      expect(
        verifyOwnerReleaseByIntentSignature(await sign(owner, request, bytes)),
      ).toBe(false);
    });
  });

  describe("ownerReleaseByIntentSpaceOwner()", () => {
    it("returns the space's own DID where it stores no access list", () => {
      expect(ownerReleaseByIntentSpaceOwner(OWNER, { stored: false }))
        .toBe(OWNER);
    });

    it("returns the access list's owner, and `undefined` for a list with none or a tombstone", () => {
      expect(
        ownerReleaseByIntentSpaceOwner("did:key:space", {
          stored: true,
          value: { [OTHER]: "OWNER", [OWNER]: "WRITE" },
        }),
      ).toBe(OTHER);
      expect(
        ownerReleaseByIntentSpaceOwner("did:key:space", {
          stored: true,
          value: { [OWNER]: "WRITE" },
        }),
      ).toBeUndefined();
      expect(
        ownerReleaseByIntentSpaceOwner("did:key:space", {
          stored: true,
          value: { deleted: { by: OWNER } },
        }),
      ).toBeUndefined();
    });
  });

  describe("clauseDigestsStoredAt()", () => {
    it("returns the clauses of every entry at exactly the path, label-metadata templates aside", () => {
      const stored = clauseDigestsStoredAt(
        envelope([
          entry([], "derived", [personalSpace(OWNER)], "shape"),
          entry([], "structure", [personalSpace(OTHER)], "enumerate"),
          entry(["rooms"], "declared", ["elsewhere"]),
          entry(["cfc", "labels"], "label-metadata", ["template"]),
          entry([], "label-metadata", ["template"]),
        ]),
        [],
        () => undefined,
      );
      expect([...stored!.keys()].sort()).toEqual(
        [digest(personalSpace(OWNER)), digest(personalSpace(OTHER))].sort(),
      );
    });

    it("returns `undefined` when an entry at the path holds a label that doesn't resolve", () => {
      expect(
        clauseDigestsStoredAt(
          envelope([{ path: [], origin: "derived", label: { $ref: "cid:x" } }]),
          [],
          () => undefined,
        ),
      ).toBeUndefined();
    });
  });

  describe("a commit the engine applies", () => {
    let path: string;
    let engine: Engine;
    let localSeq: number;

    beforeEach(async () => {
      path = await Deno.makeTempFile({ suffix: ".sqlite" });
      engine = await open({ url: toFileUrl(path) });
      localSeq = 0;
    });

    afterEach(async () => {
      close(engine);
      await Deno.remove(path);
    });

    const commitIn = (
      space: string,
      principal: string,
      operations: unknown[],
    ) =>
      applyCommit(engine, {
        sessionId: "s:a",
        space,
        principal,
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations,
        } as never,
      });

    const id = "of:result";

    /** The stamped result: the owner's existence, and the ten on membership. */
    const STAMPED = envelope([
      entry([], "derived", [personalSpace(OWNER)], "shape"),
      entry([], "structure", [personalSpace(OWNER), ...FOREIGN], "enumerate"),
      entry(["rooms"], "declared", [personalSpace(OTHER)]),
      entry(["direct"], "declared", [personalSpace(OWNER)]),
    ]);

    /** `STAMPED` once the ten are released at the root. */
    const RELEASED = envelope([
      entry([], "derived", [personalSpace(OWNER)], "shape"),
      entry([], "structure", [personalSpace(OWNER)], "enumerate"),
      entry(["rooms"], "declared", [personalSpace(OTHER)]),
      entry(["direct"], "declared", [personalSpace(OWNER)]),
    ]);

    /** `STAMPED` with the declared `rooms` entry released. */
    const ROOMS_RELEASED = envelope([
      entry([], "derived", [personalSpace(OWNER)], "shape"),
      entry([], "structure", [personalSpace(OWNER), ...FOREIGN], "enumerate"),
      entry(["direct"], "declared", [personalSpace(OWNER)]),
    ]);

    const seed = (space: string, cfc: unknown, extra: unknown[] = []) =>
      commitIn(space, OWNER, [
        { op: "set", id: `cid:${schemaHash}`, value: { value: schema } },
        ...extra,
        { op: "set", id, value: { value: { rooms: [] }, cfc } },
      ]);

    const storedCfc = () =>
      (read(engine, { id }) as { cfc?: unknown } | null)?.cfc;

    const requestFor = (
      overrides: Partial<Parameters<typeof ownerReleaseByIntentRequest>[0]> =
        {},
    ) =>
      ownerReleaseByIntentRequest({
        space: OWNER,
        document: id,
        path: [],
        releasedClauseDigests: FOREIGN.map(digest),
        envelopeDigest: ownerReleaseByIntentEnvelopeDigest(STAMPED),
        signer: OWNER,
        ...overrides,
      });

    /**
     * The operations of a release by `signed` leaving the document with
     * `proposed`, its record at the id `signed` derives unless `recordId`
     * names another, holding `record` when given.
     */
    /** The envelope a record labeled for `owner` alone stores. */
    const recordLabel = (did: string) =>
      envelope([
        entry([], "declared", [{ type: CFC_ATOM_TYPE.User, subject: did }]),
      ]);

    const releaseOps = (
      signed: SignedOwnerReleaseByIntentRequest,
      proposed: unknown,
      options: {
        recordId?: string;
        record?: unknown;
        recordCfc?: unknown;
      } = {},
    ) => [
      { op: "set", id, value: { value: { rooms: [] }, cfc: proposed } },
      {
        op: "set",
        id: options.recordId ??
          ownerReleaseByIntentRecordId(
            signed.request.document,
            ownerReleaseByIntentRequestDigest(signed.request),
          ),
        value: {
          value: options.record ??
            ownerReleaseByIntentRecord(
              signed,
              ownerReleaseByIntentEnvelopeDigest(proposed),
            ),
          cfc: "recordCfc" in options
            ? options.recordCfc
            : recordLabel(signed.request.signer),
        },
      },
    ];

    it("commits the owner's release of the ten other principals' clauses, and its record", async () => {
      seed(OWNER, STAMPED);
      const signed = await sign(owner, requestFor());
      commitIn(OWNER, OWNER, releaseOps(signed, RELEASED));

      expect(storedCfc()).toEqual(RELEASED);
      const recordId = ownerReleaseByIntentRecordId(
        id,
        ownerReleaseByIntentRequestDigest(signed.request),
      );
      expect(
        parseOwnerReleaseByIntentRecord(read(engine, { id: recordId })?.value),
      ).toEqual({
        request: signed.request,
        signature: signed.signature,
        owner: OWNER,
        document: id,
        path: [],
        removed: [...FOREIGN.map(digest)].sort(),
        before: ownerReleaseByIntentEnvelopeDigest(STAMPED),
        after: ownerReleaseByIntentEnvelopeDigest(RELEASED),
      });
    });

    it("commits the drop of another principal's declared clause that a verified release names", async () => {
      seed(OWNER, STAMPED);
      const signed = await sign(
        owner,
        requestFor({
          path: ["rooms"],
          releasedClauseDigests: [digest(personalSpace(OTHER))],
        }),
      );
      commitIn(OWNER, OWNER, releaseOps(signed, ROOMS_RELEASED));
      expect(storedCfc()).toEqual(ROOMS_RELEASED);
    });

    it("throws on the same drop with no record", () => {
      seed(OWNER, STAMPED);
      expect(() =>
        commitIn(OWNER, OWNER, [{
          op: "set",
          id,
          value: { value: { rooms: [] }, cfc: ROOMS_RELEASED },
        }])
      ).toThrow(/no declared CFC label at \["rooms"\]/);
      expect(storedCfc()).toEqual(STAMPED);
    });

    it("throws on a release whose record names another path than the declared drop", async () => {
      seed(OWNER, STAMPED);
      const signed = await sign(owner, requestFor());
      expect(() =>
        commitIn(OWNER, OWNER, [
          ...releaseOps(signed, RELEASED).slice(1),
          {
            op: "set",
            id,
            value: {
              value: { rooms: [] },
              cfc: envelope([
                entry([], "derived", [personalSpace(OWNER)], "shape"),
                entry([], "structure", [personalSpace(OWNER)], "enumerate"),
                entry(["direct"], "declared", [personalSpace(OWNER)]),
              ]),
            },
          },
        ])
      ).toThrow(ProtocolError);
      expect(storedCfc()).toEqual(STAMPED);
    });

    it("commits a release at a wildcard position, which reaches that position alone", async () => {
      const template = (clauses: unknown[]) =>
        entry(["*"], "structure", clauses, "shape");
      const slot = entry(["rooms"], "derived", FOREIGN, "value");
      const stored = envelope([
        template([personalSpace(OWNER), ...FOREIGN]),
        slot,
      ]);
      const released = envelope([template([personalSpace(OWNER)]), slot]);
      seed(OWNER, stored);
      const signed = await sign(
        owner,
        requestFor({
          path: ["*"],
          envelopeDigest: ownerReleaseByIntentEnvelopeDigest(stored),
        }),
      );
      commitIn(OWNER, OWNER, releaseOps(signed, released));
      expect(storedCfc()).toEqual(released);
    });

    it("throws on a release at a concrete path that names clauses only a wildcard position covering it holds", async () => {
      const stored = envelope([
        entry(["*"], "structure", [personalSpace(OWNER), ...FOREIGN], "shape"),
      ]);
      seed(OWNER, stored);
      const signed = await sign(
        owner,
        requestFor({
          path: ["rooms"],
          envelopeDigest: ownerReleaseByIntentEnvelopeDigest(stored),
        }),
      );
      expect(() => commitIn(OWNER, OWNER, releaseOps(signed, stored)))
        .toThrow(/not stored at the path/);
      expect(storedCfc()).toEqual(stored);
    });

    describe("refusals", () => {
      /** Applies `operations` and expects the commit refused, naming `reason`. */
      const expectRefused = (
        operations: unknown[],
        reason: RegExp,
        space = OWNER,
      ) => {
        expect(() => commitIn(space, OWNER, operations)).toThrow(reason);
        expect(storedCfc()).toEqual(STAMPED);
      };

      let seedSeq: number;

      beforeEach(() => {
        seedSeq = seed(OWNER, STAMPED).seq;
      });

      it("throws on a signature that does not verify", async () => {
        const signed = await sign(owner, requestFor());
        const forged = { ...signed, signature: signed.signature.slice(4) };
        expectRefused(releaseOps(forged, RELEASED), /signature does not/);
      });

      it("throws on a request signed under another purpose", async () => {
        const request = requestFor();
        const { purpose: _, ...rest } = request;
        const signed = await sign(
          owner,
          request,
          encodeDagCbor({ ...rest, purpose: "cfc.other/1" } as never),
        );
        expectRefused(releaseOps(signed, RELEASED), /signature does not/);
        const relabeled = { ...signed.request, purpose: "cfc.other/1" };
        expectRefused(
          releaseOps(signed, RELEASED, {
            record: {
              ...ownerReleaseByIntentRecord(
                signed,
                ownerReleaseByIntentEnvelopeDigest(RELEASED),
              ),
              request: relabeled,
            },
          }),
          /not a release record/,
        );
      });

      it("throws on a request signed by someone other than the home space's owner", async () => {
        const signed = await sign(other, requestFor({ signer: OTHER }));
        expectRefused(releaseOps(signed, RELEASED), /not the owner/);
      });

      it("throws on a request naming another space, another document, or another path", async () => {
        expectRefused(
          releaseOps(await sign(owner, requestFor({ space: OTHER })), RELEASED),
          /names another space/,
        );
        expectRefused(
          releaseOps(
            await sign(owner, requestFor({ document: "of:elsewhere" })),
            RELEASED,
          ),
          /writes no envelope of the document/,
        );
        expectRefused(
          releaseOps(
            await sign(owner, requestFor({ path: ["direct"] })),
            RELEASED,
          ),
          /not stored at the path/,
        );
      });

      it("throws on a release that removes a clause at the path its request does not name", async () => {
        const signed = await sign(
          owner,
          requestFor({ releasedClauseDigests: FOREIGN.slice(1).map(digest) }),
        );
        expectRefused(
          releaseOps(signed, RELEASED),
          /removes a clause at the path its request does not name/,
        );
        const ownGone = envelope([
          entry([], "derived", [], "shape"),
          entry([], "structure", [personalSpace(OWNER)], "enumerate"),
          entry(["rooms"], "declared", [personalSpace(OTHER)]),
          entry(["direct"], "declared", [personalSpace(OWNER)]),
        ]);
        expectRefused(
          releaseOps(await sign(owner, requestFor()), ownGone),
          /removes a clause at the path its request does not name/,
        );
      });

      it("throws on a clause not stored at the path", async () => {
        const signed = await sign(
          owner,
          requestFor({
            releasedClauseDigests: [
              ...FOREIGN.map(digest),
              digest(personalSpace(OTHER)),
            ],
          }),
        );
        expectRefused(releaseOps(signed, RELEASED), /not stored at the path/);
      });

      it("throws on an envelope changed since the request was made", async () => {
        const signed = await sign(
          owner,
          requestFor({
            envelopeDigest: ownerReleaseByIntentEnvelopeDigest(RELEASED),
          }),
        );
        expectRefused(releaseOps(signed, RELEASED), /has changed since/);
      });

      it("throws on a request already used", async () => {
        const signed = await sign(owner, requestFor());
        commitIn(OWNER, OWNER, releaseOps(signed, RELEASED));
        // The stamp comes back, so the envelope is again the one the request
        // names, and only the record's presence refuses the replay.
        commitIn(OWNER, OWNER, [{
          op: "set",
          id,
          value: { value: { rooms: [] }, cfc: STAMPED },
        }]);
        expectRefused(releaseOps(signed, RELEASED), /already been used/);
      });

      it("throws on the same release submitted again, and admits it as a no-op over a stale read, changing nothing", async () => {
        const signed = await sign(owner, requestFor());
        const operations = releaseOps(signed, RELEASED);
        commitIn(OWNER, OWNER, operations);
        const recordId = ownerReleaseByIntentRecordId(
          id,
          ownerReleaseByIntentRequestDigest(signed.request),
        );
        const record = read(engine, { id: recordId });

        expect(() => commitIn(OWNER, OWNER, operations)).toThrow(
          /already been used/,
        );
        // The same commit made against the stamped envelope, a retry of the
        // one that landed, is an identity commit: every operation leaves the
        // store as it is, so it releases nothing again.
        const retry = applyCommit(engine, {
          sessionId: "s:a",
          space: OWNER,
          principal: OWNER,
          commit: {
            localSeq: ++localSeq,
            reads: {
              confirmed: [{ id, path: [], seq: seedSeq }],
              pending: [],
            },
            operations,
          } as never,
        });
        expect(retry.revisions).toEqual([]);
        expect(retry.elidedOpIndexes).toEqual([0, 1]);
        expect(storedCfc()).toEqual(RELEASED);
        expect(read(engine, { id: recordId })).toEqual(record);
      });

      it("throws on a record at an id its request does not derive", async () => {
        const signed = await sign(owner, requestFor());
        expectRefused(
          releaseOps(signed, RELEASED, {
            recordId: ownerReleaseByIntentRecordId(id, "other"),
          }),
          /not at the id its request derives/,
        );
      });

      it("throws on a record whose `after` is not the envelope the commit leaves", async () => {
        const signed = await sign(owner, requestFor());
        expectRefused(
          releaseOps(signed, RELEASED, {
            record: ownerReleaseByIntentRecord(signed, "elsewhere"),
          }),
          /`after` is not/,
        );
      });

      it("throws on a record not labeled for its owner alone", async () => {
        const signed = await sign(owner, requestFor());
        for (const recordCfc of [undefined, recordLabel(OTHER)]) {
          expectRefused(
            releaseOps(signed, RELEASED, { recordCfc }),
            /not labeled for its owner alone/,
          );
        }
      });

      it("throws on a record whose fields disagree with its request", async () => {
        const signed = await sign(owner, requestFor());
        expectRefused(
          releaseOps(signed, RELEASED, {
            record: {
              ...ownerReleaseByIntentRecord(
                signed,
                ownerReleaseByIntentEnvelopeDigest(RELEASED),
              ),
              removed: [digest(personalSpace(OTHER))],
            },
          }),
          /not a release record/,
        );
      });

      it("throws on a record with no release: the envelope unchanged, or not written", async () => {
        const signed = await sign(owner, requestFor());
        expectRefused(
          releaseOps(signed, STAMPED),
          /leaves a released clause/,
        );
        expectRefused(
          releaseOps(signed, RELEASED).slice(1),
          /writes no envelope of the document/,
        );
      });

      it("throws on any write to a stored record but its creation", async () => {
        const signed = await sign(owner, requestFor());
        commitIn(OWNER, OWNER, releaseOps(signed, RELEASED));
        const recordId = ownerReleaseByIntentRecordId(
          id,
          ownerReleaseByIntentRequestDigest(signed.request),
        );
        for (
          const operation of [
            { op: "delete", id: recordId },
            {
              op: "patch",
              id: recordId,
              patches: [{ op: "replace", path: "/value/owner", value: OTHER }],
            },
          ]
        ) {
          expect(() => commitIn(OWNER, OWNER, [operation])).toThrow(
            /other than by creating it once/,
          );
        }
        expect(read(engine, { id: recordId })?.value).toEqual(
          ownerReleaseByIntentRecord(
            signed,
            ownerReleaseByIntentEnvelopeDigest(RELEASED),
          ),
        );
      });

      it("throws on a record created by two sets, at user scope, or by a patch carrying its value", async () => {
        const signed = await sign(owner, requestFor());
        const [envelopeOp, recordOp] = releaseOps(signed, RELEASED) as [
          unknown,
          { op: string; id: string; value: { value: unknown; cfc: unknown } },
        ];
        for (
          const operations of [
            [envelopeOp, recordOp, recordOp],
            [envelopeOp, { ...recordOp, scope: "user" }],
            [envelopeOp, {
              ...recordOp,
              op: "patch",
              patches: [{ op: "add", path: "", value: recordOp.value }],
            }],
          ]
        ) {
          expectRefused(operations, /other than by creating it once/);
        }
      });

      it("throws on two releases of one document in one commit", async () => {
        // Each request, judged at its own path, is one the store admits.
        const both = envelope([
          entry([], "derived", [personalSpace(OWNER)], "shape"),
          entry([], "structure", [personalSpace(OWNER)], "enumerate"),
          entry(["direct"], "declared", [personalSpace(OWNER)]),
        ]);
        const first = await sign(owner, requestFor());
        const second = await sign(
          owner,
          requestFor({
            path: ["rooms"],
            releasedClauseDigests: [digest(personalSpace(OTHER))],
          }),
        );
        expectRefused(
          [
            ...releaseOps(first, both),
            ...releaseOps(second, both).slice(1),
          ],
          /more than one request/,
        );
      });
    });

    describe("in a space whose access list names its owner", () => {
      const SPACE = "did:key:z6MkSharedSpaceSharedSpaceSharedSpaceShared";

      beforeEach(() => {
        commitIn(SPACE, OTHER, [{
          op: "set",
          id: `of:${SPACE}`,
          value: { value: { [OTHER]: "OWNER", [OWNER]: "WRITE" } },
        }]);
        seed(SPACE, STAMPED);
      });

      const sharedRequest = (signer: string) =>
        requestFor({ space: SPACE, signer });

      it("commits a release the list's owner signs", async () => {
        const signed = await sign(other, sharedRequest(OTHER));
        commitIn(SPACE, OTHER, releaseOps(signed, RELEASED));
        expect(storedCfc()).toEqual(RELEASED);
      });

      it("throws on a release a principal with `WRITE` but not `OWNER` signs", async () => {
        const signed = await sign(owner, sharedRequest(OWNER));
        expect(() => commitIn(SPACE, OWNER, releaseOps(signed, RELEASED)))
          .toThrow(/not the owner/);
        expect(storedCfc()).toEqual(STAMPED);
      });
    });

    it("resolves a proposed label held by reference that the commit itself creates", async () => {
      seed(OWNER, STAMPED);
      const label = { confidentiality: [personalSpace(OWNER)] };
      const ref = `cid:${taggedHashStringOf(label)}`;
      const proposed = envelope([
        entry([], "derived", [personalSpace(OWNER)], "shape"),
        {
          path: [],
          origin: "structure",
          observes: "enumerate",
          label: { $ref: ref },
        },
        entry(["rooms"], "declared", [personalSpace(OTHER)]),
        entry(["direct"], "declared", [personalSpace(OWNER)]),
      ]);
      const signed = await sign(owner, requestFor());
      commitIn(OWNER, OWNER, [
        { op: "set", id: ref, value: { value: label } },
        ...releaseOps(signed, proposed),
      ]);
      expect(storedCfc()).toEqual(proposed);
    });
  });
});
