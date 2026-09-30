import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { writerClaimFilesCorrespond } from "../src/cfc/writer-claim-correspondence.ts";
import { mergeCfcSchemaEnvelopes } from "../src/cfc/schema-merge.ts";
import { reportDroppedCfcRejectedWrite } from "../src/scheduler/cfc-rejection-report.ts";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

/**
 * `writeAuthorizedBy` anchors on `moduleIdentity` + `bindingPath`; the claim's
 * file SPELLING is resolver-dependent (the same module spells
 * `/api/patterns/system/x.tsx` from a piece-deploy compile and
 * `/patterns/system/x.tsx` from an HTTP-resolved one) and must not shear
 * authorization. These tests pin the spelling tolerance at the two sites
 * that read EXISTING stamps (verification, stored-claim reconciliation), pin
 * that stamp MINTING stays exact (rebind — the tolerance never widens who
 * can create authority), and pin that identity and path stay fail-closed
 * (direct claim rotation across module versions remains a conflict; legitimate
 * updates retain the old claim and use authenticated `piece setsrc`
 * delegation).
 */

const MODULE_IDENTITY = "profile-home-module-identity";
const PIECE_SPELLING = "/api/patterns/system/profile-home.tsx";
const HTTP_SPELLING = "/patterns/system/profile-home.tsx";
const RELATIVE_SPELLING = "api/patterns/system/profile-home.tsx";

const signer = await Identity.fromPassphrase("wab-spelling-correspondence");

describe("writerClaimFilesCorrespond", () => {
  it("accepts equal spellings, with and without the leading slash", () => {
    expect(writerClaimFilesCorrespond(PIECE_SPELLING, PIECE_SPELLING)).toBe(
      true,
    );
    expect(writerClaimFilesCorrespond(RELATIVE_SPELLING, PIECE_SPELLING)).toBe(
      true,
    );
  });

  it("accepts spellings one leading segment apart, either direction", () => {
    expect(writerClaimFilesCorrespond(PIECE_SPELLING, HTTP_SPELLING)).toBe(
      true,
    );
    expect(writerClaimFilesCorrespond(HTTP_SPELLING, PIECE_SPELLING)).toBe(
      true,
    );
    expect(writerClaimFilesCorrespond(RELATIVE_SPELLING, HTTP_SPELLING)).toBe(
      true,
    );
  });

  it("rejects unrelated files, deeper divergence, and absent sides", () => {
    expect(writerClaimFilesCorrespond("/attacker.tsx", "/victim.tsx")).toBe(
      false,
    );
    // Two segments apart is beyond the toolchain's historical divergence.
    expect(
      writerClaimFilesCorrespond(
        "/a/api/patterns/system/profile-home.tsx",
        HTTP_SPELLING,
      ),
    ).toBe(false);
    expect(writerClaimFilesCorrespond(undefined, HTTP_SPELLING)).toBe(false);
    expect(writerClaimFilesCorrespond(HTTP_SPELLING, undefined)).toBe(false);
  });

  it("rejects same-leaf files in unrelated directories", () => {
    expect(
      writerClaimFilesCorrespond(
        "/patterns/system/profile-home.tsx",
        "/attacker/profile-home.tsx",
      ),
    ).toBe(false);
  });
});

