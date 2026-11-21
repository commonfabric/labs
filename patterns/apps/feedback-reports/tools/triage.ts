/**
 * What triage does with a board's reports, decided without writing anything:
 * which reports may be filed (those whose sender is on the trusted list),
 * which links to a Topic count (those someone on the triagers list wrote),
 * which problem each report belongs to, and the Topic text for each problem.
 *
 * The text is a template over the reports' structured fields alone. No model
 * writes it, and a report's `words` never reach it: the Topic names each
 * report, and the words stay on the reports board. Every value the template
 * uses must match the strict shape `../fields.ts` gives it, an identifier or
 * a version, and one that does not is shown as `invalid` and counted, so
 * nothing a sender writes can put Markdown, a link or prose in a Topic.
 */

import { maxOf } from "@commonfabric/collections/math";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import {
  checked,
  FIELD,
  RELEASE,
  REPORT_ID,
  REPORT_NAME,
  TOPIC_ADDRESS,
} from "../fields.ts";
import type { Report } from "./read.ts";

/** What a value that fails its shape is shown as. */
export const INVALID = "invalid";

/** The most entries a list in a Topic shows before saying how many more. */
export const MAX_LISTED = 20;

/** The lines that mark the part of a Topic's body triage writes. */
export const SECTION_START = "<!-- feedback-triage: start; edits inside " +
  "are replaced, write notes outside -->";
export const SECTION_END = "<!-- feedback-triage: end -->";

/** What triage reads out of one report's structured fields, each checked. */
export interface Signals {
  kind: string;
  cause?: string;
  stop?: string;
  retries?: number;
  release?: string;

  /** Each failing probe, as `connector/probe`. */
  probes: string[];

  /** How many fields were present but failed their shape. */
  invalid: number;
}

/** One problem: the reports in it, the Topic it is filed under if any. */
export interface Problem {
  /** The Topic, absent for a problem this run files. */
  topic?: string;

  /** The reports already filed under the Topic. */
  filed: Report[];

  /** The new reports this run adds. */
  added: Report[];

  /** The keys any report of it matches on. */
  keys: Set<string>;
}

/** What a run of triage does. Report lists hold report ids. */
export interface Plan {
  /** A new Topic for each problem nothing on the board matches. */
  file: { title: string; body: string; reports: string[] }[];

  /** For each problem already filed, the section of its body triage writes,
   * and a comment when the new reports bring a release or a stop it did not
   * have. */
  update: {
    topic: string;
    section: string;
    comment?: string;
    reports: string[];
  }[];

  /** New reports whose sender is not on the trusted list. */
  untrusted: number;

  /** New reports whose sender could not be read. */
  unreadable: number;

  /** Links to a Topic that no one on the triagers list wrote, or that name no
   * Topic address; their reports count as new. */
  untrustedLinks: number;

  /** Fields of the reports this run files that failed their shape. */
  invalid: number;
}

/** Whether every principal in `authors` is in `trusted`, and one is named. */
function allIn(
  authors: readonly string[],
  trusted: ReadonlySet<string>,
): boolean {
  return authors.length > 0 && authors.every((author) => trusted.has(author));
}

/** Whether every principal `report`'s label names is in `trusted`. */
export function isTrusted(
  report: Report,
  trusted: ReadonlySet<string>,
): boolean {
  return report.unreadable !== true && allIn(report.authors, trusted);
}

/**
 * The Topic `report` is linked to, when the link names a Topic address and
 * everyone its label says wrote it is in `triagers`; else `undefined`.
 */
export function trustedTopic(
  report: Report,
  triagers: ReadonlySet<string>,
): string | undefined {
  const topic = checked(report.topic, TOPIC_ADDRESS);
  return topic !== undefined && report.topicUnreadable !== true &&
      allIn(report.topicAuthors ?? [], triagers)
    ? topic
    : undefined;
}

/** The DIDs a list names, one per line; `#` starts a comment. */
export function parseTrusted(text: string): Set<string> {
  return new Set(
    text.split("\n").map((line) => line.replace(/#.*/, "").trim()).filter((
      line,
    ) => line !== ""),
  );
}

