/**
 * `deno task cfc-audit` — the spec-anchored CFC audit over session artifacts.
 *
 * ```
 * deno task cfc-audit <runDir | artifactRoot> [more paths...]
 *                     [--json] [--fail-on fail|warn|inconclusive]
 *                     [--corpus] [--expect-refusals]
 *                     [--expected-failures <path>]
 *                     [--expected-posture <spec.json>] [--toolshed-url <url>]
 * ```
 *
 * A run directory audits that run and the `delegate_task` children beside it;
 * an artifact root audits every run under it. Every finding is printed with
 * the clause it rests on and the words of that clause, so a reader can go from
 * the finding to the sentence that makes it a finding without leaving the
 * output.
 *
 * The four deployment flags ask a question no single run's artifacts answer,
 * and they are what turns the Group D checks on. Without one of them the audit
 * is what Phase 1 made it: a per-run reading of an artifact tree, whose exit
 * code is not spent on a question nobody asked.
 *
 * The audit reads. It opens no run for writing and creates nothing inside an
 * artifact tree.
 */

import type { CfcPostureReport } from "@commonfabric/runner/cfc";

import {
  auditDeployment,
  type DeploymentAudit,
  type ToolshedMeta,
} from "./checks/deployment.ts";
import { RUN_CHECKS } from "./checks/registry.ts";
import {
  manifestReconciliationFails,
  reconcileConformanceManifest,
  renderConformancePosition,
} from "./conformance-manifest.ts";
import { auditRunFamily } from "./checks/structural.ts";
import { discoverRunFamilies, type RunFamily } from "./evidence.ts";
import {
  type ExpectedFailure,
  type ExpectedFailureReconciliation,
  readExpectedFailures,
  reconcileExpectedFailures,
  reconciliationFails,
  renderReconciliation,
} from "./expected-failures.ts";
import {
  type ExpectedPosture,
  loadExpectedPosture,
} from "./expected-posture.ts";
import {
  type CheckResult,
  type CheckVerdict,
  countVerdicts,
  DEFAULT_FAIL_ON,
  type FailOnThreshold,
  VERDICT_ORDER,
  verdictFailsThreshold,
} from "./report.ts";

/** What the command line asked for. */
export interface AuditCliOptions {
  paths: readonly string[];
  json: boolean;
  failOn: FailOnThreshold;

  /** Whether the named paths are to be read as one corpus (Group D). */
  corpus: boolean;

  /**
   * A file listing the findings this run is known to produce, when one was
   * named. Findings it covers do not fail the run; anything else does, and so
   * does an entry that matched nothing.
   */
  expectedFailures?: string;

  /** Whether that corpus is declared adversarial, so no refusal is a failure. */
  expectRefusals: boolean;

  /** Path of the expected-posture spec, when one was named. */
  expectedPosture?: string;

  /** Base URL of a deployment whose `/api/meta` posture is to be read. */
  toolshedUrl?: string;
}

/** Whether the command line asked a question the Group D checks answer. */
export const asksDeploymentQuestion = (options: AuditCliOptions): boolean =>
  options.corpus || options.expectRefusals ||
  options.expectedPosture !== undefined || options.toolshedUrl !== undefined;

const FAIL_ON_VALUES: readonly FailOnThreshold[] = [
  "fail",
  "warn",
  "inconclusive",
];

const USAGE = [
  "usage: cfc-audit <runDir | artifactRoot> [more paths...]",
  "                 [--json] [--fail-on fail|warn|inconclusive]",
  "                 [--corpus] [--expect-refusals]",
  "                 [--expected-failures <path>]",
  "                 [--expected-posture <spec.json>] [--toolshed-url <url>]",
].join("\n");

/**
 * Reads the command line.
 *
 * @throws Error naming the problem, for a caller to print beside the usage.
 */
