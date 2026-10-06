import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  boundHarnessCommandCatalog,
  HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES,
} from "../../src/client-actions/command-result.ts";
import type { HarnessCommandCatalogEntry } from "../../src/contracts/client-command.ts";

/** A catalog entry whose schema weighs about `schemaBytes`. */
const entry = (
  command: string,
  schemaBytes: number,
  description?: string,
): HarnessCommandCatalogEntry => ({
  command,
  summary: `Does ${command}.`,
  scope: "loom",
  executes: "loom",
  effect: "read",
  approval: "automatic",
  inputSchema: {
    type: "object",
    description: "x".repeat(schemaBytes),
  },
  ...(description !== undefined ? { description } : {}),
});

/** Enough commands that their schemas pass the model's catalog budget. */
const crowded = (): HarnessCommandCatalogEntry[] =>
  Array.from(
    { length: 12 },
    (_, index) => entry(`page.command-${index}`, 4 * 1024),
  );

describe("boundHarnessCommandCatalog", () => {
  it("returns a catalog that fits whole", () => {
    const entries = [entry("looms.list", 100)];
    expect(boundHarnessCommandCatalog({ entries })).toEqual({ entries });
  });

  it("keeps entries in order and drops the schemas of those past the budget", () => {
    const entries = crowded();
    const bounded = boundHarnessCommandCatalog({ entries });
    expect(bounded.entries.map((e) => e.command)).toEqual(
      entries.map((e) => e.command),
    );
    expect(bounded.compacted).toBeGreaterThan(0);
    const whole = bounded.entries.filter((e) => "inputSchema" in e);
    expect(whole.length + bounded.compacted!).toBe(entries.length);
    expect(new TextEncoder().encode(JSON.stringify(whole)).length)
      .toBeLessThanOrEqual(HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES);
  });

  it("keeps whole the commands a request named in detail, wherever they fall", () => {
    // The model asks for the last command's description and schema, which
    // the Weaver sends; a budget spent on the earlier entries must not strip
    // the one entry the request was made for.
    const entries = [
      ...crowded(),
      entry("page.write", 2 * 1024, "Write text into a page."),
    ];
    const bounded = boundHarnessCommandCatalog({ entries }, ["page.write"]);
    expect(bounded.entries.at(-1)).toEqual(entries.at(-1));
    expect(bounded.entries.map((e) => e.command)).toEqual(
      entries.map((e) => e.command),
    );
  });
});
