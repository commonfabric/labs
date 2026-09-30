import {
  normalizeCommandId,
  normalizeNativeSessionId,
  normalizeSourceId,
  sessionKey,
} from "./session-contract.ts";
import { AGENT_CONNECTOR_SCHEMAS } from "./protocol.ts";
import type { AgentDriver, CommandExecutionResult } from "./types.ts";
import type { CommandLedger } from "./command-ledger.ts";
import { hashFabricValue } from "./canonical-json.ts";
import { stableFabricValue } from "./stable-fabric-value.ts";

export type CommandType =
  | "prompt"
  | "start"
  | "cancel"
  | "rename"
  | "set-mode"
  | "set-config-option";

export interface AgentSessionCommand {
  schema: typeof AGENT_CONNECTOR_SCHEMAS.command;
  ownerDid: string;
  id: string;
  createdAt: string;
  sourceId: string;
  nativeSessionId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  force?: boolean;
  requestedBy?: string;
}

export interface AgentSessionCommandReceipt {
  schema: typeof AGENT_CONNECTOR_SCHEMAS.commandReceipt;
  ownerDid: string;
  commandId: string;
  sourceId: string;
  nativeSessionId: string;
  /**
   * The producer whose queue delivered the command; absent for a command
   * from the owner's queue. Part of the command's identity: an ID repeated
   * on another queue names another command.
   */
  producer?: string;
  status:
    | "pending"
    | "in-flight"
    | "succeeded"
    | "failed"
    | "unsupported"
    | "needs-confirmation"
    | "unknown";
  claimedAt?: string;
  completedAt?: string;
  providerOperationId?: string;
  error?: { code: string; message: string; retryable: boolean };
  result?: Record<string, unknown>;
}

export interface CommandTarget {
  publishReceipt(receipt: AgentSessionCommandReceipt): Promise<void>;
  refreshSession(driver: AgentDriver, nativeSessionId: string): Promise<void>;
  readReceipt?(
    commandId: string,
    producer?: string,
  ): Promise<AgentSessionCommandReceipt | undefined>;
}

export interface CommandTaskFailure {
  commandId: string;
  producer?: string;
  sourceId: string;
  nativeSessionId: string;
  error: unknown;
}

/**
 * A command's identity: its ID qualified by the queue it arrived on. The
 * owner's queue contributes nothing, so a receipt from it keeps the plain
 * ID; a producer's queue prefixes the producer, separated by the one byte
 * neither part can contain.
 */
export function commandIdentity(commandId: string, producer?: string): string {
  return producer === undefined ? commandId : `${producer}\u0000${commandId}`;
}

interface PromptAdmission {
  ready: Promise<void>;
  markReady(): void;
}

