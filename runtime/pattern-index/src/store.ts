/**
 * What `cf` keeps on this machine about one pattern index: the key the
 * person's membership is rooted at, the chains other keys act through, and
 * which pattern each entry file last published as.
 *
 * The root key is made for the index alone and never doubles as the
 * person's Common Fabric identity, so nothing the index learns about the
 * root links to their spaces or profile, and losing it costs only index
 * standing an admin can move to a new key. It never leaves this directory:
 * `cf` signs with the identity key, presenting the chain the root issued to
 * it.
 *
 * One directory per index host, private to the user (0700, files 0600),
 * under `$XDG_STATE_HOME/commonfabric/pattern-index/` or
 * `~/.local/state/commonfabric/pattern-index/`, or under
 * `CF_PATTERN_INDEX_HOME` when set.
 */

import { join, resolve } from "@std/path";
import {
  type DIDKey,
  Identity,
  isCanonicalEd25519DID,
} from "@commonfabric/identity";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/bytes/base64url";
import { isObjectNotArray } from "@commonfabric/js-values/types";

/** What the store records about the person's membership on one index. */
export interface IndexMembershipRecord {
  /** The member's pseudonym on the index. */
  handle: string;

  role: "admin" | "user";

  /** The root key's DID: the key the invite was redeemed with. */
  root: DIDKey;
}

/** The record file's shape, which names itself so a reader knows it. */
interface MembershipFile extends IndexMembershipRecord {
  format: typeof MEMBERSHIP_FORMAT;

  /** Signer DID to the chain it presents, root first, in base64url. */
  chains: Record<string, string[]>;
}

/** The publish record's shape. */
interface PublishedFile {
  format: typeof PUBLISHED_FORMAT;

  /** Absolute entry file path to the ids it published as, oldest first. */
  entries: Record<string, string[]>;

  /** Absolute file path to the published pattern it was fetched from. */
  sources: Record<string, string>;

  /** Piece id to the published pattern it was created from. */
  pieces: Record<string, string>;
}

const MEMBERSHIP_FORMAT = "commonfabric/pattern-index-membership";
const PUBLISHED_FORMAT = "commonfabric/pattern-index-published";
const ROOT_KEY = "root.key";
const MEMBERSHIP = "membership.json";
const PUBLISHED = "published.json";

/**
 * The directory the store for the index at `baseUrl` lives in, from the
 * environment `env` reads.
 *
 * @throws Error when neither `CF_PATTERN_INDEX_HOME`, `XDG_STATE_HOME` nor
 *   `HOME` is set.
 */
export const patternIndexStoreDir = (
  baseUrl: string,
  env: (key: string) => string | undefined = (key) => Deno.env.get(key),
): string => {
  const host = new URL(baseUrl).host;
  const explicit = env("CF_PATTERN_INDEX_HOME");
  if (explicit) return resolve(explicit, host);
  const state = env("XDG_STATE_HOME");
  if (state) return resolve(state, "commonfabric", "pattern-index", host);
  const home = env("HOME");
  if (home) {
    return resolve(
      home,
      ".local",
      "state",
      "commonfabric",
      "pattern-index",
      host,
    );
  }
  throw new Error(
    "No place to keep pattern index membership: set CF_PATTERN_INDEX_HOME, XDG_STATE_HOME or HOME.",
  );
};

const isNotFound = (error: unknown): boolean =>
  error instanceof Deno.errors.NotFound;

