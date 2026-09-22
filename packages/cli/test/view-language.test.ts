/**
 * Language selection: declarative metadata covers filenames, aliases, and
 * shebangs, with plain text when none match. Transformed compiler output selects
 * TypeScript through a separate path. `distinctLanguages` dedupes the languages
 * a diff touches, and `diffSemanticsFor` composes the diff view's semantic layer
 * from the languages present, scoped to each one's files.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import {
  _internal as languageInternals,
  decodeLanguageInput,
  diffSemanticsFor,
  distinctLanguages,
  indexLanguagesByName,
  languageForFile,
  languageForName,
  languageForSource,
  languageForTransformedOutput,
  languageIds,
  type LanguageMetadata,
  languageNames,
  metadataMatchesFilename,
  metadataMatchesSharedExtension,
  renderedLinesFor,
} from "../lib/view/languages/language.ts";
import { type LanguageDecoder } from "../lib/view/languages/decoder.ts";
import { typeScriptLanguage } from "../lib/view/languages/typescript/language.ts";
import { markdownLanguage } from "../lib/view/languages/markdown/language.ts";
import {
  jsonLanguage,
  jsonLinesLanguage,
} from "../lib/view/languages/json/language.ts";
import { yamlLanguage } from "../lib/view/languages/yaml/language.ts";
import { pythonLanguage } from "../lib/view/languages/python/language.ts";
import { binaryLanguage } from "../lib/view/languages/binary/language.ts";
import { plainTextLanguage } from "../lib/view/languages/plain-text/language.ts";
import {
  buildDiffDocument,
  type DiffMaps,
  type DiffWorkspace,
} from "../lib/view/diffdoc.ts";
import { parseDiff } from "../lib/view/diff.ts";
import type { Line } from "../lib/view/model.ts";

Deno.test("languageForFile: named files resolve and missing names use plain text", () => {
  for (const ts of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx"]) {
    assertEquals(languageForFile(ts).id, "typescript", ts);
  }
  for (const name of ["a.mtsx", "a.ctsx", "a.mjsx", "a.cjsx"]) {
    assertEquals(languageForFile(name).id, "plain-text", name);
  }
  assertEquals(languageForFile("README.md").id, "markdown");
  assertEquals(languageForFile("deno.jsonc").id, "json");
  assertEquals(languageForFile("workflow.yml").id, "yaml");
  assertEquals(languageForFile("script.py").id, "python");
  expect(languageForFile("asset.png").id).toBe("binary");
  expect(languageForFile("payload.bin").id).toBe("binary");
  assertEquals(languageForFile("notes.xyz").id, "plain-text");
  assertEquals(languageForFile("LICENSE").id, "plain-text");
  assertEquals(languageForFile(undefined).id, "plain-text");
  assertEquals(languageForTransformedOutput().id, "typescript");
});

Deno.test("language metadata matches extensions, exact names, and compound patterns", () => {
  const metadata: LanguageMetadata = {
    extensions: [".demo"],
    filenames: ["BUILD"],
    filenamePatterns: [/^Dockerfile\..+$/i],
    aliases: ["example"],
    interpreters: ["example-runner"],
    sharedExtensions: [{ extension: ".shared", content: /^demo:/ }],
  };

  assert(metadataMatchesFilename(metadata, "/repo/source.DEMO"));
  assert(metadataMatchesFilename(metadata, "/repo/BUILD"));
  assert(metadataMatchesFilename(metadata, "containers/Dockerfile.x86_64"));
  assert(metadataMatchesFilename(metadata, "containers/DOCKERFILE.debug"));
  assert(!metadataMatchesFilename(metadata, "/repo/build"));
  assert(!metadataMatchesFilename(metadata, "/repo/demo"));
  assert(!metadataMatchesFilename(metadata, undefined));
});

Deno.test("language metadata claims a shared extension only with its evidence", () => {
  const metadata: LanguageMetadata = {
    extensions: [],
    filenames: [],
    filenamePatterns: [],
    aliases: [],
    interpreters: [],
    sharedExtensions: [{ extension: ".shared", content: /^demo:/ }],
  };

  assert(!metadataMatchesFilename(metadata, "/repo/source.shared"));
  assert(
    metadataMatchesSharedExtension(metadata, "/repo/source.shared", "demo:"),
  );
  assert(
    metadataMatchesSharedExtension(metadata, "/repo/source.SHARED", "demo:"),
  );
  assert(
    !metadataMatchesSharedExtension(metadata, "/repo/source.shared", "other"),
  );
  assert(
    !metadataMatchesSharedExtension(metadata, "/repo/source.other", "demo:"),
  );
  assert(!metadataMatchesSharedExtension(metadata, undefined, "demo:"));
});

Deno.test("languageForFile: named JavaScript uses the TypeScript-family parser", () => {
  const source = "export const answer = 42;\n";
  const doc = languageForFile("answer.js").parseDocument(source, "answer.js");
  assertEquals(doc.text, source);
  assert(doc.lines[0].spans.some((span) => span.cls === "storageKeyword"));
});

Deno.test("languageForName: identifiers and aliases resolve explicit overrides", () => {
  assertEquals(languageForName("typescript"), typeScriptLanguage);
  assertEquals(languageForName("js"), typeScriptLanguage);
  assertEquals(languageForName("markdown"), markdownLanguage);
  assertEquals(languageForName("md"), markdownLanguage);
  assertEquals(languageForName("json"), jsonLanguage);
  assertEquals(languageForName("jsonc"), jsonLanguage);
  assertEquals(languageForName("json-lines"), jsonLinesLanguage);
  assertEquals(languageForName("jsonl"), jsonLinesLanguage);
  assertEquals(languageForName("ndjson"), jsonLinesLanguage);
  assertEquals(languageForName("yaml"), yamlLanguage);
  assertEquals(languageForName("yml"), yamlLanguage);
  assertEquals(languageForName("python"), pythonLanguage);
  assertEquals(languageForName("py"), pythonLanguage);
  expect(languageForName("binary")).toBe(binaryLanguage);
  expect(languageForName("bytes")).toBe(binaryLanguage);
  assertEquals(languageForName("plain-text"), plainTextLanguage);
  assertEquals(languageForName("plaintext"), plainTextLanguage);
  assertEquals(languageForName("TypeScript"), undefined);
  assertEquals(languageForName("ruby"), undefined);
  expect(languageIds()).toEqual([
    "typescript",
    "markdown",
    "json",
    "json-lines",
    "yaml",
    "python",
    "binary",
    "plain-text",
  ]);
  expect(languageNames()).toEqual([
    "typescript",
    "ts",
    "javascript",
    "js",
    "markdown",
    "md",
    "json",
    "jsonc",
    "json-lines",
    "jsonl",
    "ndjson",
    "yaml",
    "yml",
    "python",
    "py",
    "binary",
    "bytes",
    "plain-text",
    "text",
    "plaintext",
  ]);
});

describe("language byte decoding", () => {
  it("selects binary bytes before implicit text", () => {
    const encode = (text: string) => new TextEncoder().encode(text);

    expect(
      decodeLanguageInput("asset.png", encode("printable")).language,
    ).toBe(binaryLanguage);
    expect(
      decodeLanguageInput(
        "source.ts",
        new Uint8Array([0x61, 0x00, 0x62]),
      ).language,
    ).toBe(binaryLanguage);
    expect(
      decodeLanguageInput("notes.txt", new Uint8Array([0xff, 0xfe])).language,
    ).toBe(binaryLanguage);
    expect(
      decodeLanguageInput("source.ts", encode("const x = 1;")).language,
    ).toBe(typeScriptLanguage);
    expect(
      decodeLanguageInput(
        undefined,
        encode("#!/usr/bin/env python3\nprint('ok')\n"),
      ).language,
    ).toBe(pythonLanguage);
  });

  it("uses the byte-language fallback after a decoder failure", () => {
    const bytes = new TextEncoder().encode("valid UTF-8");
    const rejectedDecoder: LanguageDecoder = {
      ...plainTextLanguage.input.decoder,
      decode: () => {
        throw new TypeError("selected decoder rejected input");
      },
    };
    const selectedLanguage = {
      ...plainTextLanguage,
      id: "selected-text",
      input: { kind: "text", decoder: rejectedDecoder } as const,
    };
    const byteFallback = { ...binaryLanguage, id: "byte-fallback" };

    const decoded = languageInternals.decodeTextInput(
      "source.ts",
      typeScriptLanguage,
      bytes,
      byteFallback,
    );
    expect(decoded.language).toBe(typeScriptLanguage);
    expect(decoded.source.text).toBe("valid UTF-8");
    expect(decoded.source.encode(decoded.source.text)).toEqual(bytes);

    const fallback = languageInternals.decodeTextInput(
      "source.selected",
      selectedLanguage,
      bytes,
      byteFallback,
    );
    expect(fallback.language).toBe(byteFallback);
    expect(fallback.source.encode(fallback.source.text)).toEqual(bytes);

    expect(() =>
      languageInternals.decodeTextInput(
        "source.selected",
        selectedLanguage,
        bytes,
        undefined,
      )
    ).toThrow(
      "No byte language available",
    );
  });
});

Deno.test("language names reject ambiguous identifiers and aliases", () => {
  const collidingLanguage = {
    ...markdownLanguage,
    id: "other-markdown",
    metadata: {
      ...markdownLanguage.metadata,
      aliases: ["typescript"],
    },
  };
  assertThrows(
    () =>
      indexLanguagesByName([
        typeScriptLanguage,
        collidingLanguage,
      ]),
    Error,
    'Language name "typescript" belongs to both typescript and other-markdown',
  );
});

Deno.test("languageForSource: filenames precede direct and env shebangs", () => {
  assertEquals(
    languageForSource(
      "tool",
      "#!/usr/bin/python3.12\nprint('selected from a direct shebang')\n",
    ),
    pythonLanguage,
  );
  assertEquals(
    languageForSource(
      undefined,
      "#!/usr/bin/env -S deno run --allow-read\nconsole.log('deno');\n",
    ),
    typeScriptLanguage,
  );
  for (
    const shebang of [
      '#!/usr/bin/python3 "unterminated',
      "#!/usr/bin/python3 trailing\\",
    ]
  ) {
    assertEquals(
      languageForSource("tool", `${shebang}\n`),
      pythonLanguage,
      shebang,
    );
  }
  assertEquals(
    languageForSource(
      "tool",
      "#!/usr/bin/env -u PYTHONPATH python3\nprint('env options');\n",
    ),
    pythonLanguage,
  );
  for (
    const shebang of [
      "#!/usr/bin/env -v CF_VIEW_REVIEW=1 python3",
      "#!/usr/bin/env -- CF_VIEW_REVIEW=1 python3",
      "#!/usr/bin/env --unset PYTHONPATH python3",
      "#!/usr/bin/env -iu PYTHONPATH python3",
      "#!/usr/bin/env -iP /usr/bin python3",
      "#!/usr/bin/env -iC /tmp python3",
      "#!/usr/bin/env -iuPYTHONPATH python3",
      "#!/usr/bin/env -S CF_VIEW_REVIEW=1 python3 -u",
      '#!/usr/bin/env -S CF_VIEW_REVIEW="quoted value" python3 -u',
      "#!/usr/bin/env -S -u PYTHONPATH python3",
      "#!/usr/bin/env -S -iu PYTHONPATH python3",
      "#!/usr/bin/env -S -iP /usr/bin python3",
      "#!/usr/bin/env -S -iC /tmp python3",
      "#!/usr/bin/env -S -iuPYTHONPATH python3",
      "#!/usr/bin/env -S -- python3",
      "#!/usr/bin/env -S -- CF_VIEW_REVIEW=1 python3",
      "#!/usr/bin/env -S -S python3",
      '#!/usr/bin/env -S -S "" python3',
      '#!/usr/bin/env -S -S "-u" PYTHONPATH python3',
      '#!/usr/bin/env -S -S "--" CF_VIEW_REVIEW=1 python3',
      '#!/usr/bin/env -S -S "python3 -u"',
      '#!/usr/bin/env -S -S "CF_VIEW_REVIEW=1" python3',
      '#!/usr/bin/env -S --split-string "python3 -u"',
      "#!/usr/bin/env -S --split-string=python3",
      '#!/usr/bin/env -S --split-string="python3 -u"',
      '#!/usr/bin/env -S --split-string="CF_VIEW_REVIEW=1" python3',
      "#!/usr/bin/env -S -vS python3",
      "#!/usr/bin/env -S -vSpython3",
      '#!/usr/bin/env -S -vS"python3 -u"',
      "#!/usr/bin/env -S -S#ignored python3",
      "#!/usr/bin/env -S --split-string=#ignored python3",
      "#!/usr/bin/env -S CF=has\\\\backslash python3",
      '#!/usr/bin/env -S "CF=has\\$dollar" python3',
      "#!/usr/bin/env -S 'CF=has\\ttext' python3",
      "#!/usr/bin/env -S CF=one\\ two python3",
      "#!/usr/bin/env -S CF=one\\\ttwo python3",
      '#!/usr/bin/env -S "CF=one\\ two" python3',
      "#!/usr/bin/env -S CF=one\\_python3",
      '#!/usr/bin/env -S "CF=one\\_two" python3',
      "#!/usr/bin/env -S ${CF_VIEW_BIN}/python3",
      '#!/usr/bin/env -S "${CF_VIEW_BIN}/python3"',
      "#!/usr/bin/env -S '$CF_VIEW_BIN/python3'",
      "#!/usr/bin/env -S python3\\c ignored",
      "#!/usr/bin/env -S python3 # ignored",
      "#!/usr/bin/env --split-string python3 -u",
      "#!/usr/bin/env --split-string=CF_VIEW_REVIEW=1 python3 -u",
      "#!/usr/bin/env -vS python3 -S",
      "#!/usr/bin/env -vSpython3 -S",
      "#!/usr/bin/env python3 --split-string=node",
    ]
  ) {
    assertEquals(
      languageForSource("tool", `${shebang}\nprint('env split string');\n`),
      pythonLanguage,
      shebang,
    );
  }
  const deeplyNestedSplit = "--split-string=".repeat(20_000);
  for (const command of ["python3", "${CF_VIEW_BIN}/python3"]) {
    assertEquals(
      languageForSource(
        "tool",
        `#!/usr/bin/env -S ${deeplyNestedSplit}${command}\n`,
      ),
      pythonLanguage,
    );
  }
  for (const interpreter of ["deno", "node", "nodejs", "bun"]) {
    assertEquals(
      languageForSource(
        "tool",
        `#!/usr/bin/env ${interpreter}\nconsole.log('selected');\n`,
      ),
      typeScriptLanguage,
      interpreter,
    );
  }
  assertEquals(
    languageForSource(
      "notes.md",
      "#!/usr/bin/env python3\n# Markdown filename wins\n",
    ),
    markdownLanguage,
  );
  assertEquals(
    languageForSource(
      "notes.txt",
      "#!/usr/bin/env python3\nprint('plain-text filename wins');\n",
    ),
    plainTextLanguage,
  );
  assertEquals(
    languageForSource(
      "LICENSE",
      "#!/usr/bin/env python3\nprint('exact filename wins');\n",
    ),
    plainTextLanguage,
  );
  assertEquals(
    languageForSource("tool", "#!/usr/bin/env bash\necho plain\n"),
    plainTextLanguage,
  );
});

Deno.test("languageForSource: a launcher shebang is claimed by its subcommand", () => {
  for (
    const shebang of [
      "#!/usr/bin/env -S uv run --script",
      "#!/usr/bin/env -S uv run",
      "#!/usr/bin/env -S uv run --with rich python",
      "#!/usr/bin/env uv run --script",
      "#!/usr/bin/uv run --script",
      "#!/opt/homebrew/bin/uv run",
    ]
  ) {
    assertEquals(
      languageForSource("tool", `${shebang}\nprint('inline script')\n`),
      pythonLanguage,
      shebang,
    );
  }
  for (
    const shebang of [
      "#!/usr/bin/env -S uv",
      "#!/usr/bin/env -S uv tool run ruff",
      "#!/usr/bin/env -S uv pip install",
      "#!/usr/bin/env -S uvx ruff",
    ]
  ) {
    assertEquals(
      languageForSource("tool", `${shebang}\nnot python\n`),
      plainTextLanguage,
      shebang,
    );
  }
});

Deno.test("languageForSource: malformed and option-only shebangs fall back safely", () => {
  assertEquals(languageForSource("tool", "#!   \n"), plainTextLanguage);
  assertEquals(
    languageForSource("tool", "#!/usr/bin/env -- python3\n"),
    pythonLanguage,
  );
  assertEquals(
    languageForSource("tool", "#!/usr/bin/env --\n"),
    plainTextLanguage,
  );
  assertEquals(
    languageForSource("tool", "#!/usr/bin/env\n"),
    plainTextLanguage,
  );
  assertEquals(
    languageForSource("tool", "#!/usr/bin/env -S\n"),
    plainTextLanguage,
  );
  assertEquals(
    languageForSource("tool", "#!/usr/bin/env -S --\n"),
    plainTextLanguage,
  );
  assertEquals(
    languageForSource("tool", "#!/usr/bin/env -u PATH\n"),
    plainTextLanguage,
  );
  for (
    const shebang of [
      '#!/usr/bin/env python3 "unterminated',
      "#!/usr/bin/env python3 argument\\",
    ]
  ) {
    assertEquals(
      languageForSource("tool", `${shebang}\n`),
      pythonLanguage,
      shebang,
    );
  }
  for (
    const shebang of [
      '#!/usr/bin/env "python3"',
      "#!/usr/bin/env py\\thon3",
      "#!/usr/bin/env python3\\x",
      '#!/usr/bin/env "python3\\x"',
      "#!/usr/bin/env python3\\",
      '#!/usr/bin/env "python3',
      "#!/usr/bin/env 'python3",
      '#!/usr/bin/env -S "python3',
      "#!/usr/bin/env -S -u",
      "#!/usr/bin/env -S -S",
      "#!/usr/bin/env -S -vS",
      "#!/usr/bin/env -S -S '\"python3'",
      "#!/usr/bin/env -S py\\thon3",
      '#!/usr/bin/env -S "py\\thon3"',
      "#!/usr/bin/env -S python3\\x",
      '#!/usr/bin/env -S "python3\\c"',
      "#!/usr/bin/env -S # python3",
      "#!/usr/bin/env -S -S#/usr/bin/python3",
      "#!/usr/bin/env -S --split-string=#/usr/bin/python3",
      "#!/usr/bin/env -S $CF_VIEW_BIN/python3",
      "#!/usr/bin/env -S $*/python3",
      "#!/usr/bin/env -S ${}/python3",
      "#!/usr/bin/env -S ${1}/python3",
      "#!/usr/bin/env -S ${A-B}/python3",
      "#!/usr/bin/env -S ${CF_VIEW_BIN/python3",
      '#!/usr/bin/env -S "$CF_VIEW_BIN/python3"',
      "#!/usr/bin/env CF_VIEW_REVIEW=1 -S python3",
      "#!/usr/bin/env -S CF_VIEW_REVIEW=1 -S python3",
      '#!/usr/bin/env -S -S "CF_VIEW_REVIEW=1" -S python3',
    ]
  ) {
    assertEquals(
      languageForSource("tool", `${shebang}\n`),
      plainTextLanguage,
      shebang,
    );
  }
});