/** The fields triage reads out of `report`'s structured part, checked. */
export function signalsOf(report: Report): Signals {
  const { want, cfs, failingProbes } = report.structured;
  let invalid = 0;
  const field = (value: unknown, shape: RegExp) => {
    if (value === undefined) return undefined;
    const ok = checked(value, shape);
    if (ok === undefined) invalid++;
    return ok;
  };
  const wanted = isObjectNotArray(want) ? want : {};
  const retries = wanted.retries;
  const cause = field(wanted.cause, FIELD);
  const stop = field(wanted.stop, FIELD);
  const release = isObjectNotArray(cfs)
    ? field(cfs.release, RELEASE)
    : undefined;
  const probes = Array.isArray(failingProbes)
    ? failingProbes.flatMap((probe) => {
      if (!isObjectNotArray(probe)) {
        invalid++;
        return [];
      }
      const connector = field(probe.connector, FIELD);
      const name = field(probe.probe, FIELD);
      return connector && name ? [`${connector}/${name}`] : [];
    })
    : [];
  return {
    kind: report.kind === "wish" ? "wish" : "broke",
    ...(cause ? { cause } : {}),
    ...(stop ? { stop } : {}),
    ...(typeof retries === "number" && Number.isSafeInteger(retries) &&
        retries >= 0
      ? { retries }
      : {}),
    ...(release ? { release } : {}),
    probes,
    invalid,
  };
}

/**
 * The keys a report groups on: its want's cause and stop together, and each
 * failing probe. Two reports belong to one problem when they share a key.
 */
export function keysOf(signals: Signals): string[] {
  return [
    ...(signals.cause === undefined
      ? []
      : [`want:${signals.cause}\n${signals.stop ?? ""}`]),
    ...signals.probes.map((probe) => `probe:${probe}`),
  ];
}

/**
 * The plan for `reports`: the new reports from senders in `trusted` grouped
 * with the problem already filed that shares a key with them, else with each
 * other, else each a problem of its own. A link counts only when someone in
 * `triagers` wrote it; a report linked by anyone else counts as new.
 */
export function planTriage(
  reports: readonly Report[],
  trusted: ReadonlySet<string>,
  triagers: ReadonlySet<string>,
): Plan {
  const problems: Problem[] = [];
  const byTopic = new Map<string, Problem>();
  let untrustedLinks = 0;
  const fresh: Report[] = [];
  for (const report of reports) {
    const topic = trustedTopic(report, triagers);
    if (report.topic !== undefined && topic === undefined) untrustedLinks++;
    if (topic === undefined) {
      fresh.push(report);
      continue;
    }
    // Only reports a trusted sender wrote say what a filed problem is.
    if (!isTrusted(report, trusted)) continue;
    let problem = byTopic.get(topic);
    if (problem === undefined) {
      problem = { topic, filed: [], added: [], keys: new Set() };
      byTopic.set(topic, problem);
      problems.push(problem);
    }
    problem.filed.push(report);
    for (const key of keysOf(signalsOf(report))) problem.keys.add(key);
  }
  let untrusted = 0;
  let unreadable = 0;
  for (const report of fresh.toSorted((a, b) => a.createdAt - b.createdAt)) {
    if (report.unreadable) {
      unreadable++;
      continue;
    }
    if (
      !isTrusted(report, trusted) || checked(report.id, REPORT_ID) === undefined
    ) {
      untrusted++;
      continue;
    }
    const keys = keysOf(signalsOf(report));
    let problem = problems.find((candidate) =>
      keys.some((key) => candidate.keys.has(key))
    );
    if (problem === undefined) {
      problem = { filed: [], added: [], keys: new Set() };
      problems.push(problem);
    }
    problem.added.push(report);
    for (const key of keys) problem.keys.add(key);
  }
  const plan: Plan = {
    file: [],
    update: [],
    untrusted,
    unreadable,
    untrustedLinks,
    invalid: 0,
  };
  for (const problem of problems) {
    if (problem.added.length === 0) continue;
    const ids = problem.added.map((report) => report.id);
    const all = [...problem.filed, ...problem.added];
    plan.invalid += problem.added.reduce(
      (sum, report) => sum + invalidIn(report),
      0,
    );
    if (problem.topic === undefined) {
      plan.file.push({
        title: titleOf(all),
        body: sectionOf(all),
        reports: ids,
      });
      continue;
    }
    const comment = commentOf(problem.filed, problem.added);
    plan.update.push({
      topic: problem.topic,
      section: sectionOf(all),
      ...(comment === undefined ? {} : { comment }),
      reports: ids,
    });
  }
  return plan;
}

/** How many of `report`'s templated fields fail their shape. */
function invalidIn(report: Report): number {
  return signalsOf(report).invalid +
    (checked(report.name, REPORT_NAME) === undefined ? 1 : 0);
}

/** `report`'s name, or {@link INVALID}. */
function nameOf(report: Report): string {
  return checked(report.name, REPORT_NAME) ?? INVALID;
}

/** The part of the product a problem shows in. */
function surfaceOf(signals: Signals): string {
  if (signals.cause === undefined && signals.probes.length > 0) {
    return signals.probes[0].split("/")[0];
  }
  return "Weaver";
}

