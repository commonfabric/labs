/**
 * The presence relay: the bounds a publication is held to, shared by the
 * server that refuses one and the client that declines to send one, and the
 * rooms the server keeps. A room lives under a space and holds one
 * membership per connection; it remembers each member's latest record and
 * nothing else, and forgets a member the moment their membership ends. The
 * relay validates the envelope of a record and bounds its size; it does not
 * read facet contents (04-protocol.md §4.13).
 */

import type { FabricValue } from "@commonfabric/api";
import {
  debugStr,
  hashStringOf,
  isFabricPlainObject,
} from "@commonfabric/data-model";

import {
  encodeMemoryBoundary,
  type PresenceFacets,
  type PresenceJoinResult,
  type PresencePublication,
  type PresenceRecord,
  type PresenceRemoveMessage,
  type PresenceUpsertMessage,
} from "../v2.ts";

/** Members one room admits; a join past it is refused. */
export const MAX_PRESENCE_ROOM_MEMBERS = 128;

/** Code points a display name may hold. */
export const MAX_PRESENCE_NAME_CODE_POINTS = 80;

/** UTF-8 bytes a display name may hold. */
export const MAX_PRESENCE_NAME_BYTES = 256;

/** Facets one record may hold. */
export const MAX_PRESENCE_FACETS = 8;

/** Bytes a publication — its name and facets, wire-encoded — may take. */
export const MAX_PRESENCE_PUBLICATION_BYTES = 8 * 1024;

const roomPattern = /^[A-Za-z0-9_-]{22,128}$/;
const facetNamePattern = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A presence request the relay refuses: a bound exceeded, a publish before a
 * join, a revision that does not advance. It names the request, never the
 * connection, and a server sends it back as the request's response error.
 */
export class PresenceError extends Error {
  override readonly name = "PresenceError";
}

/** Whether `room` is an acceptable opaque room identifier. */
export const isPresenceRoom = (room: unknown): room is string =>
  typeof room === "string" && roomPattern.test(room);

/**
 * The resolved field a room is derived from: the pinned document, on its
 * branch, in the scope instance the session resolves, at one path.
 */
export type PresenceRoomField = {
  space: string;
  branch: string;
  id: string;
  scopeKey: string;
  path: readonly string[];
};

/**
 * Derives the room every client of one resolved field meets in. Aliases and
 * direct handles to the same field hash alike; different scope instances of
 * a user- or session-scoped field hash apart. The hash is a rendezvous key,
 * not authorization: the session's space access is what admits a member.
 */
export const presenceRoomForField = (field: PresenceRoomField): string =>
  hashStringOf({
    namespace: "memory-presence-room",
    version: 1,
    space: field.space,
    branch: field.branch,
    id: field.id,
    scopeKey: field.scopeKey,
    path: [...field.path],
  });

const hasInvalidNameCodePoint = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff);
  });

/**
 * Reads a decoded facets position as a facets map — a plain object whose
 * every value is a plain object, under names the relay accepts — or returns
 * `null` for any other shape. The name check here is what keeps a key such
 * as `__proto__` from reaching the assignment; the other bounds are the
 * validator's business.
 */
export const parsePresenceFacets = (
  value: FabricValue,
): PresenceFacets | null => {
  if (!isFabricPlainObject(value)) return null;
  const facets: PresenceFacets = {};
  for (const [facetName, facet] of Object.entries(value)) {
    if (!facetNamePattern.test(facetName)) return null;
    if (!isFabricPlainObject(facet)) return null;
    facets[facetName] = facet;
  }
  return facets;
};

/**
 * Holds a publication to the relay's bounds and returns it, or throws a
 * `PresenceError` naming the first bound it fails. Facet contents are not
 * read.
 */
