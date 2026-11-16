import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  type LLMResponse,
} from "@commonfabric/llm";

import type { Runtime } from "../../src/runtime.ts";
import { createTransactionCommitReceipt } from "../../src/storage/commit-receipt.ts";
import type { PostCommitSideEffect } from "../../src/cfc/types.ts";
import {
  type LLMBuiltinFixture,
  llmBuiltinFixture as fixture,
  llmFixtureIdentity,
} from "../support/llm-builtin-fixture.ts";
import { staleReadRefusal } from "../support/refuse-event-commit.ts";

/** The schema the `generateObject` cases ask for. */
const answerSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
} as const;

/** A caller-declared tool, which moves `generateObject` onto its tools path. */
const lookupTool = {
  lookup: { description: "Look up a fact", inputSchema: { type: "object" } },
};

/** A model response calling `presentResult` with `{ answer }`. */
function presentResult(answer: string): LLMResponse {
  return {
    role: "assistant",
    content: [{
      type: "tool-call",
      toolCallId: `present-${answer}`,
      toolName: "presentResult",
      input: { answer },
    }],
    id: `present-${answer}`,
  };
}

/** Commits `inputs` without running the action over them. */
async function writeInputs(f: LLMBuiltinFixture, inputs: unknown) {
  const tx = f.runtime.edit();
  f.input.withTx(tx).set(inputs);
  expect((await tx.commit().settled).error).toBeUndefined();
}

/** Runs the action in a transaction of its own and commits it. */
async function runAction(f: LLMBuiltinFixture) {
  const tx = f.runtime.edit();
  f.action(tx);
  expect((await tx.commit().settled).error).toBeUndefined();
  await tx.postCommitEffectsSettled();
  await f.runtime.idle();
}

/**
 * Commits `inputs`, then runs the action over them in a transaction of its own
 * and commits that, the way the scheduler runs it after an input changes. A
 * tool catalog reads its tools outside the action's transaction, so it sees
 * only committed ones.
 */
async function commitInputs(f: LLMBuiltinFixture, inputs: unknown) {
  await writeInputs(f, inputs);
  await runAction(f);
}

/** Each request path through the three builtins. */
const paths = {
  llm: {
    builtin: "llm",
    inputs: (text: string) => ({ messages: [{ role: "user", content: text }] }),
    response: (text: string): LLMResponse => ({
      role: "assistant",
      content: text,
      id: text,
    }),
    result: (text: string): unknown => text,
  },
  generateText: {
    builtin: "generateText",
    inputs: (text: string) => ({ prompt: text }),
    response: (text: string): LLMResponse => ({
      role: "assistant",
      content: text,
      id: text,
    }),
    result: (text: string): unknown => text,
  },
  "generateObject (direct)": {
    builtin: "generateObject",
    inputs: (text: string) => ({ prompt: text, schema: answerSchema }),
    response: (text: string): LLMResponse => ({
      role: "assistant",
      content: text,
      id: text,
    }),
    result: (text: string): unknown => ({ answer: text }),
  },
  "generateObject (tools)": {
    builtin: "generateObject",
    inputs: (text: string) => ({
      prompt: text,
      schema: answerSchema,
      tools: lookupTool,
    }),
    response: presentResult,
    result: (text: string): unknown => ({ answer: text }),
  },
} as const;

type PathName = keyof typeof paths;

/**
 * Refuses the next commit `runtime` makes with a retryable conflict whose
 * catch-up gate runs `beforeRetry`, letting every other commit through.
 * Returns how many commits were refused.
 */
function refuseNextCommit(
  runtime: Runtime,
  beforeRetry: () => Promise<void>,
): () => number {
  const edit = runtime.edit.bind(runtime);
  let refused = 0;
  runtime.edit = (options) => {
    const tx = edit(options);
    const commit = tx.commit.bind(tx);
    tx.commit = (commitOptions) => {
      if (refused > 0) return commit(commitOptions);
      refused++;
      runtime.edit = edit;
      const refusal = staleReadRefusal(
        llmFixtureIdentity.did(),
        "of:refused-llm-completion",
        beforeRetry,
      );
      tx.abort(refusal.message);
      return createTransactionCommitReceipt(
        Promise.resolve({ error: refusal }),
      );
    };
    return tx;
  };
  return () => refused;
}

