/**
 * One path of the two-principal comparison (`both-paths.ts`): a scenario run
 * under the posture a deployment has, with a serving loop and two
 * principals that each hold a session, on today's path or on the compiled
 * path.
 *
 * - **The serving loop.** A memory server reached in-process only
 *   (`newLoopbackServer`, as `startServingMemoryServer` of
 *   `runtime/runner/src/executor/serving-memory-server.deno.ts` makes one),
 *   over a store of SQLite files in a temporary directory, with a serving
 *   loop (`ExecutorHost`) whose runtimes come from `servingRuntimeFactory`,
 *   as a toolshed's do. Both paths have the same server, the same loop
 *   policy (`storeReadThrough` on, as a toolshed has it) and the same
 *   identities. On the compiled path the serving runtimes have the
 *   experimental option `compiledPatterns` and serve compiled pieces
 *   (`serveCompiledPieces`) with one `PatternCompiler`; on today's path they
 *   have neither. No port is opened.
 * - **The clients.** One for each principal, A and B, and one for the
 *   space's own identity, each a runtime with server execution on, connected
 *   in-process (`EmulatedStorageManager.connectTo`), as a browser's worker
 *   is. Each principal's client holds a sink on the result of every piece
 *   from the start on, which is the demand a client that shows the piece
 *   makes, so the serving loop derives what is of each principal's scope.
 *   A step or a start that names no principal is made by the space's
 *   client.
 * - **A piece is set up as a client sets one up.** On today's path the
 *   client compiles the program and calls `Runtime.run`, which under server
 *   execution writes the piece and leaves its running to the serving loop.
 *   On the compiled path the client writes the source and the argument
 *   (`setUpCompiledPiece`), and the serving runtime compiles the source and
 *   starts the piece. These are the two ways a client creates a piece today
 *   (`cf piece new` takes the second for a compiled pattern).
 * - **An event** is sent by the acting principal's client with
 *   `sendEvent(..., { echo: false })`, and the serving loop stamps the run
 *   of its handler with that principal, as it stamps any event. Whether the
 *   handling committed, and the message where it did not, is what the
 *   client's commit callback is told (`EventDeliveryError`).
 * - **A write** by a client is a `set` of the cell the link at a member of
 *   the result leads to, as the shell's `$value` binding writes the cell it
 *   holds.
 * - **What a principal reads** is what that principal's client hands a host
 *   for each member of each result (`HostReadGate` of
 *   `runtime/runtime-client`), under the display ceiling the shell gives a
 *   user (`defaultDisplayCeiling`): a value, or `hidden by policy` where the
 *   gate refuses it. A link in the value is read the same way, two links
 *   deep.
 * - **The homes.** Each principal has a home space whose root lists a
 *   profile of its own, under a schema whose confidentiality is the
 *   principal's `User` atom (`seedHome` of `wish-home.ts`), so that
 *   `wish("#profile")` resolves to a different profile for each.
 *
 * This file is host code: it decides nothing a pattern decides, and its
 * clients hold no right a pattern has.
 */
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  type FabricValue,
  isFabricArray,
  isFabricPlainObject,
} from "@commonfabric/data-model";

import type { Cell, MemorySpace } from "../../../runtime/runner/src/cell.ts";
import { isStream, sendEvent } from "../../../runtime/runner/src/cell.ts";
import { defaultDisplayCeiling } from "../../../runtime/runner/src/cfc/default-display-ceiling.ts";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "../../../runtime/runner/src/cfc/ui-contract.ts";
import { namesInstancesByDefault } from "../../../runtime/runner/src/builder/instance-name.ts";
import { PatternCompiler } from "../../../runtime/runner/src/compiled/compile.deno.ts";
import {
  CompiledPieceRefused,
  serveCompiledPieces,
} from "../../../runtime/runner/src/compiled/serving.ts";
import { setUpCompiledPiece } from "../../../runtime/runner/src/compiled/setup.ts";
import { ExecutorHost } from "../../../runtime/runner/src/executor/host.ts";
import { servingRuntimeFactory } from "../../../runtime/runner/src/executor/serving-runtime.ts";
import { resolveLocalProgram } from "../../../runtime/runner/src/harness/local-program.deno.ts";
import type { RuntimeProgram } from "../../../runtime/runner/src/harness/types.ts";
import { parseLink } from "../../../runtime/runner/src/link-utils.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../../runtime/runner/src/storage/cache.deno.ts";
import { rootRenderPolicyFor } from "../../../runtime/html/src/worker/display-fit.ts";
import { HostReadGate } from "../../../runtime/runtime-client/src/backends/host-read-gate.ts";
import {
  renderConfidentialityResolverFor,
  renderMembershipProviderFor,
  renderModulePolicySourceFor,
} from "../../../runtime/runtime-client/src/backends/runtime-processor.ts";
import {
  errorStatesOf,
  snapshotOf,
  type SpaceSnapshot,
  type Written,
  writtenSince,
} from "./both-paths-store.ts";
import { seedHome } from "./wish-home.ts";

