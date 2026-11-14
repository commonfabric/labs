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

/**
 * The facts about the running system that decide how a ledger lays out its
 * files and which files it accepts as its own.
 */
export interface CommandLedgerSystem {
  /** The operating system; `"windows"` selects the two-slot layout. */
  readonly os: typeof Deno.build.os;
  /** The user that must own the ledger's directory and files. */
  uid(): number | null;
}

const RUNNING_SYSTEM: CommandLedgerSystem = {
  os: Deno.build.os,
  uid: Deno.uid,
};

function comparableLedgerValue(value: ParsedLedgerFile): LedgerFile {
  return {
    schema: AGENT_CONNECTOR_SCHEMAS.commandLedger,
    generation: value.generation,
    receipts: storedReceipts(value.receipts),
    pendingPublicationCommandIds: [...value.pendingPublicationCommandIds]
      .sort((left, right) => left.localeCompare(right)),
  };
}

function ledgerFileContents(value: ParsedLedgerFile): string {
  return `${JSON.stringify(comparableLedgerValue(value), null, 2)}\n`;
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
  system: CommandLedgerSystem,
): void {
  if (info.isSymlink) {
    throw new Error(
      `command ledger ${kind} cannot be a symbolic link: ${path}`,
    );
  }
  if (kind === "directory" ? !info.isDirectory : !info.isFile) {
    throw new Error(`command ledger ${kind} is not a ${kind}: ${path}`);
  }
  if (system.os === "windows") return;
  if (info.uid !== null && info.uid !== system.uid()) {
    throw new Error(`command ledger ${kind} has a different owner: ${path}`);
  }
  if (info.mode !== null && (info.mode & 0o077) !== 0) {
    throw new Error(
      `command ledger ${kind} permits access by other users: ${path}`,
    );
  }
}

async function ensurePrivateDirectory(
  path: string,
  system: CommandLedgerSystem,
): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  validatePrivateInfo(await Deno.lstat(path), path, "directory", system);
}

