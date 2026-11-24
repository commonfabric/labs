/**
 * What a `wish` of a compared pattern resolves to in a run of the
 * comparison: a home space with one profile, seeded with the same values
 * for today's runtime and for the executor of `../exec/`.
 *
 * Today's runtime resolves its own `wish`
 * (`runtime/runner/src/builtins/wish.ts`) against documents that
 * `seedHome()` writes before the pattern is compiled:
 *
 * - The profile is a document of a space of its own, which holds the data
 *   members of the result of `patterns/system/profile-home/profile-home.tsx`
 *   with fixed values, under a schema that declares a user atom as its
 *   confidentiality. It carries the claim of whose profile it is
 *   (`profileOwnership()` in `runtime/runner/src/profile-order.ts`). It is
 *   not a running instance of that pattern: it has no stream and no view.
 * - The root of the home space, which is the space every scenario runs in,
 *   lists the profile and holds an empty list of mentionable pieces and an
 *   empty piece registry.
 *
 * The executor is given the same documents and a table (`options.wishes`)
 * that answers the operands of a `wish` with the outcome today's runtime
 * stores for them: references to those documents, or the outcome of a
 * search that matched nothing. A `wish` the table has no answer for is
 * recorded, and the comparison does not run a module that makes one.
 */
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../../runtime/runner/src/builder/types.ts";
import type { MemorySpace } from "../../../runtime/runner/src/cell.ts";
import type { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { seedProfileOwner } from "../../../runtime/runner/test/cfc-seed-envelope.ts";
import type { Instance } from "../exec/executor.ts";
import { identifierOf } from "../exec/store.ts";
import type { Probe } from "./harness.ts";

/** The data members of the seeded profile. */
export const PROFILE = {
  name: "Ada Lovelace",
  initialNameApplied: "Ada Lovelace",
  avatar: "",
  bio: "The seeded profile of the comparison.",
  externalLinks: [],
  verifiedIdentities: [],
  elements: [],
  isEditing: false,
};

/** What the root of the home space holds beside the list of profiles. */
const ROOT = { backlinksIndex: { mentionable: [] }, pieceRegistry: [] };

/** The space the profile is in. */
export const profileSpace = async (): Promise<MemorySpace> =>
  (await Identity.fromPassphrase("pattern-compiler-compare profile")).did();

/**
 * The schema the profile is written under: its confidentiality is the user
 * atom of `owner`, which each label entry of the document then holds.
 */
const profileSchema = (owner: string): JSONSchema => ({
  type: "object",
  properties: {
    name: { type: "string" },
    initialNameApplied: { type: "string" },
    avatar: { type: "string" },
    bio: { type: "string" },
    externalLinks: { type: "array", items: {} },
    verifiedIdentities: { type: "array", items: {} },
    elements: { type: "array", items: {} },
    isEditing: { type: "boolean" },
  },
  ifc: { confidentiality: [cfcAtom.user(owner)] },
} as JSONSchema);

/** A document of the seeded home, as the executor is given it. */
export type HomeDocument = {
  id: string;
  kind: string;
  value: unknown;
  space?: string;
};

/** The documents of a seeded home by what they are. */
export type Home = { profile: HomeDocument; root: HomeDocument };

const linkTo = (document: HomeDocument, path: string[] = []) => ({
  $link: { doc: document.id, path },
});

/** The documents of a home, from the identifiers of its two documents. */
const homeOf = (
  profile: { id: string; space: string },
  root: { id: string },
): Home => {
  const document = {
    id: profile.id,
    kind: "profile",
    value: structuredClone(PROFILE),
    space: profile.space,
  };
  return {
    profile: document,
    root: {
      id: root.id,
      kind: "space root",
      value: {
        defaultPattern: {
          profiles: [linkTo(document)],
          ...structuredClone(ROOT),
        },
      },
    },
  };
};

/**
 * The home of a run of the executor that has no storage: the documents
 * under identifiers of their own.
 */
export const memoryHome = async (): Promise<Home> =>
  homeOf(
    { id: identifierOf({ home: "profile" }), space: await profileSpace() },
    { id: identifierOf({ home: "root" }) },
  );

/**
 * Writes the home into the storage of `runtime`, whose user's home space
 * is `space`, and returns its documents under the identifiers the storage
 * holds them at. With `confidential` false, the profile is written under
 * no schema, so its label holds the claim of whose it is and no
 * confidentiality.
 */
export const seedHome = async (
  runtime: Runtime,
  space: MemorySpace,
  { confidential = true }: { confidential?: boolean } = {},
): Promise<Home> => {
  const committed = async (tx: ReturnType<Runtime["edit"]>) => {
    const { error } = await tx.commit().settled;
    if (error !== undefined) throw error;
  };
  const inProfile = await profileSpace();
  const written = runtime.edit();
  const profile = runtime.getCell(
    inProfile,
    "profile",
    confidential ? profileSchema(space) : undefined,
    written,
  );
  profile.set(structuredClone(PROFILE) as never);
  await committed(written);
  // The claim joins the label the commit above stored.
  const claimed = runtime.edit();
  seedProfileOwner(claimed, profile.getAsNormalizedFullLink(), space);
  await committed(claimed);
  const home = runtime.edit();
  // The root of a space is the cell the space's own identifier names
  // (`Runtime.getHomeSpaceCell()`, which a serving runtime refuses without
  // a demanding identity).
  const root = runtime.getCell(space, space, undefined, home);
  root.key("defaultPattern").set(
    {
      profiles: [runtime.getCell(inProfile, "profile", undefined, home)],
      ...structuredClone(ROOT),
    } as never,
  );
  await committed(home);
  return homeOf(
    { id: profile.getAsNormalizedFullLink().id, space: inProfile },
    { id: root.getAsNormalizedFullLink().id },
  );
};

/**
 * A probe that seeds the home when the runtime of a run exists, and then
 * does what `probe` does.
 */
export const withHome = (probe?: Probe): Probe => ({
  at: async (point, context) => {
    if (point === "created") {
      await seedHome(context.runtime, context.space as MemorySpace);
    }
    await probe?.at(point, context);
  },
});

/** The keys `getResolutionKind()` of today's `wish` does not search for. */
const WELL_KNOWN = new Set([
  "#default",
  "#mentionable",
  "#summaryIndex",
  "#knowledgeGraph",
  "#pieceRegistry",
  "#now",
  "#favorites",
  "#journal",
  "#learned",
  "#learnedSummary",
  "#agent_queue",
  "#chatManager",
  "#profile",
  "#profileName",
  "#profileBio",
  "#profileSpace",
  "#profilePicture",
  "#profileAvatar",
]);

/** The outcome of a `wish` that resolved to one reference. */
const resolved = (document: HomeDocument, path: string[]) => {
  const link = linkTo(document, path);
  return {
    result: link,
    candidates: [link],
    $UI: {
      type: "vnode",
      name: "cf-cell-link",
      props: { $cell: link },
      children: [],
    },
  };
};

/** The outcome of a search that matched nothing, as `wish` reports it. */
const noMatch = (message: string) => ({
  candidates: [],
  error: message,
  errorCode: "no-match",
  $UI: {
    type: "vnode",
    name: "span",
    props: { style: "color: red" },
    children: [`⚠️ ${message}`],
  },
});

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((member) => typeof member === "string")
    ? value
    : undefined;

/**
 * The outcome today's `wish` stores for `operands` in the seeded home, or
 * `undefined` for operands the comparison does not simulate:
 *
 * - `#profile`, `#profileName` and `#profileBio` are a reference to the
 *   profile, to its `initialNameApplied` and to its `bio`
 *   (`resolveHomeSpaceTarget()`).
 * - `#mentionable` and `#pieceRegistry`, in the current space, are a
 *   reference to the path of the root of the space that holds the empty
 *   list (`resolveSpaceTarget()`).
 * - Any tag that is none of the well-known ones is a search of the
 *   favorites, the mentionable pieces and the elements of the profile,
 *   which are all empty, so it matches nothing (`searchByHashtag()`).
 *
 * The clock (`#now`) is the executor's own.
 */
export const simulatedOutcome = (
  operands: Record<string, unknown>,
  home: Home,
): Record<string, unknown> | undefined => {
  const { query } = operands;
  if (typeof query !== "string" || !query.trim().startsWith("#")) {
    return undefined;
  }
  const extra = operands.path === undefined ? [] : strings(operands.path);
  const scope = operands.scope === undefined
    ? undefined
    : strings(operands.scope);
  if (extra === undefined) return undefined;
  if (operands.scope !== undefined && scope === undefined) return undefined;
  const segments = query.trim().slice(1).split("/").filter((segment) =>
    segment.length > 0
  );
  if (segments.length === 0) return undefined;
  const key = `#${segments[0]}`;
  const path = [...segments.slice(1), ...extra];
  switch (key) {
    case "#profile":
      return path[0] === "picture" || path[0] === "avatar"
        ? undefined
        : resolved(home.profile, path);
    case "#profileName":
      return resolved(home.profile, ["initialNameApplied", ...path]);
    case "#profileBio":
      return resolved(home.profile, ["bio", ...path]);
    case "#mentionable":
    case "#pieceRegistry":
      // With another scope than the current space, the target is in
      // another root.
      return scope === undefined || (scope.length === 1 && scope[0] === ".")
        ? resolved(
          home.root,
          key === "#mentionable"
            ? ["defaultPattern", "backlinksIndex", "mentionable", ...path]
            : ["defaultPattern", "pieceRegistry", ...path],
        )
        : undefined;
  }
  if (WELL_KNOWN.has(key)) return undefined;
  if (
    scope !== undefined &&
    scope.some((entry) => entry !== "~" && entry !== "." && entry !== "profile")
  ) {
    return undefined;
  }
  const searched = [
    ...(scope === undefined || scope.includes("~") ? ["favorites"] : []),
    ...(scope?.includes(".") ? ["mentionables"] : []),
    ...(scope?.includes("profile") ? ["profile"] : []),
  ];
  return noMatch(
    `No ${searched.join(" or ") || "favorites"} found matching ` +
      `"${key.toLowerCase()}"`,
  );
};

/**
 * The positions of the home that today's `wish` reads to resolve
 * `operands`, as the executor reports them for the outcome: the list of
 * profiles of the root for a target in the profile, nothing for a target at
 * a path of the root of the space, and for a search what it searches of the
 * seeded home, the mentionable pieces of the root and the elements of the
 * profile.
 */
export const simulatedReads = (
  operands: Record<string, unknown>,
  home: Home,
): { doc: string; path: string[] }[] => {
  const query = typeof operands.query === "string" ? operands.query.trim() : "";
  const key = `#${query.slice(1).split("/")[0]}`;
  if (["#profile", "#profileName", "#profileBio"].includes(key)) {
    return [{ doc: home.root.id, path: ["defaultPattern", "profiles"] }];
  }
  if (WELL_KNOWN.has(key)) return [];
  const scope = strings(operands.scope) ?? [];
  return [
    ...(scope.includes(".")
      ? [{
        doc: home.root.id,
        path: ["defaultPattern", "backlinksIndex", "mentionable"],
      }]
      : []),
    ...(scope.includes("profile")
      ? [{ doc: home.profile.id, path: ["elements"] }]
      : []),
  ];
};

/** What the executor of a run is given for its `wish` operations. */
export type HomeStubs = {
  documents: HomeDocument[];
  wishes: NonNullable<Instance["options"]["wishes"]>;
  /**
   * The query of each `wish` the executor resolved that the table has no
   * answer for, as text.
   */
  unsimulated: string[];
};

/** The documents of `home` and the table that answers from them. */
export const homeStubs = (home: Home): HomeStubs => {
  const unsimulated: string[] = [];
  return {
    documents: [home.profile, home.root],
    wishes: (operands) => {
      const outcome = simulatedOutcome(operands, home);
      if (outcome !== undefined) {
        return { outcome, reads: simulatedReads(operands, home) };
      }
      const text = typeof operands.query === "string"
        ? operands.query
        : "a query that is no text";
      // The clock is the executor's own.
      if (/^#now(\/|$)/.test(text.trim())) return undefined;
      if (!unsimulated.includes(text)) unsimulated.push(text);
      return undefined;
    },
    unsimulated,
  };
};

/** Whether a plan has an operation of kind `wish`. */
export const hasWish = (plan: { operations?: { kind?: string }[] }): boolean =>
  (plan.operations ?? []).some(({ kind }) => kind === "wish");
