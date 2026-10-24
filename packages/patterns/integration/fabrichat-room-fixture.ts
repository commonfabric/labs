/**
 * Builds a FabriChat group room the way people come to have one: each member
 * has a real Home and a profile created through it, the starter creates the
 * room from their manager, and the members write in it, each through a runtime
 * of their own that runs their Home beside the room.
 *
 * The profiles are what makes this different from a room seeded under a
 * stand-in. A profile Home creates is the root of a space of its own, so every
 * participant chip and every author badge a room renders reads a document in
 * another space, and each carries the `represents-principal` label a message's
 * authorship is verified against. A room of twelve members opens thirteen
 * spaces besides its own.
 *
 * Writing joins a member to the room: the room tells the writer's manager,
 * which lists the room and puts the member on its roster. A member left with
 * nothing to write, in a room of fewer messages than members, joins the way a
 * visit to the room joins them in the shell, through their manager's
 * `joinRoom`. So every member is on the roster whatever the room's size.
 *
 * The members write in turn, each a block of consecutive messages, and a
 * member's runtime runs only while they write their block. Every runtime that
 * runs the room recomputes it on each message, so a room whose members all
 * stayed open would cost a recompute per member per message. One second member
 * stays open throughout to add the reactions and, with the last writer, the
 * thread replies; neither is the starter, whose reaction is the one a
 * benchmark adds.
 *
 * Every message is a trusted `ChatSend`, sent one at a time. The room's write
 * policy admits a message from that action alone, and the room stamps each
 * with the time it arrives, refusing a proposed time more than ten minutes
 * old, so a room's history cannot be written in bulk or back-dated.
 *
 * Every body is derived from its index, so two rooms of one size carry the
 * same text and their timings are comparable.
 *
 * Each act waits for its effect in the acting member's copy of the room. A
 * room handler that refuses an act throws instead of writing, and the error
 * the member's runtime reports for it ends that wait, so the seed fails with
 * the refusal's reason rather than waiting for an effect that never comes.
 */

import type { DID } from "@commonfabric/identity";
import { Identity } from "@commonfabric/identity";
import { joinVisitedRoomOf } from "@commonfabric/piece/ops";
import type { Cell } from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { join } from "@std/path";
import {
  initializePiecesController,
  PieceController,
  type PiecesController,
} from "./pieces-controller.ts";

/** One member of a seeded room. */
export interface SeededMember {
  /** The member's principal, which is also their home space. */
  did: DID;

  /** The name their profile holds. */
  name: string;

  /** The space their profile is the root of. */
  profileSpace: DID;
}

/** A thread seeded under one of the room's messages. */
export interface SeededThread {
  /** Index of the message the thread is under, as {@link messageBody} takes. */
  root: number;

  /** How many replies the thread holds. */
  replies: number;
}

/** What a seeded room is, and what a reader of it needs to find it again. */
export interface FabrichatRoomFixture {
  /** The passphrase every member's identity is derived from. */
  passphrase: string;

  /** The space the room is the root of. */
  roomSpace: DID;

  /** The room's piece id, as a shell URL addresses it. */
  roomId: string;

  /** The room's title. */
  title: string;

  /** The members, all on the room's roster, the starter first. */
  members: SeededMember[];

  /** How many messages the room's main conversation holds. */
  messageCount: number;

  /** The threads, each under a message of the main conversation. */
  threads: SeededThread[];

  /**
   * Indexes of the messages that carry a {@link SEEDED_REACTION}, each from a
   * member other than the starter.
   */
  reacted: number[];
}

export interface SeedFabrichatRoomOptions {
  apiUrl: URL;

  /**
   * The passphrase the members' identities derive from. The members' Homes
   * persist in their home spaces, so a room seeded under a passphrase used
   * before finds them there, and their managers already list that earlier
   * room. Pass a fresh one per room for members whose Home lists that room
   * alone.
   */
  passphrase: string;

  /** How many members the room has, the starter included. */
  memberCount: number;

  /** How many messages the main conversation holds. */
  messageCount: number;

  /** How many threads to seed, each under one of the latest messages. */
  threadCount?: number;

  /** How many replies each thread holds. */
  repliesPerThread?: number;

  /**
   * Every how-many-th message carries a reaction, counting from the first; 0
   * for none.
   */
  reactionEvery?: number;

