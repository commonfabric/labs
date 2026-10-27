/**
 * Creating, listing, renaming, picturing, retiring and restoring profiles
 * from the command line.
 *
 * A profile is appended to the home root's `profiles` list, whose elements
 * carry the create surface's UI contract: the append must ride an event
 * marked with that surface's gesture. A command line renders no surface, so
 * `createProfile()` builds the event the html renderer builds for a click on
 * the create form and marks it the same way (`trusted-action-event.ts`); no
 * renderer saw that event, and no reviewed surface was shown. The handler is
 * the home pattern's `createProfile`, so the profile is made exactly as the
 * shell makes one: in its own space, its display name carried on the event
 * and never on a draft cell.
 *
 * Retiring and restoring send plain events to Home's `retireProfile` and
 * `restoreProfile`, the only writers its `retiredProfiles` list admits, and
 * renaming and picturing send plain events to the profile's own handlers.
 */

import type { CellScope, JSONSchema } from "@commonfabric/api";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  type Cell,
  cellRuntime,
  DocumentLoadError,
  getMetaLink,
  type IExtendedStorageTransaction,
  loadDocument,
  loadProfileCandidates,
  loadProfileOwnerDocuments,
  orderProfileCandidates,
  profileOwnership,
  sendEvent,
} from "@commonfabric/runner";
import {
  type CfcLabelView,
  cfcLabelViewForResolvedTargetWithStatus,
} from "@commonfabric/runner/cfc";
import { exactPrincipalAttestations } from "@commonfabric/runner/cfc/represents-principal";

import { canonicalAddress } from "./callable.ts";
import { loadPieces, type SpaceConfig } from "./piece.ts";
import { profileNameProtection } from "./profile-name-protection.ts";
import { buildActionEvent } from "./trusted-action-event.ts";

/**
 * The create surface's `data-ui-pattern` and `data-ui-action`, as
 * `packages/patterns/system/profile-create.tsx` declares them
 * (`TRUSTED_PROFILE_CREATE_SURFACE`, `TRUSTED_PROFILE_CREATE_ACTION`). Named
 * here rather than imported: a pattern is above this package in the layer
 * stack, and the event is matched by string either way.
 */
export const PROFILE_CREATE_SURFACE = "ProfileCreateSurface";
export const PROFILE_CREATE_ACTION = "CreateProfile";

/**
 * Why `name`, trimmed, cannot be a profile's display name, or `undefined`
 * when it can: it must not be empty, and must hold no control character,
 * since it is stored on the profile and echoed to the terminal. The profile's
 * own handlers refuse the same names (`nameHasControlCharacter()` in
 * profile-home.tsx, a pattern this package does not import).
 */
export function profileNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "A profile needs a name.";
  if (/\p{Cc}/u.test(trimmed)) {
    return "A profile name cannot contain control characters.";
  }
  return undefined;
}

/**
 * `name` trimmed, as a profile's display name.
 *
 * @throws Error when it cannot be one, saying why (`profileNameProblem()`).
 */
export function profileName(name: string): string {
  const problem = profileNameProblem(name);
  if (problem !== undefined) throw new Error(problem);
  return name.trim();
}

/** What `createProfile()` needs: a connection, and the name to create under. */
export interface ProfileCreateConfig extends SpaceConfig {
  /** The display name, which becomes the profile's `initialName`. */
  name: string;
}

/** A profile `createProfile()` made. */
export interface CreatedProfile {
  /** The display name the profile was created with. */
  name: string;

  /** The profile's own space, which is not the home space. */
  space: string;

  /** The profile piece's id within that space. */
  id: string;

  /**
   * The canonical reference as `canonicalAddress()` renders it —
   * `//<space>/<id>`, with a `@<scope>` suffix off the space scope — which
   * `--cell` takes whole.
   */
  address: string;
}

/** Injectable connection dep, mirroring lib/piece.ts's `RootPatternDeps`. */
export interface CreateProfileDeps {
  loadPieces?: typeof loadPieces;
}

// The list read as link cells, never inlined values: a `.get()` that follows
// each link collapses to `undefined` the moment one element lives in a space
// this runtime has not loaded, which a freshly created profile's always is.
// Mirrors `profileLinkListSchema()` in the patterns' profile-links.ts.
const profileLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
} as const satisfies JSONSchema;

/**
 * The spaces the home root's list under `key` links into, one per profile,
 * each with its link.
 */
function profileSpaces(
  root: Cell<unknown>,
  key: "profiles" | "retiredProfiles" = "profiles",
): Map<string, Cell<unknown>> {
  const links = root.key(key).asSchema(profileLinkListSchema).get() ?? [];
  return new Map(
    links.map((link) => [link.getAsNormalizedFullLink().space, link]),
  );
}

