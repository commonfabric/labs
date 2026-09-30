import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import { createSemantics } from "../lib/view/languages/typescript/semantics.ts";
import type { Semantics } from "../lib/view/languages/language.ts";
import { buildPeekCard } from "../lib/view/card.ts";
import { buildPreparedView } from "../lib/view/mod.ts";
import type { Document } from "../lib/view/model.ts";

const CWD = Deno.cwd();

function nameOffsetOf(doc: Document, name: string): number {
  const node = doc.flatStructure.find((n) => n.name === name);
  if (node?.nameOffset === undefined) {
    throw new Error(`no nameOffset for ${name}`);
  }
  return node.nameOffset;
}

/** A semantics that answers a fixed type for one offset, null elsewhere. */
function typeStub(offset: number, type: string): Semantics {
  return {
    typeAt: (o) => (o === offset ? type : null),
    definitionOf: () => [],
    fileLines: () => null,
    prewarm: () => {},
  };
}

Deno.test("semantics: infers a binding's type across sections in the blob", () => {
  // Two virtual modules; `main` imports `helpers` by its section-header path.
  const blob = `// transformed: /helpers.ts
export function double(n: number): number {
    return n * 2;
}
// transformed: /main.ts
import { double } from "/helpers.ts";
const result = double(21);`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: CWD })!;
  assert(sem, "service builds");
  assertEquals(sem.typeAt(nameOffsetOf(doc, "result")), "number");
});

Deno.test("semantics: infers a structural return type with no annotations", () => {
  // Nothing here is annotated: the type must come from real inference.
  const blob = `// transformed: /m.ts
function make() {
    return { id: 1, label: "x" };
}
const item = make();`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: CWD })!;
  const t = sem.typeAt(nameOffsetOf(doc, "item"));
  assert(t && t.includes("id: number"), `inferred object type: ${t}`);
  assert(t && t.includes("label: string"), `inferred object type: ${t}`);
});

Deno.test("semantics: maps offsets to the right section across three sections", () => {
  // Each section declares a binding of a section-unique type; a mis-mapping of
  // offset→section would surface as the wrong section's type.
  const blob = `// transformed: /a.ts
const a: { tag: "A" } = { tag: "A" };
// transformed: /b.ts
const b: { tag: "B" } = { tag: "B" };
// transformed: /c.ts
const c: { tag: "C" } = { tag: "C" };`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: CWD })!;
  const ta = sem.typeAt(nameOffsetOf(doc, "a"));
  const tb = sem.typeAt(nameOffsetOf(doc, "b"));
  const tc = sem.typeAt(nameOffsetOf(doc, "c"));
  assert(
    ta?.includes("A") && !ta.includes("B") && !ta.includes("C"),
    `a: ${ta}`,
  );
  assert(
    tb?.includes("B") && !tb.includes("A") && !tb.includes("C"),
    `b: ${tb}`,
  );
  assert(
    tc?.includes("C") && !tc.includes("A") && !tc.includes("B"),
    `c: ${tc}`,
  );
});

Deno.test("semantics: duplicate section paths stay reachable (no '#N' fragment)", () => {
  // Two sections share a header path. The de-duplicated virtual filename must
  // still be a real .ts TypeScript can load, or every binding in the second
  // copy would return null.
  const blob = `// transformed: /dup.ts
const alpha = 1;
// transformed: /dup.ts
const beta = "x";`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: CWD })!;
  assert(sem.typeAt(nameOffsetOf(doc, "alpha")) !== null, "first copy types");
  assert(
    sem.typeAt(nameOffsetOf(doc, "beta")) !== null,
    "second copy types too",
  );
});