describe("writeAuthorizedBy across resolver spellings (labs#4772)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    storageManager = undefined;
    runtime = undefined;
  });

  const makeRuntime = (snapshotId: string) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      trustSnapshotProvider: () => ({
        id: snapshotId,
        actingPrincipal: signer.did(),
      }),
    });
    return runtime;
  };

  const claimSchema = (identity: Record<string, unknown>): JSONSchema =>
    ({
      type: "object",
      properties: {
        bio: {
          type: "string",
          ifc: {
            writeAuthorizedBy: { __ctWriterIdentityOf: identity },
          },
        },
      },
      required: ["bio"],
    }) as unknown as JSONSchema;

  it("a stamped claim verifies against the same module compiled under the other spelling", async () => {
    // The cold-session bio save: claim minted+stamped by the piece-deploy
    // compile, live writer resolved via the HTTP compile. moduleIdentity
    // agrees; only the spelling differs. Before the fix the file arm
    // rejected this and the write was dropped.
    const rt = makeRuntime("ts-spelling-verify");
    const tx = rt.edit();
    const cell = rt.getCell(
      signer.did(),
      "wab-spelling-verify",
      claimSchema({
        moduleIdentity: MODULE_IDENTITY,
        file: PIECE_SPELLING,
        path: ["setBio"],
      }),
      tx,
    );
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: MODULE_IDENTITY,
      sourceFile: HTTP_SPELLING,
      bindingPath: ["setBio"],
    });
    cell.set({ bio: "written from the sidecar compile" });

    const digest = tx.prepareCfc();
    expect(digest).not.toBe("");
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
  });

  it("an UNSTAMPED claim is stamped by the owning binding under the SAME spelling, then verifies", async () => {
    // Stamp minting is exact by design: a claim being stamped rides a schema
    // emitted by the same compile as the writer, so their spellings agree.
    const rt = makeRuntime("ts-spelling-stamp");
    const tx = rt.edit();
    const cell = rt.getCell(
      signer.did(),
      "wab-spelling-stamp",
      claimSchema({ file: HTTP_SPELLING, path: ["setBio"] }),
      tx,
    );
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: MODULE_IDENTITY,
      sourceFile: HTTP_SPELLING,
      bindingPath: ["setBio"],
    });
    cell.set({ bio: "stamped in-universe" });

    const digest = tx.prepareCfc();
    expect(digest).not.toBe("");
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
  });

  it("an UNSTAMPED claim is NOT stamped across spellings — minting stays exact", async () => {
    // The reviewers' scenario (PR #4852 P1): a verified module whose path
    // differs from the unstamped claim's by one leading segment must not
    // mint the first stamp via the tolerance. Minting requires exact
    // spelling; cross-spelling healing happens only at reconcile-adoption,
    // where the stamp was already minted exactly by the owning compile.
    const rt = makeRuntime("ts-spelling-no-fuzzy-mint");
    const tx = rt.edit();
    const cell = rt.getCell(
      signer.did(),
      "wab-spelling-no-fuzzy-mint",
      claimSchema({ file: PIECE_SPELLING, path: ["setBio"] }),
      tx,
    );
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: "would-be-thief-module-identity",
      sourceFile: HTTP_SPELLING,
      bindingPath: ["setBio"],
    });
    cell.set({ bio: "must not land" });

    const digest = tx.prepareCfc();
    expect(digest).toBe("");
    const result = await tx.commit();
    expect(isCfcEnforcementRejection(result.error)).toBe(true);
  });

  it("a different moduleIdentity still fails closed even with corresponding spellings", async () => {
    // Cross-version rotation stays a conflict: the spelling tolerance must
    // never widen the identity arm (delegation is the setsrc-history topic).
    const rt = makeRuntime("ts-spelling-version");
    const tx = rt.edit();
    const cell = rt.getCell(
      signer.did(),
      "wab-spelling-version",
      claimSchema({
        moduleIdentity: "profile-home-module-identity-v1",
        file: PIECE_SPELLING,
        path: ["setBio"],
      }),
      tx,
    );
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: "profile-home-module-identity-v2",
      sourceFile: HTTP_SPELLING,
      bindingPath: ["setBio"],
    });
    cell.set({ bio: "v2 write" });

    const digest = tx.prepareCfc();
    expect(digest).toBe("");
    const result = await tx.commit();
    expect(isCfcEnforcementRejection(result.error)).toBe(true);
  });

  it("an unrelated file cannot ride the tolerance to a stamp", async () => {
    // Same binding-path name in a DIFFERENT module: the file correspondence
    // rejects, the claim stays unstamped, and the unstamped claim fails
    // closed at verification.
    const rt = makeRuntime("ts-spelling-foreign");
    const tx = rt.edit();
    const cell = rt.getCell(
      signer.did(),
      "wab-spelling-foreign",
      claimSchema({ file: PIECE_SPELLING, path: ["setBio"] }),
      tx,
    );
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: "attacker-module-identity",
      sourceFile: "/attacker/profile-home.tsx",
      bindingPath: ["setBio"],
    });
    cell.set({ bio: "stolen" });

    const digest = tx.prepareCfc();
    expect(digest).toBe("");
    const result = await tx.commit();
    expect(isCfcEnforcementRejection(result.error)).toBe(true);
  });
});

