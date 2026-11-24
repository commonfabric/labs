/**
 * Runs the copies of FabriChat and Home (`./`, `../home/`) on the executor
 * of `../../exec/` and as a compiled piece in the runner, and measures a
 * send into a room that holds a given number of messages.
 *
 * `deno run -A --no-check base/pattern-compiler/compare/fabrichat/scale.ts <arm> <pattern> [sizes]`
 *
 * Run from the repository root, after `cargo build --release` in
 * `base/pattern-compiler`. `<arm>` is `executor`, the executor with its
 * documents in memory, `runner`, a compiled piece started with
 * `startCompiledPiece` in a runtime on emulated storage, with the
 * experimental option `compiledPatterns` on, or `serving`, the room set up
 * by a client (`setUpCompiledPiece`) and run by the serving loop of a
 * memory server on this thread (`listenCompiledServingMemoryServer`), with
 * two clients over a socket: one sends, and both read the number of
 * messages back. The steps of `serving` are `start`, `seed` and `send`,
 * with the time until the sender and until the reader read the count; the
 * serving runtime is given the artifacts this process emitted, and the
 * source the client writes is a placeholder. `<pattern>` is `room`
 * (`FabriChatRoom`), `manager` (`FabriChatManager`) or `home` (`Home`).
 * Each run prints one line of JSON per step.
 *
 * The steps of `room`, for each size:
 *
 * - `start`: the piece is started on an empty argument and brought up to
 *   date.
 * - `seed`: `sendMessage` is sent an event until the room holds the size.
 *   The time is of all of them.
 * - `send`: three more events, each timed until the piece is up to date,
 *   with the counters of the executor for that event alone (evaluations,
 *   evaluations of element bodies, assemblies), and on the arm `runner`
 *   the documents its commits changed, each counted once for a commit,
 *   and their size as JSON after the commit (`changedDocuments`,
 *   `changedBytes`).
 * - `read`: the messages of the result are read, and the step says how
 *   many the room holds, the text of the last, and for how many the
 *   result holds the reader's rights, with those of the last.
 *
 * `manager` and `home` are started, and the step says how many members the
 * result has and which cones ended in an error state. `home` then takes
 * one event, which adds a space to the list it keeps (`interaction`).
 *
 * With `SCALE_CHANGES` set, the step of the last timed send of `room` on
 * the arm `runner` lists each document its commits changed, with its scope
 * and its size as JSON after the commit, largest first (`changes`).
 *
 * With `SCALE_CPU_PROFILE` set to the path of a file, the timed sends of
 * `room` and the event of `home` are sampled and the profile is written
 * to that path followed by the size.
 *
 * With `SCALE_LISTS=in-place`, the arms `runner` and `serving` store the
 * links to the row documents of the room in the result document, and
 * otherwise in documents of their own (`CompiledPieceOptions.lists`).
 *
 * Unless `SCALE_POLICIES` is `keep`, the schemas are given without the
 * write policies and the integrity they declare (`withoutWritePolicies`).
 * With them kept, a send of the room is sent as a gesture on the send
 * surface. The scheduler delivers a gesture as input of a renderer, one
 * for each second after ten in a row
 * (`runtime/runner/src/scheduler/wake-shaping.ts`); the harness queues it
 * as an event that is not held back, so the time of a send is that of the
 * piece and of the commit.
 *
 * On the arm `runner`, a `wish` is answered by the runtime's own `wish`
 * against the home `seedHome()` of `../wish-home.ts` writes, and the
 * built-ins that read the acting principal, the owner of a profile, the
 * access list of a space and the key of an event by the runtime's own
 * functions (`runtimeBuiltins`), for the one user of the run, who owns the
 * space. The arm `executor`, and the arm `runner` with `SCALE_STAND_INS`
 * set to `table`, use what stood in for the runtime before round thirteen
 * (notes 727 and 728 of `../../SPEC-NOTES.md`): a `wish` is answered from
 * the table of `../wish-home.ts`, and the built-ins by `builtinsOf` with
 * one fixed user who owns every space.
 */
