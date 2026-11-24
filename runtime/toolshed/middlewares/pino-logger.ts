import { pinoLogger as logger } from "hono-pino";
import { pino } from "pino";
import pretty from "pino-pretty";

import env from "@/env.ts";
import { backgroundLogFile, backgroundLogStream } from "@/background.ts";
import { isObjectNotArray } from "@commonfabric/js-values/types";

const SENSITIVE_HEADERS = new Set([
  "cf-request-auth",
  "cf-request-proof",
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);

export function redactHeaders(headers: unknown): unknown {
  if (headers instanceof Headers) {
    return Object.fromEntries(
      [...headers.entries()].map(([name, value]) => [
        name,
        SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value,
      ]),
    );
  }
  if (!isObjectNotArray(headers)) {
    return headers;
  }
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([name, value]) => [
      name,
      SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value,
    ]),
  );
}

export function serializeResponse(
  response: { statusCode: number; headers: unknown },
  environment: Pick<typeof env, "DISABLE_LOG_REQ_RES"> = env,
): { status: number; headers: string } | undefined {
  if (environment.DISABLE_LOG_REQ_RES) {
    return undefined;
  }
  return {
    status: response.statusCode,
    headers: JSON.stringify(redactHeaders(response.headers)),
  };
}

/**
 * The logged form of a request, with its sensitive headers redacted: an
 * object in production, where the log is structured, and a JSON string
 * elsewhere, where it is pretty-printed.
 */
export function serializeRequest(
  request: { method: string; url: string; headers: unknown },
  environment: Pick<typeof env, "DISABLE_LOG_REQ_RES" | "ENV"> = env,
): { method: string; url: string; headers: unknown } | undefined {
  if (environment.DISABLE_LOG_REQ_RES) {
    return undefined;
  }
  return {
    method: request.method,
    url: request.url,
    headers: environment.ENV === "production"
      ? redactHeaders(request.headers)
      : JSON.stringify(redactHeaders(request.headers)),
  };
}

export function pinoLogger() {
  // A background launch reserves stdout for its readiness marker, so the
  // request logger writes to the launch's log file instead of stdout there.
  const backgroundLog = backgroundLogFile();
  const destination = backgroundLog
    ? backgroundLogStream(backgroundLog)
    : env.ENV === "production"
    ? undefined
    : pretty();
  return logger({
    pino: pino({
      level: env.LOG_LEVEL || "info",
      serializers: {
        res: serializeResponse,
        req: serializeRequest,
      },
    }, destination),
    http: {
      reqId: () => crypto.randomUUID(),
    },
  });
}
