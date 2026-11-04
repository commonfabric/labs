import { dirname } from "@std/path";
import {
  type AgentSessionCommandReceipt,
  commandIdentity,
  parseCommandReceipt,
} from "./commands.ts";
import { AGENT_CONNECTOR_SCHEMAS } from "./protocol.ts";
import { AsyncSerialQueue } from "./serial-queue.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { stableFabricValue } from "./stable-fabric-value.ts";

type StoredReceipt = Omit<AgentSessionCommandReceipt, "result"> & {
  result?: string;
};

/** Receipts and the pending list are keyed by command identity (the ID
 * qualified by its producer), not by the bare ID. */
interface LedgerFile {
  schema: typeof AGENT_CONNECTOR_SCHEMAS.commandLedger;
  generation: number;
  receipts: Record<string, StoredReceipt>;
  pendingPublicationCommandIds: string[];
}

interface ParsedLedgerFile {
  generation: number;
  receipts: Map<string, AgentSessionCommandReceipt>;
  pendingPublicationCommandIds: Set<string>;
}

type WindowsLedgerSlot = "primary" | "previous";

function comparableLedgerValue(value: ParsedLedgerFile): LedgerFile {
  return {
    schema: AGENT_CONNECTOR_SCHEMAS.commandLedger,
    generation: value.generation,
    receipts: storedReceipts(value.receipts),
    pendingPublicationCommandIds: [...value.pendingPublicationCommandIds]
      .sort((left, right) => left.localeCompare(right)),
  };
}

function storeReceipt(receipt: AgentSessionCommandReceipt): StoredReceipt {
  const { result, ...stored } = receipt;
  return {
    ...stored,
    ...(result === undefined
      ? {}
      : { result: jsonFromFabricValue(stableFabricValue(result)) }),
  };
}

function storedReceipts(
  receipts: Map<string, AgentSessionCommandReceipt>,
): Record<string, StoredReceipt> {
  return Object.fromEntries(
    [...receipts].sort(([left], [right]) => left.localeCompare(right)).map(
      ([commandId, receipt]) => [commandId, storeReceipt(receipt)],
    ),
  );
}

function parseStoredReceipt(
  key: string,
  value: unknown,
): AgentSessionCommandReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`command ledger receipt must be an object: ${key}`);
  }
  const stored = value as Record<string, unknown>;
  if (typeof stored.commandId !== "string") {
    throw new Error(`command ledger receipt must name its commandId: ${key}`);
  }
  if (stored.result !== undefined && typeof stored.result !== "string") {
    throw new Error(
      `command ledger receipt result must use Fabric JSON: ${key}`,
    );
  }
  const receipt = parseCommandReceipt(stored.commandId, {
    ...stored,
    ...(typeof stored.result === "string"
      ? { result: fabricFromJsonValue(stored.result) }
      : {}),
  }, "command ledger receipt");
  if (commandIdentity(receipt.commandId, receipt.producer) !== key) {
    throw new Error(
      `command ledger receipt key does not match its identity: ${key}`,
    );
  }
  return receipt;
}