  /** Called once each message or reply is in the room. */
  onMessage?: (written: number, total: number) => void;
}

export const DEFAULT_MEMBER_COUNT = 12;
export const DEFAULT_THREAD_COUNT = 1;
export const DEFAULT_REPLIES_PER_THREAD = 5;
export const DEFAULT_REACTION_EVERY = 3;

/** The reaction a seeded reaction adds. */
export const SEEDED_REACTION = "👍";

/**
 * How many of the main conversation's messages a room's `latest` holds, as
 * `FABRICHAT_POLICY.maxWindowCount` in `../fabrichat/room-records.tsx` states.
 */
const LATEST_WINDOW = 100;

/** What the starter names the room. */
export const ROOM_TITLE = "Benchmark room";

// The reviewed actions FabriChat admits each act from, as
// `../fabrichat/schemas.tsx` names them, and the one Home admits a profile's
// creation from.
const PROFILE_CREATE = {
  surface: "ProfileCreateSurface",
  action: "CreateProfile",
};
const CHAT_START = { surface: "ChatStartSurface", action: "ChatStart" };
const CHAT_SEND = { surface: "ChatSendSurface", action: "ChatSend" };
const CHAT_REACT = { surface: "ChatReactSurface", action: "ChatReact" };

// Words a message's body is drawn from. None of them is a word a benchmark
// writes into the room itself.
const VOCABULARY = [
  "lunch",
  "agenda",
  "draft",
  "review",
  "launch",
  "notes",
  "budget",
  "sketch",
  "deadline",
  "meeting",
  "release",
  "feedback",
];

/** How many words of {@link VOCABULARY} a body carries after its heading. */
const BODY_WORDS = 14;

/** The identity of the member at `index` of a room seeded under `passphrase`. */
export function memberIdentity(
  passphrase: string,
  index: number,
): Promise<Identity> {
  return Identity.fromPassphrase(`${passphrase} member ${index}`, {
    implementation: "noble",
  });
}

/** The name the member at `index` gives their profile. */
export function memberName(index: number): string {
  return `Member ${index + 1}`;
}

/**
 * The member who writes the message at `index`. Each member writes a block of
 * consecutive messages, the blocks as even as the counts allow, so every
 * member writes when there are at least as many messages as members, and the
 * first `messageCount` members write one each when there are fewer.
 */
export function authorOf(
  index: number,
  messageCount: number,
  memberCount: number,
): number {
  return messageCount < memberCount
    ? index
    : Math.floor(index * memberCount / messageCount);
}

/** How many members write in a room of this shape. */
export function writerCount(messageCount: number, memberCount: number): number {
  return Math.min(messageCount, memberCount);
}

/** The body of the main conversation's message at `index`. */
export function messageBody(index: number): string {
  const words = Array.from(
    { length: BODY_WORDS },
    (_, position) => VOCABULARY[(index * 7 + position * 5) % VOCABULARY.length],
  );
  return `${messageHeading(index)} ${words.join(" ")}.`;
}

/**
 * The opening of {@link messageBody}, unique among a room's messages: the
 * number sits between "Message " and a period, so no message's heading holds
 * another's.
 */
export function messageHeading(index: number): string {
  return `Message ${index + 1}.`;
}

/** The body of the reply at `reply` in the thread at `thread`. */
export function replyBody(thread: number, reply: number): string {
  return `Reply ${reply + 1} in thread ${thread + 1}.`;
}

/**
 * The message each thread is under: the latest messages, one per thread
 * counting back from the last, so that each is in the window of the latest
 * messages the room addresses its messages by. A room has no more threads than
 * that window holds messages.
 */
export function threadRoots(
  messageCount: number,
  threadCount: number,
): number[] {
  return Array.from(
    { length: Math.min(threadCount, messageCount, LATEST_WINDOW) },
    (_, thread) => messageCount - 1 - thread,
  );
}

/**
 * The indexes of messages that carry a reaction. A room of one member has
 * none: its one member is the viewer, whose reaction a benchmark adds.
 */
export function reactedMessages(
  messageCount: number,
  memberCount: number,
  reactionEvery: number,
): number[] {
  if (reactionEvery <= 0 || memberCount < 2) return [];
  return Array.from({ length: messageCount }, (_, index) => index)
    .filter((index) => index % reactionEvery === 0);
}

