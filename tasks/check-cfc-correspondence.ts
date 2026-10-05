#!/usr/bin/env -S deno run --allow-read --allow-run=git

/**
 * Fails when the runtime's claim about which Contextual Flow Control
 * specification it implements stops being true.
 *
 * The specification lives in the private `commonfabric/specs` repository, and
 * what this public repository commits of it is the spec snapshot at
 * `packages/runner/src/cfc/kernel/spec-snapshot.json`: the specs commit,
 * every section number, and one hash per pseudocode function. Against that
 * snapshot, and against the manifest beside it, this holds four things:
 *
 * 1. **The manifest matches the snapshot.** Every manifest row names a
 *    function the snapshot defines in the section the row says, and every
 *    function the snapshot defines in a section some row names is a row or a
 *    recorded companion. A manifest row that is `exact` or `adapted` names a
 *    kernel file that exports the function under a `@spec` header agreeing
 *    with the row and the snapshot; a `missing` row names a function the
 *    kernel does not export.
 * 2. **The kernel is pinned and pure.** Every function a file under
 *    `packages/runner/src/cfc/kernel/` exports carries a `@spec` header whose
 *    hash is the snapshot's for that function, and the file's value imports
 *    reach only other kernel files and the modules {@link KERNEL_SHARED_MODULES}
 *    names. The ledger files, {@link KERNEL_LEDGER_FILES}, are exempt from the
 *    header rule and held to the import rule.
 * 3. **Every `§` citation under `packages/runner/src/cfc/` names a section
 *    the snapshot has.** A citation written on purpose to something else is
 *    recorded in {@link EXEMPTIONS}, naming the file, the citation and why;
 *    an entry whose file no longer writes its citation is reported too.
 * 4. **`SPEC-PENDING` markers stay under budget and name their ruling.** At
 *    most {@link SPEC_PENDING_BUDGET} markers across `packages/`, each on a
 *    line naming a `commonfabric/specs` pull request.
 *
 * What it does not check: that a kernel function's body matches its block,
 * which is equivalence the hash makes reviewable and review decides; that a
 * citation names the section its comment means, since a renumbering that
 * lands on another existing section passes; and the second number of a
 * range such as `§7.3-7`, which is not written with its own `§`.
 *
 * The exemption list is in this file rather than in the sources because an
 * exemption a scanned file could state is one that file could forge.
 *
 * Usage: deno task check-cfc-correspondence
 */

import { dirname, fromFileUrl } from "@std/path";
import {
  type Companion,
  COMPANIONS,
  MANIFEST,
  type ManifestRow,
} from "@commonfabric/runner/cfc/kernel/manifest";
import {
  parseSpecHeaders,
  type SpecHeader,
} from "@commonfabric/runner/cfc/kernel/spec-header";

import { SNAPSHOT_PATH, type SpecSnapshot } from "./cfc-spec-snapshot.ts";
import { repositoryFiles } from "./repository-files.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** The kernel directory, repository-relative, with its trailing slash. */
export const KERNEL_DIR = "packages/runner/src/cfc/kernel/";

/**
 * The files under the kernel directory that are the ledger rather than kernel
 * functions: the manifest, the header format, and the snapshot. They carry no
 * `@spec` header, and are held to the import rule like any kernel file.
 */
export const KERNEL_LEDGER_FILES: ReadonlySet<string> = new Set([
  `${KERNEL_DIR}manifest.ts`,
  `${KERNEL_DIR}spec-header.ts`,
]);

/**
 * The modules a kernel file may import values from besides other kernel
 * files: the atom and label types a kernel function is written over. A type
 * import is erased before anything runs and so is allowed from anywhere; this
 * list bounds what a kernel file may execute.
 */
export const KERNEL_SHARED_MODULES: ReadonlySet<string> = new Set([
  "@commonfabric/api/cfc",
]);

/** The most `SPEC-PENDING` markers the tree may hold at once. */
export const SPEC_PENDING_BUDGET = 3;

/** The pull request a marker has to name. */
const SPECS_PULL_REQUEST =
  /https:\/\/github\.com\/commonfabric\/specs\/pull\/\d+/;

