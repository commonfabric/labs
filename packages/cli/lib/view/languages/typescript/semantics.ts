/**
 * Optional semantic layer for `cf view`: a TypeScript {@link ts.LanguageService}
 * built over the transformed blob, used to answer "what type is this?" (and, in
 * later stages, "where is this defined?").
 *
 * The blob `--show-transformed` emits is a self-contained module graph: each
 * `// transformed: <path>` section is a module, and sections import one another
 * by those exact paths. Splitting the blob into one virtual file per section and
 * resolving the one external dependency (`commonfabric`, mapped to a real file
 * by the repo's deno import map) makes the whole thing type-checkable. Because we
 * check the same text we render, file offsets line up with the structure nodes —
 * no source map needed.
 *
 * Everything here is best-effort and isolated: construction is cheap (the heavy
 * program is built lazily on the first query), every query is wrapped so a
 * failure degrades to `null`, and when the blob cannot be resolved (piped from
 * outside a repo, partial output) the pager simply shows no semantic info. The
 * pure parser remains the authoritative, dependency-free path for everything
 * else.
 */

import { parse as parseJsonc } from "@std/jsonc";
import { dirname, fromFileUrl, isAbsolute, join, relative } from "@std/path";

import ts from "typescript";

import { cpLen } from "../../ansi.ts";
import type { DiffMaps } from "../../diffdoc.ts";
import type { Line } from "../../model.ts";
import type {
  DefTarget,
  Semantics,
  SemanticsOptions as Options,
} from "../language.ts";
import {
  decodeLanguageInput,
  languageForFile,
  readOnlyReasonFor,
} from "../language.ts";

interface SectionFile {
  /** Virtual file name (the section header path, or `fileName`). */
  name: string;

  /** Global offset of the section's first character in the blob. */
  start: number;

  end: number;
  text: string;
}

/**
 * Build a semantic service over `text`. Returns a service whose queries are
 * always safe to call; returns `undefined` only when even the lightweight setup
 * is impossible. The TypeScript program is not built until the first query.
 */