/**
 * The waits of one member's runtime for the effects of what the member did,
 * each ended by whichever comes first: the effect, or an error an action of
 * that runtime reports. A handler that refuses an act throws rather than
 * writing, so the effect a wait looks for would never arrive, and the error is
 * the only word of the refusal there is.
 */
export class MemberWaits {
  #pending = new Set<(error: Error) => void>();

  /**
   * Constructs an instance which ends the pending waits on the errors
   * `scheduler` reports. A scheduler keeps every handler it is given, so one
   * instance serves the whole life of its runtime.
   */
  constructor(scheduler: { onError(handler: (error: Error) => void): void }) {
    scheduler.onError((error) => {
      for (const fail of [...this.#pending]) fail(error);
    });
  }

  /**
   * Resolves with the value of `cell` once `holds` accepts it, reading each
   * value the cell takes rather than asking again on a schedule.
   *
   * @throws Error naming `what`, with the action's error as its `cause`, when
   *   an action of the runtime fails before the value arrives.
   */
  until<T>(
    what: string,
    cell: {
      sink(callback: (value: T | undefined) => void): () => void;
    },
    holds: (value: T | undefined) => boolean,
  ): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `${what} did not happen: an action failed with: ${error.message}`,
          { cause: error },
        ),
      );
    };
    this.#pending.add(fail);
    const cancel = cell.sink((value) => {
      if (settled || !holds(value)) return;
      settled = true;
      resolve(value as T);
    });
    return promise.finally(() => {
      this.#pending.delete(fail);
      cancel();
    });
  }
}

/**
 * Sends `event` on `stream` as a click on a control of the reviewed `surface`
 * and `action`, the way a renderer delivers one, and waits for it to commit.
 */
async function sendTrusted(
  controller: PiecesController,
  stream: Cell<unknown>,
  event: Record<string, unknown>,
  { surface, action }: { surface: string; action: string },
): Promise<void> {
  const click = {
    type: "click",
    ...event,
    provenance: reviewedActionProvenance("dom", { surface, action }),
  };
  markRendererTrustedEvent(click);
  const runtime = controller.runtime;
  const tx = runtime.edit();
  stream.withTx(tx).send(click);
  runtime.prepareTxForCommit(tx);
  const { error } = await tx.commit().settled;
  if (error) {
    throw new Error(`\`${action}\` did not commit: ${error.message}`);
  }
}

/** One member while the room is seeded: their runtime, Home, and room. */
interface MemberSession {
  index: number;
  identity: Identity;
  controller: PiecesController;
  home: Cell<unknown>;
  room?: Cell<unknown>;

  /** Requests this member has sent, which their request ids count. */
  sent: number;

  /** The member's waits for the effects of what they did. */
  waits: MemberWaits;
}

/**
 * Opens the member at `index`: their Home, started, with a profile. A Home
 * that already holds a profile is given no second one.
 */
async function openMember(
  apiUrl: URL,
  identity: Identity,
  index: number,
): Promise<MemberSession> {
  const controller = await initializePiecesController({
    space: identity.did(),
    apiUrl,
    identity,
  });
  const waits = new MemberWaits(controller.runtime.scheduler);
  try {
    const home = (await controller.ensureDefaultPattern()).getCell();
    await controller.runtime.idle();
    // The list holds links to profiles in spaces of their own, which its
    // length needs none of.
    const profiles = home.key("profiles").asSchema<Cell<unknown>[]>({
      type: "array",
      items: { asCell: ["cell"] },
    });
    await profiles.pull();
    if ((profiles.get() ?? []).length === 0) {
      await sendTrusted(controller, home.key("createProfile"), {
        target: { value: memberName(index) },
      }, PROFILE_CREATE);
      await waits.until(
        `${memberName(index)}'s profile creation`,
        profiles,
        (list) => (list ?? []).length > 0,
      );
    }
    return { index, identity, controller, home, sent: 0, waits };
  } catch (error) {
    await controller.dispose();
    throw error;
  }
}

/**
 * Waits for `member`'s writes to reach the server, and releases their
 * runtime.
 */
async function closeMember(member: MemberSession): Promise<void> {
  try {
    await member.controller.runtime.idle();
    await member.controller.synced();
  } finally {
    await member.controller.dispose();
  }
}

/** The space the member's first profile is the root of. */
async function profileSpaceOf(member: MemberSession): Promise<DID> {
  const profile = await member.home.key("profiles").key(0)
    .asSchema<Cell<unknown>>({ asCell: ["cell"] }).pull();
  return profile.space as DID;
}