import { Identity } from "@commonfabric/identity";
import { isWellFormedDID, parseDID } from "@commonfabric/identity/did";
import {
  FabricBytes,
  FabricDurationNsec,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";

import type { Cell } from "../../../../runtime/runner/src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../../../runtime/runner/src/compiled/piece.ts";
import { ACLManager } from "../../../../runtime/runner/src/acl-manager.ts";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "../../../../runtime/runner/src/cfc/ui-contract.ts";
import { listenCompiledServingMemoryServer } from "../../../../runtime/runner/src/compiled/serving-memory-server.deno.ts";
import { compiledPiecesOf } from "../../../../runtime/runner/src/compiled/serving.ts";
import { setUpCompiledPiece } from "../../../../runtime/runner/src/compiled/setup.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import { joinSpaceMembers } from "../../../../runtime/runner/src/space-members.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "../../../../runtime/runner/src/storage/cache.deno.ts";
import { type Artifact, Instance } from "../../exec/executor.ts";
import { startCpuProfile } from "../cpu-profile.ts";
import { homeStubs, memoryHome, PROFILE, seedHome } from "../wish-home.ts";

const REPOSITORY = new URL("../../../../", import.meta.url);

/** The modules of the program of Home, which holds that of FabriChat. */
const MODULES = [
  "home/home/home.tsx",
  "home/agent-queue/agent-queue.tsx",
  "home/agent-run/agent-run.tsx",
  "home/favorites-manager/favorites-manager.tsx",
  "home/private-inbox/private-inbox-refusal-text.ts",
  "home/profile-create/profile-create.tsx",
  "home/profile-picker/profile-picker.tsx",
  "home/self/self.tsx",
  "home/shared-space/shared-space-collection.tsx",
  "home/shared-space/shared-space-interface.ts",
  "fabrichat/fabrichat/logic.ts",
  "fabrichat/fabrichat/manager.tsx",
  "fabrichat/fabrichat/message-row.tsx",
  "fabrichat/fabrichat/room-records.tsx",
  "fabrichat/fabrichat/room.tsx",
  "fabrichat/fabrichat/schemas.tsx",
  "fabrichat/fabrifile/names.ts",
  "fabrichat/fabrifile/schemas.tsx",
  "fabrichat/fabrifile/store.tsx",
  "fabrichat/fabrifile/view.tsx",
  "fabrichat/loom/participants.tsx",
  "fabrichat/private-inbox/private-inbox.tsx",
  "fabrichat/profile-home/profile-home.tsx",
  "fabrichat/shared-space/shared-space-catalog.ts",
  "fabrichat/social-space/member-set.ts",
  "fabrichat/social-space/short-did.ts",
].map((module) => `base/pattern-compiler/compare/${module}`);

const PATTERNS: Record<string, string> = {
  room: "FabriChatRoom",
  manager: "FabriChatManager",
  home: "Home",
};

/**
 * A schema without the write policies and the integrity it declares. A
 * policy of a compiled pattern names its handler by module and binding,
 * which the preparation of Contextual Flow Control does not read yet and
 * refuses as malformed, and integrity of the current principal needs the
 * actor of the run, which an event queued by this harness does not carry
 * (note 729). A run that keeps them commits no send.
 */
const withoutWritePolicies = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(withoutWritePolicies);
  if (typeof schema !== "object" || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema).filter(([name]) =>
      !["writePolicyAnyOf", "addIntegrity", "writeAuthorizedBy"].includes(name)
    )
      .map(([name, member]) => [name, withoutWritePolicies(member)]),
  );
};

/** What the crate emits for the program: every pattern with its code. */
const emitted = async (): Promise<Artifact[]> => {
  const { success, stdout, stderr } = await new Deno.Command(
    new URL(
      "base/pattern-compiler/target/release/pattern-compiler",
      REPOSITORY,
    ).pathname,
    { args: ["emit", ...MODULES], cwd: REPOSITORY.pathname },
  ).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
  const modules = JSON.parse(new TextDecoder().decode(stdout)) as {
    patterns: Artifact[];
  }[];
  const patterns = modules.flatMap(({ patterns }) => patterns);
  return Deno.env.get("SCALE_POLICIES") === "keep"
    ? patterns
    : patterns.map((pattern) => ({
      ...pattern,
      schemas: withoutWritePolicies(pattern.schemas) as Artifact["schemas"],
    }));
};

