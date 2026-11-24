import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";

import { cfcCanonicalClauseDigest } from "../v2/cfc-clause-identity.ts";
import {
  ownerReleaseByIntentEnvelopeDigest,
  ownerReleaseByIntentRecord,
  ownerReleaseByIntentRecordId,
  ownerReleaseByIntentRequest,
  ownerReleaseByIntentRequestDigest,
  ownerReleaseByIntentSignature,
  ownerReleaseByIntentSignedBytes,
  type SignedOwnerReleaseByIntentRequest,
} from "../v2/cfc-owner-release-by-intent.ts";
import { applyCommit, close, type Engine, open, read } from "../v2/engine.ts";

const owner = await Identity.fromPassphrase("engine-owner-release-owner");
const OWNER = owner.did();
const ID = "of:released";

const personalSpace = (did: string) => ({
  type: CFC_ATOM_TYPE.PersonalSpace,
  owner: did,
});
const FOREIGN = [0, 1].map((index) =>
  personalSpace(`did:key:z6MkEngineReleaseForeign${index}`)
);

const schema = { type: "object" } as const;
const schemaHash = internSchemaAsTaggedHashString(schema);

const envelope = (entries: unknown[]) => ({
  version: 1,
  schemaHash,
  labelMap: { version: 1, entries },
});

const STAMPED = envelope([{
  path: [],
  origin: "structure",
  observes: "enumerate",
  label: { confidentiality: [personalSpace(OWNER), ...FOREIGN] },
}]);
const RELEASED = envelope([{
  path: [],
  origin: "structure",
  observes: "enumerate",
  label: { confidentiality: [personalSpace(OWNER)] },
}]);

/** The label a record created for `OWNER` alone carries at its root. */
const OWNER_LABEL = {
  confidentiality: [{ type: CFC_ATOM_TYPE.User, subject: OWNER }],
};
const OWNER_LABEL_REF = `cid:${taggedHashStringOf(OWNER_LABEL)}`;

describe("engine owner release by intent", () => {
  let path: string;
  let engine: Engine;
  let localSeq: number;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
    commit([
      { op: "set", id: `cid:${schemaHash}`, value: { value: schema } },
      { op: "set", id: ID, value: { value: { rooms: [] }, cfc: STAMPED } },
    ]);
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  const commit = (operations: unknown[]) =>
    applyCommit(engine, {
      sessionId: "s:owner",
      space: OWNER,
      principal: OWNER,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations,
      } as never,
    });

  const signedRelease = async (): Promise<
    SignedOwnerReleaseByIntentRequest
  > => {
    const request = ownerReleaseByIntentRequest({
      space: OWNER,
      document: ID,
      path: [],
      releasedClauseDigests: FOREIGN.map((clause) =>
        cfcCanonicalClauseDigest(clause as never)
      ),
      envelopeDigest: ownerReleaseByIntentEnvelopeDigest(STAMPED),
      signer: OWNER,
    });
    const signature = await owner.sign(
      ownerReleaseByIntentSignedBytes(request) as never,
    );
    if (signature.error) throw signature.error;
    return {
      request,
      signature: ownerReleaseByIntentSignature(
        new Uint8Array(signature.ok),
      ),
    };
  };

  /** The `set` creating the record of `signed`, labeled at its root by
   * `label`, for a commit leaving the document with `proposed`. */
  const recordOp = (
    signed: SignedOwnerReleaseByIntentRequest,
    proposed: unknown,
    label: unknown,
  ) => ({
    op: "set",
    id: ownerReleaseByIntentRecordId(
      ID,
      ownerReleaseByIntentRequestDigest(signed.request),
    ),
    value: {
      value: ownerReleaseByIntentRecord(
        signed,
        ownerReleaseByIntentEnvelopeDigest(proposed),
      ),
      cfc: envelope([{ path: [], origin: "declared", label }]),
    },
  });

  it("resolves a record label held by reference to the label document the commit creates", async () => {
    const signed = await signedRelease();

    commit([
      { op: "set", id: OWNER_LABEL_REF, value: { value: OWNER_LABEL } },
      { op: "set", id: ID, value: { value: { rooms: [] }, cfc: RELEASED } },
      recordOp(signed, RELEASED, { $ref: OWNER_LABEL_REF }),
    ]);

    expect(read(engine, { id: ID })).toEqual({
      value: { rooms: [] },
      cfc: RELEASED,
    });
  });

  it("resolves a record label held by reference to a label document the store already holds", async () => {
    commit([{ op: "set", id: OWNER_LABEL_REF, value: { value: OWNER_LABEL } }]);
    const signed = await signedRelease();

    commit([
      { op: "set", id: ID, value: { value: { rooms: [] }, cfc: RELEASED } },
      recordOp(signed, RELEASED, { $ref: OWNER_LABEL_REF }),
    ]);

    expect(read(engine, { id: ID })).toEqual({
      value: { rooms: [] },
      cfc: RELEASED,
    });
  });

  it("throws for a record label held by reference to a label document nobody stored", async () => {
    const signed = await signedRelease();

    expect(() =>
      commit([
        { op: "set", id: ID, value: { value: { rooms: [] }, cfc: RELEASED } },
        recordOp(signed, RELEASED, { $ref: OWNER_LABEL_REF }),
      ])
    ).toThrow(
      `memory v2 commit references CFC label document ${OWNER_LABEL_REF} that is neither included in the commit nor stored in the space`,
    );
    expect(read(engine, { id: ID })).toEqual({
      value: { rooms: [] },
      cfc: STAMPED,
    });
  });

  it("throws for a release whose commit deletes the document, which leaves it no envelope to judge", async () => {
    const signed = await signedRelease();

    expect(() =>
      commit([
        { op: "delete", id: ID },
        recordOp(signed, null, OWNER_LABEL),
      ])
    ).toThrow(
      `the store refuses: the commit writes no envelope of the document it names, ${ID}`,
    );
    expect(read(engine, { id: ID })).toEqual({
      value: { rooms: [] },
      cfc: STAMPED,
    });
  });
});
