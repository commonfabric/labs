/** Exercises the journal's production status when its inputs disagree. */
import {
  action,
  assert,
  type AsyncResult,
  FabricUnavailable,
  type HasError,
  type IsObsolete,
  type IsPending,
  type IsSyncing,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { journalAvailability } from "./journal.tsx";

export default pattern(() => {
  const journal = new Writable<AsyncResult<[]>>([]);
  const nowMs = new Writable<AsyncResult<number>>(1);
  const subject = journalAvailability({ journal, nowMs });
  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          subject.availability === "ready" && subject.error === ""
        ),
      },
      {
        action: action(() => {
          journal.set(
            new FabricUnavailable(
              "error",
              "network",
              "journal offline",
            ) as HasError,
          );
          nowMs.set(new FabricUnavailable("pending") as IsPending);
        }),
      },
      {
        assertion: assert(() =>
          subject.availability === "error" &&
          subject.errorKind === "network" &&
          subject.error === "journal offline"
        ),
      },
      {
        action: action(() => {
          journal.set(new FabricUnavailable("pending") as IsPending);
          nowMs.set(
            new FabricUnavailable(
              "error",
              "network",
              "clock offline",
            ) as HasError,
          );
        }),
      },
      {
        assertion: assert(() =>
          subject.availability === "error" && subject.error === "clock offline"
        ),
      },
      {
        action: action(() => {
          journal.set(
            new FabricUnavailable(
              "error",
              "schemaMismatch",
              "invalid journal",
            ) as HasError,
          );
          nowMs.set(new FabricUnavailable("pending") as IsPending);
        }),
      },
      {
        assertion: assert(() =>
          subject.availability === "error" &&
          subject.errorKind === "schemaMismatch" &&
          subject.error === "Journal data has an unexpected format."
        ),
      },
      {
        action: action(() => {
          journal.set([]);
          nowMs.set(new FabricUnavailable("syncing") as IsSyncing);
        }),
      },
      {
        assertion: assert(() =>
          subject.availability === "syncing" && subject.error === ""
        ),
      },
      {
        action: action(() =>
          nowMs.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      {
        assertion: assert(() =>
          subject.availability === "pending" && subject.error === ""
        ),
      },
      {
        action: action(() =>
          journal.set(
            new FabricUnavailable(
              "obsolete",
              null,
              null,
              "Use the replacement journal.",
            ) as IsObsolete,
          )
        ),
      },
      {
        assertion: assert(() =>
          subject.availability === "obsolete" &&
          subject.errorKind === "" &&
          subject.error === "Use the replacement journal."
        ),
      },
      {
        action: action(() => {
          journal.set([]);
          nowMs.set(new FabricUnavailable("obsolete") as IsObsolete);
        }),
      },
      {
        assertion: assert(() =>
          subject.availability === "obsolete" &&
          subject.errorKind === "" &&
          subject.error === "The journal clock is no longer served."
        ),
      },
      {
        action: action(() => {
          journal.set(
            new FabricUnavailable("obsolete", null, null, "") as IsObsolete,
          );
          nowMs.set(2);
        }),
      },
      {
        assertion: assert(() =>
          subject.availability === "obsolete" && subject.errorKind === "" &&
          subject.error === "This journal is no longer served."
        ),
      },
      {
        action: action(() => {
          journal.set([]);
          nowMs.set(
            new FabricUnavailable("obsolete", null, null, "") as IsObsolete,
          );
        }),
      },
      {
        assertion: assert(() =>
          subject.availability === "obsolete" && subject.errorKind === "" &&
          subject.error === "The journal clock is no longer served."
        ),
      },
      { action: action(() => nowMs.set(2)) },
      {
        assertion: assert(() =>
          subject.availability === "ready" && subject.error === "" &&
          subject.errorKind === ""
        ),
      },
    ],
  };
});
