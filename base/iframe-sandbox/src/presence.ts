/**
 * Grants a guest one presence room as a bridge resource. The guest is in the
 * room while a sink of the resource is open, hears the room through that
 * sink, and publishes its own record through the resource's methods. The
 * host joins the room; this module knows nothing of where rooms come from.
 */

import {
  type FabricPlainObject,
  type FabricValue,
  isFabricPlainObject,
} from "@commonfabric/data-model";

import type {
  BridgeCancel,
  BridgeResource,
  BridgeSinkFailure,
} from "./bridge.ts";
import type {
  BridgeError,
  BridgePresenceEvent,
  BridgePresenceParticipant,
} from "./ipc.ts";

/** One member's latest record, as a host's room holds it. */
export type BridgePresenceRecord = {
  /** Id of the member's membership in the room. */
  readonly participantId: string;

  /** Display name the member published. */
  readonly name: string;

  /** What the member published, by facet name. */
  readonly facets: Readonly<Record<string, FabricPlainObject>>;
};

/** What a host's room tells whoever holds it. */
export type BridgePresenceRoomEvent =
  /** The room as it stands, on each rejoin. */
  | {
    readonly kind: "snapshot";
    readonly participantId: string;
    readonly participants: readonly BridgePresenceRecord[];
  }
  /** A member's first record, or the one replacing its last. */
  | { readonly kind: "upsert"; readonly participant: BridgePresenceRecord }
  /** A member gone. */
  | { readonly kind: "remove"; readonly participantId: string }
  /** The room's end. Nothing follows it. */
  | { readonly kind: "failure"; readonly error: Error };

/** A host's hold on one joined presence room. */
export type BridgePresenceRoom = {
  /** Id of this hold's membership in the room. */
  readonly participantId: string;

  /** Every other member that has published, at its latest record. */
  readonly participants: readonly BridgePresenceRecord[];

  /** Sets the display name this membership publishes. */
  setName(name: string): void;

  /** Sets one facet of this membership's record. */
  setFacet(facet: string, value: FabricPlainObject): void;

  /** Removes one facet of this membership's record. */
  clearFacet(facet: string): void;

  /** Listens for the room's events until the returned function is called. */
  subscribe(listener: (event: BridgePresenceRoomEvent) => void): () => void;

  /** Releases this hold on the room. */
  leave(): Promise<void>;
};

/** What a host supplies to grant a guest one presence room. */
export type BridgePresenceGrant = {
  /** Joins the room on the guest's behalf. */
  join(): Promise<BridgePresenceRoom>;

  /**
   * Returns what the guest is told of `cause`, a rejected join or the error
   * of a room's `failure`. The host decides how much of the cause a guest may
   * read.
   */
  failure(cause: unknown): BridgeError;
};

/** One open sink of a presence resource. */
type PresenceSink = {
  /** Hears each of the room's events. */
  readonly listener: (value: FabricValue | undefined) => void;

  /** Hears the room's failure. */
  readonly failed: BridgeSinkFailure;
};

/**
 * Returns what a guest is told of `record`: its id, name, and facets, and
 * nothing else a host's room may hold beside them.
 */
function participantOf(
  record: BridgePresenceRecord,
): BridgePresenceParticipant {
  return {
    participantId: record.participantId,
    name: record.name,
    facets: { ...record.facets },
  };
}

function snapshotOf(room: {
  readonly participantId: string;
  readonly participants: readonly BridgePresenceRecord[];
}): BridgePresenceEvent {
  return {
    kind: "snapshot",
    participantId: room.participantId,
    participants: room.participants.map(participantOf),
  };
}

function facetName(input: FabricValue | undefined): string {
  if (typeof input !== "string") {
    throw new TypeError("A presence facet is named by a string.");
  }
  return input;
}

/**
 * One guest's membership in a room, from the first sink that opens to the
 * last that closes. It joins at once, and holds what the guest publishes
 * until the join settles.
 */
class Membership {
  readonly #grant: BridgePresenceGrant;
  readonly #sinks = new Set<PresenceSink>();

  /** Facets published ahead of the join, which takes them once it settles. */
  readonly #facets = new Map<string, FabricPlainObject>();

  /** Name published ahead of the join, or `undefined` when none was. */
  #name: string | undefined;

  #room: BridgePresenceRoom | undefined;
  #unsubscribe: (() => void) | undefined;

  /** What ended the room, told to every sink open then and opened since. */
  #failure: BridgeError | undefined;

  #left = false;

  /** Constructs an instance which joins `grant`'s room. */
  constructor(grant: BridgePresenceGrant) {
    this.#grant = grant;
    grant.join().then(
      (room) => this.#joined(room),
      (cause) => this.#fail(cause),
    );
  }

  /** Whether no sink is open. */
  get unused(): boolean {
    return this.#sinks.size === 0;
  }

