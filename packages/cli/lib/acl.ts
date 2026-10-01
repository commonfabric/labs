import { ACLManager } from "@commonfabric/runner";
import {
  ACL,
  ACLUser,
  ANYONE_USER,
  type Capability,
  type DID,
  hasConcreteOwner,
  isACLUser,
} from "@commonfabric/memory/acl";
import {
  loadPieces,
  type PieceResolutionDeps,
  type SpaceConfig,
} from "./piece.ts";
import { throwOnSpaceAuthorizationError } from "./utils.ts";
import { noteWroteTo } from "./write-receipt.ts";

/**
 * The connection an ACL operation runs over. It carries the loader alone: an
 * ACL document is addressed by the space DID, so nothing here resolves a
 * piece address and a `resolvePieceAddress` accepted alongside would be a
 * promise no function keeps.
 */
export type AclConnectionDeps = Pick<PieceResolutionDeps, "loadPieces">;

/** What {@link withAcl} hands `run` beside the `ACLManager`. */
interface AclSession {
  /** The DID of the identity the connection acts as. */
  readonly principal: DID;

  /** Throws the denial the space recorded so far, if any. */
  readonly check: () => void;
}

// Open the space and hand an ACLManager to `run`. The ACL document is
// addressed by the space DID and read through the ACLManager, so the space
// cell's contents are never needed here and their sync is deferred. That is
// now `loadPieces`'s default too; it stays explicit here because the check
// below depends on it, not on whatever the default happens to be.
async function withAcl<T>(
  config: SpaceConfig,
  run: (acl: ACLManager, session: AclSession) => Promise<T>,
  options: { writes?: boolean; revokesSelf?: boolean } = {},
  deps: AclConnectionDeps = {},
): Promise<T> {
  const pieces = await (deps.loadPieces ?? loadPieces)({
    ...config,
    deferSpaceCellSync: true,
  });
  const runtime = pieces.runtime;
  // A connection opened here is closed here. One the caller supplied outlives
  // the call, and closing its runtime would take down a socket still in use.
  await using _opened = deps.loadPieces ? undefined : runtime;
  const space = pieces.getSpace();
  const check = () =>
    throwOnSpaceAuthorizationError(runtime.storageManager, space);
  const result = await run(new ACLManager(runtime, space), {
    principal: runtime.userIdentityDID,
    check,
  });
  // Before the authorization check below, which throws on a denial recorded
  // during the access — after a write that already landed. A receipt owed for
  // a completed write is not the check's to withhold.
  if (options.writes === true) noteWroteTo(config.space);
  // Checked AFTER the ACL access, which is what pulls the space and records any
  // denial. A denied write already rejects above; this also fails a read that
  // otherwise collapses to a silent "no ACL". A write that removes the
  // writer's own access is followed by the server revoking its session, which
  // records a denial of its own; `run` checks before writing instead.
  if (options.revokesSelf !== true) check();
  return result;
}

// Add or update an ACL entry for a DID
export async function setAclEntry(
  config: SpaceConfig,
  user: string,
  capability: Capability,
  deps: AclConnectionDeps = {},
): Promise<void> {
  const userDid = userToACLUser(user);
  await withAcl(config, (acl) => acl.set(userDid, capability), {
    writes: true,
  }, deps);
}

// Remove an ACL entry for a DID
export async function removeAclEntry(
  config: SpaceConfig,
  user: string,
  deps: AclConnectionDeps = {},
): Promise<void> {
  const userDid = userToACLUser(user);
  await withAcl(config, (acl) => acl.remove(userDid), { writes: true }, deps);
}

/** What {@link leaveAcl} did. */
export type LeaveOutcome = "left" | "absent";

/**
 * Removes the entry of the identity `config` names from the ACL of its space,
 * giving up the access the entry grants. The memory server admits this from a
 * member at any level, `OWNER` or not, but only as the removal of that one
 * entry. Returns `"left"` once the removal commits, and `"absent"`, changing
 * nothing, when the ACL holds no entry for the identity.
 *
 * @throws Error when the space has no ACL, when the ACL has a `"*"` entry,
 *   which would go on granting the identity access, when the identity is the
 *   last concrete `OWNER`, whose removal would leave the space without one, or
 *   when the memory server refuses the write.
 */
export async function leaveAcl(
  config: SpaceConfig,
  deps: AclConnectionDeps = {},
): Promise<LeaveOutcome> {
  return await withAcl(
    config,
    async (acl, { principal: me, check }) => {
      const current = await acl.get();
      check();
      if (current === null) throw new Error("No ACL initialized for space.");
      if (current[ANYONE_USER] !== undefined) {
        throw new Error(
          `The ACL of ${config.space} has a "*" entry, which would go on ` +
            `granting ${me} access, so it cannot be left. An OWNER can remove ` +
            "that entry first.",
        );
      }
      if (current[me] === undefined) return "absent";
      const { [me]: _removed, ...rest } = current;
      if (!hasConcreteOwner(rest)) {
        throw new Error(
          `${me} is the last concrete OWNER of ${config.space}, and an ACL must ` +
            "keep one. Make another member OWNER first.",
        );
      }
      await acl.remove(me);
      return "left";
    },
    { writes: true, revokesSelf: true },
    deps,
  );
}

// Get the current ACL for a space
export async function getAcl(
  config: SpaceConfig,
  deps: AclConnectionDeps = {},
): Promise<ACL | null> {
  return await withAcl(config, (acl) => acl.get(), {}, deps);
}

// Use "ANYONE" on the command line to map to "*"
// to avoid shell expansion.
function userToACLUser(user: string): ACLUser {
  user = user === "ANYONE" ? "*" : user;
  if (!isACLUser(user)) {
    throw new Error(`${user} is not "ANYONE" or a valid DID.`);
  }
  return user as ACLUser;
}