/**
 * The built-ins of `commonfabric` the executor does not have, for a run
 * with one user, `user`, who owns the one space, `space`. The pure ones
 * are the runtime's own. The others answer what the runtime answers for
 * that user, and read no label and no access list.
 */
const builtinsOf = (user: string, space: string): Record<string, unknown> => {
  let events = 0;
  return {
    // The key of the result cell of an instance, where it is read as a
    // key and not bound in the parameter of a pattern.
    SELF: "$SELF",
    FabricBytes,
    FabricDurationNsec,
    FabricEpochNsec,
    isWellFormedDID,
    parseDID,
    joinSpaceMembers,
    currentPrincipal: () => user,
    eventKey: () => `event-${events++}`,
    profileOwnerOf: () => user,
    principalOf: () => user,
    writtenPrincipalOf: () => user,
    resultOwnerOf: () => user,
    spaceAccess: () => "OWNER",
    spaceDeleted: () => false,
    spaceMembers: () => undefined,
    spaceOfLink: () => space,
    linksOf: () => [],
    getEntityId: (cell: unknown) => cell,
    entityRefToString: (ref: unknown) => `${ref}`,
    getPatternEnvironment: () => ({ apiUrl: new URL("http://localhost/") }),
  };
};

/** What one arm gives a run: an instance, and how to bring it up to date. */
type Started = {
  instance: Instance;
  /**
   * The counters of the adapter of the runtime's transactions that the
   * Topics harness reports: positions read, writes staged, write records
   * given, transactions committed, and the time the piece spent in its own handlers and its
   * derivation. Absent for the executor in memory.
   */
  adapter?: () => Record<string, number>;
  /** The counts of `SCALE_TRACE` since the last call. */
  trace?: () => Record<string, number>;
  /** Sends an event to the stream of a binding and waits for the piece. */
  send: (
    binding: number,
    event: unknown,
    trusted?: { surface: string; action: string },
  ) => Promise<boolean>;
  stop: () => Promise<void>;
};

const inMemory = async (artifact: Artifact, artifacts: Artifact[]) => {
  const home = homeStubs(await memoryHome());
  const space = "did:key:z6MkspaceOfTheRun";
  const instance = new Instance(artifact, {}, {
    space,
    secret: "the secret of the run",
    artifacts: (id) =>
      artifacts.find(({ plan }) =>
        (plan as { patterns?: string[] }).patterns?.[0] === id
      ),
    now: Date.now(),
    documents: home.documents,
    wishes: home.wishes,
    builtins: builtinsOf("did:key:z6MkuserOfTheRun", space),
  });
  return {
    instance,
    send: (binding: number, event: unknown) =>
      Promise.resolve(instance.send(binding, event).committed),
    stop: () => Promise.resolve(),
  } satisfies Started;
};

