import { isDID } from "@commonfabric/identity/did";

import type { Cell } from "./cell.ts";
import type { Runtime } from "./runtime.ts";
import type { MemorySpace } from "./storage/interface.ts";
import type { URI } from "./sigil-types.ts";
import {
  type FabricRef,
  formatFabricRef,
} from "./sandbox/fabric-import-specifier.ts";
import {
  resolveSlugTargetCell,
  SlugResolutionError,
} from "./slug-resolution.ts";
import { getPatternIdentityRef } from "./runner.ts";

export interface FabricChaseResult {
  entryIdentity: string;

  /** Human-readable hops for errors/tooling. */
  chain: string[];
}

export async function resolveFabricRefToIdentity(
  runtime: Runtime,
  compilingSpace: MemorySpace,
  ref: FabricRef,
): Promise<FabricChaseResult> {
  const specifier = formatFabricRef(ref);
  if (ref.subpath !== undefined) {
    throw new Error(`subpaths not yet supported (M4): ${specifier}`);
  }
  const refSpace = resolveRefSpace(ref.space, compilingSpace);

  if (ref.ref.kind === "uri" && ref.ref.scheme === "pattern") {
    return done(ref.ref.hash, [`pattern:${ref.ref.hash}`]);
  }

  const chain: string[] = [];
  let cell: Cell<unknown>;
  if (ref.ref.kind === "slug") {
    chain.push(`slug:${ref.ref.slug}`);
    try {
      cell = await resolveSlugTargetCell(runtime, refSpace, ref.ref.slug);
    } catch (cause) {
      if (cause instanceof SlugResolutionError) {
        throw new Error(`${cause.message} (chain: ${formatChain(chain)})`, {
          cause,
        });
      }
      throw cause;
    }
  } else {
    // The URI scheme is part of the identity: an of: ref and a computed: ref
    // with the same hash name different entities, so sync the schemed URI
    // string as-is — stripping it to a bare hash would rename a computed ref
    // to its of: sibling.
    const patternId = `${ref.ref.scheme}:fid1:${ref.ref.hash}` as URI;
    chain.push(`uri:${patternId}`);
    cell = runtime.getCellFromEntityId(refSpace, patternId);
    await cell.sync();
  }

  return await resolveCellToIdentity(specifier, cell, chain);
}

function resolveRefSpace(
  refSpace: string | undefined,
  compilingSpace: MemorySpace,
): MemorySpace {
  if (refSpace === undefined) return compilingSpace;
  if (isDID(refSpace)) return refSpace;
  throw new Error(
    "space names are currently unsupported; resolve the name to a DID first",
  );
}

function resolveCellToIdentity(
  specifier: string,
  cell: Cell<unknown>,
  chain: string[],
): Promise<FabricChaseResult> {
  const link = cell.getAsNormalizedFullLink();
  const identityRef = getPatternIdentityRef(cell);

  if (identityRef !== undefined) {
    chain.push(`piece:${link.id}`);
    chain.push(`patternIdentity:${identityRef.identity}`);
    return Promise.resolve(done(identityRef.identity, chain));
  }

  throw new Error(
    `${specifier} does not resolve to a pattern (chain: ${formatChain(chain)})`,
  );
}

function done(entryIdentity: string, chain: string[]): FabricChaseResult {
  return {
    entryIdentity,
    chain: [...chain, `entryIdentity:${entryIdentity}`],
  };
}

function formatChain(chain: readonly string[]): string {
  return chain.join(" -> ");
}
