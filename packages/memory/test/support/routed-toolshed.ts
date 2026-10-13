/** Disposable real toolshed protocol fixture for the Rust router exercise. */

import { Identity, isCanonicalEd25519DID } from "@commonfabric/identity";
import { toFileUrl } from "@std/path";

import { setModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import type { MemorySpace } from "../../interface.ts";
import { verifyConnectionAuthorization } from "../../v2/connection-auth.ts";
import * as Engine from "../../v2/engine.ts";
import {
  parseUnlistedPlacement,
  unlistedToolshed,
} from "../../v2/routed-directory.ts";
import { RoutedEpochStore } from "../../v2/routed-epochs.ts";
import { RoutedMemoryHost } from "../../v2/routed-host.ts";
import { listenRoutedMemory } from "../../v2/routed-listener.ts";
import { ROUTED_QUEUE_LIMIT } from "../../v2/routed-parser.ts";
import {
  decodeRouterHeader,
  decodeRouterRecord,
} from "../../v2/router-protocol.ts";
import { verifySessionOpenAuthorization } from "../../v2/session-open-auth.ts";
import { parseClientMessage, Server } from "../../v2/server.ts";
import { resolveSpaceStoreUrl } from "../../v2/storage-path.ts";

/** Tracked fixture inputs; identities are throwaway local test keys. */
export interface RoutedToolshedFixture {
  port: number;
  seed: number;
  certificate: string;
  key: string;
  directory: string;
  store: string;
  router: string;
  space: string;
  principals: string[];
  /** The deployment's cell representation, which every client shares. */
  modernCellRep: boolean;

  /** Models an endpoint build that does not advertise label-table support. */
  omitSyncLabelTableV1?: boolean;

  /** Models an endpoint build that does not advertise commit-table support. */
  omitCommitLabelTableV1?: boolean;

  /** Frame value-count cap; omission keeps the default, `null` disables it. */
  frameSlots?: number | null;
}

/** Builds counters for one deliberately blocked backend transaction burst. */
function requestAdmissionReport() {
  return {
    inputLimitBytes: ROUTED_QUEUE_LIMIT,
    blocked: false,
    released: false,
    closed: false,
    headers: 0,
    completed: 0,
    backendRequests: 0,
    declaredBytes: 0,
    maxPendingBytes: 0,
    pendingBytesAtWait: 0,
    assemblingBytesAtWait: 0,
    waitingBodyBytes: 0,
    waitingHeaderBytes: 0,
    bodyRecordsWhileWaiting: 0,
  };
}

/** Seeds an existing ACL-backed space, then starts the actual private protocol. */
export async function startRoutedToolshed(config: RoutedToolshedFixture) {
  setModernCellRepConfig(config.modernCellRep);
  const identity = await Identity.fromRaw(new Uint8Array(32).fill(config.seed));
  const store = toFileUrl(`${config.store}/`);
  Deno.mkdirSync(`${config.store}/engine-v3`, { recursive: true });
  const engine = await Engine.open({
    url: resolveSpaceStoreUrl(store, config.space as MemorySpace),
  });
  if (Engine.serverSeq(engine) === 0) {
    Engine.applyCommit(engine, {
      sessionId: "fixture-seed",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: `of:${config.space}`,
            value: {
              value: Object.fromEntries(
                config.principals.map((did) => [did, "OWNER"]),
              ),
            },
          },
          {
            op: "set",
            id: "of:fixture-data",
            value: {
              value: {
                message: "existing space",
                principalCount: config.principals.length,
              },
            },
          },
        ],
      },
    });
  }
  Engine.close(engine);
  const ownership = (space: string): number | undefined => {
    const directory = JSON.parse(Deno.readTextFileSync(config.directory));
    const here = directory.toolsheds.findIndex((shed: { did: string }) =>
      shed.did === identity.did()
    );
    const entry = directory.spaces[space];
    if (entry !== undefined) {
      return entry.toolshed === here ? entry.epoch : undefined;
    }
    const rule = parseUnlistedPlacement(
      directory.unlisted,
      directory.toolsheds.length,
    );
    return rule !== undefined && unlistedToolshed(rule, space) === here
      ? rule.epoch
      : undefined;
  };
  const server = new Server({
    store,
    acl: { mode: "enforce" },
    requireExplicitAcl: true,
    ownsSpace: (space) =>
      isCanonicalEd25519DID(space) && ownership(space) !== undefined,
    createsSpace: (space) =>
      JSON.parse(Deno.readTextFileSync(config.directory)).spaces[space] ===
        undefined,
    authorizeSessionOpen: verifySessionOpenAuthorization,
    authorizeConnection: verifyConnectionAuthorization,
    sessionOpenAuth: { audience: identity.did() },
    // Subscriptions fan out on the server's default delay, as a deployed
    // toolshed's do. A pattern's reads wait for that fan-out, and in this
    // child process nothing would flush a manual one.
  });
  if (config.omitSyncLabelTableV1 || config.omitCommitLabelTableV1) {
    const memoryProtocolFlags = server.memoryProtocolFlags.bind(server);
    // The fixture models an older wire advertisement while keeping the
    // current server's private transport implementation.
    server.memoryProtocolFlags = () => {
      const flags = { ...memoryProtocolFlags() };
      if (config.omitSyncLabelTableV1) {
        Reflect.deleteProperty(flags, "syncLabelTableV1");
      }
      if (config.omitCommitLabelTableV1) {
        Reflect.deleteProperty(flags, "commitLabelTableV1");
      }
      return flags;
    };
  }
  let admission: {
    /** Only this SDK session's transactions enter the hold. */
    sessionId: string;
    /** Releases the first backend receive without changing transport limits. */
    release: PromiseWithResolvers<void>;
    /** Resolves on a capacity-blocked header or premature socket closure. */
    waiting: PromiseWithResolvers<ReturnType<typeof requestAdmissionReport>>;
    /** Socket-boundary observations, retained through completion. */
    report: ReturnType<typeof requestAdmissionReport>;
  } | undefined;

  /** Reports admission pressure only once the backend is actually blocked. */
  const reportAdmissionWait = () => {
    if (
      admission?.report.blocked && admission.report.waitingBodyBytes > 0 &&
      !admission.report.released
    ) admission.waiting.resolve(Object.freeze({ ...admission.report }));
  };
  const connectRouted = server.connectRouted.bind(server);
  server.connectRouted = (send, owns) => {
    const backend = connectRouted(send, owns);
    const receive = backend.receive.bind(backend);
    backend.receive = async (payload) => {
      const hold = admission;
      // The observer recognizes compact commits; the backend receives the
      // original payload and enforces its own negotiated capabilities.
      const message = hold === undefined
        ? null
        : parseClientMessage(payload, { commitLabelTableV1: true });
      if (
        hold !== undefined && message?.type === "transact" &&
        message.sessionId === hold.sessionId
      ) {
        hold.report.backendRequests++;
        if (!hold.report.released) {
          hold.report.blocked = true;
          reportAdmissionWait();
          await hold.release.promise;
        }
      }
      await receive(payload);
    };
    return backend;
  };
  const epochs = new RoutedEpochStore(`${config.store}/router-epochs.jsonl`);
  const host = new RoutedMemoryHost({
    server,
    identity,
    deployment: "local-mode-a",
    epochs,
    ownership,
    limits: {
      watchesPerSession: 1024,
      ...(config.frameSlots === undefined
        ? {}
        : { frameSlots: config.frameSlots }),
    },
    routers: new Map([[config.router, new Set(["127.0.0.1"])]]),
  });
  const linked = Promise.withResolvers<void>();
  const accept = host.accept.bind(host);
  // A heartbeat comes after the router has published the authenticated link.
  // Waiting on it lets an upgrade gate bind once, without retrying admissions.
  host.accept = (socket, endpoint, peer) => {
    if (endpoint === "/memory/router-link") {
      socket.once("ping", () => linked.resolve());
    }
    accept(socket, endpoint, peer);
    if (endpoint !== "/memory/router-data") return;
    let hold: typeof admission;
    let transaction = false;
    let waitingBody = false;
    // Registered after the host so counters include its reservation for this
    // record. The held header itself must reserve no body bytes.
    socket.on("message", (bytes, binary) => {
      if (
        admission === undefined || !binary || !(bytes instanceof ArrayBuffer)
      ) {
        return;
      }
      const frame = new Uint8Array(bytes);
      const record = decodeRouterRecord(frame);
      if (record.kind === 0) {
        const header = decodeRouterHeader(frame);
        transaction = admission !== undefined &&
          header.route.type === "transact" &&
          header.route.sessionId === admission.sessionId;
        waitingBody = false;
        if (!transaction) return;
        hold = admission;
        if (hold === undefined) throw new Error("Missing admission hold");
        hold.report.headers++;
        hold.report.declaredBytes += header.bytes;
        const state = host.accessForTestingOnly.dataSocket(socket);
        if (
          !hold.report.released && state !== undefined &&
          socket.readyState === socket.OPEN && state.assemblingBytes === 0 &&
          state.waitingHeaderBytes === header.bytes &&
          state.pendingBytes + header.bytes > ROUTED_QUEUE_LIMIT
        ) {
          waitingBody = true;
          hold.report.pendingBytesAtWait = state.pendingBytes;
          hold.report.assemblingBytesAtWait = state.assemblingBytes;
          hold.report.waitingBodyBytes = header.bytes;
          hold.report.waitingHeaderBytes = frame.byteLength;
        }
      } else if (transaction && hold !== undefined) {
        if (waitingBody && !hold.report.released) {
          hold.report.bodyRecordsWhileWaiting++;
        }
        if (record.kind === 2) hold.report.completed++;
      }
      if (hold !== undefined) {
        const state = host.accessForTestingOnly.dataSocket(socket);
        hold.report.maxPendingBytes = Math.max(
          hold.report.maxPendingBytes,
          state?.pendingBytes ?? 0,
        );
        reportAdmissionWait();
      }
    });
    socket.once("close", () => {
      if (hold !== undefined && !hold.report.released) {
        hold.report.closed = true;
        hold.waiting.resolve(Object.freeze({ ...hold.report }));
      }
    });
  };
  const listener = await listenRoutedMemory({
    hostname: "127.0.0.1",
    port: config.port,
    certificate: Deno.readTextFileSync(config.certificate),
    key: Deno.readTextFileSync(config.key),
    host,
  });
  return {
    server,
    host,
    port: listener.port,
    linked: linked.promise,
    holdRequests: (sessionId: string) => {
      if (admission !== undefined && !admission.report.released) {
        throw new Error("An admission hold is already active");
      }
      admission = {
        sessionId,
        release: Promise.withResolvers<void>(),
        waiting: Promise.withResolvers<
          ReturnType<typeof requestAdmissionReport>
        >(),
        report: requestAdmissionReport(),
      };
    },
    waitRequestAdmission: async () => {
      if (admission === undefined) {
        throw new Error("No admission hold is active");
      }
      return await admission.waiting.promise;
    },
    releaseRequests: () => {
      if (admission === undefined) {
        throw new Error("No admission hold is active");
      }
      admission.report.released = true;
      admission.release.resolve();
    },
    requestAdmission: () => admission && { ...admission.report },
    clearRequestAdmission: () => {
      if (admission !== undefined && !admission.report.released) {
        throw new Error("Cannot clear an active admission hold");
      }
      admission = undefined;
    },
    close: async () => {
      admission?.release.resolve();
      await listener.close();
      await server.close();
      epochs.close();
    },
  };
}

