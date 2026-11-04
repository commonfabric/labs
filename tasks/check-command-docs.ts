#!/usr/bin/env -S deno run --allow-read --allow-env --allow-sys --allow-ffi

/**
 * Fails when something a caller can type is described in no live document.
 *
 * `docs/README.md` already obliges a change that alters documented behavior to
 * update the document in the same change. That obligation cannot fire for a
 * word no document describes: nothing is wrong, because nothing claimed to
 * cover it. So a command ships, the prose does not, and the absence is visible
 * only to someone who already knows the command exists.
 *
 * Two surfaces are held to that. `cf`'s command tree is walkable and shuttle's
 * verbs are one table, the documents are greppable, and so for each the
 * question is machine-answerable: is this word described anywhere a reader
 * would find it? They are one check rather than two because the second half of
 * a gate is where a gate divides — the same two directions, the same live-
 * document rule and the same escape, said in the words of whichever surface is
 * at fault.
 *
 * What this cannot decide is whether a word SHOULD have prose. Plenty should
 * not — an internal entry point exists for the packaged binary to call, and a
 * forensics subcommand may be `--help`-discoverable by design. What it requires
 * is that every one has been decided about, which is what {@link NO_PROSE} and
 * {@link NO_VERB_PROSE} record. That turns the next command's documentation
 * from something remembered into something the gate asks for.
 *
 * Usage: deno task check-command-docs
 *        deno task check-command-docs --list   # everything undocumented
 */

import type { Command } from "@cliffy/command";
import { main as cliRoot } from "../runtime/cli/commands/main.ts";
import { VERB_HELP } from "../runtime/cli/lib/shuttle/verbs.ts";
import { walk } from "@std/fs/walk";
import { parse as parseJsonc } from "@std/jsonc";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import { PACKAGE_ROOTS, packageDirOf } from "./package-layout.ts";

/**
 * Commands deliberately left without prose, each with the reason.
 *
 * A reason here answers one question: why would a reader never need to find
 * this from a document? An entry point the packaged binary calls on its own has
 * no caller to inform; a subcommand whose whole surface is its `--help` page
 * has nothing a document would add.
 */
export const NO_PROSE = new Map<string, string>([
  [
    "fuse-daemon",
    "an internal entry point the packaged binary calls; no caller writes it",
  ],
  [
    "fuse-supervisor",
    "the same, for the process that supervises the FUSE child",
  ],
]);

/**
 * Shuttle verbs deliberately left without prose, each with the reason.
 *
 * The escape {@link NO_PROSE} offers a command, in the shape it offers it, so
 * that what excuses a verb is decided the way what excuses a command is. It
 * answers the same question, against a higher bar: every verb here is a word a
 * person types at a prompt, so none of them has the reason a command reached
 * only by another program has.
 */
export const NO_VERB_PROSE = new Map<string, string>();

/**
 * Where the gate looks for prose, relative to the repository root.
 *
 * Each root is somewhere a caller is sent to read: the documentation tree, the
 * authored skills that people and agents share, and the README of the package
 * implementing the command. Instructions addressed to one agent are not that —
 * a command told to an agent mid-task is still a command no caller can look up
 * — so `.claude/` is no more a root than the source is.
 */
export const DOC_ROOTS: readonly string[] = [
  "docs",
  "skills",
  ...PACKAGE_ROOTS,
];

/**
 * The README of each workspace package, as a repository-relative path.
 *
 * A package is what the root config says it is, rather than what the shape of
 * a path suggests: `connectors/agents` is a package and
 * `base/ts-transformers/test/fixtures` is not, and only the member list
 * tells the two apart. The path a member yields need not exist — one that
 * does not simply never turns up in the walk.
 */
export async function readPackageDocs(root: string): Promise<Set<string>> {
  const config = parseJsonc(
    await Deno.readTextFile(join(root, "deno.jsonc")),
  ) as { workspace?: unknown } | null;
  const members = Array.isArray(config?.workspace) ? config.workspace : [];
  const docs = new Set<string>();
  for (const member of members) {
    if (typeof member !== "string") continue;
    docs.add(`${member.replace(/^\.\//, "").replace(/\/+$/, "")}/README.md`);
  }
  return docs;
}