/**
 * Helper for {@link createProfile}, which picks the profile this call made
 * out of `candidates`, the profiles that appeared since the call's first
 * read.
 *
 * One candidate is this call's. Two processes creating at once can each
 * read the list before either append lands, so both then see two; the
 * one whose `initialName` is this call's name is this call's, and when
 * that does not settle it either (both named alike) the call refuses to
 * guess rather than print another process's profile as its own.
 *
 * @throws Error when more than one candidate carries `name`.
 */
export async function createdByThisCall(
  candidates: [string, Cell<unknown>][],
  name: string,
): Promise<[string, Cell<unknown>] | undefined> {
  if (candidates.length === 0) return undefined;
  const named: [string, Cell<unknown>][] = [];
  for (const candidate of candidates) {
    // A foreign list handle can address a redirect slot. Load and resolve it
    // outside the list snapshot before reading the profile result metadata.
    const addressed = candidate[1].withTx().asSchema(undefined);
    await addressed.sync();
    const profile = addressed.resolveAsCell();
    await profile.sync();
    const resolved: [string, Cell<unknown>] = [
      profile.getAsNormalizedFullLink().space,
      profile,
    ];
    if (candidates.length === 1) return resolved;
    const argument = getMetaLink(profile, "argument");
    if (argument === undefined) continue;
    const initialName = cellRuntime(candidate[1]).getCellFromLink(argument)
      .key("initialName");
    await initialName.sync();
    if (String(initialName.get() ?? "") === name) named.push(resolved);
  }
  if (named.length === 1) return named[0];
  throw new Error(
    `Creating profile "${name}" committed, but ${candidates.length} profiles ` +
      "appeared at once and more than one carries that name; read the " +
      "profile list to tell them apart.",
  );
}

/**
 * Sends `event` on `stream` and resolves with the transaction its handler
 * committed.
 *
 * The append's own outcome is not the answer: the handler runs after the
 * append, and what it does exists once the handler's transaction has
 * committed. A refused append is the one outcome that never reaches a commit
 * callback, so it rejects here.
 */
