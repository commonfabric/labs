import { expect } from "@std/expect";

import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { gitConfigLanguage } from "../../../../../lib/view/languages/git-config/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** The source each colored line reconstructs. */
function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

/** Every distinct class the colored lines give to an exact fragment. */
function classesOf(lines: readonly Line[], text: string): TokenClass[] {
  return [
    ...new Set(
      lines.flatMap((line) =>
        line.spans.filter((span) => span.text === text).map((span) => span.cls)
      ),
    ),
  ];
}

/** Each structure entry's label, depth, and first and last lines. */
function outline(source: string): [string, number, number, number][] {
  return gitConfigLanguage.parseDocument(source).flatStructure.map((node) => [
    node.label,
    node.depth,
    node.startLine,
    node.endLine,
  ]);
}

const CONFIGURATION = [
  "# Written by git config",
  "[core]",
  "\tbare = false",
  "\tlogallrefupdates",
  '[remote "origin"]',
  "\turl = git@github.com:commonfabric/labs.git",
  "\tfetch = +refs/heads/*:refs/remotes/origin/*",
  "  ; An indented comment",
  '[url "git@github.com:"] insteadOf = https://github.com/',
].join("\n");

describe("gitConfigLanguage", () => {
  it("selects Git configuration files by name", () => {
    for (
      const path of [
        ".gitmodules",
        "vendor/labs/.gitmodules",
        ".gitconfig",
        "home/.GITCONFIG",
        "etc/gitconfig",
        "config/work.gitconfig",
        ".git/config.worktree",
        ".lfsconfig",
      ]
    ) {
      expect(languageForFile(path).id).toBe("git-config");
    }
    for (const path of [".git/config", "config", ".gitmodules.bak"]) {
      expect(languageForFile(path).id).toBe("plain-text");
    }
  });

  it("colors comments, section names, subsections, variables, and values", () => {
    const lines = gitConfigLanguage.highlightLines(CONFIGURATION);

    expect(classesOf(lines, "# Written by git config")).toEqual(["comment"]);
    expect(classesOf(lines, "; An indented comment")).toEqual(["comment"]);
    expect(classesOf(lines, "[")).toEqual(["bracket"]);
    expect(classesOf(lines, "]")).toEqual(["bracket"]);
    expect(classesOf(lines, "core")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "remote")).toEqual(["interfaceName"]);
    expect(classesOf(lines, '"origin"')).toEqual(["string"]);
    expect(classesOf(lines, "bare")).toEqual(["propertyName"]);
    expect(classesOf(lines, "logallrefupdates")).toEqual(["propertyName"]);
    expect(classesOf(lines, "=")).toEqual(["operator"]);
    expect(classesOf(lines, "false")).toEqual(["string"]);
    expect(classesOf(lines, "+refs/heads/*:refs/remotes/origin/*"))
      .toEqual(["string"]);
    expect(classesOf(lines, '"git@github.com:"')).toEqual(["string"]);
    expect(classesOf(lines, "insteadOf")).toEqual(["propertyName"]);
    expect(classesOf(lines, "https://github.com/")).toEqual(["string"]);
    expect(verbatim(lines)).toBe(CONFIGURATION);
  });

  it("reads `#` and `;` as literal inside quotes and as a comment outside them", () => {
    const source = 'a = "x # y" ; note\nb = c#d\nc = "e;f"';
    const lines = gitConfigLanguage.highlightLines(source);

    expect(classesOf(lines, '"x # y"')).toEqual(["string"]);
    expect(classesOf(lines, " ")).toEqual(["whitespace"]);
    expect(classesOf(lines, "; note")).toEqual(["comment"]);
    expect(classesOf(lines, "c")).toEqual(["string", "propertyName"]);
    expect(classesOf(lines, "#d")).toEqual(["comment"]);
    expect(classesOf(lines, '"e;f"')).toEqual(["string"]);
  });

  it("keeps an escaped quote or backslash inside a value and a subsection", () => {
    const source = '[alias "a\\"b"]\n\tq = "say \\"hi\\"" # c\n\tr = x\\\\#y';
    const lines = gitConfigLanguage.highlightLines(source);

    expect(classesOf(lines, '"a\\"b"')).toEqual(["string"]);
    expect(classesOf(lines, '"say \\"hi\\""')).toEqual(["string"]);
    expect(classesOf(lines, "# c")).toEqual(["comment"]);
    expect(classesOf(lines, "x\\\\")).toEqual(["string"]);
    expect(classesOf(lines, "#y")).toEqual(["comment"]);
  });

  it("lists a variable only when Git accepts every escape in its value", () => {
    const source = [
      '[a] ok = "\\n\\t\\b\\\\\\""',
      "path = C:\\Users\\x",
      "k = \\q",
    ].join("\n");
    const lines = gitConfigLanguage.highlightLines(source);

    expect(classesOf(lines, '"\\n\\t\\b\\\\\\""')).toEqual(["string"]);
    expect(classesOf(lines, "C:")).toEqual(["string"]);
    expect(classesOf(lines, "\\Users\\x")).toEqual(["plain"]);
    expect(classesOf(lines, "\\q")).toEqual(["plain"]);
    expect(outline(source)).toEqual([["[a]", 0, 0, 0], ["ok", 1, 0, 0]]);
  });

  it("continues a value on the next line after a backslash at the end of a line", () => {
    const source = [
      "[alias]",
      "\tlg = log \\",
      "  --graph \\",
      '  --format="%h # %s" ; a comment \\',
      "\tst = status",
    ].join("\n");
    const lines = gitConfigLanguage.highlightLines(source);

    expect(classesOf(lines, "log ")).toEqual(["string"]);
    expect(classesOf(lines, "\\")).toEqual(["punctuation"]);
    expect(classesOf(lines, "  --graph ")).toEqual(["string"]);
    expect(classesOf(lines, '  --format="%h # %s"')).toEqual(["string"]);
    expect(classesOf(lines, "; a comment \\")).toEqual(["comment"]);
    expect(classesOf(lines, "st")).toEqual(["propertyName"]);
    expect(outline(source)).toEqual([
      ["[alias]", 0, 0, 4],
      ["lg", 1, 1, 3],
      ["st", 1, 4, 4],
    ]);
  });

  it("continues a quoted value across lines", () => {
    const source = 'a = "one \\\n# two" ; three\nb';
    const lines = gitConfigLanguage.highlightLines(source);

    expect(classesOf(lines, '"one ')).toEqual(["string"]);
    expect(classesOf(lines, '# two"')).toEqual(["string"]);
    expect(classesOf(lines, "; three")).toEqual(["comment"]);
    expect(classesOf(lines, "b")).toEqual(["propertyName"]);
  });

  it("lists a variable only on a line Git accepts", () => {
    const source = [
      "[a]",
      "ok-2 = 1",
      "flag",
      "snake_case = 2",
      "x:y = 3",
      "2nd = 4",
      "bare ; comment",
      "k\r= v",
    ].join("\n");
    const lines = gitConfigLanguage.highlightLines(source);

    expect(classesOf(lines, "ok-2")).toEqual(["propertyName"]);
    expect(classesOf(lines, "flag")).toEqual(["propertyName"]);
    expect(classesOf(lines, "snake_case")).toEqual(["plain"]);
    expect(classesOf(lines, "x:y")).toEqual(["plain"]);
    expect(classesOf(lines, "2nd")).toEqual(["plain"]);
    expect(classesOf(lines, "4")).toEqual(["plain"]);
    expect(classesOf(lines, "bare")).toEqual(["plain"]);
    expect(classesOf(lines, "comment")).toEqual(["plain"]);
    expect(classesOf(lines, "k")).toEqual(["plain"]);
    expect(outline(source)).toEqual([
      ["[a]", 0, 0, 2],
      ["ok-2", 1, 1, 1],
      ["flag", 1, 2, 2],
    ]);
  });

  it("reads several section headers on one line, as Git does", () => {
    const source = '[a][b "c"] d = e\n[f] [g]h\n[i] ; [j]';
    const lines = gitConfigLanguage.highlightLines(source);

    expect(classesOf(lines, "b")).toEqual(["interfaceName"]);
    expect(classesOf(lines, '"c"')).toEqual(["string"]);
    expect(classesOf(lines, "d")).toEqual(["propertyName"]);
    expect(classesOf(lines, "h")).toEqual(["propertyName"]);
    expect(classesOf(lines, "; [j]")).toEqual(["comment"]);
    expect(outline(source)).toEqual([
      ["[a]", 0, 0, 0],
      ['[b "c"]', 0, 0, 0],
      ["d", 1, 0, 0],
      ["[f]", 0, 1, 1],
      ["[g]", 0, 1, 1],
      ["h", 1, 1, 1],
      ["[i]", 0, 2, 2],
    ]);
  });

  it("colors a header Git rejects up to where Git rejects it, and leaves it out of the structure tree", () => {
    const source = [
      "[a_b] c = 1",
      '[d"e"]',
      '[f "g" ]',
      "[h ]",
      '[] ["i"]',
      "[ok]",
      '[ "j"]',
    ].join("\n");
    const lines = gitConfigLanguage.highlightLines(source);

    expect(classesOf(lines, "a")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "_b]")).toEqual(["plain"]);
    expect(classesOf(lines, "c")).toEqual(["plain"]);
    expect(classesOf(lines, "d")).toEqual(["interfaceName"]);
    expect(classesOf(lines, '"e"]')).toEqual(["plain"]);
    expect(classesOf(lines, '"g"')).toEqual(["string"]);
    expect(classesOf(lines, "h")).toEqual(["interfaceName"]);
    expect(classesOf(lines, '["i"]')).toEqual(["plain"]);
    expect(outline(source)).toEqual([
      ["[ok]", 0, 5, 5],
      ['[ "j"]', 0, 6, 6],
    ]);
  });

  it("reads only spaces, tabs, and carriage returns as white space inside a line", () => {
    const source = "k\v= v\nm =\u00a0w\u00a0";
    const lines = gitConfigLanguage.highlightLines(source);

    expect(classesOf(lines, "k")).toEqual(["plain"]);
    expect(classesOf(lines, "m")).toEqual(["propertyName"]);
    expect(classesOf(lines, "\u00a0w\u00a0")).toEqual(["string"]);
    expect(outline(source)).toEqual([["m", 0, 1, 1]]);
  });

  it("files no variable under a section whose header Git rejects", () => {
    expect(outline("[a]\nk = v\n[b_c]\nm = 1")).toEqual([
      ["[a]", 0, 0, 1],
      ["k", 1, 1, 1],
      ["m", 0, 3, 3],
    ]);
  });

  it("reads a legacy dotted section name as one name", () => {
    const lines = gitConfigLanguage.highlightLines("[branch.main]\nmerge = x");

    expect(classesOf(lines, "branch.main")).toEqual(["interfaceName"]);
    expect(outline("[branch.main]\nmerge = x")).toEqual([
      ["[branch.main]", 0, 0, 1],
      ["merge", 1, 1, 1],
    ]);
  });

  it("lists sections and the variables each one sets", () => {
    expect(outline("top = 1\n" + CONFIGURATION)).toEqual([
      ["top", 0, 0, 0],
      ["[core]", 0, 2, 4],
      ["bare", 1, 3, 3],
      ["logallrefupdates", 1, 4, 4],
      ['[remote "origin"]', 0, 5, 7],
      ["url", 1, 6, 6],
      ["fetch", 1, 7, 7],
      ['[url "git@github.com:"]', 0, 9, 9],
      ["insteadOf", 1, 9, 9],
    ]);
    const document = gitConfigLanguage.parseDocument(CONFIGURATION);
    expect(
      document.definitions.get('remote "origin"')?.map((d) => d.startOffset),
    ).toEqual([CONFIGURATION.indexOf('[remote "origin"]')]);
    expect(document.definitions.get("url")?.map((d) => d.startLine))
      .toEqual([5]);
  });

  it("ends a line before the carriage return of a CRLF line break", () => {
    const source = '[a]\r\nk = v ; c\r\nm = "w\\\r\nx"\r\nn\r';
    const document = gitConfigLanguage.parseDocument(source);

    expect(classesOf(document.lines, "v")).toEqual(["string"]);
    expect(classesOf(document.lines, "; c")).toEqual(["comment"]);
    expect(classesOf(document.lines, 'x"')).toEqual(["string"]);
    // Git ends a line at a carriage return only before a line feed, so a
    // carriage return after a name is not white space it accepts there.
    expect(classesOf(document.lines, "n")).toEqual(["plain"]);
    expect(outline(source)).toEqual([
      ["[a]", 0, 0, 3],
      ["k", 1, 1, 1],
      ["m", 1, 2, 3],
    ]);
    expect(verbatim(document.lines)).toBe(source);
  });

  it("ends an unclosed subsection, header, or quoted value at the end of its line", () => {
    const source = '[submodule "vendor/sp\n[core\nk = "open\nn = 1';
    const lines = gitConfigLanguage.highlightLines(source);

    expect(classesOf(lines, '"vendor/sp')).toEqual(["string"]);
    expect(classesOf(lines, "core")).toEqual(["interfaceName"]);
    expect(classesOf(lines, '"open')).toEqual(["string"]);
    expect(classesOf(lines, "n")).toEqual(["propertyName"]);
    expect(outline(source).map(([label]) => label)).toEqual(["n"]);
  });

  it("reconstructs incomplete input exactly", () => {
    for (
      const source of [
        "[",
        "[]",
        '["',
        '[a "\\',
        '[a "b" c] d',
        "=value",
        "a = \\",
        "a = x\\",
        'a = "\\',
        "k=☕ 😀",
        "",
        "\n\n",
      ]
    ) {
      expect(verbatim(gitConfigLanguage.parseDocument(source).lines))
        .toBe(source);
    }
    expect(outline("=value")).toEqual([]);
    expect(classesOf(gitConfigLanguage.highlightLines("=value"), "=value"))
      .toEqual(["plain"]);
  });

  it("recolors each edit", () => {
    const highlighter = gitConfigLanguage.createHighlighter("a=1");
    expect(highlighter.update("a=1")).toBe(highlighter.lines);
    expect(classesOf(highlighter.update("[a]"), "a")).toEqual([
      "interfaceName",
    ]);
  });
});
