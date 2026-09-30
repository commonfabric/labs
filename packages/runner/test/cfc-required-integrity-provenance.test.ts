import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IFCLabel } from "../src/cfc/mod.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-cfc-ri-provenance");

// Audit S7: verifyInputRequirements quantifies requiredIntegrity over EVERY
// labeled read in the transaction (transaction-global). A read that carries
// only structural/identity PROVENANCE (a link dereference, a current-principal
// claim) — never an endorsement — then false-rejects an unrelated protected
// write. Concrete in cfc-group-chat-demo: granting admin reads
// adminRegistry.bootstrapAdmin.subject (label [represents-principal,
// LinkReference]) and that read fails the admins list's
// requiredIntegrity:[group-chat-admin]. Fix (audit candidate D, vetted by the
// oracle as the only incremental scoping that keeps the cross-cell
// prompt-injection screen sound): drop a consumed read from the gate only when
// it carries no confidentiality and its integrity is entirely non-endorsement
// provenance. A confidentiality-bearing read (the prompt-injection briefing)
// still gates.
const LINK_REFERENCE_ATOM = {
  type: "https://commonfabric.org/cfc/atom/LinkReference",
};
const REPRESENTS_PRINCIPAL_ATOM = {
  kind: "represents-principal",
  subject: signer.did(),
};
const ADMIN_ATOM = "group-chat-admin";

