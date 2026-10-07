/** Exercises the production overview presentation across native outcomes. */

import {
  action,
  assert,
  type AsyncResult,
  type BuiltInLLMMessage,
  computed,
  FabricUnavailable,
  handler,
  type HasError,
  hasError,
  type IsPending,
  isPending,
  type IsSyncing,
  isSyncing,
  observeAvailability,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findElement, textContent } from "../test/vnode-helpers.ts";
import {
  SpaceOverviewPresentation,
  type SpaceOverviewResult,
} from "./space-overview.tsx";

const addMessage = handler<BuiltInLLMMessage, Record<string, never>>(() => {});

export default pattern(() => {
  const request = new Writable<AsyncResult<SpaceOverviewResult> | undefined>();
  const messages = new Writable<BuiltInLLMMessage[]>([]);
  const pending = new Writable(false);
  const subject = SpaceOverviewPresentation({
    overviewRequest: request,
    messages,
    addMessage: addMessage({}),
    pending,
  });
  const summary = observeAvailability(subject.summary);
  const summaryState = computed(() => {
    if (isPending(summary)) return "pending";
    if (isSyncing(summary)) return "syncing";
    if (hasError(summary)) return summary.errorMessage;
    return summary;
  });

  return {
    [TESTS]: [
      {
        action: action(() =>
          request.set({
            headline: "An active knowledge space",
            themes: [{
              name: "Research",
              description: "Open questions",
              relatedPieces: [],
            }],
            connections: [{
              description: "Notes connect to projects",
              pieceNames: [],
            }],
            suggestions: ["Explore the notes"],
          })
        ),
      },
      {
        assertion: assert(() =>
          subject.summary === "An active knowledge space"
        ),
      },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Open questions") &&
          textContent(subject[UI]).includes("Notes connect to projects") &&
          textContent(subject[UI]).includes("Explore the notes")
        ),
      },
      {
        assertion: assert(() =>
          findElement(subject[UI], "cf-message-beads") !== undefined
        ),
      },
      {
        action: action(() => {
          pending.set(true);
          request.set(new FabricUnavailable("pending") as IsPending);
        }),
      },
      { assertion: assert(() => summaryState === "pending") },
      { render: subject[UI] },
      {
        action: action(() =>
          request.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      { assertion: assert(() => summaryState === "syncing") },
      { render: subject[UI] },
      {
        action: action(() => {
          pending.set(false);
          request.set(
            new FabricUnavailable(
              "error",
              "provider",
              "overview refused",
            ) as HasError,
          );
        }),
      },
      { assertion: assert(() => summaryState === "overview refused") },
      { render: subject[UI] },
      { action: action(() => request.set(undefined)) },
      { assertion: assert(() => subject.summary === "Space Overview") },
      {
        action: action(() =>
          request.set({
            headline: "Recovered overview",
            themes: [],
            connections: [],
            suggestions: [],
          })
        ),
      },
      { assertion: assert(() => subject.summary === "Recovered overview") },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Recovered overview")
        ),
      },
    ],
  };
});