/** One citation a named file writes on purpose to something other than a spec section. */
export interface Exemption {
  /** Repository-relative path of the file that writes it. */
  file: string;

  /** The citation as written, `§` included. */
  citation: string;

  /** Why that file writes a citation the snapshot does not resolve. */
  reason: string;
}

/**
 * Every `§` citation under `packages/runner/src/cfc/` that names something
 * other than a section of the specification, on purpose.
 */
export const EXEMPTIONS: readonly Exemption[] = [];

/** A file this check reads. */
export interface SourceFile {
  /** Repository-relative path. */
  path: string;

  /** The file as written. */
  text: string;
}

/** Something the check reports. */
export interface Finding {
  /** Repository-relative path of the file the finding is about. */
  file: string;

  /** 1-based line within that file, where the finding has one. */
  line?: number;

  /** What is wrong. */
  message: string;
}

/** Everything the check reads, gathered by `main` and given to the pure core. */
export interface CheckInput {
  snapshot: SpecSnapshot;
  manifest: readonly ManifestRow[];
  companions: readonly Companion[];

  /** Every TypeScript file under the kernel directory. */
  kernelFiles: readonly SourceFile[];

  /** Every TypeScript file whose `§` citations are held to the snapshot. */
  citationFiles: readonly SourceFile[];
  exemptions: readonly Exemption[];

  /** Every file under `packages/` a marker may sit in. */
  markerFiles: readonly SourceFile[];
  budget: number;
}

/** The 1-based line number holding `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (
    let i = text.indexOf("\n");
    i !== -1 && i < index;
    i = text.indexOf("\n", i + 1)
  ) {
    line++;
  }
  return line;
}

/** Keys a snapshot function, row or companion by file, section and name. */
export function functionKey(
  entry: { file: string; section: string; name: string },
): string {
  return JSON.stringify([entry.file, entry.section, entry.name]);
}

/** Keys a section by file and number. */
function sectionKey(entry: { file: string; section: string }): string {
  return JSON.stringify([entry.file, entry.section]);
}

//
// Reading a kernel file
//

/** One function a kernel file exports, with the doc comment above it. */
export interface ExportedFunction {
  name: string;

  /** The text of the doc comment directly above the declaration, or `null`. */
  comment: string | null;

  /** Offset of the declaration in the file. */
  at: number;
}

/**
 * An exported function declaration at the start of a line: `export function`,
 * `export async function`, or an `export const` initialized to an arrow
 * function, with or without `async`.
 */
const EXPORTED_FUNCTION =
  /^export\s+(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)|^export\s+const\s+([A-Za-z_$][\w$]*)(?::[^\n]*?)?\s*=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/gm;

/**
 * Every function `source` exports, each with the doc comment that ends on the
 * line above its declaration. This recognizes the two declaration shapes
 * `EXPORTED_FUNCTION` states and nothing else, so a function exported through
 * an `export { name }` list, or a `const` whose arrow sits behind a cast, is
 * not seen; a kernel file writes its functions as plain exported
 * declarations.
 */
export function exportedFunctions(source: string): ExportedFunction[] {
  const found: ExportedFunction[] = [];
  for (const match of source.matchAll(EXPORTED_FUNCTION)) {
    const name = match[1] ?? match[2];
    const before = source.slice(0, match.index).replace(/\s+$/, "");
    let comment: string | null = null;
    if (before.endsWith("*/")) {
      const open = before.lastIndexOf("/**");
      if (open !== -1) comment = before.slice(open + 3, before.length - 2);
    }
    found.push({ name, comment, at: match.index });
  }
  return found;
}

/**
 * The three ways a module reaches another for its value: an `import`
 * declaration that is not `import type`, bare imports included; an `export`
 * list or `export *` with a `from` clause that is not `export type`; and an
 * `import(...)` expression, wherever it sits. An `export { type X } from`
 * list is read as a value re-export, which errs toward reporting.
 */
