import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import {
  resetCommitPreconditionsConfig,
  setCommitPreconditionsConfig,
} from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { JSONSchema } from "../src/builder/types.ts";
import { preparedDigestFor } from "../src/cfc/canonical.ts";
import { evaluateExchangeRules } from "../src/cfc/exchange-eval.ts";
import type { CfcGrantResolverQuery } from "../src/cfc/exchange-eval.ts";
import {
  CFC_GRANT_ABSENT_DIGEST,
  CFC_GRANT_ID_PREFIX,
  cfcGrantConsumedReceiptId,
  cfcGrantDocId,
  createTxCfcGrantResolver,
  expandCfcGrantFacts,
  flushCfcGrantConsumptionClaims,
  prepareCfcGrantWrite,
  verifyCfcGrantDocument,
} from "../src/cfc/grants.ts";
import type { CfcEnforcementMode, IFCLabel } from "../src/cfc/mod.ts";
import {
  buildCfcPolicySnapshot,
  type ExchangeRule,
} from "../src/cfc/policy.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  StorageManager,
} from "../src/storage/cache.deno.ts";
import {
  ExtendedStorageTransaction,
  setCfcImplementationIdentity,
} from "../src/storage/extended-storage-transaction.ts";
import {
  isCfcEnforcementRejection,
  isPermanentRejection,
} from "../src/storage/rejection.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-single-use-grants");

// Single-use CFC grants (declass build-order item 5;
// docs/specs/cfc-persisted-declassification.md §2.2 "Single-use releases",
// spec §6.5.1-.2 claim semantics): a grant with `singleUse: true` satisfies
// its policyState guard only while its consumption receipt does not exist,
// and the releasing transaction claims the receipt atomically with the
// release via the shipped `experimental.commitPreconditions` exactly-once
// discipline (create-only receipt document, `receipt-exists` permanent
// rejection for the create-only race loser).

const ALICE = "did:key:alice";
const BOB = "did:key:bob";
const userBob = cfcAtom.user(BOB);
const PHOTO_REF = "of:photo42";

const identity = {
  space: ALICE,
  kind: "ShareGrant",
  owner: ALICE,
  resource: PHOTO_REF,
};

const baseInput = {
  kind: "ShareGrant",
  owner: ALICE,
  resource: PHOTO_REF,
  audience: [userBob],
  grantedAt: 1000,
};