const onRunner = async (artifact: Artifact, artifacts: Artifact[]) => {
  const signer = await Identity.fromPassphrase("pattern-compiler fabrichat");
  const space = signer.did();
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    cfcFlowLabels: "persist",
    experimental: { compiledPatterns: true },
    servingPosture: true,
  });
  const standIns = Deno.env.get("SCALE_STAND_INS") === "table";
  if (!standIns) {
    // The home as today's `wish` resolves it, with the profile in a space
    // of its own, and an access list that names the user as the owner.
    // The profile declares no confidentiality: with the user atom that
    // `seedHome()` declares by default, the derivation that reads the
    // profile is refused where it writes the marker of a stream (note 745
    // of `../../SPEC-NOTES.md`).
    await seedHome(runtime, space, {
      confidential: Deno.env.get("SCALE_PROFILE") === "confidential",
    });
    await new ACLManager(runtime, space).set(space, "OWNER");
    await runtime.scheduler.idleWithPendingCommits();
  }
  // With the stand-ins, the profile is a document of the room's own space
  // and has no claim of whose it is.
  // What the commits of the runtime changed: the documents, each counted
  // once for a commit, and the size of each as JSON after the commit.
  /** The piece, once it is started, for the list of `SCALE_CHANGES`. */
  const started: { piece?: CompiledPiece } = {};
  const changedByCommits = { documents: 0, bytes: 0 };
  runtime.storageManager.subscribe({
    // deno-lint-ignore no-explicit-any
    next(notification: any) {
      if (notification.type !== "commit") return undefined;
      const seen = new Set<string>();
      for (const { address, after } of notification.changes) {
        if (seen.has(address.id)) continue;
        seen.add(address.id);
        const bytes = after === undefined ? 0 : JSON.stringify(
          after,
          (_, member) => typeof member === "bigint" ? `${member}n` : member,
        ).length;
        changedByCommits.documents += 1;
        changedByCommits.bytes += bytes;
        changesListed?.push([
          `${address.id} ${address.scope} ${describedDocument(address.id)} ${
            shapeOf(after)
          }`,
          bytes,
        ]);
      }
      return undefined;
    },
  });
  /**
   * What the executor holds of the document of an entity, for the list of
   * `SCALE_CHANGES`: its kind, or that it is none of the executor's, as a
   * list document or a label document of the adapter is not.
   */
  const describedDocument = (entity: string): string => {
    const { piece } = started;
    if (piece === undefined) return "";
    const doc = piece.transactions.documentOf(entity);
    return piece.instance.store.docs.get(doc)?.kind ??
      "not the executor's";
  };
  /**
   * The shape of a stored document, for the list of `SCALE_CHANGES`: the
   * members of its value, or the length of an array, with the size of the
   * largest member.
   */
  const shapeOf = (after: unknown): string => {
    const value = (after as { value?: unknown } | undefined)?.value;
    if (Array.isArray(value)) return `[${value.length}]`;
    if (typeof value !== "object" || value === null) return typeof value;
    const sizes = Object.entries(value).map(([name, member]) =>
      [name, (JSON.stringify(member) ?? "").length] as const
    ).sort(([, a], [, b]) => b - a);
    return `{${sizes.slice(0, 3).map(([name, size]) => `${name}:${size}`)}}`;
  };
  const seeded = runtime.edit();
  const profile = runtime.getCell(space, "profile", undefined, seeded);
  profile.set(structuredClone(PROFILE) as never);
  const root = runtime.getCell(space, space, undefined, seeded);
  root.key("defaultPattern").set(
    {
      profiles: [profile],
      backlinksIndex: { mentionable: [] },
      pieceRegistry: [],
    } as never,
  );
  if (standIns) {
    const seeding = await seeded.commit().settled;
    if (seeding.error !== undefined) throw seeding.error;
  } else seeded.abort();
  const home = homeStubs({
    profile: {
      id: profile.getAsNormalizedFullLink().id,
      kind: "profile",
      value: structuredClone(PROFILE),
      space,
    },
    root: {
      id: root.getAsNormalizedFullLink().id,
      kind: "space root",
      value: {},
    },
  });
  const result = runtime.getCell<unknown>(space, "fabrichat on the runner");
  const tx = runtime.edit();
  let piece: CompiledPiece;
  try {
    piece = startCompiledPiece(runtime, tx, artifact, {}, result.withTx(tx), {
      // The harness is host code and vouches for the artifacts the crate
      // emitted: their handlers then have the identity a claim names.
      attested: true,
      artifacts: (id) =>
        artifacts.find(({ plan }) =>
          (plan as { patterns?: string[] }).patterns?.[0] === id
        ),
      now: Date.now(),
      ...(standIns
        ? { wishes: home.wishes, builtins: builtinsOf(space, space) }
        // The runtime of the run has no serving loop, which is what names
        // the principal a run acts for. `SELF` is no built-in the runtime
        // answers: it is the stand-in of the executor's harness.
        : { actsFor: space, builtins: { SELF: "$SELF" } }),
      ...(Deno.env.get("SCALE_LISTS") === "in-place"
        ? { lists: "in-place" as const }
        : {}),
    });
  } catch (error) {
    tx.abort();
    await runtime.dispose();
    await server.close();
    throw error;
  }
  started.piece = piece;
  runtime.prepareTxForCommit(tx);
  const { error } = await tx.commit().settled;
  await runtime.scheduler.idleWithPendingCommits();
  if (error !== undefined) {
    throw new Error(`the first commit was refused: ${error.message}`);
  }
  // With `SCALE_TRACE` set: each position read, each write staged and each
  // write record given is counted by its document and the shape of its
  // path, and `trace` returns the counts since it was last called.
  let traced = new Map<string, number>();
  if (Deno.env.get("SCALE_TRACE") !== undefined) {
    const transactions = piece.transactions;
    const shape = (kind: string, _doc: string, path: readonly string[]) => {
      const key = `${kind} /${
        path.map((step) => /^\d+$/.test(step) ? "#" : step).join("/")
      }`;
      traced.set(key, (traced.get(key) ?? 0) + 1);
    };
    const { read, change } = transactions;
    transactions.read = (doc, path) => {
      shape("read", doc, path);
      return read.call(transactions, doc, path);
    };
    transactions.change = (doc, path, ...rest) => {
      shape("write", doc, path);
      return change.call(transactions, doc, path, ...rest);
    };
    transactions.onRecorded((writes) => {
      for (const { record, target, unchanged } of writes) {
        shape(
          `record ${JSON.stringify(record)}${unchanged ? " unchanged" : ""}`,
          target.id,
          target.path,
        );
      }
    });
  }
  return {
    instance: piece.instance,
    trace: () => {
      const counts = Object.fromEntries(
        [...traced].sort(([, a], [, b]) => b - a),
      );
      traced = new Map();
      return counts;
    },
    send: async (
      binding: number,
      event: unknown,
      trusted?: { surface: string; action: string },
    ) => {
      const stream = piece.instance.streams().find((held) =>
        held.binding === binding && held.instance === undefined
      );
      const entity = stream === undefined
        ? undefined
        : piece.transactions.entityOfStream({
          binding: stream.binding,
          keys: stream.keys,
        });
      if (entity === undefined) return false;
      const before = piece.counts;
      const refusedBefore = piece.refusals.length;
      const encoded = piece.transactions.encode(event);
      // With the write policies kept, a send is a gesture on the send
      // surface: the event carries the provenance a renderer attests for
      // a click there and the renderer's mark, as the event of a test step
      // with `trustedUi` does (`runtime/cli/lib/trusted-action-event.ts`).
      const sent = trusted === undefined || typeof encoded !== "object" ||
          encoded === null
        ? encoded
        : {
          type: "click",
          ...encoded,
          provenance: reviewedActionProvenance("dom", trusted),
        };
      if (sent !== encoded) markRendererTrustedEvent(sent);
      // A gesture is queued as an event the scheduler does not hold back:
      // it delivers the eleventh gesture in a row and each one behind it
      // once a second (`scheduler/wake-shaping.ts`), and the time of a send
      // would be that of the wait. The last argument is the one the
      // scheduler's own requeue of an event passes, which is not shaped.
      runtime.scheduler.queueEvent(
        { space, id: entity, path: [], scope: "space" },
        sent,
        true,
        undefined,
        sent !== encoded,
      );
      await runtime.scheduler.idleWithPendingCommits();
      const after = piece.counts;
      if (
        after.eventsRefused > before.eventsRefused ||
        piece.refusals.length > refusedBefore
      ) {
        console.error([...piece.refusals].at(-1)?.slice(0, 400));
      }
      // An event is committed where its handler ran and the storage
      // refused no commit of the piece behind it.
      return after.events > before.events &&
        after.eventsRefused === before.eventsRefused &&
        piece.refusals.length === refusedBefore;
    },
    adapter: () => {
      const { reads, writes, recordsGiven, committed, byCause } =
        piece.transactions.counts;
      return {
        reads,
        writes,
        recordsGiven,
        commits: committed,
        ...Object.fromEntries(
          ["handler", "derivation", "send"].map((
            cause,
          ) => [`${cause}Commits`, byCause[cause] ?? 0]),
        ),
        derivations: piece.counts.derivations,
        ownMs: piece.counts.ownMs,
        changedDocuments: changedByCommits.documents,
        changedBytes: changedByCommits.bytes,
      };
    },
    stop: async () => {
      piece.stop();
      await runtime.dispose();
      await server.close();
    },
  } satisfies Started;
};