describe("llm", () => {
  describe("request parameters", () => {
    it("sends `search` and each named native model tool once", async () => {
      const f = await fixture("generateText", false);
      try {
        await commitInputs(f, {
          prompt: "Where is the tallest tree?",
          search: true,
          nativeModelToolIds: [
            GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
            "url_context",
            "url_context",
          ],
        });
        await f.issued(1);
        expect(f.params[0]).toMatchObject({
          nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL, "url_context"],
        });
      } finally {
        await f.close();
      }
    });

    it("sends no native model tools when none are named", async () => {
      const f = await fixture("generateText", false);
      try {
        await commitInputs(f, { prompt: "Where is the tallest tree?" });
        await f.issued(1);
        expect(f.params[0]).not.toHaveProperty("nativeModelToolIds");
      } finally {
        await f.close();
      }
    });
  });

  describe("grounding sources", () => {
    it("flattens each source list into `groundingSources`, skipping what is not a source", async () => {
      const f = await fixture("generateText", false);
      const searchResult = {
        type: "cf-harness.native-model-tool-result",
        toolId: GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
      } as const;
      try {
        await commitInputs(f, { prompt: "Where is the tallest tree?" });
        await f.issued(1);
        f.requests[0].resolve({
          role: "assistant",
          content: "In California.",
          id: "grounded",
          nativeModelToolResults: [
            { ...searchResult, sources: "not a list" },
            {
              ...searchResult,
              sources: [
                null,
                "https://example.com/bare-string",
                { url: "https://example.com/hyperion", title: "Hyperion" },
                { url: "https://example.com/hyperion", title: "Duplicate" },
                { title: "Redwoods", description: "Coast redwoods." },
                { snippet: 42 },
              ],
            },
          ],
        });
        await f.runtime.settled();
        expect(f.output.key("result").get()).toBe("In California.");
        expect(
          f.parent.key("output").key("groundingSources").get(),
        ).toEqual([
          {
            url: "https://example.com/hyperion",
            title: "Hyperion",
            snippet: undefined,
          },
          { url: undefined, title: "Redwoods", snippet: "Coast redwoods." },
        ]);
      } finally {
        await f.close();
      }
    });
  });

  describe("a context that is not an object", () => {
    for (const path of Object.keys(paths) as PathName[]) {
      it(`sends the ${path} request with the default system prompt`, async () => {
        const { builtin, inputs, response, result } = paths[path];
        const f = await fixture(builtin, false);
        try {
          await commitInputs(f, { ...inputs("A"), context: null });
          await f.issued(1);
          expect(f.params[0]).toMatchObject({
            system: "You are a helpful assistant.",
          });
          f.requests[0].resolve(response("A"));
          await f.runtime.settled();
          expect(f.output.key("error").get()).toBeUndefined();
          expect(f.output.key("result").get()).toEqual(result("A"));
        } finally {
          await f.close();
        }
      });
    }
  });

  describe("a context entry whose links form a cycle", () => {
    for (
      const path of [
        "generateObject (direct)",
        "generateObject (tools)",
      ] as const
    ) {
      it(`sends the ${path} request and writes its result`, async () => {
        // Each entry of a `generateObject` context is pulled before the
        // request goes out; one that cannot resolve is left out of the
        // request rather than failing it.

        const { builtin, inputs, response, result } = paths[path];
        const f = await fixture(builtin, false);
        try {
          const space = llmFixtureIdentity.did();
          const first = f.runtime.getCell<unknown>(space, "context-cycle-a");
          const second = f.runtime.getCell<unknown>(space, "context-cycle-b");
          const seed = f.runtime.edit();
          first.withTx(seed).setRaw(second.getAsLink());
          second.withTx(seed).setRaw(first.getAsLink());
          expect((await seed.commit().settled).error).toBeUndefined();
          await commitInputs(f, { ...inputs("A"), context: { loop: first } });
          await f.issued(1);
          f.requests[0].resolve(response("A"));
          await f.runtime.settled();
          expect(f.requests).toHaveLength(1);
          expect(f.output.key("error").get()).toBeUndefined();
          expect(f.output.key("result").get()).toEqual(result("A"));
        } finally {
          await f.close();
        }
      });
    }
  });

  describe("`generateObject` direct path", () => {
    it("sends a request once when the action re-runs while it is in flight", async () => {
      const f = await fixture("generateObject", false);
      try {
        const inputs = { prompt: "Name a tree", schema: answerSchema };
        await commitInputs(f, inputs);
        await commitInputs(f, inputs);
        await f.issued(1);
        f.release("Sequoia");
        await f.runtime.settled();
        expect(f.requests).toHaveLength(1);
        expect(f.output.key("result").get()).toEqual({ answer: "Sequoia" });
      } finally {
        await f.close();
      }
    });

    it("reports a result that fails schema sanitization as `error`", async () => {
      const f = await fixture("generateObject", false);
      try {
        await commitInputs(f, {
          prompt: "Count the trees",
          schema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
          },
          schemaSanitizePromptInjection: true,
        });
        await f.issued(1);
        f.release("not a number");
        await f.runtime.settled();
        expect(f.output.key("pending").get()).toBe(false);
        expect(f.output.key("result").get()).toBeUndefined();
        expect(f.output.key("error").get()).toMatch(
          /^generateObject result failed schema sanitization validation: /,
        );
      } finally {
        await f.close();
      }
    });

    it("writes a result that passes schema sanitization", async () => {
      const f = await fixture("generateObject", false);
      try {
        await commitInputs(f, {
          prompt: "Name a tree",
          schema: answerSchema,
          schemaSanitizePromptInjection: true,
        });
        await f.issued(1);
        f.release("Sequoia");
        await f.runtime.settled();
        expect(f.output.key("error").get()).toBeUndefined();
        expect(f.output.key("result").get()).toEqual({ answer: "Sequoia" });
      } finally {
        await f.close();
      }
    });
  });

  describe("`generateObject` tool-calling path", () => {
    it("sends a request once when the action re-runs while it is in flight", async () => {
      const f = await fixture("generateObject", false);
      try {
        const inputs = {
          prompt: "Name a tree",
          schema: answerSchema,
          tools: lookupTool,
        };
        await commitInputs(f, inputs);
        await commitInputs(f, inputs);
        await f.issued(1);
        f.requests[0].resolve(presentResult("Sequoia"));
        await f.runtime.settled();
        expect(f.requests).toHaveLength(1);
        expect(f.output.key("result").get()).toEqual({ answer: "Sequoia" });
      } finally {
        await f.close();
      }
    });

    it("reports a response that calls no tool as `error`", async () => {
      const f = await fixture("generateObject", false);
      try {
        await commitInputs(f, {
          prompt: "Name a tree",
          schema: answerSchema,
          tools: lookupTool,
        });
        await f.issued(1);
        f.release("Sequoia, but in prose.");
        await f.runtime.settled();
        expect(f.output.key("pending").get()).toBe(false);
        expect(f.output.key("result").get()).toBeUndefined();
        expect(f.output.key("error").get()).toBe(
          "LLM did not call presentResult tool with structured data",
        );
      } finally {
        await f.close();
      }
    });

    it("stages the request hash and reports a memo hit for a settled request when serving", async () => {
      const f = await fixture("generateObject", true);
      const hits: Array<{ kind: string; id: string }> = [];
      f.runtime.effectMemoObserver = (event) => hits.push(event);
      try {
        const inputs = {
          prompt: "Name a tree",
          schema: answerSchema,
          tools: lookupTool,
        };
        await commitInputs(f, inputs);
        await f.issued(1);
        const requestHash = f.output.key("requestHash").get();
        expect(f.output.key("pending").get()).toBe(true);
        expect(requestHash).toEqual(expect.any(String));
        f.requests[0].resolve(presentResult("Sequoia"));
        await f.runtime.settled();
        expect(hits).toEqual([]);
        await commitInputs(f, inputs);
        expect(f.requests).toHaveLength(1);
        expect(hits).toEqual([
          { kind: "hit", id: `generateObject:${requestHash}` },
        ]);
        expect(f.output.key("result").get()).toEqual({ answer: "Sequoia" });
      } finally {
        await f.close();
      }
    });
  });
  describe("a request superseded before its dispatch", () => {
    for (
      const path of ["llm", "generateText", "generateObject (tools)"] as const
    ) {
      it(`does not send a ${path} request whose dispatch follows a newer request`, async () => {
        // The post-commit dispatch of request A is held back while request B is
        // staged and sent, the order a deferred post-commit effect produces.

        const { builtin, inputs, response, result } = paths[path];
        const f = await fixture(builtin, false);
        try {
          await writeInputs(f, inputs("A"));
          const held: PostCommitSideEffect[] = [];
          const tx = f.runtime.edit();
          tx.enqueuePostCommitEffect = (effect) => held.push(effect);
          f.action(tx);
          expect((await tx.commit().settled).error).toBeUndefined();
          expect(held).toHaveLength(1);
          await commitInputs(f, inputs("B"));
          await f.issued(1);
          held[0].flush(tx);
          await f.works.at(-1);
          expect(f.requests).toHaveLength(1);
          expect(f.params[0]).toMatchObject({
            messages: [{ role: "user", content: "B" }],
          });
          f.requests[0].resolve(response("B"));
          await f.runtime.settled();
          expect(f.output.key("error").get()).toBeUndefined();
          expect(f.output.key("result").get()).toEqual(result("B"));
        } finally {
          await f.close();
        }
      });
    }
  });

  describe("a response that arrives after a newer request", () => {
    it("drops a `generateObject` (tools) response that arrives after a newer request was staged", async () => {
      const f = await fixture("generateObject", false);
      const { inputs } = paths["generateObject (tools)"];
      try {
        await commitInputs(f, inputs("A"));
        await f.issued(1);
        await commitInputs(f, inputs("B"));
        await f.issued(2);
        f.requests[0].resolve(presentResult("A"));
        await f.works[0];
        expect(f.output.key("pending").get()).toBe(true);
        expect(f.output.key("result").get()).toBeUndefined();
        expect(f.output.key("error").get()).toBeUndefined();
        f.requests[1].resolve(presentResult("B"));
        await f.runtime.settled();
        expect(f.requests).toHaveLength(2);
        expect(f.output.key("error").get()).toBeUndefined();
        expect(f.output.key("result").get()).toEqual({ answer: "B" });
      } finally {
        await f.close();
      }
    });

    it("drops a finished `generateObject` (tools) result when a newer request is staged while it waits to write", async () => {
      const f = await fixture("generateObject", false);
      const { inputs } = paths["generateObject (tools)"];
      const idle = f.runtime.idle.bind(f.runtime);
      try {
        await commitInputs(f, inputs("A"));
        await f.issued(1);
        await writeInputs(f, inputs("B"));
        // The next wait for the scheduler stages B, which is where a newer
        // request lands between a finished tools loop and its write.
        f.runtime.idle = () => {
          f.runtime.idle = idle;
          const tx = f.runtime.edit();
          f.action(tx);
          tx.commit();
          return idle();
        };
        f.requests[0].resolve(presentResult("A"));
        await f.issued(2);
        await f.works[0];
        expect(f.output.key("pending").get()).toBe(true);
        expect(f.output.key("result").get()).toBeUndefined();
        f.requests[1].resolve(presentResult("B"));
        await f.runtime.settled();
        expect(f.output.key("result").get()).toEqual({ answer: "B" });
      } finally {
        f.runtime.idle = idle;
        await f.close();
      }
    });
  });

  describe("a served completion whose request is replaced before its retry", () => {
    for (const path of Object.keys(paths) as PathName[]) {
      it(`leaves the ${path} result to the newer request`, async () => {
        // The completion's first commit is refused, and the newer request is
        // selected before the retry, so the retry finds its request is no
        // longer the result's.

        const { builtin, inputs, response, result } = paths[path];
        const f = await fixture(builtin, true);
        try {
          await commitInputs(f, inputs("A"));
          await f.issued(1);
          const hashA = f.output.key("requestHash").get();
          await writeInputs(f, inputs("B"));
          const refused = refuseNextCommit(f.runtime, () => runAction(f));
          f.requests[0].resolve(response("A"));
          await f.works[0];
          await f.issued(2);
          expect(refused()).toBe(1);
          const hashB = f.output.key("requestHash").get();
          expect(hashB).not.toBe(hashA);
          expect(f.output.key("pending").get()).toBe(true);
          expect(f.output.key("result").get()).toBeUndefined();
          f.requests[1].resolve(response("B"));
          await f.runtime.settled();
          expect(f.output.key("result").get()).toEqual(result("B"));
          expect(f.output.key("requestHash").get()).toBe(hashB);
        } finally {
          await f.close();
        }
      });
    }

    it("leaves a failure's `error` unwritten when the newer request is selected before its retry", async () => {
      const f = await fixture("generateText", true);
      const { inputs } = paths.generateText;
      try {
        await commitInputs(f, inputs("A"));
        await f.issued(1);
        await writeInputs(f, inputs("B"));
        const refused = refuseNextCommit(f.runtime, () => runAction(f));
        f.requests[0].reject(new Error("upstream failure"));
        await f.works[0];
        await f.issued(2);
        expect(refused()).toBe(1);
        expect(f.output.key("pending").get()).toBe(true);
        expect(f.output.key("error").get()).toBeUndefined();
        f.release("B");
        await f.runtime.settled();
        expect(f.output.key("error").get()).toBeUndefined();
        expect(f.output.key("result").get()).toBe("B");
      } finally {
        await f.close();
      }
    });
  });

  describe("a refusal settled after a newer request", () => {
    it("keeps the newer request's result when not serving", async () => {
      const f = await fixture("llm", false);
      const refused = f.runtime.edit();
      try {
        f.stage(refused, "refused");
        const refusal = {
          name: "StorageTransactionAborted",
          message: "Controlled request refusal",
          reason: "Controlled request refusal",
        } as const;
        refused.abort(refusal);
        await f.run("A");
        await f.issued(1);
        f.release("A-result");
        await f.runtime.settled();
        refused.abandonStagedWork(refusal);
        await f.works.at(-1);
        await f.runtime.settled();
        expect(f.parent.get()).toMatchObject({ announced: true });
        expect(f.output.key("error").get()).toBeUndefined();
        expect(f.output.key("result").get()).toBe("A-result");
      } finally {
        await f.close();
      }
    });
  });

  describe("streamed partial text", () => {
    it("reports a partial write that cannot be prepared and still lands the result", async () => {
      const f = await fixture("llm", false);
      const prepare = f.runtime.prepareTxForCommit.bind(f.runtime);
      const warn = console.warn;
      const failure = new Error("partial preparation failed");
      const reported = Promise.withResolvers<unknown[]>();
      try {
        console.warn = (...args: unknown[]) => {
          if (args[0] === "[LLM] Error writing partial update:") {
            reported.resolve(args);
          }
          warn(...args);
        };
        await commitInputs(f, paths.llm.inputs("A"));
        await f.issued(1);
        f.runtime.prepareTxForCommit = () => {
          f.runtime.prepareTxForCommit = prepare;
          throw failure;
        };
        f.partials[0]!("A-par");
        expect(await reported.promise).toEqual([
          "[LLM] Error writing partial update:",
          failure,
        ]);
        expect(f.output.key("partial").get()).toBeUndefined();
        f.release("A-result");
        await f.runtime.settled();
        expect(f.output.key("result").get()).toBe("A-result");
        expect(f.output.key("partial").get()).toBe("A-result");
      } finally {
        console.warn = warn;
        f.runtime.prepareTxForCommit = prepare;
        await f.close();
      }
    });

    it("writes a batched partial text", async () => {
      const f = await fixture("llm", false);
      try {
        await commitInputs(f, paths.llm.inputs("A"));
        await f.issued(1);
        const landed = Promise.withResolvers<void>();
        const cancel = f.output.key("partial").sink((partial) => {
          if (partial === "A-par") landed.resolve();
        });
        f.partials[0]!("A-par");
        await landed.promise;
        cancel();
        expect(f.output.key("partial").get()).toBe("A-par");
        expect(f.output.key("pending").get()).toBe(true);
      } finally {
        await f.close();
      }
    });
  });
});