/**
 * Has the starter create the room from their manager, naming every other
 * member by address, and returns the room as the starter's runtime holds it.
 */
async function createRoom(
  starter: MemberSession,
  others: readonly Identity[],
): Promise<Cell<unknown>> {
  const manager = starter.home.key("chatManager");
  const requestId = "benchmark-room";
  await sendTrusted(starter.controller, manager.key("createGroup"), {
    requestId,
    title: ROOM_TITLE,
    members: others.map((identity) => identity.did()),
  }, CHAT_START);
  const outcome = await starter.waits.until(
    `${memberName(starter.index)}'s creation of the room`,
    manager.key("requests").key(requestId) as Cell<
      { status?: string; reason?: string } | undefined
    >,
    (value) => value?.status !== undefined,
  );
  if (outcome.status !== "done") {
    throw new Error(
      `The starter's manager refused the room: ${outcome.reason ?? "?"}`,
    );
  }
  // The room's space and its grants exist on the server only once the
  // starter's runtime has sent them there, and until then the other members
  // may not read it.
  await starter.controller.runtime.idle();
  await starter.controller.synced();
  // The entry holds a link to the room, which only a schema marking the
  // position as a cell reads as one rather than as the room's value.
  return await manager.key("requests").key(requestId).key("entry").key("room")
    .asSchema<Cell<unknown>>({ asCell: ["cell"] }).pull();
}

/** Starts the room in `member`'s runtime, beside their Home. */
async function enterRoom(
  member: MemberSession,
  room: Cell<unknown>,
): Promise<Cell<unknown>> {
  const runtime = member.controller.runtime;
  const here = runtime.getCellFromLink(room.getAsNormalizedFullLink());
  member.room = await member.controller.getPieceCell(here, true);
  return member.room;
}

/** How many entries, main and threaded, `member`'s copy of the room holds. */
function countOf(member: MemberSession): Cell<number | undefined> {
  return member.room!.key("messages").key("count") as Cell<number | undefined>;
}

/**
 * Sends one message as `member`, which `what` names, and waits until their
 * copy of the room counts `total` entries, which it does once the room has
 * recorded it.
 */
async function writeAs(
  member: MemberSession,
  what: string,
  event: Record<string, unknown>,
  total: number,
): Promise<void> {
  member.sent++;
  await sendTrusted(
    member.controller,
    member.room!.key("sendMessage"),
    event,
    CHAT_SEND,
  );
  await member.waits.until(
    `${memberName(member.index)}'s send of ${what}`,
    countOf(member),
    (count) => (count ?? 0) >= total,
  );
}

/** How many reactions `message` holds, as `member`'s copy of the room has it. */
function reactionCountOf(message: Cell<unknown>): Cell<number | undefined> {
  return message.key("reactions").key("length") as Cell<number | undefined>;
}

/**
 * Adds {@link SEEDED_REACTION} as `member` to the main conversation's message
 * at `index`, once their copy of the room holds `written` entries, of which
 * `main` are in the main conversation.
 */
async function reactAs(
  member: MemberSession,
  index: number,
  main: number,
  written: number,
): Promise<void> {
  member.sent++;
  await catchUp(member, written);
  const message = await mainMessage(member, index, main);
  const before = (await reactionCountOf(message).pull()) ?? 0;
  await sendTrusted(member.controller, member.room!.key("sendReaction"), {
    message,
    emoji: SEEDED_REACTION,
  }, CHAT_REACT);
  await member.waits.until(
    `${memberName(member.index)}'s reaction to message ${index + 1}`,
    reactionCountOf(message),
    (count) => (count ?? 0) > before,
  );
}

/**
 * Waits until `member`'s copy of the room counts `written` entries, so that
 * what they do next reads the room as it stands.
 */
function catchUp(member: MemberSession, written: number): Promise<number> {
  return member.waits.until(
    `${memberName(member.index)}'s catch-up to ${written} entries`,
    countOf(member),
    (count) => (count ?? 0) >= written,
  );
}

