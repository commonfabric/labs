/**
 * Runs an iframe pattern's guest in a Deno test. The guest's `guest.html` is
 * loaded into a simulated document, the guest's source module is evaluated
 * against it as it would be in the frame, and the host end of the bridge
 * serves it the resources a test supplies: in-memory cells, presence rooms,
 * and SQLite databases. The test then drives the document as a person would
 * and reads both the document and the resources back.
 *
 * Each page evaluates a fresh instance of the guest module, so every test
 * starts from a guest that has just loaded.
 */

// deno-lint-ignore no-external-import -- Deno's built-in SQLite holds a guest's database in memory.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  CustomEvent as DocumentCustomEvent,
  Event as DocumentEvent,
  EventTarget as DocumentEventTarget,
  Window,
} from "happy-dom";
import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";
import {
  type FabricPlainObject,
  type FabricValue,
  isFabricPlainObject,
  isValidFabricValue,
} from "@commonfabric/data-model";
import {
  type BridgeCell,
  type BridgePresenceRecord,
  type BridgePresenceRoom,
  type BridgePresenceRoomEvent,
  type BridgeResource,
  createFabricBridge,
  FabricBridgeHost,
  IPC,
  presenceResource,
} from "@commonfabric/iframe-sandbox";

/**
 * Hears every change a guest makes to a resource a test handed it, and every
 * change a test double announces.
 */
const changeListeners = new Set<() => void>();

/**
 * Tells every pending {@link GuestPage.until} to check its condition again.
 * The resources here call it on each change the guest makes to them; a test
 * double whose state a test waits on calls it on each change too.
 */
export function announceChange(): void {
  for (const listener of [...changeListeners]) listener();
}

//
// Cells
//

type Path = readonly (string | number)[];

/** Returns `value`, which a test supplied, as the value a cell holds. */
function fabricValueOf(value: unknown): FabricValue {
  if (!isValidFabricValue(value)) {
    throw new TypeError("A cell holds only values the data model can store.");
  }
  return value;
}

/** Returns the value at `path` inside `root`, or undefined past its end. */
function valueAt(
  root: FabricValue | undefined,
  path: Path,
): FabricValue | undefined {
  let value = root;
  for (const key of path) {
    if (Array.isArray(value)) value = value[Number(key)];
    else if (isFabricPlainObject(value)) value = value[key];
    else return undefined;
  }
  return value;
}

/**
 * Returns a copy of `root` with `value` at `path`, copying each container on
 * the way down.
 */
function withValueAt(
  root: FabricValue | undefined,
  path: Path,
  value: FabricValue,
): FabricValue {
  if (path.length === 0) return value;
  const [key, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[Number(key)] = withValueAt(copy[Number(key)], rest, value);
    return copy;
  }
  if (isFabricPlainObject(root)) {
    return { ...root, [key]: withValueAt(root[key], rest, value) };
  }
  throw new TypeError(`Cannot write \`${key}\` into a non-container value.`);
}

/** One write a guest made, as a {@link MemoryCell} records it. */
export interface CellWrite {
  readonly operation: "set" | "push" | "initialize";
  readonly path: Path;
  readonly value: FabricValue;
}

/**
 * A cell a test hands a guest, holding its value in memory. Every write the
 * guest makes through it, at any path, replaces the value and reaches each
 * sink the guest holds on a path whose value it changed.
 */
export class MemoryCell {
  #value: FabricValue | undefined;
  readonly #readonly: boolean;
  readonly #identity: Omit<IPC.BridgeCellIdentity, "path"> | undefined;
  readonly #sinks = new Set<() => void>();
  readonly #waiters = new Set<(write: CellWrite) => void>();
  #writeFailure: Error | undefined;
  #readFailure: Error | undefined;
  #heldReads: Promise<void> | undefined;

  /** The writes the guest made, in order. */
  readonly writes: CellWrite[] = [];

