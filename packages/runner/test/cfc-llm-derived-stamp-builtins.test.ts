import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  enableMockMode,
} from "@commonfabric/llm/client";
import type { JSONSchema } from "../src/builder/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { parseLink } from "../src/link-utils.ts";
import type { Cell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { waitForLlmSettled } from "./support/llm-result.ts";
import { LLM_DERIVED_RESULT_STAMP_SCHEMA } from "../src/builtins/llm-schemas.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

// Epic D1b (docs/history/plans/cfc-future-work-implementation.md): the `llm`,
// `generateText`, and `generateObject` builtins stamp their MODEL-OUTPUT
// writebacks with an explicit `LlmDerived` provenance atom — the same mark D1
// (cfc-llm-derived-stamp.test.ts) attaches to dialog messages. These tests are
// the D1b counterpart: for each builtin, real model output on the `result`
// field carries `LlmDerived`; a pattern-authored copy of the stamp is stripped
// by the runtime-minted evidence gate; and a `disabled` deployment is a no-op.

const signer = await Identity.fromPassphrase("runner-cfc-llm-derived-builtins");
const space = signer.did();

const LLM_DERIVED_ATOM = cfcAtom.llmDerived();

enableMockMode();

/** Flatten every integrity atom the persisted label surfaces at a cell. */
function integrityAtomsAt(cell: unknown): unknown[] {
  const view = cfcLabelViewForCell(cell);
  return (view?.entries ?? []).flatMap((entry) => entry.label.integrity ?? []);
}

/** The persisted integrity on a builtin's model-output `result` field. */
function resultIntegrity(result: Cell<any>): unknown[] {
  return integrityAtomsAt(result.key("result").resolveAsCell());
}

/** The persisted integrity on a builtin's model-output `partial` field. */
function partialIntegrity(result: Cell<any>): unknown[] {
  return integrityAtomsAt(result.key("partial").resolveAsCell());
}

/**
 * The integrity persisted in the labelMap of the OWN document a child cell
 * splits into (a schema `asCell` field / ID-anchored item lands the model bytes
 * in a separate doc). Read the child doc's persisted metadata directly by its
 * own id — this is the label a downstream integrity check (a `requiredIntegrity`
 * floor, a cross-space read) sees for those bytes, independent of any ancestor
 * entry on the parent document that a label view would rebase over the child.
 */
function childDocIntegrity(
  runtime: Runtime,
  childCell: Cell<any>,
): unknown[] {
  const rtx = runtime.edit();
  try {
    const raw = childCell.withTx(rtx).getRaw();
    const link = parseLink(raw);
    if (link?.id === undefined) return [];
    const metadata = readStoredCfcMetadata(rtx, {
      space: link.space ?? space,
      id: link.id,
      scope: link.scope === "inherit" ? undefined : link.scope,
    });
    return (metadata?.labelMap.entries ?? []).flatMap(
      (entry) => entry.label.integrity ?? [],
    );
  } finally {
    rtx.commit();
  }
}

describe("CFC LlmDerived stamping — result-field stamp mechanism", () => {
  it("stamps a builtin write to the result field; strips a pattern write", async () => {
    // The builtins write model output through LLM_DERIVED_RESULT_STAMP_SCHEMA.
    // Prove the gate keys the stamp on the write's authoring identity at the
    // result field-path: a builtin write stamps, a pattern write is stripped.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      // Model-output write: builtin identity + the stamp schema at ["result"].
      const modelTx = runtime.edit();
      setCfcImplementationIdentity(modelTx, {
        kind: "builtin",
        builtinId: "llm",
      });
      const builtinResult = runtime.getCell(
        space,
        "llm-derived-builtin-result",
        undefined,
        modelTx,
      );
      builtinResult.key("result").asSchema(LLM_DERIVED_RESULT_STAMP_SCHEMA).set(
        "model bytes",
      );
      modelTx.prepareCfc();
      expect((await modelTx.commit()).ok).toBeDefined();

      const readTx = runtime.edit();
      const builtinRead = runtime.getCell(
        space,
        "llm-derived-builtin-result",
        undefined,
        readTx,
      );
      expect(integrityAtomsAt(builtinRead.key("result"))).toContainEqual(
        LLM_DERIVED_ATOM,
      );
      readTx.commit();

      // Pattern write through the SAME stamp schema: no builtin identity, so
      // the runtime-minted gate strips the forged stamp.
      const forgeTx = runtime.edit();
      const forged = runtime.getCell(
        space,
        "llm-derived-forge-result",
        undefined,
        forgeTx,
      );
      forged.key("result").asSchema(LLM_DERIVED_RESULT_STAMP_SCHEMA).set(
        "forged provenance",
      );
      forgeTx.prepareCfc();
      expect((await forgeTx.commit()).ok).toBeDefined();

      const forgeReadTx = runtime.edit();
      const forgedRead = runtime.getCell(
        space,
        "llm-derived-forge-result",
        undefined,
        forgeReadTx,
      );
      expect(integrityAtomsAt(forgedRead.key("result"))).not.toContainEqual(
        LLM_DERIVED_ATOM,
      );
      forgeReadTx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("CFC LlmDerived stamping — llm builtins (end to end)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let builder: ReturnType<typeof createTrustedBuilder>["commonfabric"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    ({ commonfabric: builder } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    clearMockResponses();
    await runtime.idle();
    await runtime.dispose();
    await storageManager.close();
  });

  it("stamps the `llm` builtin's model-output result", async () => {
    const testPrompt = "d1b-llm-stamp";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      { role: "assistant", content: "hello from the model", id: "d1b-llm-1" },
    );

    const testPattern = builder.pattern(() =>
      builder.llm({ messages: [{ role: "user", content: testPrompt }] })
    );
    const resultCell = runtime.getCell(
      space,
      "d1b-llm-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    // Both model-output fields carry the stamp.
    expect(resultIntegrity(result)).toContainEqual(LLM_DERIVED_ATOM);
    expect(partialIntegrity(result)).toContainEqual(LLM_DERIVED_ATOM);
  });

  it("stamps the `llm` builtin's array-of-parts result", async () => {
    // `llm` result is `anyOf: [string, array-of-parts]`; the array variant is
    // stamped on the `result` field as a whole.
    const testPrompt = "d1b-llm-array-stamp";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      {
        role: "assistant",
        content: [{ type: "text", text: "part one" }],
        id: "d1b-llm-array-1",
      },
    );

    const testPattern = builder.pattern(() =>
      builder.llm({ messages: [{ role: "user", content: testPrompt }] })
    );
    const resultCell = runtime.getCell(
      space,
      "d1b-llm-array-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(resultIntegrity(result)).toContainEqual(LLM_DERIVED_ATOM);
  });

  it("stamps the `generateText` builtin's model-output result", async () => {
    const testPrompt = "d1b-generateText-stamp";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      { role: "assistant", content: "text reply", id: "d1b-gt-1" },
    );

    const testPattern = builder.pattern(() =>
      builder.generateText({ prompt: testPrompt })
    );
    const resultCell = runtime.getCell(
      space,
      "d1b-generateText-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("result").get()).toBe("text reply");
    expect(resultIntegrity(result)).toContainEqual(LLM_DERIVED_ATOM);
    expect(partialIntegrity(result)).toContainEqual(LLM_DERIVED_ATOM);
  });

  it("stamps the `generateObject` direct-path model-output result", async () => {
    const testPrompt = "d1b-generateObject-direct-stamp";
    const objectSchema: JSONSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
      },
      required: ["title", "summary"],
    };
    addMockObjectResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && typeof req.schema === "object" && req.schema.type === "object",
      {
        object: { title: "Model Title", summary: "Model summary" },
        id: "d1b-go-direct-1",
      },
    );

    const testPattern = builder.pattern(() =>
      builder.generateObject({ prompt: testPrompt, schema: objectSchema })
    );
    const resultCell = runtime.getCell(
      space,
      "d1b-generateObject-direct-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("result").get()).toEqual({
      title: "Model Title",
      summary: "Model summary",
    });
    // The custom user resultSchema does not itself declare LlmDerived; the stamp
    // is merged into its root at the write (withLlmDerivedStamp).
    expect(resultIntegrity(result)).toContainEqual(LLM_DERIVED_ATOM);
  });

  it("stamps the `generateObject` tools-path model-output result", async () => {
    const testPrompt = "d1b-generateObject-tools-stamp";
    const objectSchema: JSONSchema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    };
    // A presentResult tool-call routes through the generateObject tools arm.
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && req.tools?.["presentResult"] !== undefined,
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_present_1",
          toolName: "presentResult",
          input: { verdict: "model-produced" },
        }],
        id: "d1b-go-tools-1",
      },
    );

    const dummyPattern = builder.pattern(() => ({}), { type: "object" });
    const testPattern = builder.pattern(() =>
      builder.generateObject({
        prompt: testPrompt,
        schema: objectSchema,
        tools: {
          dummy: {
            description: "forces the tool-calling path",
            pattern: dummyPattern,
          },
        },
      })
    );
    const resultCell = runtime.getCell(
      space,
      "d1b-generateObject-tools-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("result").get()).toEqual({ verdict: "model-produced" });
    expect(resultIntegrity(result)).toContainEqual(LLM_DERIVED_ATOM);
  });

  it("stamps a `generateObject` result whose schema splits model bytes into a child doc", async () => {
    // Codex P1: when the resultSchema redirects/splits a nested value into its
    // OWN document (here an `asCell` array item), the model-produced bytes land
    // in that separate child doc. The D1b stamp is merged only into the schema
    // ROOT (`withLlmDerivedStamp`); the child write descends via
    // `ContextualFlowControl.getSchemaAtPath`, which carries ancestor confidentiality but
    // NOT `ifc.addIntegrity`. So the child doc that actually stores the model
    // bytes must still carry `LlmDerived` in its persisted labelMap — otherwise
    // a later integrity check reading that child doc by its own id sees ordinary,
    // unstamped output and the provenance guarantee is lost for structured
    // results. A custom resultSchema only reaches the writeback with
    // `schemaSanitizePromptInjection` on.
    const testPrompt = "d1b-generateObject-child-doc-stamp";
    const objectSchema: JSONSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            // Each item splits into its own entity document on write.
            asCell: ["cell"],
          },
        },
      },
      required: ["items"],
    };
    addMockObjectResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && typeof req.schema === "object" && req.schema.type === "object",
      {
        object: { items: [{ name: "alpha" }, { name: "beta" }] },
        id: "d1b-go-child-doc-1",
      },
    );

    const testPattern = builder.pattern(() =>
      builder.generateObject({
        prompt: testPrompt,
        schema: objectSchema,
        schemaSanitizePromptInjection: true,
      })
    );
    const resultCell = runtime.getCell(
      space,
      "d1b-generateObject-child-doc-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("result").get()).toEqual({
      items: [{ name: "alpha" }, { name: "beta" }],
    });

    // Each item is its own document; read the model bytes' OWN persisted label.
    const items = result.key("result").key("items") as unknown as Cell<any>;
    const firstItem = items.key(0) as unknown as Cell<any>;
    const secondItem = items.key(1) as unknown as Cell<any>;

    // Sanity: the items really do split into their own documents.
    expect(parseLink(firstItem.withTx().getRaw())?.id).toBeDefined();

    expect(childDocIntegrity(runtime, firstItem)).toContainEqual(
      LLM_DERIVED_ATOM,
    );
    expect(childDocIntegrity(runtime, secondItem)).toContainEqual(
      LLM_DERIVED_ATOM,
    );
  });

  it("stamps split child docs across anyOf branches and recursive `$ref` shapes", async () => {
    // The stamp is deep-merged into EVERY node of the result schema so it
    // survives `getSchemaAtPath` descent at any split point — exercising the
    // compound (`anyOf`) and recursive-`$defs` shapes, not just a flat
    // `properties`/`items` object. Each element below lands in its OWN document
    // (array items with `asCell`), so its persisted labelMap must carry the
    // stamp: `tagged[*]` splits through an `anyOf` item schema; the tree's
    // `children[*]` splits through an item schema that is a `$ref` back into
    // `$defs.node`.
    const testPrompt = "d1b-generateObject-compound-recursive-stamp";
    const objectSchema: JSONSchema = {
      type: "object",
      $defs: {
        node: {
          type: "object",
          properties: {
            label: { type: "string" },
            children: {
              type: "array",
              // A `$ref` item that splits into its own document per element.
              items: { $ref: "#/$defs/node", asCell: ["cell"] },
            },
          },
          required: ["label"],
          // A boolean schema keyword — the deep-stamp walk descends into it and
          // passes it through untouched (a leaf that is neither object nor array).
          additionalProperties: false,
        },
      },
      properties: {
        tagged: {
          type: "array",
          items: {
            // Each item splits into its own document AND is a compound schema.
            asCell: ["cell"],
            anyOf: [
              {
                type: "object",
                properties: { a: { type: "string" } },
                required: ["a"],
              },
              {
                type: "object",
                properties: { b: { type: "number" } },
                required: ["b"],
              },
            ],
          },
        },
        tree: { $ref: "#/$defs/node" },
      },
      required: ["tagged", "tree"],
    };
    addMockObjectResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && typeof req.schema === "object" && req.schema.type === "object",
      {
        object: {
          tagged: [{ a: "x" }, { b: 2 }],
          tree: { label: "root", children: [{ label: "leaf", children: [] }] },
        },
        id: "d1b-go-compound-recursive-1",
      },
    );

    const testPattern = builder.pattern(() =>
      builder.generateObject({
        prompt: testPrompt,
        schema: objectSchema,
        schemaSanitizePromptInjection: true,
      })
    );
    const resultCell = runtime.getCell(
      space,
      "d1b-generateObject-compound-recursive-result",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("result").get()).toEqual({
      tagged: [{ a: "x" }, { b: 2 }],
      tree: { label: "root", children: [{ label: "leaf", children: [] }] },
    });

    const tagged = result.key("result").key("tagged") as unknown as Cell<any>;
    const taggedFirst = tagged.key(0) as unknown as Cell<any>;
    const taggedSecond = tagged.key(1) as unknown as Cell<any>;
    const treeChild =
      ((result.key("result").key("tree") as unknown as Cell<any>)
        .key("children") as unknown as Cell<any>).key(0) as unknown as Cell<
          any
        >;

    // Sanity: every asserted element really split into its own document.
    expect(parseLink(taggedFirst.withTx().getRaw())?.id).toBeDefined();
    expect(parseLink(taggedSecond.withTx().getRaw())?.id).toBeDefined();
    expect(parseLink(treeChild.withTx().getRaw())?.id).toBeDefined();

    // anyOf-branch items carry the stamp on their own doc.
    expect(childDocIntegrity(runtime, taggedFirst)).toContainEqual(
      LLM_DERIVED_ATOM,
    );
    expect(childDocIntegrity(runtime, taggedSecond)).toContainEqual(
      LLM_DERIVED_ATOM,
    );
    // Recursive-`$ref` item carries the stamp on its own doc.
    expect(childDocIntegrity(runtime, treeChild)).toContainEqual(
      LLM_DERIVED_ATOM,
    );
  });

  it("does not stamp the `llm` result when CFC enforcement is disabled", async () => {
    const disabledStorage = StorageManager.emulate({ as: signer });
    const disabledRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: disabledStorage,
      // The assertion below reads that `result` carries no LlmDerived atom.
      // That holds at the `disabled` rung.
      cfcEnforcementMode: "disabled",
    });
    const disabledTx = disabledRuntime.edit();
    const { commonfabric } = createTrustedBuilder(disabledRuntime);

    const testPrompt = "d1b-llm-disabled";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      { role: "assistant", content: "no stamp here", id: "d1b-llm-disabled-1" },
    );

    try {
      const testPattern = commonfabric.pattern(() =>
        commonfabric.llm({ messages: [{ role: "user", content: testPrompt }] })
      );
      const resultCell = disabledRuntime.getCell(
        space,
        "d1b-llm-disabled-result",
        testPattern.resultSchema,
        disabledTx,
      );
      const result = disabledRuntime.run(
        disabledTx,
        testPattern,
        {},
        resultCell,
      );
      disabledTx.commit();

      await waitForLlmSettled(disabledRuntime, result);

      expect(resultIntegrity(result)).not.toContainEqual(LLM_DERIVED_ATOM);
    } finally {
      await disabledRuntime.idle();
      await disabledRuntime.dispose();
      await disabledStorage.close();
    }
  });

  it("does not stamp the `generateObject` result when CFC is disabled", async () => {
    // Exercises setStampedObjectResult's disabled branch (writes through the
    // bare resultSchema, minting no CFC metadata).
    const disabledStorage = StorageManager.emulate({ as: signer });
    const disabledRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: disabledStorage,
      // The assertion below reads that `result` carries no LlmDerived atom.
      // That holds at the `disabled` rung.
      cfcEnforcementMode: "disabled",
    });
    const disabledTx = disabledRuntime.edit();
    const { commonfabric } = createTrustedBuilder(disabledRuntime);

    const testPrompt = "d1b-generateObject-disabled";
    const objectSchema: JSONSchema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    };
    addMockObjectResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && typeof req.schema === "object" && req.schema.type === "object",
      { object: { verdict: "unstamped" }, id: "d1b-go-disabled-1" },
    );

    try {
      const testPattern = commonfabric.pattern(() =>
        commonfabric.generateObject({
          prompt: testPrompt,
          schema: objectSchema,
        })
      );
      const resultCell = disabledRuntime.getCell(
        space,
        "d1b-generateObject-disabled-result",
        testPattern.resultSchema,
        disabledTx,
      );
      const result = disabledRuntime.run(
        disabledTx,
        testPattern,
        {},
        resultCell,
      );
      disabledTx.commit();

      await waitForLlmSettled(disabledRuntime, result);

      expect(result.key("result").get()).toEqual({ verdict: "unstamped" });
      expect(resultIntegrity(result)).not.toContainEqual(LLM_DERIVED_ATOM);
    } finally {
      await disabledRuntime.idle();
      await disabledRuntime.dispose();
      await disabledStorage.close();
    }
  });
});
