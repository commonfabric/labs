#!/usr/bin/env -S deno run --allow-read --allow-ffi --allow-env
// Thin CLI over the inspector library. Agent-first: every command also takes
// --json so a caller can consume structured output. This is a prototype entry
// point; the intent is to later surface the same commands as `cf inspect …`.
//
// Single-space:
//   inspect summary  <db>
//   inspect commits  <db> [--session <prefix>] [--limit <n>]
//   inspect hot      <db> [--limit <n>] [--branch <b>]
//   inspect history  <db> <entity-id> [--scope <s>] [--branch <b>]
//   inspect operations <db> [entity-id] [--scope <s>] [--branch <b>]
//   inspect value-at <db> <entity-id> [--seq <n>] [--path a/b/c]
//                    [--path-json '["a/b",""]'] [--doc] [--full-depth]
// Multi-space (cross-space convergence):
//   inspect converge      <entity-id> --spaces a.sqlite,b.sqlite [--path a/b/c]
//                        [--path-json '["a/b",""]']
//   inspect converge      <entity-id> --dir <dir-of-sqlite>
//   inspect converge-scan --dir <dir> [--limit <n>] [--branch <b>]

import { openSpace } from "./db.ts";
import {
  annotate,
  escapeTerminalText,
  stringifyInspectorJson,
  summarize,
} from "./decode.ts";
import {
  describeCommitPayload,
  entityHistory,
  hotEntities,
  listCommits,
  summarizeSpace,
} from "./queries.ts";
import { inspectOperationFields } from "./operations.ts";
import { getValueAt } from "./reconstruct.ts";
import {
  buildCrossSpaceLinkIndex,
  convergenceExact,
  convergenceScanExact,
  listSqliteFiles,
  openSpaces,
  type SpaceRef,
} from "./multispace.ts";

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that never take a value — so `--json <db>` doesn't eat the db arg. */
const BOOLEAN_FLAGS = new Set(["json", "doc", "full-depth", "help"]);

/** Value-taking flags for which an empty string has defined semantics. */
const FLAGS_ALLOWING_EMPTY_VALUES = new Set(["branch", "path", "scope"]);

const COMMAND_FLAGS = {
  summary: new Set(["json"]),
  commits: new Set(["session", "limit", "json"]),
  hot: new Set(["limit", "branch", "json"]),
  history: new Set(["scope", "branch", "limit", "json"]),
  operations: new Set([
    "scope",
    "branch",
    "limit",
    "history-limit",
    "submission-after-seq",
    "json",
  ]),
  "value-at": new Set([
    "seq",
    "path",
    "path-json",
    "scope",
    "branch",
    "doc",
    "full-depth",
    "json",
  ]),
  converge: new Set([
    "spaces",
    "dir",
    "path",
    "path-json",
    "scope",
    "branch",
    "json",
  ]),
  "converge-scan": new Set([
    "spaces",
    "dir",
    "limit",
    "scope",
    "branch",
    "json",
  ]),
} satisfies Record<string, ReadonlySet<string>>;

type Command = keyof typeof COMMAND_FLAGS;

function isCommand(name: string): name is Command {
  return Object.hasOwn(COMMAND_FLAGS, name);
}

/**
 * Separates positional arguments from flags and validates flag values.
 *
 * @throws {Error} When a value-taking flag omits its value.
 */
function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = Object.create(null) as Record<string, string | boolean>;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`\`--${key}\` requires a value.`);
      }
      flags[key] = next;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function validateEmptyFlagValues(
  flags: Record<string, string | boolean>,
): void {
  for (const [name, value] of Object.entries(flags)) {
    if (value === "" && !FLAGS_ALLOWING_EMPTY_VALUES.has(name)) {
      throw new Error(`\`--${name}\` requires a value.`);
    }
  }
}

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;
const num = (v: string | boolean | undefined): number | undefined =>
  typeof v === "string" ? Number(v) : undefined;