async function validateExistingLedger(
  path: string,
  system: CommandLedgerSystem,
): Promise<boolean> {
  try {
    validatePrivateInfo(await Deno.lstat(path), path, "file", system);
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
  system: CommandLedgerSystem,
): Promise<ParsedLedgerFile | undefined> {
  await validateExistingLedger(path, system);
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

/**
 * Writes all of `contents` to `file` and synchronizes it. Throws when a write
 * reports no bytes written, which would otherwise repeat forever.
 */
async function writeAndSync(
  file: Pick<Deno.FsFile, "write" | "sync">,
  contents: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(contents);
  for (let offset = 0; offset < bytes.length;) {
    const written = await file.write(bytes.subarray(offset));
    if (written === 0) {
      throw new Error("command ledger write made no progress");
    }
    offset += written;
  }
  await file.sync();
}

/**
 * Writes `contents` to a new private file beside `path`, synchronizes it,
 * renames it over `path`, and then calls `commit`. The new file is removed
 * when any step before the rename fails.
 */
async function replaceFile(
  path: string,
  contents: string,
  commit: () => void,
): Promise<void> {
  const temp = `${path}.tmp-${Deno.pid}-${crypto.randomUUID()}`;
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
  } catch (error) {
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
    throw error;
  }
  commit();
}

async function replaceUnixFileDurably(
  path: string,
  contents: string,
  commit: () => void,
  system: CommandLedgerSystem,
): Promise<void> {
  const directoryPath = dirname(path);
  await ensurePrivateDirectory(directoryPath, system);
  await replaceFile(path, contents, commit);
  await syncDirectory(directoryPath);
}

async function writeWindowsLedgerSlot(
  path: string,
  contents: string,
  commit: () => void,
  system: CommandLedgerSystem,
): Promise<void> {
  await ensurePrivateDirectory(dirname(path), system);
  if (!await validateExistingLedger(path, system)) {
    await replaceFile(path, contents, commit);
    return;
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
  readonly #system: CommandLedgerSystem;
  readonly #receipts: Map<string, AgentSessionCommandReceipt>;
  readonly #pendingPublicationCommandIds: Set<string>;
  readonly #mutations = new AsyncSerialQueue();
  #generation: number;
  #windowsSlot?: WindowsLedgerSlot;

  private constructor(
    path: string,
    system: CommandLedgerSystem,
    receipts: Map<string, AgentSessionCommandReceipt>,
    pendingPublicationCommandIds: Set<string>,
    generation: number,
    windowsSlot?: WindowsLedgerSlot,
  ) {
    this.#path = path;
    this.#system = system;
    this.#receipts = receipts;
    this.#pendingPublicationCommandIds = pendingPublicationCommandIds;
    this.#generation = generation;
    this.#windowsSlot = windowsSlot;
  }

  /**
   * Opening a ledger as if on the operating system, and as the user, that
   * `system` states, which a test chooses, and the helper that writes a
   * ledger file, given a file a test supplies.
   */
  static get accessForTestingOnly(): {
    open(path: string, system: CommandLedgerSystem): Promise<CommandLedger>;
    writeAndSync(
      file: Pick<Deno.FsFile, "write" | "sync">,
      contents: string,
    ): Promise<void>;
  } {
    return {
      open: (path, system) => CommandLedger.#open(path, system),
      writeAndSync,
    };
  }

  /** Opens the ledger at `path`, creating its directory privately. */
  static open(path: string): Promise<CommandLedger> {
    return CommandLedger.#open(path, RUNNING_SYSTEM);
  }

  static async #open(
    path: string,
    system: CommandLedgerSystem,
  ): Promise<CommandLedger> {
    await ensurePrivateDirectory(dirname(path), system);
    if (system.os !== "windows") {
      const parsed = await readLedgerFile(path, system);
      return new CommandLedger(
        path,
        system,
        parsed?.receipts ?? new Map(),
        parsed?.pendingPublicationCommandIds ?? new Set(),
        parsed?.generation ?? 0,
      );
    }

    const previousPath = `${path}.previous`;
    const candidates = await Promise.allSettled([
      readLedgerFile(path, system),
      readLedgerFile(previousPath, system),
    ]);
    const valid = candidates.flatMap((
      result,
      index,
    ): { slot: WindowsLedgerSlot; value: ParsedLedgerFile }[] =>
      result.status === "fulfilled" && result.value
        ? [{ slot: index === 0 ? "primary" : "previous", value: result.value }]
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
    let ledger: CommandLedger;
    let inactivePath: string | undefined;
    if (selected) {
      ledger = new CommandLedger(
        path,
        system,
        selected.value.receipts,
        selected.value.pendingPublicationCommandIds,
        selected.value.generation,
        selected.slot,
      );
      if (valid.length === 1) {
        inactivePath = selected.slot === "primary" ? previousPath : path;
      }
    } else {
      const failures = candidates.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "neither Windows command ledger slot is valid",
        );
      }
      ledger = new CommandLedger(path, system, new Map(), new Set(), 0);
      await ledger.#persist(new Map(), new Set());
      inactivePath = previousPath;
    }
    if (inactivePath) {
      await writeWindowsLedgerSlot(
        inactivePath,
        ledgerFileContents({
          generation: ledger.#generation,
          receipts: ledger.#receipts,
          pendingPublicationCommandIds: ledger.#pendingPublicationCommandIds,
        }),
        () => undefined,
        system,
      );
    }
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
    const generation = this.#generation + 1;
    const contents = ledgerFileContents({
      generation,
      receipts: nextReceipts,
      pendingPublicationCommandIds: nextPendingPublicationCommandIds,
    });
    const nextSlot: WindowsLedgerSlot | undefined =
      this.#system.os === "windows"
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
      this.#generation = generation;
      this.#windowsSlot = nextSlot;
    };
    if (nextSlot) {
      await writeWindowsLedgerSlot(
        nextSlot === "primary" ? this.#path : `${this.#path}.previous`,
        contents,
        commit,
        this.#system,
      );
      return;
    }
    await replaceUnixFileDurably(this.#path, contents, commit, this.#system);
  }
}
