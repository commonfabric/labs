/**
 * Executes the explicitly configured host's Loom authoring commands. Successful
 * composition requires a matching durable receipt beside its current manifest.
 */

import { sha256 } from "@commonfabric/content-hash";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { isAbsolute } from "@std/path";

import type { ProcessRunner } from "./sandbox/process-runner.ts";
import { createClearedHostProcessEnv } from "./tools/host-process-env.ts";

/** Host-owned attribution and routing for the Loom command transport. */
export type HarnessLoomAuthoringTransport =
  | { kind: "broker"; queuePath: string }
  | { kind: "direct"; instanceDir: string; runId: string; actor: string };

/** Configuration supplied by the operator, outside the model's tool inputs. */
export interface HarnessLoomAuthoringConfig {
  /** Absolute path to the host's executable Loom CLI. */
  cliPath: string;

  /** A separately bound target for context reads; never an implicit write target. */
  boundLoomId?: string;

  /** Enables only dedicated Loom tools in otherwise read-only comment threads. */
  allowCommentThreads?: boolean;

  /** The scoped broker, or an explicitly identified local instance and agent. */
  transport: HarnessLoomAuthoringTransport;
}

/** Commands admitted by the dedicated authoring tools. */
export type LoomAuthoringCommand =
  | "loom.compose"
  | "loom.inspect"
  | "loom.authoring-context";

/** A host response checked at the command's serialization boundary. */
export type LoomAuthoringCommandOutput =
  | { status: "ok"; result: Record<string, unknown> }
  | {
    status: "error";
    message: string;
    mayHaveCommitted: boolean;
    code?: string;
  };

/** Canonical identifier of a durable Loom record. */
const LOOM_ID = /^loom-[a-f0-9]{16}$/;

/** Whether a decoded JSON value is an object with named properties. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  isObjectNotArray(value);

/** Whether an identity contains an ASCII control character. */
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => character.charCodeAt(0) < 32);

/** Whether a record version is a positive safe integer. */
const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Whether a receipt contains a list of nonempty string handles. */
const isHandleList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((id) => typeof id === "string" && id.length > 0);

/**
 * Returns whether a composition receipt agrees with its request and current
 * target. It proves the daemon reported a commit, not that components render.
 */
export const isLoomCompositionResult = (
  result: unknown,
  requestId?: string,
  target?: string,
): result is Record<string, unknown> & {
  receipt: Record<string, unknown> & {
    loom_id: string;
    request_id: string;
    version: number;
  };
  replayed: boolean;
} => {
  if (
    !isRecord(result) || !isRecord(result.receipt) || !isRecord(result.manifest)
  ) {
    return false;
  }
  const { receipt, manifest } = result;
  return typeof receipt.loom_id === "string" && LOOM_ID.test(receipt.loom_id) &&
    typeof receipt.request_id === "string" &&
    receipt.request_id.trim().length > 0 &&
    (requestId === undefined || receipt.request_id === requestId) &&
    (target === undefined || receipt.loom_id === target) &&
    typeof receipt.created === "boolean" &&
    isVersion(receipt.version) && isVersion(manifest.version) &&
    manifest.version >= receipt.version &&
    manifest.loom_id === receipt.loom_id &&
    isHandleList(receipt.component_ids) && receipt.component_ids.length > 0 &&
    isHandleList(receipt.operation_ids) && receipt.operation_ids.length > 0 &&
    Array.isArray(receipt.displaced) && typeof result.replayed === "boolean";
};

/** Validates host configuration before it can advertise an authoring tool. */
export const validateLoomAuthoringConfig = (
  config: HarnessLoomAuthoringConfig,
): void => {
  if (
    config.allowCommentThreads !== undefined &&
    typeof config.allowCommentThreads !== "boolean"
  ) {
    throw new Error("allowCommentThreads must be a boolean host grant.");
  }
  if (config.boundLoomId !== undefined && !LOOM_ID.test(config.boundLoomId)) {
    throw new Error("Loom authoring requires a canonical bound Loom id.");
  }
  if (!isAbsolute(config.cliPath)) {
    throw new Error("Loom authoring requires an absolute `cliPath`.");
  }
  if (config.transport.kind === "broker") {
    if (!isAbsolute(config.transport.queuePath)) {
      throw new Error(
        "Loom authoring requires an absolute broker `queuePath`.",
      );
    }
  } else if (config.transport.kind === "direct") {
    const { instanceDir, runId, actor } = config.transport;
    if (
      !isAbsolute(instanceDir) || !runId || runId.trim() !== runId ||
      runId.length > 128 ||
      hasControlCharacter(runId) ||
      !/^agent:[a-z0-9][a-z0-9-]{0,63}$/.test(actor)
    ) {
      throw new Error(
        "Direct Loom authoring requires an instance directory, run identity, and agent actor.",
      );
    }
  } else {
    throw new Error("Loom authoring requires a supported transport.");
  }
};