export const validatePresencePublication = (
  publication: PresencePublication,
): PresencePublication => {
  const { name, facets } = publication;
  if (
    name.trim().length === 0 || hasInvalidNameCodePoint(name) ||
    [...name].length > MAX_PRESENCE_NAME_CODE_POINTS ||
    new TextEncoder().encode(name).length > MAX_PRESENCE_NAME_BYTES
  ) {
    throw new PresenceError("Presence name is empty, too long, or unprintable");
  }
  const facetNames = Object.keys(facets);
  if (facetNames.length > MAX_PRESENCE_FACETS) {
    throw new PresenceError(
      `Presence record holds more than ${MAX_PRESENCE_FACETS} facets`,
    );
  }
  for (const facetName of facetNames) {
    if (!facetNamePattern.test(facetName)) {
      throw new PresenceError(
        debugStr`Presence facet name is invalid: $quote${facetName}`,
      );
    }
  }
  const encoded = encodeMemoryBoundary({ name, facets });
  if (
    new TextEncoder().encode(encoded).length > MAX_PRESENCE_PUBLICATION_BYTES
  ) {
    throw new PresenceError(
      `Presence record exceeds ${MAX_PRESENCE_PUBLICATION_BYTES} bytes`,
    );
  }
  return publication;
};

/** What the relay sends a member: the pushes, addressed to that member. */
export type PresenceSend = (
  message: PresenceUpsertMessage | PresenceRemoveMessage,
) => void;

/** One connection's place in one room. */
type Member = {
  participantId: string;
  connectionId: string;
  sessionId: string;
  principal: string | undefined;

  /** Last accepted revision; `0` until the member publishes. */
  revision: number;

  /** Latest accepted publication, or `null` until the member publishes. */
  publication: PresencePublication | null;

  send: PresenceSend;
};

const roomKey = (space: string, room: string): string => `${space}\0${room}`;

const recordOf = (member: Member): PresenceRecord | null =>
  member.publication === null ? null : {
    participantId: member.participantId,
    ...(member.principal === undefined ? {} : { principal: member.principal }),
    revision: member.revision,
    name: member.publication.name,
    facets: member.publication.facets,
  };

/**
 * The rooms one server relays. Membership is keyed by connection, so a
 * connection is in a room at most once, and every push a member receives is
 * addressed to the session it joined through. Nothing here is durable, and
 * nothing here reads facet contents.
 */
export class PresenceRooms {
  #rooms = new Map<string, Map<string, Member>>();

  /** The room keys each connection is a member of. */
  #roomsByConnection = new Map<string, Set<string>>();

  /**
   * Adds the connection to the room, or refreshes its membership if it is
   * already there, and returns its participant id with the latest record of
   * every other member that has published. Throws a `PresenceError` when the
   * room is full, or when the connection already holds the membership through
   * another session: a membership belongs to the session that opened it.
   */
  join(input: {
    space: string;
    room: string;
    connectionId: string;
    sessionId: string;
    principal: string | undefined;
    send: PresenceSend;
  }): PresenceJoinResult {
    const key = roomKey(input.space, input.room);
    let room = this.#rooms.get(key);
    if (room === undefined) {
      room = new Map();
      this.#rooms.set(key, room);
    }
    let member = room.get(input.connectionId);
    if (member === undefined) {
      if (room.size >= MAX_PRESENCE_ROOM_MEMBERS) {
        throw new PresenceError("Presence room is full");
      }
      member = {
        participantId: crypto.randomUUID(),
        connectionId: input.connectionId,
        sessionId: input.sessionId,
        principal: input.principal,
        revision: 0,
        publication: null,
        send: input.send,
      };
      room.set(input.connectionId, member);
      let keys = this.#roomsByConnection.get(input.connectionId);
      if (keys === undefined) {
        keys = new Set();
        this.#roomsByConnection.set(input.connectionId, keys);
      }
      keys.add(key);
    } else {
      if (member.sessionId !== input.sessionId) {
        throw new PresenceError(
          "Presence room is joined by another session on this connection",
        );
      }
      member.principal = input.principal;
      member.send = input.send;
    }
    const participants: PresenceRecord[] = [];
    for (const other of room.values()) {
      if (other === member) continue;
      const record = recordOf(other);
      if (record !== null) participants.push(record);
    }
    return { participantId: member.participantId, participants };
  }

