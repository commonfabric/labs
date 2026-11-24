/** Recorded research selections for the author's reuse-decision tests. */

import type {
  HarnessResearchPatternRecord,
  HarnessResearchRunSummary,
} from "../../src/contracts/research.ts";

/** Mailbox primitive selected by both recorded research calls. */
const mailbox = {
  "patternId": "-xx1hxtvAbY7AL6FeYuQWuEzbC0nOpUOHgXseIac2_w",
  "description":
    "Reads this month's newest email headers out of a mail connector's `messages` table \u2014 id, subject, snippet, sender and received date, and no body column at all \u2014 with a list `[UI]` over them. A live message is `deleted_at IS NULL` here: this store marks a deleted message by stamping that column, which is the opposite spelling to the `deleted = 0` integer flag a connector ledger such as Plaid's uses, so the two cannot be filtered the same way. `month` picks the window as `YYYY-MM` and defaults to the calendar month the database's own clock is in; `limit` caps the rows at 200 unless the caller says otherwise, and never above 500 whatever it says.",
  "hashtags": [
    "gmail",
    "email",
    "mail",
    "messages",
    "headers",
    "inbox",
    "month",
  ],
  "importHint":
    'import X from "cf:pattern:-xx1hxtvAbY7AL6FeYuQWuEzbC0nOpUOHgXseIac2_w"',
  "argumentType":
    "{\n  mail: SqliteDb,\n  month?: string,\n  limit?: number\n}",
  "resultType":
    "{\n  month: string,\n  headers: MailboxHeader[],\n  headerCount: number,\n  pending: boolean,\n  errorMessage: string\n}",
  "sourceIdentityVerified": true,
} satisfies HarnessResearchPatternRecord;

/**
 * Tasks and findings from rehearsal b544047f. Source citations, labels, and
 * handle bindings are omitted: these cases exercise the author's reuse
 * decision over already-admitted selections.
 */
export const REUSE_RESEARCH_RUNS = [
  {
    "type": "cf-harness.research-run",
    "researchRunId": "b544047f-dc90-4d4b-a90d-60cb3bc4a71e:research:1",
    "outputId": "b544047f-dc90-4d4b-a90d-60cb3bc4a71e:research:1",
    "completedAt": "2026-09-18T00:00:29.291Z",
    "kit": {
      "purpose": "orient",
      "status": "incomplete",
      "task": "what have I been working on",
      "summary":
        "Your available data suggests recent work is distributed across Linear (2,792 issues and 3,081 comments), email (1,739 messages), and Google Drive (571 files). I could not determine the actual project names or topics because handle descriptions expose schemas and counts, not record contents. A query/summarization run over those three sources is needed.",
      "missing": [
        "Actual record contents or a run that queries and summarizes the Linear, Drive, and email handles.",
      ],
      "inputs": [],
      "rules": [],
      "sources": [],
      "patterns": [
        mailbox,
      ],
      "leads": [],
      "questions": [],
      "availableHandleTokens": [],
    },
    "confirmedPatterns": [
      mailbox,
    ],
    "describedHandles": [],
  },
  {
    "type": "cf-harness.research-run",
    "researchRunId": "b544047f-dc90-4d4b-a90d-60cb3bc4a71e:research:10",
    "outputId": "b544047f-dc90-4d4b-a90d-60cb3bc4a71e:research:10",
    "completedAt": "2026-09-18T00:02:08.899Z",
    "kit": {
      "purpose": "answer",
      "status": "incomplete",
      "task":
        "How should I build a Common Fabric piece that answers 'what have I been working on' by querying recent Linear issues/comments, Google Drive file envelopes, and email messages from the described connector schemas? Need bounded per-session queries under confidentiality ceiling, pending/error handling, and ideally a rendered summary that can synthesize project/topic names from protected strings without releasing them to the parent. Provide supported TypeScript/TSX source structure and relevant runtime APIs.",
      "summary":
        "Bind Linear, Drive, and mail as session-scoped SqliteDb inputs. Query only bounded recent rows: Linear issues/comments, Drive `records_drive_file`, and email headers/messages. Keep envelope/body strings inside the pattern and synthesize/render the summary there; expose only aggregate/status outputs to the parent. The available schemas do not describe the protected envelope payload format, so the exact project/topic extraction logic cannot be completed safely yet. The existing email-header primitive is reusable for bounded, pending/error-aware mail reads.",
      "missing": [
        "The protected JSON/envelope contract for Linear issues/comments and Drive files: field names for title, description, comment text, timestamps, and project/topic identifiers are not described.",
        "The exact confidentiality policy/ceiling and approved output surface for synthesized protected strings. Without it, no safe parent-visible summary field can be declared.",
      ],
      "inputs": [],
      "rules": [],
      "sources": [],
      "patterns": [
        mailbox,
      ],
    },
    "confirmedPatterns": [
      mailbox,
    ],
    "describedHandles": [],
  },
] satisfies [HarnessResearchRunSummary, HarnessResearchRunSummary];