export function createSemantics(
  text: string,
  options: Options,
): Semantics | undefined {
  let sections: SectionFile[];
  try {
    sections = splitSections(text, options.fileName ?? "transformed.tsx");
  } catch {
    return undefined;
  }

  const { importMap, root } = safe(() => discoverConfig(options.cwd)) ??
    { importMap: {}, root: options.cwd };
  const libDir = safe(() => defaultLibDir());

  // The program is built lazily and cached (see lazyProgram). The
  // LanguageService it creates stays reachable here for definition lookups.
  let service: ts.LanguageService | undefined;
  const { build, prewarm } = lazyProgram(() => {
    const host = makeHost(sections, importMap, libDir, options.cwd, root);
    service = ts.createLanguageService(host, ts.createDocumentRegistry());
    return service.getProgram();
  });

  const sectionAt = (offset: number): SectionFile | undefined =>
    sections.find((s) => offset >= s.start && offset < s.end);
  const sectionByVfile = new Map(sections.map((s) => [s.name, s] as const));

  // Memoize resolutions and real-file reads: the info card resolves the same
  // offsets repeatedly (a symbol appears in both "depends on" and "defined
  // elsewhere"), and many external defs land in the same large file.
  const defCache = new Map<number, DefTarget[]>();
  const realFiles = new Map<string, string | undefined>();
  const readReal = (path: string): string | undefined => {
    if (realFiles.has(path)) return realFiles.get(path);
    const content = within(path, root)
      ? safe(() => readSourceFile(path))
      : undefined;
    realFiles.set(path, content);
    return content;
  };

  return {
    prewarm,
    typeAt(offset: number): string | null {
      return typeQuery(build, (o) => {
        const section = sectionAt(o);
        return section
          ? { path: section.name, offset: o - section.start }
          : null;
      }, offset);
    },
    definitionOf(offset: number): DefTarget[] {
      const cached = defCache.get(offset);
      if (cached) return cached;
      let out: DefTarget[] = [];
      try {
        const program = build();
        if (program && service) {
          const section = sectionAt(offset);
          if (section) {
            const local = offset - section.start;
            const defs = definitionsAtPosition(
              service,
              program,
              section.name,
              local,
            );
            for (const d of defs) {
              const sec = sectionByVfile.get(d.fileName);
              if (sec) {
                const blobOffset = sec.start + d.textSpan.start;
                const { line, col, preview } = lineAndPreview(text, blobOffset);
                out.push({ name: d.name, blobOffset, line, col, preview });
              } else {
                // A real file. Skip libs / anything outside the workspace —
                // jumping into lib.d.ts for `Set` is noise, not a definition.
                const content = readReal(d.fileName);
                if (content === undefined) continue;
                const at = lineAndPreview(content, d.textSpan.start);
                out.push({
                  name: d.name,
                  filePath: d.fileName,
                  fileOffset: d.textSpan.start,
                  line: at.line,
                  col: at.col,
                  preview: at.preview,
                });
              }
            }
          }
        }
      } catch {
        out = [];
      }
      defCache.set(offset, out);
      return out;
    },
    fileLines(filePath: string): readonly Line[] | null {
      try {
        const content = readReal(filePath);
        if (content === undefined) return null;
        return languageForFile(filePath).parseDocument(content, filePath).lines;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Build a semantic service for a DIFF view: the program's root files are the
 * real, current workspace files the diff names, and every query translates
 * diff-text offsets to file offsets (and back) through {@link DiffMaps}. So
 * "what type is this?" and "where is this defined?" are answered against the
 * workspace as it is now — not the old side of the diff.
 */
export function createDiffSemantics(
  diffText: string,
  maps: DiffMaps,
  options: Options,
): Semantics | undefined {
  const { importMap, root } = safe(() => discoverConfig(options.cwd)) ??
    { importMap: {}, root: options.cwd };
  const libDir = safe(() => defaultLibDir());
  const rootFiles = [...maps.rootFiles.keys()].filter((p) => within(p, root));
  if (rootFiles.length === 0) return undefined;

  let service: ts.LanguageService | undefined;
  const { build, prewarm } = lazyProgram(() => {
    const host = makeHost([], importMap, libDir, options.cwd, root, rootFiles);
    service = ts.createLanguageService(host, ts.createDocumentRegistry());
    return service.getProgram();
  });

  const defCache = new Map<number, DefTarget[]>();
  const realFiles = new Map<string, string | undefined>();
  const readReal = (path: string): string | undefined => {
    if (realFiles.has(path)) return realFiles.get(path);
    const content = within(path, root)
      ? safe(() => readSourceFile(path))
      : undefined;
    realFiles.set(path, content);
    return content;
  };

  return {
    prewarm,
    typeAt(offset: number): string | null {
      return typeQuery(build, maps.toFile, offset);
    },
    definitionOf(offset: number): DefTarget[] {
      const cached = defCache.get(offset);
      if (cached) return cached;
      let out: DefTarget[] = [];
      try {
        const program = build();
        if (program && service) {
          const at = maps.toFile(offset);
          if (at) {
            const defs = definitionsAtPosition(
              service,
              program,
              at.path,
              at.offset,
            );
            for (const d of defs) {
              // A definition on a line the diff shows maps back into the diff;
              // anything else within the workspace opens as an external file.
              const inDiff = maps.fromFile(d.fileName, d.textSpan.start);
              if (inDiff !== null) {
                const { line, col, preview } = lineAndPreview(diffText, inDiff);
                out.push({
                  name: d.name,
                  blobOffset: inDiff,
                  line,
                  col,
                  preview,
                });
                continue;
              }
              const content = readReal(d.fileName);
              if (content === undefined) continue;
              const atDef = lineAndPreview(content, d.textSpan.start);
              out.push({
                name: d.name,
                filePath: d.fileName,
                fileOffset: d.textSpan.start,
                line: atDef.line,
                col: atDef.col,
                preview: atDef.preview,
              });
            }
          }
        }
      } catch {
        out = [];
      }
      defCache.set(offset, out);
      return out;
    },
    fileLines(filePath: string): readonly Line[] | null {
      try {
        const content = readReal(filePath);
        if (content === undefined) return null;
        return languageForFile(filePath).parseDocument(content, filePath).lines;
      } catch {
        return null;
      }
    },
  };
}

interface DefinitionSite {
  readonly name: string;
  readonly fileName: string;
  readonly textSpan: ts.TextSpan;
}

function definitionsAtPosition(
  service: ts.LanguageService,
  program: ts.Program,
  fileName: string,
  offset: number,
): readonly DefinitionSite[] {
  const direct = service.getDefinitionAtPosition(fileName, offset) ?? [];
  if (direct.length > 0) return direct;
  return signedNumericElementDefinitions(program, fileName, offset);
}

/** Resolve signed numeric element keys through the receiver's property symbol. */
function signedNumericElementDefinitions(
  program: ts.Program,
  fileName: string,
  offset: number,
): DefinitionSite[] {
  const source = program.getSourceFile(fileName);
  if (!source) return [];
  let current: ts.Node | undefined = deepestNodeAt(source, offset);
  while (current && !ts.isElementAccessExpression(current)) {
    current = current.parent;
  }
  if (!current) return [];
  const argument = current.argumentExpression;
  if (
    !argument || !ts.isPrefixUnaryExpression(argument) ||
    !ts.isNumericLiteral(argument.operand) ||
    (argument.operator !== ts.SyntaxKind.PlusToken &&
      argument.operator !== ts.SyntaxKind.MinusToken)
  ) {
    return [];
  }
  const magnitude = Number(argument.operand.text);
  if (!Number.isFinite(magnitude)) return [];
  const value = argument.operator === ts.SyntaxKind.MinusToken
    ? -magnitude
    : magnitude;
  const checker = program.getTypeChecker();
  const receiver = checker.getNonNullableType(
    checker.getTypeAtLocation(current.expression),
  );
  const symbol = checker.getPropertyOfType(receiver, String(value));
  if (!symbol) return [];
  return (symbol.declarations ?? []).map((declaration) => ({
    name: symbol.getName(),
    fileName: declaration.getSourceFile().fileName,
    textSpan: {
      start: declaration.getStart(),
      length: declaration.getWidth(),
    },
  }));
}

function deepestNodeAt(source: ts.SourceFile, offset: number): ts.Node {
  let found: ts.Node = source;
  const visit = (node: ts.Node): void => {
    if (offset < node.getFullStart() || offset >= node.getEnd()) return;
    found = node;
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}

/** The cleaned type string of the node at `local` in `fileName`, or null. */
function typeStringAt(
  program: ts.Program,
  fileName: string,
  local: number,
): string | null {
  const sf = program.getSourceFile(fileName);
  if (!sf) return null;
  const node = nodeAt(sf, local);
  if (!node) return null;
  const checker = program.getTypeChecker();
  const type = checker.getTypeAtLocation(node);
  // No `UseFullyQualifiedType`: it prefixes names with `import("/abs/path")`,
  // which is noise in a one-line card. The enclosing node lets the checker
  // pick a readable name.
  const str = checker.typeToString(
    type,
    node,
    ts.TypeFormatFlags.NoTruncation,
  );
  return usefulType(str);
}

/** 0-based line and a trimmed, clamped preview of the line holding `offset`. */
function lineAndPreview(
  content: string,
  offset: number,
): { line: number; col: number; preview: string } {
  const clamped = Math.max(0, Math.min(offset, content.length));
  let line = 0;
  for (let i = 0; i < clamped; i++) if (content[i] === "\n") line++;
  const start = content.lastIndexOf("\n", clamped - 1) + 1;
  let end = content.indexOf("\n", clamped);
  if (end < 0) end = content.length;
  const preview = content.slice(start, end).trim();
  return {
    line,
    col: cpLen(content.slice(start, clamped)),
    preview: preview.length > 72 ? `${preview.slice(0, 71)}…` : preview,
  };
}

//
// section splitting
//

const HEADER = /^\/\/\s*transformed:\s*(.*)$/;

function splitSections(text: string, fallbackName: string): SectionFile[] {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  const lines = text.split("\n");
  const marks: { name: string; start: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADER);
    if (m) {
      marks.push({ name: m[1].trim() || fallbackName, start: lineStarts[i] });
    }
  }
  if (marks.length === 0) {
    return [{ name: fallbackName, start: 0, end: text.length, text }];
  }
  return marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    return {
      name: uniqueName(mark.name, marks, i),
      start: mark.start,
      end,
      text: text.slice(mark.start, end),
    };
  });
}

/** Disambiguate sections that share a header path (rare, but keep names 1:1). */
function uniqueName(
  name: string,
  marks: { name: string }[],
  index: number,
): string {
  const dupesBefore =
    marks.slice(0, index).filter((m) => m.name === marks[index].name).length;
  if (dupesBefore === 0) return name;
  // A trailing `#N` reads as a URL fragment, which TypeScript strips — the file
  // would then be unreachable. Insert the disambiguator before the extension so
  // the virtual name stays a real `.ts`/`.tsx` path.
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const dot = name.lastIndexOf(".");
  return dot > slash + 1
    ? `${name.slice(0, dot)}.${dupesBefore}${name.slice(dot)}`
    : `${name}.${dupesBefore}.ts`;
}

//
// compiler host
//

function makeHost(
  sections: SectionFile[],
  importMap: Record<string, string>,
  libDir: string | undefined,
  cwd: string,
  readRoot: string,
  /** Real on-disk files to include as program roots (the diff mode's files). */
  extraRoots: readonly string[] = [],
): ts.LanguageServiceHost {
  const sectionPaths = new Set(sections.map((s) => s.name));
  const sectionByName = new Map(sections.map((s) => [s.name, s] as const));
  const fileCache = new Map<string, string | undefined>();

  // A real-file read is allowed only within the workspace root or the bundled
  // TypeScript lib directory. The pager runs under broad `--allow-read`, so this
  // keeps a crafted blob from naming arbitrary files via its import specifiers.
  const readable = (path: string): boolean =>
    within(path, readRoot) || (libDir !== undefined && within(path, libDir));

  const readReal = (path: string): string | undefined => {
    if (fileCache.has(path)) return fileCache.get(path);
    let content: string | undefined;
    if (readable(path)) {
      try {
        content = readSourceFile(path);
      } catch {
        content = undefined;
      }
    }
    fileCache.set(path, content);
    return content;
  };
  const getText = (name: string): string | undefined => {
    const section = sectionByName.get(name);
    if (section) return section.text;
    return readReal(name);
  };

  const resolve = (spec: string, containing: string): string | undefined => {
    if (sectionPaths.has(spec)) return spec;
    const mapped = mapSpecifier(spec, importMap);
    if (mapped) return within(mapped, readRoot) ? mapped : undefined;
    let candidate: string | undefined;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      candidate = resolveRelative(join(dirname(containing), spec));
    } else if (isAbsolute(spec)) {
      candidate = resolveRelative(spec);
    }
    // Real files must sit inside the workspace; section paths resolve above.
    return candidate && within(candidate, readRoot) ? candidate : undefined;
  };

  const compilerOptions: ts.CompilerOptions = {
    // Program roots include scripts whose names carry no TypeScript extension,
    // such as a `#!/usr/bin/env -S deno run` script named `tool`, which the
    // compiler reads as TypeScript.
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    noEmit: true,
    noLib: libDir === undefined,
    strict: false,
  };

  return {
    getScriptFileNames: () => [...sections.map((s) => s.name), ...extraRoots],
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => {
      const t = getText(name);
      return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
    },
    getCurrentDirectory: () => cwd,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (opts) =>
      libDir ? join(libDir, ts.getDefaultLibFileName(opts)) : "lib.d.ts",
    fileExists: (name) => sectionPaths.has(name) || getText(name) !== undefined,
    readFile: (name) => getText(name),
    directoryExists: (dir) => {
      try {
        return Deno.statSync(dir).isDirectory;
      } catch {
        return false;
      }
    },
    getDirectories: () => [],
    resolveModuleNameLiterals: (literals, containing) =>
      literals.map((literal) => {
        const target = resolve(literal.text, containing);
        if (!target) return { resolvedModule: undefined };
        return {
          resolvedModule: {
            resolvedFileName: target,
            extension: extensionOf(target),
            isExternalLibraryImport: false,
          },
        };
      }),
  };
}

function resolveRelative(base: string): string | undefined {
  for (
    const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
    ]
  ) {
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch { /* try next */ }
  }
  return undefined;
}