// Seed a doc's stored CFC metadata directly via an ungated path-[] full-document
// write (how the runtime persists it), so a later read picks up the given label.
const seedLabeledDoc = async (
  runtime: Runtime,
  id: string,
  value: FabricValue,
  label: IFCLabel,
): Promise<void> => {
  const seed = runtime.edit();
  const cell = runtime.getCell(signer.did(), id, undefined, seed);
  const docId = cell.getAsNormalizedFullLink().id as URI;
  writeSeedEnvelopeDoc(seed, signer.did());
  seedStoredEnvelope(seed, {
    space: signer.did(),
    id: docId,
    type: "application/json",
    path: [],
  }, {
    value,
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries: [{ path: [], label }] },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

// The sink names the admin endorsement twice on `out`: it is required there,
// and it is minted there. The mint is what the write-side floor credits the
// written value with. The read-side gate these steps exercise quantifies over
// the reads the transaction consumed, so the mint leaves it alone.
const SINK_SCHEMA = {
  type: "object",
  properties: {
    out: {
      type: "string",
      ifc: { requiredIntegrity: [ADMIN_ATOM], addIntegrity: [ADMIN_ATOM] },
    },
  },
  required: ["out"],
} as const satisfies JSONSchema;

describe("CFC requiredIntegrity provenance scoping (S7)", () => {
  it("a provenance-only read does not gate a requiredIntegrity write", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      // A lookup doc whose stored label is entirely provenance: a link
      // reference + a current-principal claim, no confidentiality.
      await seedLabeledDoc(runtime, "ri-prov-lookup", "lookup", {
        integrity: [REPRESENTS_PRINCIPAL_ATOM, LINK_REFERENCE_ATOM],
      });

      const tx = runtime.edit();
      // Read the provenance-only lookup (records a confidential-free, provenance
      // labeled read), then write the protected sink in the same tx.
      runtime.getCell(signer.did(), "ri-prov-lookup", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "ri-prov-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "granted" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("an empty-label read does not gate a requiredIntegrity write", async () => {
    // A stored labelMap entry whose label carries NO atoms at all ({} — e.g.
    // a slot whose declared atoms only apply on one union arm, persisted by a
    // sync that materializes the entry anyway). A read with label undefined
    // (no metadata) is already excluded from the gate; a present-but-empty
    // label is the same trust level and must not gate either — otherwise the
    // gate's membership depends on whether metadata happened to materialize
    // (cfc-group-chat-demo multi-runtime: reading adminRegistry/everyoneIsAdmin
    // with label {} false-rejected the rooms-list admin write).
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      await seedLabeledDoc(runtime, "ri-empty-lookup", "lookup", {});

      const tx = runtime.edit();
      runtime.getCell(signer.did(), "ri-empty-lookup", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "ri-empty-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "granted" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a confidentiality-bearing read still gates requiredIntegrity (prompt-injection soundness)", async () => {
    // The security side: a read that carries confidentiality (like the
    // prompt-injection briefing) and lacks the required atom must STILL fail —
    // it is a genuine data input, not provenance. This is what keeps the
    // cross-cell prompt-injection screen sound under the fix.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      await seedLabeledDoc(runtime, "ri-conf-src", "briefing", {
        confidentiality: ["prompt-injection-risk-unscreened"],
      });

      const tx = runtime.edit();
      runtime.getCell(signer.did(), "ri-conf-src", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "ri-conf-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "derived" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "requiredIntegrity failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a read mixing a real integrity atom with provenance still gates", async () => {
    // Only ENTIRELY-provenance reads are excluded. A read carrying a genuine
    // (non-provenance) integrity atom that isn't the required one must still
    // fail — provenance riding alongside real data must not launder it.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      await seedLabeledDoc(runtime, "ri-mixed-src", "data", {
        // "other-endorsement" is a genuine endorsement atom, not provenance.
        integrity: [LINK_REFERENCE_ATOM, "other-endorsement"],
      });

      const tx = runtime.edit();
      runtime.getCell(signer.did(), "ri-mixed-src", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "ri-mixed-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "derived" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "requiredIntegrity failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("an author-forged provenance atom is stripped and cannot satisfy the gate", async () => {
    // Misuse direction of the S7 exemption: a pattern author self-attaches the
    // LinkReference provenance atom through the only surface untrusted code
    // has — an ifc.integrity schema declaration (NOT the privileged metadata
    // seeding used by the other steps; mirrors cfc-integrity-mint-gate). The
    // S4 mint gate (gateRuntimeMintedIntegrity) strips it at persist time, so
    // (a) the stored label keeps only the confidentiality — the read is NOT
    // provenance-only and still gates — and (b) the forged atom cannot
    // satisfy a requiredIntegrity gate keyed to LinkReference. Were the strip
    // bypassed, the forged atom would persist AND satisfy that gate (the
    // commit below would succeed) — both assertions catch it.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const seed = runtime.edit();
      const srcSchema = {
        type: "string",
        ifc: {
          // The confidentiality atom keeps the read labeled (and in the gate)
          // after the forged integrity is stripped, mirroring the mint-gate
          // suite's author-side declaration.
          confidentiality: ["s"],
          integrity: [LINK_REFERENCE_ATOM],
        },
      } as const satisfies JSONSchema;
      const src = runtime.getCell(
        signer.did(),
        "ri-forged-prov-src",
        srcSchema,
        seed,
      );
      src.set("attacker-controlled");
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      // Non-vacuity anchor: assert the S4 strip actually ran — the persisted
      // labelMap kept the confidentiality but NOT the forged LinkReference.
      const persistedId = parseLink(src.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<{
                path: string[];
                label: {
                  confidentiality?: unknown[];
                  integrity?: Array<{ type?: string }>;
                };
              }>;
            };
          };
        } | undefined;
      };
      const entries = replica.getDocument(persistedId)?.cfc?.labelMap
        ?.entries ?? [];
      expect(
        entries.flatMap((e) => e.label.integrity ?? [])
          .some((a) => a?.type?.endsWith("/LinkReference")),
      ).toBe(false);
      expect(
        entries.flatMap((e) => e.label.confidentiality ?? []).includes("s"),
      ).toBe(true);

      // A sink keyed to the very atom the author tried to mint. The stripped
      // read still gates (confidentiality-bearing, so not provenance-only)
      // and its integrity no longer carries LinkReference: the write fails.
      const tx = runtime.edit();
      runtime.getCell(signer.did(), "ri-forged-prov-src", srcSchema, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "ri-forged-prov-sink",
        {
          type: "object",
          properties: {
            out: {
              type: "string",
              ifc: { requiredIntegrity: [LINK_REFERENCE_ATOM] },
            },
          },
          required: ["out"],
        } as const satisfies JSONSchema,
        tx,
      );
      sink.set({ out: "derived" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "requiredIntegrity failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