/**
 * Starts the sampling profiler where `SCALE_CPU_PROFILE` names a file, and
 * returns what stops it and writes the profile of the steps since.
 */
const profiled = (size: number): Promise<() => Promise<void>> => {
  const file = Deno.env.get("SCALE_CPU_PROFILE");
  return file === undefined
    ? Promise.resolve(() => Promise.resolve())
    : startCpuProfile(`${file}.${size}`);
};

const print = (step: Record<string, unknown>) =>
  console.log(JSON.stringify(step));

/** The counters of the executor that a step is charged with. */
const counted = (instance: Instance, before: Instance["counts"]) => ({
  evaluations: instance.counts.evaluations - before.evaluations,
  elementEvaluations: instance.counts.elementEvaluations -
    before.elementEvaluations,
  assemblies: instance.counts.assemblies - before.assemblies,
});

/**
 * The gesture a send of the room is made with where the write policies are
 * kept: `CHAT_SEND_SURFACE` and `CHAT_SEND_ACTION` of
 * `./fabrichat/schemas.tsx`.
 */
/**
 * Where `SCALE_CHANGES` is set and a timed send is listed: each document a
 * commit changed, with its scope, and its size as JSON after the commit.
 */
let changesListed: [string, number][] | undefined;

const SEND_GESTURE = Deno.env.get("SCALE_POLICIES") === "keep"
  ? { surface: "ChatSendSurface", action: "ChatSend" }
  : undefined;

