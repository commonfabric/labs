import { assertEquals, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import type { CfcConfClause } from "@commonfabric/runner/cfc";
import { describe, it, test } from "@commonfabric/test-support/test";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import {
  bindLoomLocalRunManifest,
  type HarnessRunManifest,
  type LoomLocalHostBinding,
  parseLoomRunManifestJson,
} from "../src/contracts/run-manifest.ts";

test("parseLoomRunManifestJson validates prompt-slot evidence", () => {
  const manifest = parseLoomRunManifestJson(
    JSON.stringify({
      type: "cf-harness.loom-run-manifest",
      version: 1,
      source: "loom",
      wishId: "W-519",
      promptSlot: {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: { type: "loom.wish", wishId: "W-519" },
        role: "direct-command",
        kernelName: "loom",
        surface: "wish-dispatch",
        subject: "W-519",
      },
    }),
  );

  assertEquals(manifest.promptSlot?.type, CFC_PROMPT_SLOT_BOUND_ATOM_TYPE);
  assertEquals(manifest.promptSlot?.source, {
    type: "loom.wish",
    wishId: "W-519",
  });
});

test("parseLoomRunManifestJson rejects malformed prompt-slot evidence", () => {
  assertThrows(
    () => parseLoomRunManifestJson(JSON.stringify([])),
    Error,
    "run manifest must be a JSON object",
  );
  assertThrows(
    () =>
      parseLoomRunManifestJson(
        JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          promptSlot: [],
        }),
      ),
    Error,
    "prompt slot binding must be a JSON object",
  );
  assertThrows(
    () =>
      parseLoomRunManifestJson(
        JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          promptSlot: { role: "direct-command" },
        }),
      ),
    Error,
    "unsupported prompt slot binding type",
  );
});

test("parseLoomRunManifestJson rejects a non-Loom source", () => {
  assertThrows(
    () =>
      parseLoomRunManifestJson(
        JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "hosted",
        }),
      ),
    Error,
    "unsupported run manifest source: hosted",
  );
});

test("parseLoomRunManifestJson rejects invalid CFC metadata", () => {
  assertThrows(
    () =>
      parseLoomRunManifestJson(
        JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          cfc: [],
        }),
      ),
    Error,
    "run manifest cfc must be a JSON object",
  );
  assertThrows(
    () =>
      parseLoomRunManifestJson(
        JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          cfc: { enforcementMode: "bogus" },
        }),
      ),
    Error,
    "unsupported run manifest cfc.enforcementMode",
  );
  assertThrows(
    () =>
      parseLoomRunManifestJson(
        JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          cfc: { enforcementMode: "" },
        }),
      ),
    Error,
    "unsupported run manifest cfc.enforcementMode",
  );
});

test("parseLoomRunManifestJson preserves a non-secret credential owner reference", () => {
  const manifest = parseLoomRunManifestJson(JSON.stringify({
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    modelProvider: "openai-codex",
    credentialOwner: {
      type: "cf-harness.credential-owner-ref",
      version: 1,
      ownerKey: "loom:user-123",
      tenantKey: "tenant-1",
    },
  }));

  assertEquals(manifest.modelProvider, "openai-codex");
  assertEquals(manifest.credentialOwner, {
    type: "cf-harness.credential-owner-ref",
    version: 1,
    ownerKey: "loom:user-123",
    tenantKey: "tenant-1",
  });
});

test("parseLoomRunManifestJson preserves non-secret local host binding metadata", () => {
  const manifest = parseLoomRunManifestJson(JSON.stringify({
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    modelProvider: "openai-codex",
    modelAuthSource: "cf-harness-local-store",
    harnessHomeIdentity: "sha256:opaque-home",
  }));

  assertEquals(manifest.modelAuthSource, "cf-harness-local-store");
  assertEquals(manifest.harnessHomeIdentity, "sha256:opaque-home");
  for (const invalid of ["", "  ", "secrets-file"] as const) {
    assertThrows(
      () =>
        parseLoomRunManifestJson(JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          modelAuthSource: invalid,
        })),
      Error,
    );
  }
});