/**
 * Executes one command through argv and stdin. An uncertain composition retains
 * its logical request key for a caller-directed retry through the same transport.
 */
export const executeLoomAuthoringCommand = async (
  config: HarnessLoomAuthoringConfig,
  command: LoomAuthoringCommand,
  input: unknown,
  runner: ProcessRunner,
): Promise<LoomAuthoringCommandOutput> => {
  const failure = (
    message: string,
    mayHaveCommitted = false,
    code?: string,
  ): LoomAuthoringCommandOutput => ({
    status: "error",
    message,
    mayHaveCommitted,
    ...(code !== undefined ? { code } : {}),
  });
  validateLoomAuthoringConfig(config);
  if (
    !["loom.compose", "loom.inspect", "loom.authoring-context"].includes(
      command,
    ) || !isRecord(input)
  ) {
    return failure(
      "Loom authoring requires a supported command and object input.",
    );
  }
  const allowed = command === "loom.compose"
    ? ["request_id", "title", "components", "loom_id", "expected_version"]
    : ["loom_id"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    return failure(
      "The tool accepts composition and target fields only; routing and attribution belong to the host.",
    );
  }
  const { loom_id: suppliedTarget, expected_version: version, ...args } = input;
  if (suppliedTarget !== undefined && typeof suppliedTarget !== "string") {
    return failure("An explicit Loom target must be a canonical string id.");
  }
  const target = suppliedTarget ??
    (command === "loom.authoring-context" ? config.boundLoomId : undefined);
  if (
    (target !== undefined &&
      (typeof target !== "string" || !LOOM_ID.test(target))) ||
    (command === "loom.inspect" && target === undefined) ||
    (version !== undefined && (!isVersion(version) || target === undefined))
  ) {
    return failure(
      "Use a canonical Loom target and a positive expected version when extending it.",
    );
  }
  if (
    command === "loom.compose" &&
    (typeof args.request_id !== "string" || !args.request_id.trim() ||
      args.request_id.length > 200 ||
      hasControlCharacter(args.request_id) || !Array.isArray(args.components) ||
      args.components.length < 1 || args.components.length > 100)
  ) {
    return failure(
      "Composition requires a logical request id and 1–100 components.",
    );
  }
  const argv = ["command", "run"];
  if (config.transport.kind === "direct") argv.push("--transport", "direct");
  argv.push(command, "--args-json", "-", "--json");
  if (typeof target === "string") argv.push("--loom", target);
  if (typeof version === "number") argv.push("--expect", String(version));
  const env = createClearedHostProcessEnv();
  if (config.transport.kind === "broker") {
    env.LOOM_PAGE_RPC_QUEUE = config.transport.queuePath;
  } else {
    env.LOOM_INSTANCE_DIR = config.transport.instanceDir;
    env.LOOM_DISPATCH_ID = config.transport.runId;
    argv.push("--actor", config.transport.actor);
  }
  const uncertain = command === "loom.compose";
  try {
    const response = await runner.run({
      command: config.cliPath,
      args: argv,
      env,
      clearEnv: true,
      stdinText: JSON.stringify(args),
    });
    const body: unknown = JSON.parse(response.stdout);
    if (
      isRecord(body) && body.ok === false && typeof body.code === "string" &&
      [
        "version-conflict",
        "request-conflict",
        "bad-args",
        "bad-body",
        "no-loom",
        "archived",
        "bad-context",
        "unknown-command",
      ].includes(body.code)
    ) {
      if (
        command === "loom.authoring-context" && body.code === "no-loom" &&
        suppliedTarget === undefined && config.boundLoomId !== undefined
      ) {
        // The missing origin is context, not the scope of the run's receipts.
        const historical = await executeLoomAuthoringCommand(
          { ...config, boundLoomId: undefined },
          command,
          {},
          runner,
        );
        return historical.status === "ok"
          ? {
            status: "ok",
            result: {
              ...historical.result,
              bound_loom: {
                loom_id: target,
                available: false,
                source: "host-context",
              },
            },
          }
          : historical;
      }
      return failure(
        "The host rejected the command before applying this request.",
        false,
        body.code,
      );
    }
    if (
      response.exitCode !== 0 || !isRecord(body) || body.ok !== true ||
      !isRecord(body.result)
    ) {
      const detail = isRecord(body) && typeof body.error === "string"
        ? body.error
        : "The host command did not return success.";
      return failure(detail, uncertain);
    }
    const result = body.result;
    if (
      command === "loom.compose" &&
      !isLoomCompositionResult(
        result,
        args.request_id as string,
        target as string | undefined,
      )
    ) {
      return failure(
        "The host response lacks a matching durable receipt. Retry the identical request with the same key.",
        true,
      );
    }
    if (
      command === "loom.inspect" && (!isRecord(result.manifest) ||
        result.manifest.loom_id !== target ||
        !isVersion(result.manifest.version))
    ) {
      return failure(
        "The host response does not identify the requested Loom manifest.",
      );
    }
    if (
      command === "loom.authoring-context" &&
      (result.kind !== "authoring-context" ||
        result.historical !== true || !Array.isArray(result.authored) ||
        typeof result.truncated !== "boolean")
    ) {
      return failure(
        "The host response does not identify historical authoring context.",
      );
    }
    return { status: "ok", result };
  } catch {
    return failure(
      "The host command outcome could not be read. For composition, retry the identical request with the same key.",
      uncertain,
    );
  }
};