/**
 * Runs the room under the serving loop for one size: a client sets the
 * piece up, the serving runtime of a memory server on this thread starts
 * and runs it, and a second client reads. Each send is timed from the send
 * until each client reads the count of messages it makes.
 */
const underServingLoop = async (
  artifact: Artifact,
  artifacts: Artifact[],
  size: number,
): Promise<void> => {
  const base = { arm: "serving", pattern: artifact.name, size };
  const signer = await Identity.fromPassphrase("pattern-compiler fabrichat");
  const space = signer.did();
  // The table that answers each `wish` names the seeded documents, which
  // exist once the sender wrote them.
  let home: ReturnType<typeof homeStubs> | undefined;
  const failures: string[] = [];
  const serving = await listenCompiledServingMemoryServer({
    // The artifacts are the ones this process emitted, with the write
    // policies taken out as on the other arms.
    compile: () =>
      Promise.resolve({
        main: artifact,
        artifacts: (id) =>
          artifacts.find(({ plan }) =>
            (plan as { patterns?: string[] }).patterns?.[0] === id
          ),
      }),
    pieces: {
      piece: {
        now: Date.now(),
        wishes: (operands) => home?.wishes(operands),
        builtins: builtinsOf(space, space),
        ...(Deno.env.get("SCALE_LISTS") === "in-place"
          ? { lists: "in-place" as const }
          : {}),
      },
      failed: (_result, error) => failures.push(`${error}`),
    },
  });
  const client = () =>
    new Runtime({
      apiUrl: serving.url,
      storageManager: StorageManager.open({
        as: signer,
        memoryHost: serving.url,
      }),
      experimental: { serverExecution: true },
    });
  const sender = client();
  const reader = client();
  const cancels: (() => void)[] = [];
  try {
    const seeded = sender.edit();
    const profile = sender.getCell(space, "profile", undefined, seeded);
    profile.set(structuredClone(PROFILE) as never);
    const root = sender.getCell(space, space, undefined, seeded);
    root.key("defaultPattern").set(
      {
        profiles: [profile],
        backlinksIndex: { mentionable: [] },
        pieceRegistry: [],
      } as never,
    );
    const seeding = await seeded.commit().settled;
    if (seeding.error !== undefined) throw seeding.error;
    home = homeStubs({
      profile: {
        id: profile.getAsNormalizedFullLink().id,
        kind: "profile",
        value: structuredClone(PROFILE),
        space,
      },
      root: {
        id: root.getAsNormalizedFullLink().id,
        kind: "space root",
        value: {},
      },
    });
    const result = sender.getCell<unknown>(space, "fabrichat under serving");
    const link = result.getAsNormalizedFullLink();
    /** Resolves with the time at which `runtime` reads `count` messages. */
    const reads = (runtime: Runtime, count: number): Promise<number> => {
      const { promise, resolve } = Promise.withResolvers<number>();
      const cell = runtime.getCellFromLink(link).key("messages" as never)
        .key("count" as never) as unknown as Cell<number>;
      cancels.push(cell.sink((value) => {
        if (value === count) resolve(performance.now());
      }));
      return promise;
    };
    let began = performance.now();
    const started = Promise.all([reads(sender, 0), reads(reader, 0)]);
    const tx = sender.edit();
    setUpCompiledPiece(
      sender,
      tx,
      // The serving runtime is given the artifacts, and reads no source.
      { main: "/room.tsx", files: [{ name: "/room.tsx", contents: "" }] },
      {},
      result.withTx(tx),
    );
    const { error } = await tx.commit().settled;
    if (error !== undefined) throw error;
    const [startedAtSender, startedAtReader] = await started;
    print({
      ...base,
      step: "start",
      sender: startedAtSender - began,
      reader: startedAtReader - began,
      failures,
    });
    // The sender holds the marker of the stream, by which a send to the
    // member of the result is the append of an event.
    const sendMessage = sender.getCellFromLink(link).key(
      "sendMessage" as never,
    ) as unknown as Cell<unknown>;
    await sendMessage.sync();
    await sendMessage.resolveAsCell().sync();
    cancels.push(sendMessage.sink(() => {}));
    const [piece] = serving.runtimes().flatMap((runtime) =>
      compiledPiecesOf(runtime)
    );
    began = performance.now();
    for (let index = 0; index < size; index++) {
      const done = reads(sender, index + 1);
      sendMessage.send({ body: `message ${index}` } as never);
      await done;
    }
    print({ ...base, step: "seed", ms: performance.now() - began, failures });
    for (let index = 0; index < 3; index++) {
      const before = piece === undefined
        ? undefined
        : { ...piece.transactions.counts, ownMs: piece.counts.ownMs };
      const atSender = reads(sender, size + index + 1);
      const atReader = reads(reader, size + index + 1);
      began = performance.now();
      sendMessage.send({ body: `timed ${index}` } as never);
      const [sent, read] = await Promise.all([atSender, atReader]);
      const after = piece?.transactions.counts;
      print({
        ...base,
        step: "send",
        sender: sent - began,
        reader: read - began,
        ...(piece === undefined || before === undefined || after === undefined
          ? {}
          : {
            reads: after.reads - before.reads,
            writes: after.writes - before.writes,
            recordsGiven: after.recordsGiven - before.recordsGiven,
            ownMs: piece.counts.ownMs - before.ownMs,
          }),
        refusals: piece?.refusals.length ?? 0,
        failures,
      });
    }
  } finally {
    for (const cancel of cancels) cancel();
    await sender.dispose();
    await reader.dispose();
    await serving.close();
  }
};