test("parseLoomRunManifestJson rejects malformed provider ownership", () => {
  for (
    const credentialOwner of [
      {},
      {
        type: "cf-harness.credential-owner-ref",
        version: 1,
        ownerKey: " ",
      },
      {
        type: "cf-harness.credential-owner-ref",
        version: 1,
        ownerKey: "loom:user",
        tenantKey: "",
      },
    ]
  ) {
    assertThrows(
      () =>
        parseLoomRunManifestJson(JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          modelProvider: "openai-codex",
          credentialOwner,
        })),
      Error,
      "invalid run manifest credentialOwner reference",
    );
  }
  assertThrows(
    () =>
      parseLoomRunManifestJson(JSON.stringify({
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
        modelProvider: "codex-ish",
      })),
    Error,
    "unsupported run manifest modelProvider",
  );
});

test("parseLoomRunManifestJson rejects a path-shaped harness home identity", () => {
  assertThrows(
    () =>
      parseLoomRunManifestJson(JSON.stringify({
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
        harnessHomeIdentity: "/Users/alice/.cf-harness",
      })),
    Error,
    "invalid run manifest harnessHomeIdentity",
  );
});

test("bindLoomLocalRunManifest rejects every conflicting caller binding", () => {
  const binding: LoomLocalHostBinding = {
    source: "loom",
    modelProvider: "openai-codex",
    modelAuthSource: "cf-harness-local-store",
    credentialOwner: {
      type: "cf-harness.credential-owner-ref",
      version: 1,
      ownerKey: "local",
      tenantKey: "tenant-a",
    },
    harnessHomeIdentity: "sha256:home-a",
  };
  const baseManifest: HarnessRunManifest = {
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
  };
  const cases: Array<{
    label: string;
    manifest: HarnessRunManifest;
    model?: string;
  }> = [
    {
      label: "provider",
      manifest: {
        ...baseManifest,
        modelProvider: "openai-compatible-gateway",
      },
    },
    {
      label: "auth source",
      manifest: { ...baseManifest, modelAuthSource: "none" },
    },
    {
      label: "credential owner",
      manifest: {
        ...baseManifest,
        credentialOwner: { ...binding.credentialOwner, tenantKey: "tenant-b" },
      },
    },
    {
      label: "harness home",
      manifest: { ...baseManifest, harnessHomeIdentity: "sha256:home-b" },
    },
    {
      label: "model",
      manifest: { ...baseManifest, model: "gpt-a" },
      model: "gpt-b",
    },
  ];

  for (const testCase of cases) {
    assertThrows(
      () =>
        bindLoomLocalRunManifest(
          testCase.manifest,
          binding,
          testCase.model,
        ),
      Error,
      `Loom-local ${testCase.label} does not match the host binding`,
    );
  }

  const owner = structuredClone(binding.credentialOwner);
  const bound = bindLoomLocalRunManifest(
    { ...baseManifest, wishId: "W-coverage", credentialOwner: owner },
    binding,
    "gpt-a",
  );
  assertEquals(bound.wishId, "W-coverage");
  assertEquals(bound.model, "gpt-a");
  assertEquals(bound.credentialOwner, binding.credentialOwner);
  owner.ownerKey = "mutated-after-bind";
  assertEquals(bound.credentialOwner?.ownerKey, "local");
});

const manifestWithCfc = (cfc: unknown): string =>
  JSON.stringify({
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    wishId: "W-2201",
    cfc,
  });

