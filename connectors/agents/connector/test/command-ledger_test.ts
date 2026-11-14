import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  CommandLedger,
  type CommandLedgerSystem,
  writeAndSync,
} from "../src/command-ledger.ts";
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

const WINDOWS: CommandLedgerSystem = { os: "windows", uid: () => null };

async function readLedger(path: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(path));
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

Deno.test("command ledgers reject a directory owned by another user", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  try {
    await assertRejects(
      () =>
        CommandLedger.accessForTestingOnly.open(path, {
          os: "linux",
          uid: () => Deno.uid()! + 1,
        }),
      Error,
      "directory has a different owner",
    );
    const ledger = await CommandLedger.accessForTestingOnly.open(path, {
      os: "linux",
      uid: () => Deno.uid(),
    });
    assertEquals(ledger.pendingPublicationCount(), 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("command ledgers reject a ledger path that is not a file", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  try {
    await Deno.mkdir(path);
    await assertRejects(
      () => CommandLedger.open(path),
      Error,
      "file is not a file",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("command ledgers keep their state and remove the temporary file when a write fails", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  try {
    const ledger = await CommandLedger.open(path);
    // A directory at the ledger path refuses the rename over it.
    await Deno.mkdir(path);
    await assertRejects(() => ledger.put(receipt("refused")));
    assertEquals(ledger.pendingPublicationCount(), 0);
    assertEquals(ledger.get("refused"), undefined);
    assertEquals(
      (await Array.fromAsync(Deno.readDir(directory))).map(({ name }) => name),
      ["ledger.json"],
    );

    await Deno.remove(path);
    await ledger.put(receipt("accepted"));
    assertEquals(ledger.pendingPublicationCount(), 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("command ledgers report a failed temporary-file cleanup with the write failure", async () => {
  const directory = await Deno.makeTempDir();
  // The ledger name fits the file system's name limit, and the temporary
  // name beside it does not, so creating and removing it both fail.
  const path = join(directory, "l".repeat(230));
  try {
    const ledger = await CommandLedger.open(path);
    const error = await assertRejects(
      () => ledger.put(receipt("refused")),
      AggregateError,
      "command ledger write and temporary-file cleanup failed",
    );
    assertEquals(error.errors.length, 2);
    assertEquals(ledger.pendingPublicationCount(), 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Windows command ledgers commit both slots before open returns", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  const previousPath = `${path}.previous`;
  try {
    const ledger = await CommandLedger.accessForTestingOnly.open(path, WINDOWS);
    const empty = ledgerFile();
    assertEquals(await readLedger(path), empty);
    assertEquals(await readLedger(previousPath), empty);

    const first = receipt("first");
    await ledger.put(first);
    assertEquals(
      await readLedger(previousPath),
      ledgerFile({
        generation: 2,
        receipts: { first },
        pendingPublicationCommandIds: ["first"],
      }),
    );
    assertEquals(await readLedger(path), empty);

    const reopened = await CommandLedger.accessForTestingOnly.open(
      path,
      WINDOWS,
    );
    assertEquals(reopened.get("first"), first);
    assertEquals(reopened.pendingPublicationCount(), 1);
    await reopened.markPublished("first");
    assertEquals(
      await readLedger(path),
      ledgerFile({ generation: 3, receipts: { first } }),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Windows command ledgers repair a missing or invalid slot from the valid one", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  const previousPath = `${path}.previous`;
  const stored = receipt("stored");
  const valid = ledgerFile({ generation: 4, receipts: { stored } });
  try {
    await writeLedger(previousPath, valid);
    const repaired = await CommandLedger.accessForTestingOnly.open(
      path,
      WINDOWS,
    );
    assertEquals(repaired.get("stored"), stored);
    assertEquals(await readLedger(path), valid);

    await Deno.writeTextFile(path, "interrupted");
    await CommandLedger.accessForTestingOnly.open(path, WINDOWS);
    assertEquals(await readLedger(path), valid);

    await Deno.writeTextFile(previousPath, "interrupted");
    const ledger = await CommandLedger.accessForTestingOnly.open(path, WINDOWS);
    assertEquals(await readLedger(previousPath), valid);
    await ledger.put(receipt("next"));
    assertEquals(await readLedger(path), valid);
    assertEquals(
      (await readLedger(previousPath) as { generation: number })
        .generation,
      5,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Windows command ledgers open from the newer of two valid slots", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  const older = receipt("older");
  const newer = receipt("newer");
  try {
    await writeLedger(path, ledgerFile({ generation: 7, receipts: { newer } }));
    await writeLedger(
      `${path}.previous`,
      ledgerFile({ generation: 6, receipts: { older } }),
    );
    const ledger = await CommandLedger.accessForTestingOnly.open(path, WINDOWS);
    assertEquals(ledger.get("newer"), newer);
    assertEquals(ledger.get("older"), undefined);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Windows command ledgers reject slots that disagree at one generation", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  const one = receipt("one");
  try {
    await writeLedger(path, ledgerFile({ generation: 3, receipts: { one } }));
    await writeLedger(
      `${path}.previous`,
      ledgerFile({ generation: 3, receipts: { one } }),
    );
    assertEquals(
      (await CommandLedger.accessForTestingOnly.open(path, WINDOWS)).get("one"),
      one,
    );

    await writeLedger(`${path}.previous`, ledgerFile({ generation: 3 }));
    await assertRejects(
      () => CommandLedger.accessForTestingOnly.open(path, WINDOWS),
      Error,
      "command ledger generations disagree between Windows slots",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Windows command ledgers reject two invalid slots", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  try {
    await writeLedger(path, ledgerFile({ generation: -1 }));
    await writeLedger(`${path}.previous`, null);
    const error = await assertRejects(
      () => CommandLedger.accessForTestingOnly.open(path, WINDOWS),
      AggregateError,
      "neither Windows command ledger slot is valid",
    );
    assertEquals(
      error.errors.map((reason: Error) => reason.message),
      [
        "command ledger generation must be a non-negative safe integer",
        "command ledger must contain an object",
      ],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Windows command ledgers accept files that Unix permissions would refuse", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "ledger.json");
  try {
    await writeLedger(path, ledgerFile());
    await Deno.chmod(path, 0o644);
    await assertRejects(
      () =>
        CommandLedger.accessForTestingOnly.open(path, {
          os: "linux",
          uid: () => Deno.uid(),
        }),
      Error,
      "file permits access by other users",
    );
    const ledger = await CommandLedger.accessForTestingOnly.open(path, WINDOWS);
    assert(ledger.pendingPublicationCount() === 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("writeAndSync writes every byte across short writes and then syncs", async () => {
  const written: number[] = [];
  const events: string[] = [];
  await writeAndSync({
    write: (bytes) => {
      // Each write takes at most two bytes, as a short write would.
      const taken = Math.min(2, bytes.length);
      written.push(...bytes.subarray(0, taken));
      events.push(`write ${taken}`);
      return Promise.resolve(taken);
    },
    sync: () => {
      events.push("sync");
      return Promise.resolve();
    },
  }, "abcde");
  assertEquals(new TextDecoder().decode(new Uint8Array(written)), "abcde");
  assertEquals(events, ["write 2", "write 2", "write 1", "sync"]);
});

Deno.test("writeAndSync throws, without syncing, when a write makes no progress", async () => {
  let synced = false;
  const error = await assertRejects(() =>
    writeAndSync({
      write: () => Promise.resolve(0),
      sync: () => {
        synced = true;
        return Promise.resolve();
      },
    }, "abc")
  );
  assertEquals(
    error instanceof Error ? error.message : error,
    "command ledger write made no progress",
  );
  assertEquals(synced, false);
});