describe("stored-claim reconciliation across spellings", () => {
  const envelope = (
    identity: Record<string, unknown>,
    siblingProperties: Record<string, JSONSchemaObj> = {},
  ): JSONSchemaObj =>
    ({
      type: "object",
      properties: {
        bio: {
          type: "string",
          ifc: {
            writeAuthorizedBy: { __ctWriterIdentityOf: identity },
          },
        },
        ...siblingProperties,
      },
    }) as unknown as JSONSchemaObj;

  const claimOf = (schema: unknown): Record<string, unknown> =>
    // deno-lint-ignore no-explicit-any
    (schema as any).properties.bio.ifc.writeAuthorizedBy.__ctWriterIdentityOf;

  it("keeps the stored stamp when the candidate is the same claim under the other spelling", () => {
    const merged = mergeCfcSchemaEnvelopes(
      envelope({
        moduleIdentity: MODULE_IDENTITY,
        file: PIECE_SPELLING,
        path: ["setBio"],
      }),
      envelope({ file: HTTP_SPELLING, path: ["setBio"] }),
    );
    expect(claimOf(merged)).toEqual({
      moduleIdentity: MODULE_IDENTITY,
      file: PIECE_SPELLING,
      path: ["setBio"],
    });
  });

  it("adopts the candidate's stamp onto an unstamped stored claim across spellings", () => {
    // The self-heal direction: the store holds the unstamped claim (bricked
    // shape); a legitimately stamped input re-presents it under the other
    // spelling. The stamped side wins; the store heals.
    const merged = mergeCfcSchemaEnvelopes(
      envelope({ file: PIECE_SPELLING, path: ["setBio"] }),
      envelope({
        moduleIdentity: MODULE_IDENTITY,
        file: HTTP_SPELLING,
        path: ["setBio"],
      }),
    );
    expect(claimOf(merged)).toEqual({
      moduleIdentity: MODULE_IDENTITY,
      file: HTTP_SPELLING,
      path: ["setBio"],
    });
  });

  it("treats both-unstamped corresponding claims as the same claim (stored spelling wins)", () => {
    const merged = mergeCfcSchemaEnvelopes(
      envelope({ file: PIECE_SPELLING, path: ["setBio"] }),
      envelope({ file: HTTP_SPELLING, path: ["setBio"] }),
    );
    expect(claimOf(merged)).toEqual({
      file: PIECE_SPELLING,
      path: ["setBio"],
    });
  });

  it("keeps the stored stamp on two different stamps (version boundary: no rotation, no abort)", () => {
    // Claims are minted born stamped, so a republished module re-presents
    // this binding under its new moduleIdentity on every envelope write.
    // The stored stamp wins — the new version's field writes fail closed at
    // verification (pending setsrc-history delegation) while the envelope's
    // sibling writes keep committing; a merge-time conflict abort here
    // would brick the whole envelope on every pattern update.
    const merged = mergeCfcSchemaEnvelopes(
      envelope({
        moduleIdentity: "profile-home-module-identity-v1",
        file: PIECE_SPELLING,
        path: ["setBio"],
      }),
      envelope({
        moduleIdentity: "profile-home-module-identity-v2",
        file: HTTP_SPELLING,
        path: ["setBio"],
      }, { displayName: { type: "string" } }),
    );
    expect(claimOf(merged)).toEqual({
      moduleIdentity: "profile-home-module-identity-v1",
      file: PIECE_SPELLING,
      path: ["setBio"],
    });
    // deno-lint-ignore no-explicit-any
    expect((merged as any).properties.displayName).toEqual({ type: "string" });
  });

  it("keeps the stored stamp on two different stamps under non-corresponding spellings", () => {
    // The same authored tree served under `/api/patterns` and supplied from
    // a checkout under `/packages/patterns` spells the module two ways that
    // no single-segment strip relates. Both claims are stamped, so the
    // binding each means is its stamp and path; the stored one wins, as it
    // does when the spellings correspond, and the successor's writes are
    // for `piece setsrc` delegation to authorize.
    const merged = mergeCfcSchemaEnvelopes(
      envelope({
        moduleIdentity: "profile-home-module-identity-v1",
        file: PIECE_SPELLING,
        path: ["setBio"],
      }),
      envelope({
        moduleIdentity: "profile-home-module-identity-v2",
        file: "/packages/patterns/system/profile-home.tsx",
        path: ["setBio"],
      }),
    );
    expect(claimOf(merged)).toEqual({
      moduleIdentity: "profile-home-module-identity-v1",
      file: PIECE_SPELLING,
      path: ["setBio"],
    });
  });

  it("still conflicts on different binding paths", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes(
        envelope({ file: PIECE_SPELLING, path: ["setBio"] }),
        envelope({ file: HTTP_SPELLING, path: ["setName"] }),
      )
    ).toThrow("writeAuthorizedBy must remain stable");
  });

  it("still conflicts on non-corresponding files", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes(
        envelope({ file: "/victim.tsx", path: ["setBio"] }),
        envelope({ file: "/attacker.tsx", path: ["setBio"] }),
      )
    ).toThrow("writeAuthorizedBy must remain stable");
  });
});