  /**
   * Replaces the connection's record in the room and pushes it to every
   * other member. Throws a `PresenceError` when the connection is not a
   * member through `sessionId`, when `revision` does not exceed the last
   * accepted one, or when the publication fails a bound.
   */
  publish(input: {
    space: string;
    room: string;
    connectionId: string;
    sessionId: string;
    revision: number;
    name: string;
    facets: PresenceFacets;
  }): void {
    const room = this.#rooms.get(roomKey(input.space, input.room));
    const member = this.#memberOf(room, input.connectionId, input.sessionId);
    if (room === undefined) return;
    if (
      !Number.isSafeInteger(input.revision) || input.revision <= member.revision
    ) {
      throw new PresenceError("Presence revision does not advance");
    }
    const publication = validatePresencePublication(input);
    member.revision = input.revision;
    member.publication = publication;
    const participant = recordOf(member)!;
    for (const other of room.values()) {
      if (other === member) continue;
      other.send({
        type: "presence/upsert",
        space: input.space,
        sessionId: other.sessionId,
        room: input.room,
        participant,
      });
    }
  }

  /**
   * Ends the connection's membership in the room, if it has one. Throws a
   * `PresenceError` when the membership belongs to another session.
   */
  leave(
    space: string,
    room: string,
    connectionId: string,
    sessionId: string,
  ): void {
    const key = roomKey(space, room);
    const room_ = this.#rooms.get(key);
    if (room_?.get(connectionId) === undefined) return;
    this.#memberOf(room_, connectionId, sessionId);
    this.#end(key, connectionId);
  }

  /** Ends every membership the connection holds. */
  leaveConnection(connectionId: string): void {
    const keys = this.#roomsByConnection.get(connectionId);
    if (keys === undefined) return;
    for (const key of [...keys]) this.#end(key, connectionId);
  }

  /** Ends every membership the connection joined through the session. */
  leaveSession(space: string, sessionId: string, connectionId: string): void {
    const keys = this.#roomsByConnection.get(connectionId);
    if (keys === undefined) return;
    for (const key of [...keys]) {
      const member = this.#rooms.get(key)?.get(connectionId);
      if (
        member !== undefined && member.sessionId === sessionId &&
        key.startsWith(`${space}\0`)
      ) {
        this.#end(key, connectionId);
      }
    }
  }

  /** How many connections are in the room; `0` for a room nobody is in. */
  memberCount(space: string, room: string): number {
    return this.#rooms.get(roomKey(space, room))?.size ?? 0;
  }

  /**
   * The connection's membership in `room` through `sessionId`, or a
   * `PresenceError` when there is none or it is another session's.
   */
  #memberOf(
    room: Map<string, Member> | undefined,
    connectionId: string,
    sessionId: string,
  ): Member {
    const member = room?.get(connectionId);
    if (member === undefined) {
      throw new PresenceError("Presence room is not joined");
    }
    if (member.sessionId !== sessionId) {
      throw new PresenceError(
        "Presence room is joined by another session on this connection",
      );
    }
    return member;
  }

  #end(key: string, connectionId: string): void {
    const room = this.#rooms.get(key);
    const member = room?.get(connectionId);
    if (room === undefined || member === undefined) return;
    room.delete(connectionId);
    const keys = this.#roomsByConnection.get(connectionId);
    keys?.delete(key);
    if (keys?.size === 0) this.#roomsByConnection.delete(connectionId);
    if (room.size === 0) {
      this.#rooms.delete(key);
      return;
    }
    // A member that never published was never announced, so there is
    // nothing for the others to remove.
    if (member.publication === null) return;
    const separator = key.indexOf("\0");
    const space = key.slice(0, separator);
    const roomId = key.slice(separator + 1);
    for (const other of room.values()) {
      other.send({
        type: "presence/remove",
        space,
        sessionId: other.sessionId,
        room: roomId,
        participantId: member.participantId,
      });
    }
  }
}
