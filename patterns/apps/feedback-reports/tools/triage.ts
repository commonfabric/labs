/**
 * What triage does with a board's reports, decided without writing anything:
 * which reports may be filed (those whose sender is on the trusted list),
 * which problem each belongs to, and the Topic text for each problem. The
 * text is a template over the reports' structured fields alone. No model
 * writes it, and a report's `words` never reach it: the Topic names each
 * report, and the words stay on the reports board.
 */

import { maxOf } from "@commonfabric/collections/math";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { Report } from "./read.ts";

/** What triage reads out of one report's structured fields. */
export interface Signals {
  kind: string;
  cause?: string;
  stop?: string;
  retries?: number;
  release?: string;

  /** Each failing probe, as `connector/probe`. */
  probes: string[];
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

/** What a run of triage does. */
export interface Plan {
  /** A new Topic for each problem nothing on the board matches. */
  /** Each lists the ids of the reports it files. */
  file: { title: string; body: string; reports: string[] }[];

  /** For each problem already filed, its new body, and a comment when the
   * new reports bring a release or a stop it did not have. */
  update: {
    topic: string;
    body: string;
    comment?: string;
    reports: string[];
  }[];

  /** New reports whose sender is not on the trusted list. */
  untrusted: number;

  /** New reports whose sender could not be read. */
  unreadable: number;
}

/** Whether every principal `report`'s label names is in `trusted`. */
export function isTrusted(
  report: Report,
  trusted: ReadonlySet<string>,
): boolean {
  return report.unreadable !== true && report.authors.length > 0 &&
    report.authors.every((author) => trusted.has(author));
}

/** The trusted DIDs a list names, one per line; `#` starts a comment. */
export function parseTrusted(text: string): Set<string> {
  return new Set(
    text.split("\n").map((line) => line.replace(/#.*/, "").trim()).filter((
      line,
    ) => line !== ""),
  );
}

/** The fields triage reads out of `report`'s structured part. */
export function signalsOf(report: Report): Signals {
  const { want, cfs, failingProbes } = report.structured;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  const wanted = isObjectNotArray(want) ? want : {};
  const retries = wanted.retries;
  const cause = text(wanted.cause);
  const stop = text(wanted.stop);
  const release = isObjectNotArray(cfs) ? text(cfs.release) : undefined;
  const probes = Array.isArray(failingProbes)
    ? failingProbes.flatMap((probe) => {
      if (!isObjectNotArray(probe)) return [];
      const connector = text(probe.connector);
      const name = text(probe.probe);
      return connector && name ? [`${connector}/${name}`] : [];
    })
    : [];
  return {
    kind: report.kind,
    ...(cause ? { cause } : {}),
    ...(stop ? { stop } : {}),
    ...(typeof retries === "number" && Number.isFinite(retries)
      ? { retries }
      : {}),
    ...(release ? { release } : {}),
    probes,
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
 * The plan for `reports` given the senders in `trusted`: the new trusted
 * reports grouped with the problem already filed that shares a key with
 * them, else with each other, else each a problem of its own.
 */
export function planTriage(
  reports: readonly Report[],
  trusted: ReadonlySet<string>,
): Plan {
  const problems: Problem[] = [];
  const byTopic = new Map<string, Problem>();
  // Only reports a trusted sender wrote say what a filed problem is, since
  // anyone who may write the board may also link a report to a Topic.
  for (const report of reports) {
    if (report.topic === undefined || !isTrusted(report, trusted)) continue;
    let problem = byTopic.get(report.topic);
    if (problem === undefined) {
      problem = { topic: report.topic, filed: [], added: [], keys: new Set() };
      byTopic.set(report.topic, problem);
      problems.push(problem);
    }
    problem.filed.push(report);
    for (const key of keysOf(signalsOf(report))) problem.keys.add(key);
  }
  let untrusted = 0;
  let unreadable = 0;
  const fresh = reports.filter((report) => report.topic === undefined)
    .toSorted((a, b) => a.createdAt - b.createdAt);
  for (const report of fresh) {
    if (report.unreadable) {
      unreadable++;
      continue;
    }
    if (!isTrusted(report, trusted)) {
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
  const plan: Plan = { file: [], update: [], untrusted, unreadable };
  for (const problem of problems) {
    if (problem.added.length === 0) continue;
    const reports = problem.added.map((report) => report.id);
    const all = [...problem.filed, ...problem.added];
    if (problem.topic === undefined) {
      plan.file.push({ title: titleOf(all), body: bodyOf(all), reports });
      continue;
    }
    const comment = commentOf(problem.filed, problem.added);
    plan.update.push({
      topic: problem.topic,
      body: bodyOf(all),
      ...(comment === undefined ? {} : { comment }),
      reports,
    });
  }
  return plan;
}

/**
 * An identifier from a report as plain words: separators as spaces, and
 * nothing but letters, digits and a little punctuation, so that a value can
 * carry no Markdown, link or line break into a Topic.
 */
export function plainWords(value: string): string {
  const words = value.replace(/[-_]+/g, " ").replace(/[^\p{L}\p{N} .:/]/gu, "")
    .replace(/\s+/g, " ").trim();
  return words.length > 80 ? `${words.slice(0, 79)}…` : words;
}

/** The part of the product a problem shows in. */
function surfaceOf(signals: Signals): string {
  if (signals.cause === undefined && signals.probes.length > 0) {
    return plainWords(signals.probes[0].split("/")[0]);
  }
  return "Weaver";
}

/** The title of the Topic for the problem `reports` make up. */
export function titleOf(reports: readonly Report[]): string {
  const signals = signalsOf(reports[0]);
  const what = signals.cause !== undefined
    ? [
      plainWords(signals.cause),
      ...(signals.stop === undefined
        ? []
        : [`stops at ${plainWords(signals.stop)}`]),
    ].join(", ")
    : signals.probes.length > 0
    ? `probe ${
      plainWords(signals.probes[0].split("/").slice(1).join("/"))
    } fails`
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

/** A list of values as plain words, or `unknown`. */
function listed(values: readonly string[]): string {
  return values.length === 0 ? "unknown" : values.map(plainWords).join(", ");
}

/** The body of the Topic for the problem `reports` make up. */
export function bodyOf(reports: readonly Report[]): string {
  const retries = reports.flatMap((report) => {
    const { retries } = signalsOf(report);
    return retries === undefined ? [] : [retries];
  });
  return [
    `What is asked: ${askOf(reports)}`,
    "",
    `- Reports: ${reports.map((report) => plainWords(report.name)).join(", ")}`,
    `- Kind: ${listed(distinct(reports, (s) => [s.kind]))}`,
    `- Cause: ${listed(distinct(reports, (s) => [s.cause]))}`,
    `- Stop: ${listed(distinct(reports, (s) => [s.stop]))}`,
    `- Retries: ${retries.length === 0 ? "unknown" : maxOf(retries)}`,
    `- Failing probes: ${listed(distinct(reports, (s) => s.probes))}`,
    `- CFS releases: ${listed(distinct(reports, (s) => [s.release]))}`,
    `- Count: ${reports.length}`,
    "",
    "Filed by triage from the reports' structured fields. Each report is on " +
    "the feedback reports board; what the reporters wrote " +
    "stays there.",
  ].join("\n");
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
    `New reports: ${
      added.map((report) => plainWords(report.name)).join(", ")
    }.`,
    ...(releases.length === 0
      ? []
      : [`New CFS releases: ${listed(releases)}.`]),
    ...(stops.length === 0 ? [] : [`New stops: ${listed(stops)}.`]),
    `${filed.length + added.length} reports now.`,
  ].join("\n");
}
