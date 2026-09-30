import { isDID } from "@commonfabric/identity/did";
import type { ProgramResolver, Source } from "@commonfabric/js-compiler";
import { getLogger } from "@commonfabric/utils/logger";

import {
  loadVerifiedSourceClosure,
  type SourceDoc,
} from "../compilation-cache/cell-cache.ts";
import { resolveFabricRefToIdentity } from "../fabric-ref-resolution.ts";
import type { MemorySpace, Runtime } from "../runtime.ts";
import {
  parseFabricRef,
  pinnedIdentity,
} from "../sandbox/fabric-import-specifier.ts";
import {
  FABRIC_MOUNT_ROOT,
  type FabricMount,
} from "../sandbox/module-record-compiler.ts";
import { compilerStack } from "./deferred-compiler-stack.ts";
import type { FabricImportOptions, ResolvedFabricPin } from "./types.ts";

const MAX_FABRIC_MOUNTS = 32;
const logger = getLogger("fabric-resolver");

export interface FabricResolutionContext extends FabricImportOptions {
  runtime: Runtime;
}

export class FabricAwareResolver implements ProgramResolver {
  #mountedFiles = new Map<string, Source>();
  #mountByIdentity = new Map<string, FabricMount>();
  #entrySourceByIdentity = new Map<string, Source>();
  #specifierAliases = new Map<string, string>();
  #resolvedPins: ResolvedFabricPin[] = [];

  readonly #inner: ProgramResolver;
  readonly #ctx: FabricResolutionContext;

  constructor(
    inner: ProgramResolver,
    ctx: FabricResolutionContext,
  ) {
    this.#inner = inner;
    this.#ctx = ctx;
  }

  main(): Promise<Source> {
    return this.#inner.main();
  }

  /**
   * Forwards to the wrapped resolver, like the rest of the interface. A wrapper
   * that answers for part of a resolver and quietly drops the rest is the shape
   * this whole seam exists to avoid.
   */
  resolveDataFile(name: string): Promise<Source | undefined> {
    return this.#inner.resolveDataFile
      ? this.#inner.resolveDataFile(name)
      : this.#inner.resolveSource(name);
  }

  async resolveSource(identifier: string): Promise<Source | undefined> {
    if (identifier.startsWith(FABRIC_MOUNT_ROOT)) {
      return this.#mountedFiles.get(identifier);
    }

    const ref = parseFabricRef(identifier);
    if (ref === undefined) {
      return await this.#inner.resolveSource(identifier);
    }

    if (ref.host !== undefined) {
      throw new Error("cross-host fabric refs not yet supported (M3)");
    }
    if (ref.subpath !== undefined) {
      throw new Error("subpaths not yet supported (M4)");
    }

    let identity = pinnedIdentity(ref);
    const sourceSpace = this.#sourceSpaceFor(ref.space);
    if (identity === undefined) {
      if (this.#ctx.allowUnpinned !== true) {
        throw new Error(
          `unpinned fabric import '${identifier}'; pin it (cf deps update) or deploy to pin`,
        );
      }
      const resolved = await resolveFabricRefToIdentity(
        this.#ctx.runtime,
        this.#ctx.space,
        ref,
      );
      identity = resolved.entryIdentity;
      this.#resolvedPins.push({
        specifier: identifier,
        resolvedIdentity: identity,
        chain: resolved.chain,
      });
    }

    const existing = this.#mountByIdentity.get(identity);
    if (existing !== undefined) {
      if (!existing.specifiers.includes(identifier)) {
        existing.specifiers.push(identifier);
      }
      this.#specifierAliases.set(identifier, existing.entryPath);
      return this.#entrySourceByIdentity.get(identity);
    }

    if (this.#mountByIdentity.size >= MAX_FABRIC_MOUNTS) {
      throw new Error("fabric import graph too deep/large");
    }

    if (sourceSpace !== this.#ctx.space) {
      logger.info("fabric-import-cross-space", () => [
        `source=${sourceSpace}`,
        `dest=${this.#ctx.space}`,
        `entry=${identity}`,
      ]);
    }

    const docs = await this.#loadSourceClosure(identity, sourceSpace);
    if (docs === undefined) {
      throw new Error(this.#notFoundMessage(identity, sourceSpace));
    }
    this.#assertNoRootAbsoluteImports(identity, docs);

    const entryDoc = docs.get(identity);
    if (entryDoc === undefined) {
      throw new Error(this.#notFoundMessage(identity, sourceSpace));
    }
    const entryPath = this.#mountPath(identity, entryDoc.filename);
    const mount: FabricMount = {
      entryIdentity: identity,
      entryPath,
      specifiers: [identifier],
    };

    for (const doc of docs.values()) {
      const source: Source = {
        name: this.#mountPath(identity, doc.filename),
        contents: doc.code,
      };
      this.#mountedFiles.set(source.name, source);
      if (source.name === entryPath) {
        this.#entrySourceByIdentity.set(identity, source);
      }
    }

    this.#mountByIdentity.set(identity, mount);
    this.#specifierAliases.set(identifier, entryPath);
    return this.#entrySourceByIdentity.get(identity);
  }

  mounts(): FabricMount[] {
    return [...this.#mountByIdentity.values()].map((mount) => ({
      ...mount,
      specifiers: [...mount.specifiers],
    }));
  }

  specifierAliases(): Map<string, string> {
    return new Map(this.#specifierAliases);
  }

  resolvedPins(): ResolvedFabricPin[] {
    return this.#resolvedPins.map((pin) => ({
      ...pin,
      chain: [...pin.chain],
    }));
  }

  async #loadSourceClosure(
    identity: string,
    space: MemorySpace,
  ): Promise<Map<string, SourceDoc> | undefined> {
    const tx = this.#ctx.runtime.edit();
    try {
      return await loadVerifiedSourceClosure(
        this.#ctx.runtime,
        space,
        identity,
        tx,
      );
    } finally {
      tx.abort?.("fabric source closure read complete");
    }
  }

  #assertNoRootAbsoluteImports(
    identity: string,
    docs: ReadonlyMap<string, SourceDoc>,
  ): void {
    // Deferred compiler stack (parses): this runs under resolveSource, whose
    // flows load source closures and compile — ensureCompilerStack() is
    // awaited by loadVerifiedSourceClosure before any doc reaches here.
    const { collectImportSpecifiers, ts } = compilerStack();
    for (const doc of docs.values()) {
      const source = { name: doc.filename, contents: doc.code };
      for (
        const specifier of collectImportSpecifiers(
          source,
          ts.ScriptTarget.ES2023,
        )
      ) {
        if (specifier.startsWith("/")) {
          throw new Error(
            `imported pattern ${identity} uses root-absolute imports; not supported`,
          );
        }
      }
    }
  }

  #mountPath(identity: string, filename: string): string {
    return `${FABRIC_MOUNT_ROOT}${identity}${filename}`;
  }

  #notFoundMessage(identity: string, space: MemorySpace): string {
    return `source for pattern:${identity} not found in space ${space} (or failed integrity verification)`;
  }

  #sourceSpaceFor(refSpace: string | undefined): MemorySpace {
    if (refSpace === undefined) return this.#ctx.space;
    if (isDID(refSpace)) return refSpace;
    throw new Error(
      "space names are currently unsupported; resolve the name to a DID first",
    );
  }
}