/**
 * Documents that record a moment rather than describing the system.
 *
 * `packageDocs` is {@link readPackageDocs}: in a package the
 * documentation is a package's own README, and an internal one — a fixture
 * corpus, a test directory, a sub-example — is no more somewhere a caller is
 * sent to read than the source beside it.
 */
export function isLiveDoc(
  path: string,
  packageDocs: ReadonlySet<string>,
): boolean {
  // A repository-relative path arrives spelled with the host's separator and
  // every rule below is written in slashes, so the path is read in slashes
  // whichever it arrives in. Untranslated, a Windows `docs\history\report.md`
  // satisfies no rule here, so every one of them passes it through.
  const doc = path.replaceAll("\\", "/");
  if (!doc.endsWith(".md")) return false;
  if (doc.startsWith("docs/history/")) return false;
  // A plan describes work that is intended, not a surface a reader can use
  // today, so naming a command there is not documenting it.
  if (doc.startsWith("docs/plans/")) return false;
  if (doc.includes("/node_modules/")) return false;
  if (packageDirOf(doc) !== undefined && !packageDocs.has(doc)) return false;
  return true;
}

/**
 * Every command path the tree accepts, deepest last.
 *
 * Hidden commands are walked with the rest. Hidden is a fact about `--help`,
 * not about whether the CLI accepts the words: `cf completion complete` is
 * hidden and every installed completion function invokes it on every Tab. A
 * command a caller can reach is a command this gate has to ask about, and one
 * that genuinely needs no prose says so in {@link NO_PROSE} rather than by
 * being invisible here.
 */
export function declaredCommands(
  // deno-lint-ignore no-explicit-any
  root: Command<any>,
): string[] {
  const paths: string[] = [];
  // deno-lint-ignore no-explicit-any
  const visit = (command: Command<any>, path: readonly string[]): void => {
    if (path.length > 0) paths.push(path.join(" "));
    for (const child of command.getCommands(true)) {
      // Cliffy propagates its generated `help` to every descendant, so it is
      // nobody's command and no document owes it prose.
      if (child.getName() === "help") continue;
      visit(child, [...path, child.getName()]);
    }
  };
  visit(root, []);
  return paths;
}

/**
 * Every verb shuttle accepts, by the word that names one, against the usage a
 * document has to write it under.
 *
 * The verb table is the domain rather than a copy of it, so a verb added to
 * `runtime/cli/lib/shuttle/verbs.ts` is a verb this gate asks about with
 * nothing else to edit. It is that table's own account of itself that the
 * document is held to: the usage string `help` opens a verb's page with is the
 * one a row has to carry, so a verb whose operands change is a verb whose row
 * has to be rewritten.
 */
export function declaredVerbs(
  verbs: ReadonlyMap<string, { readonly usage: string }>,
): Map<string, string> {
  return new Map([...verbs].map(([verb, help]) => [verb, help.usage]));
}

/** Nothing in a pattern's own text may be read as regex syntax. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The expression that decides whether a document names one command.
 *
 * A document names a command by writing it the way a caller types it, which
 * is the whole command path between boundaries. Three things look like that
 * and are not it. `cf piece setsrc` is a different command with its own prose
 * obligation, so it cannot stand in for `cf cell set`. `scf brew` is a word
 * that happens to end in the command's letters. And `cf piece ls` names the
 * child: a reader looking up `cf piece` finds nothing about `cf piece` there,
 * so the parent still owes prose of its own — which is why the next segment
 * of every command this one is a prefix of ends the match.
 */
export function commandPattern(
  command: string,
  commands: readonly string[],
): RegExp {
  const path = command.split(" ");
  const children = new Set<string>();
  for (const other of commands) {
    const parts = other.split(" ");
    if (parts.length === path.length + 1 && other.startsWith(`${command} `)) {
      children.add(parts.at(-1)!);
    }
  }
  const child = children.size === 0
    ? ""
    : `(?!\\s+(?:${[...children].map(escapeRegExp).join("|")})(?![\\w-]))`;
  return new RegExp(
    `(?<![\\w-])cf\\s+${path.map(escapeRegExp).join("\\s+")}${child}(?![\\w-])`,
  );
}