  /**
   * Constructs a cell holding `value`, or none. A `readonly` cell grants the
   * guest no writes. A cell with an `identity` gives the guest that identity,
   * at the path resolved, for each cell it resolves.
   */
  constructor(
    value?: unknown,
    options: {
      readonly?: boolean;
      identity?: Omit<IPC.BridgeCellIdentity, "path">;
    } = {},
  ) {
    this.#value = value === undefined ? undefined : fabricValueOf(value);
    this.#readonly = options.readonly ?? false;
    this.#identity = options.identity;
  }

  /** The value the cell holds. */
  get value(): FabricValue | undefined {
    return this.#value;
  }

  /** Replaces the value, as another writer would, and notifies the guest. */
  set value(value: unknown) {
    this.#value = value === undefined ? undefined : fabricValueOf(value);
    for (const sink of [...this.#sinks]) sink();
  }

  /** Makes each later write by the guest fail with `error`. */
  failWrites(error: Error): void {
    this.#writeFailure = error;
  }

  /** Makes each later read the guest pulls fail with `error`. */
  failReads(error: Error): void {
    this.#readFailure = error;
  }

  /**
   * Holds back every read the guest pulls until the returned function is
   * called.
   */
  holdReads(): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#heldReads = promise;
    return () => {
      this.#heldReads = undefined;
      resolve();
    };
  }

  /** Resolves with the guest's next write through this cell. */
  nextWrite(): Promise<CellWrite> {
    return new Promise((resolve) => {
      const waiter = (write: CellWrite) => {
        this.#waiters.delete(waiter);
        resolve(write);
      };
      this.#waiters.add(waiter);
    });
  }

  /** The bridge resource that grants the guest this cell. */
  resource(): BridgeResource {
    return { kind: "cell", cell: this.#cell([]) };
  }

  #write(write: CellWrite, next: FabricValue): void {
    if (this.#writeFailure) throw this.#writeFailure;
    this.writes.push(write);
    this.value = next;
    for (const waiter of [...this.#waiters]) waiter(write);
    announceChange();
  }

  #cell(path: Path): BridgeCell {
    const get = () => valueAt(this.#value, path);
    const cell: BridgeCell = {
      get,
      pull: async () => {
        await this.#heldReads;
        if (this.#readFailure) throw this.#readFailure;
        return get();
      },
      sink: (listener) => {
        let heard = false;
        let last: FabricValue | undefined;
        const sink = () => {
          const value = get();
          if (heard && value === last) return;
          heard = true;
          last = value;
          listener(value);
        };
        this.#sinks.add(sink);
        sink();
        return () => this.#sinks.delete(sink);
      },
      key: (key) => this.#cell([...path, key]),
      resolve: () => {
        const resolved = this.#cell(path);
        return this.#identity
          ? { ...resolved, identity: { ...this.#identity, path: [...path] } }
          : resolved;
      },
    };
    if (this.#readonly) return cell;
    return {
      ...cell,
      set: (value) =>
        this.#write(
          { operation: "set", path, value },
          withValueAt(this.#value, path, value),
        ),
      push: (values) => {
        const current = get();
        if (!Array.isArray(current)) {
          throw new TypeError("push() requires an array value.");
        }
        this.#write(
          { operation: "push", path, value: [...values] },
          withValueAt(this.#value, path, [...current, ...values]),
        );
      },
      initialize: (value) => {
        const current = get();
        if (current !== undefined) return current;
        this.#write(
          { operation: "initialize", path, value },
          withValueAt(this.#value, path, value),
        );
        return value;
      },
    };
  }
}

//
// Presence
//

/** Why a presence room ended, as the guest hears it. */
export type PresenceFailureCode =
  | typeof IPC.BRIDGE_PRESENCE_DISCONNECTED
  | typeof IPC.BRIDGE_PRESENCE_REFUSED
  | typeof IPC.BRIDGE_PRESENCE_UNSUPPORTED;

/**
 * A presence room a test hands a guest. The test plays every other member:
 * it adds, updates and removes them, and ends the room. What the guest
 * publishes about itself is readable from {@link name} and {@link facets}.
 */
export class MemoryPresenceRoom {
  readonly #participants = new Map<string, BridgePresenceRecord>();
  readonly #listeners = new Set<(event: BridgePresenceRoomEvent) => void>();
  readonly #refusal: PresenceFailureCode | undefined;
  #ending: PresenceFailureCode = IPC.BRIDGE_PRESENCE_DISCONNECTED;
  #joins = 0;

  /** The display name the guest published. */
  name: string | undefined;

  /** The facets the guest published, by name. */
  readonly facets = new Map<string, FabricPlainObject>();

  /** Constructs a room, or one whose every join fails with `refusal`. */
  constructor(options: { refusal?: PresenceFailureCode } = {}) {
    this.#refusal = options.refusal;
  }

  /** How many times the guest has joined. */
  get joins(): number {
    return this.#joins;
  }

  /** Adds `participant`, or replaces its last record. */
  upsert(participant: BridgePresenceRecord): void {
    this.#participants.set(participant.participantId, participant);
    this.#emit({ kind: "upsert", participant });
  }

  /** Removes the participant `participantId`. */
  remove(participantId: string): void {
    this.#participants.delete(participantId);
    this.#emit({ kind: "remove", participantId });
  }

  /** Ends the room, telling the guest `code`. */
  fail(code: PresenceFailureCode): void {
    this.#ending = code;
    this.#emit({ kind: "failure", error: new Error(code) });
    this.#listeners.clear();
  }

  /** The bridge resource that grants the guest this room. */
  resource(): BridgeResource {
    return presenceResource({
      join: () => this.#join(),
      failure: () => ({
        code: this.#ending,
        message: `The presence room ended: ${this.#ending}.`,
      }),
    });
  }

  #emit(event: BridgePresenceRoomEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  #join(): Promise<BridgePresenceRoom> {
    this.#joins++;
    if (this.#refusal) {
      this.#ending = this.#refusal;
      return Promise.reject(new Error(this.#refusal));
    }
    const participantId = `guest-${this.#joins}`;
    const participants = this.#participants;
    return Promise.resolve({
      participantId,
      get participants() {
        return [...participants.values()];
      },
      setName: (name) => {
        this.name = name;
        announceChange();
      },
      setFacet: (facet, value) => {
        this.facets.set(facet, value);
        announceChange();
      },
      clearFacet: (facet) => {
        this.facets.delete(facet);
        announceChange();
      },
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
      leave: () => Promise.resolve(),
    });
  }
}

//
// SQLite
//

/** Returns `value`, a bind value a guest sent, as one SQLite takes. */
function sqliteValueOf(value: FabricValue): SQLInputValue {
  if (
    value === null || typeof value === "string" || typeof value === "number" ||
    typeof value === "bigint" || value instanceof Uint8Array
  ) {
    return value;
  }
  throw new TypeError(
    "A SQLite bind value is a string, number, bigint, byte array or null.",
  );
}

/** Returns the statement and bind values of a guest's SQLite operation. */
function sqliteOperation(input: FabricValue | undefined): {
  sql: string;
  positional: SQLInputValue[];
  named: Record<string, SQLInputValue>;
} {
  if (!isFabricPlainObject(input) || typeof input.sql !== "string") {
    throw new TypeError("A SQLite operation is an object with `sql` text.");
  }
  if (input.params !== undefined && input.namedParams !== undefined) {
    throw new TypeError(
      "A SQLite operation carries positional or named parameters, not both.",
    );
  }
  const named: Record<string, SQLInputValue> = {};
  for (
    const entry of Array.isArray(input.namedParams) ? input.namedParams : []
  ) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      throw new TypeError("A named SQLite parameter is a [name, value] pair.");
    }
    named[entry[0]] = sqliteValueOf(entry[1]);
  }
  return {
    sql: input.sql,
    positional: Array.isArray(input.params)
      ? input.params.map(sqliteValueOf)
      : [],
    named,
  };
}

/**
 * A SQLite database a test hands a guest, held in memory. The test seeds and
 * reads it through {@link database}; each statement the guest executes
 * tells every sink the guest holds that the database changed.
 */
export class MemorySqlite {
  /** The database itself. */
  readonly database = new DatabaseSync(":memory:");

  readonly #sinks = new Set<() => void>();
  #failure: Error | undefined;

  /** Makes each later query and statement of the guest fail with `error`. */
  failOperations(error: Error): void {
    this.#failure = error;
  }

  /** Tells the guest the database changed, as another writer would. */
  changed(): void {
    for (const sink of [...this.#sinks]) sink();
  }

  /** The bridge resource that grants the guest this database. */
  resource(): BridgeResource {
    return {
      kind: "sqlite",
      sink: (listener) => {
        const sink = () => listener(undefined);
        this.#sinks.add(sink);
        return () => this.#sinks.delete(sink);
      },
      methods: {
        query: (input) => {
          if (this.#failure) throw this.#failure;
          const { sql, positional, named } = sqliteOperation(input);
          const rows = this.database.prepare(sql).all(named, ...positional);
          return {
            rows: rows.map((row) =>
              Object.entries(row).map(([column, value]) => [
                column,
                fabricValueOf(value),
              ])
            ),
          };
        },
        exec: (input) => {
          if (this.#failure) throw this.#failure;
          const { sql, positional, named } = sqliteOperation(input);
          this.database.prepare(sql).run(named, ...positional);
          this.changed();
          announceChange();
          return undefined;
        },
      },
    };
  }
}

//
// Pages
//

/** Names a guest must not see as globals: they would stand for a frame. */
const FRAME_GLOBALS = new Set([
  "frames",
  "globalThis",
  "opener",
  "parent",
  "self",
  "top",
  "window",
]);

/**
 * Names Deno defines that the window's take the place of while a page is
 * open. The window stands for the global scope as it does in a frame, so a
 * listener the guest adds to the global scope hears what the document
 * dispatches.
 */
const WINDOW_GLOBALS = [
  "addEventListener",
  "dispatchEvent",
  "removeEventListener",
];

/**
 * Returns `event` as an instance of the document's own event classes, which
 * are the only ones it dispatches. Deno's event classes stay in place while a
 * page is open, since Deno's own message ports dispatch them, so an `Event`
 * or `CustomEvent` a guest or a test constructs is one of Deno's. Any other
 * class of Deno's carries fields a copy would lose, so it is refused.
 */
function documentEvent(event: unknown): DocumentEvent {
  if (event instanceof DocumentEvent) return event;
  if (!(event instanceof Event)) {
    throw new TypeError("Only an event can be dispatched.");
  }
  const init = {
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    composed: event.composed,
  };
  if (event.constructor !== Event && event.constructor !== CustomEvent) {
    throw new TypeError(
      `A ${event.constructor.name} cannot be dispatched on the document.`,
    );
  }
  return event instanceof CustomEvent
    ? new DocumentCustomEvent(event.type, { ...init, detail: event.detail })
    : new DocumentEvent(event.type, init);
}

/**
 * Returns the bridge message `event` carries, decoded from a copy: decoding
 * takes over the byte buffers in what it decodes, and the receiver the
 * message is for decodes it after this.
 */
function decodedCopy(event: MessageEvent): FabricValue {
  return fabricFromRealmValue(structuredClone(event.data));
}

/** Resolves once the event loop has run the tasks already queued. */
export function taskTurn(): Promise<void> {
  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve) => {
    port1.onmessage = () => {
      port1.close();
      port2.close();
      resolve();
    };
    port2.postMessage(undefined);
  });
}

/** Puts back what {@link patchProperty} replaced, last first. */
const patches: (() => void)[] = [];

/**
 * Replaces the property `name` of `target` with `descriptor` until the page
 * open now, or the next one opened, closes. A double that has to go on one of
 * the document's own classes, such as a canvas's drawing context, goes in
 * this way, since those classes are shared by every page.
 */
export function patchProperty(
  target: object,
  name: string,
  descriptor: PropertyDescriptor,
): void {
  const original = Object.getOwnPropertyDescriptor(target, name);
  patches.push(() => {
    if (original) Object.defineProperty(target, name, original);
    else Reflect.deleteProperty(target, name);
  });
  Object.defineProperty(target, name, { configurable: true, ...descriptor });
}

/**
 * A frame clock a test drives: it stands for `requestAnimationFrame` and
 * `cancelAnimationFrame`, and runs the frames asked for only when the test
 * says so, each a sixtieth of a second after the last.
 */
export class ManualFrames {
  #next = 0;
  #time = 0;
  readonly #callbacks = new Map<number, (time: number) => void>();

  readonly request = (callback: (time: number) => void): number => {
    this.#callbacks.set(++this.#next, callback);
    return this.#next;
  };

  readonly cancel = (id: number): void => {
    this.#callbacks.delete(id);
  };

  /** Whether a frame has been asked for and not yet run. */
  get pending(): boolean {
    return this.#callbacks.size > 0;
  }

  /** Runs the frames asked for so far. */
  run(): void {
    this.#time += 1000 / 60;
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback(this.#time);
  }
}

// Every event target of every document dispatches through this, the window
// included, so each hears an event of the document's own classes. A window
// binds its own copy of the method when it is constructed, so this is in
// place before any is.
const dispatch = DocumentEventTarget.prototype.dispatchEvent;
DocumentEventTarget.prototype.dispatchEvent = function (
  this: DocumentEventTarget,
  event: unknown,
) {
  const own = documentEvent(event);
  const result = Reflect.apply(dispatch, this, [own]) === true;
  if (own !== event && own.defaultPrevented && event instanceof Event) {
    event.preventDefault();
  }
  return result;
};

/** Calls `posted` after each message `port` posts. */
function watchPosts(port: MessagePort, posted: () => void): void {
  const post = port.postMessage;
  Object.defineProperty(port, "postMessage", {
    value: (...message: unknown[]) => {
      Reflect.apply(post, port, message);
      posted();
    },
  });
}

/**
 * One session of the bridge: a channel whose host end serves a guest the
 * page's resources. The traffic on it is counted at both ends of each
 * direction, with the requests whose answers the guest has yet to receive,
 * so a test can tell when none is in flight. A guest that disconnects closes
 * its end, and hears nothing after, its disconnection included.
 */
class BridgeSession {
  readonly #channel = new MessageChannel();
  readonly #host: FabricBridgeHost;
  #guestSent = 0;
  #hostReceived = 0;
  #hostSent = 0;
  #guestReceived = 0;
  #unanswered = 0;
  #guestClosed = false;

  constructor(resources: Record<string, BridgeResource>, moved: () => void) {
    const { port1: hostPort, port2: guestPort } = this.#channel;
    watchPosts(guestPort, () => {
      this.#guestSent++;
      moved();
    });
    watchPosts(hostPort, () => {
      this.#hostSent++;
      moved();
    });
    const close = guestPort.close;
    Object.defineProperty(guestPort, "close", {
      value: () => {
        this.#guestClosed = true;
        Reflect.apply(close, guestPort, []);
        moved();
      },
    });
    hostPort.addEventListener("message", (event) => {
      this.#hostReceived++;
      if (IPC.isBridgeRequest(decodedCopy(event))) this.#unanswered++;
      moved();
    });
    guestPort.addEventListener("message", (event) => {
      this.#guestReceived++;
      const message = decodedCopy(event);
      if (IPC.isBridgeHostMessage(message) && message.type === "response") {
        this.#unanswered--;
      }
      moved();
      // The guest's own listener runs after this one, so the next task is
      // where what it did with the message shows.
      void taskTurn().then(announceChange);
    });
    this.#host = new FabricBridgeHost(createFabricBridge(resources), hostPort);
  }

  /** The guest's end of the channel. */
  get guestPort(): MessagePort {
    return this.#channel.port2;
  }

  /** How many messages have been sent or received, at either end. */
  get traffic(): number {
    return this.#guestSent + this.#hostReceived + this.#hostSent +
      this.#guestReceived;
  }

  /** Whether no message is in flight and no answer is outstanding. */
  get quiet(): boolean {
    return this.#guestSent === this.#hostReceived &&
      (this.#guestClosed ||
        this.#hostSent === this.#guestReceived && this.#unanswered === 0);
  }

  /** Answers the flush marker carrying `nonce`, as the host's frame does. */
  acknowledgeFlush(nonce: string): void {
    this.#host.acknowledgeFlush(nonce);
  }

  /** Ends the session at both ends. */
  close(): void {
    this.#host.disconnect();
    this.#channel.port2.close();
  }
}

/** A guest loaded into a simulated document, with the host end of its bridge. */
export interface GuestPage {
  /**
   * Resolves once `condition` holds, checking it now, after each change to
   * the document, after each change the guest makes to a resource, after the
   * guest has handled each message the bridge sends it, and after each change
   * a test double announces with {@link announceChange}. It rejects with
   * whatever `condition` throws, and when the page closes first. A condition
   * on something none of those announce, such as a form control's value, is
   * checked only when one of them happens.
   */
  until(condition: () => boolean): Promise<void>;

  /**
   * Resolves once no bridge message is on its way in either direction, the
   * host has answered every request it was sent, and no message was sent
   * over a whole turn of the event loop since: what the guest asked for has
   * been answered, and what it did straight away with the answers is done.
   * A guest that has disconnected, or a closed page, is settled. A write the
   * guest makes only after other asynchronous work of its own, such as a
   * timer or a digest, is not bridge traffic until it is sent. A test checks
   * that the guest wrote nothing only after this.
   */
  settled(): Promise<void>;

  /** The errors the guest reported to its frame, in order. */
  readonly alarms: IPC.GuestError[];

  /**
   * Unloads the guest, and puts back each global the page replaced or added
   * besides the document's own.
   */
  close(): Promise<void>;
}

let pages = 0;

/** The names the document defines and Deno does not, as the pages install them. */
const documentGlobals = new Set<string>();

/**
 * Loads the guest module at `guest` into a document, and serves it
 * `resources` by name. The document is the file `html` names, or `html`
 * itself when it is a string of markup. `globals` are installed beside the
 * document's own: test doubles for what the simulated document lacks, such
 * as an audio engine. `setup` runs once the globals are installed and before
 * the guest loads, for a double that has to go on one of the document's own
 * classes with {@link patchProperty}. A test reads the guest's document
 * through the globals, so one page is open at a time.
 */
export async function openGuestPage(options: {
  guest: URL;
  html: URL | string;
  resources: Record<string, BridgeResource>;
  globals?: Record<string, unknown>;
  setup?: () => void;
}): Promise<GuestPage> {
  const window = new Window({ url: "https://guest.invalid/" });
  window.document.open();
  window.document.write(
    typeof options.html === "string"
      ? options.html
      : await Deno.readTextFile(options.html),
  );
  window.document.close();
  await window.happyDOM.waitUntilComplete();

  const define = (name: string, get: () => unknown) =>
    Object.defineProperty(globalThis, name, { configurable: true, get });
  for (const name of Object.getOwnPropertyNames(window)) {
    if (FRAME_GLOBALS.has(name)) continue;
    if (documentGlobals.has(name) || !(name in globalThis)) {
      define(name, () => Reflect.get(window, name));
      documentGlobals.add(name);
    }
  }
  // A frame's window is its global scope.
  if (!("window" in globalThis)) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
  // These are this page's alone, and go when it closes.
  const replaced = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, get = () => Reflect.get(window, name)) => {
    if (!replaced.has(name)) {
      replaced.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    define(name, get);
  };
  WINDOW_GLOBALS.forEach((name) => install(name));
  for (const [name, value] of Object.entries(options.globals ?? {})) {
    install(name, () => value);
  }

  // The guest's frame: a guest that connects once its document has loaded
  // asks it for a port to the bridge, and is offered a fresh session in
  // answer, as the host's frame offers one.
  const alarms: IPC.GuestError[] = [];
  const sessions: BridgeSession[] = [];
  let pageClosed = false;
  const trafficListeners = new Set<() => void>();
  const moved = () => {
    for (const listener of [...trafficListeners]) listener();
  };
  const traffic = () =>
    sessions.reduce((total, session) => total + session.traffic, 0);
  const quiet = () => pageClosed || sessions.every((session) => session.quiet);
  const nextTraffic = () =>
    new Promise<void>((resolve) => {
      const heard = () => {
        trafficListeners.delete(heard);
        resolve();
      };
      trafficListeners.add(heard);
    });
  const offerSession = () => {
    const session = new BridgeSession(options.resources, moved);
    sessions.push(session);
    window.dispatchEvent(
      new window.MessageEvent("message", { data: IPC.GUEST_PORT_ORDERED }),
    );
    const handoff = new window.MessageEvent("message", {
      data: IPC.GUEST_PORT_HANDOFF,
    });
    Object.defineProperty(handoff, "ports", { value: [session.guestPort] });
    window.dispatchEvent(handoff);
  };
  const frame = {
    postMessage: (message: unknown) => {
      if (IPC.isGuestPortRequest(message)) queueMicrotask(offerSession);
      if (IPC.isGuestFlush(message)) {
        for (const session of sessions) session.acknowledgeFlush(message.nonce);
      }
      if (IPC.isGuestAlarm(message)) {
        alarms.push(message.data);
        announceChange();
      }
    },
  };
  install("parent", () => frame);

  /** What ends each wait still pending on this page, once it closes. */
  const waits = new Set<() => void>();

  const page: GuestPage = {
    alarms,
    until: (condition) =>
      new Promise((resolve, reject) => {
        if (pageClosed) {
          reject(new Error("The page closed before the condition held."));
          return;
        }
        const observer = new MutationObserver(() => check());
        const stop = () => {
          observer.disconnect();
          changeListeners.delete(check);
          waits.delete(abandon);
        };
        const abandon = () => {
          stop();
          reject(new Error("The page closed before the condition held."));
        };
        waits.add(abandon);
        const check = () => {
          let held: boolean;
          try {
            held = condition();
          } catch (cause) {
            stop();
            reject(cause);
            return;
          }
          if (!held) return;
          stop();
          resolve();
        };
        changeListeners.add(check);
        observer.observe(document, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        check();
      }),
    settled: async () => {
      for (;;) {
        if (!quiet()) {
          await nextTraffic();
          continue;
        }
        const before = traffic();
        await taskTurn();
        if (quiet() && traffic() === before) return;
      }
    },
    close: async () => {
      pageClosed = true;
      moved();
      for (const abandon of [...waits]) abandon();
      dispatchEvent(new Event("pagehide"));
      // The document's globals stay until the next page replaces them, so
      // what the guest still has in flight after it unloads finds its
      // document, as it would in a frame.
      for (const [name, descriptor] of replaced) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      for (const session of sessions) session.close();
      await window.happyDOM.close();
      patches.splice(0).reverse().forEach((restore) => restore());
    },
  };

  const guest = new URL(options.guest);
  guest.searchParams.set("page", String(++pages));
  try {
    options.setup?.();
    await import(guest.href);
  } catch (cause) {
    const text = document.body?.textContent ?? "";
    await page.close();
    throw new GuestLoadError(cause, alarms, text);
  }
  return page;
}

/**
 * Thrown by {@link openGuestPage} for a guest whose module threw while it
 * loaded, carrying what the page held when it did: the guest's error as its
 * cause and its message, the alarms the guest raised, and the text of its
 * document.
 */
export class GuestLoadError extends Error {
  readonly #alarms: readonly IPC.GuestError[];
  readonly #text: string;

  constructor(
    cause: unknown,
    alarms: readonly IPC.GuestError[],
    text: string,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "GuestLoadError";
    this.#alarms = alarms;
    this.#text = text;
  }

  /** The errors the guest reported to its frame before it threw. */
  get alarms(): readonly IPC.GuestError[] {
    return this.#alarms;
  }

  /** The text of the guest's document when it threw. */
  get text(): string {
    return this.#text;
  }
}