Deno.test("semantics: resolves a bare import via the deno import map", () => {
  // A self-contained repo-like layout in a temp dir: an import map points a
  // bare specifier at a real file, and the blob imports it.
  const tmp = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(tmp, "deno.json"),
      JSON.stringify({ imports: { "ext": "./ext.ts" } }),
    );
    Deno.writeTextFileSync(
      join(tmp, "ext.ts"),
      "export function ext(): boolean { return true; }\n",
    );
    const blob = `// transformed: /main.ts
import { ext } from "ext";
const flag = ext();`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: tmp })!;
    assertEquals(sem.typeAt(nameOffsetOf(doc, "flag")), "boolean");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("semantics: resolves an import-map specifier from a subdirectory", () => {
  // The real launch model: the mapping lives in the repo-root deno.json while
  // cf view runs from a subpackage. The value must resolve against the dir that
  // declared it, not the cwd.
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ workspace: ["./sub"], imports: { ext: "./ext.ts" } }),
    );
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      "export function ext(): boolean { return true; }\n",
    );
    Deno.mkdirSync(join(root, "sub"));
    Deno.writeTextFileSync(
      join(root, "sub", "deno.json"),
      JSON.stringify({ imports: {} }),
    );
    const blob = `// transformed: /main.ts
import { ext } from "ext";
const flag = ext();`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: join(root, "sub") })!;
    assertEquals(sem.typeAt(nameOffsetOf(doc, "flag")), "boolean");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: prefix import map resolves under the mapped dir", () => {
  // `lib/` -> `./src/lib/`. A same-named decoy one directory up must not win.
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { "lib/": "./src/lib/" } }),
    );
    Deno.mkdirSync(join(root, "src", "lib"), { recursive: true });
    Deno.writeTextFileSync(
      join(root, "src", "lib", "thing.ts"),
      "export const thing: number = 1;\n",
    );
    Deno.writeTextFileSync(
      join(root, "src", "thing.ts"), // decoy one directory above the mapped dir
      'export const thing: string = "x";\n',
    );
    const blob = `// transformed: /main.ts
import { thing } from "lib/thing.ts";
const v = thing;`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    assertEquals(sem.typeAt(nameOffsetOf(doc, "v")), "number");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: JSONC import map survives '//' inside a string value", () => {
  // A comment forces the JSONC path; a value containing '//' must not corrupt
  // the parse and drop the whole import map.
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.jsonc"),
      `{\n  // workspace config\n  "name": "pkg // tool",\n  "imports": { "ext": "./ext.ts" }\n}\n`,
    );
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      "export function ext(): boolean { return true; }\n",
    );
    const blob = `// transformed: /main.ts
import { ext } from "ext";
const flag = ext();`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    assertEquals(sem.typeAt(nameOffsetOf(doc, "flag")), "boolean");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: JSONC import map survives a trailing comma", () => {
  // Deno configs are JSONC and commonly carry trailing commas, which make a
  // plain JSON.parse throw. The config must still be parsed so the import map
  // is not silently dropped and a mapped specifier still resolves.
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.jsonc"),
      `{
  // workspace config
  "imports": {
    "ext": "./ext.ts",
  },
}
`,
    );
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      "export function ext(): boolean { return true; }\n",
    );
    const blob = `// transformed: /main.ts
import { ext } from "ext";
const flag = ext();`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    assertEquals(sem.typeAt(nameOffsetOf(doc, "flag")), "boolean");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: refuses to read files outside the workspace root", () => {
  const root = Deno.makeTempDirSync(); // the "repo" (holds deno.json)
  const outside = Deno.makeTempDirSync(); // a sibling, outside the root
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: {} }),
    );
    Deno.writeTextFileSync(
      join(outside, "secret.ts"),
      "export const SECRET: number = 42;\n",
    );
    const secret = join(outside, "secret.ts");
    const blob = `// transformed: /main.ts
import { SECRET } from ${JSON.stringify(secret)};
const leaked = SECRET;`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    assertEquals(
      sem.typeAt(nameOffsetOf(doc, "leaked")),
      null,
      "a path outside the root is not read",
    );
    // Control: an absolute path INSIDE the root is allowed.
    Deno.writeTextFileSync(
      join(root, "inside.ts"),
      "export const INSIDE: number = 7;\n",
    );
    const blob2 = `// transformed: /main.ts
import { INSIDE } from ${JSON.stringify(join(root, "inside.ts"))};
const ok = INSIDE;`;
    const doc2 = parseDocument(blob2);
    const sem2 = createSemantics(blob2, { cwd: root })!;
    assertEquals(
      sem2.typeAt(nameOffsetOf(doc2, "ok")),
      "number",
      "in-root read ok",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(outside, { recursive: true });
  }
});