/** The main conversation's message at `index`, as `member`'s room holds it. */
function mainMessage(
  member: MemberSession,
  index: number,
  main: number,
): Promise<Cell<unknown>> {
  // `latest` holds the last hundred of the `main` messages of the main
  // conversation.
  const latest = member.room!.key("messages").key("latest").key("messages");
  const offset = Math.max(0, main - LATEST_WINDOW);
  if (index < offset) {
    throw new Error(`Message ${index} is outside the room's latest window`);
  }
  return latest.key(index - offset)
    .asSchema<Cell<unknown>>({ asCell: ["cell"] }).pull();
}

/** What a seeded room records of `member`, who must still be open. */
async function describeMember(member: MemberSession): Promise<SeededMember> {
  return {
    did: member.identity.did(),
    name: memberName(member.index),
    profileSpace: await profileSpaceOf(member),
  };
}

/**
 * Creates a room whose members each have a real Home and profile, and fills
 * it. Every member's runtime is disposed before this returns, so the room is
 * left to whatever reads it next with no connection of ours still open.
 */
export async function seedFabrichatRoom(
  options: SeedFabrichatRoomOptions,
): Promise<FabrichatRoomFixture> {
  const {
    apiUrl,
    passphrase,
    memberCount,
    messageCount,
    threadCount = DEFAULT_THREAD_COUNT,
    repliesPerThread = DEFAULT_REPLIES_PER_THREAD,
    reactionEvery = DEFAULT_REACTION_EVERY,
  } = options;
  if (memberCount < 1) throw new Error("A room needs at least one member");
  if (messageCount < 1) throw new Error("A room needs at least one message");
  const roots = threadRoots(messageCount, threadCount);
  const reacting = new Set(
    reactedMessages(messageCount, memberCount, reactionEvery),
  );
  const blocks: number[][] = Array.from(
    { length: writerCount(messageCount, memberCount) },
    () => [],
  );
  for (let index = 0; index < messageCount; index++) {
    blocks[authorOf(index, messageCount, memberCount)].push(index);
  }
  const total = messageCount + roots.length * repliesPerThread;
  const identities = await Promise.all(
    Array.from(
      { length: memberCount },
      (_, index) => memberIdentity(passphrase, index),
    ),
  );

  // Every runtime this seed holds open, so that a failure releases them all.
  const open = new Set<MemberSession>();
  const acted = new Map<number, SeededMember>();
  const openRoomMember = async (index: number): Promise<MemberSession> => {
    const member = await openMember(apiUrl, identities[index], index);
    open.add(member);
    return member;
  };
  const release = async (member: MemberSession): Promise<void> => {
    // Out of the set before closing, which disposes the runtime whether or not
    // its writes reach the server, so a failure here is not disposed twice.
    open.delete(member);
    await closeMember(member);
  };
  const record = async (member: MemberSession): Promise<void> => {
    if (!acted.has(member.index)) {
      acted.set(member.index, await describeMember(member));
    }
  };

  try {
    const starter = await openRoomMember(0);
    const room = await createRoom(starter, identities.slice(1));
    const roomId = new PieceController(starter.controller, room).id;
    await enterRoom(starter, room);
    // The member who reacts, and replies beside the last writer, open from
    // the start: the second member, or the starter in a room of one.
    const helper = memberCount > 1 ? await openRoomMember(1) : starter;
    if (helper !== starter) await enterRoom(helper, room);

    let written = 0;
    let last = starter;
    for (const [writer, block] of blocks.entries()) {
      const author = writer === 0
        ? starter
        : writer === helper.index
        ? helper
        : await openRoomMember(writer);
      if (author.room === undefined) await enterRoom(author, room);
      for (const index of block) {
        // The author's copy has every earlier message before they write, so
        // their write reads the room as it stands rather than conflicting
        // with the message before it.
        await catchUp(author, written);
        await writeAs(author, `message ${index + 1}`, {
          target: { value: messageBody(index) },
        }, ++written);
        options.onMessage?.(written, total);
        // A message is reacted to while it is the newest, and so within the
        // window of the latest messages the room addresses its messages by.
        if (reacting.has(index)) {
          await reactAs(helper, index, index + 1, written);
          await record(helper);
        }
      }
      await record(author);
      if (last !== helper && last !== author) await release(last);
      last = author;
    }

    for (const [thread, root] of roots.entries()) {
      for (let reply = 0; reply < repliesPerThread; reply++) {
        const author = reply % 2 === 0 ? last : helper;
        await catchUp(author, written);
        await writeAs(author, `reply ${reply + 1} in thread ${thread + 1}`, {
          target: { value: replyBody(thread, reply) },
          replyTo: {
            message: await mainMessage(author, root, messageCount),
            shownIn: "thread",
          },
        }, ++written);
        await record(author);
        options.onMessage?.(written, total);
      }
    }

    // A member with nothing to write joins as a visit joins them.
    for (let index = 0; index < memberCount; index++) {
      if (acted.has(index)) continue;
      const visitor = await openRoomMember(index);
      await enterRoom(visitor, room);
      const decision = await joinVisitedRoomOf(
        visitor.controller.runtime,
        visitor.home,
        visitor.identity.did(),
        room.space as DID,
      );
      if (decision !== "sent") {
        throw new Error(
          `${memberName(index)}'s visit did not join the room: ${decision}`,
        );
      }
      const joined = acted.size + 1;
      await visitor.waits.until(
        `${memberName(index)}'s join by visit`,
        visitor.room!.key("roster") as Cell<unknown[] | undefined>,
        (list) => (list ?? []).length >= joined,
      );
      await record(visitor);
      await release(visitor);
    }

    const roster = helper.room!.key("roster") as Cell<unknown[] | undefined>;
    await helper.waits.until(
      `${memberName(helper.index)}'s view of the full roster`,
      roster,
      (list) => (list ?? []).length >= memberCount,
    );

    for (const member of [...open]) await release(member);
    return {
      passphrase,
      roomSpace: room.space as DID,
      roomId,
      title: ROOM_TITLE,
      members: [...acted.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, member]) => member),
      messageCount,
      threads: roots.map((root) => ({ root, replies: repliesPerThread })),
      reacted: [...reacting],
    };
  } finally {
    await Promise.all([...open].map((member) => member.controller.dispose()));
  }
}