function sendAndCommit(
  stream: Cell<unknown>,
  event: unknown,
): Promise<IExtendedStorageTransaction> {
  return new Promise((resolve, reject) => {
    try {
      sendEvent(stream, event, resolve, {
        onAppended: (delivery, appendedTx) => {
          if (!delivery.delivered && appendedTx.status().status !== "error") {
            reject(new Error(`event append refused: ${delivery.refused}`));
          }
        },
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Helper for {@link createProfile}, which runs the created profile once so
 * that the piece's outputs are materialized — stored where a runtime that
 * never runs the piece reads them. The name is not derived here: the create
 * handler's seed step stores it on the new profile, and this run is what
 * makes that stored name, and the rest of the outputs, readable headlessly.
 *
 * The create handler sets the piece up and nothing runs it until a shell
 * opens it. `cf profile show` and the `#profile` wish loom resolves a viewer
 * through read the stored `name` and run nothing, so without this step they
 * find a profile whose outputs were never written.
 *
 * The run goes through a connection of its own, scoped to the profile's
 * space, rather than through the home connection that sent the create: in
 * the runtime that ran the handler the piece's nodes do not run on demand —
 * a start there wires the scheduler and a pull materializes nothing — while
 * a fresh runtime resuming the piece from storage runs them. The step starts
 * the piece through `getPieceCell()`, pulls it, syncs storage, waits for
 * scheduler idle, and syncs again.
 * The stop and dispose close the connection down the way a one-shot command
 * closes it.
 *
 * Under server execution (`experimental.serverExecution`) the server runs
 * the piece as soon as it exists, and this client-side run adds nothing to
 * what the server stored.
 */
async function materializeProfile(
  config: SpaceConfig,
  created: Pick<CreatedProfile, "space" | "id">,
  scope: CellScope,
  load: typeof loadPieces,
): Promise<void> {
  const pieces = await load({ ...config, space: created.space });
  try {
    const piece = await pieces.getPieceCell(created.id, true, undefined, scope);
    await piece.pull();
    await pieces.synced();
    await pieces.runtime.idle();
    await pieces.synced();
    await pieces.stopPiece(piece);
  } finally {
    await pieces.dispose();
  }
}

/**
 * Creates a profile named `config.name` in the home space of
 * `config.identity`, and returns where it landed.
 *
 * `config.space` is the identity's home space: the home root owns the
 * profile list, and a profile created against any other root would be one
 * nothing resolves. The root is ensured and started first, since the
 * handler runs in this process.
 *
 * @throws Error when the name is empty or holds a control character, when
 * the handler's commit fails, or when the list carries no
 * new profile after it — the shape a refused owner-protected write arrives
 * in, since the runtime records the refusal on the transaction it rejected.
 */
export async function createProfile(
  config: ProfileCreateConfig,
  deps: CreateProfileDeps = {},
): Promise<CreatedProfile> {
  const name = profileName(config.name);
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const home = await pieces.ensureDefaultPattern();
  // Rebound to no transaction: the controller's cell rides a read
  // transaction, and a send opens a writable one of its own.
  const root = home.getCell().withTx().asSchema(undefined);
  await root.sync();
  const before = profileSpaces(root);

  const committed = await sendAndCommit(
    root.key("createProfile"),
    buildActionEvent({ name }, {
      surface: PROFILE_CREATE_SURFACE,
      action: PROFILE_CREATE_ACTION,
    }),
  );
  throwIfFailed(committed, `Creating profile "${name}"`);
  // The append lands through the handler's cross-space commit and the
  // retry rounds behind it; the list is read once the runtime is idle and
  // storage has caught up, not off the transaction the send resolved with.
  await pieces.runtime.idle();
  await pieces.synced();
  await root.sync();

  const created = await createdByThisCall(
    [...profileSpaces(root)].filter(([space]) => !before.has(space)),
    name,
  );
  if (created === undefined) {
    throw new Error(
      `Creating profile "${name}" committed, but the home root's ` +
        "`profiles` list carries no new profile.",
    );
  }
  const [space, link] = created;
  const normalized = link.getAsNormalizedFullLink();
  const scope = normalized.scope ?? "space";
  await materializeProfile(
    config,
    { space, id: normalized.id },
    scope,
    deps.loadPieces ?? loadPieces,
  );
  return {
    name,
    space,
    id: normalized.id,
    address: canonicalAddress({ space, id: normalized.id, scope }),
  };
}

/**
 * Throws when `committed`, the transaction a handler committed, failed:
 * `doing` names the act in the message.
 */
function throwIfFailed(
  committed: IExtendedStorageTransaction,
  doing: string,
): void {
  const status = committed.status();
  if (status.status !== "error") return;
  throw new Error(
    `${doing} failed: ${
      "message" in status.error
        ? String(status.error.message)
        : String(status.error)
    }`,
  );
}

/** One of a person's profiles, as `listProfiles()` reports it. */
export interface ListedProfile {
  /** The profile's stored display name, or "" when it has none yet. */
  name: string;

  /**
   * The bytes of the profile's picture, a raster image, or `undefined` when
   * it has none.
   */
  picture: Uint8Array | undefined;

  /**
   * Whether the picture is attested to its owner: the label its value carries
   * names the person whose profiles these are, and no one else, as the
   * principal it represents (`ownerAttests()`). `false` when there is no
   * picture, for one another principal set, which anyone can, since a
   * profile's space lets anyone write, and for one stored without a label. A
   * host showing the picture as the person's face shows it only where this is
   * `true`. A picture stored before writes to it were labeled carries no
   * label, so it is `false` until its owner sets it again, as
   * `setProfilePicture()` does with `keepCurrent`.
   */
  pictureByOwner: boolean;

  /**
   * The profile's legacy avatar text (a URL, a `data:` URL or a glyph), or
   * "" when it has none, shown only where the profile has no picture.
   */
  avatar: string;

  /**
   * Whether the avatar text is attested to its owner, as `pictureByOwner`
   * says of the picture. `false` when there is none.
   */
  avatarByOwner: boolean;

  /** The profile's own space, which identifies it. */
  space: string;

  /** The profile piece's id within that space. */
  id: string;

  /** The canonical reference, as {@link CreatedProfile.address} is. */
  address: string;

  /** Whether `#profile` answers with this profile. */
  current: boolean;

  /**
   * Present, and `true`, on the row of a profile the home retired, which only
   * a listing that asks for them (`ListProfilesOptions.includeRetired`)
   * holds. Absent on every other row.
   */
  retired?: true;
}

/** How `listProfiles()` lists a person's profiles. */
export interface ListProfilesOptions {
  /**
   * Also list the profiles the home retired, after the live ones, in the
   * order the home retired them, each marked `retired`. Only the retired
   * profiles that the home lists among its `profiles` and that are the
   * identity's own, by the rule the live ones are listed by, are listed.
   */
  includeRetired?: boolean;
}

/**
 * A profile's stored name, picture and avatar, read without running the
 * profile.
 */
const profileFieldsSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    picture: { type: "FabricBytes" },
    avatar: { type: "string" },
  },
} as const satisfies JSONSchema;

/** The bytes `value`, a stored picture, holds; `undefined` for none. */
function pictureBytes(value: unknown): Uint8Array | undefined {
  return value instanceof FabricBytes && value.length > 0
    ? value.slice()
    : undefined;
}

/**
 * Lists the profiles of `config.identity`, in the order `#profile` answers
 * in. The profiles are the ones `#profile` collects
 * (`loadProfileCandidates()`) that are the identity's own: a retired
 * profile, or one whose document is absent, is not listed, and neither is
 * one that is not the identity's own by the rule `#profile` applies
 * (`isOwnProfile()`, `profileOwnership()`). A profile Home lists may be
 * someone else's, as one listed before Home's lists carried write policies of
 * their own may be. The one `#profile` answers with is marked `current`,
 * which no listed profile is when `#profile` answers with a profile that is
 * not the identity's. A person with no home root yet has no profiles.
 *
 * With `options.includeRetired`, the identity's own retired profiles are
 * listed after the live ones, each marked `retired`, and read the same way.
 *
 * `config.space` is the identity's home space. The home root is read and not
 * started, and no profile runs.
 *
 * @throws Error when a listed profile failed to load, or the label on its
 * `name` cannot be read, since leaving it out would report a profile that
 * could not be read as one that is not there or is not the identity's.
 */
export async function listProfiles(
  config: SpaceConfig,
  deps: CreateProfileDeps = {},
  options: ListProfilesOptions = {},
): Promise<ListedProfile[]> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  try {
    const home = await pieces.getDefaultPattern(false);
    if (home === undefined) return [];
    const root = home.withTx().asSchema(undefined);
    const { candidates, failures } = await loadProfileCandidates(
      pieces.runtime,
      root,
    );
    const { ordered } = orderProfileCandidates(
      pieces.runtime,
      root,
      root.space,
      candidates,
    );
    const failed = ordered.find((profile) => failures.has(profile));
    if (failed !== undefined) {
      throw new Error(`Cannot read the profile in ${failed.space}.`, {
        cause: failures.get(failed),
      });
    }
    const own = await Promise.all(
      ordered.map((profile) => isOwnProfile(profile, root.space)),
    );
    const live = await Promise.all(
      ordered.filter((_, index) => own[index]).map((profile) =>
        listedRow(profile, root.space, profile === ordered[0])
      ),
    );
    if (!options.includeRetired) return live;
    const retired = await Promise.all(
      (await ownRetiredProfiles(root)).map(async (profile) => ({
        ...await listedRow(profile, root.space, false),
        retired: true as const,
      })),
    );
    return [...live, ...retired];
  } finally {
    await pieces.dispose();
  }
}

/**
 * The row `listProfiles()` reports for `profile`, one of the identity
 * `owner`'s own profiles, `current` saying whether `#profile` answers with
 * it.
 *
 * @throws Error when a label on the picture or the avatar cannot be read.
 */
async function listedRow(
  profile: Cell<unknown>,
  owner: string,
  current: boolean,
): Promise<ListedProfile> {
  const fields = profile.asSchema(profileFieldsSchema);
  await fields.sync();
  const value = fields.get();
  const link = profile.getAsNormalizedFullLink();
  const scope = link.scope ?? "space";
  const picture = pictureBytes(value?.picture);
  return {
    name: value?.name ?? "",
    picture,
    pictureByOwner: picture !== undefined &&
      ownerAttests(profile.key("picture"), owner),
    avatar: value?.avatar ?? "",
    avatarByOwner: (value?.avatar ?? "") !== "" &&
      ownerAttests(profile.key("avatar"), owner),
    space: link.space,
    id: link.id,
    address: canonicalAddress({ space: link.space, id: link.id, scope }),
    current,
  };
}

/**
 * The profiles the home root `root` retired that it lists among its
 * `profiles` and that are the identity's own (`isOwnProfile()`), once each,
 * in the order the home retired them. A profile whose document is absent is
 * left out, as a live one is.
 *
 * @throws Error when one of them failed to load, or a label that says whose
 * it is cannot be read.
 */
async function ownRetiredProfiles(
  root: Cell<unknown>,
): Promise<Cell<unknown>[]> {
  await root.sync();
  await root.key("profiles").resolveAsCell().sync();
  await root.key("retiredProfiles").resolveAsCell().sync();
  const listed = profileSpaces(root);
  const runtime = cellRuntime(root);
  const found: Cell<unknown>[] = [];
  for (const space of profileSpaces(root, "retiredProfiles").keys()) {
    const link = listed.get(space);
    if (link === undefined) continue;
    try {
      if (!await loadDocument(runtime, link)) continue;
      // A link that is no one's profile, one whose links run in a cycle among
      // them, is left unresolved, since only an own profile is listed.
      if (await isOwnProfile(link, root.space)) {
        found.push(link.resolveAsCell());
      }
    } catch (error) {
      if (!(error instanceof DocumentLoadError)) throw error;
      throw new Error(`Cannot read the profile in ${space}.`, {
        cause: error,
      });
    }
  }
  return found;
}

/**
 * Whether the value at `cell` is attested to `principal`, as `attestsOnly()`
 * reads the label `valueLabel()` returns. A value stored without a label is
 * not attested to `principal`.
 *
 * @throws Error when the label cannot be read, which is not the same as there
 * being none.
 */
function ownerAttests(cell: Cell<unknown>, principal: string): boolean {
  return attestsOnly(valueLabel(cell), principal);
}

/**
 * The label the value at `cell` carries, which the write that stored the
 * value minted, or `undefined` when it carries none. The label of the
 * document a field sits in says whom the field was installed for, not who
 * wrote the value behind it (spec §3.7.2), so the value cell's label is the
 * one read, as HOME_SPACE.md says a host reads a profile field.
 *
 * @throws Error when the label cannot be read, which is not the same as there
 * being none.
 */
function valueLabel(cell: Cell<unknown>): CfcLabelView | undefined {
  const { view, readFailed } = cfcLabelViewForResolvedTargetWithStatus(cell);
  if (readFailed) {
    throw new Error(
      `Could not read the label of ${cell.getAsNormalizedFullLink().id}.`,
    );
  }
  return view;
}

/**
 * Whether `label` attests `principal`, and no one else, as the principal the
 * value it labels represents, read as `principalOf()` reads one
 * (`exactPrincipalAttestations()`). Like every claim, it binds honest
 * runtimes only.
 */
function attestsOnly(
  label: CfcLabelView | undefined,
  principal: string,
): boolean {
  const attested = exactPrincipalAttestations(
    label,
    "represents-principal",
    false,
  );
  return attested?.length === 1 && attested[0] === principal;
}

/**
 * Whether `profile`, a profile Home lists, is the identity `owner`'s own, by
 * the one rule for which profiles are a person's (`profileOwnership()`). The
 * profile and the documents its name resolves through are loaded first
 * (`loadProfileOwnerDocuments()`), so that what is read is what is stored.
 *
 * @throws Error when a label cannot be read.
 */
async function isOwnProfile(
  profile: Cell<unknown>,
  owner: string,
): Promise<boolean> {
  const runtime = cellRuntime(profile);
  await loadProfileOwnerDocuments(runtime, profile);
  const tx = runtime.edit();
  try {
    return profileOwnership(runtime, profile, owner, tx) === "own";
  } finally {
    tx.abort();
  }
}

/** What the profile commands that act on one profile need. */
export interface ProfileTargetConfig extends SpaceConfig {
  /** The profile's own space, which identifies it. */
  profileSpace: string;
}

/**
 * The profile of `config.identity` whose space is `config.profileSpace`, as
 * a link from the list `root`, the home root, holds under `profiles`.
 * `retired` says whether the profile must be one the home retired, or one it
 * has not, or, `undefined`, either.
 *
 * @throws Error when the home lists no such profile, when the profile it
 * lists there is not the identity's own (`isOwnProfile()`) or what says so
 * cannot be read, or when its retirement is not what `retired` asks for.
 */
async function listedProfile(
  root: Cell<unknown>,
  config: ProfileTargetConfig,
  retired: boolean | undefined,
): Promise<Cell<unknown>> {
  await root.sync();
  await root.key("retiredProfiles").resolveAsCell().sync();
  const profile = profileSpaces(root).get(config.profileSpace);
  if (profile === undefined) {
    throw new Error(
      `No profile of ${config.space} lives in ${config.profileSpace}.`,
    );
  }
  if (!await isOwnProfile(profile, config.space)) {
    throw new Error(
      `The profile in ${config.profileSpace} is not one of ` +
        `${config.space}'s own.`,
    );
  }
  if (retired !== undefined && isRetired(root, config) !== retired) {
    throw new Error(
      retired
        ? `The profile in ${config.profileSpace} is not retired.`
        : `The profile in ${config.profileSpace} is retired.`,
    );
  }
  return profile;
}

/**
 * Whether the home root `root` lists the profile in `config.profileSpace` as
 * retired, as it is loaded now.
 */
function isRetired(root: Cell<unknown>, config: ProfileTargetConfig): boolean {
  return profileSpaces(root, "retiredProfiles").has(config.profileSpace);
}

/**
 * Sends the event `{ profile }` on the home root's stream `streamName`, for
 * the profile of `config.identity` whose space is `config.profileSpace`,
 * which is retired before the send exactly when `retired` is true and is not
 * after it. The home root is started, since its handler runs in this
 * process, and only once it is found to exist, so that a refused act creates
 * no home. `doing` names the act in a failure's message.
 *
 * @throws Error when the identity has no home, when the commit fails, or
 * when it leaves the profile's
 * retirement as it was: a refused write does not reach the commit's own
 * status, since the runtime records the refusal on the transaction it
 * rejected.
 */
async function sendToHome(
  config: ProfileTargetConfig,
  streamName: "retireProfile" | "restoreProfile",
  retired: boolean,
  doing: string,
  deps: CreateProfileDeps,
): Promise<void> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  try {
    if (await pieces.getDefaultPattern(false) === undefined) {
      throw new Error(`${config.space} has no home, so it has no profiles.`);
    }
    const home = await pieces.ensureDefaultPattern();
    const root = home.getCell().withTx().asSchema(undefined);
    const profile = await listedProfile(root, config, retired);
    const committed = await sendAndCommit(root.key(streamName), { profile });
    throwIfFailed(committed, doing);
    await pieces.runtime.idle();
    await pieces.synced();
    await root.key("retiredProfiles").resolveAsCell().sync();
    if (isRetired(root, config) === retired) {
      throw new Error(`${doing} committed, but Home's list did not change.`);
    }
  } finally {
    await pieces.dispose();
  }
}

/**
 * Retires the profile of `config.identity` whose space is
 * `config.profileSpace`, as the picker's Remove does: Home lists it in
 * `retiredProfiles`, and it stops being one of the person's profiles until
 * `restoreProfile()` restores it.
 *
 * @throws Error when the home lists no such profile, when the profile is
 * retired already, or when the retire fails, as Home's handler fails it for
 * the profile `#profile` returns, or does not land.
 */
export function retireProfile(
  config: ProfileTargetConfig,
  deps: CreateProfileDeps = {},
): Promise<void> {
  return sendToHome(
    config,
    "retireProfile",
    false,
    `Retiring profile ${config.profileSpace}`,
    deps,
  );
}

/**
 * Restores the retired profile of `config.identity` whose space is
 * `config.profileSpace`: Home takes it out of `retiredProfiles`, and it is
 * one of the person's profiles again.
 *
 * @throws Error when the home lists no such profile, when the profile is not
 * retired, or when the restore fails or does not land.
 */
export function restoreProfile(
  config: ProfileTargetConfig,
  deps: CreateProfileDeps = {},
): Promise<void> {
  return sendToHome(
    config,
    "restoreProfile",
    true,
    `Restoring profile ${config.profileSpace}`,
    deps,
  );
}

/** One event `sendToProfile()` sends, and the profile's stream it goes to. */
interface ProfileSend {
  /** The profile's stream. */
  stream: "setName" | "setPicture" | "setAvatar";

  /** The event sent on it. */
  event: unknown;
}

/**
 * Sends each of `sends`, in order and each in a commit of its own, to the
 * profile of `config.identity` whose space is `config.profileSpace`, which
 * the home lists and has not retired, running the profile so that its
 * handlers exist, and waits for the commits to reach storage. The home root
 * is read and not started. `doing` names the act in a failure's message.
 *
 * @throws Error when the home lists no such profile or retired it, when a
 * commit fails, or when `landed`, given the profile's stored name, picture
 * and avatar once the commits have reached storage, says the writes did not
 * land: a refused write does not reach the commit's own status, since the
 * runtime records the refusal on the transaction it rejected.
 */
async function sendToProfile(
  config: ProfileTargetConfig,
  sends: readonly ProfileSend[],
  doing: string,
  landed: (
    stored: { name?: string; picture?: unknown; avatar?: string },
  ) => boolean,
  deps: CreateProfileDeps,
): Promise<void> {
  const load = deps.loadPieces ?? loadPieces;
  const home = await load(config);
  let target: { id: string; scope: CellScope };
  try {
    const root = await home.getDefaultPattern(false);
    if (root === undefined) {
      throw new Error(`${config.space} has no home, so it has no profiles.`);
    }
    const profile = await listedProfile(
      root.withTx().asSchema(undefined),
      config,
      false,
    );
    const resolved = profile.withTx();
    await resolved.sync();
    const link = resolved.resolveAsCell().getAsNormalizedFullLink();
    target = { id: link.id, scope: link.scope ?? "space" };
  } finally {
    await home.dispose();
  }
  const pieces = await load({ ...config, space: config.profileSpace });
  try {
    const piece = await pieces.getPieceCell(
      target.id,
      true,
      undefined,
      target.scope,
    );
    for (const { stream, event } of sends) {
      const committed = await sendAndCommit(
        piece.asSchema(undefined).key(stream),
        event,
      );
      throwIfFailed(committed, doing);
    }
    await pieces.runtime.idle();
    await pieces.synced();
    const stored = piece.asSchema(profileFieldsSchema);
    await stored.sync();
    await pieces.stopPiece(piece);
    if (!landed(stored.get() ?? {})) {
      throw new Error(`${doing} committed, but the profile did not change.`);
    }
  } finally {
    await pieces.dispose();
  }
}

/**
 * Renames the profile of `config.identity` whose space is
 * `config.profileSpace` to `name`, through the profile's own `setName`.
 *
 * @throws Error when the name is empty or holds a control character, when
 * the home lists no such profile or has retired it, or when the rename fails
 * or does not land.
 */
export async function renameProfile(
  config: ProfileTargetConfig & { name: string },
  deps: CreateProfileDeps = {},
): Promise<void> {
  const name = profileName(config.name);
  await sendToProfile(
    config,
    [{ stream: "setName", event: { name } }],
    `Renaming profile ${config.profileSpace}`,
    (stored) => stored.name === name,
    deps,
  );
}

/** What `attestProfileName()` needs: the profile, and what to apply. */
export interface ProfileNameAttestationConfig extends ProfileTargetConfig {
  /**
   * The `inspection` an earlier call without it returned, which applies the
   * attestation it inspected; the call only inspects without it.
   */
  expectedInspection?: string;
}

/**
 * What `attestProfileName()` found or did: `already`, for a name already
 * attested to the identity; `inspected`, for a name carrying no label, with
 * the `inspection` that applying it takes; or `attested`, once applied. Each
 * carries the stored `name`.
 */
export type ProfileNameAttestation =
  | { status: "already" | "attested"; name: string }
  | { status: "inspected"; name: string; inspection: string };

/**
 * Has the identity label the name of its own profile whose space is
 * `config.profileSpace`, retired or not, when the value of that name carries
 * no label at all, as one stored before names were labeled does. Such a
 * profile is the identity's own through the owner policy its name field was
 * set up with (`profileOwnership()`); this labels the name value itself.
 * Without `config.expectedInspection` it inspects the profile, as
 * `cf profile repair-name-protection` does (`profileNameProtection()`), and
 * returns the stored name and the inspection's receipt, changing nothing.
 * Given that receipt, it accepts the stored name, unchanged, under that
 * policy, as the identity running the call, and the value is then labeled as
 * that identity's. The receipt covers the name, so a name changed since it
 * was inspected is refused. A name whose value is already attested to the
 * identity is left as it is.
 *
 * @throws Error when the home lists no such profile of the identity's own,
 * when the profile's name policy names another owner or a layout the repair
 * does not support, when the profile changed since
 * `config.expectedInspection` was taken, or when the name still carries no
 * label afterward.
 */
export async function attestProfileName(
  config: ProfileNameAttestationConfig,
  deps: CreateProfileDeps = {},
): Promise<ProfileNameAttestation> {
  const load = deps.loadPieces ?? loadPieces;
  const listed = async () => {
    const home = await load(config);
    try {
      const root = await home.getDefaultPattern(false);
      if (root === undefined) {
        throw new Error(`${config.space} has no home, so it has no profiles.`);
      }
      const profile = await listedProfile(
        root.withTx().asSchema(undefined),
        config,
        undefined,
      );
      const link = profile.withTx().resolveAsCell().getAsNormalizedFullLink();
      return {
        labeled: ownerAttests(profile.key("name"), config.space),
        name: profile.asSchema(profileFieldsSchema).get()?.name ?? "",
        cell: canonicalAddress({
          space: link.space,
          id: link.id,
          scope: "space",
        }),
      };
    } finally {
      await home.dispose();
    }
  };
  const before = await listed();
  if (before.labeled) return { status: "already", name: before.name };
  const inspected = await profileNameProtection(
    {
      ...config,
      cell: before.cell,
      ...(config.expectedInspection === undefined
        ? {}
        : { expectedInspection: config.expectedInspection }),
    },
    load,
  );
  if (config.expectedInspection === undefined) {
    return {
      status: "inspected",
      name: inspected.name,
      inspection: inspected.inspection,
    };
  }
  const after = await listed();
  if (!after.labeled) {
    throw new Error(
      `Attesting the name of profile ${config.profileSpace} committed, but ` +
        "its name still carries no label.",
    );
  }
  return { status: "attested", name: after.name };
}

/**
 * The most bytes a profile picture `setProfilePicture()` stores may hold:
 * 256 KiB. The shell's picture picker stores a 128-pixel square, which even
 * as uncompressed RGBA is 64 KiB, so this admits four times that, a larger
 * square or a less compressed one, and refuses a photograph straight off a
 * camera. Every list, cache and feed that carries a profile carries its
 * picture.
 */
export const PROFILE_PICTURE_MAX_BYTES = 256 * 1024;

/** The header sizes a BMP's DIB header may have, by the version it is. */
const BMP_DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

/**
 * Whether `bytes` opens as a raster image an `<img>` decodes, by its leading
 * bytes:
 *
 * - PNG: the eight-byte signature `89 50 4E 47 0D 0A 1A 0A`;
 * - JPEG: `FF D8 FF`;
 * - GIF: `GIF87a` or `GIF89a`;
 * - WebP: `RIFF`, any four bytes, then `WEBP`;
 * - BMP: `BM`, and at offset 14 a little-endian 32-bit DIB header size of
 *   12, 40, 52, 56, 64, 108 or 124;
 * - AVIF: an ISO BMFF `ftyp` box at offset 0 (a big-endian 32-bit size of at
 *   least 16, then `ftyp`) whose major brand, at offset 8, or one of whose
 *   compatible brands, from offset 16 to the box's end in steps of four, is
 *   `avif` or `avis`.
 *
 * It looks at nothing past those bytes, so a file that opens like an image
 * and is not one passes; what it keeps out is anything that does not open
 * like one, SVG among them.
 */
export function isRasterImage(bytes: Uint8Array): boolean {
  const ascii = (start: number, text: string) =>
    start + text.length <= bytes.length &&
    [...text].every((char, index) =>
      bytes[start + index] === char.charCodeAt(0)
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isAvif = () => {
    if (bytes.length < 16 || !ascii(4, "ftyp")) return false;
    const end = Math.min(view.getUint32(0), bytes.length);
    if (end < 16) return false;
    const brands = [8];
    for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(offset);
    return brands.some((offset) =>
      ascii(offset, "avif") || ascii(offset, "avis")
    );
  };
  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) =>
    bytes[index] === byte
  ) ||
    (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    ascii(0, "GIF87a") || ascii(0, "GIF89a") ||
    (ascii(0, "RIFF") && ascii(8, "WEBP")) ||
    (ascii(0, "BM") && bytes.length >= 18 &&
      BMP_DIB_HEADER_SIZES.has(view.getUint32(14, true))) ||
    isAvif();
}

/**
 * What `setProfilePicture()` needs: the profile, and the picture's bytes,
 * `keepCurrent: true` to set again the picture already stored, or
 * `clear: true` to remove it.
 */
export type ProfilePictureConfig =
  & ProfileTargetConfig
  & (
    /** The bytes of a raster image, stored as they are. */
    | { bytes: Uint8Array }
    /** Sets the profile's stored picture again, as its owner. */
    | { keepCurrent: true }
    /** Removes the picture and the legacy avatar text. */
    | { clear: true }
  );

/**
 * Sets the picture of the profile of `config.identity` whose space is
 * `config.profileSpace` to `config.bytes`, through the profile's own
 * `setPicture`. The bytes are stored as they are: nothing here crops or
 * scales them, as the shell's picture picker does to a 128-pixel square, so a
 * caller passes an image of the size it wants shown.
 *
 * With `config.keepCurrent` it sets the picture the profile already stores
 * again, which attests it to the identity making the call. A picture stored
 * before writes to it were labeled carries no label, so it is not attested
 * to its owner (`ListedProfile.pictureByOwner`) until its owner sets it
 * again this way.
 *
 * With `config.clear` it removes the picture, through `setPicture`, and the
 * legacy avatar text, through `setAvatar`, since a profile shows that text
 * wherever it has no picture: a person removing their picture expects none
 * to be shown.
 *
 * @throws Error when the bytes are more than `PROFILE_PICTURE_MAX_BYTES` or
 * are not a raster image (`isRasterImage()`), when `config.keepCurrent` is
 * given for a profile with no picture, when the home lists no such profile of
 * the identity's own or has retired it, or when a write fails or does not
 * land.
 */
export async function setProfilePicture(
  config: ProfilePictureConfig,
  deps: CreateProfileDeps = {},
): Promise<void> {
  const expected = "keepCurrent" in config
    ? await storedPicture(config, deps)
    : "bytes" in config
    ? config.bytes
    : undefined;
  if (expected !== undefined) {
    if (expected.length > PROFILE_PICTURE_MAX_BYTES) {
      throw new Error(
        `A profile picture can be at most ${PROFILE_PICTURE_MAX_BYTES} ` +
          `bytes (256 KiB), and this one is ${expected.length}. The ` +
          "shell stores a 128-pixel square; scale the image down first.",
      );
    }
    if (!isRasterImage(expected)) {
      throw new Error(
        "A profile picture must be a PNG, JPEG, GIF, WebP, AVIF or BMP image.",
      );
    }
  }
  await sendToProfile(
    config,
    expected === undefined
      ? [
        { stream: "setPicture", event: { clear: true } },
        { stream: "setAvatar", event: { clear: true } },
      ]
      : [{
        stream: "setPicture",
        event: { picture: new FabricBytes(expected) },
      }],
    expected === undefined
      ? `Removing the picture of profile ${config.profileSpace}`
      : `Setting the picture of profile ${config.profileSpace}`,
    (stored) => {
      const picture = pictureBytes(stored.picture);
      return expected === undefined
        ? picture === undefined && (stored.avatar ?? "") === ""
        : picture !== undefined && picture.length === expected.length &&
          picture.every((byte, index) => byte === expected[index]);
    },
    deps,
  );
}

/**
 * Helper for {@link setProfilePicture}, which returns the bytes of the
 * picture the listed profile of `config.identity` in `config.profileSpace`
 * stores, whoever set it.
 *
 * @throws Error when no listed profile lives there, or it has no picture.
 */
async function storedPicture(
  config: ProfileTargetConfig,
  deps: CreateProfileDeps,
): Promise<Uint8Array> {
  const listed = (await listProfiles(config, deps)).find((each) =>
    each.space === config.profileSpace
  );
  if (listed === undefined) {
    throw new Error(
      `No listed profile of ${config.space} lives in ${config.profileSpace}.`,
    );
  }
  if (listed.picture === undefined) {
    throw new Error(
      `The profile in ${config.profileSpace} has no picture to set again.`,
    );
  }
  return listed.picture;
}
