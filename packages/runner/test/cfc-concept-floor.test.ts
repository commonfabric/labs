import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { CfcAtom } from "@commonfabric/api/cfc";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { enableMockMode } from "@commonfabric/llm/client";

import type { JSONSchema } from "../src/builder/types.ts";
import { llmToolExecutionHelpers } from "../src/builtins/llm-dialog.ts";
import { conceptGuard } from "../src/cfc/atom-pattern.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import {
  cfcIntegritySatisfiesFloor,
  cfcIntegritySatisfiesFloorCoherently,
  cfcIntegrityWitnessKey,
} from "../src/cfc/observation.ts";
import {
  buildCfcTrustConfig,
  type CfcTrustConfigInput,
  createTrustResolver,
} from "../src/cfc/trust.ts";
import { createLLMFriendlyLink } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cfc-concept-floor");
enableMockMode();

// Epic D5 (docs/history/plans/cfc-future-work-implementation.md §5; spec §4.8.9 /
// §8.10.3 / §8.12.4.1): integrity-floor membership matches a CONCEPT-valued
// requirement against carried CONCRETE integrity through the acting
// principal's trust closure. A floor like "minted by a valid GPS measurement"
// accepts ANY concrete atom above the concept for the acting user (inv-11:
// concrete integrity is portable; concept satisfaction is acting-principal
// scoped). Plain-atom floors keep their exact-match / pattern meaning.

const GPS_CONCEPT = "https://commonfabric.org/cfc/concepts/gps-measurement";
const PRIVACY_CONCEPT =
  "https://commonfabric.org/cfc/concepts/privacy-preserving";
const AUDITOR = "did:key:gps-auditor";
const BOB = "did:key:bob";
const GPS_TYPE = "https://example.com/atoms/GPSMeasurement";
const APPROVED = { type: "https://example.com/atoms/Approved" };

const concept = (uri: string) => cfcAtom.concept(uri);
// A concrete measurement atom (device-scoped): two devices are SIBLINGS under
// the concept — both above it, neither dominating the other.
const gps = (device: string) => ({ type: GPS_TYPE, device });
const unrelated = {
  type: "https://example.com/atoms/Thermometer",
  device: "T",
};

// Trust config binding any GPSMeasurement (family pattern on `type`) to the
// GPS concept, delegated by `delegator` to AUDITOR. `delegator` defaults to
// the runtime's acting principal (the signer) so the integration paths, whose
// acting principal is the signer's DID, resolve the concept.
const trustInput = (
  overrides: Partial<CfcTrustConfigInput> = {},
  delegator: string = signer.did(),
): CfcTrustConfigInput => ({
  statements: [{
    concrete: { type: GPS_TYPE },
    implements: GPS_CONCEPT,
    verifier: AUDITOR,
  }],
  delegations: [{ delegator, verifier: AUDITOR, concepts: [GPS_CONCEPT] }],
  ...overrides,
});

const trustCtx = (
  actingPrincipal: string | undefined,
  overrides: Partial<CfcTrustConfigInput> = {},
) => ({
  trustResolver: createTrustResolver(
    buildCfcTrustConfig(trustInput(overrides)),
  ),
  actingPrincipal,
});