export interface SeedFabrichatRoomOutOfProcessOptions {
  apiUrl: URL;
  passphrase: string;
  memberCount: number;
  messageCount: number;
  threadCount?: number;
  repliesPerThread?: number;
  reactionEvery?: number;

  /** Heap ceiling for the child, in megabytes. */
  heapMegabytes?: number;
}

/**
 * Heap ceiling for the seeding child, which holds one runtime per member, each
 * with the compiled Home and room.
 */
export const DEFAULT_SEED_HEAP_MEGABYTES = 8192;

const REPO_ROOT = join(import.meta.dirname!, "..", "..", "..");

/**
 * Seeds a room in a child Deno and returns what it wrote. The child exits once
 * the room is complete, so the members' runtimes are gone before the caller
 * reads the fixture.
 */
export async function seedFabrichatRoomOutOfProcess(
  options: SeedFabrichatRoomOutOfProcessOptions,
): Promise<FabrichatRoomFixture> {
  const script = join(import.meta.dirname!, "fabrichat-room-seed.ts");
  const outputDirectory = await Deno.makeTempDir({
    prefix: "commonfabric-fabrichat-room-",
  });
  const output = join(outputDirectory, "fixture.json");
  try {
    const heap = options.heapMegabytes ?? DEFAULT_SEED_HEAP_MEGABYTES;
    const result = await runDenoCommandWithTemporaryLock({
      root: REPO_ROOT,
      args: (lockPath) => [
        "run",
        "--lock",
        lockPath,
        "--no-check",
        `--v8-flags=--max-old-space-size=${heap}`,
        "-A",
        script,
        `--api-url=${options.apiUrl.href}`,
        `--passphrase=${options.passphrase}`,
        `--members=${options.memberCount}`,
        `--messages=${options.messageCount}`,
        `--threads=${options.threadCount ?? DEFAULT_THREAD_COUNT}`,
        `--replies=${options.repliesPerThread ?? DEFAULT_REPLIES_PER_THREAD}`,
        `--reaction-every=${options.reactionEvery ?? DEFAULT_REACTION_EVERY}`,
        `--out=${output}`,
      ],
      // The child's progress, and the reason it gives up, reach the caller's
      // log as they happen rather than only once the child has exited.
      stderr: "inherit",
    });
    if (!result.success) {
      throw new Error(
        `Seeding a ${options.messageCount}-message room failed ` +
          `(exit ${result.code}); the seed's own stderr above says why`,
      );
    }
    return JSON.parse(await Deno.readTextFile(output)) as FabrichatRoomFixture;
  } finally {
    await Deno.remove(outputDirectory, { recursive: true });
  }
}
