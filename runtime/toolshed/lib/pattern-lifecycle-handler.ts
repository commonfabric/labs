import { type Span, trace } from "@opentelemetry/api";

import { getLogger } from "@commonfabric/logger";
import { aclDocId } from "@commonfabric/memory/acl";
import type { PatternLifecycleHandler } from "@commonfabric/memory/v2/server";
import env from "@/env.ts";
import { runtime } from "@/index.ts";
import { identity } from "@/lib/identity.ts";
import {
  type LifecycleDeps,
  processLifecycleCall,
} from "@/lib/pattern-lifecycle.ts";
import {
  serverExecutionHost,
  serverExecutionRoute,
} from "@/lib/server-execution.ts";
import { hostsSpaceInStore } from "@/lib/space-authority.ts";
import { memoryEngineStoreUrl } from "@/routes/storage/memory-store-url.ts";
import { memoryServer } from "@/routes/storage/memory.ts";

const serviceDids = env.MEMORY_SERVICE_DIDS
  .split(",")
  .map((did) => did.trim())
  .filter((did) => did.length > 0);

const hostsSpace = hostsSpaceInStore(memoryEngineStoreUrl);

const logger = getLogger("toolshed.pattern-lifecycle", {
  enabled: true,
  level: "info",
});

const tracer = trace.getTracer("toolshed.pattern-lifecycle");

/**
 * Runs the `pattern.lifecycle` requests this process's memory server
 * receives, as `Server.setPatternLifecycleHandler()` takes it, over this
 * process's serving loop and memory server, each in a trace span of its own
 * that the verb marks with what it timed. The memory server has already
 * checked that the session's principal writes the space.
 */
export const lifecycleRequestHandler: PatternLifecycleHandler = (call) =>
  tracer.startActiveSpan(`pattern.lifecycle ${call.verb}`, async (span) => {
    span.setAttribute("space.did", call.space);
    try {
      return await processLifecycleCall(deps(span), call);
    } finally {
      span.end();
    }
  });

/**
 * Helper for `lifecycleRequestHandler()`, which returns what a verb runs
 * over, marking `requestSpan`.
 */
const deps = (requestSpan: Span): LifecycleDeps => ({
  authority: {
    runtime,
    operatorDid: identity.did(),
    serviceDids,
    hostsSpace,
    aclMode: env.MEMORY_ACL_MODE,
    readAcl: async (space) =>
      (await memoryServer.readDocument(space, aclDocId(space)))?.value,
  },
  host: serverExecutionHost,
  route: serverExecutionRoute,
  append: (entry) => memoryServer.commitDelegatedAppend(entry),
  readDocument: (space, id) => memoryServer.readDocument(space, id),
  watchAdmittedCommits: (watcher) => memoryServer.watchAdmittedCommits(watcher),
  logger: {
    warn: (obj, msg) => logger.warn("pattern-lifecycle", () => [msg, obj]),
    info: (obj, msg) => logger.info("pattern-lifecycle", () => [msg, obj]),
  },
  requestSpan,
});
