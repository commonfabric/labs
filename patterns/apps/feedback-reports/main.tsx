/**
 * A team's reports board: one record per problem report a person's service
 * sends in, and the Topic triage filed each one under. The sender of a report
 * is not a field of it: the runtime labels each record `authored-by` the
 * principal whose `addReport` call wrote it, and a reader takes the sender
 * from that label.
 */
import {
  type AuthoredByCurrentUser,
  Default,
  handler,
  type JSONValue,
  lift,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

/** What a report is about: something that broke, or something wished for. */
export type ReportKind = "broke" | "wish";

/** The kinds `addReport` accepts. */
export const REPORT_KINDS: readonly string[] = ["broke", "wish"];

/** The most characters a report's `words` may hold. */
export const MAX_WORDS = 4000;

/**
 * The structured part of a report: `source` and whatever else the sender
 * knew. Only `source` is required. Every other field is kept as it was sent,
 * known or not, so a sender can add a field without the board changing, and a
 * reader ignores a field it does not know. The fields a sender writes today
 * are in this directory's README.
 */
export interface ReportStructured {
  /** Where in the sender's app the report started, such as `failure-card`. */
  source: string;
  [field: string]: JSONValue;
}

/** A report as the board stores it. */
export interface ReportRecord {
  /** The report's name, unique on the board, such as `quiet-heron-41`. */
  name: string;
  kind: ReportKind;

  /** The person's own words, as the sender scrubbed them. */
  words?: string;
  structured: ReportStructured;

  /** When the board stored the report, in milliseconds since the epoch. */
  createdAt: number;
}

/**
 * A stored report. Only `addReport` writes one, and the runtime labels each
 * write `authored-by` the principal it acts for, which is how a reader knows
 * who sent the report.
 */
export type StoredReport = AuthoredByCurrentUser<
  WriteAuthorizedBy<ReportRecord, typeof addReportHandler>
>;

/** The cell holding the board's reports, in the order they arrived. */
export type ReportsCell = Writable<StoredReport[] | Default<[]>>;

/**
 * The cell holding the Topic each linked report was filed under, by report
 * name. Kept beside the reports rather than in them, so that a report stays
 * written by its sender alone.
 */
// deno-lint-ignore ban-types
export type TopicOfCell = Writable<Default<Record<string, string>, {}>>;

export interface FeedbackReportsInput {
  /** The reports. `addReport` appends here. */
  reports?: ReportsCell;

  /** The Topic each linked report was filed under. `linkTopic` writes here,
   * one key per call. */
  topicOf?: TopicOfCell;
}

export interface AddReportEvent {
  /** The agent sending the report, as Topics verbs take one. The author is
   * the principal whose key signs the call. */
  agentName: string;
  name: string;
  kind: string;
  words?: string;
  structured: ReportStructured;
}

export interface AddReportResult {
  /** The name the report was stored under. */
  name: string;
}

export interface LinkTopicEvent {
  /** The agent linking the report, such as the triage command's. */
  agentName: string;

  /** The report's name. */
  name: string;

  /** The Topic the report was filed under, as an address. */
  topic: string;
}

export interface LinkTopicResult {
  name: string;
  topic: string;
}

/** One row of the board's index: a report's scalars and its Topic. */
export interface ReportRow {
  name: string;
  kind: string;
  source: string;
  createdAt: number;

  /** The Topic the report was filed under, absent for a new report. */
  topic?: string;
}

export interface FeedbackReportsOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The reports, in the order they arrived. */
  reports: ReportRecord[];

  /** The Topic each linked report was filed under, by report name. */
  // deno-lint-ignore ban-types
  topicOf: Default<Record<string, string>, {}>;

  /** One row per report, without its words, and the Topic it is filed
   * under. */
  index: ReportRow[];

  /** How many reports have no Topic yet. */
  newCount: number;

  /** Store a report. Refuses a duplicate or malformed one. */
  addReport: Stream<AddReportEvent, AddReportResult>;

  /** Record the Topic a report was filed under. */
  linkTopic: Stream<LinkTopicEvent, LinkTopicResult>;
}

/**
 * Rejects a call loudly, with a stable code a client can act on: a silent
 * return reads as success to a headless caller. The message is
 * `<verb> rejected: <code>: <reason>`.
 */
export const rejectReport = (
  verb: string,
  code: string,
  reason: string,
): never => {
  throw new Error(`${verb} rejected: ${code}: ${reason}`);
};

/**
 * Why `addReport` refuses `event` on a board already holding reports named
 * `taken`, as a code and a reason, or `undefined` when it accepts it.
 */
