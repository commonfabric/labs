/**
 * Assumption 9 of the agent requests design, as an executable check: one
 * `AgentRun` record takes a derived creation and later authored writes.
 *
 * The builtin's post-commit effect creates the record on one runtime. A
 * second runtime — a separate client session on the same memory server, the
 * position a runner process is in — then writes the runner's fields into it
 * as ordinary authored commits. The check is that those commits land, that
 * the request fields the effect wrote survive them, and that the builtin
 * re-running afterwards derives from the record and writes nothing over the
 * runner's fields.
 *
 * Both runtimes here are clients. The same split under a serving runtime
 * rests on the spec reading recorded in the design document's assumption 9.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { AgentRunRecordSchema } from "../src/builtins/agent-schemas.ts";
import type { AgentRunRecord } from "../src/builtins/agent.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { seedHomeAgentQueue } from "./support/agent-queue.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("agent split writer");
const space = signer.did();

describe("agent run split writer", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let managers: EmulatedStorageManager[];
  let requester: Runtime;
  let runner: Runtime;

  const connect = (experimental?: { agentBuiltin: boolean }) => {
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    managers.push(storageManager);
    return new Runtime({
      apiUrl: new URL("https://fabric.example/"),
      storageManager,
      ...(experimental ? { experimental } : {}),
    });
  };

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    managers = [];
    requester = connect({ agentBuiltin: true });
    runner = connect();
  });

  afterEach(async () => {
    for (const runtime of [requester, runner]) {
      await runtime.idle();
      await runtime.dispose();
    }
    for (const manager of managers) await manager.close();
    await server.close();
  });

  it("admits a runner's authored writes into a record the effect created", async () => {
    const { pattern, agent, Cell: BuilderCell } =
      createTrustedBuilder(requester).commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const finished = BuilderCell.of(["Dune"], {
        type: "array",
        items: { type: "string" },
      });
      return agent({
        task: "recommend a book",
        inputs: { finished },
        resultSchema: { type: "object" },
        // deno-lint-ignore no-explicit-any
      } as any);
    });
    const tx = requester.edit();
    seedHomeAgentQueue(requester, space, tx);
    const result = requester.run(
      tx,
      testPattern,
      {},
      requester.getCell(space, "split-writer", testPattern.resultSchema, tx),
    ) as Cell<{ pending?: boolean; error?: string; run?: AgentRunRecord }>;
    requester.prepareTxForCommit(tx);
    await tx.commit();
    const created = await waitForCellValue<AgentRunRecord>(
      requester,
      result.key("run"),
      (value) => value?.state === "queued",
    );

    const record = runner.getCellFromLink(
      result.key("run").resolveAsCell().getAsNormalizedFullLink(),
      AgentRunRecordSchema,
    ) as unknown as Cell<AgentRunRecord>;
    await record.sync();
    const claim = await runner.editWithRetry((tx) => {
      const current = record.withTx(tx);
      current.key("state").set("claimed");
      current.key("claim").set({
        runner: "runner-1",
        leaseUntil: "2026-09-18T12:01:00.000Z",
      });
      current.key("attempts").set(1);
    });
    const finish = await runner.editWithRetry((tx) => {
      const current = record.withTx(tx);
      current.key("state").set("failed");
      current.key("outcome").set("failed");
      current.key("errorCode").set("PROVIDER_FAILURE");
      current.key("modelTurns").set(4);
      current.key("claim").set(undefined);
    });

    expect(claim.error).toBeUndefined();
    expect(finish.error).toBeUndefined();

    // The builtin re-runs on the record's change and derives from it.
    const settled = await waitForCellValue<{ error?: string }>(
      requester,
      result,
      (value) => value?.error !== undefined,
    );
    await requester.settled();
    expect(settled.error).toBe("PROVIDER_FAILURE");

    // Both writers' fields stand side by side.
    const final = await waitForCellValue<AgentRunRecord>(
      requester,
      result.key("run"),
      (value) => value?.state === "failed",
    );
    expect(final.task).toBe("recommend a book");
    expect(final.requestHash).toBe(created.requestHash);
    expect(final.submittedAt).toBe(created.submittedAt);
    expect(final.attempts).toBe(1);
    expect(final.modelTurns).toBe(4);
    expect(final.errorCode).toBe("PROVIDER_FAILURE");
  });
});