function extensionOf(path: string): ts.Extension {
  if (path.endsWith(".tsx")) return ts.Extension.Tsx;
  if (path.endsWith(".d.ts")) return ts.Extension.Dts;
  if (path.endsWith(".json")) return ts.Extension.Json;
  if (path.endsWith(".jsx")) return ts.Extension.Jsx;
  if (path.endsWith(".js")) return ts.Extension.Js;
  return ts.Extension.Ts;
}

//
// import map + libs
//

/**
 * Map a specifier to a real local file via the import map. Values in `importMap`
 * are already absolute (resolved against the deno.json that declared them), so
 * resolution does not depend on where cf view was launched.
 */
function mapSpecifier(
  spec: string,
  importMap: Record<string, string>,
): string | undefined {
  const exact = importMap[spec];
  if (exact !== undefined) return resolveRelative(exact);
  // Prefix mapping: `@scope/pkg/` → directory. The mapped value is the absolute
  // directory; append the remainder after the prefix and resolve once.
  for (const key of Object.keys(importMap)) {
    if (key.endsWith("/") && spec.startsWith(key)) {
      return resolveRelative(join(importMap[key], spec.slice(key.length)));
    }
  }
  return undefined;
}

function isLocalSpecifier(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../") ||
    value.startsWith("/") || isAbsolute(value);
}

