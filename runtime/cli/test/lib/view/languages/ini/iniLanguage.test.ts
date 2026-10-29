import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  languageForFile,
  languageForSource,
} from "../../../../../lib/view/languages/language.ts";
import { iniLanguage } from "../../../../../lib/view/languages/ini/language.ts";
import type { Line, TokenClass } from "../../../../../lib/view/model.ts";

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
  return iniLanguage.parseDocument(source).flatStructure.map((node) => [
    node.label,
    node.depth,
    node.startLine,
    node.endLine,
  ]);
}

const CONFIGURATION = [
  "; Ansible settings",
  "[defaults]",
  "roles_path = roles",
  "ansible_managed = Ansible managed: {file} on %Y-%m-%d",
  "  # An indented comment",
  "",
  "[ssh_connection]",
  "ssh_args=-o ForwardAgent=yes",
  "pipelining",
].join("\n");

const INVENTORY = [
  "[all:vars]",
  'overrides={"API_URL":"https://rapids.example"}',
  "",
  "[toolshed]",
  "rapids.example ansible_user=deploy",
  'ocean ansible_host=compute.1 args="-o A=b" stray',
  "",
  "[ocean:children]",
  "ocean",
].join("\n");

describe("iniLanguage", () => {
  it("selects INI files by name, and `.cfg` files that open with a section", () => {
    expect(languageForFile("ansible/estuary-inventory.ini").id).toBe("ini");
    expect(languageForFile("PYTEST.INI").id).toBe("ini");
    expect(languageForFile("gvisor/.codespellrc").id).toBe("ini");
    expect(languageForFile(".coveragerc").id).toBe("ini");
    expect(languageForFile(".editorconfig").id).toBe("plain-text");
    expect(languageForFile("ansible/ansible.cfg").id).toBe("ini");
    expect(languageForFile("setup.cfg").id).toBe("ini");
    expect(languageForFile("tools.cfg").id).toBe("plain-text");

    expect(languageForSource("tools.cfg", CONFIGURATION).id).toBe("ini");
    expect(languageForSource("setup.cfg", "\n# tools\n[flake8]\n").id)
      .toBe("ini");
    expect(languageForSource("config.cfg", '{"a": [1]}').id).toBe("json");
    for (
      const array of [
        "[1, 2]",
        '[\n  "a"\n]',
        "[[1]]",
        "[{}]",
        "[-1]",
        "[]",
        "[true, false]",
        "[null]",
        "[ false ]",
      ]
    ) {
      expect(languageForSource("config.cfg", array).id).toBe("plain-text");
    }
    expect(languageForSource("config.cfg", "[nullable]\nkey=1").id)
      .toBe("ini");
    expect(
      languageForSource("tlaplus/LeaseOps.cfg", "\\* model\nSPECIFICATION Spec")
        .id,
    ).toBe("plain-text");
    expect(languageForSource("ini.txt", "[defaults]\n").id).toBe("plain-text");
    expect(languageForSource("a.cfg", "\f; note\r\n\f[a]\n").id).toBe("ini");
  });

  it("colors comments, sections, keys, separators, and values", () => {
    const lines = iniLanguage.highlightLines(CONFIGURATION);

    expect(classesOf(lines, "; Ansible settings")).toEqual(["comment"]);
    expect(classesOf(lines, "# An indented comment")).toEqual(["comment"]);
    expect(classesOf(lines, "[")).toEqual(["bracket"]);
    expect(classesOf(lines, "]")).toEqual(["bracket"]);
    expect(classesOf(lines, "defaults")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "roles_path")).toEqual(["propertyName"]);
    expect(classesOf(lines, "=")).toEqual(["operator"]);
    expect(classesOf(lines, "roles")).toEqual(["string"]);
    expect(classesOf(lines, "Ansible managed: {file} on %Y-%m-%d"))
      .toEqual(["string"]);
    expect(classesOf(lines, "ssh_args")).toEqual(["propertyName"]);
    expect(classesOf(lines, "-o ForwardAgent=yes")).toEqual(["string"]);
    expect(classesOf(lines, "pipelining")).toEqual(["propertyName"]);
    expect(verbatim(lines)).toBe(CONFIGURATION);
  });

  it("colors an inventory's hosts and the variables each host line sets", () => {
    const lines = iniLanguage.highlightLines(INVENTORY);

    expect(classesOf(lines, "all:vars")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "overrides")).toEqual(["propertyName"]);
    expect(classesOf(lines, '{"API_URL":"https://rapids.example"}'))
      .toEqual(["string"]);
    expect(classesOf(lines, "rapids.example")).toEqual(["propertyName"]);
    expect(classesOf(lines, "ansible_user")).toEqual(["propertyName"]);
    expect(classesOf(lines, "deploy")).toEqual(["string"]);
    expect(classesOf(lines, "ansible_host")).toEqual(["propertyName"]);
    expect(classesOf(lines, "compute.1")).toEqual(["string"]);
    expect(classesOf(lines, '"-o A=b"')).toEqual(["string"]);
    expect(classesOf(lines, "stray")).toEqual(["plain"]);
    expect(verbatim(lines)).toBe(INVENTORY);
  });

  it("ends an unclosed quoted value, a key, and a section name at the end of their line", () => {
    const source = 'host a="open\nnext = "x"\n[b\nc]\nd';
    const lines = iniLanguage.highlightLines(source);

    expect(classesOf(lines, '"open')).toEqual(["string"]);
    expect(classesOf(lines, "next")).toEqual(["propertyName"]);
    expect(classesOf(lines, '"x"')).toEqual(["string"]);
    expect(classesOf(lines, "b")).toEqual(["interfaceName"]);
    expect(classesOf(lines, "c]")).toEqual(["propertyName"]);
    expect(classesOf(lines, "d")).toEqual(["propertyName"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "host",
      "next",
      "[b]",
      "c]",
      "d",
    ]);
  });

  it("ends a key at the first `=` or `:`", () => {
    const source = "[metadata]\nname: cf\nurl = https://example.com";
    const lines = iniLanguage.highlightLines(source);

    expect(classesOf(lines, "name")).toEqual(["propertyName"]);
    expect(classesOf(lines, ":")).toEqual(["operator"]);
    expect(classesOf(lines, "cf")).toEqual(["string"]);
    expect(classesOf(lines, "https://example.com")).toEqual(["string"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "[metadata]",
      "name",
      "url",
    ]);
  });

  it("colors a host line from a `#` outside quotes to its end as a comment", () => {
    const source = [
      "host a=1 # note=x",
      "web1   # primary",
      "web2 port=22#note",
      'web3 a="x # y" #c',
    ].join("\n");
    const lines = iniLanguage.highlightLines(source);

    expect(classesOf(lines, "a")).toEqual(["propertyName"]);
    expect(classesOf(lines, "# note=x")).toEqual(["comment"]);
    expect(classesOf(lines, "# primary")).toEqual(["comment"]);
    expect(classesOf(lines, "22")).toEqual(["string"]);
    expect(classesOf(lines, "#note")).toEqual(["comment"]);
    expect(classesOf(lines, '"x # y"')).toEqual(["string"]);
    expect(classesOf(lines, "#c")).toEqual(["comment"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "host",
      "web1",
      "web2",
      "web3",
    ]);
  });

  it("reads a key that ends in `:` as a key whose value may hold `=`", () => {
    const source = "python_requires: >=3.8\nsetenv: FOO=bar\nhost:22 a=b";
    const lines = iniLanguage.highlightLines(source);

    expect(classesOf(lines, "python_requires")).toEqual(["propertyName"]);
    expect(classesOf(lines, ">=3.8")).toEqual(["string"]);
    expect(classesOf(lines, "FOO=bar")).toEqual(["string"]);
    expect(classesOf(lines, "host:22")).toEqual(["propertyName"]);
    expect(outline(source).map(([label]) => label)).toEqual([
      "python_requires",
      "setenv",
      "host:22",
    ]);
  });

  it("separates host line fields at any white space other than a line feed", () => {
    for (const space of ["\u00a0", "\v", "\r", "\u2003"]) {
      const source = `host a=1${space}b=2`;
      const lines = iniLanguage.highlightLines(source);

      expect(classesOf(lines, "b")).toEqual(["propertyName"]);
      expect(classesOf(lines, "2")).toEqual(["string"]);
      expect(verbatim(lines)).toBe(source);
    }
  });

  it("takes a line whose first word is followed by a `name=value` field as a host line", () => {
    expect(outline("[log]\nlog format=%(x)s").map(([label]) => label))
      .toEqual(["[log]", "log"]);
  });

  it("keeps white space in a key that is not an inventory host line", () => {
    const source = "key with spaces = a b=c";
    const lines = iniLanguage.highlightLines(source);

    expect(classesOf(lines, "with")).toEqual(["propertyName"]);
    expect(classesOf(lines, "spaces")).toEqual(["propertyName"]);
    expect(classesOf(lines, "a b=c")).toEqual(["string"]);
    expect(outline(source)).toEqual([["key with spaces", 0, 0, 0]]);
  });

  it("continues a value on lines indented further than its key", () => {
    const source = [
      "[pytest]",
      "markers =",
      "    browser: a browser test",
      "  [not a section]",
      "next = 1",
      "",
      "[core]",
      "\tbare = false",
      "\tfilemode = true",
    ].join("\n");
    const lines = iniLanguage.highlightLines(source);

    expect(classesOf(lines, "browser: a browser test")).toEqual(["string"]);
    expect(classesOf(lines, "[not a section]")).toEqual(["string"]);
    expect(classesOf(lines, "next")).toEqual(["propertyName"]);
    expect(classesOf(lines, "filemode")).toEqual(["propertyName"]);
    expect(outline(source)).toEqual([
      ["[pytest]", 0, 0, 4],
      ["markers", 1, 1, 3],
      ["next", 1, 4, 4],
      ["[core]", 0, 6, 8],
      ["bare", 1, 7, 7],
      ["filemode", 1, 8, 8],
    ]);
  });

  it("does not continue a value across a section header", () => {
    const lines = iniLanguage.highlightLines("[a]\n  b = 1\n[c]\n  d = 2");

    expect(classesOf(lines, "d")).toEqual(["propertyName"]);
  });

  it("lists sections and the keys and hosts in each", () => {
    expect(outline("top = 1\n" + INVENTORY)).toEqual([
      ["top", 0, 0, 0],
      ["[all:vars]", 0, 1, 2],
      ["overrides", 1, 2, 2],
      ["[toolshed]", 0, 4, 6],
      ["rapids.example", 1, 5, 5],
      ["ocean", 1, 6, 6],
      ["[ocean:children]", 0, 8, 9],
      ["ocean", 1, 9, 9],
    ]);
    const document = iniLanguage.parseDocument(INVENTORY);
    expect(document.definitions.get("toolshed")?.map((d) => d.startOffset))
      .toEqual([INVENTORY.indexOf("[toolshed]")]);
    expect(document.definitions.get("ocean")?.map((d) => d.startLine))
      .toEqual([5, 8]);
  });

  it("keeps a carriage return that no line feed follows in the last line", () => {
    const source = "[a]\nk = v\r";
    const document = iniLanguage.parseDocument(source);

    expect(document.flatStructure.map((node) => node.endOffset))
      .toEqual([source.length, source.length]);
    expect(verbatim(document.lines)).toBe(source);
  });

  it("ends lines only where the pager does, at a line feed", () => {
    const source = "[a]\r\nk = v\r\n  more\r\nn=1\rm=2";
    const document = iniLanguage.parseDocument(source);

    expect(classesOf(document.lines, "v")).toEqual(["string"]);
    expect(classesOf(document.lines, "1\rm=2")).toEqual(["string"]);
    expect(outline(source)).toEqual([
      ["[a]", 0, 0, 3],
      ["k", 1, 1, 2],
      ["n", 1, 3, 3],
    ]);
    expect(verbatim(document.lines)).toBe(source);
  });

  it("reconstructs incomplete input exactly", () => {
    for (
      const source of [
        "[",
        "[unclosed",
        "[]",
        "=value",
        "host a=",
        'host a="open',
        "host a='open",
        "k=☕ 😀",
        "",
        "\n\n",
      ]
    ) {
      expect(verbatim(iniLanguage.parseDocument(source).lines)).toBe(source);
    }
    expect(classesOf(iniLanguage.highlightLines("[unclosed"), "unclosed"))
      .toEqual(["interfaceName"]);
    expect(outline("=value")).toEqual([]);
  });

  it("recolors each edit", () => {
    const highlighter = iniLanguage.createHighlighter("a=1");
    expect(highlighter.update("a=1")).toBe(highlighter.lines);
    expect(classesOf(highlighter.update("[a]"), "a")).toEqual([
      "interfaceName",
    ]);
  });
});
