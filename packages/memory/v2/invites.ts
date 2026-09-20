/** Private invitation records share the space engine's ACL transaction. */
import { isDIDKey } from "@commonfabric/identity/did";
import {
  type ACL,
  aclDocId,
  hasConcreteOwner,
  isACL,
  isCapable,
} from "../acl.ts";
import {
  type CreateInvite,
  inviteCodeVerifier,
  type InviteMetadata,
  type InviteRedemption,
  isInviteId,
  isInviteSecret,
  type RedeemReceipt,
  SPACE_INVITE_CAPABILITY,
  SpaceInviteError,
} from "../space-invites.ts";
import {
  type AppliedCommit,
  type Engine,
  read,
  runAtomicCommit,
  serverSeq,
} from "./engine.ts";

/** Typed operations admitted only through the authenticated service boundary. */
export type InviteOperation =
  | { operation: "create"; body: CreateInvite }
  | { operation: "redeem"; body: { inviteId: string; code: string } }
  | { operation: "revoke"; body: { inviteId: string } }
  | { operation: "list"; body: Record<string, never> }
  | { operation: "receipts"; body: { inviteId?: string } };

/** Common envelope, supplied by the server rather than by the request body. */
export type InviteRequest = InviteOperation & {
  host: string;
  space: string;
  principal: string;
  now: number | (() => number);
  /** Effective access only; invitation administration requires explicit OWNER. */
  implicitOwner?: boolean;
};

/** Result and optional durable ACL commit for server publication. */
export interface InviteResult {
  result:
    | InviteMetadata
    | InviteMetadata[]
    | InviteRedemption[]
    | RedeemReceipt
    | { revoked: true };
  commit?: AppliedCommit;
}

interface ActiveRow {
  inviteId: string;
  codeVerifier: string;
  issuedBy: string;
  createdAt: number;
  expiresAt: number;
  access: "READ" | "WRITE";
  maxUses: number;
  ttlSeconds: number;
}

// CF1 permits at most 300 seconds of lifetime and 60 seconds of future skew.
// One extra second covers its integer-second freshness comparison boundary.
const CREATE_REPLAY_WINDOW_MS = 361_000;
// REAL retains safe-integer epoch milliseconds with the driver's default
// numeric decoding, whose INTEGER reads are otherwise limited to 32 bits.
const TABLES = `
CREATE TABLE IF NOT EXISTS space_invites (
  inviteId TEXT PRIMARY KEY, codeVerifier TEXT NOT NULL, issuedBy TEXT NOT NULL,
  createdAt REAL NOT NULL, expiresAt REAL NOT NULL, access TEXT NOT NULL,
  maxUses INTEGER NOT NULL, ttlSeconds INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS space_invite_redemptions (
  inviteId TEXT NOT NULL, did TEXT NOT NULL, PRIMARY KEY(inviteId,did)
);
CREATE TABLE IF NOT EXISTS space_invite_rejections (
  inviteId TEXT PRIMARY KEY, rejectUntil REAL NOT NULL
);`;

