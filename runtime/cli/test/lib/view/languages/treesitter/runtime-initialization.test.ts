/**
 * The shared Tree-sitter runtime's initialization, in a file of its own so that
 * nothing has initialized the runtime before its one case runs. The pager warms
 * every language at once, so several grammars load concurrently into a runtime
 * that none of them has initialized yet.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  highlightLines,
  prepareGrammar,
  type TreeSitterGrammar,
} from "../../../../../lib/view/languages/treesitter/adapter.ts";
import { pythonGrammar } from "../../../../../lib/view/languages/python/python.ts";

describe("adapter", () => {
  it("parses with every grammar that loads while the runtime initializes", async () => {
    // A second grammar under its own identifier loads separately, as a second
    // language would.
    const second: TreeSitterGrammar = { ...pythonGrammar, id: "python-second" };

    await Promise.all([prepareGrammar(pythonGrammar), prepareGrammar(second)]);

    for (const grammar of [pythonGrammar, second]) {
      expect(highlightLines(grammar, "x = 1")[0].spans.map((span) => span.cls))
        .toContain("number");
    }
  });
});