export function addReportRefusal(
  event: Partial<AddReportEvent>,
  taken: readonly string[],
): { code: string; reason: string } | undefined {
  const name = typeof event.name === "string" ? event.name.trim() : "";
  const structured = event.structured;
  if (typeof event.agentName !== "string" || !event.agentName.trim()) {
    return { code: "unsigned", reason: "agentName must be non-blank" };
  }
  if (!name) return { code: "missing-name", reason: "name is required" };
  if (typeof event.kind !== "string" || !event.kind) {
    return { code: "missing-kind", reason: "kind is required" };
  }
  if (!REPORT_KINDS.includes(event.kind)) {
    return { code: "bad-kind", reason: "kind must be broke or wish" };
  }
  if (
    typeof structured !== "object" || structured === null ||
    typeof structured.source !== "string" || !structured.source.trim()
  ) {
    return {
      code: "missing-source",
      reason: "structured.source is required",
    };
  }
  if (event.words !== undefined && typeof event.words !== "string") {
    return { code: "bad-words", reason: "words must be a string" };
  }
  if ((event.words ?? "").length > MAX_WORDS) {
    return {
      code: "words-too-long",
      reason: `words must be at most ${MAX_WORDS} characters`,
    };
  }
  if (taken.includes(name)) {
    return {
      code: "duplicate-name",
      reason: `a report named ${name} is already on the board`,
    };
  }
  return undefined;
}

/** The state `addReport` writes, named so `StoredReport` can refer to the
 * handler without referring to itself. */
interface AddReportState {
  reports: ReportsCell;
}

/** Handles `addReport`. */
const addReportHandler = handler<
  AddReportEvent,
  AddReportState,
  AddReportResult
>((event, { reports }) => {
  const taken = reports.get().map((report) => report.name);
  const refusal = addReportRefusal(event, taken);
  if (refusal) rejectReport("addReport", refusal.code, refusal.reason);
  const name = event.name.trim();
  const kind: ReportKind = event.kind === "wish" ? "wish" : "broke";
  reports.push({
    name,
    kind,
    ...(event.words === undefined ? {} : { words: event.words }),
    structured: event.structured,
    createdAt: Date.now(),
  });
  return { name };
});

interface LinkTopicState {
  reports: ReportsCell;
  topicOf: TopicOfCell;
}

/** Handles `linkTopic`. A report keeps the first Topic it is linked to: a
 * second call naming the same Topic changes nothing, and one naming another
 * is refused. */
const linkTopicHandler = handler<
  LinkTopicEvent,
  LinkTopicState,
  LinkTopicResult
>(({ agentName, name, topic }, { reports, topicOf }) => {
  if (typeof agentName !== "string" || !agentName.trim()) {
    rejectReport("linkTopic", "unsigned", "agentName must be non-blank");
  }
  const reportName = typeof name === "string" ? name.trim() : "";
  const topicAddress = typeof topic === "string" ? topic.trim() : "";
  if (!reportName) {
    rejectReport("linkTopic", "missing-name", "name is required");
  }
  if (!topicAddress) {
    rejectReport("linkTopic", "missing-topic", "topic is required");
  }
  if (!reports.get().some((report) => report.name === reportName)) {
    rejectReport(
      "linkTopic",
      "unknown-report",
      `no report named ${reportName} is on the board`,
    );
  }
  const linked = topicOf.get()[reportName];
  if (linked !== undefined && linked !== topicAddress) {
    rejectReport(
      "linkTopic",
      "already-linked",
      `${reportName} is already filed under ${linked}`,
    );
  }
  if (linked === undefined) topicOf.key(reportName).set(topicAddress);
  return { name: reportName, topic: topicAddress };
});

/** The board's index rows, joining each report with its Topic. */
const indexOf = lift((
  { reports, topicOf }: {
    reports: ReportRecord[];
    topicOf: Record<string, string>;
  },
): ReportRow[] =>
  (reports ?? []).map((report) => {
    const topic = topicOf?.[report.name];
    return {
      name: report.name,
      kind: report.kind,
      source: report.structured?.source ?? "",
      createdAt: report.createdAt,
      ...(topic === undefined ? {} : { topic }),
    };
  })
);

const newCountOf = lift((rows: ReportRow[]): number =>
  (rows ?? []).filter((row) => row.topic === undefined).length
);

export default pattern<FeedbackReportsInput, FeedbackReportsOutput>(
  ({ reports, topicOf }) => {
    const index = indexOf({ reports, topicOf });
    const newCount = newCountOf(index);
    return {
      [NAME]: "Feedback reports",
      [UI]: (
        <div style="padding: 1rem; font-family: system-ui, sans-serif;">
          <h2 style="margin: 0 0 0.5rem;">Feedback reports</h2>
          <p style="margin: 0 0 1rem;">{newCount} new</p>
          <ul style="margin: 0; padding-left: 1.25rem;">
            {index.map((row) => (
              <li>
                <code>{row.name}</code> {row.kind} from {row.source}{" "}
                {row.topic ?? "new"}
              </li>
            ))}
          </ul>
        </div>
      ),
      reports,
      topicOf,
      index,
      newCount,
      addReport: addReportHandler({ reports }),
      linkTopic: linkTopicHandler({ reports, topicOf }),
    };
  },
);
