import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { CommandLedger } from "../src/command-ledger.ts";
import { AGENT_CONNECTOR_SCHEMAS } from "../src/protocol.ts";
import type { AgentSessionCommandReceipt } from "../src/commands.ts";

function receipt(
  commandId: string,
  overrides: Partial<AgentSessionCommandReceipt> = {},
): AgentSessionCommandReceipt {
  return {
    schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
    ownerDid: "did:key:test-owner",
    commandId,
    sourceId: "fake:default",
    nativeSessionId: "session-1",
    status: "succeeded",
    completedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function ledgerFile(overrides: Record<string, unknown> = {}) {
  return {
    schema: AGENT_CONNECTOR_SCHEMAS.commandLedger,
    generation: 1,
    receipts: {},
    pendingPublicationCommandIds: [],
    ...overrides,
  };
}

async function writeLedger(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(value), { mode: 0o600 });
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
}

Deno.test("command ledgers preserve Fabric results across reopen", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  try {
    const ledger = await CommandLedger.open(path);
    assertEquals(ledger.pendingPublicationCount(), 0);
    assertEquals(ledger.get("missing"), undefined);

    const stored = receipt("result-command", {
      result: { nested: { value: 1 }, list: ["a", "b"] },
    });
    await ledger.put(stored);
    assertEquals(ledger.pendingPublicationCount(), 1);
    assertEquals(ledger.get(stored.commandId), stored);

    await ledger.markPublished("missing");
    await ledger.markPublished(stored.commandId);
    assertEquals(ledger.pendingPublicationCount(), 0);

    const reopened = await CommandLedger.open(path);
    assertEquals(reopened.get(stored.commandId), stored);
    assertEquals(await reopened.recoverUnpublishedReceipts(), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("command ledgers key receipts by command identity", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  try {
    const ledger = await CommandLedger.open(path);
    const owners = receipt("one");
    const producers = receipt("one", {
      producer: "workbench",
      status: "failed",
    });
    await ledger.put(owners);
    await ledger.put(producers);
    assertEquals(ledger.pendingPublicationCount(), 2);
    assertEquals(await ledger.recoverUnpublishedReceipts(), [
      owners,
      producers,
    ]);
    assertEquals(ledger.get("one"), owners);
    assertEquals(ledger.get("one", "workbench"), producers);
    assertEquals(ledger.get("one", "dashboard"), undefined);
    await ledger.markPublished("one", "workbench");
    assertEquals(ledger.pendingPublicationCount(), 1);

    const reopened = await CommandLedger.open(path);
    assertEquals(reopened.get("one"), owners);
    assertEquals(reopened.get("one", "workbench"), producers);
    assertEquals(reopened.pendingPublicationCount(), 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("command ledgers validate their complete persisted shape", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  const cases: Array<[unknown, string]> = [
    [null, "command ledger must contain an object"],
    [[], "command ledger must contain an object"],
    [ledgerFile({ generation: -1 }), "generation must be a non-negative"],
    [ledgerFile({ generation: 1.5 }), "generation must be a non-negative"],
    [ledgerFile({ receipts: null }), "receipts must be an object"],
    [ledgerFile({ receipts: [] }), "receipts must be an object"],
    [
      ledgerFile({ pendingPublicationCommandIds: null }),
      "pendingPublicationCommandIds must be a string array",
    ],
    [
      ledgerFile({ pendingPublicationCommandIds: [1] }),
      "pendingPublicationCommandIds must be a string array",
    ],
    [
      ledgerFile({ pendingPublicationCommandIds: ["same", "same"] }),
      "pendingPublicationCommandIds must not contain duplicates",
    ],
    [
      ledgerFile({ pendingPublicationCommandIds: ["missing"] }),
      "pending receipt is missing: missing",
    ],
    [
      ledgerFile({ receipts: { command: null } }),
      "receipt must be an object: command",
    ],
    [
      ledgerFile({
        receipts: { command: { ...receipt("command"), result: 1 } },
      }),
      "receipt result must use Fabric JSON: command",
    ],
    [
      ledgerFile({
        receipts: {
          command: { ...receipt("command"), commandId: undefined },
        },
      }),
      "receipt must name its commandId: command",
    ],
    [
      ledgerFile({
        receipts: { command: receipt("command", { producer: "workbench" }) },
      }),
      "receipt key does not match its identity: command",
    ],
  ];

  try {
    for (const [value, message] of cases) {
      await writeLedger(path, value);
      await assertRejects(() => CommandLedger.open(path), Error, message);
    }
    await Deno.writeTextFile(path, "not JSON", { mode: 0o600 });
    await assertRejects(() => CommandLedger.open(path), SyntaxError);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("command ledgers reject exhausted generations", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  try {
    await writeLedger(
      path,
      ledgerFile({ generation: Number.MAX_SAFE_INTEGER }),
    );
    const ledger = await CommandLedger.open(path);
    await assertRejects(
      () => ledger.put(receipt("too-late")),
      Error,
      "generation is exhausted",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("command ledgers reject shared files and symbolic links", async () => {
  if (Deno.build.os === "windows") return;
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  const target = join(directory, "target.json");
  try {
    await writeLedger(path, ledgerFile());
    await Deno.chmod(path, 0o644);
    await assertRejects(
      () => CommandLedger.open(path),
      Error,
      "file permits access by other users",
    );

    await Deno.remove(path);
    await writeLedger(target, ledgerFile());
    await Deno.symlink(target, path);
    await assertRejects(
      () => CommandLedger.open(path),
      Error,
      "file cannot be a symbolic link",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
