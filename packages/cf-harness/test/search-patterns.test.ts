import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { Identity } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";
import { PatternIndexClient } from "../src/pattern-index/client.ts";
import {
  isSearchPatternsToolSuccessOutput,
  patternIndexDeclaredType,
  searchPatternsTool,
  type SearchPatternsToolErrorOutput,
  type SearchPatternsToolSuccessOutput,
} from "../src/tools/search-patterns.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness search-patterns tool");

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

const SEARCH_HIT = {
  patternId: "pat-expenses",
  description: "Totals an expense list",
  hashtags: ["expenses", "money"],
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  dependencies: [],
  signals: { uses: 12, score: 0.9 },
  quality: "proven",
  kind: "part",
};

const PATTERN_RECORD = {
  patternId: "pat-expenses",
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  description: "Totals an expense list",
  hashtags: ["expenses", "money"],
  dependencies: [],
  argumentSchema: {
    type: "object",
    properties: { amounts: { type: "array", items: { type: "number" } } },
    required: ["amounts"],
  },
  resultSchema: {
    type: "object",
    properties: { total: { type: "number" } },
    required: ["total"],
  },
};

interface IndexStub {
  fetchFn: HarnessFetch;
  calls: { fn: string; body: unknown }[];
}

/**
 * An index that answers `searchPatterns` with `results` and `getPattern` with
 * whatever `patterns` holds for the requested id. A pattern absent from the
 * map answers 404, which is how a hit whose record cannot be read is staged.
 */
const stubIndex = (
  results: readonly unknown[],
  patterns: Record<string, unknown> = {},
): IndexStub => {
  const calls: { fn: string; body: unknown }[] = [];
  const catalogRecords = new Map(results.map((result) => {
    const record = result as Record<string, unknown>;
    return [record.patternId as string, record];
  }));
  for (const [id, record] of Object.entries(patterns)) {
    catalogRecords.set(id, record as Record<string, unknown>);
  }
  const fetchFn: HarnessFetch = (input, init) => {
    const fn = String(input).split("/").pop() ?? "";
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    calls.push({ fn, body });
    if (fn === "searchPatterns") {
      return Promise.resolve(
        new Response(JSON.stringify({ results }), { status: 200 }),
      );
    }
    if (fn === "listPatterns") {
      return Promise.resolve(Response.json({
        patterns: [...catalogRecords.values()].map((record) => ({
          ...record,
          events: { created: 1 },
          score: 0,
          quality: "unproven",
        })),
        eventTypes: {},
      }));
    }
    const id = (body as { patternId: string }).patternId;
    const pattern = patterns[id];
    return Promise.resolve(
      pattern === undefined
        ? new Response(JSON.stringify({ error: "unknown pattern" }), {
          status: 404,
        })
        : new Response(JSON.stringify(pattern), { status: 200 }),
    );
  };
  return { fetchFn, calls };
};

const createEngine = (index?: IndexStub): CfHarnessEngine =>
  new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: `search-patterns-test-${crypto.randomUUID()}`,
    ...(index === undefined ? {} : {
      patternIndexClientFactory: () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test",
            fetchFn: index.fetchFn,
            signer,
          }),
        ),
    }),
  });

