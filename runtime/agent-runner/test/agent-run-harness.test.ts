import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type AgentRunRecord,
  INVALID_INPUT,
} from "@commonfabric/runner/agent-run";

import { createHarnessAgentRunExecutor } from "../src/agent-run-harness.ts";

/**
 * Declares `fields`, the parts of a record the case's executor reads, as the
 * record a run carries.
 */
function asAgentRunRecord(fields: Partial<AgentRunRecord>): AgentRunRecord {
  return fields as AgentRunRecord;
}

describe("createHarnessAgentRunExecutor()", () => {
  it("throws before starting the Fabric lane when its ACL reader is missing", () => {
    const options = {
      identityKeyPath: "/unused.key",
      requester: "did:key:requester",
      workRoot: "/unused",
      allowedTools: ["describe_handle"],
    };
    expect(() => {
      // @ts-expect-error The runtime boundary also rejects untyped callers.
      createHarnessAgentRunExecutor(options);
    }).toThrow("The Fabric lane requires a readSpaceAcl function");
  });

  it("fails a run that asks for progress with no way to publish it, starting nothing", async () => {
    let aclReads = 0;
    const execute = createHarnessAgentRunExecutor({
      identityKeyPath: "/unused.key",
      requester: "did:key:requester",
      workRoot: "/unused",
      allowedTools: ["describe_handle"],
      readSpaceAcl: () => {
        aclReads++;
        return Promise.resolve(null);
      },
    });

    const execution = await execute({
      record: asAgentRunRecord({ progressRequested: true }),
      link: { id: "of:run", space: "did:key:space", scope: "space", path: [] },
      host: "https://toolshed.example",
      signal: new AbortController().signal,
      renewLease: () => Promise.resolve(),
    });

    expect(execution).toEqual({ outcome: "failed", errorCode: INVALID_INPUT });
    expect(aclReads).toBe(0);
  });
});
