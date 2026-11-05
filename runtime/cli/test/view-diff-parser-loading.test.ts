/**
 * Tests that preparing a diff view loads the parser of a language the diff's
 * content selects. Every other case that reaches a parser lives in another
 * file, because a case here that loaded one would leave this file's evidence
 * unable to fail.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { buildPreparedView } from "../lib/view/mod.ts";

describe("diff parser loading", () => {
  it("colors an extensionless file in the language its diff's shebang selects", async () => {
    // A view built before the shell parser loads shows shell as plain text,
    // so the coloring shows that preparing the view loaded it.

    const diff = [
      "diff --git a/.githooks/pre-commit b/.githooks/pre-commit",
      "--- a/.githooks/pre-commit",
      "+++ b/.githooks/pre-commit",
      "@@ -1,2 +1,2 @@",
      " #!/usr/bin/env bash",
      '-echo "old"',
      '+echo "new"',
      "",
    ].join("\n");

    const { doc } = await buildPreparedView(diff);

    expect(
      doc.lines.filter((line) => line.bg !== undefined).map((line) =>
        line.spans.find((span) => span.text === "echo")?.cls
      ),
    ).toEqual(["callName", "callName"]);
  });
});