/** Reads an explicit operator-owned configuration file; absence grants nothing. */
export const readLoomAuthoringConfig = async (
  path: string | undefined,
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<HarnessLoomAuthoringConfig | undefined> => {
  if (path === undefined) return undefined;
  if (!isAbsolute(path)) {
    throw new Error("The Loom authoring configuration path must be absolute.");
  }
  const value: unknown = JSON.parse(await readTextFile(path));
  if (
    !isRecord(value) || typeof value.cliPath !== "string" ||
    !isRecord(value.transport)
  ) {
    throw new Error(
      "Loom authoring requires a host CLI and a transport configuration.",
    );
  }
  const config = value as unknown as HarnessLoomAuthoringConfig;
  validateLoomAuthoringConfig(config);
  return config;
};

/**
 * Binds one turn's explicit Loom context while keeping direct authoring receipts
 * under the conversation's identity. A broker owns its existing namespace.
 */
export const loomAuthoringForTurn = (
  config: HarnessLoomAuthoringConfig | undefined,
  sessionId: string,
  loomId?: string,
): HarnessLoomAuthoringConfig | undefined => {
  if (config === undefined) return undefined;
  const bound = structuredClone(config);
  delete bound.boundLoomId;
  if (loomId !== undefined) bound.boundLoomId = loomId;
  if (bound.transport.kind === "direct") {
    const digest = sha256(
      new TextEncoder().encode(
        JSON.stringify([bound.transport.runId, sessionId]),
      ),
    );
    bound.transport.runId = "cfh-chat-" +
      Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
  }
  validateLoomAuthoringConfig(bound);
  return bound;
};

/** Verifiable model-facing composition evidence, separate from rendered state. */
export interface LoomAuthoredObservation {
  /** Successful dedicated tool observation discriminator. */
  status: "ok";

  /** Indicates a receipt produced by composition, never by an inspection. */
  kind: "loom-authored";

  /** Immutable historical receipt from the command host. */
  receipt: Record<string, unknown> & {
    loom_id: string;
    request_id: string;
    version: number;
  };

  /** Whether this invocation recovered a previous commit. */
  replayed: boolean;

  /** Target version when this invocation read it; may exceed receipt.version. */
  current_version: number;
}

/** Validates evidence when projecting a dedicated tool into a turn result. */
export const isLoomAuthoredObservation = (
  value: unknown,
): value is LoomAuthoredObservation =>
  isRecord(value) && value.status === "ok" && value.kind === "loom-authored" &&
  isVersion(value.current_version) && isLoomCompositionResult({
    receipt: value.receipt,
    replayed: value.replayed,
    manifest: {
      loom_id: isRecord(value.receipt) ? value.receipt.loom_id : undefined,
      version: value.current_version,
    },
  });
