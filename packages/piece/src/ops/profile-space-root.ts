/**
 * Makes an existing profile its space's root. A profile created in a space
 * whose genesis reserved no root is reached only through a link to it; once
 * the space cell's `defaultPattern` links it, a host holding only the space's
 * DID reaches it too. An operator runs this over a whole store, as an
 * identity of its own with no special privilege: a profile space grants every
 * principal `WRITE`, so the link is an ordinary commit. A person runs it over
 * the profiles their own Home lists, as the identity that owns them.
 *
 * What it replaces is a root that only a space-root ensure created: at the
 * address the ensure derives, running the default app by the evidence of its
 * stored source, following the system default source or none, with nothing
 * registered in it. Any other root is reported as `occupied` and left alone. The genesis reservation a
 * space was created without cannot be added afterward, so a repaired profile
 * is not at the reserved root address.
 */

import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import type { DID } from "@commonfabric/identity";
import { hasConcreteOwner, isACL } from "@commonfabric/memory/acl";
import {
  ACLManager,
  attestedPrincipalsAt,
  type Cell,
  DEFAULT_APP_PATTERN_SOURCE,
  entityIdFrom,
  getPatternIdentityRef,
  getPatternSource,
  type JSONSchema,
  type NormalizedFullLink,
  resolveSpaceRootPattern,
  spaceRootPatternConfig,
} from "@commonfabric/runner";

import type { PiecesController } from "./pieces-controller.ts";

/**
 * Where a profile's space stands:
 *
 * - `root`: the space cell already links the profile as the space's root.
 * - `unrooted`: the space has no root, and linking the profile makes it one.
 * - `junk-root`: the root is one a space-root ensure created and nothing was
 *   added to, which linking the profile replaces.
 * - `occupied`: some other root, which is left alone.
 * - `not-a-profile`: the piece does not read as a profile its space's owner
 *   holds, so nothing is changed.
 */
export type ProfileSpaceRootStatus =
  | "root"
  | "unrooted"
  | "junk-root"
  | "occupied"
  | "not-a-profile";

/** What one profile's inspection found, and the receipt that pins it. */
export interface ProfileSpaceRootInspection {
  status: ProfileSpaceRootStatus;

  /** What a repair does for it: link, replace, or nothing. */
  action: "link" | "replace" | "none";

  /** The profile, resolved from the address it was named by. */
  profile: NormalizedFullLink;

  /** The principal the profile's label says it represents, when it says one. */
  owner?: DID;

  /** The root the space cell links, when it links one. */
  root?: NormalizedFullLink;

  /** Why the profile is `not-a-profile`. */
  reason?: string;

  /** A hash of everything above and of the facts it was decided from. */
  inspection: string;
}

interface ProfileSpaceRootPlan {
  report: ProfileSpaceRootInspection;
  profile: Cell<unknown>;
  root?: Cell<unknown>;
}

/** Helper for the inspection, which drops a link's schema from what it reports. */
function address(link: NormalizedFullLink): NormalizedFullLink {
  return {
    space: link.space,
    id: link.id,
    scope: link.scope,
    path: [...link.path],
  };
}

/**
 * Reads where the profile named by `id` in the controller's space stands. The
 * reads are of the live store, through the controller's runtime.
 */
async function readPlan(
  controller: PiecesController,
  id: string,
): Promise<ProfileSpaceRootPlan> {
  const runtime = controller.runtime;
  const space = controller.getSpace();
  const named = runtime.getCellFromEntityId(space, entityIdFrom(id), []);
  await named.sync();
  const profile = named.resolveAsCell();
  await profile.sync();
  const profileLink = address(profile.getAsNormalizedFullLink());

  const slot = runtime.getSpaceCell(space).key("defaultPattern");
  await slot.sync();
  const root = slot.getRaw() === undefined
    ? undefined
    : slot.get() as Cell<unknown> | undefined;
  if (root !== undefined) await root.sync();
  const rootLink = root === undefined
    ? undefined
    : address(root.getAsNormalizedFullLink());

  const decide = (
    status: ProfileSpaceRootStatus,
    facts: { owner?: DID; reason?: string; evidence?: FabricValue } = {},
  ): ProfileSpaceRootPlan => {
    const report = {
      status,
      action: status === "unrooted"
        ? "link" as const
        : status === "junk-root"
        ? "replace" as const
        : "none" as const,
      profile: profileLink,
      ...(facts.owner === undefined ? {} : { owner: facts.owner }),
      ...(rootLink === undefined ? {} : { root: rootLink }),
      ...(facts.reason === undefined ? {} : { reason: facts.reason }),
    };
    return {
      report: {
        ...report,
        inspection: hashStringOf({
          report,
          evidence: facts.evidence ?? null,
        }),
      },
      profile,
      ...(root === undefined ? {} : { root }),
    };
  };

  if (
    profileLink.space !== space || profileLink.path.length !== 0 ||
    profile.getRaw() === undefined
  ) {
    return decide("not-a-profile", {
      reason: "the address names no piece in the profile's space",
    });
  }

  const acl = await new ACLManager(runtime, space).getStored();
  const owners = isACL(acl) && hasConcreteOwner(acl)
    ? Object.entries(acl).flatMap(([principal, capability]) =>
      principal !== "*" && capability === "OWNER" ? [principal] : []
    )
    : [];
  const tx = runtime.edit();
  let represented: DID[] | undefined;
  try {
    represented = attestedPrincipalsAt(
      tx,
      profileLink,
      "represents-principal",
    );
  } finally {
    tx.abort();
  }
  if (represented?.length !== 1 || !owners.includes(represented[0])) {
    return decide("not-a-profile", {
      reason: "its label names no single owner of the space it represents",
      evidence: { owners, represented: represented ?? null },
    });
  }
  const owner = represented[0];

  if (root === undefined) return decide("unrooted", { owner });
  if (root.resolveAsCell().equalLinks(profile)) {
    return decide("root", { owner });
  }

  // The root a space-root ensure creates for a space that is not a Home: at
  // the address the ensure derives, running the default app, following its
  // system source or none, with nothing registered in it. Each fact is
  // established positively; a root the evidence does not reach is occupied.
  const ensured = runtime.getCell(space, spaceRootPatternConfig(false).cause);
  const origin = getPatternSource(root);
  const identity = getPatternIdentityRef(root);
  const program = identity === undefined
    ? undefined
    : await runtime.patternManager.getPatternSourceProgramByIdentity(
      identity.identity,
      space,
    );
  const registered = await registeredCount(root);
  const evidence = {
    origin: origin ?? null,
    identity: identity ?? null,
    main: program?.main ?? null,
    registered: registered ?? null,
  };
  return root.equalLinks(ensured) &&
      (origin === undefined || origin === DEFAULT_APP_PATTERN_SOURCE) &&
      program?.main.endsWith(DEFAULT_APP_MAIN) === true &&
      registered === 0
    ? decide("junk-root", { owner, evidence })
    : decide("occupied", { owner, evidence });
}

