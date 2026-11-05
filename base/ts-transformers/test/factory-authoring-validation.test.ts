import { assertEquals, assertStringIncludes } from "@std/assert";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { validateSource } from "./utils.ts";

async function factoryAuthoringDiagnostics(source: string) {
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
    typeCheck: true,
  });
  return diagnostics.filter((diagnostic) =>
    diagnostic.type.startsWith("factory-authoring:")
  );
}

Deno.test("removed patternTool imports point to inline pattern factories", async () => {
  const diagnostics = await factoryAuthoringDiagnostics(`
import { pattern, patternTool } from "commonfabric";

export default pattern(() => ({ patternTool }));
`);

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.type, "factory-authoring:legacy-pattern-tool");
  assertStringIncludes(diagnostics[0]!.message, "pattern(...)");
  assertStringIncludes(
    diagnostics[0]!.message,
    "docs/common/concepts/factories.md",
  );
});

Deno.test("removed extraParams points to closure capture", async () => {
  const diagnostics = await factoryAuthoringDiagnostics(`
import { generateText, pattern } from "commonfabric";

const search = pattern<{ query: string }, { answer: string }>(
  ({ query }) => ({ answer: query }),
);

export default pattern(() =>
  generateText({
    prompt: "search",
    tools: { search, extraParams: { locale: "en" } },
  })
);
`);

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.type, "factory-authoring:legacy-extra-params");
  assertStringIncludes(diagnostics[0]!.message, "closure");
  assertStringIncludes(diagnostics[0]!.message, "pattern(...)");
});

Deno.test("plain callbacks in PatternFactory slots name pattern()", async () => {
  const diagnostics = await factoryAuthoringDiagnostics(`
import { type PatternFactory } from "commonfabric";

const operation: PatternFactory<
  { query: string },
  { answer: string }
> = (input: { query: string }) => ({ answer: input.query });
`);

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.type, "factory-authoring:plain-function");
  assertStringIncludes(diagnostics[0]!.message, "PatternFactory");
  assertStringIncludes(diagnostics[0]!.message, "pattern(...)");
});

Deno.test("Default in an incompatible factory slot names the narrowing", async () => {
  const diagnostics = await factoryAuthoringDiagnostics(`
import { pattern, type Default, type PatternFactory } from "commonfabric";

const child = pattern<{ query: Default<""> }, { answer: string }>(
  ({ query }) => ({ answer: query }),
);
const operation: PatternFactory<
  { query: string },
  { answer: string }
> = child;
`);

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.type, "factory-authoring:default-input-slot");
  assertStringIncludes(diagnostics[0]!.message, "Default<>");
  assertStringIncludes(diagnostics[0]!.message, "factory slot");
});

Deno.test("wrong factory kinds are named directly", async () => {
  const diagnostics = await factoryAuthoringDiagnostics(`
import { pattern, type ModuleFactory } from "commonfabric";

const operation: ModuleFactory<
  { query: string },
  { answer: string }
> = pattern<{ query: string }, { answer: string }>(
  ({ query }) => ({ answer: query }),
);
`);

  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]!.type, "factory-authoring:wrong-kind");
  assertStringIncludes(diagnostics[0]!.message, "pattern factory");
  assertStringIncludes(diagnostics[0]!.message, "module factory");
});