/** A principal of the comparison. */
export type Who = "A" | "B";

/** The principals, in order. */
export const WHO: readonly Who[] = ["A", "B"];

/** A path into a result, as members and positions. */
export type ResultPath = readonly (string | number)[];

/** What a scenario's functions are handed to name cells. */
export type CellsOf = {
  /**
   * The acting client's cell at `path` of the result of `piece`, resolved
   * through the links on the way.
   */
  at(piece: string, path?: ResultPath): Cell<unknown>;
  /** A new cell of the acting client that holds `value`, written at once. */
  make(value: unknown): Cell<unknown>;
};

/** A value a scenario gives as it is, or makes from the acting client's cells. */
export type Given =
  | ((cells: CellsOf) => unknown)
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

/** A pattern a scenario starts. */
export type GatePiece = {
  /** The name the steps and the arguments of later pieces know it by. */
  name: string;
  /** The module, as a path from the repository root. */
  module: string;
  /** The export that is the pattern, where it is not the default. */
  mainExport?: string;
  /** The argument; the empty record by default. */
  argument?: Given;
  /** The principal whose client sets the piece up, by a scenario's name. */
  as?: string;
};

/** An event a scenario sends, or a value a client writes. */
export type GateStep = {
  /** The piece whose result the step reaches into: the first by default. */
  piece?: string;
  /** The stream, as a member of the result or a path into it. */
  stream?: string | ResultPath;
  /** The payload, or what makes it from the acting client's cells. */
  event?: Given;
  /** The surface and the action of the gesture, where the event is one. */
  trustedUi?: { surface: string; action: string };
  /**
   * In the place of an event: a write of `value` into the cell the link at
   * `path` of the result leads to.
   */
  write?: { path: ResultPath; value: unknown };
  /** The principal whose client acts, by a scenario's name. */
  as?: string;
  /**
   * Text this step makes readable by the other principal on purpose, such
   * as a value a client typed that the handler of this step writes into a
   * document of the space: not a violation of the derived check (b) from
   * this step on.
   */
  shares?: string[];
};

/** One pattern or several, and what the principals do with them. */
export type GateScenario = {
  name: string;
  pieces: GatePiece[];
  steps: GateStep[];
  /**
   * Text that a principal's own scope holds, by a scenario's name of the
   * principal: no position the other principal reads may hold it. A
   * principal's profile name is always such text.
   */
  scoped?: Record<string, string[]>;
  /** Why the scenario cannot run under this harness, where it cannot. */
  skip?: string;
};

/** Which principal each of a scenario's names stands for. */
export type Roles = Record<string, Who>;

/** What a principal read at one member of a result. */
export type Read =
  | { value: FabricValue }
  | { hidden: string }
  | { failed: string };

/** What one start or one step did on one path, and what the store holds. */
export type Checkpoint = {
  /** `start <piece>` or `step <n>`. */
  at: string;
  /** Who acted. */
  actor: Who | "space";
  /** Whether the client's setup commit, or the handling, committed. */
  committed: boolean;
  /** The first line of the message of a refusal. */
  message?: string;
  /** What each principal reads, by `piece.member`. */
  reads: Record<Who, Record<string, Read>>;
  /** The scenario's space after the step. */
  snapshot: SpaceSnapshot;
  /** The error states of every space of the path's store. */
  errors: ReturnType<typeof errorStatesOf>;
  /** What the step wrote into the scenario's space. */
  written: Written;
  /** The text of each principal's scope that is shared from this step on. */
  shared: string[];
};

