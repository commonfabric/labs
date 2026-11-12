import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import type { URI } from "@commonfabric/memory/interface";
import {
  ownerReleaseByIntentEnvelopeDigest,
  ownerReleaseByIntentRequest,
  ownerReleaseByIntentSignature,
  ownerReleaseByIntentSignedBytes,
  type SignedOwnerReleaseByIntentRequest,
} from "@commonfabric/memory/v2/cfc-owner-release-by-intent";

import { ACLManager } from "../../src/acl-manager.ts";
import {
  CONFIDENTIALITY_RELEASE_WRITER,
  OWNER_RELEASE_BY_INTENT_WRITER,
} from "../../src/cfc/confidentiality-release-plan.ts";
import {
  addCfcDenialListener,
  type CfcDenial,
} from "../../src/cfc/denial-report.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
  type PostCommitSideEffect,
  type RuntimeWritePolicyAuthorization,
  runtimeWritePolicyAuthorization,
} from "../../src/cfc/types.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { registerSchemaDocument } from "../../src/schema-registry.ts";
import {
  readRuntimeSecret,
  runtimeSecretLink,
} from "../../src/runtime-secret.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  createDuplicateWorkTransaction,
  ExtendedStorageTransaction,
  readOnlyCfcView,
  releaseAccessListOf,
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
  TransactionWrapper,
} from "../../src/storage/extended-storage-transaction.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
} from "../../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "storage-extended-storage-transaction",
);
const space = signer.did();
const other = (await Identity.fromPassphrase("storage-ext-tx-other")).did();

/** The link to the document `of:<name>` in `space`. */
const link = (name: string, path: string[] = []) => ({
  space,
  id: `of:${name}` as URI,
  scope: "space" as const,
  type: "application/json" as const,
  path,
});

/** The address of the document `of:<name>` in `space`, as a store names it. */
const address = (name: string, path: string[] = []) => ({
  ...link(name),
  path: ["value", ...path],
});

/**
 * `target` with its member `name` hidden, as a transaction that does not
 * implement that optional member presents itself. Every other member is the
 * target's own, bound to it.
 */
const lacking = <T extends object>(target: T, name: keyof T): T =>
  new Proxy(target, {
    get: (held, key) => {
      if (key === name) return undefined;
      const member = Reflect.get(held, key, held);
      return typeof member === "function" ? member.bind(held) : member;
    },
  });

/** An authorization argument that does not carry the runtime's mark. */
const forgedAuthorization = {
  forged: true,
} as unknown as RuntimeWritePolicyAuthorization;

/** The reasons an invalidated preparation holds, or none. */
const invalidationReasons = (tx: IExtendedStorageTransaction): string[] => {
  const prepare = tx.getCfcState().prepare;
  return prepare.status === "invalidated" ? [...prepare.reasons] : [];
};

/** How often the transaction module has logged a `storage-error`. */
const storageErrorsLogged = (): number => {
  const counts = getLoggerCountsBreakdown()["extended-storage-transaction"];
  return typeof counts === "object" ? counts["storage-error"]?.total ?? 0 : 0;
};

