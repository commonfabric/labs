/** Exercises the production diagnosis list and the demo's SQL privacy ceiling. */

import {
  action,
  assert,
  type AsyncResult,
  computed,
  FabricUnavailable,
  type HasError,
  hasError,
  type IsPending,
  isPending,
  type IsSyncing,
  isSyncing,
  observeAvailability,
  pattern,
  type SqliteQueryResult,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  countElements,
  findNodeById,
  textContent,
} from "../test/vnode-helpers.ts";
import Records, { DiagnosisList, type DiagnosisRow } from "./main.tsx";

export default pattern(() => {
  const request = new Writable<AsyncResult<SqliteQueryResult<DiagnosisRow>>>({
    rows: [{
      id: 1,
      patient_email: "ada@a.example",
      diagnosis: "sprained wrist",
    }],
  });
  const subject = DiagnosisList({ request });
  const rows: AsyncResult<DiagnosisRow[]> = observeAvailability(subject.rows);
  const state = computed(() => {
    if (isPending(rows)) return "pending";
    if (isSyncing(rows)) return "syncing";
    if (hasError(rows)) return `${rows.errorKind}: ${rows.errorMessage}`;
    return "usable";
  });
  const demo = Records({});

  return {
    [TESTS]: [
      {
        assertion: assert(() => subject.rows[0].diagnosis === "sprained wrist"),
      },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("ada@a.example: sprained wrist")
        ),
      },
      {
        action: action(() =>
          request.set(new FabricUnavailable("pending") as IsPending)
        ),
      },
      { assertion: assert(() => state === "pending") },
      { render: subject[UI] },
      {
        action: action(() =>
          request.set(new FabricUnavailable("syncing") as IsSyncing)
        ),
      },
      { assertion: assert(() => state === "syncing") },
      { render: subject[UI] },
      {
        action: action(() =>
          request.set(
            new FabricUnavailable(
              "error",
              "network",
              "database offline",
            ) as HasError,
          )
        ),
      },
      { assertion: assert(() => state === "network: database offline") },
      { render: subject[UI] },
      { action: action(() => request.set({ rows: [] })) },
      {
        assertion: assert(() =>
          state === "usable" && subject.rows.length === 0
        ),
      },
      {
        action: action(() =>
          request.set({
            rows: [{
              id: 2,
              patient_email: "grace@g.example",
              diagnosis: "common cold",
            }],
          })
        ),
      },
      { assertion: assert(() => subject.rows[0].diagnosis === "common cold") },
      { render: subject[UI] },
      {
        assertion: assert(() =>
          textContent(subject[UI]).includes("grace@g.example: common cold")
        ),
      },
      {
        action: action(() =>
          request.key("rows").key(0).key("diagnosis").set("recovered")
        ),
      },
      {
        assertion: assert(() =>
          subject.rows[0].diagnosis === "recovered" &&
          textContent(subject[UI]).includes("grace@g.example: recovered")
        ),
      },
      { action: action(() => demo.seed.send()) },
      { render: demo[UI] },
      {
        assertion: assert(() =>
          textContent(findNodeById(demo[UI], "diagnosis-list")).includes(
            "sprained wrist",
          ) &&
          textContent(findNodeById(demo[UI], "diagnosis-list")).includes(
            "common cold",
          )
        ),
      },
      { action: action(() => demo.seed.send()) },
      {
        assertion: assert(() =>
          countElements(
              findNodeById(demo[UI], "diagnosis-list"),
              "cf-label",
            ) ===
            4 &&
          textContent(findNodeById(demo[UI], "ssn-error")).includes("ceiling")
        ),
      },
      {
        assertion: assert(() =>
          textContent(findNodeById(demo[UI], "ssn-error")).includes(
            "ceiling",
          ) &&
          !textContent(demo[UI]).includes("111-22-3333") &&
          !textContent(demo[UI]).includes("444-55-6666")
        ),
      },
    ],
  };
});