if (import.meta.main) {
  const service = await startRoutedToolshed(
    JSON.parse(Deno.readTextFileSync(Deno.args[0])),
  );
  console.log(JSON.stringify({ ready: true, port: service.port }));
  const decoder = new TextDecoderStream();
  const lines = Deno.stdin.readable.pipeThrough(decoder);
  let held = "";
  for await (const chunk of lines) {
    held += chunk;
    let newline: number;
    while ((newline = held.indexOf("\n")) >= 0) {
      const command = JSON.parse(held.slice(0, newline));
      held = held.slice(newline + 1);
      if (command.revoke !== undefined) {
        service.host.revokeRouter(command.revoke);
      }
      if (command.fence === true) service.host.fenceOwnership();
      if (command.linked === true) await service.linked;
      if (typeof command.holdRequests === "string") {
        service.holdRequests(command.holdRequests);
      }
      const admissionSnapshot = command.waitRequestAdmission === true
        ? await service.waitRequestAdmission()
        : undefined;
      if (command.releaseRequests === true) service.releaseRequests();
      if (command.clearRequestAdmission === true) {
        service.clearRequestAdmission();
      }
      console.log(JSON.stringify({
        acknowledged: true,
        ...(command.waitRequestAdmission === true ||
            command.requestAdmission === true ||
            command.releaseRequests === true
          ? {
            requestAdmission: admissionSnapshot ?? service.requestAdmission(),
          }
          : {}),
        ...(command.sessionReports === true
          ? { sessionReports: service.server.sessionReports() }
          : {}),
      }));
    }
  }
  await service.close();
}