const RECEIPT_STATUSES = new Set([
  "pending",
  "in-flight",
  "succeeded",
  "failed",
  "unsupported",
  "needs-confirmation",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalReceiptString(
  value: unknown,
  field: string,
  context: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) {
    throw new Error(`${context} ${field} must be a string`);
  }
  return value;
}

function optionalReceiptTimestamp(
  value: unknown,
  field: string,
  context: string,
): string | undefined {
  const timestamp = optionalReceiptString(value, field, context);
  if (timestamp === undefined) return undefined;
  const parsed = new Date(timestamp);
  if (
    !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp
  ) {
    throw new Error(`${context} ${field} must be an ISO timestamp`);
  }
  return timestamp;
}

export function parseCommandReceipt(
  commandId: string,
  value: unknown,
  context = "command receipt",
): AgentSessionCommandReceipt {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object: ${commandId}`);
  }
  if (value.schema !== AGENT_CONNECTOR_SCHEMAS.commandReceipt) {
    throw new Error(
      `${context} schema must be ${AGENT_CONNECTOR_SCHEMAS.commandReceipt}: ${commandId}`,
    );
  }
  if (!isNonEmptyString(value.ownerDid)) {
    throw new Error(`${context} ownerDid must be a string: ${commandId}`);
  }
  if (value.commandId !== commandId) {
    throw new Error(`${context} key does not match commandId: ${commandId}`);
  }
  if (normalizeCommandId(commandId) !== commandId) {
    throw new Error(`${context} commandId is not normalized: ${commandId}`);
  }
  if (!isNonEmptyString(value.sourceId)) {
    throw new Error(`${context} sourceId must be a string: ${commandId}`);
  }
  if (!isNonEmptyString(value.nativeSessionId)) {
    throw new Error(
      `${context} nativeSessionId must be a string: ${commandId}`,
    );
  }
  if (normalizeSourceId(value.sourceId) !== value.sourceId) {
    throw new Error(`${context} sourceId is not normalized: ${commandId}`);
  }
  if (
    normalizeNativeSessionId(value.nativeSessionId) !== value.nativeSessionId
  ) {
    throw new Error(
      `${context} nativeSessionId is not normalized: ${commandId}`,
    );
  }
  if (typeof value.status !== "string" || !RECEIPT_STATUSES.has(value.status)) {
    throw new Error(`${context} status is invalid: ${commandId}`);
  }
  const producer = optionalReceiptString(value.producer, "producer", context);
  if (producer !== undefined && normalizeSourceId(producer) !== producer) {
    throw new Error(`${context} producer is not normalized: ${commandId}`);
  }
  const claimedAt = optionalReceiptTimestamp(
    value.claimedAt,
    "claimedAt",
    context,
  );
  const completedAt = optionalReceiptTimestamp(
    value.completedAt,
    "completedAt",
    context,
  );
  const providerOperationId = optionalReceiptString(
    value.providerOperationId,
    "providerOperationId",
    context,
  );
  let error: AgentSessionCommandReceipt["error"];
  if (value.error !== undefined) {
    if (
      !isRecord(value.error) || !isNonEmptyString(value.error.code) ||
      !isNonEmptyString(value.error.message) ||
      typeof value.error.retryable !== "boolean"
    ) {
      throw new Error(`${context} error is invalid: ${commandId}`);
    }
    error = {
      code: value.error.code,
      message: value.error.message,
      retryable: value.error.retryable,
    };
  }
  if (value.result !== undefined && !isRecord(value.result)) {
    throw new Error(`${context} result must be an object: ${commandId}`);
  }
  return {
    schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
    ownerDid: value.ownerDid,
    commandId,
    sourceId: value.sourceId,
    ...(producer === undefined ? {} : { producer }),
    nativeSessionId: value.nativeSessionId,
    status: value.status as AgentSessionCommandReceipt["status"],
    ...(claimedAt ? { claimedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(providerOperationId ? { providerOperationId } : {}),
    ...(error ? { error } : {}),
    ...(value.result
      ? {
        result: stableFabricValue(value.result) as Record<string, unknown>,
      }
      : {}),
  };
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 4096,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${field} exceeds ${maxLength} characters`);
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  field: string,
  maxLength = 4096,
): string | undefined {
  return value === undefined
    ? undefined
    : requiredString(value, field, maxLength);
}

