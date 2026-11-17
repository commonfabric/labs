/**
 * The lo-fi inductor's history: every judged proposal, newest first, with
 * whether it was accepted, why, and the rules it proposed or the reasons
 * they were refused.
 */

import { computed, NAME, pattern, UI, type VNode } from "commonfabric";
import { type HistoryEntry, MONO } from "./induction.ts";
import { describeRule } from "../shared/rule-grammar.ts";

interface HistoryCardInput {
  history: HistoryEntry[];
}

/** The inductor's judged proposals, newest first. */
export interface HistoryCardOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<HistoryCardInput, HistoryCardOutput>(
  ({ history }) => {
    const lines = computed(() =>
      [...history].reverse().map((entry) => ({
        round: `Round ${entry.round}: ${
          entry.accepted ? "accepted" : "rejected"
        }`,
        reason: entry.reason,
        detail: [
          ...entry.proposed.map(describeRule),
          ...entry.refusals,
        ],
      }))
    );
    const empty = computed(() => history.length === 0);

    return {
      [NAME]: "Proposals",
      [UI]: (
        <cf-card>
          <cf-vstack gap="2">
            <cf-heading level={5}>Proposals</cf-heading>
            {empty
              ? <cf-empty-state message="No proposals judged yet." />
              : null}
            {lines.map((entry) => (
              <cf-vstack gap="1">
                <cf-text variant="heading-sm">{entry.round}</cf-text>
                <cf-text tone="muted">{entry.reason}</cf-text>
                {entry.detail.map((line) => (
                  <cf-text variant="caption" style={MONO}>{line}</cf-text>
                ))}
              </cf-vstack>
            ))}
          </cf-vstack>
        </cf-card>
      ),
    };
  },
);