  /** Opens `sink`, telling it at once of the room as it stands. */
  open(sink: PresenceSink): void {
    this.#sinks.add(sink);
    if (this.#failure !== undefined) sink.failed(this.#failure);
    else if (this.#room !== undefined) sink.listener(snapshotOf(this.#room));
  }

  /** Closes `sink`. */
  close(sink: PresenceSink): void {
    this.#sinks.delete(sink);
  }

  /** Leaves the room, or the join once it settles. */
  leave(): void {
    this.#left = true;
    this.#release();
  }

  /** Sets the display name the guest publishes. */
  setName(name: string): void {
    this.#requireLive();
    if (this.#room !== undefined) this.#room.setName(name);
    else this.#name = name;
  }

  /** Sets one facet of the guest's record. */
  setFacet(facet: string, value: FabricPlainObject): void {
    this.#requireLive();
    if (this.#room !== undefined) this.#room.setFacet(facet, value);
    else this.#facets.set(facet, value);
  }

  /** Removes one facet of the guest's record. */
  clearFacet(facet: string): void {
    this.#requireLive();
    if (this.#room !== undefined) this.#room.clearFacet(facet);
    else this.#facets.delete(facet);
  }

  /** Helper for the publishing methods, which throws once the room ended. */
  #requireLive(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }

  #joined(room: BridgePresenceRoom): void {
    if (this.#left) {
      void room.leave();
      return;
    }
    this.#room = room;
    this.#unsubscribe = room.subscribe((event) => this.#receive(event));
    if (this.#name !== undefined) room.setName(this.#name);
    for (const [facet, value] of this.#facets) room.setFacet(facet, value);
    this.#facets.clear();
    this.#tell(snapshotOf(room));
  }

  #receive(event: BridgePresenceRoomEvent): void {
    switch (event.kind) {
      case "snapshot":
        this.#tell(snapshotOf(event));
        return;
      case "upsert":
        this.#tell({
          kind: "upsert",
          participant: participantOf(event.participant),
        });
        return;
      case "remove":
        this.#tell({ kind: "remove", participantId: event.participantId });
        return;
      case "failure":
        this.#fail(event.error);
    }
  }

  #tell(event: BridgePresenceEvent): void {
    for (const sink of [...this.#sinks]) sink.listener(event);
  }

  #fail(cause: unknown): void {
    if (this.#left || this.#failure !== undefined) return;
    this.#failure = this.#grant.failure(cause);
    this.#release();
    for (const sink of [...this.#sinks]) sink.failed(this.#failure);
  }

  /** Helper for the methods that end the membership, which drops the room. */
  #release(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const room = this.#room;
    this.#room = undefined;
    void room?.leave();
  }
}

/**
 * Builds the `presence` resource that grants a guest `grant`'s room. The
 * guest joins by opening the resource's sink, which delivers a
 * `BridgePresenceEvent` for the room as it stands and for each change after,
 * and leaves by closing it. The `setName`, `setFacet`, and `clearFacet`
 * methods publish the guest's own record, and reject while no sink is open.
 * A rejected join, or the room's failure, fails every open sink with what
 * `grant.failure()` returns; closing the sinks and opening one joins again.
 */
export function presenceResource(
  grant: BridgePresenceGrant,
  metadata: { schema?: FabricValue; description?: string } = {},
): BridgeResource {
  let membership: Membership | undefined;
  const joined = (): Membership => {
    if (membership === undefined) {
      throw new Error(
        "The presence room is not joined: open its sink before publishing.",
      );
    }
    return membership;
  };
  return {
    kind: "presence",
    ...(metadata.schema !== undefined && { schema: metadata.schema }),
    ...(metadata.description !== undefined && {
      description: metadata.description,
    }),
    sink: (listener, failed): BridgeCancel => {
      const sink: PresenceSink = { listener, failed };
      const held = membership ??= new Membership(grant);
      held.open(sink);
      return () => {
        held.close(sink);
        if (!held.unused) return;
        held.leave();
        if (membership === held) membership = undefined;
      };
    },
    methods: {
      setName: (input) => {
        if (typeof input !== "string") {
          throw new TypeError("A presence name is a string.");
        }
        joined().setName(input);
        return undefined;
      },
      setFacet: (input) => {
        if (!isFabricPlainObject(input)) {
          throw new TypeError(
            "`setFacet` takes an object with `facet` and `value` fields.",
          );
        }
        const value = input.value;
        if (!isFabricPlainObject(value)) {
          throw new TypeError("A presence facet's value is a plain object.");
        }
        joined().setFacet(facetName(input.facet), value);
        return undefined;
      },
      clearFacet: (input) => {
        joined().clearFacet(facetName(input));
        return undefined;
      },
    },
  };
}
