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

import { addReportRefusal, REPORT_ID, TOPIC_ADDRESS } from "./fields.ts";

export { MAX_WORDS, REPORT_KINDS } from "./fields.ts";

/** What a report is about: something that broke, or something wished for. */
export type ReportKind = "broke" | "wish";

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
  /** The report's id, unique on the board: 32 lowercase hex characters the
   * sender derives, so a resend carries the same one. */
  id: string;

  /** The report's name, a label for people such as `quiet-heron-41`. Two
   * senders may use the same one. */
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
 * A report's Topic address. Only `linkTopic` writes one, and the runtime
 * labels each write `authored-by` the principal it acts for, so a reader
 * can honour only links someone it trusts wrote.
 */
export type TopicLink = AuthoredByCurrentUser<
  WriteAuthorizedBy<string, typeof linkTopicHandler>
>;

/**
 * The cell holding the Topic each linked report was filed under, by report
 * id. Kept beside the reports rather than in them, so that a report stays
 * written by its sender alone.
 */
export interface TopicOfMap {
  [id: string]: TopicLink;
}

/** The same, as the cell `linkTopic` writes. */
// deno-lint-ignore ban-types
export type TopicOfCell = Writable<Default<TopicOfMap, {}>>;

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
  id: string;
  name: string;
  kind: string;
  words?: string;
  structured: ReportStructured;
}

export interface AddReportResult {
  /** The id the report was stored under. */
  id: string;
  name: string;
}

export interface LinkTopicEvent {
  /** The agent linking the report, such as the triage command's. */
  agentName: string;

  /** The report's id. */
  id: string;

  /** The Topic the report was filed under, as an address. */
  topic: string;
}

export interface LinkTopicResult {
  id: string;
  topic: string;
}

/** One row of the board's index: a report's scalars and its Topic. */
export interface ReportRow {
  id: string;
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

  /** The Topic each linked report was filed under, by report id. */
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
  const taken = reports.get().map((report) => report.id);
  const refusal = addReportRefusal(event, taken);
  if (refusal) rejectReport("addReport", refusal.code, refusal.reason);
  const name = event.name.trim();
  const kind: ReportKind = event.kind === "wish" ? "wish" : "broke";
  reports.push({
    id: event.id,
    name,
    kind,
    ...(event.words === undefined ? {} : { words: event.words }),
    structured: event.structured,
    createdAt: Date.now(),
  });
  return { id: event.id, name };
});

interface LinkTopicState {
  reports: ReportsCell;
  topicOf: TopicOfCell;
}

/** Handles `linkTopic`. Linking a report to the Topic it is linked to
 * changes nothing; linking it to another replaces the link. Anyone who may
 * write the board may call this, so a link is no fact until a reader checks
 * who wrote it: a first-link-wins rule would let any writer claim a report
 * before triage reached it. */
const linkTopicHandler = handler<
  LinkTopicEvent,
  LinkTopicState,
  LinkTopicResult
>(({ agentName, id, topic }, { reports, topicOf }) => {
  if (typeof agentName !== "string" || !agentName.trim()) {
    rejectReport("linkTopic", "unsigned", "agentName must be non-blank");
  }
  const reportId = typeof id === "string" ? id : "";
  const topicAddress = typeof topic === "string" ? topic.trim() : "";
  if (!REPORT_ID.test(reportId)) {
    rejectReport(
      "linkTopic",
      "bad-id",
      "id must be 32 lowercase hex characters",
    );
  }
  if (!TOPIC_ADDRESS.test(topicAddress)) {
    rejectReport(
      "linkTopic",
      "bad-topic",
      "topic must be a Topic address, top/<n> or of:…",
    );
  }
  if (!reports.get().some((report) => report.id === reportId)) {
    rejectReport(
      "linkTopic",
      "unknown-report",
      `no report with id ${reportId} is on the board`,
    );
  }
  topicOf.key(reportId).set(topicAddress);
  return { id: reportId, topic: topicAddress };
});

/** The board's index rows, joining each report with its Topic. */
const indexOf = lift((
  { reports, topicOf }: {
    reports: ReportRecord[];
    topicOf: Record<string, string>;
  },
): ReportRow[] =>
  (reports ?? []).map((report) => {
    const topic = topicOf?.[report.id];
    return {
      id: report.id,
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
