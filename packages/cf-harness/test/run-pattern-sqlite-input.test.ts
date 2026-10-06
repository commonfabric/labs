/**
 * `run_pattern` over a pattern whose input is a SQLite database handle — the
 * shape a model writes when the harness hands it an injected store.
 *
 * Two separate things carry that run. The source compiles with `SqliteDb`
 * naming an input, which the js-compiler's brand filter settles at declaration
 * emit; and the handle cell named as that input reaches the pattern as a
 * handle, which turns on how `run_pattern` measures a live-cell input against
 * the argument schema before any piece exists.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CfHarnessEngine } from "../src/engine.ts";
import type { RunPatternToolSuccessOutput } from "../src/tools/run-pattern.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness sqlite input");

/**
 * A pattern typed the way a model types one against an injected store: the
 * input is a `SqliteDb`, and the rows come from `query` on it.
 */
const MAIL_PATTERN_SOURCE = [
  "import { computed, pattern, type SqliteDb } from 'commonfabric';",
  "interface BillRow { id: number; subject: string; }",
  "type Input = { mail: SqliteDb };",
  "type Output = { subjects: string[]; pending: boolean };",
  "export default pattern<Input, Output>(({ mail }) => {",
  "  const bills = mail.query<BillRow>('SELECT id, subject FROM messages', {});",
  "  return {",
  "    subjects: computed(() => (bills.result ?? []).map((row) => row.subject)),",
  "    pending: computed(() => bills.pending === true),",
  "  };",
  "});",
  "",
].join("\n");

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string): string {
    return path;
  }

  isPathWithinWorkspace(path: string): boolean {
    return path.startsWith("/workspace");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

describe("run_pattern over a database handle input", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Seed a database holding one `messages` row and return the LLM-friendly
   * link naming its handle cell — the address a model is handed for an
   * injected store, and passes straight back as an input.
   */
  async function seedDatabaseHandle(subject: string): Promise<string> {
    const space = pieces.getSpace();
    const dbRef: SqliteDbRef = {
      id: `sqlite-input-${crypto.randomUUID()}`,
      tables: {
        messages: table({ id: "integer primary key", subject: "text" }),
      },
    };
    const tx = runtime.edit();
    const handle = runtime.getCell<SqliteDbRef>(
      space,
      "sqlite-input-handle",
      undefined,
      tx,
    );
    handle.set(dbRef);
    tx.recordSqliteWrite!(space, {
      op: "sqlite",
      db: dbRef,
      sql: "INSERT INTO messages (id, subject) VALUES (?, ?)",
      params: [1, subject],
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    return createLLMFriendlyLink(handle.getAsNormalizedFullLink(), space);
  }

  function createEngine(): CfHarnessEngine {
    return new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `sqlite-input-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
  }

  it("runs a pattern whose input is typed `SqliteDb` and queries the database the input names", async () => {
    const mail = await seedDatabaseHandle("rent");
    const result = await createEngine().invokeBuiltinTool("run_pattern", {
      sourceText: MAIL_PATTERN_SOURCE,
      inputs: { mail },
    });

    const output = result.output as RunPatternToolSuccessOutput;
    expect(output.status).toBe("ok");

    // The query is a server round-trip, so the run returns while it is still
    // in flight; the piece's own result is where it lands.
    const piece = await pieces.get(output.pieceId);
    await runtime.idle();
    await pieces.synced();
    await runtime.idle();
    expect(await piece.result.get()).toEqual({
      pending: false,
      subjects: ["rent"],
    });
  });
});