export const parseAuditCliArgs = (
  args: readonly string[],
): AuditCliOptions => {
  const paths: string[] = [];
  let json = false;
  let failOn: FailOnThreshold = DEFAULT_FAIL_ON;
  let corpus = false;
  let expectedFailures: string | undefined;
  let expectRefusals = false;
  let expectedPosture: string | undefined;
  let toolshedUrl: string | undefined;
  const valueOf = (option: string, value: string | undefined): string => {
    if (value === undefined) {
      throw new Error(`\`${option}\` needs a value`);
    }
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--expected-failures") {
      expectedFailures = valueOf("--expected-failures", args[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--corpus") {
      corpus = true;
      continue;
    }
    if (arg === "--expect-refusals") {
      // Declaring the corpus adversarial is declaring it a corpus: the claim
      // is about the set of runs, and a set of one run cannot support it.
      expectRefusals = true;
      corpus = true;
      continue;
    }
    if (arg === "--expected-posture") {
      expectedPosture = valueOf(arg, args[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--toolshed-url") {
      toolshedUrl = valueOf(arg, args[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--fail-on") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("`--fail-on` needs one of fail, warn, inconclusive");
      }
      if (!FAIL_ON_VALUES.includes(value as FailOnThreshold)) {
        throw new Error(
          `\`--fail-on ${value}\` is not one of fail, warn, inconclusive`,
        );
      }
      failOn = value as FailOnThreshold;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unknown option \`${arg}\``);
    }
    paths.push(arg);
  }
  if (paths.length === 0) {
    throw new Error("name at least one run directory or artifact root");
  }
  return {
    paths,
    json,
    failOn,
    corpus,
    ...(expectedFailures !== undefined ? { expectedFailures } : {}),
    expectRefusals,
    ...(expectedPosture !== undefined ? { expectedPosture } : {}),
    ...(toolshedUrl !== undefined ? { toolshedUrl } : {}),
  };
};

/** Every run family under every named path. */
export const loadRunFamilies = async (
  paths: readonly string[],
): Promise<readonly RunFamily[]> => {
  const families: RunFamily[] = [];
  for (const path of paths) {
    for (const family of await discoverRunFamilies(path)) {
      families.push(family);
    }
  }
  return families;
};

/**
 * Reads a deployment's published posture.
 *
 * A deployment that cannot be reached is `unreachable` rather than an
 * exception: the audit's subject is the artifact trees, and a network that
 * did not answer must not cost the findings on those.
 */
export const readToolshedMeta = async (
  url: string,
  fetchMeta: typeof fetch = fetch,
): Promise<ToolshedMeta> => {
  const metaUrl = new URL("/api/meta", url).toString();
  try {
    const response = await fetchMeta(metaUrl);
    if (!response.ok) {
      return {
        status: "unreachable",
        url: metaUrl,
        detail: `HTTP ${response.status}`,
      };
    }
    const body = await response.json() as { cfc?: CfcPostureReport | null };
    return { status: "read", url: metaUrl, cfc: body.cfc ?? null };
  } catch (error) {
    return {
      status: "unreachable",
      url: metaUrl,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

const VERDICT_LABEL: Record<CheckVerdict, string> = {
  fail: "FAIL",
  warn: "WARN",
  inconclusive: "INCONCLUSIVE",
  "not-applicable": "N/A",
  pass: "PASS",
};

const renderFinding = (result: CheckResult): string => {
  const restsOnSpec = result.citations.some((citation) =>
    citation.kind === "required-by"
  );
  const lines = [
    `  ${result.checkId} ${result.title} — ${result.runId}${
      restsOnSpec ? "" : " [our requirement, not the specification's]"
    }`,
    `    ${result.message}`,
  ];
  for (const citation of result.citations) {
    // The kind rides on the clause line, so a reader never has to ask whether
    // a finding is the specification speaking or our judgment.
    lines.push(
      `    ${citation.clause} (${citation.doc}) — ${
        citation.kind === "required-by"
          ? "states this requirement"
          : "this check extends this clause's purpose; the clause does not state the requirement"
      }`,
    );
    lines.push(`      "${citation.quote}"`);
  }
  if (result.knownDefect !== undefined) {
    // A known defect's finding is not news, so what a reader needs from it is
    // where the work is rather than more argument that it is real.
    lines.push(
      `    known defect, tracked under ${result.knownDefect.issue} — ${result.knownDefect.why}`,
    );
  }
  for (const evidence of result.evidence) {
    const where = [evidence.artifact, evidence.pointer].filter((part) =>
      part !== undefined
    ).join(" ");
    lines.push(
      `    evidence: ${where === "" ? "" : `${where} — `}${evidence.detail}`,
    );
  }
  lines.push(`    run: ${result.runDir}`);
  return lines.join("\n");
};

/** The human report: the findings that carry weight, worst verdict first. */
export const renderAuditReport = (
  results: readonly CheckResult[],
  failOn: FailOnThreshold,
  options: { exitDecidedBy?: "expected-failures" } = {},
): string => {
  const counts = countVerdicts(results);
  const runs = new Set(results.map((result) => result.runDir)).size;
  const sections: string[] = [];
  for (const verdict of VERDICT_ORDER) {
    if (verdict === "pass" || verdict === "not-applicable") {
      continue;
    }
    const matching = results.filter((result) => result.verdict === verdict);
    if (matching.length === 0) {
      continue;
    }
    sections.push(
      `${VERDICT_LABEL[verdict]} (${matching.length})\n${
        matching.map(renderFinding).join("\n\n")
      }`,
    );
  }
  const summary = VERDICT_ORDER
    .map((verdict) => `${VERDICT_LABEL[verdict]} ${counts[verdict]}`)
    .join("  ");
  const header = `${results.length} checks over ${runs} runs — ${summary}`;
  // What decides the exit is what the footer must say. Under an
  // expected-failures list the threshold selects which findings are
  // reconciled and the reconciliation decides the outcome, so a footer
  // promising a non-zero exit at the threshold would contradict a green run
  // that has findings in it.
  const footer = options.exitDecidedBy === "expected-failures"
    ? `findings at or above \`${failOn}\` are reconciled against the expected-failures list, which decides the exit`
    : `exiting non-zero at or above \`${failOn}\``;
  return [header, ...sections, footer].join("\n\n");
};

/** Runs the audit and returns the process exit code. */
export const runAuditCli = async (
  args: readonly string[],
  write: (text: string) => void = (text) => console.log(text),
): Promise<number> => {
  let options: AuditCliOptions;
  try {
    options = parseAuditCliArgs(args);
  } catch (error) {
    write(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return 2;
  }
  let expected: ExpectedPosture | undefined;
  if (options.expectedPosture !== undefined) {
    try {
      expected = await loadExpectedPosture(options.expectedPosture);
    } catch (error) {
      // A spec that asserts nothing, or that could not be read, is the same
      // failure as an unreadable command line: the audit did not run the
      // comparison the caller asked for, and a green exit would say it had.
      write(`${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  const families = await loadRunFamilies(options.paths);
  const results: CheckResult[] = families.flatMap((
    family,
  ) => [...auditRunFamily(family, RUN_CHECKS)]);
  if (asksDeploymentQuestion(options)) {
    const audit: DeploymentAudit = {
      families,
      paths: options.paths,
      expectRefusals: options.expectRefusals,
      ...(expected !== undefined ? { expected } : {}),
      ...(options.toolshedUrl !== undefined
        ? { toolshedMeta: await readToolshedMeta(options.toolshedUrl) }
        : {}),
    };
    for (const result of auditDeployment(audit)) results.push(result);
  }
  if (results.length === 0) {
    // Nothing was audited, so no threshold applies: a green exit here would
    // report the absence of a run as the absence of findings. This is the same
    // answer as an unreadable command line, because it is the same fact — the
    // audit did not run.
    write(
      `no run directory found under ${
        options.paths.map((path) => `\`${path}\``).join(", ")
      }; nothing was audited`,
    );
    return 2;
  }
  // Where we stand against the profile, printed on every run rather than left
  // in a document nobody re-reads — and held to the verdicts beside it, so a
  // status nothing tests cannot be asserted.
  const conformance = reconcileConformanceManifest(results);
  if (options.expectedFailures === undefined) {
    // One document, so a caller parsing `--json` gets the same top level
    // whichever flags were passed and a field it does not read is absent
    // rather than the whole document being a different kind of thing.
    write(
      options.json
        ? JSON.stringify({ results, conformance }, null, 2)
        : `${renderConformancePosition(conformance)}\n\n${
          renderAuditReport(results, options.failOn)
        }`,
    );
    // A manifest disagreeing with the checks covering it is our account of
    // ourselves being wrong, which is a failure whatever the threshold.
    return manifestReconciliationFails(conformance) ||
        results.some((result) =>
          verdictFailsThreshold(result.verdict, options.failOn)
        )
      ? 1
      : 0;
  }
  // Held to a list rather than to a threshold. A finding no entry covers
  // fails, and so does an entry that matched nothing — a closed gap takes its
  // entry with it, which is what stops the list becoming an excuse.
  let expectedFailures: readonly ExpectedFailure[];
  try {
    expectedFailures = readExpectedFailures(
      JSON.parse(await Deno.readTextFile(options.expectedFailures)),
    );
  } catch (error) {
    write(
      `could not read --expected-failures ${options.expectedFailures}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 2;
  }
  let reconciliation: ExpectedFailureReconciliation;
  try {
    reconciliation = reconcileExpectedFailures(
      results,
      expectedFailures,
      options.failOn,
    );
  } catch (error) {
    // A malformed entry is a configuration error, the same answer as an
    // unreadable command line: the audit did not run the comparison asked of
    // it, and a verdict here would report otherwise.
    write(
      `--expected-failures ${options.expectedFailures} is not usable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 2;
  }
  // One document in JSON mode: the position and the reconciliation are part
  // of the answer, not footers after it, and a caller piping this into a
  // parser gets one parse.
  write(
    options.json
      ? JSON.stringify({ results, conformance, reconciliation }, null, 2)
      : `${renderConformancePosition(conformance)}\n\n${
        renderAuditReport(results, options.failOn, {
          exitDecidedBy: "expected-failures",
        })
      }\n${renderReconciliation(reconciliation)}`,
  );
  // The expected-failures list excuses findings it names. It does not excuse
  // the manifest disagreeing with them: that is our account of ourselves being
  // wrong, which no ledger entry is a reason to pass.
  return manifestReconciliationFails(conformance) ||
      reconciliationFails(reconciliation)
    ? 1
    : 0;
};

if (import.meta.main) {
  Deno.exit(await runAuditCli(Deno.args));
}