/** The local record of one index's membership and publications. */
export class PatternIndexStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  get dir(): string {
    return this.#dir;
  }

  /** The index-only root key, or `undefined` when none was made here. */
  async rootKey(): Promise<Identity<DIDKey> | undefined> {
    let pkcs8: Uint8Array;
    try {
      pkcs8 = await Deno.readFile(join(this.#dir, ROOT_KEY));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    return await Identity.fromPkcs8(pkcs8);
  }

  /**
   * Makes a new index-only root key and keeps it, readable only by the
   * user.
   *
   * @throws Deno.errors.AlreadyExists when one is already kept: a root is
   *   never replaced in place, since losing it loses the membership.
   */
  async createRootKey(): Promise<Identity<DIDKey>> {
    await this.#ensureDir();
    const pkcs8 = await Identity.generatePkcs8();
    await Deno.writeFile(join(this.#dir, ROOT_KEY), pkcs8, {
      createNew: true,
      mode: 0o600,
    });
    return await Identity.fromPkcs8(pkcs8);
  }

  /** The recorded membership, or `undefined` before a join. */
  async membership(): Promise<IndexMembershipRecord | undefined> {
    const file = await this.#readMembership();
    if (file === undefined) return undefined;
    return { handle: file.handle, role: file.role, root: file.root };
  }

  /** Records the membership a join answered, keeping any chains held. */
  async recordMembership(record: IndexMembershipRecord): Promise<void> {
    const file = await this.#readMembership();
    await this.#writeJson(
      MEMBERSHIP,
      {
        format: MEMBERSHIP_FORMAT,
        ...record,
        chains: file?.chains ?? {},
      } satisfies MembershipFile,
    );
  }

  /** The chain `signer` presents, root first, or `undefined` for none. */
  async chainFor(signer: DIDKey): Promise<Uint8Array[] | undefined> {
    const file = await this.#readMembership();
    const chain = file?.chains[signer];
    return chain?.map((link) => fromBase64url(link));
  }

  /**
   * Keeps the chain `signer` presents, replacing any it held.
   *
   * @throws Error before a membership is recorded: a chain belongs to one.
   */
  async recordChain(
    signer: DIDKey,
    chain: readonly Uint8Array[],
  ): Promise<void> {
    const file = await this.#readMembership();
    if (file === undefined) {
      throw new Error("No index membership is recorded to hold a chain for");
    }
    await this.#writeJson(
      MEMBERSHIP,
      {
        ...file,
        chains: { ...file.chains, [signer]: chain.map(toUnpaddedBase64url) },
      } satisfies MembershipFile,
    );
  }

  /** The id `entryPath` last published as, or `undefined`. */
  async lastPublished(entryPath: string): Promise<string | undefined> {
    return (await this.#readPublished()).entries[resolve(entryPath)]?.at(-1);
  }

  /** The entry file that published `patternId` from this machine, if any. */
  async entryFor(patternId: string): Promise<string | undefined> {
    const { entries } = await this.#readPublished();
    return Object.entries(entries).find(([, ids]) => ids.includes(patternId))
      ?.[0];
  }

  /** Records that `entryPath` published as `patternId`. */
  async recordPublished(entryPath: string, patternId: string): Promise<void> {
    const file = await this.#readPublished();
    const key = resolve(entryPath);
    const ids = file.entries[key] ?? [];
    if (ids.at(-1) === patternId) return;
    await this.#writeJson(PUBLISHED, {
      ...file,
      entries: { ...file.entries, [key]: [...ids, patternId] },
    });
  }

  /** Records that the piece `pieceId` was created from `patternId`. */
  async recordIndexedPiece(pieceId: string, patternId: string): Promise<void> {
    const file = await this.#readPublished();
    await this.#writeJson(PUBLISHED, {
      ...file,
      pieces: { ...file.pieces, [pieceId]: patternId },
    });
  }

  /** The published pattern the piece `pieceId` was created from, if recorded. */
  async indexedPiece(pieceId: string): Promise<string | undefined> {
    return (await this.#readPublished()).pieces[pieceId];
  }

  /**
   * Records that each of `paths`, files just written from a published
   * pattern's source, came from `patternId`.
   */
  async recordSource(
    paths: readonly string[],
    patternId: string,
  ): Promise<void> {
    const file = await this.#readPublished();
    await this.#writeJson(PUBLISHED, {
      ...file,
      sources: {
        ...file.sources,
        ...Object.fromEntries(paths.map((path) => [resolve(path), patternId])),
      },
    });
  }

  /**
   * The published pattern the entry file at `entryPath` was fetched from, or
   * `undefined`. Only a file written from it counts, so new work beside or
   * below a fetched pattern is not credited to it.
   */
  async sourceOf(entryPath: string): Promise<string | undefined> {
    return (await this.#readPublished()).sources[resolve(entryPath)];
  }

  async #readMembership(): Promise<MembershipFile | undefined> {
    const parsed = await this.#readJson(MEMBERSHIP);
    if (parsed === undefined) return undefined;
    if (
      !isObjectNotArray(parsed) || parsed.format !== MEMBERSHIP_FORMAT ||
      typeof parsed.handle !== "string" ||
      (parsed.role !== "admin" && parsed.role !== "user") ||
      typeof parsed.root !== "string" || !isCanonicalEd25519DID(parsed.root) ||
      !isObjectNotArray(parsed.chains)
    ) {
      throw new Error(
        `${
          join(this.#dir, MEMBERSHIP)
        } is not a pattern index membership record`,
      );
    }
    return parsed as unknown as MembershipFile;
  }

  async #readPublished(): Promise<PublishedFile> {
    const parsed = await this.#readJson(PUBLISHED);
    if (parsed === undefined) {
      return { format: PUBLISHED_FORMAT, entries: {}, sources: {}, pieces: {} };
    }
    if (
      !isObjectNotArray(parsed) || parsed.format !== PUBLISHED_FORMAT ||
      !isObjectNotArray(parsed.entries) || !isObjectNotArray(parsed.sources) ||
      !isObjectNotArray(parsed.pieces)
    ) {
      throw new Error(
        `${join(this.#dir, PUBLISHED)} is not a pattern index publish record`,
      );
    }
    return parsed as unknown as PublishedFile;
  }

  async #readJson(name: string): Promise<unknown> {
    let text: string;
    try {
      text = await Deno.readTextFile(join(this.#dir, name));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${join(this.#dir, name)} is not JSON`);
    }
  }

  /** Writes beside and renames, so a reader never sees half a file. */
  async #writeJson(name: string, value: unknown): Promise<void> {
    await this.#ensureDir();
    const path = join(this.#dir, name);
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
      createNew: true,
      mode: 0o600,
    });
    await Deno.rename(temp, path);
  }

  async #ensureDir(): Promise<void> {
    await Deno.mkdir(this.#dir, { recursive: true, mode: 0o700 });
  }
}