describe("CFC concept-level integrity floors (D5)", () => {
  describe("shared predicate: cfcIntegritySatisfiesFloor", () => {
    it("accepts a concrete atom above the concept in the acting closure", () => {
      // RED before D5: a Concept-valued floor matched nothing (a concept
      // pattern never structurally matches a GPSMeasurement atom), so a valid
      // measurement wrongly failed the floor.
      expect(cfcIntegritySatisfiesFloor(
        [gps("X")],
        [concept(GPS_CONCEPT)],
        trustCtx(signer.did()),
      )).toBe(true);
    });

    it("rejects a below/unrelated atom for a concept floor", () => {
      expect(cfcIntegritySatisfiesFloor(
        [unrelated],
        [concept(GPS_CONCEPT)],
        trustCtx(signer.did()),
      )).toBe(false);
      expect(cfcIntegritySatisfiesFloor(
        [],
        [concept(GPS_CONCEPT)],
        trustCtx(signer.did()),
      )).toBe(false);
    });

    it("scopes concept satisfaction to the acting principal (inv-11)", () => {
      // The SAME concrete atom is portable, but only the delegating principal's
      // closure admits the concept. Bob never delegated to the auditor.
      expect(cfcIntegritySatisfiesFloor(
        [gps("X")],
        [concept(GPS_CONCEPT)],
        trustCtx(signer.did()),
      )).toBe(true);
      expect(cfcIntegritySatisfiesFloor(
        [gps("X")],
        [concept(GPS_CONCEPT)],
        trustCtx(BOB),
      )).toBe(false);
    });

    it("fails closed with no trust resolver or no config", () => {
      // No context at all (the pre-D5 2-arg callers): a concept floor never
      // passes — concepts resolve ONLY through the trust closure.
      expect(cfcIntegritySatisfiesFloor([gps("X")], [concept(GPS_CONCEPT)]))
        .toBe(false);
      // Context present but no resolver.
      expect(cfcIntegritySatisfiesFloor(
        [gps("X")],
        [concept(GPS_CONCEPT)],
        { actingPrincipal: signer.did() },
      )).toBe(false);
      // Resolver from an empty (undefined) config fails closed.
      expect(cfcIntegritySatisfiesFloor(
        [gps("X")],
        [concept(GPS_CONCEPT)],
        {
          trustResolver: createTrustResolver(undefined),
          actingPrincipal: signer.did(),
        },
      )).toBe(false);
    });

    it("never satisfies a malformed concept shape, even with a matching atom", () => {
      // Extra field beyond {type, uri} → fail closed (the guard is checked on
      // type + closure only; an over-constrained concept must not fire broadly).
      expect(cfcIntegritySatisfiesFloor(
        [gps("X")],
        [{ ...concept(GPS_CONCEPT), subject: "extra" }],
        trustCtx(signer.did()),
      )).toBe(false);
      // Missing uri → never satisfied.
      expect(cfcIntegritySatisfiesFloor(
        [gps("X")],
        [{ type: concept(GPS_CONCEPT).type }],
        trustCtx(signer.did()),
      )).toBe(false);
    });

    it("never pool-matches a literal Concept atom in carried integrity", () => {
      // A literal Concept atom in the value's integrity (which the mint gate
      // strips, but belt-and-suspenders here) does NOT satisfy a concept floor:
      // it matches no trust statement's concrete side.
      expect(cfcIntegritySatisfiesFloor(
        [concept(GPS_CONCEPT)],
        [concept(GPS_CONCEPT)],
        trustCtx(signer.did()),
      )).toBe(false);
    });

    it("rejects a Concept-typed carried atom even under a Concept-shaped concrete statement (cubic P2)", () => {
      // Defense in depth (cubic review-run a177bba7): the previous version
      // handed `actual` straight to the resolver, so a MISCONFIGURED trust
      // statement whose `concrete` side is itself Concept-shaped would let a
      // smuggled literal Concept atom pool-match its way to concept
      // satisfaction. A concept floor is satisfied ONLY by concrete evidence
      // (spec §4.8), so a Concept-typed carried atom must fail closed BEFORE
      // the closure is consulted, independent of how the config is written.
      const cfg = buildCfcTrustConfig({
        // `concrete` is the concept atom itself — a config a careful operator
        // would never write, but the predicate must not depend on that.
        statements: [{
          concrete: concept(GPS_CONCEPT),
          implements: PRIVACY_CONCEPT,
          verifier: AUDITOR,
        }],
        delegations: [{
          delegator: signer.did(),
          verifier: AUDITOR,
          concepts: [PRIVACY_CONCEPT],
        }],
      });
      const ctx = {
        trustResolver: createTrustResolver(cfg),
        actingPrincipal: signer.did(),
      };
      // Before the fix this returned true: `concept(GPS_CONCEPT)` matched the
      // Concept-shaped concrete and reached PRIVACY_CONCEPT.
      expect(cfcIntegritySatisfiesFloor(
        [concept(GPS_CONCEPT)],
        [concept(PRIVACY_CONCEPT)],
        ctx,
      )).toBe(false);
    });

    it("does not treat a Concept-shaped ARRAY as a concept guard (cubic P2)", () => {
      // `isObjectOrArray` admits arrays (`typeof [] === "object"`), so an array
      // carrying own `type`/`uri` properties previously routed to trust-closure
      // satisfaction. The canonical Concept atom is an OBJECT; a Concept-shaped
      // array is not the canonical shape and must fail closed to ordinary
      // matching (cubic review-run a177bba7).
      const arrayGuard = [] as unknown as Record<string, unknown>;
      arrayGuard.type = concept(GPS_CONCEPT).type;
      arrayGuard.uri = GPS_CONCEPT;
      // Before the fix `conceptGuard` returned `{ uri }` here.
      expect(conceptGuard(arrayGuard)).toBeUndefined();
      // And through the floor: an array-shaped requirement is NOT a concept
      // floor, so a valid measurement does not satisfy it via the closure —
      // it falls through to structural matching, which an array requirement
      // against a concrete object never meets.
      expect(cfcIntegritySatisfiesFloor(
        [gps("X")],
        [arrayGuard as unknown as CfcAtom],
        trustCtx(signer.did()),
      )).toBe(false);
    });

    it("satisfies a downstream concept floor transitively over concept edges", () => {
      const ctx = trustCtx(signer.did(), {
        conceptEdges: [{ from: GPS_CONCEPT, to: PRIVACY_CONCEPT }],
      });
      expect(
        cfcIntegritySatisfiesFloor([gps("X")], [concept(PRIVACY_CONCEPT)], ctx),
      )
        .toBe(true);
      // Reverse direction is not walked: a privacy-only carrier does not
      // satisfy the upstream GPS floor.
      expect(
        cfcIntegritySatisfiesFloor([gps("X")], [concept(GPS_CONCEPT)], ctx),
      )
        .toBe(true);
    });

    it("preserves exact-match / pattern behavior for plain atoms (byte-compat)", () => {
      // Trust context present but irrelevant: plain-atom requirements resolve
      // exactly as before, ignoring the closure.
      const ctx = trustCtx(signer.did());
      expect(cfcIntegritySatisfiesFloor([APPROVED], [APPROVED], ctx)).toBe(
        true,
      );
      expect(
        cfcIntegritySatisfiesFloor([APPROVED], [{ type: APPROVED.type }], ctx),
      )
        .toBe(true);
      expect(cfcIntegritySatisfiesFloor([APPROVED], [gps("X")], ctx)).toBe(
        false,
      );
      // And the 2-arg plain-atom form is unchanged.
      expect(cfcIntegritySatisfiesFloor([APPROVED], [APPROVED])).toBe(true);
    });

    it("conjunctively combines a concept requirement with a plain one", () => {
      const ctx = trustCtx(signer.did());
      expect(cfcIntegritySatisfiesFloor(
        [gps("X"), APPROVED],
        [concept(GPS_CONCEPT), APPROVED],
        ctx,
      )).toBe(true);
      // Missing the plain requirement fails the whole floor.
      expect(cfcIntegritySatisfiesFloor(
        [gps("X")],
        [concept(GPS_CONCEPT), APPROVED],
        ctx,
      )).toBe(false);
    });
  });

  describe("shared predicate: concept coherence + witness key", () => {
    it("keys a concept witness by the concrete atom that reaches it", () => {
      const ctx = trustCtx(signer.did());
      // The witness is the concrete measurement, not the concept.
      expect(cfcIntegrityWitnessKey(concept(GPS_CONCEPT), gps("X"), ctx))
        .not.toBeNull();
      expect(cfcIntegrityWitnessKey(concept(GPS_CONCEPT), gps("X"), ctx))
        .toBe(cfcIntegrityWitnessKey(concept(GPS_CONCEPT), gps("X"), ctx));
      // Sibling measurements are DISTINCT witnesses.
      expect(cfcIntegrityWitnessKey(concept(GPS_CONCEPT), gps("X"), ctx))
        .not.toBe(cfcIntegrityWitnessKey(concept(GPS_CONCEPT), gps("Y"), ctx));
      // A non-reaching atom has no witness key.
      expect(cfcIntegrityWitnessKey(concept(GPS_CONCEPT), unrelated, ctx))
        .toBeNull();
    });

    it("requires ONE shared concrete witness across all leaves for a concept floor", () => {
      const ctx = trustCtx(signer.did());
      const required = [concept(GPS_CONCEPT)];
      // Same measurement in every leaf → coherent.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[gps("X")], [gps("X"), gps("Y")]],
        required,
        ctx,
      )).toBe(true);
      // Each leaf reaches the concept, but via DIFFERENT measurements →
      // incoherent ("each part measured by some GPS" is not "the object
      // measured by one GPS").
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[gps("X")], [gps("Y")]],
        required,
        ctx,
      )).toBe(false);
      // A leaf reaching nothing fails outright.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[gps("X")], [unrelated]],
        required,
        ctx,
      )).toBe(false);
    });
  });

  describe("read-side gate integration (verifyInputRequirements)", () => {
    const sourceSchema = (integrity: unknown[]) =>
      ({
        type: "string",
        ifc: { confidentiality: ["s"], integrity },
      }) as JSONSchema;

    const runGate = async (
      sources: unknown[][],
      required: unknown,
      trust?: CfcTrustConfigInput,
    ): Promise<{ ok: boolean; message?: string }> => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        ...(trust ? { cfcTrustConfig: trust } : {}),
      });
      try {
        for (const [index, integrity] of sources.entries()) {
          const seed = runtime.edit();
          runtime.getCell(
            signer.did(),
            `concept-src-${index}`,
            sourceSchema(integrity),
            seed,
          ).set(`value-${index}`);
          seed.prepareCfc();
          expect((await seed.commit().settled).ok).toBeDefined();
        }
        const tx = runtime.edit();
        for (const [index, integrity] of sources.entries()) {
          runtime.getCell(
            signer.did(),
            `concept-src-${index}`,
            sourceSchema(integrity),
            tx,
          ).get();
        }
        runtime.getCell(
          signer.did(),
          "concept-sink",
          {
            type: "object",
            // The sink holds a value derived from the sources. It declares
            // the confidentiality those sources carry.
            ifc: { confidentiality: ["s"] },
            properties: {
              // The write mints the integrity its sources carry. That
              // leaves the read-side gate as the only thing deciding these
              // commits.
              out: {
                type: "string",
                ifc: {
                  requiredIntegrity: [required],
                  addIntegrity: sources.flat(),
                },
              },
            },
            required: ["out"],
          } as JSONSchema,
          tx,
        ).set({ out: "derived" });
        tx.prepareCfc();
        const result = await tx.commit().settled;
        return {
          ok: result.ok !== undefined,
          message: (result.error as Error | undefined)?.message,
        };
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    it("admits a concrete atom above the concept floor", async () => {
      // RED before threading the trust context into the gate: the concept
      // floor rejected the valid measurement and the commit failed.
      const result = await runGate(
        [[gps("X")]],
        concept(GPS_CONCEPT),
        trustInput(),
      );
      expect(result.ok).toBe(true);
    });

    it("rejects a concrete atom that is not above the concept", async () => {
      const result = await runGate(
        [[unrelated]],
        concept(GPS_CONCEPT),
        trustInput(),
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("requiredIntegrity failed");
    });

    it("rejects a concept floor with no trust configured (fail closed)", async () => {
      const result = await runGate([[gps("X")]], concept(GPS_CONCEPT));
      expect(result.ok).toBe(false);
      expect(result.message).toContain("requiredIntegrity failed");
    });

    it("rejects heterogeneous per-leaf witnesses for one concept requirement", async () => {
      // Two reads each reach the concept, but via different measurements →
      // concept coherence rejects, exactly like the concrete case.
      const result = await runGate(
        [[gps("X")], [gps("Y")]],
        concept(GPS_CONCEPT),
        trustInput(),
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("requiredIntegrity failed");
    });

    it("still exact-matches a plain-atom floor with trust configured", async () => {
      expect((await runGate([[APPROVED]], APPROVED, trustInput())).ok).toBe(
        true,
      );
      expect((await runGate([[gps("X")]], APPROVED, trustInput())).ok).toBe(
        false,
      );
    });
  });

  describe("write-side floor integration (verifyWriteFloor)", () => {
    const runWriteFloor = async (
      addIntegrity: unknown[],
      required: unknown,
      trust?: CfcTrustConfigInput,
    ): Promise<{ ok: boolean; message?: string }> => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        // Two of the cases below assert the message "write floor failed".
        // An enforcing write floor is what produces it.
        cfcWriteFloor: "enforce",
        ...(trust ? { cfcTrustConfig: trust } : {}),
      });
      try {
        const tx = runtime.edit();
        runtime.getCell(
          signer.did(),
          "concept-write-sink",
          {
            type: "object",
            properties: {
              out: {
                type: "string",
                ifc: { requiredIntegrity: [required], addIntegrity },
              },
            },
            required: ["out"],
          } as JSONSchema,
          tx,
        ).set({ out: "written" });
        tx.prepareCfc();
        const result = await tx.commit().settled;
        return {
          ok: result.ok !== undefined,
          message: (result.error as Error | undefined)?.message,
        };
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    it("passes when the minted concrete value is above the concept floor", async () => {
      // RED before threading the trust context into the write floor: the
      // minted GPSMeasurement did not satisfy the Concept floor.
      const result = await runWriteFloor(
        [gps("X")],
        concept(GPS_CONCEPT),
        trustInput(),
      );
      expect(result.ok).toBe(true);
    });

    it("rejects when the minted value is not above the concept floor", async () => {
      const result = await runWriteFloor(
        [unrelated],
        concept(GPS_CONCEPT),
        trustInput(),
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("write floor failed");
    });

    it("rejects a concept write floor with no trust configured", async () => {
      const result = await runWriteFloor([gps("X")], concept(GPS_CONCEPT));
      expect(result.ok).toBe(false);
      expect(result.message).toContain("write floor failed");
    });
  });

  describe("tool-input floor integration (llm-dialog, Epic D2)", () => {
    const KERNEL_CONCEPT_FLOOR = concept(GPS_CONCEPT);

    async function setup(trust: CfcTrustConfigInput | undefined) {
      const space = signer.did();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        ...(trust ? { cfcTrustConfig: trust } : {}),
      });
      const tx = runtime.edit();
      const { commonfabric } = createTrustedBuilder(runtime);
      const { pattern, handler, Writable } = commonfabric;

      const sendMailInputSchema = {
        type: "object",
        properties: {
          recipient: {
            type: "string",
            ifc: { requiredIntegrity: [KERNEL_CONCEPT_FLOOR] },
          },
          body: { type: "string" },
        },
        required: ["recipient", "body"],
        additionalProperties: false,
      } as JSONSchema;

      const sendMail = handler<
        { recipient: string; body: string },
        { emails: any }
      >(
        {
          type: "object",
          properties: {
            recipient: { type: "string" },
            body: { type: "string" },
          },
          required: ["recipient", "body"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            emails: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              asCell: ["cell"],
            },
          },
          required: ["emails"],
        },
        ({ recipient, body }, { emails }) => {
          emails.push({ recipient, body });
        },
      );

      const resultSchema = {
        type: "object",
        properties: {
          emails: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          tools: true,
        },
        required: ["emails", "tools"],
      } as const satisfies JSONSchema;

      const testPattern = pattern(
        () => {
          const emails = Writable.of<{ recipient: string; body: string }[]>([]);
          return {
            emails,
            tools: {
              sendMail: {
                description: "Send an email.",
                inputSchema: sendMailInputSchema,
                handler: sendMail({ emails }),
              },
            },
          };
        },
        false,
        resultSchema,
      );

      const resultCell = runtime.getCell(
        space,
        `concept-tool-${trust ? "trust" : "notrust"}`,
        resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
      await runtime.idle();

      const catalog = llmToolExecutionHelpers.buildToolCatalog(
        result.key("tools") as any,
        false,
      );

      const sendCall = async (recipient: unknown) => {
        await llmToolExecutionHelpers.executeToolCalls(
          runtime,
          space,
          catalog,
          [{
            type: "tool-call",
            toolCallId: "call-under-test",
            toolName: "sendMail",
            input: { recipient, body: "hi" },
          }] as any,
        );
        await runtime.idle();
      };

      const sentRecipients = async () => {
        const emails = (await result.key("emails").pull()) as
          | { recipient: string }[]
          | undefined;
        return (emails ?? []).map((e) => e.recipient);
      };

      // Seed a value whose stored label carries a concrete measurement atom,
      // returned as the by-reference form the model would pass.
      const seedConcreteRecipient = async (name: string, value: string) => {
        const seedTx = runtime.edit();
        const cell = runtime.getCell(
          space,
          name,
          {
            type: "string",
            ifc: { integrity: [gps("X")] },
          } as const satisfies JSONSchema,
          seedTx,
        );
        cell.set(value);
        seedTx.prepareCfc();
        expect((await seedTx.commit().settled).ok).toBeDefined();
        await runtime.idle();
        // Premise: the concrete atom really landed on the stored label.
        const readTx = runtime.edit();
        const view = cfcLabelViewForCell(
          runtime.getCell(
            space,
            name,
            { type: "string" } as JSONSchema,
            readTx,
          ),
        );
        expect(
          (view?.entries ?? []).flatMap((e) => e.label.integrity ?? []),
        ).toContainEqual(gps("X"));
        readTx.commit();
        return {
          "@link": createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space),
        };
      };

      const dispose = async () => {
        await runtime.dispose();
        await storageManager.close();
      };

      return { sendCall, sentRecipients, seedConcreteRecipient, dispose };
    }

    it("allows a by-reference recipient whose concrete atom is above the concept floor", async () => {
      // RED before threading the trust context into the tool-input gate: the
      // concept floor rejected the referenced concrete measurement.
      const t = await setup(trustInput());
      try {
        const ref = await t.seedConcreteRecipient(
          "concept-ok",
          "john@example.org",
        );
        await t.sendCall(ref);
        expect(await t.sentRecipients()).toEqual(["john@example.org"]);
      } finally {
        await t.dispose();
      }
    });

    it("refuses a plain-literal recipient against a concept floor", async () => {
      const t = await setup(trustInput());
      try {
        await t.sendCall("bob@evil.org");
        expect(await t.sentRecipients()).toEqual([]);
      } finally {
        await t.dispose();
      }
    });

    it("refuses a concept floor when no trust is configured (fail closed)", async () => {
      const t = await setup(undefined);
      try {
        const ref = await t.seedConcreteRecipient(
          "concept-notrust",
          "john@example.org",
        );
        await t.sendCall(ref);
        expect(await t.sentRecipients()).toEqual([]);
      } finally {
        await t.dispose();
      }
    });
  });
});