function validatePrivateInfo(
  info: Deno.FileInfo,
  path: string,
  kind: "directory" | "file",
): void {
  if (info.isSymlink) {
    throw new Error(
      `command ledger ${kind} cannot be a symbolic link: ${path}`,
    );
  }
  if (kind === "directory" ? !info.isDirectory : !info.isFile) {
    throw new Error(`command ledger ${kind} is not a ${kind}: ${path}`);
  }
  if (Deno.build.os === "windows") return;
  if (info.uid !== null && info.uid !== Deno.uid()) {
    throw new Error(`command ledger ${kind} has a different owner: ${path}`);
  }
  if (info.mode !== null && (info.mode & 0o077) !== 0) {
    throw new Error(
      `command ledger ${kind} permits access by other users: ${path}`,
    );
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  validatePrivateInfo(await Deno.lstat(path), path, "directory");
}

async function validateExistingLedger(path: string): Promise<boolean> {
  try {
    validatePrivateInfo(await Deno.lstat(path), path, "file");
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function parseLedgerFile(decoded: unknown): ParsedLedgerFile {
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("command ledger must contain an object");
  }
  const parsed = decoded as Partial<LedgerFile>;
  if (parsed.schema !== AGENT_CONNECTOR_SCHEMAS.commandLedger) {
    throw new Error(
      `command ledger schema must be ${AGENT_CONNECTOR_SCHEMAS.commandLedger}`,
    );
  }
  if (!Number.isSafeInteger(parsed.generation) || parsed.generation! < 0) {
    throw new Error(
      "command ledger generation must be a non-negative safe integer",
    );
  }
  if (
    !parsed.receipts || typeof parsed.receipts !== "object" ||
    Array.isArray(parsed.receipts)
  ) {
    throw new Error("command ledger receipts must be an object");
  }
  if (
    !Array.isArray(parsed.pendingPublicationCommandIds) ||
    !parsed.pendingPublicationCommandIds.every((id) => typeof id === "string")
  ) {
    throw new Error(
      "command ledger pendingPublicationCommandIds must be a string array",
    );
  }
  const receipts = new Map(
    Object.entries(parsed.receipts).map(([commandId, receipt]) => [
      commandId,
      parseStoredReceipt(commandId, receipt),
    ]),
  );
  if (
    new Set(parsed.pendingPublicationCommandIds).size !==
      parsed.pendingPublicationCommandIds.length
  ) {
    throw new Error(
      "command ledger pendingPublicationCommandIds must not contain duplicates",
    );
  }
  const pendingPublicationCommandIds = new Set(
    parsed.pendingPublicationCommandIds,
  );
  for (const commandId of pendingPublicationCommandIds) {
    if (!receipts.has(commandId)) {
      throw new Error(
        `command ledger pending receipt is missing: ${commandId}`,
      );
    }
  }
  return {
    generation: parsed.generation!,
    receipts,
    pendingPublicationCommandIds,
  };
}

async function readLedgerFile(
  path: string,
): Promise<ParsedLedgerFile | undefined> {
  await validateExistingLedger(path);
  try {
    return parseLedgerFile(JSON.parse(await Deno.readTextFile(path)));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await Deno.open(path, { read: true });
  try {
    await directory.sync();
  } finally {
    directory.close();
  }
}

async function writeAndSync(
  file: Deno.FsFile,
  contents: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(contents);
  let offset = 0;
  while (offset < bytes.length) {
    const written = await file.write(bytes.subarray(offset));
    if (written === 0) {
      throw new Error("command ledger write made no progress");
    }
    offset += written;
  }
  await file.sync();
}

async function replaceUnixFileDurably(
  path: string,
  contents: string,
  commit: () => void,
): Promise<void> {
  const directoryPath = dirname(path);
  await ensurePrivateDirectory(directoryPath);
  const temp = `${path}.tmp-${Deno.pid}-${crypto.randomUUID()}`;
  let renamed = false;
  try {
    const file = await Deno.open(temp, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    try {
      await writeAndSync(file, contents);
    } finally {
      file.close();
    }
    await Deno.rename(temp, path);
    renamed = true;
    commit();
    await syncDirectory(directoryPath);
  } catch (error) {
    if (!renamed) {
      try {
        await Deno.remove(temp);
      } catch (cleanupError) {
        if (!(cleanupError instanceof Deno.errors.NotFound)) {
          throw new AggregateError(
            [error, cleanupError],
            "command ledger write and temporary-file cleanup failed",
          );
        }
      }
    }
    throw error;
  }
}

async function writeWindowsLedgerSlot(
  path: string,
  contents: string,
  commit: () => void,
): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const exists = await validateExistingLedger(path);
  if (!exists) {
    const temp = `${path}.tmp-${Deno.pid}-${crypto.randomUUID()}`;
    let renamed = false;
    try {
      const file = await Deno.open(temp, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
      try {
        await writeAndSync(file, contents);
      } finally {
        file.close();
      }
      await Deno.rename(temp, path);
      renamed = true;
      commit();
      return;
    } catch (error) {
      if (!renamed) {
        try {
          await Deno.remove(temp);
        } catch (cleanupError) {
          if (!(cleanupError instanceof Deno.errors.NotFound)) {
            throw new AggregateError(
              [error, cleanupError],
              "command ledger write and temporary-file cleanup failed",
            );
          }
        }
      }
      throw error;
    }
  }
  const file = await Deno.open(path, {
    truncate: true,
    write: true,
    mode: 0o600,
  });
  try {
    await writeAndSync(file, contents);
  } finally {
    file.close();
  }
  commit();
}

export class CommandLedger {
  readonly #path: string;
  readonly #receipts: Map<string, AgentSessionCommandReceipt>;
  readonly #pendingPublicationCommandIds: Set<string>;
  readonly #mutations = new AsyncSerialQueue();
  #generation: number;
  #windowsSlot?: WindowsLedgerSlot;

  private constructor(
    path: string,
    receipts: Map<string, AgentSessionCommandReceipt>,
    pendingPublicationCommandIds: Set<string>,
    generation: number,
    windowsSlot?: WindowsLedgerSlot,
  ) {
    this.#path = path;
    this.#receipts = receipts;
    this.#pendingPublicationCommandIds = pendingPublicationCommandIds;
    this.#generation = generation;
    this.#windowsSlot = windowsSlot;
  }

  static async open(path: string): Promise<CommandLedger> {
    await ensurePrivateDirectory(dirname(path));
    if (Deno.build.os !== "windows") {
      const parsed = await readLedgerFile(path);
      return new CommandLedger(
        path,
        parsed?.receipts ?? new Map(),
        parsed?.pendingPublicationCommandIds ?? new Set(),
        parsed?.generation ?? 0,
      );
    }

    const previousPath = `${path}.previous`;
    const candidates = await Promise.allSettled([
      readLedgerFile(path),
      readLedgerFile(previousPath),
    ]);
    const valid = candidates.flatMap((result, index) =>
      result.status === "fulfilled" && result.value
        ? [{
          slot: (index === 0 ? "primary" : "previous") as WindowsLedgerSlot,
          value: result.value,
        }]
        : []
    ).sort((left, right) => right.value.generation - left.value.generation);
    if (
      valid.length > 1 &&
      valid[0].value.generation === valid[1].value.generation &&
      canonicalJson(comparableLedgerValue(valid[0].value)) !==
        canonicalJson(comparableLedgerValue(valid[1].value))
    ) {
      throw new Error(
        "command ledger generations disagree between Windows slots",
      );
    }
    const selected = valid[0];
    if (selected) {
      if (valid.length === 1) {
        const mirrorPath = selected.slot === "primary" ? previousPath : path;
        await writeWindowsLedgerSlot(
          mirrorPath,
          `${JSON.stringify(comparableLedgerValue(selected.value), null, 2)}\n`,
          () => undefined,
        );
      }
      return new CommandLedger(
        path,
        selected.value.receipts,
        selected.value.pendingPublicationCommandIds,
        selected.value.generation,
        selected.slot,
      );
    }
    const failures = candidates.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "neither Windows command ledger slot is valid",
      );
    }
    const ledger = new CommandLedger(path, new Map(), new Set(), 0);
    await ledger.#persist(new Map(), new Set());
    await writeWindowsLedgerSlot(
      previousPath,
      `${
        JSON.stringify(
          comparableLedgerValue({
            generation: ledger.#generation,
            receipts: ledger.#receipts,
            pendingPublicationCommandIds: ledger.#pendingPublicationCommandIds,
          }),
          null,
          2,
        )
      }\n`,
      () => undefined,
    );
    return ledger;
  }

  get(
    commandId: string,
    producer?: string,
  ): AgentSessionCommandReceipt | undefined {
    const receipt = this.#receipts.get(commandIdentity(commandId, producer));
    return receipt ? parseCommandReceipt(commandId, receipt) : undefined;
  }

  pendingPublicationCount(): number {
    return this.#pendingPublicationCommandIds.size;
  }

  async put(receipt: AgentSessionCommandReceipt): Promise<void> {
    await this.#mutations.run(async () => {
      const stored = parseCommandReceipt(
        receipt.commandId,
        receipt,
        "command ledger receipt",
      );
      const receipts = new Map(this.#receipts);
      const pendingPublicationCommandIds = new Set(
        this.#pendingPublicationCommandIds,
      );
      const key = commandIdentity(stored.commandId, stored.producer);
      receipts.set(key, stored);
      pendingPublicationCommandIds.add(key);
      await this.#persist(receipts, pendingPublicationCommandIds);
    });
  }

  markPublished(commandId: string, producer?: string): Promise<void> {
    return this.#mutations.run(async () => {
      const key = commandIdentity(commandId, producer);
      if (!this.#pendingPublicationCommandIds.has(key)) return;
      const pendingPublicationCommandIds = new Set(
        this.#pendingPublicationCommandIds,
      );
      pendingPublicationCommandIds.delete(key);
      await this.#persist(this.#receipts, pendingPublicationCommandIds);
    });
  }

  recoverUnpublishedReceipts(): Promise<AgentSessionCommandReceipt[]> {
    return this.#mutations.run(async () => {
      const receipts = new Map(this.#receipts);
      const pendingPublicationCommandIds = new Set(
        this.#pendingPublicationCommandIds,
      );
      for (const [commandId, receipt] of receipts) {
        if (receipt.status !== "in-flight") continue;
        const next: AgentSessionCommandReceipt = {
          ...receipt,
          status: "unknown",
          completedAt: new Date().toISOString(),
          error: {
            code: "orphaned-in-flight",
            message:
              "process restarted after claiming the command; provider outcome is unknown",
            retryable: false,
          },
        };
        receipts.set(commandId, next);
        pendingPublicationCommandIds.add(commandId);
      }
      await this.#persist(receipts, pendingPublicationCommandIds);
      return [...this.#pendingPublicationCommandIds]
        .sort((left, right) => left.localeCompare(right))
        .map((key) => {
          const receipt = this.#receipts.get(key)!;
          return parseCommandReceipt(receipt.commandId, receipt);
        });
    });
  }

  async #persist(
    receipts: Map<string, AgentSessionCommandReceipt>,
    pendingPublicationCommandIds: Set<string>,
  ): Promise<void> {
    if (this.#generation === Number.MAX_SAFE_INTEGER) {
      throw new Error("command ledger generation is exhausted");
    }
    const nextReceipts = new Map(receipts);
    const nextPendingPublicationCommandIds = new Set(
      pendingPublicationCommandIds,
    );
    const value: LedgerFile = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandLedger,
      generation: this.#generation + 1,
      receipts: storedReceipts(nextReceipts),
      pendingPublicationCommandIds: [...nextPendingPublicationCommandIds]
        .sort((left, right) => left.localeCompare(right)),
    };
    const nextSlot: WindowsLedgerSlot | undefined = Deno.build.os === "windows"
      ? this.#windowsSlot === "primary" ? "previous" : "primary"
      : undefined;
    const commit = () => {
      this.#receipts.clear();
      for (const [commandId, receipt] of nextReceipts) {
        this.#receipts.set(commandId, receipt);
      }
      this.#pendingPublicationCommandIds.clear();
      for (const commandId of nextPendingPublicationCommandIds) {
        this.#pendingPublicationCommandIds.add(commandId);
      }
      this.#generation = value.generation;
      this.#windowsSlot = nextSlot;
    };
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    if (nextSlot) {
      await writeWindowsLedgerSlot(
        nextSlot === "primary" ? this.#path : `${this.#path}.previous`,
        contents,
        commit,
      );
      return;
    }
    await replaceUnixFileDurably(this.#path, contents, commit);
  }
}