describe("CFC single-use grants (§2.2 single-use releases)", () => {
  //
  // Item 1: the `singleUse` field
  //

  describe("singleUse field (writer validation)", () => {
    it("accepts singleUse: true and stores it in the value", () => {
      const prepared = prepareCfcGrantWrite(
        { ...baseInput, singleUse: true },
        ALICE,
      );
      expect(prepared.value.singleUse).toBe(true);
    });

    it("omits the field for a standing grant (absent, not false)", () => {
      const prepared = prepareCfcGrantWrite(baseInput, ALICE);
      expect("singleUse" in prepared.value).toBe(false);
    });

    it("refuses anything but boolean-true or absent (malformed)", () => {
      // `false` is refused too: "standing" has exactly one spelling (absent),
      // so no consumer can ever treat a present-but-false marker as a third
      // state.
      const attempt = (singleUse: unknown) => () =>
        prepareCfcGrantWrite(
          { ...baseInput, singleUse } as Parameters<
            typeof prepareCfcGrantWrite
          >[0],
          ALICE,
        );
      expect(attempt(false)).toThrow(/singleUse/);
      expect(attempt(1)).toThrow(/singleUse/);
      expect(attempt("yes")).toThrow(/singleUse/);
      expect(attempt(null)).toThrow(/singleUse/);
    });

    it("does not participate in the address (identity = release scope)", () => {
      // Same release scope, same document: converting a standing grant to
      // single-use (or back) is an in-place update of the SAME durable
      // decision, exactly like audience/lifecycle changes.
      const standing = prepareCfcGrantWrite(baseInput, ALICE);
      const single = prepareCfcGrantWrite(
        { ...baseInput, singleUse: true },
        ALICE,
      );
      expect(single.id).toBe(standing.id);
      expect(single.id).toBe(cfcGrantDocId(identity));
    });
  });

  describe("singleUse field (verify-on-read)", () => {
    const id = cfcGrantDocId(identity);
    const value = {
      version: 1,
      ...identity,
      audience: [userBob],
      grantedAt: 1000,
    };

    it("admits singleUse: true and absent", () => {
      expect(verifyCfcGrantDocument(ALICE, id, value)).toBeDefined();
      expect(
        verifyCfcGrantDocument(ALICE, id, { ...value, singleUse: true })
          ?.singleUse,
      ).toBe(true);
    });

    it("rejects a malformed singleUse (defense in depth)", () => {
      expect(verifyCfcGrantDocument(ALICE, id, { ...value, singleUse: false }))
        .toBeUndefined();
      expect(verifyCfcGrantDocument(ALICE, id, { ...value, singleUse: 1 }))
        .toBeUndefined();
      expect(
        verifyCfcGrantDocument(ALICE, id, { ...value, singleUse: "true" }),
      ).toBeUndefined();
    });

    it("carries singleUse through fact expansion (absent stays absent)", () => {
      const single = verifyCfcGrantDocument(ALICE, id, {
        ...value,
        singleUse: true,
      })!;
      expect(expandCfcGrantFacts(single)[0]).toMatchObject({
        singleUse: true,
      });
      const standing = verifyCfcGrantDocument(ALICE, id, value)!;
      const fact = expandCfcGrantFacts(standing)[0] as Record<string, unknown>;
      // Standing facts stay byte-identical to #4627 — no new key.
      expect("singleUse" in fact).toBe(false);
    });
  });

  //
  // Item 2: the consumption receipt identity
  //

  describe("consumption receipt derivation", () => {
    const grantId = cfcGrantDocId(identity);

    it("derives a deterministic receipt id in the reserved namespace", () => {
      const receipt = cfcGrantConsumedReceiptId(grantId);
      expect(receipt.startsWith(CFC_GRANT_ID_PREFIX)).toBe(true);
      expect(cfcGrantConsumedReceiptId(grantId)).toBe(receipt);
    });

    it("is distinct from the grant id and varies with it", () => {
      const receipt = cfcGrantConsumedReceiptId(grantId);
      expect(receipt).not.toBe(grantId);
      const other = cfcGrantDocId({ ...identity, resource: "of:other" });
      expect(cfcGrantConsumedReceiptId(other)).not.toBe(receipt);
    });
  });

  //
  // Shared harness
  //
  // A labeled cell, a policyState-guarded sink rule, and a Runtime whose
  // experimental commitPreconditions flag is the receipts dial. Every region
  // below draws on these.
  //

  const SECRET_SCHEMA = internSchema(
    {
      type: "object",
      properties: {
        secret: { type: "string", ifc: { confidentiality: ["never-fits"] } },
      },
      required: ["secret"],
    } satisfies JSONSchema,
    true,
  );

  const seedLabeledCell = async (
    runtime: Runtime,
    id: string,
    label: IFCLabel,
  ): Promise<void> => {
    const seed = runtime.edit();
    const target = runtime.getCell(signer.did(), id, undefined, seed);
    const targetId = target.getAsNormalizedFullLink().id;
    seedStoredEnvelope(seed, {
      space: signer.did(),
      scope: "space",
      id: targetId,
      path: [],
    }, {
      value: { secret: "rosebud" },
      cfc: {
        version: 1,
        schemaHash: SECRET_SCHEMA.taggedHashString,
        labelMap: { version: 1, entries: [{ path: ["secret"], label }] },
      },
    });
    seed.writeOrThrow({
      space: signer.did(),
      scope: "space",
      id: `cid:${SECRET_SCHEMA.taggedHashString}`,
      path: [],
    }, { value: SECRET_SCHEMA.schema });
    expect((await seed.commit()).ok).toBeDefined();
  };

  // The §13.4.4 rule at the network egress boundary (grant-records shape).
  const sinkShareRule: ExchangeRule = {
    id: "user-to-user-share",
    appliesTo: { type: CFC_ATOM_TYPE.User, subject: { var: "$owner" } },
    preCondition: {
      policyState: [{
        kind: "ShareGrant",
        owner: { var: "$owner" },
        resource: PHOTO_REF,
        audience: { type: CFC_ATOM_TYPE.User, subject: { var: "$recipient" } },
      }],
      boundary: [{
        type: CFC_ATOM_TYPE.BoundaryContext,
        key: "sinkClass",
        value: "network",
      }],
    },
    post: {
      addAlternatives: [{
        type: CFC_ATOM_TYPE.User,
        subject: { var: "$recipient" },
      }],
    },
  };

  const withRuntime = async (
    opts: {
      receipts?: boolean;
      policyEvaluation?: "off" | "observe" | "enforce";
      enforcement?: CfcEnforcementMode;
      rules?: readonly ExchangeRule[];
    },
    body: (
      runtime: Runtime,
      storageManager: ReturnType<typeof StorageManager.emulate>,
    ) => void | Promise<void>,
  ): Promise<void> => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The receipts dial: the Runtime constructor propagates it to the
      // ambient commit-preconditions config the storage commit consults.
      experimental: { commitPreconditions: opts.receipts ?? true },
      cfcSinkMaxConfidentiality: { fetchJson: [userBob] },
      cfcPolicyRecords: [{
        id: "share-policy",
        rules: [...(opts.rules ?? [sinkShareRule])],
      }],
      // The rule firings these tests assert on happen inside policy
      // evaluation.
      cfcPolicyEvaluation: opts.policyEvaluation ?? "enforce",
      // An unstated rung is the one the runtime resolves for a construction
      // that names none. The S18 gate case below names its own; nothing else
      // in this file does.
      cfcEnforcementMode: opts.enforcement,
    });
    try {
      await body(runtime, storageManager);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  };

  const writeGrant = async (
    runtime: Runtime,
    overrides: Record<string, unknown> = {},
  ): Promise<{ space: string; id: string }> => {
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, {
      kind: "builtin",
      builtinId: "cfc-grant-writer",
    });
    const written = tx.writeCfcGrant({
      kind: "ShareGrant",
      owner: signer.did(),
      resource: PHOTO_REF,
      audience: [userBob],
      grantedAt: 1000,
      singleUse: true,
      ...overrides,
    });
    const result = await tx.commit();
    expect(result.ok).toBeDefined();
    return written;
  };

  const grantIdFor = (_runtime: Runtime): URI =>
    cfcGrantDocId({
      space: signer.did(),
      kind: "ShareGrant",
      owner: signer.did(),
      resource: PHOTO_REF,
    });

  // Read the labeled cell, enqueue the gated egress, prepare. Returns the
  // OPEN transaction plus its prepare outcome; callers commit or abort.
  const buildRelease = (
    runtime: Runtime,
    id: string,
    effectSuffix = "",
  ) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(signer.did(), id, SECRET_SCHEMA.schema, tx);
    expect(cell.key("secret").get()).toBe("rosebud");
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchJson",
      `fetchJson:single-use-${id}${effectSuffix}`,
      createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
      "fetchJson-start",
      () => {},
    );
    tx.prepareCfc();
    const state = tx.getCfcState();
    return {
      tx,
      reasons: state.prepare.status === "invalidated"
        ? [...state.prepare.reasons]
        : [],
      diagnostics: [...state.diagnostics],
      prepare: state.prepare,
    };
  };

  const readReceipt = (runtime: Runtime, receiptId: URI): unknown => {
    const tx = runtime.edit();
    const value = tx.readOrThrow({
      space: signer.did(),
      id: receiptId,
      type: "application/json",
      path: ["value"],
    });
    tx.abort();
    return value;
  };

  const stagedReceiptWrite = (
    tx: ReturnType<Runtime["edit"]>,
    receiptId: URI,
  ): boolean =>
    [...(tx.getWriteDetails?.(signer.did() as MemorySpace) ?? [])].some(
      (write) => write.address.id === receiptId,
    );

  //
  // Consuming vs observing context (the seam decision)
  //
  // Single-use grants resolve ONLY in consuming contexts; everywhere else they
  // are unsatisfiable, fail closed.
  //

  describe("consumption context (resolver + evaluator threading)", () => {
    const singleUseRule: ExchangeRule = {
      id: "single-use-share",
      appliesTo: { type: CFC_ATOM_TYPE.User, subject: { var: "$owner" } },
      preCondition: {
        policyState: [{
          kind: "ShareGrant",
          owner: { var: "$owner" },
          resource: PHOTO_REF,
          audience: {
            type: CFC_ATOM_TYPE.User,
            subject: { var: "$recipient" },
          },
        }],
      },
      post: {
        addAlternatives: [{
          type: CFC_ATOM_TYPE.User,
          subject: { var: "$recipient" },
        }],
      },
    };
    const ruleSnapshot = buildCfcPolicySnapshot([{
      id: "p",
      rules: [singleUseRule],
    }])!;

    it("stamps the context onto resolver queries (absent = observing)", () => {
      const queries: CfcGrantResolverQuery[] = [];
      const resolver = (query: CfcGrantResolverQuery) => {
        queries.push(query);
        return [];
      };
      evaluateExchangeRules(
        { confidentiality: [cfcAtom.user(ALICE)] },
        ruleSnapshot,
        { grantResolver: resolver },
      );
      evaluateExchangeRules(
        { confidentiality: [cfcAtom.user(ALICE)] },
        ruleSnapshot,
        { grantResolver: resolver, grantConsumption: "consuming" },
      );
      expect(queries.length).toBe(2);
      expect(queries[0].consumption).toBe("observing");
      expect(queries[1].consumption).toBe("consuming");
    });

    it("a single-use grant is unsatisfiable in observing queries; a standing grant resolves", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime); // singleUse: true
        const tx = runtime.edit();
        const resolver = createTxCfcGrantResolver(tx);
        const fields = { owner: signer.did(), resource: PHOTO_REF };
        // Absent consumption → observing → unsatisfiable.
        expect(resolver({ kind: "ShareGrant", fields })).toEqual([]);
        // Explicit observing → unsatisfiable.
        expect(
          resolver({ kind: "ShareGrant", fields, consumption: "observing" }),
        ).toEqual([]);
        // No receipt was consulted for the observing evaluations — the grant
        // is unsatisfiable there regardless of receipt state, so the decision
        // never depended on it.
        const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
        expect(
          tx.getCfcState().consultedGrants.some((g) => g.id === receiptId),
        ).toBe(false);
        tx.abort();

        // The SAME release scope as a standing grant resolves in an
        // observing query (regression pin: the context axis is single-use
        // only).
        await writeGrant(runtime, { singleUse: undefined });
        const tx2 = runtime.edit();
        const standingResolver = createTxCfcGrantResolver(tx2);
        expect(
          standingResolver({ kind: "ShareGrant", fields }).length,
        ).toBe(1);
        tx2.abort();
      });
    });

    it("resolves in a consuming query, records the receipt consulted-absent, and stages the claim", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        const grantId = grantIdFor(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantId);
        const tx = runtime.edit();
        const resolver = createTxCfcGrantResolver(tx);
        const facts = resolver({
          kind: "ShareGrant",
          fields: { owner: signer.did(), resource: PHOTO_REF },
          consumption: "consuming",
        });
        expect(facts.length).toBe(1);
        expect(facts[0]).toMatchObject({ singleUse: true });
        // Both the grant AND the receipt joined the consulted set — the
        // receipt as ABSENT (digest binding, same discipline as the grant).
        const consulted = tx.getCfcState().consultedGrants;
        expect(consulted.some((g) => g.id === grantId)).toBe(true);
        expect(
          consulted.some((g) =>
            g.id === receiptId && g.digest === CFC_GRANT_ABSENT_DIGEST
          ),
        ).toBe(true);
        // The claim flushes into a receipt write + create-only mark.
        expect(stagedReceiptWrite(tx, receiptId)).toBe(false);
        expect(flushCfcGrantConsumptionClaims(tx)).toEqual([]);
        expect(stagedReceiptWrite(tx, receiptId)).toBe(true);
        tx.abort();
      });
    });

    it("a durably consumed receipt makes the grant unsatisfiable in consuming queries", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        const grantId = grantIdFor(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantId);
        // Seed a receipt as another release would have committed it.
        const seed = runtime.edit();
        setCfcImplementationIdentity(seed, {
          kind: "builtin",
          builtinId: "cfc-grant-writer",
        });
        // Receipts live in the reserved namespace: use an OBSERVE-mode
        // runtime? No — write privileged is not reachable here, so seed
        // through a fresh observe-enforcement runtime sharing storage is
        // overkill; instead exercise the real path: a full release commit.
        seed.abort();
        await seedLabeledCell(runtime, "consumed-check", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const release = buildRelease(runtime, "consumed-check");
        expect(release.reasons).toEqual([]);
        expect((await release.tx.commit()).ok).toBeDefined();
        expect(readReceipt(runtime, receiptId)).toBeDefined();

        // Now the consuming query fails closed and records the receipt as
        // PRESENT (content digest, not the absent marker).
        const tx = runtime.edit();
        const resolver = createTxCfcGrantResolver(tx);
        expect(
          resolver({
            kind: "ShareGrant",
            fields: { owner: signer.did(), resource: PHOTO_REF },
            consumption: "consuming",
          }),
        ).toEqual([]);
        expect(
          tx.getCfcState().consultedGrants.some((g) =>
            g.id === receiptId && g.digest !== CFC_GRANT_ABSENT_DIGEST
          ),
        ).toBe(true);
        // No claim staged for a consumed grant.
        expect(flushCfcGrantConsumptionClaims(tx)).toEqual([]);
        expect(stagedReceiptWrite(tx, receiptId)).toBe(false);
        tx.abort();
      });
    });

    it("garbage at the receipt address still counts as consumed (presence is the signal)", async () => {
      await withRuntime({}, async (runtime, storageManager) => {
        const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
        await writeGrant(runtime);
        // A bare storage transaction carries no CFC state, so the forged
        // receipt lands at the reserved address unexamined. The subject is
        // what the resolver then makes of the document sitting there.
        const seed = new ExtendedStorageTransaction(storageManager.edit());
        seed.writeOrThrow({
          space: signer.did(),
          id: receiptId,
          type: "application/json",
          path: ["value"],
        }, { forged: "garbage" });
        expect((await seed.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        const resolver = createTxCfcGrantResolver(tx);
        expect(
          resolver({
            kind: "ShareGrant",
            fields: { owner: signer.did(), resource: PHOTO_REF },
            consumption: "consuming",
          }),
        ).toEqual([]);
        tx.abort();
      });
    });

    it("a metadata-only (value-less) receipt document still counts as consumed", async () => {
      // Memory v2 documents can exist with no `value` subpath (a
      // metadata-only write). Presence of the receipt DOCUMENT is the
      // consumption signal, so the resolver must read the document root: a
      // value-subpath read would report `undefined` for such a document and
      // re-arm the grant at evaluation time (cubic P1 on #4649). The
      // create-only backstop would still kill the release at commit — any
      // prior set on the entity fails the entity-absent precondition — but
      // resolution itself must already fail closed as consumed.
      await withRuntime({}, async (runtime, storageManager) => {
        const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
        await writeGrant(runtime);
        // A full-document write with NO value key: the document exists, its
        // ["value"] subpath does not (the `source`-only sibling-field shape).
        // A bare storage transaction carries no CFC state, so it lands at the
        // reserved address unexamined.
        const seed = new ExtendedStorageTransaction(storageManager.edit());
        seed.writeOrThrow({
          space: signer.did(),
          id: receiptId,
          type: "application/json",
          path: [],
        }, { source: { note: "metadata-only" } } as never);
        expect((await seed.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        const resolver = createTxCfcGrantResolver(tx);
        expect(
          resolver({
            kind: "ShareGrant",
            fields: { owner: signer.did(), resource: PHOTO_REF },
            consumption: "consuming",
          }),
        ).toEqual([]);
        // The receipt joined the consulted set as PRESENT, not absent.
        expect(
          tx.getCfcState().consultedGrants.some((g) =>
            g.id === receiptId && g.digest !== CFC_GRANT_ABSENT_DIGEST
          ),
        ).toBe(true);
        tx.abort();
      });
    });

    it("flag off: unsatisfiable even in consuming queries, with a diagnostic", async () => {
      await withRuntime({ receipts: false }, async (runtime) => {
        await writeGrant(runtime);
        const tx = runtime.edit();
        const resolver = createTxCfcGrantResolver(tx);
        expect(
          resolver({
            kind: "ShareGrant",
            fields: { owner: signer.did(), resource: PHOTO_REF },
            consumption: "consuming",
          }),
        ).toEqual([]);
        expect(
          tx.getCfcState().diagnostics.some((note) =>
            note.includes("commitPreconditions")
          ),
        ).toBe(true);
        // Nothing claimed, nothing staged.
        expect(flushCfcGrantConsumptionClaims(tx)).toEqual([]);
        tx.abort();
      });
    });

    it("evaluator: a consuming context fires the rule; an observing one does not", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        const label = { confidentiality: [cfcAtom.user(signer.did())] };
        const observing = runtime.edit();
        const observed = evaluateExchangeRules(
          label,
          ruleSnapshot,
          { grantResolver: createTxCfcGrantResolver(observing) },
        );
        expect(observed.firings).toEqual([]);
        observing.abort();

        const consuming = runtime.edit();
        const consumed = evaluateExchangeRules(
          label,
          ruleSnapshot,
          {
            grantResolver: createTxCfcGrantResolver(consuming),
            grantConsumption: "consuming",
          },
        );
        expect(consumed.firings.length).toBe(1);
        consuming.abort();
      });
    });
  });

  //
  // Claim staging arms
  //

  describe("claim staging (flushCfcGrantConsumptionClaims)", () => {
    it("no claims → no writes, no reasons", async () => {
      await withRuntime({}, (runtime) => {
        const tx = runtime.edit();
        expect(flushCfcGrantConsumptionClaims(tx)).toEqual([]);
        tx.abort();
      });
    });

    it("is idempotent across repeated flushes (re-prepare shape)", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
        const tx = runtime.edit();
        const resolver = createTxCfcGrantResolver(tx);
        resolver({
          kind: "ShareGrant",
          fields: { owner: signer.did(), resource: PHOTO_REF },
          consumption: "consuming",
        });
        expect(flushCfcGrantConsumptionClaims(tx)).toEqual([]);
        expect(flushCfcGrantConsumptionClaims(tx)).toEqual([]);
        expect(stagedReceiptWrite(tx, receiptId)).toBe(true);
        tx.abort();
      });
    });

    it("own claim: a second resolution in the same tx still resolves (re-prepare)", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        const tx = runtime.edit();
        const query = {
          kind: "ShareGrant",
          fields: { owner: signer.did(), resource: PHOTO_REF },
          consumption: "consuming" as const,
        };
        expect(createTxCfcGrantResolver(tx)(query).length).toBe(1);
        expect(flushCfcGrantConsumptionClaims(tx)).toEqual([]);
        // Fresh resolver instance (a re-prepare builds one per evaluation):
        // the receipt now sits in this tx's journal, but it is OUR claim —
        // the same consumption, so the grant still resolves.
        expect(createTxCfcGrantResolver(tx)(query).length).toBe(1);
        tx.abort();
      });
    });

    it("one resolver never serves a consuming resolution to an observing query (memo isolation)", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        const tx = runtime.edit();
        const resolver = createTxCfcGrantResolver(tx);
        const fields = { owner: signer.did(), resource: PHOTO_REF };
        // Consuming first (facts memoized under the consuming key)…
        expect(
          resolver({ kind: "ShareGrant", fields, consumption: "consuming" })
            .length,
        ).toBe(1);
        // …must not leak to an observing query on the SAME instance.
        expect(resolver({ kind: "ShareGrant", fields })).toEqual([]);
        expect(
          resolver({ kind: "ShareGrant", fields, consumption: "observing" }),
        ).toEqual([]);
        tx.abort();
      });
    });

    it("fails closed when the storage cannot enforce create-only (no markCreateOnly)", () => {
      // A hand-built transaction without markCreateOnly (the optional
      // interface member): the claim's exactly-once witness cannot be
      // enforced, so staging must fail closed with a reason — never a
      // silently unguarded receipt write. The ambient flag is forced on so
      // the resolver reaches the claim path at all.
      setCommitPreconditionsConfig(true);
      try {
        const writes: unknown[] = [];
        const grantValue = prepareCfcGrantWrite(
          { ...baseInput, singleUse: true },
          ALICE,
        );
        const stubTx = {
          readOrThrow: (address: { id: string }) =>
            address.id === grantValue.id ? grantValue.value : undefined,
          recordCfcConsultedGrant: () => {},
          noteCfcDiagnostic: () => {},
          writeOrThrow: (address: unknown, value: unknown) =>
            writes.push([address, value]),
          // no markCreateOnly
        } as unknown as Parameters<typeof createTxCfcGrantResolver>[0];
        const resolver = createTxCfcGrantResolver(stubTx);
        expect(
          resolver({
            kind: "ShareGrant",
            fields: { owner: ALICE, resource: PHOTO_REF },
            consumption: "consuming",
          }).length,
        ).toBe(1);
        const failures = flushCfcGrantConsumptionClaims(stubTx);
        expect(failures.length).toBe(1);
        expect(failures[0]).toContain("markCreateOnly");
        // Mark-first discipline: the refused mark left no unguarded receipt
        // value in the journal.
        expect(writes).toEqual([]);
      } finally {
        resetCommitPreconditionsConfig();
      }
    });

    it("fails closed when a claim cannot be staged (cross-space write isolation)", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        const tx = runtime.edit();
        // Claim another space as the write target first: the receipt write
        // (owner's space) then violates single-space write isolation.
        tx.writeOrThrow({
          space: BOB as MemorySpace,
          id: "of:elsewhere" as URI,
          type: "application/json",
          path: ["value"],
        }, { probe: true });
        const resolver = createTxCfcGrantResolver(tx);
        expect(
          resolver({
            kind: "ShareGrant",
            fields: { owner: signer.did(), resource: PHOTO_REF },
            consumption: "consuming",
          }).length,
        ).toBe(1);
        const failures = flushCfcGrantConsumptionClaims(tx);
        expect(failures.length).toBe(1);
        expect(failures[0]).toContain("staging consumption receipt");
        tx.abort();
      });
    });
  });

  //
  // The core
  //
  // Consumption semantics at the sink egress gate, end to end.
  //

  describe("single-use release at the sink egress gate", () => {
    it("releases once, committing the receipt atomically; the second evaluation fails closed", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
        await seedLabeledCell(runtime, "single-release", {
          confidentiality: [cfcAtom.user(signer.did())],
        });

        const first = buildRelease(runtime, "single-release", "-1");
        expect(first.reasons).toEqual([]);
        // The receipt write is staged in the SAME transaction (atomic).
        expect(stagedReceiptWrite(first.tx, receiptId)).toBe(true);
        expect((await first.tx.commit()).ok).toBeDefined();
        // The receipt committed with the release.
        expect(readReceipt(runtime, receiptId)).toMatchObject({
          grantConsumed: { grantId: grantIdFor(runtime) },
        });

        // Second evaluation: the receipt exists → the rule no longer fires →
        // fail closed, exactly like revoked/expired.
        const second = buildRelease(runtime, "single-release", "-2");
        expect(
          second.reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
        second.tx.abort();
      });
    });

    it("standing grants (singleUse absent) release repeatedly with no receipt (regression pin)", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime, { singleUse: undefined });
        const grantId = grantIdFor(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantId);
        await seedLabeledCell(runtime, "standing-release", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        for (const suffix of ["-1", "-2"]) {
          const release = buildRelease(runtime, "standing-release", suffix);
          expect(release.reasons).toEqual([]);
          // No receipt machinery for standing grants: no staged write, no
          // receipt consulted — byte-identical decision inputs to #4627.
          expect(stagedReceiptWrite(release.tx, receiptId)).toBe(false);
          const prepared = release.prepare;
          expect(prepared.status).toBe("prepared");
          if (prepared.status === "prepared") {
            // The grant itself was consulted (plus any absent candidate
            // addresses the fixpoint's label-carried discovery probed — the
            // added User(bob) alternative re-matches the rule and probes
            // Bob's own would-be grant scope, #4627 behavior), but never
            // the consumption receipt.
            const consulted = prepared.input.consultedGrants!;
            expect(consulted.some((g) => g.id === grantId)).toBe(true);
            expect(consulted.some((g) => g.id === receiptId)).toBe(false);
          }
          expect((await release.tx.commit()).ok).toBeDefined();
        }
        expect(readReceipt(runtime, receiptId)).toBeUndefined();
      });
    });

    it("two racing releases in one runtime: exactly one commits; the re-run does not fire", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
        await seedLabeledCell(runtime, "racing-release", {
          confidentiality: [cfcAtom.user(signer.did())],
        });

        // Both transactions resolve the grant before either commits: both
        // see the receipt durably absent, both stage the claim.
        const first = buildRelease(runtime, "racing-release", "-1");
        const second = buildRelease(runtime, "racing-release", "-2");
        expect(first.reasons).toEqual([]);
        expect(second.reasons).toEqual([]);

        expect((await first.tx.commit()).ok).toBeDefined();
        // SAME-replica loser: the local replica already applied the winner,
        // so the loser dies on the client-side consistency guard
        // (StorageTransactionInconsistent — retryable class) before its
        // commit ever reaches the server precondition. Either rejection
        // surface converges identically: the re-run re-evaluates, the
        // receipt exists, the rule does not fire. The server-side
        // receipt-exists classification proper (a REMOTE second replica
        // that could not know) is pinned by the next test.
        const lost = await second.tx.commit();
        expect(lost.error).toBeDefined();

        // Exactly one release: the winner's receipt.
        expect(readReceipt(runtime, receiptId)).toMatchObject({
          grantConsumed: { grantId: grantIdFor(runtime) },
        });

        // Re-evaluation after the lost race: the receipt exists → the rule
        // no longer fires.
        const rerun = buildRelease(runtime, "racing-release", "-3");
        expect(
          rerun.reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
        rerun.tx.abort();
      });
    });

    it("a remote racing claim loses as a permanent receipt-exists rejection (create-only race)", async () => {
      // The create-only race proper needs a second REPLICA on the same
      // server: a same-replica loser is caught by the local consistency
      // guard first (previous test). A second storage manager sharing the
      // base manager's in-process server plays the remote releaser whose
      // replica never observed the winner's receipt.
      const base = StorageManager.emulate({ as: signer });
      // The server belongs to the base manager; connectTo never closes it.
      const remote = EmulatedStorageManager.connectTo(
        (base as unknown as { server(): MemoryV2Server.Server }).server(),
        { as: signer },
      );
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: base,
        experimental: { commitPreconditions: true },
        cfcSinkMaxConfidentiality: { fetchJson: [userBob] },
        cfcPolicyRecords: [{ id: "share-policy", rules: [sinkShareRule] }],
        // The release under test is a rule firing, which happens inside
        // policy evaluation.
        cfcPolicyEvaluation: "enforce",
      });
      try {
        await writeGrant(runtime);
        const grantId = grantIdFor(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantId);
        await seedLabeledCell(runtime, "remote-racing-release", {
          confidentiality: [cfcAtom.user(signer.did())],
        });

        // The remote releaser stages its claim — the receipt write plus the
        // create-only mark, exactly the shape flushCfcGrantConsumptionClaims
        // stages — against a replica that has not observed any receipt.
        const remoteTx = new ExtendedStorageTransaction(remote.edit());
        remoteTx.writeOrThrow({
          space: signer.did(),
          id: receiptId,
          type: "application/json",
          path: ["value"],
        }, {
          version: 1,
          grantConsumed: { grantId },
          space: signer.did(),
          consumedAt: 1000,
        });
        remoteTx.markCreateOnly({ space: signer.did(), id: receiptId });

        // The local release wins.
        const local = buildRelease(runtime, "remote-racing-release");
        expect(local.reasons).toEqual([]);
        expect((await local.tx.commit()).ok).toBeDefined();

        // The remote claim reaches the server unaware — and dies on the
        // entity-absent precondition as the PERMANENT receipt-exists
        // rejection the scheduler never retries.
        const lost = await remoteTx.commit();
        expect(lost.error).toBeDefined();
        expect(lost.error!.name).toBe("PreconditionFailedError");
        expect(
          (lost.error as { precondition?: string }).precondition,
        ).toBe("receipt-exists");
        expect(isPermanentRejection(lost.error!)).toBe(true);
      } finally {
        await runtime.dispose();
        await remote.close();
        await base.close();
      }
    });

    it("a failed commit consumes nothing; a retry can still consume (no-consume-on-failure)", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
        await seedLabeledCell(runtime, "failed-release", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        // A doc the release reads (confirmed) and an interloper then bumps,
        // making the release's commit fail on a stale confirmed read.
        const seedY = runtime.edit();
        seedY.writeOrThrow({
          space: signer.did(),
          id: "of:conflict-anchor" as URI,
          type: "application/json",
          path: ["value"],
        }, { rev: 1 });
        expect((await seedY.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        expect(
          tx.readOrThrow({
            space: signer.did(),
            id: "of:conflict-anchor" as URI,
            type: "application/json",
            path: ["value"],
          }),
        ).toMatchObject({ rev: 1 });
        const cell = runtime.getCell(
          signer.did(),
          "failed-release",
          SECRET_SCHEMA.schema,
          tx,
        );
        expect(cell.key("secret").get()).toBe("rosebud");
        enqueueSinkRequestPostCommitEffect(
          tx,
          "fetchJson",
          "fetchJson:single-use-failed-release",
          createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
          "fetchJson-start",
          () => {},
        );
        tx.prepareCfc();
        expect(tx.getCfcState().prepare.status).toBe("prepared");
        expect(stagedReceiptWrite(tx, receiptId)).toBe(true);

        // Interloper bumps the anchor; the prepared release's basis is stale.
        const interloper = runtime.edit();
        interloper.writeOrThrow({
          space: signer.did(),
          id: "of:conflict-anchor" as URI,
          type: "application/json",
          path: ["value"],
        }, { rev: 2 });
        expect((await interloper.commit()).ok).toBeDefined();

        const failed = await tx.commit();
        expect(failed.error).toBeDefined();
        // The staged receipt rode the failed transaction: nothing landed.
        expect(readReceipt(runtime, receiptId)).toBeUndefined();

        // The retry (a fresh transaction, as the scheduler would run it)
        // re-resolves the grant — the receipt is still absent — and lands.
        const retry = buildRelease(runtime, "failed-release", "-retry");
        expect(retry.reasons).toEqual([]);
        expect((await retry.tx.commit()).ok).toBeDefined();
        expect(readReceipt(runtime, receiptId)).toBeDefined();
      });
    });

    it("re-prepare in one transaction: still releases, one receipt, commit ok", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
        await seedLabeledCell(runtime, "reprepare-release", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const release = buildRelease(runtime, "reprepare-release");
        expect(release.reasons).toEqual([]);
        // Invalidate and re-prepare: the resolver finds its own staged
        // receipt in the journal and recognizes the claim as this
        // transaction's own consumption.
        release.tx.invalidateCfc("test-reprepare");
        release.tx.prepareCfc();
        expect(release.tx.getCfcState().prepare.status).toBe("prepared");
        expect((await release.tx.commit()).ok).toBeDefined();
        expect(readReceipt(runtime, receiptId)).toBeDefined();

        // Spent: the next evaluation fails closed.
        const next = buildRelease(runtime, "reprepare-release", "-next");
        expect(next.reasons.length).toBeGreaterThan(0);
        next.tx.abort();
      });
    });

    it("flag off: a single-use grant is unsatisfiable at the gate (never silently multi-use)", async () => {
      await withRuntime({ receipts: false }, async (runtime) => {
        await writeGrant(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
        await seedLabeledCell(runtime, "flag-off-release", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const release = buildRelease(runtime, "flag-off-release");
        expect(
          release.reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
        expect(
          release.diagnostics.some((note) =>
            note.includes("commitPreconditions")
          ),
        ).toBe(true);
        expect(stagedReceiptWrite(release.tx, receiptId)).toBe(false);
        release.tx.abort();

        // A standing grant under the SAME flag-off runtime keeps releasing
        // (the flag gates single-use consumption, nothing else).
        await writeGrant(runtime, { singleUse: undefined });
        const standing = buildRelease(runtime, "flag-off-release", "-standing");
        expect(standing.reasons).toEqual([]);
        standing.tx.abort();
      });
    });

    it("observe dial: decides on the raw label and never stages a claim", async () => {
      await withRuntime({ policyEvaluation: "observe" }, async (runtime) => {
        await writeGrant(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
        await seedLabeledCell(runtime, "observe-release", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const release = buildRelease(runtime, "observe-release");
        // Observe decides on the raw label: the egress still rejects.
        expect(
          release.reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
        // And the observing evaluation must not spend the grant: no claim.
        expect(stagedReceiptWrite(release.tx, receiptId)).toBe(false);
        release.tx.abort();
      });
    });

    it("receipt lookups never taint (internalVerifierRead discipline)", async () => {
      await withRuntime({}, async (runtime) => {
        await writeGrant(runtime);
        await seedLabeledCell(runtime, "no-taint-release", {
          confidentiality: [cfcAtom.user(signer.did())],
        });
        const release = buildRelease(runtime, "no-taint-release");
        expect(release.prepare.status).toBe("prepared");
        if (release.prepare.status !== "prepared") return;
        // Grant + receipt were consulted…
        const grantId = grantIdFor(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantId);
        const consulted = release.prepare.input.consultedGrants!;
        expect(consulted.some((g) => g.id === grantId)).toBe(true);
        expect(
          consulted.some((g) =>
            g.id === receiptId && g.digest === CFC_GRANT_ABSENT_DIGEST
          ),
        ).toBe(true);
        // …but neither entered the consumed read set.
        expect(
          release.prepare.input.consumedReads.some((read) =>
            read.id.startsWith(CFC_GRANT_ID_PREFIX)
          ),
        ).toBe(false);
        release.tx.abort();
      });
    });

    it("the input-requirement gate (gated write) consumes too: releases once, then fails closed", async () => {
      // The OTHER consuming site (design §2.2 seam decision): a write whose
      // maxConfidentiality ceiling is satisfied through the grant persists a
      // released value — the ceiling decision is durable, so it consumes
      // exactly like the sink gate. The rule carries no boundary guard
      // (write gates mint no BoundaryContext atoms).
      const writeGateRule: ExchangeRule = {
        ...sinkShareRule,
        preCondition: {
          policyState: sinkShareRule.preCondition!.policyState,
        },
      };
      const gatedSchema = {
        type: "object",
        // The released value lands on the document root carrying the owner's
        // confidentiality, so the store declares it there.
        ifc: { confidentiality: [cfcAtom.user(signer.did())] },
        properties: {
          out: {
            type: "string",
            ifc: { maxConfidentiality: [userBob] },
          },
        },
        required: ["out"],
      } as const satisfies JSONSchema;
      const readThenGatedWrite = (runtime: Runtime, suffix: string) => {
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "gated-write",
          SECRET_SCHEMA.schema,
          tx,
        );
        expect(cell.key("secret").get()).toBe("rosebud");
        runtime.getCell(
          signer.did(),
          `gated-write-out${suffix}`,
          gatedSchema,
          tx,
        ).set({ out: "derived" });
        tx.prepareCfc();
        const state = tx.getCfcState();
        return {
          tx,
          reasons: state.prepare.status === "invalidated"
            ? [...state.prepare.reasons]
            : [],
        };
      };
      await withRuntime({ rules: [writeGateRule] }, async (runtime) => {
        await writeGrant(runtime);
        const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
        await seedLabeledCell(runtime, "gated-write", {
          confidentiality: [cfcAtom.user(signer.did())],
        });

        const first = readThenGatedWrite(runtime, "-1");
        expect(first.reasons).toEqual([]);
        expect(stagedReceiptWrite(first.tx, receiptId)).toBe(true);
        expect((await first.tx.commit()).ok).toBeDefined();
        expect(readReceipt(runtime, receiptId)).toBeDefined();

        // Spent: the same gated write no longer releases.
        const second = readThenGatedWrite(runtime, "-2");
        expect(
          second.reasons.some((reason) =>
            reason.includes("maxConfidentiality failed")
          ),
        ).toBe(true);
        second.tx.abort();
      });
    });

    // The enforcement rung decides this case, so it names one. A reserved
    // grant address written through the ordinary write surface is refused
    // from `enforce-explicit` upward. Under `observe` the recorded reason
    // stays a diagnostic and under `disabled` no gate runs, so under either
    // of those the commit succeeds and the forged write lands.
    it("rejects an unprivileged write at the receipt address (S18 gate)", async () => {
      await withRuntime(
        { enforcement: "enforce-explicit" },
        async (runtime) => {
          const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
          const tx = runtime.edit();
          tx.writeOrThrow({
            space: signer.did(),
            id: receiptId,
            type: "application/json",
            path: ["value"],
          }, { forged: true });
          // Prepare, the way the runtime's own commit paths do, so the gate
          // this case is named for is the one that decides the commit. An
          // unprepared transaction is refused too, but for being unprepared:
          // that arm carries no reason and would still refuse if the gate
          // stopped recording the write.
          tx.prepareCfc();
          const state = tx.getCfcState().prepare;
          expect(state.status).toBe("invalidated");
          if (state.status === "invalidated") {
            expect(state.reasons.join(" ")).toContain(
              `unprivileged write to protected runtime surface ${receiptId}`,
            );
          }
          const result = await tx.commit();
          // The refusal, rather than any error at all. The message prefix is
          // what tells a CFC refusal apart from an ordinary abort or a storage
          // failure.
          expect(isCfcEnforcementRejection(result.error)).toBe(true);
        },
      );
    });
  });

  //
  // Digest binding (item 3)
  //
  // Receipt consulted-state rides consultedGrants with the grants' own
  // canonicalization + invalidation discipline.
  //

  describe("digest binding of the receipt state", () => {
    it("a receipt appearing between evaluations invalidates the prepared digest", async () => {
      await withRuntime({}, (runtime) => {
        const receiptId = cfcGrantConsumedReceiptId(grantIdFor(runtime));
        const tx = runtime.edit();
        // Prepare with the receipt consulted ABSENT (as a consuming
        // resolution records it)…
        tx.recordCfcConsultedGrant({
          space: signer.did(),
          id: receiptId,
          digest: CFC_GRANT_ABSENT_DIGEST,
        });
        tx.markCfcRelevant("test");
        tx.prepareCfc();
        expect(tx.getCfcState().prepare.status).toBe("prepared");
        // …then the receipt APPEARS (a re-evaluation records it present):
        // the prepared decision consumed "absent", so it must invalidate —
        // the cfc-prepared-digest-mismatch class, independent of the
        // create-only race.
        tx.recordCfcConsultedGrant({
          space: signer.did(),
          id: receiptId,
          digest: "receipt-present-digest",
        });
        const state = tx.getCfcState().prepare;
        expect(state.status).toBe("invalidated");
        if (state.status === "invalidated") {
          expect(state.reasons).toContain("consulted-grant-changed");
        }
        tx.abort();
      });
    });

    it("present vs absent receipt state digests differently (pure)", () => {
      const base = {
        consumedReads: [],
        attemptedWrites: [],
        writes: [],
        writeAttemptLog: [],
        dereferenceTraces: [],
        triggerReads: [],
        writePolicyInputs: [],
      };
      const receiptId = cfcGrantConsumedReceiptId(
        cfcGrantDocId(identity),
      );
      const absent = preparedDigestFor({
        ...base,
        consultedGrants: [{
          space: ALICE as MemorySpace,
          id: receiptId,
          digest: CFC_GRANT_ABSENT_DIGEST,
        }],
      });
      const present = preparedDigestFor({
        ...base,
        consultedGrants: [{
          space: ALICE as MemorySpace,
          id: receiptId,
          digest: "receipt-present-digest",
        }],
      });
      expect(absent).not.toBe(present);
      expect(preparedDigestFor(base)).not.toBe(absent);
      // Order-insensitive alongside the grant's own entry.
      const grantEntry = {
        space: ALICE as MemorySpace,
        id: cfcGrantDocId(identity),
        digest: "grant-digest",
      };
      const receiptEntry = {
        space: ALICE as MemorySpace,
        id: receiptId,
        digest: CFC_GRANT_ABSENT_DIGEST,
      };
      expect(
        preparedDigestFor({
          ...base,
          consultedGrants: [grantEntry, receiptEntry],
        }),
      ).toBe(
        preparedDigestFor({
          ...base,
          consultedGrants: [receiptEntry, grantEntry],
        }),
      );
    });
  });
});