describe("extended-storage-transaction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** A transaction the runtime creates. */
  const edit = (): ExtendedStorageTransaction => {
    const tx = runtime.edit();
    if (!(tx instanceof ExtendedStorageTransaction)) {
      throw new Error("the runtime created a transaction of another class");
    }
    return tx;
  };

  /** A transaction over a fresh storage transaction, with no runtime setup. */
  const bare = () => new ExtendedStorageTransaction(edit().tx);

  /** A runtime transaction that wrote `of:<name>` and prepared over it. */
  const prepared = (name: string) => {
    const tx = edit();
    tx.writeValueOrThrow(link(name), { text: "draft" });
    tx.markCfcRelevant("test");
    tx.prepareCfc();
    expect(tx.getCfcState().prepare.status).toBe("prepared");
    return tx;
  };

  /** Commits a document `of:<name>` whose `text` field holds `text`. */
  const seedText = async (name: string, text: string) => {
    const tx = edit();
    tx.writeValueOrThrow(link(name), { text });
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /**
   * Writes a document `of:<name>` carrying a label at its root, and the
   * schema document the label map names when `schemaInstalled`, and returns
   * the transaction it wrote them in.
   */
  const seedLabeled = (name: string, schemaInstalled = true) => {
    const tx = edit();
    if (schemaInstalled) writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, link(name), {
      value: { title: "labeled" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            origin: "derived",
            label: { confidentiality: [cfcAtom.personalSpace(other)] },
          }],
        },
      },
    });
    return tx;
  };

  describe("ExtendedStorageTransaction", () => {
    describe("instance members", () => {
      describe("configureSealDestination()", () => {
        it("throws on a second call", () => {
          // The runtime configures the destination when it creates a
          // transaction, so this call is the second.
          const tx = edit();
          expect(() => tx.configureSealDestination(undefined)).toThrow(
            "Seal destination is already configured for this transaction",
          );
          tx.abort();
        });
      });

      describe("setCfcServingIdentity() and setCfcClientIdentity()", () => {
        it("keep the identity of the first call and ignore later ones", () => {
          const tx = bare();
          tx.setCfcServingIdentity(space);
          tx.setCfcClientIdentity(space);
          tx.setCfcServingIdentity(other);
          tx.setCfcClientIdentity(other);
          expect(tx.getCfcState().servingIdentity).toBe(space);
          expect(tx.getCfcState().clientIdentity).toBe(space);
          tx.abort();
        });
      });

      describe("writeOrThrow()", () => {
        it("refuses a write to a runtime secret, and writes the value of any other document", () => {
          const tx = edit();
          const secret = runtimeSecretLink(space, "storage-ext-tx-secret");
          expect(() => tx.writeValueOrThrow(secret, "forged")).toThrow(
            `${secret.id} is a runtime secret`,
          );
          expect(readRuntimeSecret(tx, space, "storage-ext-tx-secret"))
            .toBeUndefined();
          tx.writeValueOrThrow(link("not-a-secret"), "plain");
          expect(tx.readValueOrThrow(link("not-a-secret"))).toBe("plain");
          tx.abort();
        });

        it("creates the containers a path into a missing document needs", () => {
          const tx = edit();
          tx.writeOrThrow(address("created", ["list", "0", "name"]), "x");
          expect(tx.readValueOrThrow(link("created"))).toEqual({
            list: [{ name: "x" }],
          });
          tx.abort();
        });

        it("deletes nothing, and creates nothing, for a path that does not exist", () => {
          const tx = edit();
          tx.writeValueOrThrow(link("kept"), { a: 1 });
          tx.writeOrThrow(address("kept", ["b", "c"]), undefined, {
            delete: true,
          });
          expect(tx.readValueOrThrow(link("kept"))).toEqual({ a: 1 });
          tx.abort();
        });
      });

      describe("writeValuesOrThrow()", () => {
        it("writes one at a time over a transaction that cannot batch", () => {
          const tx = new ExtendedStorageTransaction(
            lacking(edit().tx, "writeBatch"),
          );
          tx.writeValueOrThrow(link("dropped"), "before");
          tx.writeValuesOrThrow([
            { address: link("first"), value: 1 },
            { address: link("second"), value: 2 },
            { address: link("dropped"), value: "ignored", delete: true },
          ]);
          expect(tx.readValueOrThrow(link("first"))).toBe(1);
          expect(tx.readValueOrThrow(link("second"))).toBe(2);
          expect(tx.readValueOrThrow(link("dropped"))).toBeUndefined();
          tx.abort();
        });
      });

      describe("recordTextChanges() and recordSqliteWrite()", () => {
        it("throw over a transaction that does not support them", () => {
          const inner = edit().tx;
          const noText = new ExtendedStorageTransaction(
            lacking(inner, "recordTextChanges"),
          );
          expect(() =>
            noText.recordTextChanges(link("text", ["body"]), [{ from: 0 }])
          ).toThrow("storage transaction does not support recordTextChanges()");
          const noSqlite = new ExtendedStorageTransaction(
            lacking(inner, "recordSqliteWrite"),
          );
          expect(() =>
            noSqlite.recordSqliteWrite(space, {
              op: "sqlite",
              db: { id: "of:db", tables: {} },
              sql: "CREATE TABLE notes (body TEXT)",
              params: [],
            })
          ).toThrow("storage transaction does not support recordSqliteWrite()");
          inner.abort();
        });
      });

      describe("invalidating a preparation", () => {
        it("invalidates it for a write made after it", () => {
          const tx = prepared("late-write");
          expect(tx.write(address("late-write", ["text"]), "final").ok)
            .toBeDefined();
          expect(invalidationReasons(tx)).toContain("write-after-prepare");
          tx.abort();
        });

        it("invalidates it for text changes recorded after it", async () => {
          await seedText("late-text", "draft");
          const tx = edit();
          tx.markCfcRelevant("test");
          tx.prepareCfc();
          expect(tx.getCfcState().prepare.status).toBe("prepared");
          expect(
            tx.recordTextChanges(link("late-text", ["text"]), [{
              from: 5,
              insert: "ed",
            }]),
          ).toBe("drafted");
          expect(invalidationReasons(tx)).toContain(
            "text-changes-after-prepare",
          );
          tx.abort();
        });

        it("invalidates it for a whole-value root recorded after it, and not for one recorded without the runtime's mark", () => {
          const tx = prepared("late-root");
          const root = { ...link("late-root"), path: [] };
          tx.recordCfcAssertedValueRoot(root, forgedAuthorization);
          expect(tx.getCfcState().prepare.status).toBe("prepared");
          tx.recordCfcAssertedValueRoot(root, runtimeWritePolicyAuthorization);
          expect(invalidationReasons(tx)).toContain(
            "asserted-value-root-added",
          );
          tx.abort();
        });
      });

      describe("markCfcPieceCreator()", () => {
        const piece = { space, id: "of:piece" };

        it("records a creator once, however often it is marked", () => {
          const tx = edit();
          tx.markCfcPieceCreator(runtimeWritePolicyAuthorization, piece, space);
          tx.markCfcPieceCreator(runtimeWritePolicyAuthorization, piece, space);
          tx.markCfcPieceCreator(runtimeWritePolicyAuthorization, piece, other);
          expect(tx.getCfcState().pieceCreators).toEqual([
            { piece, creator: space },
            { piece, creator: other },
          ]);
          tx.abort();
        });

        it("records nothing without the runtime's mark", () => {
          const tx = edit();
          tx.markCfcPieceCreator(forgedAuthorization, piece, space);
          expect(tx.getCfcState().pieceCreators).toEqual([]);
          tx.abort();
        });

        it("invalidates a preparation it follows", () => {
          const tx = prepared("piece-after-prepare");
          tx.markCfcPieceCreator(runtimeWritePolicyAuthorization, piece, space);
          expect(invalidationReasons(tx)).toContain("piece-creator-marked");
          tx.abort();
        });
      });

      describe("releaseCfcConfidentiality()", () => {
        it("throws for a document whose stored labels cannot be read", () => {
          // The label map names a schema document the store does not hold.
          const tx = seedLabeled("unreadable-release", false);
          setCfcImplementationIdentity(tx, {
            kind: "builtin",
            builtinId: CONFIDENTIALITY_RELEASE_WRITER,
          });
          expect(() =>
            tx.releaseCfcConfidentiality({
              space,
              id: link("unreadable-release").id,
              path: [],
              keep: [],
            })
          ).toThrow("Cannot lower confidentiality in of:unreadable-release:");
          tx.abort();
        });
      });

      describe("releaseCfcConfidentialityByIntent()", () => {
        /** The owner's signed request to release `other`'s clause. */
        const signedRequest = async (
          name: string,
          storedCfc: unknown,
        ): Promise<SignedOwnerReleaseByIntentRequest> => {
          const request = ownerReleaseByIntentRequest({
            space,
            document: link(name).id,
            path: [],
            releasedClauseDigests: ["unused"],
            envelopeDigest: ownerReleaseByIntentEnvelopeDigest(storedCfc),
            signer: space,
          });
          const signed = await signer.sign(
            ownerReleaseByIntentSignedBytes(request) as never,
          );
          if (signed.error) throw signed.error;
          return {
            request,
            signature: ownerReleaseByIntentSignature(
              new Uint8Array(signed.ok),
            ),
          };
        };

        /** `tx`, given the release-by-intent writer's identity. */
        const asReleaseWriter = (tx: IExtendedStorageTransaction) => {
          setCfcImplementationIdentity(tx, {
            kind: "builtin",
            builtinId: OWNER_RELEASE_BY_INTENT_WRITER,
          });
          return tx;
        };

        it("refuses a document that stores no labels", async () => {
          const tx = asReleaseWriter(edit());
          tx.writeValueOrThrow(link("unlabeled"), { title: "plain" });
          const signed = await signedRequest("unlabeled", undefined);
          expect(() => tx.releaseCfcConfidentialityByIntent({ signed }))
            .toThrow("the document stores no labels");
          tx.abort();
        });

        it("refuses a document whose stored labels cannot be read", async () => {
          const tx = asReleaseWriter(
            seedLabeled("unreadable-intent", false),
          );
          const storedCfc = tx.readOrThrow({
            ...link("unreadable-intent"),
            path: ["cfc"],
          });
          const signed = await signedRequest("unreadable-intent", storedCfc);
          expect(() => tx.releaseCfcConfidentialityByIntent({ signed }))
            .toThrow(
              "Cannot release by intent at <root> of of:unreadable-intent: " +
                `stored schemaHash ${SEED_ENVELOPE_SCHEMA_HASH} is missing`,
            );
          tx.abort();
        });
      });

      describe("commit()", () => {
        it("reports a commit refused for activity that moved after preparing, with the reasons, to a denial listener and the instrumentation", async () => {
          const rejections: (readonly string[])[] = [];
          const tx = new ExtendedStorageTransaction(edit().tx, {
            onCommitRejected: (reasons) => rejections.push(reasons),
          });
          tx.setCfcEnforcementMode("enforce-strict");
          tx.writeValueOrThrow(link("moved"), "one");
          tx.markCfcRelevant("test");
          tx.prepareForCommit();
          // The module delegations are bound by the digest and do not
          // invalidate the preparation, so only the commit's recheck sees
          // them change.
          tx.setCfcModuleDelegations(
            new Map([[space, new Map([["module-a", ["module-b"]]])]]),
          );
          const denials: CfcDenial[] = [];
          const stop = addCfcDenialListener((denial) => denials.push(denial));
          try {
            const { error } = await tx.commit().settled;
            expect(error?.message).toContain("prepared digest changed");
          } finally {
            stop();
          }
          expect(denials.map((denial) => denial.code)).toEqual([
            "write-prepared-digest-mismatch",
          ]);
          expect(denials[0].inputs.reasons).toEqual([
            "prepared-digest-mismatch",
          ]);
          expect(rejections).toEqual([["prepared digest changed"]]);
        });

        it("logs a settle callback that throws, and still runs the others", () => {
          const tx = edit();
          const ran: string[] = [];
          tx.addVerdictCallback(() => {
            throw new Error("verdict callback failed");
          });
          tx.addVerdictCallback(() => ran.push("verdict"));
          tx.addCommitCallback(() => {
            throw new Error("commit callback failed");
          });
          tx.addCommitCallback(() => ran.push("commit"));
          const before = storageErrorsLogged();
          tx.abort();
          expect(ran).toEqual(["verdict", "commit"]);
          expect(storageErrorsLogged() - before).toBe(2);
        });

        it("logs nothing when no settle callback throws", () => {
          const tx = edit();
          tx.addVerdictCallback(() => {});
          tx.addCommitCallback(() => {});
          const before = storageErrorsLogged();
          tx.abort();
          expect(storageErrorsLogged() - before).toBe(0);
        });
      });

      describe("getCfcState()", () => {
        it("yields read-only values from a map's entries()", () => {
          const tx = edit();
          tx.recordCfcWritePolicyInput({
            kind: "structural-provenance",
            target: { space, id: "of:store", scope: "space", path: [] },
            claim: CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
            sources: [],
          }, runtimeWritePolicyAuthorization);
          const identities = tx.getCfcState().writePolicyInputIdentities;
          const entries = [...identities.entries()];
          expect(entries).toHaveLength(1);
          const [[input]] = entries;
          expect(input).toBe(tx.getCfcState().writePolicyInputs[0]);
          expect(() => identities.set(input, undefined)).toThrow("read-only");
          tx.abort();
        });
      });
    });
  });

  describe("readOnlyCfcView()", () => {
    it("wraps the values a map's entries() yields, and keeps the keys", () => {
      const key = { k: 1 };
      const backing = new Map([[key, { id: "x" }]]);
      const view = readOnlyCfcView(backing);
      const [[viewKey, value]] = [...view.entries()];
      expect(viewKey).toBe(key);
      expect(() => {
        value.id = "y";
      }).toThrow("read-only");
      expect(backing.get(key)?.id).toBe("x");
    });
  });

  describe("setCfcTrustSnapshot()", () => {
    it("sets the snapshot on the transaction a wrapper wraps", () => {
      const tx = edit();
      const snapshot = { id: "wrapped", actingPrincipal: other };
      setCfcTrustSnapshot(createDuplicateWorkTransaction(tx), snapshot);
      expect(tx.getCfcState().trustSnapshot).toEqual(snapshot);
      tx.abort();
    });

    it("throws for an object the runtime did not create", () => {
      const tx = edit();
      const before = tx.getCfcState().trustSnapshot;
      const forged = new TransactionWrapper(new Proxy(tx, {}));
      expect(() =>
        setCfcTrustSnapshot(forged, { id: "forged", actingPrincipal: other })
      ).toThrow(
        "setCfcTrustSnapshot() requires a transaction the runtime created",
      );
      expect(tx.getCfcState().trustSnapshot).toEqual(before);
      tx.abort();
    });
  });

  describe("releaseAccessListOf()", () => {
    it("returns the stored list, no list for a document that is not a record, and not stored for a space that has none", async () => {
      const before = edit();
      expect(releaseAccessListOf(before, space)).toEqual({ stored: false });
      before.abort();

      await new ACLManager(runtime, space).set(other, "OWNER");
      await storageManager.synced();

      const tx = edit();
      const list = releaseAccessListOf(tx, space);
      expect(list.stored).toBe(true);
      expect(list.stored && list.value).toMatchObject({ [other]: "OWNER" });
      seedStoredEnvelope(tx, {
        space,
        id: aclDocId(space) as URI,
        scope: "space",
        type: "application/json",
        path: [],
      }, "not a record");
      expect(releaseAccessListOf(tx, space)).toEqual({
        stored: true,
        value: undefined,
      });
      tx.abort();
    });
  });

  describe("TransactionWrapper", () => {
    describe("instance members", () => {
      it("sets the modes of the transaction it wraps", () => {
        const tx = bare();
        // Writes are authoritative only for a transaction with a seal
        // destination.
        tx.configureSealDestination({ seal: (sealed) => sealed.tx.commit() });
        const wrapper = new TransactionWrapper(tx);
        expect(tx.isAuthoritativeWrites()).toBe(false);
        wrapper.setCfcEnforcementMode("enforce-explicit");
        wrapper.setCfcFlowLabelsMode("observe");
        wrapper.setCfcWriteFloorMode("observe");
        wrapper.setCfcTriggerReadGating(true);
        wrapper.markAuthoritativeWrites();
        const state = tx.getCfcState();
        expect(state.enforcementMode).toBe("enforce-explicit");
        expect(state.flowLabelsMode).toBe("observe");
        expect(state.writeFloorMode).toBe("observe");
        expect(state.triggerReadGating).toBe(true);
        expect(tx.isAuthoritativeWrites()).toBe(true);
        tx.abort();
      });

      it("stages through to the transaction it wraps", () => {
        const schema: JSONSchema = {
          type: "object",
          title: "storage-ext-tx-staged",
        };
        const hash = internSchemaAsTaggedHashString(schema);
        registerSchemaDocument(hash, schema);
        const tx = edit();
        const wrapper = new TransactionWrapper(tx);
        const cid = `cid:${hash}`;
        const staged = () =>
          [...tx.getWriteDetails?.(space) ?? []].map((write) =>
            write.address.id
          );
        expect(staged()).not.toContain(cid);
        wrapper.stageSchemaDocClosure(space, hash);
        expect(staged()).toContain(cid);

        expect(readRuntimeSecret(tx, space, "wrapped-secret"))
          .toBeUndefined();
        wrapper.ensureRuntimeSecret(
          space,
          "wrapped-secret",
          runtimeWritePolicyAuthorization,
        );
        expect(readRuntimeSecret(tx, space, "wrapped-secret")).toEqual(
          expect.any(String),
        );
        tx.abort();
      });

      it("prepares and invalidates the transaction it wraps", () => {
        const tx = edit();
        const wrapper = new TransactionWrapper(tx);
        tx.writeValueOrThrow(link("wrapped-prepare"), 1);
        tx.markCfcRelevant("test");
        const digest = wrapper.prepareCfc();
        const prepare = tx.getCfcState().prepare;
        expect(prepare.status === "prepared" && prepare.digest).toBe(digest);
        wrapper.invalidateCfc("wrapper-invalidated");
        expect(invalidationReasons(tx)).toEqual(["wrapper-invalidated"]);
        tx.abort();
      });

      it("records CFC state on the transaction it wraps", () => {
        const tx = edit();
        const wrapper = new TransactionWrapper(tx);
        const piece = { space, id: "of:wrapped-piece" };
        wrapper.markCfcPieceCreator(
          runtimeWritePolicyAuthorization,
          piece,
          space,
        );
        expect(tx.getCfcState().pieceCreators).toEqual([
          { piece, creator: space },
        ]);
        wrapper.noteCfcSinkReleaseReject({
          sink: "fetchText",
          effectId: "effect-1",
          detail: "too confidential",
        });
        expect(tx.getCfcState().diagnostics).toContain(
          "sink-request release rejected for fetchText (effect-1): " +
            "too confidential",
        );
        const input = (id: string) => ({
          kind: "structural-provenance" as const,
          target: { space, id, scope: "space" as const, path: [] },
          claim: CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
          sources: [],
        });
        wrapper.recordCfcWritePolicyInput(
          input("of:authorized"),
          runtimeWritePolicyAuthorization,
        );
        wrapper.recordCfcWritePolicyInput(input("of:unauthorized"));
        const [authorized, unauthorized] = tx.getCfcState().writePolicyInputs;
        expect(wrapper.isRuntimeWritePolicyInput(authorized)).toBe(true);
        expect(wrapper.isRuntimeWritePolicyInput(unauthorized)).toBe(false);
        tx.abort();
      });

      it("releases through the transaction it wraps", () => {
        const tx = seedLabeled("wrapped-release", false);
        const wrapper = new TransactionWrapper(tx);
        setCfcImplementationIdentity(wrapper, {
          kind: "builtin",
          builtinId: CONFIDENTIALITY_RELEASE_WRITER,
        });
        expect(() =>
          wrapper.releaseCfcConfidentiality({
            space,
            id: link("wrapped-release").id,
            path: [],
            keep: [],
          })
        ).toThrow("Cannot lower confidentiality in of:wrapped-release:");
        expect(() =>
          wrapper.releaseCfcConfidentialityByIntent({
            signed: { request: {}, signature: "" } as never,
          })
        ).toThrow(OWNER_RELEASE_BY_INTENT_WRITER);
        tx.abort();
      });

      it("reads and writes through the transaction it wraps", () => {
        const tx = edit();
        const wrapper = new TransactionWrapper(tx);
        expect(wrapper.journal).toBe(tx.journal);
        expect(wrapper.write(address("wrapped-write"), "written").ok)
          .toBeDefined();
        expect(tx.readValueOrThrow(link("wrapped-write"))).toBe("written");
        expect(wrapper.getWriteAttemptLog()).toEqual(tx.getWriteAttemptLog());
        expect(wrapper.getWriteAttemptLog().length).toBeGreaterThan(0);
        tx.abort();
      });

      it("answers whether the transaction it wraps is read-only", () => {
        const tx = edit();
        const wrapper = new TransactionWrapper(tx);
        expect(wrapper.isReadOnly()).toBe(false);
        tx.setReadOnly("test");
        expect(wrapper.isReadOnly()).toBe(true);
        tx.clearReadOnly();
        tx.abort();
      });

      it("answers whether there is flow-label work as the transaction it wraps does", async () => {
        await seedLabeled("flow-source").commit().settled;
        for (
          const wrapped of [(tx: IExtendedStorageTransaction) => tx, (
            tx: IExtendedStorageTransaction,
          ) => lacking(tx, "probeFlowLabelWork")]
        ) {
          const tx = edit();
          const wrapper = new TransactionWrapper(wrapped(tx));
          expect(wrapper.probeFlowLabelWork()).toBe(false);
          tx.readValueOrThrow(link("flow-source"));
          expect(wrapper.probeFlowLabelWork()).toBe(true);
          tx.abort();
        }
      });

      describe("addCommitPrecondition()", () => {
        it("adds the precondition to the transaction it wraps", () => {
          const tx = edit();
          const wrapper = new TransactionWrapper(tx);
          const precondition = {
            kind: "entity-absent" as const,
            id: "of:absent",
          };
          wrapper.addCommitPrecondition(space, precondition);
          expect(tx.getCommitPreconditions(space)).toEqual([precondition]);
          expect(wrapper.getCommitPreconditions(space)).toEqual([
            precondition,
          ]);
          tx.abort();
        });
      });

      describe("over a transaction without optional members", () => {
        it("throws for a gate or a write the transaction cannot carry", () => {
          const tx = edit();
          expect(() =>
            new TransactionWrapper(lacking(tx, "addCommitPrecondition"))
              .addCommitPrecondition(space, {
                kind: "entity-absent",
                id: "of:absent",
              })
          ).toThrow(
            "storage transaction does not support addCommitPrecondition()",
          );
          expect(() =>
            new TransactionWrapper(lacking(tx, "recordTextChanges"))
              .recordTextChanges(link("text", ["body"]), [{ from: 0 }])
          ).toThrow("storage transaction does not support recordTextChanges()");
          expect(() =>
            new TransactionWrapper(lacking(tx, "recordSqliteWrite"))
              .recordSqliteWrite(space, {
                op: "sqlite",
                db: { id: "of:db", tables: {} },
                sql: "CREATE TABLE notes (body TEXT)",
                params: [],
              })
          ).toThrow("storage transaction does not support recordSqliteWrite()");
          expect(tx.getCommitPreconditions(space)).toBeUndefined();
          tx.abort();
        });

        it("records text changes and SQLite writes when it can", async () => {
          await seedText("text", "hello");
          const tx = edit();
          const wrapper = new TransactionWrapper(tx);
          expect(
            wrapper.recordTextChanges(link("text", ["text"]), [{
              from: 5,
              insert: "!",
            }]),
          ).toBe("hello!");
          tx.abort();

          const sqlite = edit();
          expect(sqlite.hasWrites()).toBe(false);
          new TransactionWrapper(sqlite).recordSqliteWrite(space, {
            op: "sqlite",
            db: { id: "of:db", tables: {} },
            sql: "CREATE TABLE notes (body TEXT)",
            params: [],
          });
          expect(sqlite.hasWrites()).toBe(true);
          sqlite.abort();
        });

        it("reads the write attempts off the storage transaction", () => {
          const tx = edit();
          tx.writeValueOrThrow(link("attempted"), 1);
          const wrapper = new TransactionWrapper(
            lacking(tx, "getWriteAttemptLog"),
          );
          expect(wrapper.getWriteAttemptLog()).toEqual(tx.getWriteAttemptLog());
          expect(wrapper.getWriteAttemptLog().length).toBeGreaterThan(0);
          tx.abort();
        });

        it("writes values one at a time when the transaction cannot batch", () => {
          const tx = edit();
          tx.writeValueOrThrow(link("unbatched-dropped"), "before");
          new TransactionWrapper(lacking(tx, "writeValuesOrThrow"))
            .writeValuesOrThrow([
              { address: link("unbatched"), value: 1 },
              {
                address: link("unbatched-dropped"),
                value: "ignored",
                delete: true,
              },
            ]);
          expect(tx.readValueOrThrow(link("unbatched"))).toBe(1);
          expect(tx.readValueOrThrow(link("unbatched-dropped")))
            .toBeUndefined();
          tx.abort();
        });
      });

      describe("settling", () => {
        /** A post-commit effect that records how it ended in `log`. */
        const effect = (log: string[]): PostCommitSideEffect => ({
          id: "effect",
          kind: "test",
          flush: () => {
            log.push("flushed");
          },
          abandon: (error: CommitError) => {
            log.push(`abandoned: ${error.message}`);
          },
        });

        it("settles the post-commit effects of the transaction it wraps", async () => {
          const tx = edit();
          const wrapper = new TransactionWrapper(tx);
          const log: string[] = [];
          tx.writeValueOrThrow(link("effects"), 1);
          tx.enqueuePostCommitEffect(effect(log));
          const settled = tx.commit().settled;
          await wrapper.postCommitEffectsSettled();
          expect(log).toEqual(["flushed"]);
          expect((await settled).error).toBeUndefined();
        });

        it("abandons the staged work of the transaction it wraps, unless it duplicates it", () => {
          const tx = edit();
          const log: string[] = [];
          tx.enqueuePostCommitEffect(effect(log));
          const error = {
            name: "StorageTransactionAborted" as const,
            message: "gone",
            reason: "gone",
          };
          createDuplicateWorkTransaction(tx).abandonStagedWork(error);
          expect(log).toEqual([]);
          new TransactionWrapper(tx).abandonStagedWork(error);
          expect(log).toEqual(["abandoned: gone"]);
          tx.abort();
        });

        it("registers a verdict callback on the transaction it wraps, unless it duplicates it", () => {
          const tx = edit();
          const verdicts: string[] = [];
          new TransactionWrapper(tx).addVerdictCallback(() =>
            verdicts.push("wrapper")
          );
          createDuplicateWorkTransaction(tx).addVerdictCallback(() =>
            verdicts.push("duplicate")
          );
          tx.abort();
          expect(verdicts).toEqual(["wrapper"]);
        });
      });
    });
  });
});