/** What one path did with a scenario. */
export type PathRun = {
  path: "today" | "compiled";
  /** Whether each piece ran as a compiled piece. */
  compiled: Record<string, boolean>;
  /** Why the serving runtime did not start a piece, where it did not. */
  refused: string[];
  checkpoints: Checkpoint[];
  /** The result document of each piece. */
  results: Record<string, string>;
  /** The identifiers of the run, for the comparison's names. */
  identities: Identities;
  /** Each principal's text of its own scope. */
  scoped: Record<Who, string[]>;
  /** The error that ended the run, where one did. */
  failure?: string;
};

/** The identifiers of a run. */
export type Identities = {
  space: string;
  principals: Record<Who, string>;
  /** Each principal's home space and profile space. */
  homes: Record<Who, { home: string; profile: string }>;
  service: string;
};

const repository = fromFileUrl(new URL("../../../", import.meta.url));

/** The identities every run uses, made once. */
let identities: Promise<Identities & { keys: Record<string, Identity> }>;
const identitiesOf = () =>
  identities ??= (async () => {
    const key = (name: string) =>
      Identity.fromPassphrase(`two principals ${name}`);
    const keys = {
      space: await key("space"),
      A: await key("A"),
      B: await key("B"),
      profileA: await key("profile A"),
      profileB: await key("profile B"),
      service: await key("service"),
    };
    return {
      keys,
      space: keys.space.did(),
      principals: { A: keys.A.did(), B: keys.B.did() },
      homes: {
        A: { home: keys.A.did(), profile: keys.profileA.did() },
        B: { home: keys.B.did(), profile: keys.profileB.did() },
      },
      service: keys.service.did(),
    };
  })();

/** The name of each principal's profile: text of that principal's scope. */
export const PROFILE_NAMES: Record<Who, string> = {
  A: "Profile name of A, 7151",
  B: "Profile name of B, 2862",
};

/** Resolves the program of each piece of `scenario` from the repository. */
export const programsOf = async (
  scenario: GateScenario,
): Promise<Record<string, RuntimeProgram>> => {
  const programs: Record<string, RuntimeProgram> = {};
  const resolving = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: EmulatedStorageManager.emulate({
      as: await Identity.fromPassphrase("two principals resolving"),
    }),
  });
  try {
    for (const piece of scenario.pieces) {
      programs[piece.name] = await resolveLocalProgram(
        (resolver) => resolving.harness.resolve(resolver),
        {
          main: `${repository}${piece.module}`,
          root: repository,
          ...(piece.mainExport === undefined
            ? {}
            : { mainExport: piece.mainExport }),
        },
      );
    }
  } finally {
    await resolving.dispose();
  }
  return programs;
};

/**
 * The first line of the message of `error`, at most 300 characters. A
 * commit's error is a record with a name and a message, and not always an
 * `Error`.
 */
const firstLine = (error: unknown): string => {
  const named = error as { name?: unknown; message?: unknown } | undefined;
  const text = error instanceof Error ||
      (typeof named?.message === "string")
    ? `${String(named!.name ?? "Error")}: ${String(named!.message)}`
    : String(error);
  return text.split("\n")[0].slice(0, 300);
};

/** Whether `value` is a link a host read holds in the place of a cell. */
const linkIn = (value: unknown) => {
  try {
    return parseLink(value as never);
  } catch {
    return undefined;
  }
};

/** How deep the links in a read value are read. */
const READ_DEPTH = 2;

/**
 * What `gate` gives a host for `cell`, with each link in the value read the
 * same way `depth` links deep, a stream as `<stream>`, and a link past that
 * as `<link>`.
 */