Deno.test("semantics: builds the program lazily, on first query", () => {
  // The dependency does not exist when the service is created. An eager build
  // would cache the missing file; a lazy one reads it after it appears.
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { ext: "./ext.ts" } }),
    );
    const blob = `// transformed: /main.ts
import { ext } from "ext";
const flag = ext();`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      "export function ext(): boolean { return true; }\n",
    );
    assertEquals(sem.typeAt(nameOffsetOf(doc, "flag")), "boolean");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: degrades to null instead of saying 'any'", () => {
  const blob = `// transformed: /m.ts
const mystery = someUndeclaredThing.field;`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: CWD })!;
  // An unresolved reference has no knowable type, so we stay silent.
  assertEquals(sem.typeAt(nameOffsetOf(doc, "mystery")), null);
  // Out-of-range offsets and empty input never throw.
  assertEquals(sem.typeAt(10_000_000), null);
  const empty = createSemantics("", { cwd: CWD });
  assert(empty, "empty input still yields a (silent) service");
  assertEquals(empty!.typeAt(0), null);
});

const SCRIPT = `#!/usr/bin/env -S deno run
const answer = 42;
console.log(answer);
`;

Deno.test("semantics: a script with no TypeScript extension answers like its .ts twin", () => {
  const binding = SCRIPT.indexOf("answer");
  const use = SCRIPT.lastIndexOf("answer");
  const twin = createSemantics(SCRIPT, { cwd: CWD, fileName: "/tmp/tool.ts" })!;
  assertEquals(twin.typeAt(binding), "42");
  assertEquals(twin.definitionOf(use).map((d) => d.blobOffset), [binding]);
  for (const fileName of ["/tmp/tool", "/tmp/deploy.prod"]) {
    const sem = createSemantics(SCRIPT, { cwd: CWD, fileName })!;
    assertEquals(sem.typeAt(binding), twin.typeAt(binding), fileName);
    assertEquals(sem.definitionOf(use), twin.definitionOf(use), fileName);
  }
});

Deno.test("semantics: an extensionless file is served only when read as TypeScript", async () => {
  const root = Deno.makeTempDirSync();
  try {
    const tool = join(root, "tool");
    const hook = join(root, "hook");
    Deno.writeTextFileSync(tool, SCRIPT);
    Deno.writeTextFileSync(
      hook,
      SCRIPT.replace("-S deno run", "bash"),
    );

    const script = await buildPreparedView(Deno.readFileSync(tool), tool);
    assertEquals(script.semantics()?.typeAt(SCRIPT.indexOf("answer")), "42");

    const shell = await buildPreparedView(Deno.readFileSync(hook), hook);
    assertEquals(shell.semantics(), undefined);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: resolves a real commonfabric type from a subdirectory", () => {
  // End-to-end against the real repo: a pattern binding in the representative
  // SAMPLE blob must type even when launched from a subpackage of the repo.
  const doc = parseDocument(SAMPLE);
  const sem = createSemantics(SAMPLE, { cwd: join(CWD, "lib", "view") })!;
  const t = sem.typeAt(nameOffsetOf(doc, "myPattern"));
  // `pattern` comes from commonfabric; a non-null type means it resolved.
  assert(t !== null, "commonfabric-derived type resolves from a subdir");
  // The card shows a tidy type, not `import("/abs/path").Name`.
  assert(!t!.includes("import("), `no import-path prefix: ${t}`);
});

Deno.test("semantics: tidies a long type to one clamped line", () => {
  const blob = `// transformed: /m.ts
const big = { aaaa: 1, bbbb: 2, cccc: 3, dddd: 4, eeee: 5, ffff: 6, gggg: 7 };`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: CWD })!;
  const t = sem.typeAt(nameOffsetOf(doc, "big"))!;
  assert(t !== null, "types the object");
  assert(!t.includes("\n"), "single line");
  assert(t.length <= 72, `clamped to one line, got ${t.length}`);
  assert(t.endsWith("…"), "marks truncation");
});

Deno.test("semantics: definitionOf resolves a cross-section reference in-blob", () => {
  const blob = `// transformed: /helpers.ts
export function double(n: number): number {
    return n * 2;
}
// transformed: /main.ts
import { double } from "/helpers.ts";
const result = double(21);`;
  const useOffset = blob.indexOf("double(21)");
  const sem = createSemantics(blob, { cwd: CWD })!;
  const inBlob = sem.definitionOf(useOffset).find((d) =>
    d.blobOffset !== undefined
  );
  assert(inBlob, "resolved an in-blob definition");
  assertEquals(inBlob!.name, "double");
  assert(
    blob.slice(inBlob!.blobOffset!).startsWith("double"),
    "blobOffset lands on the declaration name",
  );
  assert(
    inBlob!.preview.includes("function double"),
    `preview: ${inBlob!.preview}`,
  );
});