/** How the default app's entry module's name ends, wherever it was compiled. */
const DEFAULT_APP_MAIN = "/system/default-app.tsx";

/**
 * How many pieces `root`'s `pieceRegistry` holds, `0` when it has an empty
 * one, and `undefined` when its result has no list there, which a default app
 * always has.
 */
async function registeredCount(
  root: Cell<unknown>,
): Promise<number | undefined> {
  const registry = await root.key("pieceRegistry").asSchema({
    type: "array",
  }).pull();
  return Array.isArray(registry) ? registry.length : undefined;
}

/** Like {@link registeredCount}, except read through `root`'s transaction. */
function registeredCountNow(root: Cell<unknown>): number | undefined {
  const registry = root.key("pieceRegistry").asSchema({ type: "array" }).get();
  return Array.isArray(registry) ? registry.length : undefined;
}

/**
 * Returns where the profile named by `id`, in the controller's space, stands,
 * without changing anything.
 */
export async function inspectProfileSpaceRoot(
  controller: PiecesController,
  id: string,
): Promise<ProfileSpaceRootInspection> {
  return (await readPlan(controller, id)).report;
}

/**
 * Makes the profile named by `id` its space's root, as `expectedInspection`
 * found it, and returns the inspection made afterward. A profile whose
 * action is `none` is returned unchanged.
 *
 * @throws Error when the profile or its space's root changed since the
 *   inspection that produced `expectedInspection`, including a root another
 *   writer links while the repair commits.
 */
export async function repairProfileSpaceRoot(
  controller: PiecesController,
  id: string,
  expectedInspection: string,
): Promise<ProfileSpaceRootInspection> {
  const plan = await readPlan(controller, id);
  if (plan.report.inspection !== expectedInspection) {
    throw new Error(
      "The profile changed after inspection; inspect it again before applying",
    );
  }
  if (plan.report.action === "none") return plan.report;
  // A root replaced as junk must still be junk when the link is written:
  // running the pattern it was inspected running, with nothing registered.
  const inspected = plan.root === undefined
    ? undefined
    : getPatternIdentityRef(plan.root);
  await controller.linkDefaultPattern(plan.profile, {
    replacing: plan.root ?? null,
    ...(plan.report.action === "replace"
      ? {
        stillReplaceable: (root: Cell<unknown>) => {
          const now = getPatternIdentityRef(root);
          return now?.identity === inspected?.identity &&
            now?.symbol === inspected?.symbol &&
            registeredCountNow(root) === 0;
        },
      }
      : {}),
  });
  await controller.runtime.storageManager.synced();
  return await inspectProfileSpaceRoot(controller, id);
}

/** A Home's `profiles` list, each entry read as the cell it links. */
const PROFILE_LIST_SCHEMA = {
  type: "array",
  items: { asCell: ["cell"] },
} as const satisfies JSONSchema;

/**
 * Returns the address of every profile the Home at the controller's space
 * lists in another space, each as the list stores it: the slot the profile was
 * appended through, which links on to the profile. The reads are of the live
 * store, through the controller's runtime, and write nothing.
 *
 * @throws Error when the space's root is not a Home, one with a `profiles`
 *   list.
 */
export async function listedProfiles(
  controller: PiecesController,
): Promise<{ space: string; id: string }[]> {
  const space = controller.getSpace();
  const root = await resolveSpaceRootPattern(controller.runtime, space);
  const list = root?.key("profiles").asSchema(PROFILE_LIST_SCHEMA);
  await list?.sync();
  const entries = list?.get();
  if (!Array.isArray(entries)) {
    throw new Error(`The root of ${space} is not a Home with a profiles list`);
  }
  return entries.flatMap((entry) => {
    const link = (entry as Cell<unknown>).getAsNormalizedFullLink();
    return link.space === space ? [] : [{ space: link.space, id: link.id }];
  });
}