const VALUE_IMPORTS = [
  /^import\s+(?!type\s)(?:[^"']*?\s+from\s+)?["']([^"'\n]+)["']/gm,
  /^export\s+(?!type\s)(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/gm,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];

/** Every specifier a file reaches for its value, with where, in file order. */
export function valueImports(
  source: string,
): { specifier: string; at: number }[] {
  const found: { specifier: string; at: number }[] = [];
  for (const pattern of VALUE_IMPORTS) {
    for (const match of source.matchAll(pattern)) {
      found.push({ specifier: match[1], at: match.index });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Whether `specifier` stays inside the kernel directory. */
function staysInKernel(specifier: string): boolean {
  return specifier.startsWith("./") && !specifier.includes("/../");
}

//
// The check
//

/** The header rule over one kernel file, against the snapshot. */
function kernelFileFindings(
  file: SourceFile,
  byKey: ReadonlyMap<string, SpecSnapshot["functions"][number]>,
  seen: Map<string, { file: string; header: SpecHeader }>,
): Finding[] {
  const findings: Finding[] = [];
  for (const { specifier, at } of valueImports(file.text)) {
    if (staysInKernel(specifier) || KERNEL_SHARED_MODULES.has(specifier)) {
      continue;
    }
    findings.push({
      file: file.path,
      line: lineAt(file.text, at),
      message: `imports \`${specifier}\`, which is outside the kernel and ` +
        "not a shared type module; a kernel function takes no transaction, " +
        "reads no dial and calls no hook",
    });
  }
  if (KERNEL_LEDGER_FILES.has(file.path)) return findings;
  for (const { name, comment, at } of exportedFunctions(file.text)) {
    const line = lineAt(file.text, at);
    const headers = comment === null ? [] : parseSpecHeaders(comment);
    if (headers.length !== 1) {
      findings.push({
        file: file.path,
        line,
        message: headers.length === 0
          ? `\`${name}()\` carries no \`@spec\` header`
          : `\`${name}()\` carries ${headers.length} \`@spec\` headers`,
      });
      continue;
    }
    const header = headers[0];
    if (header.name !== name) {
      findings.push({
        file: file.path,
        line,
        message: `\`${name}()\` carries a header for \`${header.name}\``,
      });
      continue;
    }
    const recorded = byKey.get(functionKey(header));
    if (recorded === undefined) {
      findings.push({
        file: file.path,
        line,
        message: `\`${name}()\` names ${header.file} §${header.section}, ` +
          "where the snapshot defines no such function",
      });
    } else if (recorded.sha256 !== header.sha256) {
      findings.push({
        file: file.path,
        line,
        message: `\`${name}()\` was derived from a block whose hash is now ` +
          `${recorded.sha256.slice(0, 12)}…; re-derive it from ` +
          `${header.file} §${header.section} and update the header`,
      });
    }
    const elsewhere = seen.get(name);
    if (elsewhere !== undefined) {
      findings.push({
        file: file.path,
        line,
        message: `\`${name}()\` is also exported by ${elsewhere.file}; a ` +
          "kernel function has one home",
      });
      continue;
    }
    seen.set(name, { file: file.path, header });
  }
  return findings;
}

/**
 * Every finding over `input`. Pure: all reading happens in `main`.
 */
export function collectFindings(input: CheckInput): Finding[] {
  const findings: Finding[] = [];
  const byKey = new Map(
    input.snapshot.functions.map((entry) => [functionKey(entry), entry]),
  );
  const sections = new Set(input.snapshot.sections);

  // The kernel directory: headers against the snapshot, and imports.
  const exported = new Map<string, { file: string; header: SpecHeader }>();
  for (const file of input.kernelFiles) {
    for (const finding of kernelFileFindings(file, byKey, exported)) {
      findings.push(finding);
    }
  }

  // The manifest against the snapshot and the kernel.
  const manifestPath = `${KERNEL_DIR}manifest.ts`;
  const rowKeys = new Set<string>();
  const rowSections = new Set<string>();
  for (const row of input.manifest) {
    const key = functionKey(row);
    if (rowKeys.has(key)) {
      findings.push({
        file: manifestPath,
        message: `two rows name ${row.file} §${row.section} \`${row.name}\``,
      });
    }
    rowKeys.add(key);
    rowSections.add(sectionKey(row));
    const recorded = byKey.get(key);
    if (recorded === undefined) {
      findings.push({
        file: manifestPath,
        message: `the row for \`${row.name}\` names ${row.file} ` +
          `§${row.section}, where the snapshot defines no such function`,
      });
      continue;
    }
    const kernel = exported.get(row.name);
    if (row.relation === "missing") {
      if (kernel !== undefined) {
        findings.push({
          file: manifestPath,
          message: `the row for \`${row.name}\` reads \`missing\`, and ` +
            `${kernel.file} exports it`,
        });
      }
      continue;
    }
    const expectedFile = `${KERNEL_DIR}${row.kernelFile}`;
    if (kernel === undefined) {
      findings.push({
        file: manifestPath,
        message: `the row for \`${row.name}\` names ${expectedFile}, which ` +
          "exports no such function",
      });
    } else if (kernel.file !== expectedFile) {
      findings.push({
        file: manifestPath,
        message: `the row for \`${row.name}\` names ${expectedFile}, and ` +
          `${kernel.file} is where it is exported`,
      });
    } else if (functionKey(kernel.header) !== key) {
      findings.push({
        file: manifestPath,
        message: `the row for \`${row.name}\` names ${row.file} ` +
          `§${row.section}, and its header names ${kernel.header.file} ` +
          `§${kernel.header.section}`,
      });
    }
  }
  const companionKeys = new Set<string>();
  for (const companion of input.companions) {
    const key = functionKey(companion);
    companionKeys.add(key);
    if (!byKey.has(key)) {
      findings.push({
        file: manifestPath,
        message: `the companion \`${companion.name}\` names ` +
          `${companion.file} §${companion.section}, where the snapshot ` +
          "defines no such function",
      });
    } else if (rowKeys.has(key)) {
      findings.push({
        file: manifestPath,
        message: `\`${companion.name}\` in ${companion.file} ` +
          `§${companion.section} is both a row and a companion`,
      });
    }
  }
  for (const entry of input.snapshot.functions) {
    const key = functionKey(entry);
    if (!rowSections.has(sectionKey(entry))) continue;
    if (rowKeys.has(key) || companionKeys.has(key)) continue;
    findings.push({
      file: manifestPath,
      message: `${entry.file} §${entry.section} defines \`${entry.name}\`, ` +
        "which is neither a row nor a companion; decide which it is",
    });
  }
  for (const [name, { file }] of exported) {
    if (input.manifest.some((row) => row.name === name)) continue;
    findings.push({
      file,
      message: `exports \`${name}()\`, which no manifest row names`,
    });
  }

  // Citations against the section list.
  const excused = new Map<string, Exemption>();
  for (const exemption of input.exemptions) {
    excused.set(
      JSON.stringify([exemption.file, exemption.citation]),
      exemption,
    );
  }
  const used = new Set<string>();
  for (const file of input.citationFiles) {
    for (const match of file.text.matchAll(/§\s?(\d+(?:\.\d+)*)/g)) {
      const citation = `§${match[1]}`;
      const key = JSON.stringify([file.path, citation]);
      if (excused.has(key)) {
        used.add(key);
        continue;
      }
      if (sections.has(match[1])) continue;
      findings.push({
        file: file.path,
        line: lineAt(file.text, match.index),
        message: `cites ${citation}, which the specification at ` +
          `${input.snapshot.specsCommit.slice(0, 8)} has no section for`,
      });
    }
  }
  for (const exemption of input.exemptions) {
    const key = JSON.stringify([exemption.file, exemption.citation]);
    if (exemption.reason.trim() === "") {
      findings.push({
        file: exemption.file,
        message: `the EXEMPTIONS entry for ${exemption.citation} gives no ` +
          "reason",
      });
    } else if (!used.has(key)) {
      findings.push({
        file: exemption.file,
        message: `EXEMPTIONS excuses ${exemption.citation}, and the file ` +
          "no longer writes it",
      });
    }
  }

  // Pending markers.
  let markers = 0;
  for (const file of input.markerFiles) {
    for (const match of file.text.matchAll(/^.*SPEC-PENDING.*$/gm)) {
      markers++;
      if (!SPECS_PULL_REQUEST.test(match[0])) {
        findings.push({
          file: file.path,
          line: lineAt(file.text, match.index),
          message: "a `SPEC-PENDING` marker names no " +
            "`https://github.com/commonfabric/specs/pull/<n>`",
        });
      }
    }
  }
  if (markers > input.budget) {
    findings.push({
      file: "packages/",
      message: `${markers} \`SPEC-PENDING\` markers exceed the budget of ` +
        `${input.budget}; land a ruling before adding another`,
    });
  }

  findings.sort((a, b) =>
    a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) ||
    a.message.localeCompare(b.message)
  );
  return findings;
}

/** A TypeScript or TSX source file. */
const SOURCE = /\.tsx?$/;

/** A file a `SPEC-PENDING` marker could sit in. */
const MARKER_HOST = /\.(?:[cm]?[jt]sx?|md)$/;

/** Reads the files the check covers from the tree at `root`. */
export async function readInput(root: string): Promise<CheckInput> {
  const read = async (path: string): Promise<SourceFile> => ({
    path,
    text: await Deno.readTextFile(`${root}/${path}`),
  });
  const files = await repositoryFiles(root);
  const kernelFiles: SourceFile[] = [];
  const citationFiles: SourceFile[] = [];
  const markerFiles: SourceFile[] = [];
  for (const path of files) {
    if (path.startsWith(KERNEL_DIR) && SOURCE.test(path)) {
      kernelFiles.push(await read(path));
    }
    if (
      (path.startsWith("packages/runner/src/cfc/") ||
        path === "packages/runner/src/cfc.ts") && SOURCE.test(path)
    ) {
      citationFiles.push(await read(path));
    }
    if (path.startsWith("packages/") && MARKER_HOST.test(path)) {
      markerFiles.push(await read(path));
    }
  }
  return {
    snapshot: JSON.parse(
      await Deno.readTextFile(`${root}/${SNAPSHOT_PATH}`),
    ) as SpecSnapshot,
    manifest: MANIFEST,
    companions: COMPANIONS,
    kernelFiles,
    citationFiles,
    exemptions: EXEMPTIONS,
    markerFiles,
    budget: SPEC_PENDING_BUDGET,
  };
}

function reportFindings(
  findings: readonly Finding[],
  specsCommit: string,
): void {
  console.error(
    [
      "",
      `CFC correspondence against specs ${specsCommit.slice(0, 8)}:`,
      "",
      ...findings.map((finding) =>
        `  ${finding.file}${
          finding.line === undefined ? "" : `:${finding.line}`
        }` +
        `\n      ${finding.message}`
      ),
      "",
      "docs/development/cfc-spec-correspondence.md is the procedure. A kernel",
      "header or manifest row that disagrees with the snapshot is re-derived",
      "from the specification at the recorded commit, or the snapshot is",
      "regenerated with `deno task cfc-spec-snapshot` from a specs checkout.",
      "A citation naming a section the specification does not have is",
      "corrected, or, where it is written on purpose to something else,",
      "recorded in EXEMPTIONS in tasks/check-cfc-correspondence.ts with the",
      "file, the citation and the reason.",
      "",
    ].join("\n"),
  );
}

/** Runs the check over `root`, reports, and returns a process exit code. */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const input = await readInput(root);
  const findings = collectFindings(input);
  if (findings.length > 0) {
    reportFindings(findings, input.snapshot.specsCommit);
    return 1;
  }
  let citations = 0;
  for (const file of input.citationFiles) {
    citations += [...file.text.matchAll(/§\s?\d/g)].length;
  }
  console.log(
    `CFC correspondence OK against specs ` +
      `${input.snapshot.specsCommit.slice(0, 8)}: ${input.manifest.length} ` +
      `manifest rows, ${input.kernelFiles.length} kernel files, ` +
      `${citations} citations in ${input.citationFiles.length} files.`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main());
