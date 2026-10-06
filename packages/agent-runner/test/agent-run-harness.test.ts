import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createHarnessAgentRunExecutor } from "../src/agent-run-harness.ts";

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
});