Deno.test("distinctLanguages: dedupes in first-seen order", () => {
  const languages = distinctLanguages([
    "a.ts",
    "b.ts",
    "c.md",
    "d.json",
    "events.jsonl",
    "e.yaml",
    "f.py",
    "image.png",
    "LICENSE",
    undefined,
  ]);
  expect(languages.map((l) => l.id)).toEqual(
    [
      "typescript",
      "markdown",
      "json",
      "json-lines",
      "yaml",
      "python",
      "binary",
      "plain-text",
    ],
  );
});

Deno.test("renderedLinesFor rejects a renderer that changes line topology", () => {
  assertEquals(
    renderedLinesFor(plainTextLanguage, "plain", "notes.txt"),
    undefined,
  );
  assertThrows(
    () =>
      renderedLinesFor(
        {
          ...markdownLanguage,
          id: "malformed",
          renderLines: () => [],
        },
        "first\nsecond",
        "notes.md",
      ),
    Error,
    "malformed rendered 0 lines for 2 source lines",
  );
});

Deno.test("renderedLinesFor rejects malformed display lines", () => {
  const malformed = (renderLines: () => Line[]) => ({
    ...markdownLanguage,
    id: "malformed",
    renderLines,
  });
  assertThrows(
    () =>
      renderedLinesFor(
        malformed(() => [{
          text: "first\nsecond",
          spans: [{ col: 0, text: "first\nsecond", cls: "plain" }],
        }]),
        "source",
      ),
    Error,
    "malformed rendered a line break inside display line 1",
  );
  assertThrows(
    () =>
      renderedLinesFor(
        malformed(() => [{
          text: "visible",
          spans: [{ col: 0, text: "different", cls: "plain" }],
        }]),
        "source",
      ),
    Error,
    "malformed rendered spans that do not reconstruct display line 1",
  );
});

