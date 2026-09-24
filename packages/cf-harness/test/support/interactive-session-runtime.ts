/**
 * Runs real interactive turns against a private SQLite-backed Fabric. A fresh
 * process exposes both SES initialization and post-GC runtime reachability.
 */
import { expect } from "@std/expect";
import { normalize, toFileUrl } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { table } from "@commonfabric/memory/sqlite/schema";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, Runtime, runtimePresets } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { createCliPromptSlotBinding } from "../../src/contracts/prompt-slot.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../../src/diagnostics.ts";
import { createFabricInstantiationRecorder } from "../../src/fabric-instantiations.ts";
import { HarnessInteractiveChatService } from "../../src/interactive-chat-service.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";
import type { SandboxRuntime } from "../../src/sandbox/types.ts";

const gc = (globalThis as {
  gc?: (options: {
    type: "major";
    execution: "sync";
    flavor: "last-resort";
  }) => void;
}).gc;
if (!gc) throw new Error("This fixture requires --expose-gc");
const reopen = Deno.args[0] === "reopen";
const root = await Deno.makeTempDir({ prefix: "interactive-session-runtime-" });
const signer = await Identity.fromPassphrase("interactive runtime fixture");
const server = newLoopbackServer({
  store: new URL("store/", toFileUrl(`${root}/`)),
  subscriptionRefreshDelayMs: 0,
});
const refs: {
  runtime: WeakRef<Runtime>;
  pieces: WeakRef<PiecesController>;
  cell?: WeakRef<Cell<unknown>>;
}[] = [];
const report = {
  closedSessions: 0,
  aliveAfterClose: [] as number[],
  aliveBeforeFirstClose: 0,
  reopened: 0,
  reactiveUpdates: 0,
};
let previousPieceId: string | undefined;
const db = {
  id: "of:interactive-session-runtime",
  tables: { messages: table({ id: "integer primary key", body: "text" }) },
};
const sourceText = `
import { computed, pattern, type SqliteDb } from "commonfabric";
export default pattern<{ db: SqliteDb; tick: number }>(({ db, tick }) => {
  const query = db.query<{ id: number }>("SELECT id FROM messages", { reactOn: tick });
  return {
    count: computed(() => query.result?.length ?? 0),
    pending: query.pending,
    error: query.error,
  };
});
`;
type Result = { count: number; pending: boolean; error?: unknown };
const sandbox: SandboxRuntime = {
  describe: () => ({
    kind: "docker-runsc-cfc",
    defaultWorkingDirectory: "/workspace",
    cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
  }),
  resolvePath: (path, cwd = "/workspace") =>
    normalize(path.startsWith("/") ? path : `${cwd}/${path}`),
  isPathWithinWorkspace: (path) =>
    path === "/workspace" || path.startsWith("/workspace/"),
  isPathWithinAllowedRoots: (path) =>
    path === "/workspace" || path.startsWith("/workspace/"),
  defaultWorkingDirectory: () => "/workspace",
  run: () => {
    throw new Error("This fixture executes no commands");
  },
  runShell: (request) => {
    expect(request.command).toContain(CAPABILITY_PROBE_SENTINEL);
    return Promise.resolve({
      stdout: "bash\tpresent\t/bin/bash\tfixture capability probe",
      stderr: "",
      exitCode: 0,
    });
  },
};

async function fabric() {
  const recorder = createFabricInstantiationRecorder();
  const runtime = new Runtime(runtimePresets.remoteClient({
    apiUrl: new URL("http://127.0.0.1:9"),
    storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    experimental: { serverExecution: false },
    onPatternInstantiated: recorder.observe,
  }));
  const pieces = new PiecesController(
    await createSession({ identity: signer, spaceName: "fixture" }),
    runtime,
  );
  const record: typeof refs[number] = {
    runtime: new WeakRef(runtime),
    pieces: new WeakRef(pieces),
  };
  refs.push(record);
  const run = pieces.runPersistent.bind(pieces);
  pieces.runPersistent = async <T>(...args: Parameters<typeof run>) => {
    const cell = await run<T>(...args);
    record.cell = new WeakRef(cell);
    return cell;
  };
  await pieces.synced();
  if (refs.length === 1) {
    const tx = runtime.edit();
    tx.recordSqliteWrite!(pieces.getSpace(), {
      op: "sqlite",
      db,
      sql: "INSERT INTO messages (id, body) VALUES (1, 'first'), (2, 'second')",
    });
    expect((await tx.commit()).error).toBeUndefined();
  }
  if (reopen && previousPieceId) {
    const prior = await pieces.getPieceCell<Result>(previousPieceId, true);
    await prior.pull();
    await waitForCellValue<Result>(
      runtime,
      prior,
      (value) => value?.count === 2 && !value.pending && !value.error,
    );
    report.reopened++;
    for (
      const [sql, count] of [
        ["INSERT INTO messages (id, body) VALUES (3, 'later session')", 3],
        ["DELETE FROM messages WHERE id = 3", 2],
      ] as const
    ) {
      const tx = runtime.edit();
      tx.recordSqliteWrite!(pieces.getSpace(), { op: "sqlite", db, sql });
      pieces.getArgument<{ tick: number }>(prior).key("tick").withTx(tx)
        .set(count);
      expect((await tx.commit()).error).toBeUndefined();
      await waitForCellValue<Result>(
        runtime,
        prior,
        (value) => value?.count === count && !value.pending && !value.error,
      );
      expect(prior.get().count).toBe(count);
      report.reactiveUpdates++;
    }
    await pieces.synced();
  }
  return { pieces, identity: signer, instantiations: recorder.instantiations };
}

