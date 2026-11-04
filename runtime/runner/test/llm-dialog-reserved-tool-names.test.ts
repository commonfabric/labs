import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { llmToolExecutionHelpers } from "../src/builtins/llm-dialog.ts";

const { buildToolCatalog, flattenTools } = llmToolExecutionHelpers;

describe("llmDialog reserved tool names", () => {
  // A name addresses one tool. A pattern supplying a second under a name the
  // dialog answers to would leave the catalog, the flattened list the UI reads,
  // the CFC gates, and the system prompt each free to describe a different one
  // — and the prompt describes the built-ins in prose that no lookup can
  // redirect. The name is refused where it is registered instead.

  const toolsCellNamed = (name: string) => ({
    get: () => ({
      [name]: {
        description: "the pattern's own tool",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    }),
    key: () => ({ get: () => undefined }),
  });

  const BUILTIN_NAMES = [
    "read",
    "invoke",
    "schema",
    "pin",
    "unpin",
    "updateArgument",
  ];

  for (const name of BUILTIN_NAMES) {
    it(`refuses a tool named ${name} while the built-ins are registered`, () => {
      const toolsCell = toolsCellNamed(name);

      expect(() => buildToolCatalog(toolsCell as any)).toThrow(
        new RegExp(`may not be named "${name}"`),
      );
      expect(() => flattenTools(toolsCell as any)).toThrow(
        new RegExp(`may not be named "${name}"`),
      );
    });

    it(`allows a tool named ${name} when builtinTools is false`, () => {
      const toolsCell = toolsCellNamed(name);

      const catalog = buildToolCatalog(toolsCell as any, false);

      expect(catalog.llmTools[name].description).toBe("the pattern's own tool");
      expect(catalog.dynamicToolCells.has(name)).toBe(true);

      // The flattened list releases the name on the same terms; a name freed
      // in one description and refused in the other would be the divergence
      // reserving it is meant to rule out.
      expect(flattenTools(toolsCell as any, false)[name].description).toBe(
        "the pattern's own tool",
      );
    });
  }

  it("refuses a tool named presentResult even without the built-ins", () => {
    const toolsCell = toolsCellNamed("presentResult");

    // Unlike the six, this name is not the built-ins' to give up: the dialog
    // stores the call carrying it as the structured result, matching by name.
    expect(() => buildToolCatalog(toolsCell as any, false)).toThrow(
      /may not be named "presentResult"/,
    );
    expect(() => flattenTools(toolsCell as any, false)).toThrow(
      /may not be named "presentResult"/,
    );
  });

  it("leaves an ordinary tool name alone", () => {
    const toolsCell = toolsCellNamed("searchNotes");

    const catalog = buildToolCatalog(toolsCell as any);

    expect(catalog.llmTools.searchNotes.description).toBe(
      "the pattern's own tool",
    );
    for (const name of BUILTIN_NAMES) {
      expect(name in catalog.llmTools).toBe(true);
    }
  });

  it("flattens the pattern's tools alongside the built-ins", () => {
    const toolsCell = toolsCellNamed("searchNotes");

    const flattened = flattenTools(toolsCell as any);

    // `flattenedTools` is what the UI lists, and it names the same set the
    // model is offered.
    expect(flattened.searchNotes.description).toBe("the pattern's own tool");
    for (const name of BUILTIN_NAMES) {
      expect(name in flattened).toBe(true);
    }
  });

  it("flattens only the pattern's tools when builtinTools is false", () => {
    const toolsCell = toolsCellNamed("searchNotes");

    const flattened = flattenTools(toolsCell as any, false);

    expect(Object.keys(flattened)).toEqual(["searchNotes"]);
  });
});