const FILE_TEXT = `export function double(n: number): number {
    return n * 2;
}
export const answer = double(21);
`;

const DIFF = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,4 +1,4 @@ export function double
 export function double(n: number): number {
     return n * 2;
 }
-export const answer = 42;
+export const answer = double(21);
`;

function tempWorkspace(): {
  root: string;
  ws: DiffWorkspace;
  done: () => void;
} {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(root, "deno.json"), "{}");
  Deno.writeTextFileSync(join(root, "m.ts"), FILE_TEXT);
  return {
    root,
    ws: {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    },
    done: () => Deno.removeSync(root, { recursive: true }),
  };
}

Deno.test("diffSemanticsFor: TypeScript answers over its own files in the diff", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const model = parseDiff(DIFF)!;
    const { doc, maps } = buildDiffDocument(DIFF, model, ws);

    // TypeScript offers a diff semantic layer and claims m.ts, so the service
    // builds and answers a type query against the workspace.
    const sem = diffSemanticsFor([typeScriptLanguage], DIFF, maps, {
      cwd: root,
    });
    assert(sem, "TypeScript composes a diff service");
    const answer = doc.flatStructure.find((n) => n.name === "answer")!;
    assertEquals(sem!.typeAt(answer.nameOffset!), "number");

    // Languages without a semantic layer contribute none, so a diff of only
    // those resolves to no service.
    assertEquals(
      diffSemanticsFor(
        [
          markdownLanguage,
          jsonLanguage,
          jsonLinesLanguage,
          yamlLanguage,
          pythonLanguage,
          plainTextLanguage,
        ],
        DIFF,
        maps,
        { cwd: root },
      ),
      undefined,
    );
  } finally {
    done();
  }
});

Deno.test("typeScriptLanguage exposes both semantic services", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    // The single-document service: a blob yields a (lazy) service.
    const single = typeScriptLanguage.createSemantics!(
      "const n: number = 1;",
      { cwd: root },
    );
    assert(single, "createSemantics returns a service");
    // The diff service: over the workspace file the diff names.
    const model = parseDiff(DIFF)!;
    const { maps } = buildDiffDocument(DIFF, model, ws);
    const diff = typeScriptLanguage.createDiffSemantics!(DIFF, maps, {
      cwd: root,
    });
    assert(diff, "createDiffSemantics returns a service");
  } finally {
    done();
  }
});

Deno.test("typeScriptLanguage identifies edits confined to quoted string contents", () => {
  const highlightLocally = typeScriptLanguage.highlightDiffLineEditLocally!;
  const stringLine = typeScriptLanguage.highlightLines(
    '  "AAHED",',
    "words.ts",
  )[0];
  assert(
    highlightLocally(stringLine, '  "AAHEDS",'),
    "an insertion before the unchanged closing quote stays within one string",
  );
  const contextualBefore = [
    "const value = {",
    '  label: "A", nested: [true],',
    "};",
  ].join("\n");
  const contextualAfter = contextualBefore.replace('"A"', '"A😀"');
  assertEquals(
    highlightLocally(
      typeScriptLanguage.highlightLines(contextualBefore, "object.ts")[1],
      '  label: "A😀", nested: [true],',
    ),
    typeScriptLanguage.highlightLines(contextualAfter, "object.ts")[1],
    "other token classes, bracket depths, and Unicode columns stay unchanged",
  );
  assertEquals(
    highlightLocally(stringLine, '  "AAHED\\S",'),
    null,
    "an escape change can alter how the rest of the line is tokenised",
  );
  const escapedLine = typeScriptLanguage.highlightLines(
    String.raw`const value = "a\"b";`,
    "escaped.ts",
  )[0];
  assertEquals(
    highlightLocally(
      escapedLine,
      String.raw`const value = "ax\"b";`,
    ),
    null,
    "an existing escape can interact with an adjacent edit",
  );

  const templateLine = typeScriptLanguage.highlightLines(
    "const value = `\nbefore\n`;\n",
    "template.ts",
  )[1];
  assertEquals(
    highlightLocally(templateLine, "after"),
    null,
    "template contents retain state from an earlier line",
  );
});

Deno.test("diffSemanticsFor: a language with no matching files is skipped", () => {
  // TypeScript offers a service, but the diff's only file is Markdown, so its
  // root-file set is empty and it contributes nothing.
  const maps: DiffMaps = {
    rootFiles: ["/workspace/README.md"],
    toFile: () => null,
    fromFile: () => null,
  };
  assertEquals(
    diffSemanticsFor([typeScriptLanguage], "diff", maps, { cwd: "/workspace" }),
    undefined,
  );
});