Deno.test("semantics: definitionOf picks the exact binding, not first-by-name", () => {
  // `helper` is declared in two sections; the import binds the use to /b.ts.
  const blob = `// transformed: /a.ts
export const helper = 1;
// transformed: /b.ts
export const helper = "two";
// transformed: /main.ts
import { helper } from "/b.ts";
const v = helper;`;
  const useOffset = blob.lastIndexOf("helper"); // the use in `const v = helper`
  const sem = createSemantics(blob, { cwd: CWD })!;
  const inBlob = sem.definitionOf(useOffset).find((d) =>
    d.blobOffset !== undefined
  );
  assert(inBlob, "resolved in-blob");
  const lineStart = blob.lastIndexOf("\n", inBlob!.blobOffset!) + 1;
  const declLine = blob.slice(
    lineStart,
    blob.indexOf("\n", inBlob!.blobOffset!),
  );
  assert(
    declLine.includes('"two"'),
    `points at the /b.ts binding: ${declLine}`,
  );
});

Deno.test("semantics: definitionOf resolves a definition in an external file", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { ext: "./ext.ts" } }),
    );
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      "export function ext(): boolean { return true; }\n",
    );
    const blob = `// transformed: /main.ts
import { ext } from "ext";
const flag = ext();`;
    const useOffset = blob.indexOf("ext();");
    const sem = createSemantics(blob, { cwd: root })!;
    const ext = sem.definitionOf(useOffset).find((d) =>
      d.filePath !== undefined
    );
    assert(ext, "resolved an external definition");
    assertEquals(ext!.name, "ext");
    assert(ext!.filePath!.endsWith("ext.ts"), `file path: ${ext!.filePath}`);
    assert(
      ext!.preview.includes("export function ext"),
      `preview: ${ext!.preview}`,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("card: a dependency jumps to the semantic definition, over the name index", () => {
  const blob = `// transformed: /m.ts
const alpha = 1;
const beta = 2;
const useIt = beta;`;
  const doc = parseDocument(blob);
  const node = doc.flatStructure.find((n) => n.name === "useIt")!;
  const alpha = doc.flatStructure.find((n) => n.name === "alpha")!;
  const beta = doc.flatStructure.find((n) => n.name === "beta")!;
  let askedOffset = -1;
  const stub: Semantics = {
    typeAt: () => null,
    prewarm: () => {},
    fileLines: () => null,
    definitionOf: (o) => {
      askedOffset = o;
      return [{
        name: "alpha",
        blobOffset: alpha.nameOffset!,
        line: alpha.startLine,
        preview: "const alpha = 1;",
      }];
    },
  };
  const card = buildPeekCard(doc, node, stub);
  // It asked about the use of `beta` inside `useIt`...
  assertEquals(askedOffset, blob.indexOf("beta;"));
  // ...and the dependency now jumps to the resolved node (alpha), not the
  // name-index default (beta).
  assert(
    card.targets.some((t) => t.defOffset === alpha.startOffset),
    "jumps to the semantic definition",
  );
  assert(
    !card.targets.some((t) => t.defOffset === beta.startOffset),
    "not the name-index default",
  );
});

Deno.test("card: surfaces an external definition; fileLines colors it (bounded)", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { ext: "./ext.ts" } }),
    );
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      "export function ext(): boolean {\n  return true;\n}\n",
    );
    const blob = `// transformed: /main.ts
import { ext } from "ext";
const flag = ext();`;
    const doc = parseDocument(blob);
    const node = doc.flatStructure.find((n) => n.name === "flag")!;
    const sem = createSemantics(blob, { cwd: root })!;
    const card = buildPeekCard(doc, node, sem);
    const text = card.info.map((l) => l.text).join("\n");
    assert(text.includes("DEFINED ELSEWHERE"), `external section: ${text}`);
    const ext = card.targets.find((t) => t.filePath !== undefined);
    assert(ext, "has an external target");
    assert(
      ext!.filePath!.endsWith("ext.ts"),
      `points at ext.ts: ${ext!.filePath}`,
    );
    // fileLines reads and colors the external file...
    const lines = sem.fileLines(ext!.filePath!);
    assert(lines && lines.length >= 3, "reads the file lines");
    assert(
      lines!.some((l) => l.text.includes("export function ext")),
      "carries the source",
    );
    // ...but refuses a path outside the workspace root.
    assertEquals(sem.fileLines(join(root, "..", "outside.ts")), null);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("card: an external method called by a statement is defined elsewhere", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { ext: "./ext.ts" } }),
    );
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      `export class Worker {
  run(): void {}
}
export const worker = new Worker();
`,
    );
    for (
      const [call, displayName] of [
        ["worker.run()", "run"],
        ["(worker.run)()", "run"],
        ["worker.run!()", "run"],
        ["(worker.run as () => void)()", "run"],
        ["(worker.run<string>)()", "run"],
        ['worker["run"]()', '"run"'],
        ["worker[`run`]()", '"run"'],
      ]
    ) {
      const blob = `// transformed: /main.ts
import { worker } from "ext";
${call};`;
      const doc = parseDocument(blob);
      const statement = doc.flatStructure.find((node) =>
        node.kind === "statement" && node.startLine === 2
      )!;
      const sem = createSemantics(blob, { cwd: root })!;
      const card = buildPeekCard(doc, statement, sem);
      const text = card.info
        .map((line) => line.text)
        .join("\n");
      assert(
        text.includes(`  ${displayName}  ext.ts:2`),
        `${call} lists its called method as defined elsewhere: ${text}`,
      );
      assert(
        card.targets.some((target) =>
          target.filePath?.endsWith("ext.ts") &&
          target.destLine === 1 &&
          target.destCol === 2
        ),
        `${call} has a jump target at its external declaration`,
      );
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("card: literal call keys have safe one-line display names", () => {
  const blob = `// transformed: /main.ts
const worker = {
  [""](): void {},
  [\`line one
line two\`](): void {},
  ["\\u2028"](): void {},
  ["\\u2029"](): void {},
};
[worker[""](), worker[\`line one
line two\`](), worker["\\u2028"](), worker["\\u2029"]()];
`;
  const doc = parseDocument(blob);
  const statement = doc.flatStructure.find((node) =>
    node.kind === "statement" && node.label.startsWith("[worker")
  )!;
  const sem = createSemantics(blob, { cwd: CWD })!;
  const card = buildPeekCard(doc, statement, sem);
  const text = card.info.map((line) => line.text).join("\n");
  assert(text.includes('  ""  method'), `empty key is quoted: ${text}`);
  assert(
    text.includes('  "line one\\nline two"  method'),
    `multiline key is escaped: ${text}`,
  );
  assert(
    text.includes('  "\\u2028"  method'),
    `line separator is escaped: ${text}`,
  );
  assert(
    text.includes('  "\\u2029"  method'),
    `paragraph separator is escaped: ${text}`,
  );
  for (const line of card.info) {
    assert(!line.text.includes("\n"), "card model lines remain single-line");
    assert(
      !/[\u2028\u2029]/u.test(line.text),
      "card model lines contain no Unicode line separators",
    );
    assertEquals(line.spans.map((span) => span.text).join(""), line.text);
  }
});

Deno.test("card: signed numeric method calls are defined elsewhere", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { ext: "./ext.ts" } }),
    );
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      `export const numbered = {
  [-1](): void {},
  [+1](): void {},
};
`,
    );
    const blob = `// transformed: /main.ts
import { numbered } from "ext";
[numbered[-1](), numbered[+1]()];`;
    const doc = parseDocument(blob);
    const statement = doc.flatStructure.find((node) =>
      node.kind === "statement" && node.startLine === 2
    )!;
    const sem = createSemantics(blob, { cwd: root })!;
    const card = buildPeekCard(doc, statement, sem);
    const text = card.info.map((line) => line.text).join("\n");
    assert(text.includes("  -1  ext.ts:2"), `negative key is listed: ${text}`);
    assert(text.includes("  +1  ext.ts:3"), `positive key is listed: ${text}`);
    assertEquals(
      card.targets
        .filter((target) =>
          target.filePath?.endsWith("ext.ts") &&
          /^[ ]+[+-]1[ ]+/.test(card.info[target.cardLine]?.text ?? "")
        )
        .map((target) => [target.destLine, target.destCol]),
      [[1, 2], [2, 2]],
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("card: equal method names keep distinct external jump targets", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { ext: "./ext.ts" } }),
    );
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      "export const first = { run(): void {} }; " +
        "export const second = { run(): void {} };\n",
    );
    const calls = [
      ...Array.from({ length: 40 }, () => "first.run()"),
      "second.run()",
    ].join(", ");
    const blob = `// transformed: /main.ts
import { first, second } from "ext";
${calls};`;
    const doc = parseDocument(blob);
    const statement = doc.flatStructure.find((node) =>
      node.kind === "statement" && node.startLine === 2
    )!;
    const sem = createSemantics(blob, { cwd: root })!;
    const card = buildPeekCard(doc, statement, sem, true);
    assertEquals(
      card.info
        .filter((line) => line.text.startsWith("  run  "))
        .map((line) => line.text),
      ["  run  ext.ts:1", "  run  ext.ts:1"],
    );
    const runTargets = card.targets.filter((target) =>
      target.filePath?.endsWith("ext.ts") &&
      card.info[target.cardLine]?.text.startsWith("  run  ")
    );
    assertEquals(runTargets.length, 2);
    assertEquals(runTargets.map((target) => target.destLine), [0, 0]);
    assertEquals(
      new Set(runTargets.map((target) => target.destCol)).size,
      2,
      "same-line method declarations retain distinct destination columns",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("card: collapsed definition lookup is bounded and expandable", () => {
  const calls = Array.from({ length: 1_000 }, () => "worker.run()").join(", ");
  const blob = `// transformed: /main.ts
${calls};`;
  const doc = parseDocument(blob);
  const statement = doc.flatStructure.find((node) =>
    node.kind === "statement" && node.startLine === 1
  )!;
  let definitionCalls = 0;
  const sem: Semantics = {
    typeAt: () => null,
    prewarm: () => {},
    fileLines: () => null,
    definitionOf: () => {
      definitionCalls++;
      return [{
        name: "run",
        filePath: "/workspace/ext.ts",
        fileOffset: 0,
        line: 0,
        col: 0,
        preview: "",
      }];
    },
  };
  const card = buildPeekCard(doc, statement, sem);
  assertEquals(
    definitionCalls,
    40,
    "the collapsed card resolves only its bounded prefix",
  );
  assert(
    card.info.some((line) => line.text.includes("961 remaining uses")),
    "the card says how much definition lookup remains",
  );
  assert(
    card.targets.some((target) => target.expand),
    "the remaining lookup can be expanded",
  );
});

Deno.test("card: a called in-document method is a dependency jump", () => {
  const blob = `// transformed: /main.ts
const worker = { render(): void {} };
worker.render();`;
  const doc = parseDocument(blob);
  const call = doc.flatStructure.find((node) =>
    node.kind === "builder" && node.startLine === 2
  )!;
  const method = doc.flatStructure.find((node) =>
    node.kind === "method" && node.label.includes("render")
  )!;
  const sem = createSemantics(blob, { cwd: CWD })!;
  const card = buildPeekCard(doc, call, sem);
  const text = card.info.map((line) => line.text).join("\n");
  assert(
    text.includes("  render  method  line 2"),
    `called method is listed as a dependency: ${text}`,
  );
  assert(
    card.targets.some((target) =>
      target.defOffset === method.startOffset && target.destLine === 1
    ),
    "called method has an in-document jump target",
  );
});

Deno.test("card: local function properties retain distinct exact destinations", () => {
  const definitionLine =
    "const worker = { first: { run: () => 1 }, second: { run: () => 2 } };";
  const blob = `// transformed: /main.ts
${definitionLine}
[worker.first.run(), worker.second.run()];`;
  const doc = parseDocument(blob);
  const statement = doc.flatStructure.find((node) =>
    node.kind === "statement" && node.startLine === 2
  )!;
  const sem = createSemantics(blob, { cwd: CWD })!;
  const card = buildPeekCard(doc, statement, sem);
  const runTargets = card.targets.filter((target) =>
    card.info[target.cardLine]?.text.startsWith("  run  ")
  );
  assertEquals(runTargets.length, 2);
  assertEquals(runTargets.map((target) => target.destLine), [1, 1]);
  assertEquals(
    runTargets.map((target) => target.destCol).sort((a, b) => a - b),
    [definitionLine.indexOf("run"), definitionLine.lastIndexOf("run")],
  );
});

Deno.test("card: exact and name-index dependencies stay in source order", () => {
  const declarations = Array.from(
    { length: 10 },
    (_, index) => `const d${index} = ${index};`,
  ).join("\n");
  const blob = `// transformed: /main.ts
const worker = { run(..._values: number[]): void {} };
${declarations}
worker.run(d0, d1, d2, d3, d4, d5, d6, d7, d8, d9);`;
  const doc = parseDocument(blob);
  const statement = doc.flatStructure.find((node) =>
    node.kind === "statement" && node.startLine === 12
  )!;
  const sem = createSemantics(blob, { cwd: CWD })!;
  const card = buildPeekCard(doc, statement, sem);
  const runLine = card.info.findIndex((line) =>
    line.text.startsWith("  run  ")
  );
  const firstArgumentLine = card.info.findIndex((line) =>
    line.text.startsWith("  d0  ")
  );
  assert(
    runLine >= 0,
    "the called method fits in the collapsed dependency list",
  );
  assert(
    runLine < firstArgumentLine,
    "the called method precedes the arguments that follow it in source",
  );
});

Deno.test("card: a dependency jumps to the exact binding across a name collision", () => {
  // `helper` is declared in two sections; /main imports it from /b.ts.
  const blob = `// transformed: /a.ts
export const helper = 1;
// transformed: /b.ts
export const helper = "two";
// transformed: /main.ts
import { helper } from "/b.ts";
const v = helper;`;
  const doc = parseDocument(blob);
  const vNode = doc.flatStructure.find((n) => n.name === "v")!;
  const helpers = doc.flatStructure
    .filter((n) => n.name === "helper")
    .sort((a, b) => a.startOffset - b.startOffset);
  const [aHelper, bHelper] = helpers;
  // Without a service, the name index points at the first `helper` (/a.ts).
  const noSem = buildPeekCard(doc, vNode);
  assert(
    noSem.targets.some((t) => t.defOffset === aHelper.startOffset),
    "name index lands on the first same-named binding",
  );
  // With the service, it lands on the binding the use actually resolves to.
  const sem = createSemantics(blob, { cwd: CWD })!;
  const withSem = buildPeekCard(doc, vNode, sem);
  assert(
    withSem.targets.some((t) => t.defOffset === bHelper.startOffset),
    "semantic jump lands on the /b.ts binding",
  );
  assert(
    !withSem.targets.some((t) => t.defOffset === aHelper.startOffset),
    "and not the unrelated /a.ts binding",
  );
});

Deno.test("card: an external def sharing a name with an unrelated in-blob one is shown, not mis-jumped", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { ext: "./ext.ts" } }),
    );
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      "export function ext(): boolean { return true; }\n",
    );
    // An unrelated `/other.ts` also declares `ext`; the use in `/main.ts`
    // resolves to the imported ext.ts, not that in-blob declaration.
    const blob = `// transformed: /other.ts
export const ext = 99;
// transformed: /main.ts
import { ext } from "ext";
const flag = ext();`;
    const doc = parseDocument(blob);
    const flagNode = doc.flatStructure.find((n) => n.name === "flag")!;
    const otherExt = doc.flatStructure.find((n) =>
      n.name === "ext" && n.kind === "variable"
    )!;
    const sem = createSemantics(blob, { cwd: root })!;
    const card = buildPeekCard(doc, flagNode, sem);
    const text = card.info.map((l) => l.text).join("\n");
    assert(text.includes("DEFINED ELSEWHERE"), "external def is shown");
    assert(
      card.targets.some((t) => t.filePath?.endsWith("ext.ts")),
      "points at the real ext.ts",
    );
    assert(
      !card.targets.some((t) => t.defOffset === otherExt.startOffset),
      "and is not mis-jumped to the unrelated in-blob `ext`",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("card: a non-BMP char on the use line does not derail the definition jump", () => {
  // The emoji (a surrogate pair) precedes the dependency on the same line; the
  // use offset is summed in UTF-16 units, so it must still land on `double`.
  const blob = `// transformed: /helpers.ts
export function double(n: number): number {
    return n * 2;
}
// transformed: /main.ts
import { double } from "/helpers.ts";
const result = "😀" + double(21);`;
  const doc = parseDocument(blob);
  const resultNode = doc.flatStructure.find((n) => n.name === "result")!;
  const doubleNode = doc.flatStructure.find((n) => n.name === "double")!;
  const sem = createSemantics(blob, { cwd: CWD })!;
  const card = buildPeekCard(doc, resultNode, sem);
  assert(
    card.targets.some((t) => t.defOffset === doubleNode.startOffset),
    "jumps to `double` despite the emoji earlier on the line",
  );
});

Deno.test("card: builtins are not listed as defined elsewhere; in-blob is not double-listed", () => {
  const blob = `// transformed: /m.ts
const s = new Set();
const helper = 1;
const useHelper = helper + 1;`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: CWD })!;
  // `Set` resolves to lib.d.ts (outside the workspace) → no external jump.
  const sCard = buildPeekCard(
    doc,
    doc.flatStructure.find((n) => n.name === "s")!,
    sem,
  );
  assert(
    !sCard.info.map((l) => l.text).join("\n").includes("DEFINED ELSEWHERE"),
    "a builtin is not offered as a cross-file definition",
  );
  assert(!sCard.targets.some((t) => t.filePath), "no external target for Set");
  // An in-blob dependency stays under "depends on", not duplicated below.
  const useCard = buildPeekCard(
    doc,
    doc.flatStructure.find((n) => n.name === "useHelper")!,
    sem,
  );
  assert(
    !useCard.info.map((l) => l.text).join("\n").includes("DEFINED ELSEWHERE"),
    "an in-blob dependency is not double-listed",
  );
});

