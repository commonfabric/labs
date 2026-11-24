import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  buildCfcPolicySnapshot,
  type CfcPolicyRecordInput,
  type ExchangeRule,
} from "../src/cfc/policy.ts";

const signer = await Identity.fromPassphrase("runner-cfc-policy");

// Epic B2a (docs/history/plans/cfc-future-work-implementation.md §3): deployment
// policy records — validation, content digests, freeze discipline, and the
// Runtime → tx snapshot injection. The evaluator that consumes these lands
// in B4/B5.

const spaceReaderRule: ExchangeRule = {
  id: "space-reader-access",
  appliesTo: { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.HasRole,
      principal: { var: "$p" },
      space: { var: "$s" },
      role: "reader",
    }],
  },
  post: {
    addAlternatives: [{
      type: CFC_ATOM_TYPE.User,
      subject: { var: "$p" },
    }],
  },
};

const dropExpiresRule: ExchangeRule = {
  id: "drop-expires",
  appliesTo: { type: CFC_ATOM_TYPE.Expires, timestamp: { var: "$t" } },
  preCondition: {
    integrity: [{ type: "https://example.com/atoms/DetectedBy" }],
  },
  post: { dropClause: true },
};

const record = (
  overrides: Partial<CfcPolicyRecordInput> = {},
): CfcPolicyRecordInput => ({
  id: "standard-profile",
  rules: [spaceReaderRule, dropExpiresRule],
  ...overrides,
});

