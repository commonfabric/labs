/** Exercises discovery availability through the production summary index. */

import {
  action,
  assert,
  type AsyncResult,
  computed,
  equals,
  FabricUnavailable,
  type HasError,
  hasError,
  type IsPending,
  isPending,
  type IsSyncing,
  isSyncing,
  NAME,
  observeAvailability,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { textContent } from "../test/vnode-helpers.ts";
import {
  type SummarizablePiece,
  type SummaryIndexEntry,
  SummaryIndexPresentation,
} from "./summary-index.tsx";

export default pattern(() => {
  const piece = new Writable<SummarizablePiece>({
    [NAME]: "Alpha",
    summary: "First summary",
  });
  const request = new Writable<
    AsyncResult<Writable<SummarizablePiece>[] | undefined>
  >();
  const subject = SummaryIndexPresentation({ mentionableRequest: request });
  const entries: AsyncResult<SummaryIndexEntry[]> = observeAvailability(
    subject.entries,
    "pending",
    "syncing",
    "error",
  );
  const indexState = computed(() => {
    if (isPending(entries)) return "pending";
    if (isSyncing(entries)) return "syncing";
    if (hasError(entries)) return entries.errorMessage;
    return "usable";
  });

  return {
    [TESTS]: [
      { action: action(() => request.set([piece])) },
      {
        assertion: assert(() =>
          subject.entries.length === 1 &&
          subject.entries[0].name === "Alpha" &&
          subject.entries[0].summary === "First summary" &&
          equals(subject.entries[0].piece, piece)
        ),
      },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("First summary")
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      { assertion: assert(() => indexState === "pending") },
      {
        action: action(() =>
          request.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      { assertion: assert(() => indexState === "syncing") },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable(
              "error",
              "general",
              "discovery refused",
            ) as HasError,
          )
        ),
      },
      {
        assertion: assert(() => indexState === "discovery refused"),
      },
      { action: action(() => request.set([])) },
      { assertion: assert(() => subject.entries.length === 0) },
      { action: action(() => request.set(undefined)) },
      { assertion: assert(() => subject.entries.length === 0) },
      {
        action: action(() => {
          piece.key("summary").set("Recovered summary");
          request.set([piece]);
        }),
      },
      {
        assertion: assert(() =>
          subject.entries.length === 1 &&
          subject.entries[0].summary === "Recovered summary"
        ),
      },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Recovered summary")
        ),
      },
      { action: action(() => piece.key("summary").set("Edited summary")) },
      {
        assertion: assert(() =>
          subject.entries[0].summary === "Edited summary" &&
          equals(subject.entries[0].piece, piece)
        ),
      },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("Edited summary")
        ),
      },
    ],
  };
});