/** Applies admission, receipts, and any ACL grant in one durable transaction. */
export function executeInvite(
  engine: Engine,
  request: InviteRequest,
): InviteResult {
  const outcome = runAtomicCommit(engine, (apply) => {
    const db = engine.database;
    db.exec(TABLES);
    const { space, principal } = request;
    const now = typeof request.now === "function" ? request.now() : request.now;
    if (
      !Number.isSafeInteger(now) || now < 0 || !isDIDKey(principal) ||
      !isDIDKey(space)
    ) {
      throw new SpaceInviteError("invalid-request");
    }
    const remove = (inviteId: string) => {
      db.prepare("DELETE FROM space_invites WHERE inviteId = ?").run(inviteId);
      if (usedCount(inviteId) === 0) {
        db.prepare(
          "INSERT INTO space_invite_rejections VALUES (?, ?) ON CONFLICT(inviteId) DO UPDATE SET rejectUntil = max(rejectUntil, excluded.rejectUntil)",
        ).run(inviteId, now + CREATE_REPLAY_WINDOW_MS);
      }
    };
    const usedCount = (inviteId: string) =>
      db.prepare(
        "SELECT count(*) AS count FROM space_invite_redemptions WHERE inviteId = ?",
      ).get<{ count: number }>(inviteId)!.count;
    const metadata = (row: ActiveRow): InviteMetadata => {
      const count = usedCount(row.inviteId);
      return {
        inviteId: row.inviteId,
        issuedBy: row.issuedBy,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        access: row.access,
        maxUses: row.maxUses,
        usedCount: count,
        remainingUses: row.maxUses - count,
      };
    };
    // Cleanup is committed even when admission is refused. Refusals therefore
    // leave the callback as values and are thrown after the transaction ends.
    db.prepare("DELETE FROM space_invite_rejections WHERE rejectUntil < ?").run(
      now,
    );
    for (
      const row of db.prepare(
        "SELECT inviteId FROM space_invites WHERE expiresAt <= ?",
      ).all<{ inviteId: string }>(now)
    ) remove(row.inviteId);
    const value = read(engine, { id: aclDocId(space) })?.value;
    const acl: ACL | null = isACL(value) && hasConcreteOwner(value)
      ? value
      : null;
    const capability = () =>
      request.implicitOwner || principal === space
        ? "OWNER" as const
        : acl === null
        ? null
        : acl[principal as keyof ACL] ?? acl["*"] ?? null;
    const failure = (code: string) => ({ failure: code } as const);
    if (request.operation === "redeem") {
      const { inviteId, code } = request.body;
      if (!isInviteId(inviteId) || !isInviteSecret(code)) {
        return failure("invalid-request");
      }
      const redemption = { inviteId, did: principal };
      const receipt = db.prepare(
        "SELECT did FROM space_invite_redemptions WHERE inviteId = ? AND did = ?",
      ).get(inviteId, principal);
      if (receipt) {
        return {
          result: {
            outcome: "already-redeemed",
            redemption,
            currentAccess: capability(),
          } satisfies RedeemReceipt,
        };
      }
      const row = db.prepare("SELECT * FROM space_invites WHERE inviteId = ?")
        .get<ActiveRow>(inviteId);
      if (!row) return failure("invite-unavailable");
      if (!acl || acl[row.issuedBy as keyof ACL] !== "OWNER") {
        remove(inviteId);
        return failure("invite-unavailable");
      }
      if (
        row.codeVerifier !==
          inviteCodeVerifier({ host: request.host, space, inviteId, code }) ||
        usedCount(inviteId) >= row.maxUses
      ) return failure("invite-unavailable");
      const current = capability();
      let commit: AppliedCommit | undefined;
      if (current === null || !isCapable(current, row.access)) {
        const updated = { ...acl, [principal]: row.access };
        commit = apply({
          sessionId: "invite-service",
          space,
          principal,
          commitClass: "system",
          commit: {
            localSeq: serverSeq(engine) + 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: aclDocId(space),
              value: { value: updated },
            }],
          },
        });
      }
      db.prepare("INSERT INTO space_invite_redemptions VALUES (?, ?)").run(
        inviteId,
        principal,
      );
      if (usedCount(inviteId) === row.maxUses) remove(inviteId);
      return {
        result: {
          outcome: "redeemed",
          redemption,
          currentAccess: current !== null && isCapable(current, row.access)
            ? current
            : row.access,
        } satisfies RedeemReceipt,
        ...(commit ? { commit } : {}),
      };
    }
    if (!acl || acl[principal as keyof ACL] !== "OWNER") {
      return failure("not-owner");
    }
    switch (request.operation) {
      case "create": {
        const body = request.body;
        const maxUses = body.maxUses ?? 1;
        if (
          !isInviteId(body.inviteId) || !isInviteSecret(body.codeVerifier) ||
          !["READ", "WRITE"].includes(body.access) ||
          !Number.isSafeInteger(maxUses) || maxUses < 1 ||
          maxUses > SPACE_INVITE_CAPABILITY.maxUses ||
          !Number.isSafeInteger(body.ttlSeconds) || body.ttlSeconds < 1 ||
          body.ttlSeconds > SPACE_INVITE_CAPABILITY.maxTtlSeconds
        ) return failure("invalid-request");
        const existing = db.prepare(
          "SELECT * FROM space_invites WHERE inviteId = ?",
        ).get<ActiveRow>(body.inviteId);
        if (existing) {
          if (
            existing.issuedBy !== principal ||
            existing.codeVerifier !== body.codeVerifier ||
            existing.access !== body.access || existing.maxUses !== maxUses ||
            existing.ttlSeconds !== body.ttlSeconds
          ) return failure("invite-id-unavailable");
          return { result: metadata(existing) };
        }
        if (
          usedCount(body.inviteId) ||
          db.prepare(
            "SELECT inviteId FROM space_invite_rejections WHERE inviteId = ?",
          ).get(body.inviteId)
        ) return failure("invite-id-unavailable");
        const row: ActiveRow = {
          ...body,
          maxUses,
          issuedBy: principal,
          createdAt: now,
          expiresAt: now + body.ttlSeconds * 1000,
        };
        db.prepare("INSERT INTO space_invites VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(
            row.inviteId,
            row.codeVerifier,
            row.issuedBy,
            row.createdAt,
            row.expiresAt,
            row.access,
            row.maxUses,
            row.ttlSeconds,
          );
        return { result: metadata(row) };
      }
      case "list":
        return {
          result: db.prepare("SELECT * FROM space_invites ORDER BY inviteId")
            .all<ActiveRow>().map(metadata),
        };
      case "receipts": {
        const id = request.body.inviteId;
        if (id !== undefined && !isInviteId(id)) {
          return failure("invalid-request");
        }
        return {
          result: id === undefined
            ? db.prepare(
              "SELECT inviteId, did FROM space_invite_redemptions ORDER BY inviteId,did",
            ).all<InviteRedemption>()
            : db.prepare(
              "SELECT inviteId, did FROM space_invite_redemptions WHERE inviteId = ? ORDER BY did",
            ).all<InviteRedemption>(id),
        };
      }
      case "revoke": {
        if (!isInviteId(request.body.inviteId)) {
          return failure("invalid-request");
        }
        remove(request.body.inviteId);
        return { result: { revoked: true } as const };
      }
    }
  }, { durable: true });
  if ("failure" in outcome) throw new SpaceInviteError(outcome.failure);
  return outcome;
}