const readAsHost = async (
  client: Runtime,
  gate: HostReadGate,
  cell: Cell<unknown>,
  depth: number,
): Promise<Read> => {
  try {
    if (isStream(cell)) return { value: "<stream>" };
    await cell.sync();
    await gate.settle(cell);
    const answer = gate.read(cell) as {
      value?: FabricValue;
      refused?: { refusedBy?: string; labelSource?: string };
      error?: unknown;
    };
    if (answer.refused !== undefined) {
      return {
        hidden: `hidden by policy (${answer.refused.labelSource ?? "label"})`,
      };
    }
    if (!("value" in answer)) return { failed: "the gate gave no value" };
    const follow = async (value: FabricValue): Promise<FabricValue> => {
      const link = linkIn(value);
      if (link !== undefined) {
        if (depth <= 0) return "<link>";
        const target = client.getCellFromLink(link as never);
        const read = await readAsHost(client, gate, target, depth - 1);
        return "value" in read
          ? read.value
          : "hidden" in read
          ? `<${read.hidden}>`
          : `<not read: ${read.failed}>`;
      }
      if (isFabricArray(value) || Array.isArray(value)) {
        const out: FabricValue[] = [];
        for (const member of value as FabricValue[]) {
          out.push(await follow(member));
        }
        return out;
      }
      if (isFabricPlainObject(value)) {
        const out: Record<string, FabricValue> = {};
        for (const [name, member] of Object.entries(value)) {
          // The label view the gate adds to a link is no part of the value.
          if (name === "cfcLabelView") continue;
          out[name] = await follow(member as FabricValue);
        }
        return out;
      }
      return value;
    };
    return { value: await follow(answer.value as FabricValue) };
  } catch (error) {
    return { failed: firstLine(error) };
  }
};

/** The host read gate of `client`, for the principal `identity`. */
const gateOf = (
  client: Runtime,
  identity: Identity,
  space: string,
): HostReadGate => {
  const ceiling = defaultDisplayCeiling(identity.did());
  const membership = renderMembershipProviderFor(client, identity, ceiling);
  const modulePolicies = renderModulePolicySourceFor(client, ceiling);
  return new HostReadGate(rootRenderPolicyFor(ceiling), {
    resolveConfidentiality: renderConfidentialityResolverFor(
      client,
      identity,
      ceiling,
      space,
      membership,
      modulePolicies,
    ),
    ...(membership === undefined ? {} : { membership }),
    ...(modulePolicies === undefined ? {} : { modulePolicies }),
  });
};

/** What `runPath` takes beside the scenario. */
export type RunPathOptions = {
  path: "today" | "compiled";
  programs: Record<string, RuntimeProgram>;
  roles: Roles;
  /** The compiler of the compiled path's serving runtimes. */
  compiler?: PatternCompiler;
};

