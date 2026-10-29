/**
 * Vetting a shared space as its user, before the host acts on it: that the
 * user may write there, that the space is the kind it is taken for, and that
 * its root is what that kind's contract asks for. Share intake and visits to
 * standalone rooms use this contract. Container visits share the access and
 * own-root checks. Vetting reads the access list, kind, and root, and the
 * root's stored result schema where the kind's contract turns on it, and loads
 * and runs none of the space's code.
 */

import type { JSONSchema } from "@commonfabric/api";
import { debugStr } from "@commonfabric/data-model";
import { classifySchemaMetaValue } from "@commonfabric/data-model-schema/schema-refs";
import type { DID } from "@commonfabric/identity";
import { type ACL, hasConcreteOwner, isACL } from "@commonfabric/memory/acl";
import {
  ACLManager,
  type Cell,
  inSpaceRootCause,
  isCell,
  readResultSchemaMeta,
  type Runtime,
} from "@commonfabric/runner";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { accessRefused } from "./space-access.ts";

/** The kind of space a standalone FabriChat room's own space declares. */
export const CHAT_ROOM_SPACE_KIND = "fabrichat-room";

/** The kind of space a social Loom's own space declares. */
export const LOOM_SPACE_KIND = "loom";

/** Why a space fails vetting. */
export type SpaceRefusal =
  | "recipient-access-refused"
  | "space-kind-undeclared"
  | "space-kind-mismatch"
  | "space-root-missing"
  | "space-root-misplaced"
  | "space-root-mismatch";

/**
 * What a kind's contract asks of a space beyond the kind its creator declared,
 * as `docs/features/space-kinds.md` lists the kind.
 */
interface KindContract {
  /** Whether a space declaring no kind passes the kind check. */
  admitsUndeclared: boolean;

  /**
   * Why `root`, a piece of `space`, fails the kind's root check, or
   * `undefined` when it passes.
   */
  rootRefusal(
    runtime: Runtime,
    space: DID,
    root: Cell<unknown>,
  ): SpaceRefusal | undefined | Promise<SpaceRefusal | undefined>;
}

/**
 * The contract of each kind a space is vetted as. A `fabrichat-room` space
 * declares the kind, and its root is the document at the address the space's
 * genesis commit reserves for an `inSpace(..., { root: true })` root, so that
 * a root a member with `WRITE` has linked in place of that one is refused. A
 * `loom` space declares the kind or, created before the kind was declared,
 * none, and its root is whatever the space links, held to a Loom's
 * composition by its stored result schema: a migration may link another Loom
 * as the root, and a member with `WRITE`, who can change everything the root
 * holds, can link another too.
 */
const KIND_CONTRACTS: ReadonlyMap<string, KindContract> = new Map([
  [CHAT_ROOM_SPACE_KIND, {
    admitsUndeclared: false,
    rootRefusal: reservedRootRefusal,
  }],
  [LOOM_SPACE_KIND, { admitsUndeclared: true, rootRefusal: loomRootRefusal }],
]);

/**
 * Vets `space` as `identity`, for a space of `kind`, returning its root, or
 * the reason it is refused. A space passes when:
 *
 * - the identity can open it, holding `WRITE` or `OWNER` there, through an
 *   entry of its own or the grant to every principal (`"*"`);
 * - it declares `kind` as its own kind, as `Runtime.spaceKind()` reads it from
 *   the space's genesis commit, which is its creator's claim, or declares no
 *   kind where `kind`'s contract admits that;
 * - it has a root, a document of the space itself, and the root is what
 *   `kind`'s contract asks for, as {@link KIND_CONTRACTS} states it.
 *
 * `admits`, when given, is asked first, of the space's access list as stored,
 * which reads as `undefined` when it is malformed or names no concrete owner
 * and so grants nobody anything; a refusal it returns is the space's.
 *
 * @throws When `kind` is not one {@link KIND_CONTRACTS} lists; when reading
 *   the space's access list or root fails other than by a refusal of access;
 *   when the host cannot tell the space's kind; or when what the kind's root
 *   check reads of the root cannot be read.
 */
export async function vetSpace<Refusal extends string = never>(
  runtime: Runtime,
  space: DID,
  identity: DID,
  kind: string,
  admits?: (acl: ACL | undefined) => Refusal | undefined,
): Promise<SpaceRefusal | Refusal | Cell<unknown>> {
  const contract = KIND_CONTRACTS.get(kind);
  if (contract === undefined) {
    throw new Error(
      debugStr`No root contract is listed for the space kind $quote${kind}`,
    );
  }
  const writable = await readWritableSpace(runtime, space, identity, admits);
  if (typeof writable === "string") return writable;
  const { root } = writable;
  // An access list naming a concrete owner was written by the space's genesis
  // commit or after it, so the kind read here is the one the space keeps.
  const declared = await runtime.spaceKind(space);
  if (declared === undefined) {
    if (!contract.admitsUndeclared) return "space-kind-undeclared";
  } else if (declared !== kind) return "space-kind-mismatch";
  if (!isOwnRoot(root, space)) return "space-root-missing";
  return (await contract.rootRefusal(runtime, space, root)) ?? root;
}

