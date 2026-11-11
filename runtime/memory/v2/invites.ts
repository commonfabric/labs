/** Private invitation records share the space engine's ACL transaction. */
import { isDIDKey } from "@commonfabric/identity/did";
import { isPlainObject } from "@commonfabric/js-values/types";
import {
  type ACL,
  aclDocId,
  hasConcreteOwner,
  isACL,
  isCapable,
  isDeletionTombstone,
} from "../acl.ts";
import {
  type CreateInvite,
  type InviteAccess,
  inviteCodeVerifier,
  type InviteMetadata,
  type InvitePreview,
  type InviteProfileSuggestion,
  type InviteRedemption,
  isInviteAccess,
  isInviteId,
  isInvitePreviewName,
  isInviteProfileSuggestion,
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
  | { operation: "preview"; body: { inviteId: string; code: string } }
  | { operation: "revoke"; body: { inviteId: string } }
  | { operation: "list"; body: Record<string, never> }
  | { operation: "receipts"; body: { inviteId?: string } };

/**
 * Returns the invitation operation a wire message names, or `null` when
 * `operation` names none or `body` is not that operation's shape: a record
 * holding exactly the operation's fields, each of its type. The values
 * themselves — an identifier's form, a lifetime's range — are
 * `executeInvite()`'s to judge.
 */
export function parseInviteOperation(
  operation: unknown,
  body: unknown,
): InviteOperation | null {
  if (!isPlainObject(body)) return null;
  const keys = Object.keys(body);
  const only = (...allowed: string[]) =>
    keys.every((key) => allowed.includes(key));
  switch (operation) {
    case "create": {
      const {
        inviteId,
        codeVerifier,
        access,
        ttlSeconds,
        maxUses,
        suggestedProfile,
        spaceName,
        issuerName,
      } = body;
      if (
        !only(
          "inviteId",
          "codeVerifier",
          "access",
          "ttlSeconds",
          "maxUses",
          "suggestedProfile",
          "spaceName",
          "issuerName",
        ) ||
        typeof inviteId !== "string" || typeof codeVerifier !== "string" ||
        !isInviteAccess(access) || typeof ttlSeconds !== "number" ||
        (maxUses !== undefined && typeof maxUses !== "number") ||
        (suggestedProfile !== undefined &&
          !isSuggestionShape(suggestedProfile)) ||
        (spaceName !== undefined && typeof spaceName !== "string") ||
        (issuerName !== undefined && typeof issuerName !== "string")
      ) return null;
      return {
        operation,
        body: {
          inviteId,
          codeVerifier,
          access,
          ttlSeconds,
          ...(maxUses === undefined ? {} : { maxUses }),
          ...(suggestedProfile === undefined ? {} : { suggestedProfile }),
          ...(spaceName === undefined ? {} : { spaceName }),
          ...(issuerName === undefined ? {} : { issuerName }),
        },
      };
    }
    case "redeem":
    case "preview": {
      const { inviteId, code } = body;
      if (
        !only("inviteId", "code") || typeof inviteId !== "string" ||
        typeof code !== "string"
      ) return null;
      return { operation, body: { inviteId, code } };
    }
    case "revoke": {
      const { inviteId } = body;
      if (!only("inviteId") || typeof inviteId !== "string") return null;
      return { operation, body: { inviteId } };
    }
    case "list":
      return keys.length === 0 ? { operation, body: {} } : null;
    case "receipts": {
      const { inviteId } = body;
      if (
        !only("inviteId") ||
        (inviteId !== undefined && typeof inviteId !== "string")
      ) return null;
      return { operation, body: inviteId === undefined ? {} : { inviteId } };
    }
    default:
      return null;
  }
}

/**
 * Whether `value` has the fields of an `InviteProfileSuggestion`, each of its
 * type; its values are `executeInvite()`'s to judge.
 */
function isSuggestionShape(value: unknown): value is InviteProfileSuggestion {
  if (!isPlainObject(value)) return false;
  const { name, picture, ...rest } = value;
  return Object.keys(rest).length === 0 && typeof name === "string" &&
    (picture === undefined || typeof picture === "string");
}

/** Common envelope, supplied by the server rather than by the request body. */
export type InviteRequest = InviteOperation & {
  host: string;
  space: string;
  principal: string;
  now: number | (() => number);
  /** Whether the principal is a configured service DID, which holds OWNER on
   *  every space. Effective access only; invitation administration requires
   *  explicit OWNER. */
  implicitOwner?: boolean;
};

/** Result and optional durable ACL commit for server publication. */
export interface InviteResult {
  result:
    | InviteMetadata
    | InviteMetadata[]
    | InviteRedemption[]
    | RedeemReceipt
    | InvitePreview
    | { revoked: true };
  commit?: AppliedCommit;
}

interface ActiveRow {
  inviteId: string;
  codeVerifier: string;
  issuedBy: string;
  createdAt: number;
  expiresAt: number;
  access: InviteAccess;
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
);
CREATE TABLE IF NOT EXISTS space_invite_suggestions (
  inviteId TEXT PRIMARY KEY, issuedBy TEXT NOT NULL, name TEXT NOT NULL,
  picture TEXT, expiresAt REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS space_invite_previews (
  inviteId TEXT PRIMARY KEY, issuedBy TEXT NOT NULL, access TEXT NOT NULL,
  spaceName TEXT, issuerName TEXT, expiresAt REAL NOT NULL
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
    // No invitation operation acts on a deleted space, inside the transaction
    // it would run in, so a deletion another connection committed is seen
    // here too (INV-15).
    if (isDeletionTombstone(read(engine, { id: aclDocId(space) })?.value)) {
      throw new SpaceInviteError("space-deleted");
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
    // An invitation's suggested profile, and what its preview shows, outlive
    // the row's exhaustion, so a redeemer whose receipt was lost reads them
    // again on retry. They are forgotten when the invitation expires or is
    // revoked, and when the issuer they keep for this no longer owns the
    // space.
    const forgetSuggestion = (inviteId: string) => {
      db.prepare("DELETE FROM space_invite_suggestions WHERE inviteId = ?")
        .run(inviteId);
      db.prepare("DELETE FROM space_invite_previews WHERE inviteId = ?")
        .run(inviteId);
    };
    const previewNames = (inviteId: string) => {
      const row = db.prepare(
        "SELECT issuedBy, access, spaceName, issuerName FROM space_invite_previews WHERE inviteId = ?",
      ).get<{
        issuedBy: string;
        access: InviteAccess;
        spaceName: string | null;
        issuerName: string | null;
      }>(inviteId);
      return row === undefined ? undefined : {
        issuedBy: row.issuedBy,
        access: row.access,
        ...(row.spaceName === null ? {} : { spaceName: row.spaceName }),
        ...(row.issuerName === null ? {} : { issuerName: row.issuerName }),
      };
    };
    const suggestion = (inviteId: string) => {
      const row = db.prepare(
        "SELECT issuedBy, name, picture FROM space_invite_suggestions WHERE inviteId = ?",
      ).get<{ issuedBy: string; name: string; picture: string | null }>(
        inviteId,
      );
      return row === undefined ? undefined : {
        issuedBy: row.issuedBy,
        profile: {
          name: row.name,
          ...(row.picture === null ? {} : { picture: row.picture }),
        } satisfies InviteProfileSuggestion,
      };
    };
    const withSuggestion = (
      receipt: RedeemReceipt,
      acl: ACL | null,
    ): RedeemReceipt => {
      const { inviteId } = receipt.redemption;
      const held = suggestion(inviteId);
      if (held === undefined) return receipt;
      if (acl?.[held.issuedBy as keyof ACL] !== "OWNER") {
        forgetSuggestion(inviteId);
        return receipt;
      }
      return { ...receipt, suggestedProfile: held.profile };
    };
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
    db.prepare("DELETE FROM space_invite_suggestions WHERE expiresAt <= ?").run(
      now,
    );
    db.prepare("DELETE FROM space_invite_previews WHERE expiresAt <= ?").run(
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
      request.implicitOwner
        ? "OWNER" as const
        : acl === null
        ? null
        : acl[principal as keyof ACL] ?? acl["*"] ?? null;
    const failure = (code: string) => ({ failure: code } as const);
    if (request.operation === "preview") {
      // A preview reads; it consumes no use, grants nothing, and records no
      // receipt. Every reason it is refused gives the one refusal, so the
      // code is what learns whether an invitation exists. As on redemption,
      // an identity holding a receipt for the invitation needs no active
      // row, and its preview comes from what the service keeps beside it.
      const { inviteId, code } = request.body;
      if (!isInviteId(inviteId) || !isInviteSecret(code)) {
        return failure("invalid-request");
      }
      const redeemed = db.prepare(
        "SELECT did FROM space_invite_redemptions WHERE inviteId = ? AND did = ?",
      ).get(inviteId, principal) !== undefined;
      const row = db.prepare("SELECT * FROM space_invites WHERE inviteId = ?")
        .get<ActiveRow>(inviteId);
      if (
        !redeemed && (
          row === undefined ||
          row.codeVerifier !==
            inviteCodeVerifier({ host: request.host, space, inviteId, code }) ||
          usedCount(inviteId) >= row.maxUses
        )
      ) return failure("invite-unavailable");
      const names = previewNames(inviteId);
      const issuedBy = row?.issuedBy ?? names?.issuedBy;
      const access = row?.access ?? names?.access;
      if (
        issuedBy === undefined || access === undefined ||
        acl?.[issuedBy as keyof ACL] !== "OWNER"
      ) return failure("invite-unavailable");
      const held = suggestion(inviteId)?.profile;
      const result: InvitePreview = {
        access,
        ...(names?.spaceName === undefined
          ? {}
          : { spaceName: names.spaceName }),
        ...(names?.issuerName === undefined
          ? {}
          : { issuerName: names.issuerName }),
        ...(held === undefined ? {} : { suggestedProfile: held }),
      };
      return { result };
    }
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
          result: withSuggestion({
            outcome: "already-redeemed",
            redemption,
            currentAccess: capability(),
          }, acl),
        };
      }
      const row = db.prepare("SELECT * FROM space_invites WHERE inviteId = ?")
        .get<ActiveRow>(inviteId);
      if (!row) return failure("invite-unavailable");
      if (!acl || acl[row.issuedBy as keyof ACL] !== "OWNER") {
        remove(inviteId);
        forgetSuggestion(inviteId);
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
        result: withSuggestion({
          outcome: "redeemed",
          redemption,
          currentAccess: current !== null && isCapable(current, row.access)
            ? current
            : row.access,
        }, acl),
        ...(commit ? { commit } : {}),
      };
    }
    const administrator = acl?.[principal as keyof ACL];
    if (administrator !== "OWNER") return failure("not-owner");
    switch (request.operation) {
      case "create": {
        const body = request.body;
        const maxUses = body.maxUses ?? 1;
        if (
          !isInviteId(body.inviteId) || !isInviteSecret(body.codeVerifier) ||
          // An invitation grants at most its issuer's own access. Only an
          // explicit OWNER reaches this point, so today every InviteAccess
          // passes; the bound stays here so that admitting lesser issuers
          // later cannot let a WRITE holder mint an OWNER link.
          !isInviteAccess(body.access) ||
          !isCapable(administrator, body.access) ||
          !Number.isSafeInteger(maxUses) || maxUses < 1 ||
          maxUses > SPACE_INVITE_CAPABILITY.maxUses ||
          !Number.isSafeInteger(body.ttlSeconds) || body.ttlSeconds < 1 ||
          body.ttlSeconds > SPACE_INVITE_CAPABILITY.maxTtlSeconds ||
          // A suggested profile is one person's, so only an invitation that
          // admits one identity carries one.
          (body.suggestedProfile !== undefined &&
            (!isInviteProfileSuggestion(body.suggestedProfile) ||
              maxUses !== 1)) ||
          (body.spaceName !== undefined &&
            !isInvitePreviewName(body.spaceName)) ||
          (body.issuerName !== undefined &&
            !isInvitePreviewName(body.issuerName))
        ) return failure("invalid-request");
        const existing = db.prepare(
          "SELECT * FROM space_invites WHERE inviteId = ?",
        ).get<ActiveRow>(body.inviteId);
        if (existing) {
          const held = suggestion(body.inviteId)?.profile;
          const names = previewNames(body.inviteId);
          if (
            existing.issuedBy !== principal ||
            existing.codeVerifier !== body.codeVerifier ||
            existing.access !== body.access || existing.maxUses !== maxUses ||
            existing.ttlSeconds !== body.ttlSeconds ||
            held?.name !== body.suggestedProfile?.name ||
            held?.picture !== body.suggestedProfile?.picture ||
            names?.spaceName !== body.spaceName ||
            names?.issuerName !== body.issuerName
          ) return failure("invite-id-unavailable");
          return { result: metadata(existing) };
        }
        if (
          usedCount(body.inviteId) ||
          db.prepare(
            "SELECT inviteId FROM space_invite_rejections WHERE inviteId = ?",
          ).get(body.inviteId)
        ) return failure("invite-id-unavailable");
        const { suggestedProfile, spaceName, issuerName, ...settings } = body;
        const row: ActiveRow = {
          ...settings,
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
        if (suggestedProfile !== undefined) {
          db.prepare(
            "INSERT INTO space_invite_suggestions VALUES (?, ?, ?, ?, ?)",
          ).run(
            row.inviteId,
            row.issuedBy,
            suggestedProfile.name,
            suggestedProfile.picture ?? null,
            row.expiresAt,
          );
        }
        // Kept for every invitation, names or not: it holds the access and
        // issuer a redeemer's preview reads once the row is used up.
        db.prepare(
          "INSERT INTO space_invite_previews VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          row.inviteId,
          row.issuedBy,
          row.access,
          spaceName ?? null,
          issuerName ?? null,
          row.expiresAt,
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
        forgetSuggestion(request.body.inviteId);
        return { result: { revoked: true } as const };
      }
    }
  }, { durable: true });
  if ("failure" in outcome) throw new SpaceInviteError(outcome.failure);
  return outcome;
}
