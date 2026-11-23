/**
 * Runs the copies of FabriChat and Home (`./`, `../home/`) on the executor
 * of `../../exec/` and as a compiled piece in the runner, and measures a
 * send into a room that holds a given number of messages.
 *
 * `deno run -A --no-check base/pattern-compiler/compare/fabrichat/scale.ts <arm> <pattern> [sizes]`
 *
 * Run from the repository root, after `cargo build --release` in
 * `base/pattern-compiler`. `<arm>` is `executor`, the executor with its
 * documents in memory, or `runner`, a compiled piece started with
 * `startCompiledPiece` in a runtime on emulated storage, with the
 * experimental option `compiledPatterns` on. `<pattern>` is `room`
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
 *   evaluations of element bodies, assemblies).
 * - `read`: the messages of the result are read, and the step says how
 *   many the room holds, the text of the last, and for how many the
 *   result holds the reader's rights, with those of the last.
 *
 * `manager` and `home` are started, and the step says how many members the
 * result has and which cones ended in an error state. `home` then takes
 * one event, which adds a space to the list it keeps (`interaction`).
 *
 * With `SCALE_CPU_PROFILE` set to the path of a file, the timed sends of
 * `room` and the event of `home` are sampled and the profile is written
 * to that path followed by the size.
 *
 * Unless `SCALE_POLICIES` is `keep`, the schemas are given without the
 * write policies and the integrity they declare (`withoutWritePolicies`).
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

import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../../../runtime/runner/src/compiled/piece.ts";
import { ACLManager } from "../../../../runtime/runner/src/acl-manager.ts";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "../../../../runtime/runner/src/cfc/ui-contract.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import { joinSpaceMembers } from "../../../../runtime/runner/src/space-members.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
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
    });
  } catch (error) {
    tx.abort();
    await runtime.dispose();
    await server.close();
    throw error;
  }
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
      runtime.scheduler.queueEvent(
        { space, id: entity, path: [], scope: "space" },
        sent,
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
const SEND_GESTURE = Deno.env.get("SCALE_POLICIES") === "keep"
  ? { surface: "ChatSendSurface", action: "ChatSend" }
  : undefined;

const [arm, which, sizes] = Deno.args;
const name = PATTERNS[which];
if (!["executor", "runner"].includes(arm) || name === undefined) {
  console.error(
    "usage: scale.ts <executor | runner> <room | manager | home> [sizes]",
  );
  Deno.exit(2);
}
const artifacts = await emitted();
const artifact = artifacts.find((pattern) => pattern.name === name)!;
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
      began = performance.now();
      const committed = await send(
        binding,
        { body: `timed ${index}` },
        SEND_GESTURE,
      );
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