test("parseLoomRunManifestJson carries a read ceiling through normalization", () => {
  const ceiling: CfcConfClause[] = [
    "did:key:zOwner",
    { type: "Facet", owner: "did:key:zOwner", id: "work" },
    { anyOf: ["did:key:zOwner", "did:key:zOther"] },
  ];
  const manifest = parseLoomRunManifestJson(
    manifestWithCfc({
      enforcementMode: "enforce-strict",
      maxConfidentiality: ceiling,
      onExceed: "skip",
    }),
  );
  assertEquals(manifest.cfc, {
    enforcementMode: "enforce-strict",
    maxConfidentiality: ceiling,
    onExceed: "skip",
  });
});

test("parseLoomRunManifestJson still drops a cfc key it does not know", () => {
  const manifest = parseLoomRunManifestJson(
    manifestWithCfc({ enforcementMode: "observe", ceiling: ["did:key:zX"] }),
  );
  assertEquals(manifest.cfc, { enforcementMode: "observe" });
});

test("parseLoomRunManifestJson refuses a malformed read ceiling rather than dropping it", () => {
  const cases: { cfc: unknown; message: string }[] = [
    {
      cfc: { maxConfidentiality: [] },
      message: "run manifest cfc.maxConfidentiality: an empty ceiling admits",
    },
    {
      cfc: { maxConfidentiality: "did:key:zOwner" },
      message:
        "run manifest cfc.maxConfidentiality: expected an array of clauses",
    },
    {
      cfc: { maxConfidentiality: ["did:key:zOwner", 7] },
      message: "run manifest cfc.maxConfidentiality[1]: expected an atom",
    },
    {
      cfc: { maxConfidentiality: [{ anyOf: [] }] },
      message:
        "run manifest cfc.maxConfidentiality[0]: an `anyOf` with no alternatives",
    },
    {
      cfc: { maxConfidentiality: ["did:key:zOwner"], onExceed: "drop" },
      message: 'run manifest cfc.onExceed: expected "fail" or "skip"',
    },
    {
      cfc: { onExceed: "skip" },
      message:
        "run manifest cfc.onExceed: qualifies `run manifest cfc.maxConfidentiality`",
    },
  ];
  for (const testCase of cases) {
    assertThrows(
      () => parseLoomRunManifestJson(manifestWithCfc(testCase.cfc)),
      Error,
      testCase.message,
    );
  }
});

describe("run-manifest", () => {
  describe("parseLoomRunManifestJson()", () => {
    const parse = (manifest: Record<string, unknown>) =>
      parseLoomRunManifestJson(JSON.stringify(manifest));

    it("throws naming the parse failure for text that is not JSON", () => {
      expect(() => parseLoomRunManifestJson("{not json")).toThrow(
        "failed to parse run manifest JSON:",
      );
    });

    it("throws naming a manifest type other than the Loom one", () => {
      expect(parse({ type: "cf-harness.loom-run-manifest" }).type).toBe(
        "cf-harness.loom-run-manifest",
      );
      expect(() => parse({ type: "cf-harness.other-manifest" })).toThrow(
        "unsupported run manifest type: cf-harness.other-manifest",
      );
    });

    it("throws naming a manifest version other than 1", () => {
      expect(parse({ version: 1 }).version).toBe(1);
      expect(() => parse({ version: 2 })).toThrow(
        "unsupported run manifest version: 2",
      );
    });

    it("returns the CFC label source when it is the Loom manifest's own", () => {
      expect(parse({ cfc: { labelSource: "loom-run-manifest" } }).cfc).toEqual(
        { labelSource: "loom-run-manifest" },
      );
    });

    it("throws naming a CFC label source other than the Loom manifest", () => {
      expect(() => parse({ cfc: { labelSource: "model" } })).toThrow(
        "unsupported run manifest cfc.labelSource: model",
      );
    });

    it("throws for a credential owner that is not a JSON object", () => {
      for (const credentialOwner of ["loom:user", ["loom:user"], null]) {
        expect(() => parse({ credentialOwner })).toThrow(
          "run manifest credentialOwner must be a JSON object",
        );
      }
    });
  });
});