describe("the labs#4772 heal end-to-end: exact mint + tolerant adoption + identity verify", () => {
  const signer2 = signer;
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    storageManager = undefined;
    runtime = undefined;
  });

  it("a bricked store (unstamped piece-spelled claim) heals through a cold-session write", async () => {
    // The full bio-save shape with minting kept exact: the cold session's
    // candidate schema carries the claim in the WRITER's own spelling
    // (same compile universe), so rebind stamps it exactly; the merge then
    // adopts that stamp onto the stored piece-spelled claim; verification
    // passes on moduleIdentity + bindingPath.
    const stored = {
      type: "object",
      properties: {
        bio: {
          type: "string",
          ifc: {
            writeAuthorizedBy: {
              __ctWriterIdentityOf: { file: PIECE_SPELLING, path: ["setBio"] },
            },
          },
        },
      },
    } as unknown as JSONSchemaObj;
    const candidate = {
      type: "object",
      properties: {
        bio: {
          type: "string",
          ifc: {
            writeAuthorizedBy: {
              __ctWriterIdentityOf: {
                moduleIdentity: MODULE_IDENTITY,
                file: HTTP_SPELLING,
                path: ["setBio"],
              },
            },
          },
        },
      },
    } as unknown as JSONSchemaObj;
    const merged = mergeCfcSchemaEnvelopes(stored, candidate);
    // deno-lint-ignore no-explicit-any
    const healedClaim = (merged as any).properties.bio.ifc.writeAuthorizedBy
      .__ctWriterIdentityOf;
    expect(healedClaim.moduleIdentity).toBe(MODULE_IDENTITY);

    storageManager = StorageManager.emulate({ as: signer2 });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      trustSnapshotProvider: () => ({
        id: "ts-heal-e2e",
        actingPrincipal: signer2.did(),
      }),
    });
    const tx = runtime.edit();
    const cell = runtime.getCell(
      signer2.did(),
      "wab-heal-e2e",
      merged as unknown as JSONSchema,
      tx,
    );
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: MODULE_IDENTITY,
      sourceFile: HTTP_SPELLING,
      bindingPath: ["setBio"],
    });
    cell.set({ bio: "healed and committed" });

    const digest = tx.prepareCfc();
    expect(digest).not.toBe("");
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
  });
});

describe("reportDroppedCfcRejectedWrite", () => {
  it("reports CFC-rejected drops unconditionally and stays silent otherwise", () => {
    const seen: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      seen.push(args);
    };
    try {
      reportDroppedCfcRejectedWrite(
        {
          name: "CfcCommitRefusalError",
          message: "CFC enforcement rejected commit: relevant transaction " +
            "was not prepared: writeAuthorizedBy failed at /",
        },
        "handler-1",
      );
      reportDroppedCfcRejectedWrite(
        {
          message: "CFC enforcement rejected commit: relevant transaction " +
            "was not prepared: lookalike only",
        },
        "handler-2",
      );
      reportDroppedCfcRejectedWrite(
        { name: "ConflictError", message: "some unrelated storage conflict" },
        "handler-3",
      );
      reportDroppedCfcRejectedWrite(undefined, "handler-4");
    } finally {
      console.error = original;
    }
    expect(seen.length).toBe(1);
    expect(String(seen[0]![0])).toContain("Owner-protected write dropped");
    expect(seen[0]![1]).toMatchObject({ writerId: "handler-1" });
  });
});
