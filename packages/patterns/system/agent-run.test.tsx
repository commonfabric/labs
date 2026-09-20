import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { hasText } from "../test/vnode-helpers.ts";
import AgentRunView, { type AgentRun } from "./agent-run.tsx";

const QUEUED: AgentRun = {
  requestHash: "hash-1",
  request: {},
  piece: {},
  space: {},
  task: "recommend a book",
  inputs: {},
  resultSchema: {},
  submittedAt: "2026-09-18T00:00:00.000Z",
  state: "queued",
  stateSince: "2026-09-18T00:00:00.000Z",
};

export default pattern(() => {
  const run = new Writable<AgentRun>(QUEUED);
  const finished = new Writable<AgentRun>({
    ...QUEUED,
    requestHash: "hash-2",
    state: "completed",
    outcome: "completed",
  });
  const view = AgentRunView({ run });
  const finishedView = AgentRunView({ run: finished });

  const assert_queued_view = assert(() =>
    view[NAME] === "Agent run: queued" &&
    hasText(view[UI], "recommend a book") &&
    hasText(view[UI], "submitted 2026-09-18T00:00:00.000Z") &&
    hasText(view[UI], "Cancel")
  );
  const assert_completed_view = assert(() =>
    finishedView[NAME] === "Agent run: completed" &&
    hasText(finishedView[UI], "completed") &&
    !hasText(finishedView[UI], "Cancel")
  );

  const assert_queued_is_not_terminal = assert(() => view.terminal === false);
  const assert_completed_is_terminal = assert(() =>
    finishedView.terminal === true
  );
  const assert_no_cancel_requested = assert(() =>
    run.get().cancelRequestedAt === undefined
  );

  const action_cancel = action(() => {
    view.cancel.send();
  });
  const assert_cancel_requested = assert(() =>
    typeof run.get().cancelRequestedAt === "string" &&
    run.get().state === "queued"
  );

  // A finished run takes no cancel: terminal states are terminal.
  const action_cancel_finished = action(() => {
    finishedView.cancel.send();
  });
  const assert_finished_untouched = assert(() =>
    finished.get().cancelRequestedAt === undefined
  );

  // The runner moves the record; the view follows it.
  const action_runner_cancels = action(() => {
    run.key("state").set("cancelled");
    run.key("outcome").set("cancelled");
    run.key("errorCode").set("CANCELLED");
  });
  const assert_cancelled_is_terminal = assert(() => view.terminal === true);
  const assert_cancelled_view = assert(() =>
    view[NAME] === "Agent run: cancelled" &&
    hasText(view[UI], "error CANCELLED") &&
    !hasText(view[UI], "Cancel")
  );

  return {
    [TESTS]: [
      { assertion: assert_queued_view },
      { assertion: assert_completed_view },
      { assertion: assert_queued_is_not_terminal },
      { assertion: assert_completed_is_terminal },
      { assertion: assert_no_cancel_requested },
      { action: action_cancel },
      { assertion: assert_cancel_requested },
      { action: action_cancel_finished },
      { assertion: assert_finished_untouched },
      { action: action_runner_cancels },
      { assertion: assert_cancelled_is_terminal },
      { assertion: assert_cancelled_view },
    ],
  };
});
