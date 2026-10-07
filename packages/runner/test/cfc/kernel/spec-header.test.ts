import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  formatSpecHeader,
  parseSpecHeaders,
} from "@commonfabric/runner/cfc/kernel/spec-header";

const HASH = "a".repeat(64);
const FILE = "08-12-store-label-monotonicity.md";

describe("spec-header", () => {
  describe("parseSpecHeaders()", () => {
    it("returns the four fields of a tag on one line", () => {
      expect(
        parseSpecHeaders(
          ` Whether. @spec ${FILE} §8.12.1 atomLe sha256:${HASH} `,
        ),
      ).toEqual([
        { file: FILE, section: "8.12.1", name: "atomLe", sha256: HASH },
      ]);
    });

    it("returns one tag for a header wrapped across the continuation lines of a doc comment", () => {
      const comment = [
        "",
        " * Whether `proposed` is at least as restrictive as `current`.",
        " *",
        ` * @spec ${FILE} §8.12.1`,
        ` *   atomLe sha256:${HASH}`,
        " ",
      ].join("\n");
      expect(parseSpecHeaders(comment)).toEqual([
        { file: FILE, section: "8.12.1", name: "atomLe", sha256: HASH },
      ]);
    });

    it("returns an empty list for a hash a letter or a sixty-fifth digit runs on from", () => {
      expect(parseSpecHeaders(`@spec ${FILE} §8.12.1 atomLe sha256:${HASH}Z`))
        .toEqual([]);
      expect(parseSpecHeaders(`@spec ${FILE} §8.12.1 atomLe sha256:${HASH}0`))
        .toEqual([]);
    });

    it("returns the tag when punctuation follows the hash", () => {
      expect(
        parseSpecHeaders(`@spec ${FILE} §8.12.1 atomLe sha256:${HASH}.`).length,
      ).toBe(1);
    });

    it("returns an empty list for a comment with no tag", () => {
      expect(parseSpecHeaders(" Whether one atom entails another. ")).toEqual(
        [],
      );
    });
  });

  describe("formatSpecHeader()", () => {
    it("writes a tag `parseSpecHeaders()` reads back", () => {
      const header = {
        file: FILE,
        section: "8.12.1",
        name: "atomLe",
        sha256: HASH,
      };
      expect(parseSpecHeaders(formatSpecHeader(header))).toEqual([header]);
    });
  });
});