const splitPath = (v: string | boolean | undefined): string[] =>
  str(v) ? str(v)!.split("/").filter(Boolean) : [];
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_$@.:%+~-]+$/;

function stringifyPathSegments(segments: string[]): string {
  return JSON.stringify(segments).replace(
    /[^\x20-\x7E]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function formatSelectedPath(segments: string[], exact: boolean): string {
  return exact || !segments.every((segment) => SAFE_PATH_SEGMENT.test(segment))
    ? stringifyPathSegments(segments)
    : `/${segments.join("/")}`;
}

function validateNumericFlags(
  flags: Record<string, string | boolean>,
): void {
  for (
    const name of ["seq", "limit", "history-limit", "submission-after-seq"]
  ) {
    const raw = flags[name];
    if (raw === undefined) continue;
    const value = typeof raw === "string" ? Number(raw) : Number.NaN;
    if (
      typeof raw !== "string" || raw.trim() === "" ||
      !Number.isSafeInteger(value) || value < 0
    ) {
      throw new Error(`\`--${name}\` must be a non-negative integer.`);
    }
  }
}

function validateOperationLimits(
  command: string,
  flags: Record<string, string | boolean>,
): void {
  if (command !== "operations") return;
  for (const name of ["limit", "history-limit"]) {
    const raw = flags[name];
    if (raw === undefined) continue;
    const value = typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
      throw new Error(`\`--${name}\` must be an integer from 1 to 1000.`);
    }
  }
}

/**
 * Parses one of the supported path flags into exact string segments.
 *
 * @throws {Error} When path flags conflict or `path-json` is not a JSON array
 * of strings.
 */
function parsePathFlags(flags: Record<string, string | boolean>): string[] {
  const path = str(flags.path);
  const pathJson = str(flags["path-json"]);
  if (path !== undefined && pathJson !== undefined) {
    throw new Error("Use either `--path` or `--path-json`, not both.");
  }
  if (flags.doc === true && (path !== undefined || pathJson !== undefined)) {
    throw new Error("Use `--doc` without `--path` or `--path-json`.");
  }
  if (pathJson === undefined) return splitPath(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(pathJson);
  } catch {
    throw new Error(
      "`--path-json` must contain a JSON array of string segments.",
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((segment) => typeof segment === "string")
  ) {
    throw new Error(
      "`--path-json` must contain a JSON array of string segments.",
    );
  }
  return parsed;
}

/** Where the CLI writes its report and its diagnostics. */
export interface CliOutput {
  log(text: string): void;
  error(text: string): void;
}

type OutputStringifier = (value: unknown) => string;

const prettyJson: OutputStringifier = (value) => JSON.stringify(value, null, 2);

function out(
  output: CliOutput,
  json: boolean,
  data: unknown,
  render: () => void,
  stringify: OutputStringifier = prettyJson,
) {
  if (json) output.log(stringify(data));
  else render();
}

const USAGE = `cf state-inspector (prototype)

single-space:
  summary  <db>
  commits  <db> [--session <prefix>] [--limit <n>] [--json]
  hot      <db> [--limit <n>] [--branch <b>] [--json]
  history  <db> <entity-id> [--scope <s>] [--branch <b>] [--limit <n>] [--json]
  operations <db> [entity-id] [--scope <s>] [--branch <b>] [--limit <n>]
                              [--history-limit <n>]
                              [--submission-after-seq <n>] [--json]
  value-at <db> <entity-id> [--seq <n>] [--path a/b/c] [--scope <s>]
                            [--path-json '["a/b",""]'] [--branch <b>]
                            [--doc] [--full-depth] [--json]

cross-space convergence:
  converge      <entity-id> (--spaces a,b,… | --dir <dir>) [--path a/b/c]
                            [--path-json '["a/b",""]'] [--scope <s>]
                            [--branch <b>] [--json]
  converge-scan (--spaces a,b,… | --dir <dir>) [--limit <n>] [--scope <s>]
                            [--branch <b>] [--json]
`;

function resolveSpaces(flags: Record<string, string | boolean>): SpaceRef[] {
  if (flags.dir !== undefined && flags.spaces !== undefined) {
    throw new Error("Use either `--dir` or `--spaces`, not both.");
  }
  const dir = str(flags.dir);
  const spaces = str(flags.spaces);
  if (dir) return openSpaces(listSqliteFiles(dir));
  if (spaces !== undefined) {
    const paths = spaces.split(",").map((path) => path.trim()).filter(Boolean);
    if (paths.length === 0) {
      throw new Error("`--spaces` must contain at least one space.");
    }
    return openSpaces(paths);
  }
  throw new Error("provide --spaces a,b,… or --dir <dir>");
}

function runMultiSpace(
  output: CliOutput,
  cmd: "converge" | "converge-scan",
  rest: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
  path: string[] = [],
): number {
  const id = rest[0];
  if (cmd === "converge" && !id) {
    output.error("error: converge needs <entity-id>");
    return 1;
  }
  let refs: SpaceRef[];
  try {
    refs = resolveSpaces(flags);
  } catch (e) {
    output.error(`error: ${(e as Error).message}`);
    return 1;
  }
  if (refs.length === 0) {
    output.error("error: no space DBs resolved");
    return 1;
  }
  try {
    if (cmd === "converge") {
      const index = buildCrossSpaceLinkIndex(refs, {
        scope: str(flags.scope),
        branch: str(flags.branch),
      });
      const result = convergenceExact(refs, {
        id,
        scope: str(flags.scope),
        branch: str(flags.branch),
        path,
      }, index);
      out(output, json, result, () => {
        output.log(
          `verdict: ${result.verdict.toUpperCase()}` +
            (result.relationship && result.relationship !== "n/a"
              ? `  [${result.relationship}]`
              : ""),
        );
        output.log(
          `entity:  ${result.id}  scope=${result.scope}  branch=${
            result.branch || "(default)"
          }` +
            (result.path.length
              ? `  path=${
                formatSelectedPath(
                  result.path,
                  flags["path-json"] !== undefined,
                )
              }`
              : ""),
        );
        for (const v of result.views) {
          if (!v.present) {
            output.log(`  ${escapeTerminalText(v.label)}\tABSENT`);
            continue;
          }
          if (v.error) {
            output.log(
              `  ${escapeTerminalText(v.label)}\tERROR\t${
                escapeTerminalText(v.error)
              }`,
            );
            continue;
          }
          const cluster = result.clusters.findIndex((c) =>
            c.valueKey === v.valueKey
          ) + 1;
          output.log(
            `  ${
              escapeTerminalText(v.label)
            }\thead=${v.headSeq}\trevs=${v.revisions}\tlast=${
              (v.lastSession ?? "?").slice(0, 14)
            }@${v.lastWriteAt ?? "?"}\tcluster#${cluster}` +
              (v.pathExists === false ? "\tpath=MISSING" : ""),
          );
        }
        if (result.clusters.length > 1) {
          output.log("clusters:");
          result.clusters.forEach((c, i) =>
            output.log(
              `  #${i + 1} [${c.labels.length}]\t${
                c.pathExists === false ? "(path missing)" : summarize(c.value)
              }`,
            )
          );
        }
        output.log(`note: ${result.caveat}`);
      });
      return 0;
    }
    const result = convergenceScanExact(refs, {
      scope: str(flags.scope),
      branch: str(flags.branch),
      limit: num(flags.limit),
    });
    out(output, json, result, () => {
      output.log(
        `shared entities (in >=2 spaces): ${result.sharedEntities}  examined: ${result.examined}`,
      );
      output.log(
        `cross-space link edges: ${result.crossSpaceLinkEdges}` +
          `  (${result.linkedFindings} real-drift / ` +
          `${result.unlinkedFindings} likely-independent-instances / ` +
          `${result.unknownFindings} unknown)`,
      );
      output.log(
        `findings (diverged/partial/unknown): ${result.findings.length}`,
      );
      for (const f of result.findings) {
        const present = f.views.filter((v) => v.present).map((v) => v.label);
        const absent = f.views.filter((v) => !v.present).map((v) => v.label);
        const rel = f.relationship === "cross-space-linked"
          ? "DRIFT"
          : f.relationship === "no-cross-space-link"
          ? "instance?"
          : "?";
        output.log(
          `  ${f.verdict.toUpperCase()}\t${rel}\t${f.id}\tpresent=${present.length}` +
            (absent.length ? `\tmissing=${absent.length}` : "") +
            `\tclusters=${f.clusters.length}`,
        );
      }
    });
    return 0;
  } finally {
    for (const r of refs) r.space.close();
  }
}

/**
 * Runs one inspector command, writing what it reports to `output`, and returns
 * the process exit status.
 */
export function main(argv: string[], output: CliOutput): number {
  let parsed: Args;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    output.error(`error: ${(e as Error).message}`);
    return 1;
  }
  const { positional, flags } = parsed;
  const [cmd, ...rest] = positional;
  const json = flags.json === true;

  if (!cmd || cmd === "help" || flags.help) {
    output.log(USAGE);
    return cmd || flags.help ? 0 : 1;
  }

  if (!isCommand(cmd)) {
    output.error(`unknown command: ${cmd}\n`);
    output.log(USAGE);
    return 1;
  }
  const allowedFlags: ReadonlySet<string> = COMMAND_FLAGS[cmd];
  const unsupportedFlag = Object.keys(flags).find((flag) =>
    !allowedFlags.has(flag)
  );
  if (unsupportedFlag !== undefined) {
    output.error(`error: \`--${unsupportedFlag}\` is not valid for ${cmd}.`);
    return 1;
  }
  try {
    validateEmptyFlagValues(flags);
    validateNumericFlags(flags);
    validateOperationLimits(cmd, flags);
  } catch (e) {
    output.error(`error: ${(e as Error).message}`);
    return 1;
  }

  if (cmd === "converge") {
    let path: string[];
    try {
      path = parsePathFlags(flags);
    } catch (e) {
      output.error(`error: ${(e as Error).message}`);
      return 1;
    }
    return runMultiSpace(output, cmd, rest, flags, json, path);
  }
  if (cmd === "converge-scan") {
    return runMultiSpace(output, cmd, rest, flags, json);
  }

  // Single-space commands take <db> as the first positional.
  const dbPath = rest[0];
  const tail = rest.slice(1);
  if (!dbPath) {
    output.error("error: missing <db> path\n");
    output.log(USAGE);
    return 1;
  }
  if (cmd === "history" && !tail[0]) {
    output.error("error: history needs <entity-id>");
    return 1;
  }
  if (cmd === "value-at" && !tail[0]) {
    output.error("error: value-at needs <entity-id>");
    return 1;
  }

  let valuePath: string[] | undefined;
  if (cmd === "value-at") {
    try {
      valuePath = parsePathFlags(flags);
    } catch (e) {
      output.error(`error: ${(e as Error).message}`);
      return 1;
    }
  }

  const space = openSpace(dbPath);
  try {
    switch (cmd) {
      case "summary": {
        const s = summarizeSpace(space);
        out(output, json, s, () => {
          output.log(`space: ${s.path}`);
          output.log(
            `commits: ${s.commits}` +
              (s.commitSeqRange
                ? ` (seq ${s.commitSeqRange[0]}–${s.commitSeqRange[1]})`
                : ""),
          );
          output.log(`sessions: ${s.sessions}`);
          output.log(`entities: ${s.entities}  revisions: ${s.revisions}`);
          output.log(
            `ops: ${
              Object.entries(s.ops).map(([k, v]) => `${k}=${v}`).join(" ")
            }`,
          );
          output.log(
            `scopes: ${
              s.scopes.map((sc) => `${sc.scope_key}=${sc.count}`).join(" ")
            }`,
          );
          output.log(
            `branches: ${
              s.branches.map((b) => `${b.name || "(default)"}@${b.head_seq}`)
                .join(" ")
            }`,
          );
          output.log(
            `scheduler basis table: ${s.hasSchedulerBasisTable ? "yes" : "no"}`,
          );
        });
        return 0;
      }
      case "commits": {
        const rows = listCommits(space, {
          session: str(flags.session),
          limit: num(flags.limit),
        });
        out(output, json, rows, () => {
          for (const r of rows) {
            output.log(
              `#${r.seq}\t${r.session.slice(0, 14)}\tlocal=${r.localSeq}\t${
                describeCommitPayload(r)
              }\t${r.createdAt}`,
            );
          }
        });
        return 0;
      }
      case "hot": {
        const rows = hotEntities(space, {
          limit: num(flags.limit),
          branch: str(flags.branch),
        });
        out(output, json, rows, () => {
          for (const r of rows) {
            output.log(
              `${r.writes}\twrites\t${r.sessions} sessions\t${r.id}\t(${r.scope})`,
            );
          }
        });
        return 0;
      }
      case "history": {
        const id = tail[0];
        const rows = entityHistory(space, {
          id,
          scope: str(flags.scope),
          branch: str(flags.branch),
          limit: num(flags.limit),
        });
        out(output, json, rows, () => {
          for (const r of rows) {
            output.log(
              `seq=${r.seq}\tcommit=${r.commitSeq}\t${r.op}\t${
                r.session.slice(0, 14)
              }\tlocal=${r.localSeq}\t${r.createdAt}`,
            );
          }
        });
        return 0;
      }
      case "operations": {
        const report = inspectOperationFields(space, {
          id: tail[0],
          scope: str(flags.scope),
          branch: str(flags.branch),
          fieldLimit: num(flags.limit),
          historyLimit: num(flags["history-limit"]),
          submissionAfterSeq: num(flags["submission-after-seq"]),
        });
        out(output, json, report, () => {
          if (!report.available) {
            output.log("operation tables are absent");
            return;
          }
          for (const field of report.fields) {
            output.log(
              `${field.active ? "active" : "inactive"}\t${field.address.id}` +
                `\t${field.address.scope}\t${field.address.pathPointer}` +
                `\t${field.codec}` +
                `\t${field.cursor.epoch}:${field.cursor.version}` +
                `\tretained=${field.retainedFrom.version}` +
                `\t${field.consistency.healthy ? "healthy" : "INCONSISTENT"}`,
            );
            output.log(
              `  submissions=${field.submissions.length}` +
                ` integrated=${field.integrated.length}` +
                ` checkpoints=${field.checkpoints.length}`,
            );
          }
          if (report.fieldsTruncated) {
            output.log(`field list truncated at ${report.fieldLimit}`);
          }
        });
        return 0;
      }
      case "value-at": {
        const id = tail[0];
        const res = getValueAt(
          space,
          {
            id,
            scope: str(flags.scope),
            branch: str(flags.branch),
            atSeq: num(flags.seq),
          },
          valuePath ?? [],
        );
        const shown = flags.doc === true ? res.document : res.value;
        const pathExists = flags.doc === true ? res.exists : res.pathExists;
        const fullDepth = flags["full-depth"] === true;
        const annotated = annotate(
          shown,
          fullDepth ? Number.POSITIVE_INFINITY : 8,
        );
        const stringify = fullDepth ? stringifyInspectorJson : prettyJson;
        out(
          output,
          json,
          { exists: res.exists, pathExists, value: annotated },
          () => {
            if (!res.exists) {
              output.log("(absent at this seq)");
              return;
            }
            if (!pathExists) {
              output.log("(entity present, but nothing at that path)");
              return;
            }
            output.log(stringify(annotated));
          },
          stringify,
        );
        return 0;
      }
    }
  } finally {
    space.close();
  }
}

if (import.meta.main) {
  Deno.exit(main(Deno.args, console));
}