/** The title of the Topic for the problem `reports` make up. */
export function titleOf(reports: readonly Report[]): string {
  const signals = signalsOf(reports[0]);
  const what = signals.cause !== undefined
    ? signals.stop === undefined
      ? signals.cause
      : `${signals.cause} at ${signals.stop}`
    : signals.probes.length > 0
    ? `probe ${signals.probes[0].split("/")[1]} fails`
    : signals.kind === "wish"
    ? "a wish"
    : "a problem";
  return `[feedback] ${surfaceOf(signals)}: ${what}`;
}

/** What the Topic asks of the engineer reading it. */
function askOf(reports: readonly Report[]): string {
  return reports.every((report) => report.kind === "wish")
    ? "Make a product call: the product works as built, and the reporters " +
      "want something else."
    : "Find the cause and fix it, or say why it is the reporters' setup.";
}

/** The values `pick` gives across `reports`, each once, in order. */
function distinct(
  reports: readonly Report[],
  pick: (signals: Signals) => readonly (string | undefined)[],
): string[] {
  return [
    ...new Set(
      reports.flatMap((report) => pick(signalsOf(report))).flatMap((value) =>
        value === undefined ? [] : [value]
      ),
    ),
  ];
}

/** `values` as a list of at most {@link MAX_LISTED}, or `unknown`. */
export function listed(values: readonly string[]): string {
  if (values.length === 0) return "unknown";
  const shown = values.slice(0, MAX_LISTED).join(", ");
  return values.length > MAX_LISTED
    ? `${shown}, +${values.length - MAX_LISTED} more`
    : shown;
}

/**
 * The section of the Topic's body triage writes for the problem `reports`
 * make up, between its marker lines.
 */
export function sectionOf(reports: readonly Report[]): string {
  const retries = reports.flatMap((report) => {
    const { retries } = signalsOf(report);
    return retries === undefined ? [] : [retries];
  });
  const invalid = reports.reduce((sum, report) => sum + invalidIn(report), 0);
  return [
    SECTION_START,
    `What is asked: ${askOf(reports)}`,
    "",
    `- Reports: ${listed(reports.map(nameOf))}`,
    `- Kind: ${listed(distinct(reports, (s) => [s.kind]))}`,
    `- Cause: ${listed(distinct(reports, (s) => [s.cause]))}`,
    `- Stop: ${listed(distinct(reports, (s) => [s.stop]))}`,
    `- Retries: ${retries.length === 0 ? "unknown" : maxOf(retries)}`,
    `- Failing probes: ${listed(distinct(reports, (s) => s.probes))}`,
    `- CFS releases: ${listed(distinct(reports, (s) => [s.release]))}`,
    `- Count: ${reports.length}`,
    ...(invalid === 0 ? [] : [`- Fields that failed their checks: ${invalid}`]),
    "",
    "Filed by triage from the reports' structured fields. Each report is on " +
    "the feedback reports board; what the reporters wrote stays there.",
    SECTION_END,
  ].join("\n");
}

/**
 * `body` with the section triage writes replaced by `section`, and every
 * line outside it as it was. A body with no whole section gets `section`
 * after what it holds.
 */
export function withSection(body: string, section: string): string {
  const start = body.indexOf(SECTION_START);
  const end = start < 0 ? -1 : body.indexOf(SECTION_END, start);
  if (start < 0 || end < 0) {
    return body.trim() === "" ? section : `${body.trimEnd()}\n\n${section}`;
  }
  return body.slice(0, start) + section +
    body.slice(end + SECTION_END.length);
}

/**
 * The comment the reports `added` make on a problem already holding
 * `filed`: what releases and stops they bring that it did not have, or
 * `undefined` when they bring none.
 */
export function commentOf(
  filed: readonly Report[],
  added: readonly Report[],
): string | undefined {
  const had = (pick: (signals: Signals) => readonly (string | undefined)[]) =>
    new Set(distinct(filed, pick));
  const releases = distinct(added, (s) => [s.release]).filter((release) =>
    !had((s) => [s.release]).has(release)
  );
  const stops = distinct(added, (s) => [s.stop]).filter((stop) =>
    !had((s) => [s.stop]).has(stop)
  );
  if (releases.length === 0 && stops.length === 0) return undefined;
  return [
    `New reports: ${listed(added.map(nameOf))}.`,
    ...(releases.length === 0
      ? []
      : [`New CFS releases: ${listed(releases)}.`]),
    ...(stops.length === 0 ? [] : [`New stops: ${listed(stops)}.`]),
    `${filed.length + added.length} reports now.`,
  ].join("\n");
}