/** Runs `scenario` on one path, under the serving loop with two principals. */
export const runPath = async (
  scenario: GateScenario,
  options: RunPathOptions,
): Promise<PathRun> => {
  const compiled = options.path === "compiled";
  const ids = await identitiesOf();
  const directory = await Deno.makeTempDir({ prefix: "two-principals-" });
  const store = new URL(`file://${directory}/`);
  const apiUrl = new URL(import.meta.url);
  const experimental = compiled ? { compiledPatterns: true } : {};
  const server = newLoopbackServer({
    store,
    subscriptionRefreshDelayMs: 0,
    delegatingDids: [ids.service],
    namesInstances: () => namesInstancesByDefault(),
  });
  const compiler = options.compiler ??
    (compiled ? new PatternCompiler() : undefined);
  const create = servingRuntimeFactory({
    server,
    identity: ids.keys.service,
    apiUrl,
    experimental,
  });
  const run: PathRun = {
    path: options.path,
    compiled: {},
    refused: [],
    checkpoints: [],
    results: {},
    identities: {
      space: ids.space,
      principals: ids.principals,
      homes: ids.homes,
      service: ids.service,
    },
    scoped: { A: [PROFILE_NAMES.A], B: [PROFILE_NAMES.B] },
  };
  for (const [name, texts] of Object.entries(scenario.scoped ?? {})) {
    const who = options.roles[name];
    if (who === undefined) continue;
    for (const text of texts) run.scoped[who].push(text);
  }
  // How many compiled pieces the serving runtimes started, and why they
  // did not start one, by its result document.
  let started = 0;
  const refusedFor = new Map<string, string>();
  const host = new ExecutorHost({
    policy: { storeReadThrough: true },
    ensureSpaceRoots: false,
    server,
    serviceIdentity: ids.service,
    createRuntime: async (space, context) => {
      const made = await create!(space, context);
      if (compiled && compiler !== undefined) {
        serveCompiledPieces(made.runtime, {
          compile: (program) => compiler.compile(program),
          started: () => started += 1,
          failed: (result, error) => {
            refusedFor.set(
              result,
              `${
                error instanceof CompiledPieceRefused
                  ? "refused"
                  : "not started"
              }: ${
                (error instanceof Error ? error.message : String(error))
                  .split("\n").filter((line) => line.trim() !== "")
                  .slice(0, 3).join(" | ").slice(0, 400)
              }`,
            );
          },
        });
      }
      return made;
    },
  });
  const clientOf = (identity: Identity) =>
    new Runtime({
      apiUrl,
      storageManager: EmulatedStorageManager.connectTo(server, {
        as: identity,
      }),
      experimental: { serverExecution: true },
    });
  const clients = {
    A: clientOf(ids.keys.A),
    B: clientOf(ids.keys.B),
    space: clientOf(ids.keys.space),
  };
  const gates: Record<Who, HostReadGate> = {
    A: gateOf(clients.A, ids.keys.A, ids.space),
    B: gateOf(clients.B, ids.keys.B, ids.space),
  };
  const cancels: (() => void)[] = [];
  const space = ids.space as MemorySpace;
  const results: Record<string, string> = {};
  const settled = async () => {
    await host.whenQuiescent();
    await server.idle();
    for (const client of Object.values(clients)) {
      await client.storageManager.synced();
    }
    await host.whenQuiescent();
    await server.idle();
  };
  const actorOf = (name: string | undefined): Who | "space" => {
    if (name === undefined) return "space";
    const who = options.roles[name];
    if (who === undefined) {
      throw new Error(`The scenario names no principal \`${name}\`.`);
    }
    return who;
  };
  const resultCell = (client: Runtime, piece: string): Cell<unknown> => {
    const id = results[piece];
    if (id === undefined) throw new Error(`No piece \`${piece}\` was started.`);
    return client.getCellFromLink(
      { space, id: id as never, path: [], scope: "space" } as never,
    );
  };
  const cellsOf = (client: Runtime, pending: Promise<unknown>[]): CellsOf => ({
    at: (piece, path = []) => {
      let cell = resultCell(client, piece);
      for (const step of path) cell = cell.key(step as never) as Cell<unknown>;
      return cell.resolveAsCell() as Cell<unknown>;
    },
    make: (value) => {
      const tx = client.edit();
      const cell = client.getCell<unknown>(
        space,
        `two principals made ${crypto.randomUUID()}`,
        undefined,
        tx,
      );
      cell.set(value as never);
      pending.push(tx.commit().settled);
      return client.getCellFromLink(cell.getAsNormalizedFullLink());
    },
  });
  let seq = 0;
  let shared: string[] = [];
  const checkpoint = async (
    at: string,
    actor: Who | "space",
    committed: boolean,
    message: string | undefined,
  ) => {
    await settled();
    const reads: Checkpoint["reads"] = { A: {}, B: {} };
    for (const who of WHO) {
      const client = clients[who];
      for (const piece of Object.keys(results)) {
        const root = resultCell(client, piece);
        const whole = await readAsHost(client, gates[who], root, 0);
        // Where the gate refuses the whole result, each member is read on
        // its own, as the shell's panel reads the fields of a refused
        // record; the names are listed from the stored record.
        const listed = "value" in whole ? whole.value : root.getRaw();
        const members = isFabricPlainObject(listed as FabricValue)
          ? Object.keys(listed as object).sort()
          : [];
        // The whole result is compared as readable or not; its members are
        // compared one by one below.
        reads[who][piece] = "value" in whole ? { value: "<record>" } : whole;
        for (const member of members) {
          reads[who][`${piece}.${member}`] = await readAsHost(
            client,
            gates[who],
            root.key(member as never) as Cell<unknown>,
            READ_DEPTH,
          );
        }
      }
    }
    // Reading may have demanded more of the piece.
    await settled();
    const spaces = [
      ids.space,
      ids.homes.A.home,
      ids.homes.B.home,
      ids.homes.A.profile,
      ids.homes.B.profile,
    ];
    const written = writtenSince(store, ids.space, seq);
    seq = written.seq;
    const point: Checkpoint = {
      at,
      actor,
      committed,
      ...(message === undefined ? {} : { message }),
      reads,
      snapshot: snapshotOf(store, ids.space),
      errors: errorStatesOf(store, spaces),
      written: {
        documents: written.documents,
        bytes: written.bytes,
        writes: written.writes,
      },
      shared: [...shared],
    };
    run.checkpoints.push(point);
  };
  try {
    // Each principal's home and profile, written by that principal.
    for (const who of WHO) {
      await seedHome(clients[who], ids.homes[who].home as MemorySpace, {
        profileIn: ids.homes[who].profile as MemorySpace,
        name: PROFILE_NAMES[who],
        confidential: Deno.env.get("BOTH_PATHS_PROFILE") !== "public",
      });
    }
    seq = writtenSince(store, ids.space, 0).seq;
    for (const piece of scenario.pieces) {
      const actor = actorOf(piece.as);
      const client = clients[actor];
      const pending: Promise<unknown>[] = [];
      const argument = typeof piece.argument === "function"
        ? piece.argument(cellsOf(client, pending))
        : piece.argument ?? {};
      await Promise.all(pending);
      const result = client.getCell<unknown>(
        space,
        `two principals ${scenario.name} ${piece.name}`,
      );
      const before = started;
      const tx = client.edit();
      const program = options.programs[piece.name];
      if (compiled) {
        setUpCompiledPiece(client, tx, program, argument, result.withTx(tx));
      } else {
        const pattern = await client.patternManager.compilePattern(program, {
          space,
        });
        client.run(tx, pattern, argument as never, result.withTx(tx));
      }
      const { error } = await tx.commit().settled;
      const id = result.getAsNormalizedFullLink().id;
      results[piece.name] = id;
      run.results[piece.name] = id;
      // Each principal's client shows the piece from here on.
      for (const who of WHO) {
        cancels.push(resultCell(clients[who], piece.name).sink(() => {}));
      }
      await settled();
      run.compiled[piece.name] = started > before;
      const refusal = refusedFor.get(id);
      if (refusal !== undefined) run.refused.push(`${piece.name}: ${refusal}`);
      await checkpoint(
        `start ${piece.name}`,
        actor,
        error === undefined,
        error === undefined ? undefined : firstLine(error),
      );
    }
    for (const [index, step] of scenario.steps.entries()) {
      const actor = actorOf(step.as);
      const client = clients[actor];
      const piece = step.piece ?? scenario.pieces[0].name;
      const pending: Promise<unknown>[] = [];
      const cells = cellsOf(client, pending);
      let committed = true;
      let message: string | undefined;
      if (step.write !== undefined) {
        const target = cells.at(piece, step.write.path);
        cancels.push(target.sink(() => {}));
        await target.sync();
        const tx = client.edit();
        target.withTx(tx).set(step.write.value as never);
        const { error } = await tx.commit().settled;
        if (error !== undefined) {
          committed = false;
          message = firstLine(error);
        }
      } else {
        const path = typeof step.stream === "string"
          ? [step.stream]
          : step.stream ?? [];
        const payload = typeof step.event === "function"
          ? step.event(cells)
          : step.event;
        await Promise.all(pending);
        const sent = step.trustedUi === undefined ? payload : {
          type: "click",
          ...(isFabricPlainObject(payload as FabricValue)
            ? payload as Record<string, unknown>
            : {}),
          provenance: reviewedActionProvenance("dom", step.trustedUi),
        };
        if (step.trustedUi !== undefined) markRendererTrustedEvent(sent);
        // The acting client loads the result and what the stream's link
        // leads to before it sends, as a client that shows the piece has:
        // the space's client holds no sink.
        let stream = resultCell(client, piece);
        await stream.sync();
        for (const member of path) {
          stream = stream.key(member as never) as Cell<unknown>;
          await stream.sync();
        }
        await (stream.resolveAsCell() as Cell<unknown>).sync();
        const handled = Promise.withResolvers<
          ReturnType<ReturnType<Runtime["edit"]>["status"]>
        >();
        try {
          sendEvent(
            stream,
            sent as never,
            (tx) => handled.resolve(tx.status()),
            { echo: false },
          );
          const status = await handled.promise;
          if (status.status === "error") {
            committed = false;
            const error = status.error as { reason?: string } & Error;
            message = firstLine(error);
          }
        } catch (error) {
          committed = false;
          message = `not sent: ${firstLine(error)}`;
        }
      }
      if (step.shares !== undefined) shared = [...shared, ...step.shares];
      await checkpoint(`step ${index}`, actor, committed, message);
    }
  } catch (error) {
    run.failure = firstLine(error);
  } finally {
    for (const cancel of cancels) cancel();
    try {
      await host.close();
    } finally {
      for (const client of Object.values(clients)) await client.dispose();
      await server.close();
      await Deno.remove(directory, { recursive: true });
    }
  }
  return run;
};