/**
 * Walk from `cwd` up to the filesystem root, merging the `imports` of every
 * deno.json(c) found; a nearer config wins. Local targets are resolved to
 * absolute paths against the directory of the config that declared them — which
 * is what Deno does, and is what makes resolution correct no matter which
 * subdirectory cf view was launched from. `root` is the topmost directory that
 * held a config, used to bound real-file reads.
 */
function discoverConfig(
  cwd: string,
): { importMap: Record<string, string>; root: string } {
  const importMap: Record<string, string> = {};
  let root = cwd;
  let dir = cwd;
  for (let depth = 0; depth < 64; depth++) {
    for (const file of ["deno.json", "deno.jsonc"]) {
      let raw: string;
      try {
        raw = Deno.readTextFileSync(join(dir, file));
      } catch {
        continue;
      }
      root = dir; // a config lives here; allow reads under the topmost one
      for (const [key, value] of Object.entries(parseImports(raw))) {
        if (key in importMap) continue; // a nearer config already set this key
        if (!isLocalSpecifier(value)) continue; // jsr:/npm:/https: → leave as any
        importMap[key] = isAbsolute(value) ? value : join(dir, value);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { importMap, root };
}

function parseImports(raw: string): Record<string, string> {
  // Deno configs are JSONC: they may carry comments and trailing commas, both
  // of which make JSON.parse throw. Parse as JSONC so a comment or a trailing
  // comma does not drop the whole import map.
  const parsed = safe(() => JSON.parse(raw)) ??
    safe(() => parseJsonc(raw));
  const imports = (parsed as { imports?: unknown } | undefined)?.imports;
  if (!imports || typeof imports !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(imports as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** True if `child` is `parent` or sits beneath it (lexically). */
function lexicallyWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * True if `child` sits beneath `parent` PHYSICALLY: the check canonicalizes
 * both sides, so an in-workspace symlink pointing outside the workspace does
 * not pass. `child` must exist (a nonexistent path cannot be read anyway).
 */
function within(child: string, parent: string): boolean {
  if (!lexicallyWithin(child, parent)) return false;
  try {
    // child resolves first; parent is always an ancestor of it, so it resolves
    // too. A throw from either (a missing path) means "not within".
    return lexicallyWithin(
      Deno.realPathSync(child),
      Deno.realPathSync(parent),
    );
  } catch {
    return false;
  }
}

function readSourceFile(path: string): string {
  const selected = languageForFile(path);
  const selectedReadOnlyReason = readOnlyReasonFor(selected);
  if (selectedReadOnlyReason !== undefined) {
    throw new TypeError(selectedReadOnlyReason);
  }
  const decoded = decodeLanguageInput(path, Deno.readFileSync(path));
  const decodedReadOnlyReason = readOnlyReasonFor(decoded.language);
  if (decodedReadOnlyReason !== undefined) {
    throw new TypeError(decodedReadOnlyReason);
  }
  return decoded.source.text;
}

/** Directory holding the bundled `lib.*.d.ts`, derived from the ts module URL. */
function defaultLibDir(): string {
  return dirname(fromFileUrl(import.meta.resolve("typescript")));
}

//
// ast helpers
//

/** The deepest node whose range contains `pos`. */
function nodeAt(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (pos >= n.getStart(sf) && pos < n.getEnd()) {
      found = n;
      n.forEachChild(visit);
    }
  };
  sf.forEachChild(visit);
  return found;
}

/**
 * Suppress useless results so the card stays silent rather than say `any`. Also
 * tidies the type for a one-line card: drops the `import("/abs/path").` prefix
 * TypeScript emits for out-of-scope symbols, collapses whitespace, and clamps
 * the length.
 */
function usefulType(str: string): string | null {
  const tidy = str
    .replace(/import\("[^"]*"\)\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (tidy === "" || tidy === "any" || tidy === "error") return null;
  return tidy.length > 72 ? `${tidy.slice(0, 71)}…` : tidy;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * A TypeScript program built lazily from `make` and cached. A `make` that throws
 * or yields no program latches `failed`, so a broken setup is not retried on
 * every keystroke. `prewarm` builds eagerly (and silently, since `build`
 * already swallows its own failure). Shared by the blob and diff factories.
 */
function lazyProgram(
  make: () => ts.Program | undefined,
): { build: () => ts.Program | undefined; prewarm: () => void } {
  let program: ts.Program | undefined;
  let failed = false;
  const build = (): ts.Program | undefined => {
    if (program) return program;
    if (failed) return undefined;
    try {
      program = make();
      if (!program) failed = true;
      return program;
    } catch {
      failed = true;
      return undefined;
    }
  };
  return { build, prewarm: () => void build() };
}

/** Read the type string at `offset`: build the program, map `offset` to a
 * (file, offset) with `locate`, and ask the program there. Null when the
 * program is unavailable, the offset does not map, or any step throws. Shared
 * by the blob and diff factories' typeAt. */
function typeQuery(
  build: () => ts.Program | undefined,
  locate: (offset: number) => { path: string; offset: number } | null,
  offset: number,
): string | null {
  try {
    const prog = build();
    if (!prog) return null;
    const at = locate(offset);
    if (!at) return null;
    return typeStringAt(prog, at.path, at.offset);
  } catch {
    return null;
  }
}

/** Internals exposed for tests only. */
export const _internal = {
  lazyProgram,
  makeHost,
  signedNumericElementDefinitions,
};