describe("search-patterns", () => {
  describe("patternIndexDeclaredType()", () => {
    const LEDGER_RESULT = {
      type: "object",
      properties: {
        month: { type: "string" },
        rows: {
          type: "array",
          items: { $ref: "#/$defs/LedgerTransaction" },
        },
        pending: { type: "boolean" },
        currency: { $ref: "#/$defs/Currency" },
      },
      required: ["month", "rows", "pending", "currency"],
      $defs: {
        LedgerTransaction: {
          type: "object",
          properties: {
            transaction_id: { type: "string" },
            merchant_name: { type: "string" },
            signed_amount: { type: "number" },
            category: { $ref: "#/$defs/CategoryWithAVeryLongDescriptiveName" },
          },
          required: [
            "transaction_id",
            "merchant_name",
            "signed_amount",
            "category",
          ],
        },
        CategoryWithAVeryLongDescriptiveName: {
          type: "object",
          properties: {
            primary: { type: "string" },
            detailed: { type: "string" },
            confidence_level: { type: "string" },
          },
          required: ["primary", "detailed", "confidence_level"],
        },
        Currency: { type: "string" },
        Unreferenced: {
          type: "object",
          properties: { never: { type: "string" } },
        },
        month: {
          type: "object",
          properties: { never_used_under_this_name: { type: "string" } },
        },
      },
    };

    it("writes out each named definition the type refers to, and the ones those refer to", () => {
      const rendered = patternIndexDeclaredType(LEDGER_RESULT as never)!;

      expect(rendered).toContain("rows: LedgerTransaction[]");
      expect(rendered).toContain("type LedgerTransaction = {");
      expect(rendered).toContain("merchant_name: string");
      expect(rendered).toContain("signed_amount: number");
      expect(rendered).toContain(
        "type CategoryWithAVeryLongDescriptiveName = {",
      );
      expect(rendered).toContain("confidence_level: string");
      expect(rendered).not.toContain("Unreferenced");
      // A property named like a definition is not a reference to it.
      expect(rendered).not.toContain("type month =");
      // A definition small enough to inline is inlined, not written out.
      expect(rendered).toContain("currency: string");
      expect(rendered).not.toContain("type Currency =");
    });

    it("adds nothing to a type that names no definition", () => {
      expect(
        patternIndexDeclaredType({
          type: "object",
          properties: { amounts: { type: "array", items: { type: "number" } } },
        }),
      ).not.toContain("type ");
    });
  });

  it("keeps inherited evidence attributed in the model's search result", async () => {
    const signals = {
      uses: 10,
      score: 4,
      inherited: {
        priorPatternId: "pat-older",
        asOf: "2026-09-17T00:00:00Z",
        events: { run_succeeded: 4 },
        score: 4,
      },
    };
    const index = stubIndex([{ ...SEARCH_HIT, signals }], {
      "pat-expenses": PATTERN_RECORD,
    });
    const result = await createEngine(index).invokeBuiltinTool(
      "search_patterns",
      { text: "expenses" },
    );
    const output = result.output as SearchPatternsToolSuccessOutput;
    expect(output.results[0].signals).toEqual(signals);
  });

  it("offers only the successor's identity, import, and declared shapes", async () => {
    const successor = {
      ...PATTERN_RECORD,
      patternId: "pat-fresh",
      priorPatternId: SEARCH_HIT.patternId,
      description: "Returns a donut count",
      argumentSchema: {
        type: "object",
        properties: { donuts: { type: "number" } },
        required: ["donuts"],
      },
    };
    const index = stubIndex([SEARCH_HIT], {
      "pat-expenses": PATTERN_RECORD,
      "pat-fresh": successor,
    });
    const result = await createEngine(index).invokeBuiltinTool(
      "search_patterns",
      { text: "expenses" },
    );
    const output = result.output as SearchPatternsToolSuccessOutput;
    expect(output.status).toBe("ok");
    expect(output.results.map((hit) => hit.patternId)).toEqual(["pat-fresh"]);
    expect(output.results[0].importHint).toBe(
      'import X from "cf:pattern:pat-fresh"',
    );
    expect(output.results[0].argumentType).toContain("donuts: number");
    expect(output.results[0].argumentType).not.toContain("amounts");
    expect(
      index.calls.filter((call) => call.fn === "getPattern").map((call) =>
        call.body
      ),
    ).toEqual([
      { patternId: "pat-expenses", includeSource: false },
      { patternId: "pat-fresh", includeSource: false },
      { patternId: "pat-fresh", includeSource: false },
    ]);
  });
  it("reports each hit with the import specifier that composes it", async () => {
    const index = stubIndex([SEARCH_HIT], { "pat-expenses": PATTERN_RECORD });
    const result = await createEngine(index).invokeBuiltinTool(
      "search_patterns",
      { tags: ["expenses"] },
    );
    const output = result.output as SearchPatternsToolSuccessOutput;
    expect(output.status).toBe("ok");
    expect(output.results.length).toBe(1);
    expect(output.results[0].patternId).toBe("pat-expenses");
    expect(output.results[0].description).toBe("Totals an expense list");
    expect(output.results[0].hashtags).toEqual(["expenses", "money"]);
    expect(output.results[0].signals).toEqual({ uses: 12, score: 0.9 });
    expect(output.results[0].quality).toBe("proven");
    expect(output.results[0].kind).toBe("part");
    expect(output.results[0].importHint).toBe(
      'import X from "cf:pattern:pat-expenses"',
    );
  });

  it("renders the declared argument and result shapes as types", async () => {
    const index = stubIndex([SEARCH_HIT], { "pat-expenses": PATTERN_RECORD });
    const result = await createEngine(index).invokeBuiltinTool(
      "search_patterns",
      { text: "expenses" },
    );
    const output = result.output as SearchPatternsToolSuccessOutput;
    expect(output.results[0].argumentType).toContain("amounts");
    expect(output.results[0].argumentType).toContain("number[]");
    expect(output.results[0].resultType).toContain("total: number");
  });

  it("asks the index for the shapes without asking for source", async () => {
    const index = stubIndex([SEARCH_HIT], { "pat-expenses": PATTERN_RECORD });
    await createEngine(index).invokeBuiltinTool("search_patterns", {
      tags: ["expenses"],
    });
    const lookup = index.calls.find((call) => call.fn === "getPattern");
    expect(lookup?.body).toEqual({
      patternId: "pat-expenses",
      includeSource: false,
    });
  });

  it("reports a discovery error when catalog metadata cannot be read", async () => {
    const index = stubIndex([SEARCH_HIT]);
    const result = await createEngine(index).invokeBuiltinTool(
      "search_patterns",
      { tags: ["expenses"] },
    );
    const output = result.output as SearchPatternsToolErrorOutput;
    expect(output.status).toBe("error");
    expect(output.message).toContain("getPattern failed (404)");
    expect(output).not.toHaveProperty("results");
  });

  it("keeps a discovered hit when the later shape request loses service", async () => {
    const index = stubIndex([SEARCH_HIT], { "pat-expenses": PATTERN_RECORD });
    const available = index.fetchFn;
    let reads = 0;
    index.fetchFn = (input, init) => {
      if (String(input).endsWith("/getPattern") && ++reads === 2) {
        return Promise.resolve(new Response("unavailable", { status: 503 }));
      }
      return available(input, init);
    };
    const result = await createEngine(index).invokeBuiltinTool(
      "search_patterns",
      { tags: ["expenses"] },
    );
    const output = result.output as SearchPatternsToolSuccessOutput;
    expect(output.status).toBe("ok");
    expect(output.results[0].patternId).toBe("pat-expenses");
    expect(output.results[0].argumentType).toBeUndefined();
    expect(output.results[0].resultType).toBeUndefined();
  });

  it("refuses a search that names neither tags nor text", async () => {
    const index = stubIndex([]);
    const result = await createEngine(index).invokeBuiltinTool(
      "search_patterns",
      {},
    );
    const output = result.output as SearchPatternsToolErrorOutput;
    expect(output.status).toBe("error");
    expect(output.message).toContain("requires tags, text, or both");
  });

  it("refuses when the run has no pattern index configured", async () => {
    const result = await createEngine().invokeBuiltinTool("search_patterns", {
      tags: ["expenses"],
    });
    const output = result.output as SearchPatternsToolErrorOutput;
    expect(output.status).toBe("error");
    expect(output.message).toContain("--pattern-index-url");
  });

  it("declares itself a read, since a search alters nothing", () => {
    expect(searchPatternsTool.descriptor.effectClass).toBe("read");
  });

  it("does not trust a persisted success whose hit is incomplete", () => {
    expect(isSearchPatternsToolSuccessOutput({
      outputId: "search_patterns-1",
      status: "ok",
      results: [{ patternId: "pat-incomplete" }],
    })).toBe(false);
  });

  it("does not trust non-object persisted successes or hits", () => {
    expect(isSearchPatternsToolSuccessOutput(null)).toBe(false);
    expect(isSearchPatternsToolSuccessOutput({
      outputId: "search_patterns-1",
      status: "ok",
      results: [null],
    })).toBe(false);
  });

  it("describes deployed stopword-free disjunctive matching", () => {
    const schema = searchPatternsTool.descriptor.inputSchema;
    if (
      !isObjectOrArray(schema) ||
      schema.type !== "object" || schema.properties === undefined
    ) {
      throw new Error("expected `search_patterns` object input schema");
    }
    const text = schema.properties.text;
    const description = isObjectOrArray(text) ? text.description : undefined;

    expect(description).toContain("stopword-free");
    expect(description).toContain("whole words");
    expect(description).toContain("suffix");
    expect(description).not.toContain("more words widen the net");
  });

  it("reports what the index answered when a search fails", async () => {
    const failing: HarnessFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
      );
    const result = await createEngine({ fetchFn: failing, calls: [] })
      .invokeBuiltinTool("search_patterns", { tags: ["expenses"] });
    const output = result.output as SearchPatternsToolErrorOutput;
    expect(output.status).toBe("error");
    expect(output.message).toContain("403");
    // The service body ("forbidden") stays off the model-facing message.
    expect(output.message).toContain("searchPatterns failed (403)");
    expect(output.message).not.toContain("forbidden");
  });
});