Deno.test("card: shows the semantic type and it supersedes the syntactic one", () => {
  // `cfg`'s syntactic type is the cast `AppConfig`; a semantic service that
  // knows better must win.
  const doc = parseDocument(`// transformed: /a.ts
const cfg = load() as AppConfig;`);
  const node = doc.flatStructure.find((n) => n.name === "cfg")!;
  const lines = buildPeekCard(
    doc,
    node,
    typeStub(node.nameOffset!, "ResolvedConfig"),
  )
    .info.map((l) => l.text);
  // The `binds to` line keeps the verbatim source (`… as AppConfig`); it is the
  // `type` line that must reflect the semantic type, superseding the syntactic.
  const typeLine = lines.find((l) => l.trimStart().startsWith("type"));
  assert(typeLine, "shows a type line");
  assert(typeLine!.includes("ResolvedConfig"), "uses the semantic type");
  assert(
    !typeLine!.includes("AppConfig"),
    "semantic type supersedes syntactic",
  );
});

Deno.test("card: builder, pattern and object bindings all show an inferred type", () => {
  // The inferred-type line is not limited to plain variables — builder/pattern
  // call results and object bindings (the dominant content of real blobs) get
  // it too.
  const doc = parseDocument(`// transformed: /a.ts
const counter = lift(() => 1);
const P = pattern(() => ({ ok: true }));
const obj = { a: 1, b: "x" };`);
  const cases: Array<[string, string, string]> = [
    ["counter", "builder", "Cell<number>"],
    ["P", "pattern", "PatternFactory<void>"],
    ["obj", "object", "{ a: number; b: string }"],
  ];
  for (const [name, kind, type] of cases) {
    const node = doc.flatStructure.find((n) => n.name === name)!;
    assertEquals(node.kind, kind, `${name} is a ${kind} node`);
    assert(node.nameOffset !== undefined, `${name} carries a nameOffset`);
    const lines = buildPeekCard(doc, node, typeStub(node.nameOffset!, type))
      .info.map((l) => l.text);
    const typeLine = lines.find((l) => l.trimStart().startsWith("type"));
    assert(
      typeLine?.includes(type),
      `${name} (${kind}) shows its inferred type, got: ${typeLine}`,
    );
  }
});

Deno.test("card: falls back to the syntactic type without a service", () => {
  const doc = parseDocument(`// transformed: /a.ts
const cfg = load() as AppConfig;`);
  const node = doc.flatStructure.find((n) => n.name === "cfg")!;
  const text = buildPeekCard(doc, node).info.map((l) => l.text).join("\n");
  assert(
    text.includes("type") && text.includes("AppConfig"),
    "syntactic fallback",
  );
});
