/**
 * The tool-input integrity gate and the malformed-floor scan at a schema
 * reference that resolves to a boolean schema, and the gate at a reference
 * whose stored labels this session cannot read.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { llmToolExecutionHelpers } from "../../src/builtins/llm-dialog.ts";
import { createLLMFriendlyLink, parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const { toolInputMalformedFloor, toolInputRequiredIntegrityFailure } =
  llmToolExecutionHelpers;

const signer = await Identity.fromPassphrase(
  "llm dialog tool input references",
);
const space = signer.did();

const KERNEL_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Builtin",
  name: "agent-kernel-demo-v1",
} as const;

const FLOOR = { ifc: { requiredIntegrity: [KERNEL_ATOM] } };

describe("llm-dialog", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  function gate(schema: unknown, value: unknown) {
    return toolInputRequiredIntegrityFailure(
      runtime,
      space,
      schema,
      value,
      "",
      {},
    );
  }

  describe("a field whose schema is a reference to a boolean schema", () => {
    // The reference sits alone in its field, so it resolves against the
    // enclosing schema to the bare boolean rather than to an object merged
    // with siblings.

    it("returns `undefined` from the malformed-floor scan, which reports a malformed floor beside it", () => {
      const schema = (defs: Record<string, unknown>) => ({
        type: "object",
        properties: { recipient: { $ref: "#/$defs/Recipient" } },
        $defs: defs,
      });

      expect(toolInputMalformedFloor(schema({ Recipient: true }), ""))
        .toBeUndefined();
      expect(toolInputMalformedFloor(schema({ Recipient: false }), ""))
        .toBeUndefined();
      expect(
        toolInputMalformedFloor(
          schema({ Recipient: { ifc: { requiredIntegrity: "kernel" } } }),
          "",
        ),
      ).toContain("declares a requiredIntegrity that is not a list");
    });

    it("returns `undefined` from the gate for that field, which still gates a floored sibling", () => {
      const schema = {
        type: "object",
        properties: {
          recipient: { $ref: "#/$defs/Recipient" },
          subject: FLOOR,
        },
        $defs: { Recipient: true },
      };

      expect(gate(schema, { recipient: "bob@example.com" })).toBeUndefined();
      expect(gate(schema, { recipient: "bob@example.com", subject: "hi" }))
        .toBe(
          'field "subject" requires integrity the model-supplied value does ' +
            "not carry (pass an integrity-bearing reference, not a literal)",
        );
    });
  });

  describe("a reference to a value whose labels cannot be read", () => {
    /**
     * Stores `value` under an envelope of `version`, and returns the reference
     * a model would pass to it.
     */
    async function referenceUnder(cause: string, version: number) {
      const cell = runtime.getCell(space, cause);
      const id = parseLink(cell.getAsLink()).id!;
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
        value: "sealed",
        cfc: {
          version,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality: ["vaulted"] } }],
          },
        },
      });
      expect((await seed.commit().settled).ok).toBeDefined();
      return {
        "@link": createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space),
      };
    }

    it("returns an unreadable-value failure for an envelope version this build does not interpret", async () => {
      const unreadable = await referenceUnder("unknown envelope version", 3);
      const readable = await referenceUnder("known envelope version", 1);

      expect(gate(FLOOR, unreadable)).toBe(
        'field "(root)" holds a reference whose value or labels this ' +
          "session cannot read; refusing the call (fail closed)",
      );
      expect(gate(FLOOR, readable)).toBe(
        'field "(root)" requires integrity the model-supplied value does ' +
          "not carry (pass an integrity-bearing reference, not a literal)",
      );
    });
  });
});
