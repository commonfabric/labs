/**
 * What a reader of an LLM built-in's output sees when a confidential cell was
 * handed to that built-in as a parameter.
 *
 * Two mechanisms put the label there, and the cases below separate them.
 * `connectInputAndOutputs` joins every input cell's `ifc` onto the output
 * cell's schema while the graph is assembled, which is the conservative
 * default of CFC §8.9.2 over-approximated before anything is read. The
 * `cfcFlowLabels` dial at `"persist"` measures each transaction's own reads
 * and writes the join as the `derived` component. The dial is off in the
 * default posture, so the first mechanism is what a deployment has, and
 * §8.9.1 holds a label less restrictive than the conservative default to
 * trust in the executing implementation for `flow-taint-precision`. Both dial
 * settings are exercised because a label present only under `"persist"` is a
 * label the default posture does not carry.
 *
 * `cfc-argument-ifc-propagation.test.ts` holds the other seam, where a
 * confidential argument reaches a module's declared result schema.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { BuiltInLLMMessage } from "@commonfabric/api";
import { findInternedSchema } from "@commonfabric/data-model-schema";
import {
  parseExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import { Identity } from "@commonfabric/identity";
import {
  addMockResponse,
  clearMockResponses,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm/client";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import type {
  JSONSchema,
  JSONSchemaObj,
  NodeRef,
} from "../src/builder/types.ts";
import { cfcLabelViewForResolvedCellWithStatus } from "../src/cfc/label-view.ts";
import type { CfcFlowLabelsMode } from "../src/cfc/types.ts";
import { LLMDialogResultSchema } from "../src/builtins/llm-schemas.ts";
import { Runtime } from "../src/runtime.ts";
import { waitForLlmMessages } from "./support/llm-result.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cfc-builtin-output-ifc");
const space = signer.did();

const BRIEFING_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "SensitiveBriefing",
  subject: "did:example:subject",
} as const;

// One confidential field, the shape a `Confidential<...>` argument compiles to.
const ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    briefing: { type: "string", ifc: { confidentiality: [BRIEFING_ATOM] } },
  },
} as const satisfies JSONSchema;

// The label the turn's cases put on the dialog's `messages` input, which is the
// pattern's own cell rather than its argument.
const LABELED_MESSAGES_SCHEMA = {
  type: "array",
  ifc: { confidentiality: [BRIEFING_ATOM] },
} as const satisfies JSONSchema;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    addMessage: { asCell: ["stream"] },
    pending: { type: "boolean" },
    messages: { type: "array" },
    answer: {},
  },
} as const satisfies JSONSchema;

type Builder = ReturnType<typeof createBuilder>["commonfabric"];

const createRuntime = (cfcFlowLabels: CfcFlowLabelsMode) => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels,
  });
  return { runtime, storageManager };
};

/**
 * The schema of the cell a node writes its output to.
 *
 * The node holds that schema interned behind an external reference, so the
 * reference is resolved rather than read.
 */
const outputSchema = (node: NodeRef): JSONSchema | undefined => {
  const alias = (node.outputs as {
    $alias?: { schema?: JSONSchema | { $ref?: string } };
  })?.$alias;
  const ref = (alias?.schema as { $ref?: string } | undefined)?.$ref;
  const taggedHash = typeof ref === "string"
    ? parseExternalSchemaRef(ref)?.taggedHash
    : undefined;
  return taggedHash !== undefined
    ? findInternedSchema(taggedHash)?.schema
    : alias?.schema as JSONSchema | undefined;
};

/**
 * The `ifc` on that schema.
 *
 * Five states report `undefined` together: a node with no output binding, a
 * binding naming no schema, a reference that does not parse, a reference naming
 * no interned schema, and the one a reader means — a schema carrying no `ifc`.
 * A case asserting the last pins {@link outputSchema} as well.
 */
const outputIfc = (node: NodeRef): JSONSchemaObj["ifc"] =>
  (outputSchema(node) as JSONSchemaObj | undefined)?.ifc;

/**
 * The confidentiality clauses a reader of `cell` sees, flattened across the
 * entries of its label view.
 *
 * The resolved view is the one an inspection surface uses: it follows the link
 * the selected path lands on, which a pattern result's field into a built-in's
 * output document always is.
 */
const confidentialityOf = (cell: unknown): unknown[] => {
  const { view } = cfcLabelViewForResolvedCellWithStatus(cell);
  return (view?.entries ?? []).flatMap((entry) =>
    entry.label.confidentiality ?? []
  );
};

/**
 * Builds a one-node pattern whose single built-in is handed the confidential
 * argument as its `system` parameter, and returns that node.
 *
 * The body drops what the built-in returns. `pattern()` takes the same join
 * over the cells a body returns, and the built-in's output cell is one of
 * them, so returning that cell itself labels its schema whatever this seam
 * did. Returning a path into it — `dialog.result`, say — escapes that, because
 * the join then reaches the alias rather than the output cell.
 */
const nodeForBuiltin = (
  runtime: Runtime,
  build: (builder: Builder, briefing: unknown) => unknown,
): NodeRef => {
  const { commonfabric } = createTrustedBuilder(runtime);
  const factory = commonfabric.pattern(
    (input: { briefing: string }) => {
      build(commonfabric, input.briefing);
      return { answer: "unrelated to the built-in" };
    },
    ARGUMENT_SCHEMA,
    { type: "object", properties: { answer: { type: "string" } } } as const,
  );
  const nodes = factory.nodes ?? [];
  expect(nodes.length).toBe(1);
  return nodes[0] as NodeRef;
};

