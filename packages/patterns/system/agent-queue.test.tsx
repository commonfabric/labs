import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findElementByText,
  findNodeByProp,
  hasText,
  propsOf,
} from "../test/vnode-helpers.ts";
import AgentQueue from "./agent-queue.tsx";
import type { AgentRun } from "./agent-run.tsx";

const RUNNER = {
  host: "https://local.example",
  tools: ["loom_search"],
  registrationId: "runner-1",
  registeredAt: "2026-09-18T00:00:00.000Z",
};

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
  const queue = AgentQueue({});
  const record = new Writable.perUser<AgentRun>(QUEUED);

  const running = new Writable.perUser<AgentRun>({
    ...QUEUED,
    requestHash: "hash-2",
    task: "find authors",
    state: "running",
  });
  const finished = new Writable.perUser<AgentRun>({
    ...QUEUED,
    requestHash: "hash-3",
    task: "find books",
    state: "completed",
    outcome: "completed",
    usage: { totalTokens: 120, costUsd: 0.01, estimatedCostUsd: 0.02 },
  });

  const assert_starts_with_no_entries = assert(() =>
    queue.entries.get().length === 0
  );
  const assert_starts_with_no_runner = assert(() =>
    queue.agentRunner === undefined
  );

  const assert_no_runner_notice = assert(() =>
    hasText(queue[UI], "No runner is registered.")
  );
  const assert_runner_notice_cleared = assert(() =>
    !hasText(queue[UI], "No runner is registered.")
  );

  const action_register_runner = action(() => {
    queue.setAgentRunner.send({ runner: RUNNER });
  });
  const assert_runner_registered = assert(() =>
    queue.agentRunner?.host === RUNNER.host &&
    queue.agentRunner?.tools[0] === "loom_search" &&
    queue.agentRunner?.lastClaimAt === undefined
  );

  const action_refresh_on_claim = action(() => {
    queue.setAgentRunner.send({
      runner: { ...RUNNER, lastClaimAt: "2026-09-18T00:05:00.000Z" },
    });
  });
  const assert_claim_refreshed = assert(() =>
    queue.agentRunner?.lastClaimAt === "2026-09-18T00:05:00.000Z" &&
    queue.agentRunner?.registeredAt === RUNNER.registeredAt
  );

  // The builtin appends entries as the runtime; a push stands in for it.
  const action_append_entry = action(() => {
    queue.entries.push({ run: record, host: "https://cloud.example" });
    queue.entries.push({ run: running, host: "https://cloud.example" });
    queue.entries.push({ run: finished, host: "https://cloud.example" });
  });
  const assert_entry_links_the_record = assert(() =>
    queue.entries.get().length === 3 &&
    queue.entries.get()[0].host === "https://cloud.example" &&
    queue.entries.get()[0].run.get()?.state === "queued"
  );

  const assert_rendered_record = assert(() =>
    hasText(queue[UI], "queued") &&
    hasText(queue[UI], "recommend a book") &&
    hasText(queue[UI], "https://cloud.example")
  );

  const assert_three_record_views = assert(() =>
    hasText(findNodeByProp(queue[UI], "data-agent-run", "hash-1"), "queued") &&
    hasText(findNodeByProp(queue[UI], "data-agent-run", "hash-2"), "running") &&
    hasText(
      findNodeByProp(queue[UI], "data-agent-run", "hash-3"),
      "completed",
    ) &&
    hasText(
      findNodeByProp(queue[UI], "data-agent-run", "hash-3"),
      "120 tokens",
    ) &&
    hasText(
      findNodeByProp(queue[UI], "data-agent-run", "hash-3"),
      "Reported cost: $0.010000",
    ) &&
    hasText(
      findNodeByProp(queue[UI], "data-agent-run", "hash-3"),
      "Estimated cost: $0.020000",
    ) &&
    !hasText(findNodeByProp(queue[UI], "data-agent-run", "hash-3"), "Cancel")
  );
  const action_cancel_running = action(() => {
    const row = findNodeByProp(queue[UI], "data-agent-run", "hash-2");
    const button = findElementByText(row, "cf-button", "Cancel");
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: () => void }).send();
    }
  });
  const assert_only_running_cancelled = assert(() =>
    typeof running.get().cancelRequestedAt === "string" &&
    record.get().cancelRequestedAt === undefined &&
    finished.get().cancelRequestedAt === undefined &&
    running.get().state === "running" &&
    hasText(
      findNodeByProp(queue[UI], "data-agent-run", "hash-2"),
      "Cancellation requested",
    )
  );

  const action_clear_runner = action(() => {
    queue.setAgentRunner.send({ expectedRegistrationId: "runner-2" });
  });

  const action_replace_runner = action(() => {
    queue.setAgentRunner.send({
      runner: { ...RUNNER, registrationId: "runner-2" },
    });
  });
  const action_stale_clear = action(() => {
    queue.setAgentRunner.send({ expectedRegistrationId: "runner-1" });
  });
  const assert_replacement_survives_stale_clear = assert(() =>
    queue.agentRunner?.registrationId === "runner-2"
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_with_no_entries },
      { assertion: assert_starts_with_no_runner },
      { assertion: assert_no_runner_notice },
      { action: action_register_runner },
      { assertion: assert_runner_registered },
      { assertion: assert_runner_notice_cleared },
      { action: action_refresh_on_claim },
      { assertion: assert_claim_refreshed },
      { action: action_append_entry },
      { assertion: assert_entry_links_the_record },
      { assertion: assert_rendered_record },
      { assertion: assert_three_record_views },
      { action: action_cancel_running },
      { assertion: assert_only_running_cancelled },
      { action: action_replace_runner },
      { action: action_stale_clear },
      { assertion: assert_replacement_survives_stale_clear },
      { action: action_clear_runner },
      { assertion: assert_starts_with_no_runner },
      { assertion: assert_no_runner_notice },
    ],
  };
});
