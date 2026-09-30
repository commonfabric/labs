import { pinoLogger as logger } from "hono-pino";
import { pino } from "pino";
import pretty from "pino-pretty";

import env from "@/env.ts";
import { backgroundLogFile, backgroundLogStream } from "@/background.ts";
import { isObjectNotArray } from "@commonfabric/utils/types";

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

export function serializeResponse(response: {
  statusCode: number;
  headers: unknown;
}): { status: number; headers: string } | undefined {
  if (env.DISABLE_LOG_REQ_RES) {
    return undefined;
  }
  return {
    status: response.statusCode,
    headers: JSON.stringify(redactHeaders(response.headers)),
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
        req: (req) => {
          if (env.DISABLE_LOG_REQ_RES) {
            return undefined;
          }
          return {
            method: req.method,
            url: req.url,
            headers: env.ENV === "production"
              ? redactHeaders(req.headers)
              : JSON.stringify(redactHeaders(req.headers)),
          };
        },
      },
    }, destination),
    http: {
      reqId: () => crypto.randomUUID(),
    },
  });
}
