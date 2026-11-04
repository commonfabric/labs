import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  findTopLevelArrow,
  findTopLevelEquals,
  isStringLiteralRange,
  locationFromOffset,
  parseFunctionText,
  splitTopLevelCommaList,
  stripJsTrivia,
  stripWholeParentheses,
  trimRange,
  tryParseCallExpression,
} from "../src/sandbox/compiled-js-parser.ts";

describe("findTopLevelEquals()", () => {
  it("ignores compound assignments at the top level", () => {
    const source = "exports.foo += 1";

    expect(findTopLevelEquals(source, 0, source.length)).toBeUndefined();
  });

  it("still finds direct assignments before nested compound assignments", () => {
    const source = "foo = bar += 1";

    expect(findTopLevelEquals(source, 0, source.length)).toBe(4);
  });
});

describe("trimRange()", () => {
  it("trims trailing block comments", () => {
    const source = "value /* trailing comment */";

    expect(trimRange(source, 0, source.length)).toEqual({
      start: 0,
      end: 5,
    });
  });

  it("trims trailing line comments", () => {
    const source =
      "value\n//# sourceMappingURL=data:foo\n//# sourceURL=bar.js\n";

    expect(trimRange(source, 0, source.length)).toEqual({
      start: 0,
      end: 5,
    });
  });

  it("leaves already-trimmed plain expressions unchanged", () => {
    const source = "exports.default";

    expect(trimRange(source, 0, source.length)).toEqual({
      start: 0,
      end: source.length,
    });
  });
});

describe("parseFunctionText()", () => {
  it("parses async function expressions with defaulted parameters", () => {
    const source = `async function (first = 1, second) {
      class Local {}
      return \`${"${first + second}"}\`;
    }`;

    const parsed = parseFunctionText(source, 0, source.length);

    expect(parsed.params).toEqual(["first", "second"]);
    expect(parsed.body.statements).toHaveLength(2);
  });

  it("parses arrow functions with block bodies", () => {
    const source = `(value, other) => {
      return value ? other : "fallback";
    }`;

    const parsed = parseFunctionText(source, 0, source.length);

    expect(parsed.params).toEqual(["value", "other"]);
    expect(parsed.body.statements).toHaveLength(1);
  });

  it("rejects destructured parameters", () => {
    const source = `({ value }) => { return value; }`;

    expect(() => parseFunctionText(source, 0, source.length)).toThrow(
      "Factory parameters must be simple identifiers",
    );
  });

  it("rejects arrow expression bodies", () => {
    const source = `value => value + 1`;

    expect(() => parseFunctionText(source, 0, source.length)).toThrow(
      "Expected '{'",
    );
  });
});

describe("scanner helpers", () => {
  it("strips trivia while preserving strings, regexes, and templates", () => {
    const source =
      `  // leading\nfoo /* inner */ + /a\\/[b]/g.test("a/b") + \`x${"${1 + /z/.test(y)}"}\` // trailing`;

    expect(stripJsTrivia(source)).toBe(
      `foo+/a\\/[b]/g.test("a/b")+\`x${"${1 + /z/.test(y)}"}\``,
    );
  });

  it("scans single bitwise operators and reads a regex after them", () => {
    // A single `&` or `|` is its own token (distinct from `&&`/`||`), and each
    // marks the scanner so a following `/.../ ` is a regex literal, not division
    // or a comment.
    expect(stripJsTrivia("a & b")).toBe("a&b");
    expect(stripJsTrivia("a | b")).toBe("a|b");
    expect(stripJsTrivia("a & /b/g")).toBe("a&/b/g");
    expect(stripJsTrivia("a | /b/ // tail")).toBe("a|/b/");
    // The doubled forms `&&`/`||` advance two characters as one token.
    expect(stripJsTrivia("a && b || c")).toBe("a&&b||c");
  });

  it("splits comma lists without splitting nested structures", () => {
    const source =
      `first, call(1, [2, 3]), { nested: /a,b/g }, \`hi, ${"${name}"}\``;

    const parts = splitTopLevelCommaList(source, 0, source.length)
      .map((range) => source.slice(range.start, range.end));

    expect(parts).toEqual([
      "first",
      "call(1, [2, 3])",
      "{ nested: /a,b/g }",
      `\`hi, ${"${name}"}\``,
    ]);
  });

  it("parses call expressions with nested arguments", () => {
    const source = `outer(inner(1, 2), { ok: true }, /a,b/g);`;

    const call = tryParseCallExpression(source, 0, source.length);

    expect(call?.callee).toBe("outer");
    expect(call?.args.map((arg) => source.slice(arg.start, arg.end))).toEqual([
      "inner(1, 2)",
      "{ ok: true }",
      "/a,b/g",
    ]);
  });

  it("returns undefined for non-call expressions", () => {
    const source = `value + 1`;

    expect(tryParseCallExpression(source, 0, source.length)).toBeUndefined();
  });

  it("recognizes exact string literal ranges", () => {
    const literalWithTrivia = ` /* before */ "a\\\"b" /* after */ `;
    expect(isStringLiteralRange(
      literalWithTrivia,
      0,
      literalWithTrivia.length,
    )).toBe(true);
    const literalWithLineComment = ` /* before */ "a" // after`;
    expect(isStringLiteralRange(
      literalWithLineComment,
      0,
      literalWithLineComment.length,
    )).toBe(true);
    expect(isStringLiteralRange(`"a" + value`, 0, 11)).toBe(false);
    expect(isStringLiteralRange(`"a\n"`, 0, 4)).toBe(false);
    expect(isStringLiteralRange(`"a"b`, 0, 4)).toBe(false);
  });

  it("matches JavaScript string literal token boundaries", () => {
    const escapedClosingQuote = '"' + 'a\\"b' + '"';
    const loneBackslash = '"a\\';
    const escapedBackslash = '"' + "a" + "\\\\" + '"';
    const unicodeEscape = '"' + "\\u0061" + '"';
    const adjacentStrings = '"a""b"';

    expect(isStringLiteralRange(
      escapedClosingQuote,
      0,
      escapedClosingQuote.length,
    )).toBe(true);
    expect(isStringLiteralRange(
      loneBackslash,
      0,
      loneBackslash.length,
    )).toBe(false);
    expect(isStringLiteralRange(
      escapedBackslash,
      0,
      escapedBackslash.length,
    )).toBe(true);
    expect(isStringLiteralRange(
      unicodeEscape,
      0,
      unicodeEscape.length,
    )).toBe(true);
    expect(isStringLiteralRange(
      adjacentStrings,
      0,
      adjacentStrings.length,
    )).toBe(false);

    expect(() => new Function(`return ${escapedClosingQuote};`)).not.toThrow();
    expect(() => new Function(`return ${loneBackslash};`)).toThrow();
    expect(() => new Function(`return ${escapedBackslash};`)).not.toThrow();
    expect(() => new Function(`return ${unicodeEscape};`)).not.toThrow();
    expect(() => new Function(`return ${adjacentStrings};`)).toThrow();
  });

  it("strips only whole parentheses", () => {
    const source = `((value)) + other`;

    expect(stripWholeParentheses(source, 0, source.length)).toEqual({
      start: 0,
      end: source.length,
    });
    expect(stripWholeParentheses(source, 0, "((value))".length)).toEqual({
      start: 2,
      end: 7,
    });
  });

  it("locates top-level arrows and source locations", () => {
    const source = `call(() => 1)\nvalue => ({ ok: true })`;

    expect(findTopLevelArrow(source, 0, source.length)).toBe(20);
    expect(locationFromOffset(source, 20)).toEqual({
      line: 2,
      column: 7,
    });
  });
});