const service = new HarnessInteractiveChatService({
  basePromptLoopOptions: {
    model: "fixture",
    sandboxRuntime: sandbox,
    artifactRoot: `${root}/runs`,
    gatewayAuthMode: "none",
    cfcEnforcementModeOverride: "enforce-strict",
    fabricSessionFactory: fabric,
  },
  runIdForTurn: (_sessionId, turnId) => turnId,
  createPromptLoop: (options) => {
    let calls = 0;
    return new CfHarnessPromptLoop({
      ...options,
      modelClient: {
        providerId: "fixture",
        complete: () =>
          Promise.resolve({
            assistant: calls++ === 0
              ? {
                role: "assistant",
                content: "",
                toolCalls: [{
                  id: `query-${options.runId}`,
                  type: "function",
                  function: {
                    name: "run_pattern",
                    arguments: JSON.stringify({
                      sourceText,
                      inputs: { db, tick: 0 },
                    }),
                  },
                }],
              }
              : { role: "assistant", content: "Done." },
          }),
      },
    });
  },
});

async function verifyCurrent() {
  const record = refs.at(-1)!;
  const runtime = record.runtime.deref()!;
  const pieces = record.pieces.deref()!;
  const cell = record.cell!.deref()! as Cell<Result>;
  await waitForCellValue<Result>(
    runtime,
    cell,
    (value) => value?.count === 2 && !value.pending && !value.error,
  );
  await pieces.synced();
  previousPieceId = cell.getAsNormalizedFullLink().id;
}

async function aliveRuntimes() {
  // End WeakRef's keep-alive job, then finish a full collection before reading
  // reachability. The zero timer is a task boundary, not a wait for cleanup.
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc!({ type: "major", execution: "sync", flavor: "last-resort" });
  return refs.filter((ref) => ref.runtime.deref() !== undefined).length;
}

try {
  for (let session = 1; session <= 3; session++) {
    const sessionId = `session-${session}`;
    expect(
      (await service.startSession(`open-${session}`, {
        sessionId,
        workspace: { hostPath: root },
        policy: {
          type: "cf-harness.chat-policy",
          toolMode: "workspace-write",
          allowedToolIds: ["run_pattern"],
          allowedSubagentProfiles: [],
          cfcEnforcementMode: "enforce-strict",
          promptSlot: createCliPromptSlotBinding({
            kernelName: "cf-harness",
            subject: "runtime lifecycle fixture",
          }),
        },
      })).ok,
    ).toBe(true);
    for (let turn = 1; turn <= (session === 1 ? 2 : 1); turn++) {
      const turnId = `${sessionId}-turn-${turn}`;
      expect(
        (await service.startTurn(turnId, {
          sessionId,
          turnId,
          input: { text: "Count the fixture rows." },
        })).ok,
      ).toBe(true);
      await service.waitForTurn(sessionId, turnId);
      expect(
        service.listTurns({ sessionId }).turns.at(-1)!.turn.status,
        JSON.stringify(service.events(sessionId)),
      )
        .toBe("completed");
      await verifyCurrent();
    }
    if (session === 1) report.aliveBeforeFirstClose = await aliveRuntimes();
    expect((await service.closeSession(`close-${session}`, sessionId)).ok)
      .toBe(true);
    await service.waitForIdle();
    report.closedSessions++;
    report.aliveAfterClose.push(await aliveRuntimes());
  }
} catch (error) {
  console.error(error);
  Deno.exitCode = 1;
} finally {
  // Clean up even on the mutation that leaves the runtimes alive.
  for (const ref of refs) await ref.runtime.deref()?.dispose();
  await server.close();
  await Deno.remove(root, { recursive: true });
}
console.log(`RUNTIME_REPORT ${JSON.stringify(report)}`);