/**
 * The expression that decides whether a document describes one verb.
 *
 * A verb has no `cf` in front of it to make a mention unmistakable, and the
 * words are `cd`, `get`, `help`, `more` and `where`: written into a sentence
 * each is a word the sentence was going to hold anyway, and even in backticks
 * it is as likely to be a sentence about something else — "`more` writes the
 * next one" is a fact about paging, not the account of a verb. So the standard
 * is the row that makes the verb its subject: a table cell that opens a line
 * and holds the verb's usage, as code, and nothing besides.
 *
 * That is what a mention cannot satisfy, and the difference is the whole
 * point. `runtime/cli/README.md` lost its row for `more` while its prose went
 * on saying what `more` writes, and no gate saw it.
 */
export function verbPattern(usage: string): RegExp {
  return new RegExp(`^\\|[ \\t]*\`${escapeRegExp(usage)}\`[ \\t]*\\|`, "m");
}

/** What the live documents were found to describe, by surface. */
export interface DocumentedNames {
  /** The command paths some live document names. */
  readonly commands: Set<string>;

  /** The verbs some live document gives a row of their own. */
  readonly verbs: Set<string>;
}

/**
 * What some live document describes, of the commands and the verbs given.
 *
 * Both surfaces are answered from one walk, because the walk is the cost: each
 * document is read once and every pattern tried against it, rather than the
 * tree being read once per surface. `verbs` is {@link declaredVerbs}, the verb
 * against the usage its row has to carry.
 */