const [arm, which, sizes] = Deno.args;
const name = PATTERNS[which];
if (
  !["executor", "runner", "serving"].includes(arm) || name === undefined ||
  (arm === "serving" && which !== "room")
) {
  console.error(
    "usage: scale.ts <executor | runner | serving> <room | manager | home> [sizes]",
  );
  Deno.exit(2);
}
const artifacts = await emitted();
const artifact = artifacts.find((pattern) => pattern.name === name)!;
if (arm === "serving") {
  for (const size of (sizes ?? "10,100,1000").split(",").map(Number)) {
    await underServingLoop(artifact, artifacts, size);
  }
  Deno.exit(0);
}
const start = arm === "executor" ? inMemory : onRunner;

for (
  const size of which === "room"
    ? (sizes ?? "10,100,1000").split(",").map(Number)
    : [0]
) {
  const base = { arm, pattern: name, size };
  let began = performance.now();
  const started: Started = await start(artifact, artifacts);
  const { instance, send, stop } = started;
  /** What the adapter counted since `before`. */
  const adapted = (before: Record<string, number> | undefined) => {
    const now = started.adapter?.();
    return now === undefined || before === undefined ? {} : Object.fromEntries(
      Object.entries(now).map(([name, count]) => [name, count - before[name]]),
    );
  };
  const result = instance.result() as Record<string, unknown>;
  print({
    ...base,
    step: "start",
    ms: performance.now() - began,
    ...counted(instance, {
      ...instance.counts,
      evaluations: 0,
      elementEvaluations: 0,
      assemblies: 0,
    }),
    members: Object.keys(result ?? {}).length,
    failed: [...new Set(instance.failed.map(({ cone }) => cone))],
    failures: [...new Set(instance.failed.map(({ message }) => message))],
  });
  if (which === "home") {
    // One interaction: a space is added to the list Home keeps.
    const plan = artifact.plan as { bindings: { name: unknown }[] };
    const binding = plan.bindings.findIndex((held) =>
      held.name === "addSpaceHandler"
    );
    const before = { ...instance.counts };
    const adapter = started.adapter?.();
    const stopProfile = await profiled(size);
    began = performance.now();
    const committed = await send(binding, {
      name: "notes",
      did: "did:key:z6MkaddedByTheRun",
    });
    const ms = performance.now() - began;
    await stopProfile();
    const { spaces } = instance.result() as { spaces?: unknown[] };
    print({
      ...base,
      step: "interaction",
      ms,
      committed,
      ...counted(instance, before),
      ...adapted(adapter),
      spaces,
    });
  }
  if (which === "room") {
    const plan = artifact.plan as { bindings: { name: unknown }[] };
    const binding = plan.bindings.findIndex((held) =>
      held.name === "sendMessage"
    );
    began = performance.now();
    let refused = 0;
    for (let index = 0; index < size; index++) {
      if (!await send(binding, { body: `message ${index}` }, SEND_GESTURE)) {
        refused += 1;
      }
    }
    print({ ...base, step: "seed", ms: performance.now() - began, refused });
    const stopProfile = await profiled(size);
    for (let index = 0; index < 3; index++) {
      const before = { ...instance.counts };
      const adapter = started.adapter?.();
      started.trace?.();
      if (Deno.env.get("SCALE_CHANGES") !== undefined && index === 2) {
        changesListed = [];
      }
      began = performance.now();
      const committed = await send(
        binding,
        { body: `timed ${index}` },
        SEND_GESTURE,
      );
      const listed = changesListed?.sort(([, a], [, b]) => b - a);
      changesListed = undefined;
      if (Deno.env.get("SCALE_TRACE") !== undefined && index === 2) {
        print({ ...base, step: "trace", ...started.trace?.() });
      }
      print({
        ...base,
        step: "send",
        ms: performance.now() - began,
        committed,
        ...counted(instance, before),
        ...adapted(adapter),
        ...(listed === undefined ? {} : { changes: listed }),
      });
    }
    await stopProfile();
    if (Deno.env.get("SCALE_DUMP") !== undefined) {
      await Deno.writeTextFile(
        Deno.env.get("SCALE_DUMP")!,
        JSON.stringify(
          [...instance.store.docs].map(([id, { value }]) => [id, value]),
          (_, member) => typeof member === "bigint" ? `${member}n` : member,
          1,
        ),
      );
    }
    began = performance.now();
    const { messages, messageRights } = instance.result() as {
      messages: { count: number; latest: { messages: { body: string }[] } };
      messageRights: { message: { body: string }; canEdit: boolean }[];
    };
    print({
      ...base,
      step: "read",
      ms: performance.now() - began,
      count: messages.count,
      last: messages.latest.messages.at(-1)?.body,
      rights: messageRights.length,
      lastRights: messageRights.at(-1),
    });
  }
  await stop();
}
