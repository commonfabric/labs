import { decodeBase64 } from "@std/encoding/base64";

import type { AppRouteHandler } from "@/lib/types.ts";
import type { SandboxExecRoute } from "./exec.routes.ts";

export interface SandboxExecHandlerDeps {
  /** Calls the sandbox service. */
  fetch: typeof fetch;
  /** The origin of the sandbox service. */
  sandboxUrl: string;
  /** The toolshed URL handed to commands as `CF_API_URL`. */
  toolshedUrl: string;
}

/** The sandbox service reported that the sandbox does not exist. */
class SandboxNotFoundError extends Error {}

/** Decodes a base64 field of the exec result as UTF-8 text. */
function decodeOutput(field: string | undefined): string {
  return field ? new TextDecoder().decode(decodeBase64(field)) : "";
}

export function createSandboxExecHandlers(deps: SandboxExecHandlerDeps) {
  /** Ensure a sandbox exists, creating it (or restoring from GCS) if needed. */
  async function ensureSandbox(
    sandboxId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await deps.fetch(
      `${deps.sandboxUrl}/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
      { signal },
    );
    if (res.ok) {
      await res.body?.cancel();
      return;
    }

    if (res.status !== 404) {
      throw new Error(`Failed to check sandbox: ${res.status} ${await res
        .text()}`);
    }
    await res.body?.cancel();

    const createRes = await deps.fetch(`${deps.sandboxUrl}/v1/sandboxes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sandboxId, baseImage: "devbox" }),
      signal,
    });
    const text = await createRes.text();
    // "already exists" means the sandbox is running, which is not an error.
    if (!createRes.ok && !text.includes("already exists")) {
      throw new Error(`Failed to create sandbox: ${createRes.status} ${text}`);
    }
  }

  /** Execute a command in a sandbox, returning decoded stdout/stderr. */
  async function execInSandbox(
    sandboxId: string,
    command: string,
    cwd: string | undefined,
    env: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const res = await deps.fetch(
      `${deps.sandboxUrl}/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd: ["bash", "-c", command],
          cwd: cwd || undefined,
          env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        }),
        signal,
      },
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404) {
        throw new SandboxNotFoundError(`Sandbox not found: ${text}`);
      }
      throw new Error(`Exec failed: ${res.status} ${text}`);
    }

    // Go's encoding/json encodes []byte as base64.
    const result = await res.json();
    return {
      stdout: decodeOutput(result.stdout),
      stderr: decodeOutput(result.stderr),
      exitCode: result.exitCode ?? 0,
    };
  }

  const sandboxExec: AppRouteHandler<SandboxExecRoute> = async (c) => {
    const logger = c.get("logger");
    const verifiedUserDid = c.get("verifiedUserDid");
    const {
      sandboxId,
      command,
      workingDirectory,
      timeout = 300000,
      environment,
    } = await c.req.json();

    logger.info(
      { sandboxId, command, verifiedUserDid },
      "Sandbox exec request",
    );

    // CF_API_URL lets `cf` inside the sandbox reach the toolshed.
    const env: Record<string, string> = {
      CF_API_URL: deps.toolshedUrl,
      ...environment,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const signal = controller.signal;
    const exec = () =>
      execInSandbox(sandboxId, command, workingDirectory, env, signal);

    try {
      await ensureSandbox(sandboxId, signal);
      let result;
      try {
        result = await exec();
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
        logger.warn({ sandboxId }, "Sandbox was reaped, recreating");
        await ensureSandbox(sandboxId, signal);
        result = await exec();
      }
      logger.info(
        { sandboxId, exitCode: result.exitCode },
        "Sandbox exec completed",
      );
      return c.json(result, 200);
    } catch (error) {
      logger.error({ err: error, sandboxId }, "Sandbox exec failed");
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: `Exec failed: ${message}` }, 500);
    } finally {
      clearTimeout(timer);
    }
  };

  return { sandboxExec };
}