describe("CFC policy records (B2a)", () => {
  describe("digest stability", () => {
    it("is insensitive to authoring key order and explicit defaults", () => {
      const reordered: CfcPolicyRecordInput = {
        rules: [
          {
            post: spaceReaderRule.post,
            preCondition: spaceReaderRule.preCondition,
            appliesTo: spaceReaderRule.appliesTo,
            id: spaceReaderRule.id,
            // Explicit default spelled out — must not change the digest.
            preConfScope: "targetClause",
          },
          dropExpiresRule,
        ],
        id: "standard-profile",
      };
      const a = buildCfcPolicySnapshot([record()])!;
      const b = buildCfcPolicySnapshot([reordered])!;
      expect(a.records[0].digest).toBe(b.records[0].digest);
      expect(a.digest).toBe(b.digest);
    });

    it("changes when rule content changes", () => {
      const tightened: ExchangeRule = {
        ...spaceReaderRule,
        preCondition: {
          integrity: [{
            type: CFC_ATOM_TYPE.HasRole,
            principal: { var: "$p" },
            space: { var: "$s" },
            role: "owner",
          }],
        },
      };
      const a = buildCfcPolicySnapshot([record()])!;
      const b = buildCfcPolicySnapshot([
        record({ rules: [tightened, dropExpiresRule] }),
      ])!;
      expect(a.records[0].digest).not.toBe(b.records[0].digest);
      expect(a.digest).not.toBe(b.digest);
    });

    it("treats rule order as content", () => {
      // Reordering rules is a different record: evaluation order is
      // canonicalized separately (B4), but the authored artifact changed and
      // the digest must say so.
      const a = buildCfcPolicySnapshot([record()])!;
      const b = buildCfcPolicySnapshot([
        record({ rules: [dropExpiresRule, spaceReaderRule] }),
      ])!;
      expect(a.records[0].digest).not.toBe(b.records[0].digest);
    });

    it("verifies a supplied digest and fails closed on mismatch", () => {
      const built = buildCfcPolicySnapshot([record()])!;
      const good = record({ digest: built.records[0].digest });
      expect(buildCfcPolicySnapshot([good])!.digest).toBe(built.digest);
      expect(() => buildCfcPolicySnapshot([record({ digest: "sha256:bogus" })]))
        .toThrow(/digest mismatch/);
    });

    it("distinguishes no-policies from a declared empty set", () => {
      expect(buildCfcPolicySnapshot(undefined)).toBeUndefined();
      const empty = buildCfcPolicySnapshot([])!;
      expect(empty.records).toEqual([]);
      expect(typeof empty.digest).toBe("string");
      expect(empty.digest.length).toBeGreaterThan(0);
    });
  });

  describe("selection scope (B2b: label-carried policy selection)", () => {
    it("defaults to ambient and accepts an explicit selection", () => {
      const defaulted = buildCfcPolicySnapshot([record()])!;
      expect(defaulted.records[0].selection).toBe("ambient");
      const referenced = buildCfcPolicySnapshot([
        record({ selection: "referenced" }),
      ])!;
      expect(referenced.records[0].selection).toBe("referenced");
    });

    it("digests explicit ambient identically to the default", () => {
      const a = buildCfcPolicySnapshot([record()])!;
      const b = buildCfcPolicySnapshot([record({ selection: "ambient" })])!;
      expect(a.records[0].digest).toBe(b.records[0].digest);
      expect(a.digest).toBe(b.digest);
    });

    it("treats the selection mode as record content (digest binding)", () => {
      // A selection flip re-scopes every rule in the record, so it must
      // invalidate prepared digests through the snapshot digest the same way
      // a rule edit does (PreparedDigestInput.policySnapshot, Epic B5).
      const a = buildCfcPolicySnapshot([record()])!;
      const b = buildCfcPolicySnapshot([record({ selection: "referenced" })])!;
      expect(a.records[0].digest).not.toBe(b.records[0].digest);
      expect(a.digest).not.toBe(b.digest);
    });

    it("rejects unknown selection values", () => {
      expect(() =>
        buildCfcPolicySnapshot([
          record({ selection: "label" as never }),
        ])
      ).toThrow(/selection must be "ambient" or "referenced"/);
      expect(() =>
        buildCfcPolicySnapshot([
          record({ selection: 7 as never }),
        ])
      ).toThrow(/selection must be "ambient" or "referenced"/);
    });
  });

  describe("freeze discipline", () => {
    it("deep-freezes the snapshot, records, rules, and patterns", () => {
      const snapshot = buildCfcPolicySnapshot([record()])!;
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.records)).toBe(true);
      expect(Object.isFrozen(snapshot.records[0])).toBe(true);
      expect(Object.isFrozen(snapshot.records[0].rules)).toBe(true);
      expect(Object.isFrozen(snapshot.records[0].rules[0])).toBe(true);
      expect(Object.isFrozen(snapshot.records[0].rules[0].post)).toBe(true);
      expect(Object.isFrozen(snapshot.records[0].rules[0].appliesTo))
        .toBe(true);
      expect(() => {
        (snapshot.records as unknown as unknown[]).push("smuggled");
      }).toThrow();
    });
  });

  describe("malformed records fail closed at construction", () => {
    const cases: Array<[string, () => unknown, RegExp]> = [
      [
        "non-array input",
        () => buildCfcPolicySnapshot({} as unknown as never),
        /must be an array of policy records/,
      ],
      [
        "non-object record",
        () => buildCfcPolicySnapshot(["nope" as unknown as never]),
        /must be an object/,
      ],
      [
        // A Map passes `isObjectOrArray` but exposes no own string keys, so
        // field-by-field validation would read no guards — must fail closed
        // (cubic P1 on #4562).
        "Map-shaped record",
        () => buildCfcPolicySnapshot([new Map() as unknown as never]),
        /must be an object/,
      ],
      [
        "non-object rule",
        () => buildCfcPolicySnapshot([record({ rules: ["nope"] as never })]),
        /must be a rule object/,
      ],
      [
        "Map-shaped rule",
        () =>
          buildCfcPolicySnapshot([
            record({ rules: [new Map() as unknown as never] }),
          ]),
        /must be a rule object/,
      ],
      [
        "Map-shaped preCondition",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                {
                  ...spaceReaderRule,
                  preCondition: new Map([["integrity", "x"]]),
                } as unknown as never,
              ],
            }),
          ]),
        /preCondition must be an object/,
      ],
      [
        "Map-shaped post",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                {
                  ...spaceReaderRule,
                  post: new Map([["dropClause", true]]),
                } as unknown as never,
              ],
            }),
          ]),
        /needs a post object/,
      ],
      [
        "non-object preCondition",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                {
                  ...spaceReaderRule,
                  preCondition: "nope",
                } as unknown as never,
              ],
            }),
          ]),
        /preCondition must be an object/,
      ],
      [
        "non-array guard value",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                {
                  ...spaceReaderRule,
                  preCondition: { integrity: "nope" },
                } as unknown as never,
              ],
            }),
          ]),
        /preCondition\.integrity must be an array/,
      ],
      [
        "missing post",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                { ...spaceReaderRule, post: undefined } as unknown as never,
              ],
            }),
          ]),
        /needs a post object/,
      ],
      [
        "non-boolean dropClause",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                {
                  ...spaceReaderRule,
                  post: { dropClause: "yes" },
                } as unknown as never,
              ],
            }),
          ]),
        /dropClause must be a boolean/,
      ],
      [
        "empty record id",
        () => buildCfcPolicySnapshot([record({ id: "" })]),
        /non-empty string id/,
      ],
      [
        "duplicate record ids",
        () => buildCfcPolicySnapshot([record(), record()]),
        /duplicate record id/,
      ],
      [
        "unknown record key (typo)",
        () =>
          buildCfcPolicySnapshot([
            { ...record(), exchangeRules: [] } as unknown as never,
          ]),
        /unknown key "exchangeRules"/,
      ],
      [
        "missing rules",
        () =>
          buildCfcPolicySnapshot([
            { id: "r" } as unknown as never,
          ]),
        /needs a rules array/,
      ],
      [
        "duplicate rule ids",
        () =>
          buildCfcPolicySnapshot([
            record({ rules: [spaceReaderRule, spaceReaderRule] }),
          ]),
        /duplicate rule id/,
      ],
      [
        "rule without id",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                { ...spaceReaderRule, id: undefined } as unknown as never,
              ],
            }),
          ]),
        /non-empty string id/,
      ],
      [
        "rule without appliesTo",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                {
                  ...spaceReaderRule,
                  appliesTo: undefined,
                } as unknown as never,
              ],
            }),
          ]),
        /needs an appliesTo pattern/,
      ],
      [
        "appliesTo that is not a FabricValue",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [{
                ...spaceReaderRule,
                // @ts-expect-error: a `Date` is not a `FabricValue`.
                appliesTo: new Date(0),
              }],
            }),
          ]),
        /appliesTo is not a `FabricValue`/,
      ],
      [
        "unknown rule key (typo)",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                {
                  ...spaceReaderRule,
                  precondition: {},
                } as unknown as never,
              ],
            }),
          ]),
        /unknown key "precondition"/,
      ],
      [
        "bad preConfScope",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                {
                  ...spaceReaderRule,
                  preConfScope: "everywhere",
                } as unknown as never,
              ],
            }),
          ]),
        /preConfScope/,
      ],
      [
        "undefined entry in a guard array",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                {
                  ...spaceReaderRule,
                  preCondition: { integrity: [undefined] },
                } as unknown as never,
              ],
            }),
          ]),
        /undefined pattern/,
      ],
      [
        "guard pattern that is not a FabricValue",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [{
                ...spaceReaderRule,
                // @ts-expect-error: a `Date` is not a `FabricValue`.
                preCondition: { integrity: [new Date(0)] },
              }],
            }),
          ]),
        /contains a pattern that is not a `FabricValue`/,
      ],
      [
        "post with neither effect",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [{ ...spaceReaderRule, post: {} } as unknown as never],
            }),
          ]),
        /must addAlternatives or dropClause/,
      ],
      [
        "post with empty addAlternatives",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                {
                  ...spaceReaderRule,
                  post: { addAlternatives: [] },
                } as unknown as never,
              ],
            }),
          ]),
        /must addAlternatives or dropClause/,
      ],
      [
        "post with both effects",
        () =>
          buildCfcPolicySnapshot([
            record({
              rules: [
                {
                  ...spaceReaderRule,
                  post: {
                    addAlternatives: spaceReaderRule.post.addAlternatives,
                    dropClause: true,
                  },
                } as unknown as never,
              ],
            }),
          ]),
        /cannot both/,
      ],
    ];

    for (const [name, build, message] of cases) {
      it(`rejects ${name}`, () => {
        expect(build).toThrow(message);
      });
    }
  });

  describe("Runtime wiring", () => {
    it("builds the frozen snapshot at construction and injects it per tx", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcPolicyRecords: [record()],
      });
      try {
        expect(runtime.cfcPolicySnapshot).toBeDefined();
        expect(Object.isFrozen(runtime.cfcPolicySnapshot)).toBe(true);
        const tx = runtime.edit();
        expect(tx.getCfcState().policySnapshot).toBe(runtime.cfcPolicySnapshot);
        // Write-once: a later attempt (e.g. handler code reaching the
        // concrete tx) cannot swap the policy set mid-transaction.
        (tx as unknown as {
          setCfcPolicySnapshot: (s: unknown) => void;
        }).setCfcPolicySnapshot({ records: [], digest: "swapped" });
        expect(tx.getCfcState().policySnapshot).toBe(runtime.cfcPolicySnapshot);
        tx.abort();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("pins the no-policy state write-once: a later injection is refused", async () => {
      // Runtime with NO policies configured. The "no policies" state must be
      // just as write-once as a configured one — handler code reaching the
      // concrete tx must not be able to install exchange rules after the
      // Runtime's `undefined` call (codex P1 / cubic P2 on #4562).
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        expect(runtime.cfcPolicySnapshot).toBeUndefined();
        const tx = runtime.edit();
        expect(tx.getCfcState().policySnapshot).toBeUndefined();
        (tx as unknown as {
          setCfcPolicySnapshot: (s: unknown) => void;
        }).setCfcPolicySnapshot({
          records: [{ id: "injected", digest: "x", rules: [] }],
          digest: "injected",
        });
        // Still undefined — the injection was ignored.
        expect(tx.getCfcState().policySnapshot).toBeUndefined();
        tx.abort();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("fails Runtime construction on malformed records", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      try {
        expect(() =>
          new Runtime({
            apiUrl: new URL("https://example.com"),
            storageManager,
            cfcPolicyRecords: [record({ id: "" })],
          })
        ).toThrow(/non-empty string id/);
      } finally {
        await storageManager.close();
      }
    });
  });
});