function parseCommand(value: unknown, ownerDid: string): AgentSessionCommand {
  if (typeof value === "string") {
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch (error) {
      throw new Error(`command JSON is invalid: ${error}`);
    }
    return parseCommand(decoded, ownerDid);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("command must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schema !== AGENT_CONNECTOR_SCHEMAS.command) {
    throw new Error("unsupported command schema");
  }
  if (raw.ownerDid !== ownerDid) {
    throw new Error("command owner does not match this connector");
  }
  const type = raw.type;
  if (
    ![
      "prompt",
      "start",
      "cancel",
      "rename",
      "set-mode",
      "set-config-option",
    ].includes(String(type))
  ) {
    throw new Error(`unsupported command type: ${String(type)}`);
  }
  if (!isRecord(raw.payload)) {
    throw new Error("command payload must be an object");
  }
  const payload = { ...raw.payload };
  const id = normalizeCommandId(requiredString(raw.id, "command id", 256));
  const sourceId = normalizeSourceId(
    requiredString(raw.sourceId, "sourceId", 256),
  );
  const nativeSessionId = requiredString(
    raw.nativeSessionId,
    "nativeSessionId",
    1024,
  );
  sessionKey(sourceId, nativeSessionId);
  return {
    schema: AGENT_CONNECTOR_SCHEMAS.command,
    ownerDid,
    id,
    createdAt: requiredString(raw.createdAt, "createdAt", 128),
    sourceId,
    nativeSessionId,
    type: type as CommandType,
    payload,
    force: raw.force === true,
    requestedBy: typeof raw.requestedBy === "string"
      ? raw.requestedBy
      : undefined,
  };
}

function receiptFromResult(
  command: AgentSessionCommand,
  producer: string | undefined,
  claimedAt: string,
  result: CommandExecutionResult,
): AgentSessionCommandReceipt {
  return {
    schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
    ownerDid: command.ownerDid,
    commandId: command.id,
    sourceId: command.sourceId,
    nativeSessionId: command.nativeSessionId,
    ...(producer === undefined ? {} : { producer }),
    status: result.status,
    claimedAt,
    completedAt: new Date().toISOString(),
    providerOperationId: result.providerOperationId,
    error: result.error,
    result: result.result,
  };
}

export class CommandWorker {
  readonly #drivers: Map<string, AgentDriver>;
  readonly #targets: CommandTarget[];
  readonly #ledger: CommandLedger;
  readonly #ownerDid: string;
  readonly #onReceipt?: (
    receipt: AgentSessionCommandReceipt,
  ) => Promise<void> | void;
  readonly #onTaskFailure?: (failure: CommandTaskFailure) => void;
  readonly #sessionQueues = new Map<string, Promise<void>>();
  readonly #promptAdmissions = new Map<string, PromptAdmission[]>();
  readonly #scheduledCommandIds = new Set<string>();
  readonly #activeTasks = new Set<Promise<void>>();
  readonly #taskFailures: unknown[] = [];
  #handleQueue: Promise<void> = Promise.resolve();

  constructor(
    drivers: Map<string, AgentDriver>,
    targets: CommandTarget[],
    ledger: CommandLedger,
    ownerDid: string,
    onReceipt?: (
      receipt: AgentSessionCommandReceipt,
    ) => Promise<void> | void,
    onTaskFailure?: (failure: CommandTaskFailure) => void,
  ) {
    this.#drivers = drivers;
    this.#targets = targets;
    this.#ledger = ledger;
    this.#ownerDid = ownerDid;
    this.#onReceipt = onReceipt;
    this.#onTaskFailure = onTaskFailure;
  }

  async recoverUnpublishedReceipts(): Promise<void> {
    const failures: unknown[] = [];
    for (const receipt of await this.#ledger.recoverUnpublishedReceipts()) {
      try {
        await this.#publishTrackedReceipt(receipt);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "could not publish recovered command receipts",
      );
    }
  }

  /**
   * Admits the commands one queue delivered. `producer` names the queue: a
   * producer's ID, or `undefined` for the owner's queue. It qualifies each
   * command's identity, so an ID a producer reuses across restarts is the
   * same command delivered again, while the same ID on another queue is
   * another command.
   */
  handle(values: unknown[], producer?: string): Promise<void> {
    const task = this.#handleQueue.then(() =>
      this.#handleSerial(values, producer)
    );
    this.#handleQueue = task.catch(() => undefined);
    return task;
  }

  async #handleSerial(
    values: unknown[],
    producer: string | undefined,
  ): Promise<void> {
    for (const value of values) {
      let command: AgentSessionCommand;
      try {
        command = parseCommand(value, this.#ownerDid);
      } catch (error) {
        console.error(`[agents-connector] invalid command: ${error}`);
        continue;
      }
      const identity = commandIdentity(command.id, producer);
      if (
        this.#ledger.get(command.id, producer) ||
        this.#scheduledCommandIds.has(identity)
      ) continue;
      try {
        const existing = await this.#readPublishedReceipt(
          command.id,
          producer,
        );
        if (existing) {
          if (
            existing.sourceId !== command.sourceId ||
            existing.nativeSessionId !== command.nativeSessionId ||
            existing.ownerDid !== command.ownerDid
          ) {
            throw new Error(
              `command ID belongs to another session: ${command.id}`,
            );
          }
          const receipt: AgentSessionCommandReceipt =
            existing.status === "in-flight"
              ? {
                ...existing,
                status: "unknown",
                completedAt: new Date().toISOString(),
                error: {
                  code: "orphaned-shared-claim",
                  message:
                    "another host published a command claim without a terminal outcome",
                  retryable: false,
                },
              }
              : existing;
          await this.#ledger.put(receipt);
          await this.#publishTrackedReceipt(receipt);
          continue;
        }
      } catch (error) {
        this.#taskFailures.push(error);
        this.#notifyTaskFailure(command, producer, error);
        console.error(
          `[agents-connector] command ownership check failed command=${command.id}: ${error}`,
        );
        continue;
      }
      this.#scheduledCommandIds.add(identity);
      const key = sessionKey(command.sourceId, command.nativeSessionId);
      let promptAdmission: PromptAdmission | undefined;
      if (command.type === "prompt" || command.type === "start") {
        const ready = Promise.withResolvers<void>();
        let marked = false;
        promptAdmission = {
          ready: ready.promise,
          markReady() {
            if (marked) return;
            marked = true;
            ready.resolve();
          },
        };
        const admissions = this.#promptAdmissions.get(key) ?? [];
        admissions.push(promptAdmission);
        this.#promptAdmissions.set(key, admissions);
      }
      const precedingPrompt = this.#promptAdmissions.get(key)?.[0];
      const task = command.type === "cancel"
        ? (precedingPrompt?.ready ?? Promise.resolve()).then(() =>
          this.#execute(command, producer)
        )
        : (this.#sessionQueues.get(key) ?? Promise.resolve())
          .catch(() => undefined)
          .then(() =>
            this.#execute(command, producer, promptAdmission?.markReady)
          );
      if (command.type !== "cancel") this.#sessionQueues.set(key, task);
      this.#activeTasks.add(task);
      task.catch((error) => {
        this.#taskFailures.push(error);
        this.#notifyTaskFailure(command, producer, error);
        console.error(
          `[agents-connector] command failed command=${command.id}: ${error}`,
        );
      }).finally(() => {
        this.#scheduledCommandIds.delete(identity);
        this.#activeTasks.delete(task);
        if (
          command.type !== "cancel" && this.#sessionQueues.get(key) === task
        ) {
          this.#sessionQueues.delete(key);
        }
        if (promptAdmission) {
          promptAdmission.markReady();
          const admissions = this.#promptAdmissions.get(key);
          if (admissions) {
            const index = admissions.indexOf(promptAdmission);
            if (index !== -1) admissions.splice(index, 1);
            if (admissions.length === 0) {
              this.#promptAdmissions.delete(key);
            }
          }
        }
      });
    }
  }

  async #readPublishedReceipt(
    commandId: string,
    producer: string | undefined,
  ): Promise<AgentSessionCommandReceipt | undefined> {
    let found: AgentSessionCommandReceipt | undefined;
    for (const target of this.#targets) {
      if (!target.readReceipt) continue;
      const receipt = await target.readReceipt(commandId, producer);
      if (!receipt) continue;
      if (found && hashFabricValue(found) !== hashFabricValue(receipt)) {
        throw new Error(
          `command targets disagree about the existing receipt: ${commandId}`,
        );
      }
      found = receipt;
    }
    return found;
  }

  async drain(): Promise<void> {
    await this.#handleQueue;
    await Promise.allSettled([...this.#activeTasks]);
    const failures = this.#taskFailures.splice(0);
    if (failures.length > 0) {
      throw new AggregateError(failures, "command worker operations failed");
    }
  }

  #notifyTaskFailure(
    command: AgentSessionCommand,
    producer: string | undefined,
    error: unknown,
  ): void {
    try {
      this.#onTaskFailure?.({
        commandId: command.id,
        ...(producer === undefined ? {} : { producer }),
        sourceId: command.sourceId,
        nativeSessionId: command.nativeSessionId,
        error,
      });
    } catch (observationError) {
      console.error(
        `[agents-connector] command failure observation failed command=${command.id}: ${observationError}`,
      );
    }
  }

  async #execute(
    command: AgentSessionCommand,
    producer: string | undefined,
    markCancellationReady?: () => void,
  ): Promise<void> {
    const claimedAt = new Date().toISOString();
    const inFlight: AgentSessionCommandReceipt = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
      ownerDid: command.ownerDid,
      commandId: command.id,
      sourceId: command.sourceId,
      nativeSessionId: command.nativeSessionId,
      ...(producer === undefined ? {} : { producer }),
      status: "in-flight",
      claimedAt,
    };
    await this.#ledger.put(inFlight);
    try {
      await this.#publishTrackedReceipt(inFlight);
    } catch (error) {
      const failed: AgentSessionCommandReceipt = {
        ...inFlight,
        status: "failed",
        completedAt: new Date().toISOString(),
        error: {
          code: "claim-publish-failed",
          message: String(error),
          retryable: true,
        },
      };
      await this.#ledger.put(failed);
      try {
        await this.#publishTrackedReceipt(failed);
      } catch (failedReceiptError) {
        throw new AggregateError(
          [error, failedReceiptError],
          "could not publish the command claim or its failure receipt",
        );
      }
      return;
    }

    const driver = this.#drivers.get(command.sourceId);
    const invocation = driver
      ? Promise.resolve().then(() =>
        this.#invoke(
          driver,
          command,
          markCancellationReady,
          async () => {
            markCancellationReady?.();
            await Promise.allSettled(
              this.#targets.map((target) =>
                target.refreshSession(driver, command.nativeSessionId)
              ),
            );
          },
        )
      ).catch((
        error,
      ): CommandExecutionResult => ({
        status: "failed",
        error: {
          code: "provider-call-failed",
          message: String(error),
          retryable: false,
        },
      }))
      : undefined;
    const result = invocation ? await invocation : {
      status: "unsupported" as const,
      error: {
        code: "source-unavailable",
        message: `source is not available: ${command.sourceId}`,
        retryable: true,
      },
    };
    const terminal = receiptFromResult(command, producer, claimedAt, result);
    await this.#ledger.put(terminal);
    let publicationFailed = false;
    let publicationError: unknown;
    try {
      await this.#publishTrackedReceipt(terminal);
    } catch (error) {
      publicationFailed = true;
      publicationError = error;
    }
    // The command's own session is refreshed unless the driver named
    // another, or none: a desktop start opens the app and the person sends
    // the prompt, so no session exists to read yet, and reading the one the
    // command named would fail the refresh.
    const affected = result.affectedSession === undefined
      ? command.nativeSessionId
      : result.affectedSession;
    if (
      driver && affected !== null &&
      (result.status === "succeeded" || command.type === "prompt" ||
        command.type === "start")
    ) {
      await Promise.allSettled(
        this.#targets.map((target) => target.refreshSession(driver, affected)),
      );
    }
    if (publicationFailed) throw publicationError;
  }

  #invoke(
    driver: AgentDriver,
    command: AgentSessionCommand,
    onCancellationReady: (() => void) | undefined,
    onSessionActive: () => Promise<void>,
  ): Promise<CommandExecutionResult> {
    switch (command.type) {
      case "prompt":
        return driver.prompt(
          command.nativeSessionId,
          {
            text: requiredString(
              command.payload.text,
              "prompt text",
              128 * 1024,
            ),
          },
          {
            force: command.force,
            onCancellationReady,
            onSessionActive,
          },
        );
      case "start": {
        const cwd = optionalString(command.payload.cwd, "start cwd");
        const title = optionalString(command.payload.title, "start title", 512);
        const mode = optionalString(command.payload.mode, "start mode", 128);
        const surface = optionalString(
          command.payload.surface,
          "start surface",
          32,
        );
        return driver.startSession(
          command.nativeSessionId,
          {
            text: requiredString(
              command.payload.text,
              "start text",
              128 * 1024,
            ),
            ...(cwd !== undefined ? { cwd } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(mode !== undefined ? { mode } : {}),
            ...(surface !== undefined ? { surface } : {}),
          },
          {
            force: command.force,
            onCancellationReady,
            onSessionActive,
          },
        );
      }
      case "cancel":
        return driver.cancel(command.nativeSessionId);
      case "rename":
        return driver.renameSession(
          command.nativeSessionId,
          requiredString(command.payload.title, "rename title", 512),
        );
      case "set-mode":
        return driver.setMode(
          command.nativeSessionId,
          requiredString(command.payload.mode, "mode", 128),
        );
      case "set-config-option":
        return driver.setConfigOption(
          command.nativeSessionId,
          requiredString(command.payload.key, "config key", 256),
          command.payload.value,
        );
    }
  }

  async #publishReceipt(
    receipt: AgentSessionCommandReceipt,
  ): Promise<void> {
    await Promise.all(
      this.#targets.map((target) => target.publishReceipt(receipt)),
    );
  }

  async #publishTrackedReceipt(
    receipt: AgentSessionCommandReceipt,
  ): Promise<void> {
    await this.#publishReceipt(receipt);
    await this.#ledger.markPublished(receipt.commandId, receipt.producer);
    try {
      await this.#onReceipt?.(receipt);
    } catch (error) {
      console.error(
        `[agents-connector] receipt observation failed command=${receipt.commandId}: ${error}`,
      );
    }
  }
}