describe("cfc-builtin-output-ifc", () => {
  describe("the build-time join", () => {
    // Each case names the built-in whose node it measures, because the join is
    // attached per node and an exemption would be per built-in.

    const measure = async (
      build: (builder: Builder, briefing: unknown) => unknown,
    ) => {
      const { runtime, storageManager } = createRuntime("off");
      try {
        return outputIfc(nodeForBuiltin(runtime, build));
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    it("puts the argument's label on `llm`'s output schema", async () => {
      expect(
        await measure((builder, briefing) =>
          builder.llm({ system: briefing } as never)
        ),
      ).toEqual({ confidentiality: [BRIEFING_ATOM] });
    });

    it("puts the argument's label on `generateText`'s output schema", async () => {
      expect(
        await measure((builder, briefing) =>
          builder.generateText({ system: briefing } as never)
        ),
      ).toEqual({ confidentiality: [BRIEFING_ATOM] });
    });

    it("puts the argument's label on `generateObject`'s output schema", async () => {
      expect(
        await measure((builder, briefing) =>
          builder.generateObject({ system: briefing } as never)
        ),
      ).toEqual({ confidentiality: [BRIEFING_ATOM] });
    });

    it("puts the argument's label on `llmDialog`'s output schema", async () => {
      expect(
        await measure((builder, briefing) =>
          builder.llmDialog({ system: briefing } as never)
        ),
      ).toEqual({ confidentiality: [BRIEFING_ATOM] });
    });

    it("leaves an output schema unlabeled when no input carries a label", async () => {
      const { runtime, storageManager } = createRuntime("off");
      try {
        const { commonfabric } = createTrustedBuilder(runtime);
        const factory = commonfabric.pattern(
          () => {
            commonfabric.llmDialog({ system: "plain" } as never);
            return { answer: "unrelated to the built-in" };
          },
          false,
          {
            type: "object",
            properties: { answer: { type: "string" } },
          } as const,
        );
        const node = (factory.nodes ?? [])[0] as NodeRef;

        // The schema the node names is the one `llmDialog` declares, by
        // identity, because interning hands back the object it was given. That
        // says the binding, the reference and the lookup all resolved, so the
        // absent `ifc` below is the schema carrying none.
        expect(outputSchema(node)).toBe(LLMDialogResultSchema);
        expect(outputIfc(node)).toBeUndefined();
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  // A whole turn, because the label these cases read is minted by the write the
  // turn performs rather than by the schema the graph declares. The pattern
  // declares no argument and labels the messages cell it hands the dialog, so
  // the join `pattern()` takes over a pattern's own argument and result
  // contributes nothing and this seam is the only candidate.
  for (const dial of ["persist", "off"] as const) {
    describe(`a completed dialog turn under cfcFlowLabels: "${dial}"`, () => {
      const runTurn = async () => {
        enableMockMode();
        clearMockResponses();
        addMockResponse(() => true, {
          role: "assistant",
          content: "a reply shaped by the briefing",
          id: "cfc-builtin-output-ifc",
        });
        const { runtime, storageManager } = createRuntime(dial);
        const tx = runtime.edit();
        const { commonfabric } = createTrustedBuilder(runtime);
        const { pattern, llmDialog, Cell } = commonfabric;
        const factory = pattern(
          () => {
            const messages = Cell.of<BuiltInLLMMessage[]>(
              [],
              LABELED_MESSAGES_SCHEMA,
            );
            const dialog = llmDialog({ messages } as never);
            return {
              addMessage: dialog.addMessage,
              pending: dialog.pending,
              messages,
              answer: dialog.result,
            };
          },
          false,
          RESULT_SCHEMA,
        );
        const resultCell = runtime.getCell(
          space,
          `dialog-result-${dial}`,
          RESULT_SCHEMA,
          tx,
        );
        const result = runtime.run(tx, factory, {}, resultCell);
        await tx.commit();
        const addMessage = await result.key("addMessage").pull();
        addMessage!.send({ role: "user", content: "what does it say?" });
        const settled = await waitForLlmMessages(runtime, result, 2);
        return { runtime, storageManager, result, settled };
      };

      const withTurn = async (
        body: (turn: Awaited<ReturnType<typeof runTurn>>) => void,
      ) => {
        const turn = await runTurn();
        try {
          body(turn);
        } finally {
          resetMockMode();
          await turn.runtime.dispose();
          await turn.storageManager.close();
        }
      };

      it("appends the model's reply to the dialog's messages", () =>
        withTurn(({ settled }) => {
          // Without this the cases below would pass on a turn that never ran:
          // an absent label and an absent request look alike from the outside.
          expect(settled.messages?.length).toBe(2);
          expect((settled.messages?.[1] as BuiltInLLMMessage).content).toBe(
            "a reply shaped by the briefing",
          );
        }));

      it("labels the dialog state with the labeled input's atom", () =>
        withTurn(({ result }) => {
          expect(confidentialityOf(result.key("answer"))).toContainEqual(
            BRIEFING_ATOM,
          );
          expect(confidentialityOf(result.key("pending"))).toContainEqual(
            BRIEFING_ATOM,
          );
        }));
    });
  }
});