/**
 * Returns a writable space's own document root, with no constraint on its
 * declared kind or root reservation. Access failures use the same refusals
 * as `vetSpace()`.
 */
export async function vetWritableSpaceRoot(
  runtime: Runtime,
  space: DID,
  identity: DID,
): Promise<SpaceRefusal | Cell<unknown>> {
  const writable = await readWritableSpace(runtime, space, identity);
  if (typeof writable === "string") return writable;
  return isOwnRoot(writable.root, space) ? writable.root : "space-root-missing";
}

/** Reads a space's root and requires the identity's write access to it. */
async function readWritableSpace<Refusal extends string = never>(
  runtime: Runtime,
  space: DID,
  identity: DID,
  admits?: (acl: ACL | undefined) => Refusal | undefined,
): Promise<SpaceRefusal | Refusal | { root: unknown }> {
  let stored;
  let root;
  try {
    stored = await new ACLManager(runtime, space).getStored();
    root = await runtime.getSpaceCell(space).key("defaultPattern").pull();
  } catch (error) {
    if (accessRefused(runtime, space)) return "recipient-access-refused";
    throw error;
  }
  if (accessRefused(runtime, space)) return "recipient-access-refused";
  const acl = isACL(stored) && hasConcreteOwner(stored) ? stored : undefined;
  const refusal = admits?.(acl);
  if (refusal !== undefined) return refusal;
  if (!isWriter(acl?.[identity] ?? acl?.["*"])) {
    return "recipient-access-refused";
  }
  return { root };
}

/**
 * Why `root` fails as the root of a space whose genesis commit reserves its
 * root's address: it is not the document at the address `inSpaceRootCause()`
 * derives in the space.
 */
function reservedRootRefusal(
  runtime: Runtime,
  space: DID,
  root: Cell<unknown>,
): SpaceRefusal | undefined {
  return root.equalLinks(runtime.getCell(space, inSpaceRootCause(space)))
    ? undefined
    : "space-root-misplaced";
}

/**
 * The schema that loads a root's document alone: none of the documents its
 * fields link, and none of its code.
 */
const DOCUMENT_ALONE = { type: "object", properties: {} } as const;

/**
 * Why `root` fails as a `loom` space's root: the result schema its setup
 * stored is not a Loom's composition, as {@link isLoomComposition} reads one.
 * Reads the root's document and nothing it links.
 *
 * @throws When the schema is stored as a reference to documents that have not
 *   reached this host, so that whether the root is a Loom cannot be told yet.
 */
async function loomRootRefusal(
  _runtime: Runtime,
  _space: DID,
  root: Cell<unknown>,
): Promise<SpaceRefusal | undefined> {
  await root.asSchema(DOCUMENT_ALONE).pull();
  const schema = readResultSchemaMeta(root);
  if (classifySchemaMetaValue(schema).kind === "reference") {
    throw new Error(
      "The root's result schema refers to documents that have not arrived",
    );
  }
  return isLoomComposition(schema) ? undefined : "space-root-mismatch";
}

/**
 * Whether `schema`, a piece's result schema, is a Loom's public composition:
 * an object whose `panels` is an array, and whose `addPanel` and
 * `removePanel` are streams.
 */
function isLoomComposition(schema: JSONSchema | undefined): boolean {
  if (
    !isObjectNotArray(schema) || schema.type !== "object" ||
    !isObjectNotArray(schema.properties)
  ) return false;
  const { panels, addPanel, removePanel } = schema.properties;
  return isObjectNotArray(panels) && panels.type === "array" &&
    isStream(addPanel) && isStream(removePanel);
}

/** Whether `property`, a result schema's property, describes a stream. */
function isStream(property: unknown): boolean {
  return isObjectNotArray(property) && Array.isArray(property.asCell) &&
    property.asCell.includes("stream");
}

/** Whether a space's root pointer names a document of that same space. */
function isOwnRoot(root: unknown, space: DID): root is Cell<unknown> {
  // A pointer into another space can read as the space cell's own
  // `defaultPattern` key, which the empty-path check refuses.
  return isCell(root) && root.space === space &&
    root.getAsNormalizedFullLink().path.length === 0;
}

/** Whether an access-list grant lets its holder write. */
export function isWriter(grant: unknown): boolean {
  return grant === "WRITE" || grant === "OWNER";
}
