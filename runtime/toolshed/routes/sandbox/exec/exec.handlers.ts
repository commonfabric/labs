import type { AppRouteHandler } from "@/lib/types.ts";
import type { SandboxExecRoute } from "./exec.routes.ts";
import env from "@/env.ts";

const SANDBOX_URL = () => env.SANDBOX_SERVICE_URL;

/** Ensure a sandbox exists, creating it (or restoring from GCS) if needed. */
async function ensureSandbox(
  sandboxId: string,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `${SANDBOX_URL()}/v1/sandboxes/${sandboxId}`,
    { signal },
  );
  if (res.ok) return;

  if (res.status === 404) {
    const createRes = await fetch(`${SANDBOX_URL()}/v1/sandboxes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sandboxId, baseImage: "devbox" }),
      signal,
    });
    if (!createRes.ok) {
      const text = await createRes.text();
      // "already exists" means the sandbox is running — not an error
      if (!text.includes("already exists")) {
        throw new Error(
          `Failed to create sandbox: ${createRes.status} ${text}`,
        );
      }
    }
    return;
  }

  const text = await res.text();
  throw new Error(`Failed to check sandbox: ${res.status} ${text}`);
}

/** Execute a command in a sandbox, returning decoded stdout/stderr. */
async function execInSandbox(
  sandboxId: string,
  command: string,
  cwd?: string,
  envVars?: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const envArray = envVars
    ? Object.entries(envVars).map(([k, v]) => `${k}=${v}`)
    : undefined;

  const body: Record<string, unknown> = {
    cmd: ["bash", "-c", command],
  };
  if (cwd) body.cwd = cwd;
  if (envArray && envArray.length > 0) body.env = envArray;

  const res = await fetch(
    `${SANDBOX_URL()}/v1/sandboxes/${sandboxId}/exec`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  );

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 404) {
      throw Object.assign(new Error(`Sandbox not found: ${text}`), {
        status: 404,
      });
    }
    throw new Error(`Exec failed: ${res.status} ${text}`);
  }

  const result = await res.json();

  // Go's encoding/json encodes []byte as base64
  const stdout = result.stdout ? atob(result.stdout) : "";
  const stderr = result.stderr ? atob(result.stderr) : "";
  const exitCode = result.exitCode ?? 0;

  return { stdout, stderr, exitCode };
}

export const sandboxExec: AppRouteHandler<SandboxExecRoute> = async (c) => {
  const logger = c.get("logger");
  const verifiedUserDid = c.get("verifiedUserDid");
  const payload = await c.req.json();
  const {
    sandboxId,
    command,
    workingDirectory,
    timeout = 300000,
    environment,
  } = payload;

  logger.info({ sandboxId, command, verifiedUserDid }, "Sandbox exec request");

  // Inject CF_API_URL so `cf` inside sandboxes can reach the toolshed
  const sandboxToolshedUrl = env.SANDBOX_TOOLSHED_URL || env.API_URL;
  const mergedEnv: Record<string, string> = {
    CF_API_URL: sandboxToolshedUrl,
    ...(environment || {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    // Ensure sandbox exists (lazy create / GCS restore)
    await ensureSandbox(sandboxId, controller.signal);

    try {
      const result = await execInSandbox(
        sandboxId,
        command,
        workingDirectory,
        mergedEnv,
        controller.signal,
      );
      logger.info(
        { sandboxId, exitCode: result.exitCode },
        "Sandbox exec completed",
      );
      return c.json(result, 200);
    } catch (err: unknown) {
      // On exec 404 (sandbox was reaped), recreate and retry once
      if (
        err && typeof err === "object" && "status" in err &&
        (err as { status: number }).status === 404
      ) {
        logger.warn({ sandboxId }, "Sandbox was reaped, recreating");
        await ensureSandbox(sandboxId, controller.signal);
        const result = await execInSandbox(
          sandboxId,
          command,
          workingDirectory,
          mergedEnv,
          controller.signal,
        );
        logger.info(
          { sandboxId, exitCode: result.exitCode },
          "Sandbox exec completed (after recreate)",
        );
        return c.json(result, 200);
      }
      throw err;
    }
  } catch (error) {
    logger.error({
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
      sandboxId,
    }, "Sandbox exec failed");
    return c.json({ error: `Exec failed: ${(error as Error).message}` }, 500);
  } finally {
    clearTimeout(timer);
  }
};
