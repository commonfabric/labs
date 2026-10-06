import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  agentInspectionAction,
  type AgentInspectionCommandDeps,
  createAgentCommand,
  formatAgentRun,
} from "../commands/agent.ts";
import type { AgentRunInspection } from "../lib/agent-inspection.ts";

const queued: AgentRunInspection = {
  id: "run-queued",
  address: "ref-queued",
  host: "https://home.example",
  space: "did:key:user",
  requestHash: "hash-queued",
  task: "Find books",
  state: "queued",
  submittedAt: "2026-09-20T12:00:00Z",
  stateSince: "2026-09-20T12:00:00Z",
};
const completed: AgentRunInspection = {
  ...queued,
  id: "run-completed",
  requestHash: "hash-completed",
  state: "completed",
  startedAt: "2026-09-20T12:01:00Z",
  finishedAt: "2026-09-20T12:02:00Z",
  usage: {
    costUsd: 0.1,
    estimatedCostUsd: 0.08,
    estimateWithheldReason: "incomplete-estimates",
  },
};

describe("agent inspection commands", () => {
  const setup = () => {
    const outputs: unknown[] = [];
    const cancelled: string[] = [];
    const deps: AgentInspectionCommandDeps = {
      read: () => Promise.resolve([queued, completed]),
      readOne: (_config, identifier) =>
        Promise.resolve(identifier === "hash-completed" ? completed : queued),
      cancel: (_config, run) => {
        cancelled.push(run);
        return Promise.resolve(queued);
      },
      render: (value) => {
        outputs.push(value);
      },
    };
    const run = (args: string[]) =>
      createAgentCommand(undefined, deps).throwErrors().noExit()
        .parse([
          ...args,
          "--identity",
          "/key",
          "--api-url",
          "https://home.example",
        ]);
    return { outputs, cancelled, run };
  };

  it("lists only the requested state as structured JSON metadata", async () => {
    const { run, outputs } = setup();
    await run(["ls", "--state", "queued", "--json"]);
    expect(outputs).toEqual([[queued]]);
  });

  it("shows a run selected by its request hash", async () => {
    const { run, outputs } = setup();
    await run(["show", "hash-completed", "--json"]);
    expect(outputs).toEqual([completed]);
  });

  it("passes cancellation to the durable writer", async () => {
    const { run, cancelled } = setup();
    await run(["cancel", "run-queued"]);
    expect(cancelled).toEqual(["run-queued"]);
  });

  it("keeps provider cost, estimated cost, and the withheld reason distinct", () => {
    const rendered = formatAgentRun(completed);
    expect(rendered).toContain("Provider cost (USD): 0.1");
    expect(rendered).toContain("Estimated cost (USD): 0.08");
    expect(rendered).toContain("Estimate withheld: incomplete-estimates");
  });

  it("shows an empty filtered list without rendering record metadata", async () => {
    const { run, outputs } = setup();
    await run(["ls", "--state", "refused"]);
    expect(outputs).toEqual(["No agent runs."]);
  });

  it("lists the host and canonical address needed to disambiguate a run", async () => {
    const { run, outputs } = setup();
    await run(["ls", "--state", "queued"]);
    expect(outputs).toEqual([
      "run-queued  queued  Find books  https://home.example  ref-queued",
    ]);
  });

  it("includes terminal status and result addresses in the human-readable view", () => {
    const rendered = formatAgentRun({
      ...completed,
      outcome: "completed",
      modelTurns: 2,
      toolCalls: 1,
      usageCoverage: "including-descendants",
      result: "remote-result-address",
    });
    expect(rendered).toContain("Outcome: completed");
    expect(rendered).toContain("Started: 2026-09-20T12:01:00Z");
    expect(rendered).toContain("Finished: 2026-09-20T12:02:00Z");
    expect(rendered).toContain("Model turns: 2");
    expect(rendered).toContain("Tool calls: 1");
    expect(rendered).toContain("Result: remote-result-address");
    expect(rendered).toContain("Usage coverage: including-descendants");
  });

  it("rejects incomplete action inputs before opening any connection", async () => {
    let opened = false;
    const deps: AgentInspectionCommandDeps = {
      read: () => {
        opened = true;
        return Promise.resolve([]);
      },
      readOne: () => {
        opened = true;
        return Promise.resolve(queued);
      },
      cancel: () => {
        opened = true;
        return Promise.resolve(queued);
      },
      render: () => {},
    };
    await expect(agentInspectionAction("ls", {}, undefined, deps))
      .rejects.toThrow("requires --identity");
    await expect(agentInspectionAction(
      "show",
      {
        identity: "/key",
        apiUrl: "https://home.example",
      },
      undefined,
      deps,
    )).rejects.toThrow("identifier is required");
    expect(opened).toBe(false);
  });

  it("rejects an unknown state before reading the index", async () => {
    const { run, outputs } = setup();
    await expect(run(["ls", "--state", "lost"])).rejects.toThrow("lost");
    expect(outputs).toEqual([]);
  });
});