export async function documentedNames(
  root: string,
  commands: readonly string[],
  verbs: ReadonlyMap<string, string>,
): Promise<DocumentedNames> {
  const found: DocumentedNames = { commands: new Set(), verbs: new Set() };
  const packageDocs = await readPackageDocs(root);
  const patterns = [
    ...commands.map((name) => ({
      into: found.commands,
      name,
      pattern: commandPattern(name, commands),
    })),
    ...[...verbs].map(([name, usage]) => ({
      into: found.verbs,
      name,
      pattern: verbPattern(usage),
    })),
  ];
  for (const dir of DOC_ROOTS) {
    // `walk` reports a missing directory when it is iterated rather than when
    // it is constructed, so the guard has to wrap the loop. A root a checkout
    // does not have contributes no documents rather than failing the run.
    try {
      const entries = walk(`${root}/${dir}`, {
        exts: [".md"],
        includeDirs: false,
      });
      for await (const entry of entries) {
        const path = relative(root, entry.path);
        if (!isLiveDoc(path, packageDocs)) continue;
        const text = await Deno.readTextFile(entry.path);
        for (const { into, name, pattern } of patterns) {
          if (!into.has(name) && pattern.test(text)) into.add(name);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return found;
}

/** What the check found about one surface, in the two directions it looks. */
export interface DocReport {
  /** Names no live document describes and no allowance covers. */
  readonly undocumented: string[];

  /** Allowances naming something the surface no longer holds. */
  readonly staleAllowance: string[];
}

/** Subtract what the documents cover from what the surface declares. */
export function reportDocs(
  declared: readonly string[],
  documented: ReadonlySet<string>,
  allowed: ReadonlyMap<string, string>,
): DocReport {
  const undocumented = declared
    .filter((name) => !documented.has(name) && !allowed.has(name))
    .sort();
  const declaredSet = new Set(declared);
  const staleAllowance = [...allowed.keys()]
    .filter((name) => !declaredSet.has(name))
    .sort();
  return { undocumented, staleAllowance };
}

/**
 * The words one surface's failures are written in.
 *
 * Every step but the vocabulary is shared, so the vocabulary is the parameter:
 * the same report, the same two directions and the same paragraphs, said about
 * whichever surface is at fault. A third surface is a value of this rather
 * than a second copy of the reporting, which is where the two halves would
 * otherwise part company.
 */
export interface Surface {
  /** What one of its names is called, in the singular. */
  readonly noun: string;

  /** Writes one name the way a live document has to write it. */
  readonly write: (name: string) => string;

  /** The table in this file that records a deliberate silence about one. */
  readonly table: string;

  /** What would satisfy the check, for a reader who has just failed it. */
  readonly remedy: string;
}

/** The `cf` commands, in the words their failures are written in. */
export const COMMAND_SURFACE: Surface = {
  noun: "command",
  write: (command) => `cf ${command}`,
  table: "NO_PROSE",
  remedy: "Either describe the command in a live document, or record why it " +
    "needs none in tasks/check-command-docs.ts.",
};

/**
 * Shuttle's verbs, in the words their failures are written in.
 *
 * `verbs` is {@link declaredVerbs}, so a verb is written as the row that would
 * satisfy the check opens — which is the answer to what a reader is being
 * asked for. An allowance that outlived its verb has no usage left to write,
 * and is named by the word it recorded.
 */
export function verbSurface(verbs: ReadonlyMap<string, string>): Surface {
  return {
    noun: "shuttle verb",
    write: (verb) => `\`${verbs.get(verb) ?? verb}\``,
    table: "NO_VERB_PROSE",
    remedy: "A live document describes a verb by giving it a row of its own " +
      "in a table, the row opening with the verb's usage in backticks as " +
      "written above; the verb table in runtime/cli/README.md is the shape. " +
      "A mention in a sentence is not that. Either give the verb such a row, " +
      "or record why it needs none in tasks/check-command-docs.ts.",
  };
}

/**
 * The failures a report describes, one paragraph each.
 *
 * Each paragraph closes with what would answer that paragraph, because the two
 * directions are answered differently and a run can fail in both at once: what
 * satisfies the check is no use to an entry whose subject has gone, and
 * deleting the entry is no use to a verb that wants a row.
 */
export function describeDocFailures(
  report: DocReport,
  surface: Surface,
): string[] {
  const failures: string[] = [];
  const block = (names: readonly string[]) =>
    names.map((name) => `  ${surface.write(name)}`).join("\n");
  if (report.undocumented.length > 0) {
    failures.push(
      `${report.undocumented.length} ${surface.noun}(s) are described in no ` +
        `live document and have no entry in ${surface.table}:\n` +
        `${block(report.undocumented)}\n\n${surface.remedy}`,
    );
  }
  if (report.staleAllowance.length > 0) {
    failures.push(
      `${report.staleAllowance.length} ${surface.table} entr(ies) name a ` +
        `${surface.noun} that no longer exists:\n` +
        `${block(report.staleAllowance)}\n\nRemove each entry: what it ` +
        `recorded a decision about is not there to decide about.`,
    );
  }
  return failures;
}

/** Run the check against the real CLI tree. Returns the process exit code. */
export async function main(
  args: readonly string[] = [],
  root = dirname(dirname(fromFileUrl(import.meta.url))),
): Promise<number> {
  const commands = declaredCommands(cliRoot);
  const verbs = declaredVerbs(VERB_HELP);
  const documented = await documentedNames(root, commands, verbs);
  const surfaces: readonly (readonly [DocReport, Surface])[] = [
    [reportDocs(commands, documented.commands, NO_PROSE), COMMAND_SURFACE],
    [
      reportDocs([...verbs.keys()], documented.verbs, NO_VERB_PROSE),
      verbSurface(verbs),
    ],
  ];

  if (args.includes("--list")) {
    for (const [report, surface] of surfaces) {
      for (const name of report.undocumented) console.log(surface.write(name));
    }
    return 0;
  }

  const failures = surfaces.flatMap(([report, surface]) =>
    describeDocFailures(report, surface)
  );
  if (failures.length > 0) {
    console.error("Command documentation check failed.\n");
    console.error(failures.join("\n\n"));
    return 1;
  }

  console.log(
    `Command documentation OK (${commands.length} command(s) and ` +
      `${verbs.size} shuttle verb(s), ` +
      `${NO_PROSE.size + NO_VERB_PROSE.size} deliberately without prose).`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
