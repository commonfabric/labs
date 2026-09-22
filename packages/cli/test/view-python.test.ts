/**
 * Python highlighting and structure for direct files, diffs, and live edits.
 * The grammar is loaded once for the whole file, which is what the pager does
 * before it parses anything.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { languageForFile } from "../lib/view/languages/language.ts";
import { pythonLanguage } from "../lib/view/languages/python/language.ts";
import type { Line, TokenClass } from "../lib/view/model.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { createDiffHighlighter, diffSource } from "../lib/view/diffedit.ts";

await pythonLanguage.prepare!();

function highlight(source: string): Line[] {
  return pythonLanguage.highlightLines(source);
}

function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

function classesOf(lines: readonly Line[], text: string): Set<TokenClass> {
  const classes = new Set<TokenClass>();
  for (const line of lines) {
    for (const span of line.spans) {
      if (span.text === text) classes.add(span.cls);
    }
  }
  return classes;
}

function classOnLine(
  lines: readonly Line[],
  lineText: string,
  token: string,
): TokenClass | undefined {
  return lines.find((line) => line.text === lineText)?.spans.find((span) =>
    span.text === token
  )?.cls;
}

function tempWorkspace(root: string): DiffWorkspace {
  return {
    resolve: (path) => join(root, path),
    read: (path) => {
      try {
        return Deno.readTextFileSync(path);
      } catch {
        return null;
      }
    },
  };
}

Deno.test("python: metadata selects source, stub, and windowed files", () => {
  for (const path of ["main.py", "types.pyi", "app.pyw", "/tmp/UPPER.PY"]) {
    assertEquals(languageForFile(path).id, "python", path);
  }
  for (const path of ["module.pyc", "archive.pyz", "notes.md", undefined]) {
    assert(
      languageForFile(path).id !== "python",
      `${String(path)} selected Python`,
    );
  }
});

Deno.test("python: the language registry selects Python extensions", () => {
  const python = languageForFile("main.py");
  assertEquals(python.id, "python");
  assertEquals(languageForFile("types.pyi").id, "python");
  assertEquals(languageForFile("app.pyw").id, "python");
  assertEquals(languageForFile("main.ts").id, "typescript");
  assertEquals(languageForFile(undefined).id, "plain-text");
  assertEquals(
    verbatim(python.createHighlighter("answer = True").lines),
    "answer = True",
  );
});

Deno.test("python: declarations, keywords, calls, properties, and comments color", () => {
  const source = [
    "#!/usr/bin/env python3",
    "@decorator",
    'async def greet(name: str = "world") -> str:',
    "    if name is None or not name:",
    "        raise ValueError(name)",
    "    return name.upper()  # ready",
    "",
    "class Greeter:",
    "    pass",
  ].join("\n");
  const lines = highlight(source);

  assertEquals([...classesOf(lines, "#!/usr/bin/env python3")], ["comment"]);
  assertEquals([...classesOf(lines, "@")], ["operator"]);
  assertEquals([...classesOf(lines, "decorator")], ["callName"]);
  assertEquals([...classesOf(lines, "async")], ["keyword"]);
  assertEquals([...classesOf(lines, "def")], ["storageKeyword"]);
  assertEquals([...classesOf(lines, "greet")], ["functionName"]);
  assertEquals([...classesOf(lines, "name")], ["parameter", "identifier"]);
  assertEquals([...classesOf(lines, "str")], ["typeName"]);
  assertEquals([...classesOf(lines, "if")], ["controlKeyword"]);
  assertEquals([...classesOf(lines, "is")], ["operator"]);
  assertEquals([...classesOf(lines, "None")], ["keyword"]);
  assertEquals([...classesOf(lines, "ValueError")], ["callName"]);
  assertEquals([...classesOf(lines, "upper")], ["callName"]);
  assertEquals([...classesOf(lines, "# ready")], ["comment"]);
  assertEquals([...classesOf(lines, "class")], ["storageKeyword"]);
  assertEquals([...classesOf(lines, "Greeter")], ["interfaceName"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: current string prefixes and escapes remain single tokens", () => {
  const source = [
    String.raw`plain = "a\"b\\c"`,
    String.raw`raw = r"\w+\s"`,
    String.raw`bytes_value = br"\x00"`,
    `legacy = u"text"`,
  ].join("\n");
  const lines = highlight(source);

  assertEquals([...classesOf(lines, String.raw`"a\"b\\c"`)], ["string"]);
  assertEquals([...classesOf(lines, String.raw`r"\w+\s"`)], ["string"]);
  assertEquals([...classesOf(lines, String.raw`br"\x00"`)], ["string"]);
  assertEquals([...classesOf(lines, `u"text"`)], ["string"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: interpolated strings color their fields as code", () => {
  const source = [
    `formatted = f"{value!r}"`,
    `templated = t"{value}"`,
    `reversed_prefix = rf"{value}"`,
    `nested = f"{items["key"]}"`,
  ].join("\n");
  const lines = highlight(source);

  for (const opening of ['f"', 't"', 'rf"']) {
    assertEquals([...classesOf(lines, opening)], ["template"], opening);
  }
  assertEquals([...classesOf(lines, "{")], ["punctuation"]);
  assertEquals([...classesOf(lines, "value")], ["identifier"]);
  assertEquals([...classesOf(lines, "!r")], ["template"]);
  assertEquals([...classesOf(lines, `"key"`)], ["string"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: formatted strings accept nested same-quote expressions", () => {
  const source = [
    'value = f"{items["key"]!r:>{width}}"',
    `nested = f"{f'{value=}'}"`,
    'filled = f"{value:[<10}"',
    String.raw`escaped = f"\{items["key"]}"`,
  ].join("\n");
  const lines = highlight(source);

  assertEquals([...classesOf(lines, "items")], ["identifier"]);
  assertEquals([...classesOf(lines, `"key"`)], ["string"]);
  assertEquals([...classesOf(lines, "width")], ["identifier"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: multiline strings carry state across blank lines", () => {
  const source = [
    'message = """first',
    "",
    "second # text, not a comment",
    'third"""',
    "answer = 42",
  ].join("\n");
  const lines = highlight(source);

  assertEquals(lines[1], { text: "", spans: [] });
  assertEquals(
    [...classesOf(lines, "second # text, not a comment")],
    ["string"],
  );
  assertEquals([...classesOf(lines, "answer")], ["identifier"]);
  assertEquals([...classesOf(lines, "42")], ["number"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: CRLF backslash continuations stay inside strings", () => {
  const continuation = "\\\r\n";
  const source = `plain = "left${continuation}right"\r\n` +
    `formatted = f"{1${continuation}+ 2}"`;
  const lines = highlight(source);

  assertEquals([...classesOf(lines, 'right"')], ["string"]);
  assertEquals([...classesOf(lines, "+")], ["operator"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: formatted replacement fields can cross physical lines", () => {
  const source = [
    'value = f"{',
    "    first +  # comment",
    "    second",
    '}"',
    "answer = True",
  ].join("\n");
  const lines = highlight(source);

  assertEquals([...classesOf(lines, "first")], ["identifier"]);
  assertEquals([...classesOf(lines, "# comment")], ["comment"]);
  assertEquals([...classesOf(lines, "second")], ["identifier"]);
  assertEquals([...classesOf(lines, "True")], ["boolean"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: numeric forms and ellipsis use literal classes", () => {
  const source =
    "values = (0, 1_000, 0b_1010, 0o755, 0xCA_FE, .5, 1., 1.5e-2, 3j, ...)";
  const lines = highlight(source);

  for (
    const number of [
      "0",
      "1_000",
      "0b_1010",
      "0o755",
      "0xCA_FE",
      ".5",
      "1.",
      "1.5e-2",
      "3j",
    ]
  ) {
    assertEquals([...classesOf(lines, number)], ["number"], number);
  }
  assertEquals([...classesOf(lines, "...")], ["keyword"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: brackets retain rainbow depth and Unicode columns", () => {
  const source = 'π = call([{"😀": value}])';
  const [line] = highlight(source);
  const brackets = line.spans.filter((span) => span.cls === "bracket");

  assertEquals(
    brackets.map((span) => [span.text, span.bracketDepth]),
    [
      ["(", 0],
      ["[", 1],
      ["{", 2],
      ["}", 2],
      ["]", 1],
      [")", 0],
    ],
  );
  const value = line.spans.find((span) => span.text === "value")!;
  assertEquals(value.col, [...source.slice(0, source.indexOf("value"))].length);
  assertEquals(verbatim([line]), source);
});

Deno.test("python: soft keywords are keywords only where they open a statement", () => {
  const source = [
    "match subject:",
    "    case Point(x, y):",
    "        pass",
    "type Pair[T] = tuple[T, T]",
    "match = 1",
    "match.subject",
    "match + 1",
    "match: object",
    "match()",
    "case: int",
    "case += 1",
    "case[index] = 1",
    "type(value)",
    "type[index]",
    "value = 1; type Result = int",
    "if True: type Inline = str",
  ].join("\n");
  const lines = highlight(source);

  assertEquals(classOnLine(lines, "match subject:", "match"), "controlKeyword");
  assertEquals(
    classOnLine(lines, "    case Point(x, y):", "case"),
    "controlKeyword",
  );
  assertEquals(
    classOnLine(lines, "type Pair[T] = tuple[T, T]", "type"),
    "storageKeyword",
  );
  assertEquals(
    classOnLine(lines, "value = 1; type Result = int", "type"),
    "storageKeyword",
  );
  assertEquals(
    classOnLine(lines, "if True: type Inline = str", "type"),
    "storageKeyword",
  );
  for (
    const [lineText, token] of [
      ["match = 1", "match"],
      ["match.subject", "match"],
      ["match + 1", "match"],
      ["match: object", "match"],
      ["case: int", "case"],
      ["case += 1", "case"],
      ["case[index] = 1", "case"],
      ["type[index]", "type"],
    ] as const
  ) {
    assertEquals(classOnLine(lines, lineText, token), "identifier", lineText);
  }
  assertEquals(classOnLine(lines, "match()", "match"), "callName");
  assertEquals(classOnLine(lines, "type(value)", "type"), "callName");
  assertEquals(verbatim(lines), source);
});

Deno.test("python: soft keywords resolve across line continuations", () => {
  // What follows a soft keyword settles it, and a line continuation can put
  // that on the next physical line.
  const assignment = "match  \\\n    = lambda x: x";
  const alias = "type Alias \\\n    = int";

  assertEquals(
    classOnLine(highlight(assignment), "match  \\", "match"),
    "identifier",
  );
  assertEquals(
    classOnLine(highlight(alias), "type Alias \\", "type"),
    "storageKeyword",
  );
  assertEquals(
    classOnLine(
      highlight("match, \\\r\n    other = lambda: 1"),
      "match, \\\r",
      "match",
    ),
    "identifier",
  );
  assertEquals(
    classOnLine(
      highlight("type Alias \\\r\n    = int"),
      "type Alias \\\r",
      "type",
    ),
    "storageKeyword",
  );
  assertEquals(
    classOnLine(
      highlight("match lambda x=1: x:\n    case 1:\n        pass"),
      "match lambda x=1: x:",
      "match",
    ),
    "controlKeyword",
  );
  for (const source of [assignment, alias, "match subject"]) {
    assertEquals(verbatim(highlight(source)), source, source);
  }
});

Deno.test("python: incomplete formatted fields recover without dropping text", () => {
  const source = [
    'escaped = f"{{literal}}"',
    'line_break = f"{value',
    "next = True",
    'commented = f"""{value  # field comment',
    '}"""',
    String.raw`backslash = f"{value\}}"`,
    "lower_hex = 0xdead_beef",
    "bare = 😀",
  ].join("\n");
  const lines = highlight(source);

  assertEquals([...classesOf(lines, 'f"{{literal}}"')], ["template"]);
  assertEquals([...classesOf(lines, "# field comment")], ["comment"]);
  assertEquals([...classesOf(lines, "0xdead_beef")], ["number"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: malformed and incomplete input stays lossless", () => {
  for (
    const source of [
      "value = 'unterminated\nnext = True",
      'value = """unterminated\nstill text',
      "f'{unclosed'",
      "0x 1e+ @@@",
      "\ud800",
      "",
      " \t\f",
      "def broken(",
      "class Half:\n    def inner(self",
    ]
  ) {
    const document = pythonLanguage.parseDocument(source);
    assertEquals(verbatim(document.lines), source, JSON.stringify(source));
  }
  const unterminated = highlight('value = """unterminated\nstill text');
  assertEquals([...classesOf(unterminated, '"""')], ["string"]);
});

Deno.test("python: structure carries classes, functions, and their decorators", () => {
  const source = [
    "import sys",
    "",
    "",
    "@register",
    "class Store:",
    "    @property",
    "    def size(self) -> int:",
    "        return len(self.items)",
    "",
    "    async def load(self) -> None:",
    "        self.items = []",
    "",
    "",
    "def main() -> int:",
    "    def inner() -> None:",
    "        pass",
    "",
    "    return 0",
  ].join("\n");
  const document = pythonLanguage.parseDocument(source);

  assertEquals(
    document.flatStructure.map((node) => [
      node.kind,
      node.label,
      node.depth,
      node.startLine,
      node.endLine,
    ]),
    [
      ["class", "class Store", 0, 3, 10],
      ["method", "def size", 1, 5, 7],
      ["method", "async def load", 1, 9, 10],
      ["function", "def main", 0, 13, 17],
      ["function", "def inner", 1, 14, 15],
    ],
  );
  assertEquals(document.structure.map((node) => node.label), [
    "class Store",
    "def main",
  ]);
  assertEquals([...document.definitions.keys()], [
    "Store",
    "size",
    "load",
    "main",
    "inner",
  ]);
  const store = document.structure[0];
  assertEquals(store.startCol, 0);
  assertEquals(store.name, "Store");
  assertEquals(
    source.slice(store.nameOffset!, store.nameOffset! + 5),
    "Store",
  );
  assertEquals(store.astKinds, ["class_definition"]);
});

Deno.test("python: live file highlighting re-baselines multiline state", () => {
  const before = 'value = """first\nsecond\n"""\n';
  const after = 'value = "first"\nsecond = True\n';
  const highlighter = pythonLanguage.createHighlighter(before);

  assertEquals([...classesOf(highlighter.lines, "second")], ["string"]);
  const updated = highlighter.update(after);
  assertEquals([...classesOf(updated, "second")], ["identifier"]);
  assertEquals([...classesOf(updated, "True")], ["boolean"]);
  assertEquals(verbatim(updated), after);
});

Deno.test("python: an incremental update matches a complete re-highlight", () => {
  const source = [
    "# café ☕ and an astral 😀",
    "import sys",
    "",
    "",
    "class Store:",
    '    """Keeps items."""',
    "",
    "    def add(self, item: str) -> None:",
    "        self.items.append(item)",
    "",
    "    def size(self) -> int:",
    "        return len(self.items)",
    "",
    "",
    "def main(argv: list[str]) -> int:",
    "    store = Store()",
    "    for name in argv:",
    "        store.add(name)",
    "    return store.size()",
    "",
  ].join("\n");
  const edits: [string, string][] = [
    ["store.add(name)", "store.add(name.strip())"],
    ["def size(self)", "def size_of(self)"],
    ["    return len(self.items)", "    return len(self.items) + 1"],
    ["import sys", "import sys\nimport os"],
    ["        self.items.append(item)", ""],
    ["def main(argv: list[str]) -> int:", "def main(argv) -> int:"],
    ["    store = Store()", "    store = Store(("],
    ["# café ☕ and an astral 😀", "# café ☕ and an astral 😀 and more"],
    ['    """Keeps items."""', '    """Keeps items'],
  ];
  const highlighter = pythonLanguage.createHighlighter(source);
  let current = source;
  for (const [from, to] of edits) {
    assert(current.includes(from), `${from} is absent`);
    current = current.replace(from, to);
    const updated = highlighter.update(current);
    assertEquals(verbatim(updated), current, from);
    assertEquals(
      updated.map((line) => line.spans),
      highlight(current).map((line) => line.spans),
      from,
    );
  }
});

Deno.test("python: unavailable diff files use context for multiline strings", () => {
  const diff = [
    "diff --git a/example.py b/example.py",
    "--- a/example.py",
    "+++ b/example.py",
    "@@ -1,3 +1,3 @@",
    ' value = """',
    "-old text",
    "+new text",
    ' """',
    "",
  ].join("\n");
  const model = parseDiff(diff)!;
  const workspace: DiffWorkspace = {
    resolve: () => null,
    read: () => null,
  };
  const { doc } = buildDiffDocument(diff, model, workspace);

  assertEquals([...classesOf(doc.lines, "old text")], ["string"]);
  assertEquals([...classesOf(doc.lines, "new text")], ["string"]);
  assertEquals(verbatim(doc.lines), diff);
});

Deno.test("python: a seedless diff highlighter joins both hunk sides", () => {
  const diff = [
    "diff --git a/example.py b/example.py",
    "--- a/example.py",
    "+++ b/example.py",
    "@@ -1,3 +1,3 @@",
    ' value = """',
    "-old text",
    "+new text",
    ' """',
    "",
  ].join("\n");
  const highlighter = createDiffHighlighter(diff);

  assertEquals([...classesOf(highlighter.lines, "old text")], ["string"]);
  assertEquals([...classesOf(highlighter.lines, "new text")], ["string"]);
  assertEquals(verbatim(highlighter.lines), diff);

  const renamedHeader = diff.replace(
    "diff --git a/example.py b/example.py",
    "diff --git a/renamed.py b/renamed.py",
  );
  assertEquals(verbatim(highlighter.update(renamedHeader)), renamedHeader);
  assertEquals(verbatim(highlighter.update("not a diff")), "not a diff");
});

Deno.test("python: live diff edits retain complete-file multiline state", () => {
  const root = Deno.makeTempDirSync();
  try {
    const file = ['value = """', "new text", '"""', ""].join("\n");
    Deno.writeTextFileSync(join(root, "example.py"), file);
    const diff = [
      "diff --git a/example.py b/example.py",
      "--- a/example.py",
      "+++ b/example.py",
      "@@ -2 +2 @@",
      "-old text",
      "+new text",
      "",
    ].join("\n");
    const model = parseDiff(diff)!;
    const workspace = tempWorkspace(root);
    const { doc, edit } = buildDiffDocument(diff, model, workspace);
    const source = diffSource(workspace, edit);
    const highlighter = source.createHighlighter!(diff, doc.lines);

    const editedText = diff.replace("+new text", "+newer text");
    const edited = highlighter.update(editedText);
    assertEquals([...classesOf(edited, "newer text")], ["string"]);
    assertEquals(verbatim(edited), editedText);

    const reparsed = source.parse(editedText);
    assertEquals([...classesOf(reparsed.lines, "newer text")], ["string"]);
    assertEquals(verbatim(reparsed.lines), editedText);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("python: deferred diff parsing keeps old state across a rename", () => {
  const root = Deno.makeTempDirSync();
  try {
    const file = ['value = """', "new text", '"""', ""].join("\n");
    Deno.writeTextFileSync(join(root, "example.txt"), file);
    const diff = [
      "diff --git a/example.py b/example.txt",
      "--- a/example.py",
      "+++ b/example.txt",
      "@@ -2 +2 @@",
      "-old text",
      "+new text",
      "",
    ].join("\n");
    const model = parseDiff(diff)!;
    const workspace = tempWorkspace(root);
    const { doc, edit } = buildDiffDocument(diff, model, workspace);
    const source = diffSource(workspace, edit);
    const highlighter = source.createHighlighter!(diff, doc.lines);

    assertEquals([...classesOf(doc.lines, "old text")], ["string"]);
    const editedText = diff.replace("+new text", "+newer text");
    const edited = highlighter.update(editedText);
    assertEquals([...classesOf(edited, "old text")], ["string"]);

    const reparsed = source.parse(editedText);
    assertEquals([...classesOf(reparsed.lines, "old text")], ["string"]);
    assertEquals(verbatim(reparsed.lines), editedText);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("python: live edits account for line shifts across later hunks", () => {
  const root = Deno.makeTempDirSync();
  try {
    const file = [
      'value = """',
      "first",
      "middle",
      "last",
      '"""',
      "",
    ].join("\n");
    Deno.writeTextFileSync(join(root, "example.py"), file);
    const diff = [
      "diff --git a/example.py b/example.py",
      "--- a/example.py",
      "+++ b/example.py",
      "@@ -2 +2 @@",
      "-old first",
      "+first",
      "@@ -4 +4 @@",
      "-old last",
      "+last",
      "",
    ].join("\n");
    const model = parseDiff(diff)!;
    const workspace = tempWorkspace(root);
    const { doc, edit } = buildDiffDocument(diff, model, workspace);
    const highlighter = diffSource(workspace, edit).createHighlighter!(
      diff,
      doc.lines,
    );
    const edited = [
      "diff --git a/example.py b/example.py",
      "--- a/example.py",
      "+++ b/example.py",
      "@@ -2 +2,2 @@",
      "-old first",
      "+first",
      "+inserted",
      "@@ -4 +5 @@",
      "-old last",
      "+last",
      "",
    ].join("\n");
    const lines = highlighter.update(edited);

    assertEquals([...classesOf(lines, "inserted")], ["string"]);
    assertEquals([...classesOf(lines, "last")], ["string"]);
    assertEquals(verbatim(lines), edited);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
