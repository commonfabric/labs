/** Linked book recommendations and the progress of the run that selected them. */
import {
  computed,
  NAME,
  pattern,
  type ReadonlyCell,
  UI,
  type VNode,
} from "commonfabric";
import type { AgentRunUsage } from "../system/agent-run.tsx";

/** A book held in its own cell, independently of the reader's list. */
export interface Book {
  title: string;
  author: string;
}

/** One recommendation keeps the selected book's live reference. */
export interface BookPick {
  book: ReadonlyCell<Book>;
  why: string;
}

/** The agent returns exactly five picks under the request's result schema. */
export interface Recommendations {
  picks: BookPick[];
  sources?: ReadonlyCell<unknown>[];
}

/** The fields this display reads from an agent's state and run record. */
export interface RecommendationState {
  pending: boolean;
  result?: Recommendations;
  error?: string;
  run?: { usage?: AgentRunUsage };
}

/** The display exposes the same linked result it receives. */
export interface RecommendationViewOutput {
  [NAME]: string;
  [UI]: VNode;
  state: RecommendationState;
}

export default pattern<
  { state: RecommendationState },
  RecommendationViewOutput
>(({ state }) => {
  const picks = computed(() => state.result?.picks ?? []);
  const usage = computed(() => {
    const value = state.run?.usage;
    if (value === undefined) return "Usage unavailable";
    return [
      value.totalTokens !== undefined ? `${value.totalTokens} tokens` : "",
      value.costUsd !== undefined
        ? `Reported cost: $${value.costUsd.toFixed(6)}`
        : "",
      value.estimatedCostUsd !== undefined
        ? `Estimated cost: $${value.estimatedCostUsd.toFixed(6)}`
        : "",
      value.estimateWithheldReason !== undefined
        ? `Estimate withheld: ${value.estimateWithheldReason}`
        : "",
    ].filter((part) => part !== "").join(" · ") || "Usage unavailable";
  });
  return {
    [NAME]: "Book recommendations",
    [UI]: (
      <cf-theme theme={{ density: "comfortable", borderRadius: "12px" }}>
        <cf-vstack gap="4" padding="4">
          <h2>Five books for you</h2>
          {state.pending ? <p>Finding five books…</p> : null}
          {state.error ? <p role="alert">{state.error}</p> : null}
          {picks.map((pick) => (
            <cf-card>
              <cf-vstack gap="2">
                <strong>{computed(() => pick.book.get().title)}</strong>
                <span>{computed(() => pick.book.get().author)}</span>
                <p>{pick.why}</p>
              </cf-vstack>
            </cf-card>
          ))}
          <small>{usage}</small>
        </cf-vstack>
      </cf-theme>
    ),
    state,
  };
});
