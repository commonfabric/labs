import { expect } from "@std/expect";

import { firstContentLineMatches } from "../../../../lib/view/languages/evidence.ts";
import { languageForSource } from "../../../../lib/view/languages/language.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("evidence", () => {
  describe("firstContentLineMatches", () => {
    const opensWithKey = firstContentLineMatches(";#", /[^\S\n]*key\b/);

    it("matches the first line that is neither blank nor a comment", () => {
      expect(opensWithKey("key")).toBe(true);
      expect(opensWithKey("\n  \r\n\f\n; note\n  # note\nkey=1\n")).toBe(true);
      expect(opensWithKey("  key=1")).toBe(true);
    });

    it("does not match a later line or a commented one", () => {
      expect(opensWithKey("other\nkey\n")).toBe(false);
      expect(opensWithKey("; key\n")).toBe(false);
      expect(opensWithKey("% key\n")).toBe(false);
      expect(opensWithKey("\n\n")).toBe(false);
      expect(opensWithKey("")).toBe(false);
    });

    it("reads comment characters that are special inside a character class literally", () => {
      const evidence = firstContentLineMatches("]^-\\", /x/);

      expect(evidence("] a\n^ b\n- c\n\\ d\nx")).toBe(true);
      expect(evidence("a\nx")).toBe(false);
    });

    it("gives the same answer however many times it runs", () => {
      expect(opensWithKey("; c\nkey")).toBe(true);
      expect(opensWithKey("; c\nkey")).toBe(true);
      expect(opensWithKey("other")).toBe(false);
      expect(opensWithKey("key")).toBe(true);
    });
  });

  it("selects a shared extension's language from behind millions of blank and comment lines", () => {
    const blank = "\n".repeat(4_000_000);
    const comments = "# c\n".repeat(1_000_000);

    expect(languageForSource("a.conf", `${blank}${comments}[server]\n`).id)
      .toBe("ini");
    expect(
      languageForSource("site.conf", `${blank}${comments}worker 1;\n`).id,
    ).toBe("directive");
    expect(
      languageForSource("go.d.conf", `${blank}${comments}jobs:\n  - name: x\n`)
        .id,
    ).toBe("yaml");
    expect(languageForSource("a.conf", `${blank}${comments}`).id).toBe(
      "plain-text",
    );
    expect(languageForSource("app.env", `${blank}${comments}KEY=1\n`).id)
      .toBe("dotenv");
  });
});
