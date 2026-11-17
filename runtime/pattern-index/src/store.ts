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
const PENDING_MOVE = "pending-root-move";
const NOTED_NOT_JOINED = "noted-not-joined";
const SLOT_KEY = "slot.key";
const KEEPS_VERSIONS = "keeps-versions";

/**
 * The directory every index's store lives under, one subdirectory per index
 * host, from the environment `env` reads.
 *
 * @throws Error when neither `CF_PATTERN_INDEX_HOME`, `XDG_STATE_HOME` nor
 *   `HOME` is set.
 */
export const patternIndexStoreRoot = (
  env: (key: string) => string | undefined = (key) => Deno.env.get(key),
): string => {
  const explicit = env("CF_PATTERN_INDEX_HOME");
  if (explicit) return resolve(explicit);
  const state = env("XDG_STATE_HOME");
  if (state) return resolve(state, "commonfabric", "pattern-index");
  const home = env("HOME");
  if (home) {
    return resolve(home, ".local", "state", "commonfabric", "pattern-index");
  }
  throw new Error(
    "No place to keep pattern index membership: set CF_PATTERN_INDEX_HOME, XDG_STATE_HOME or HOME.",
  );
};

/** The directory the store for the index at `baseUrl` lives in. */
export const patternIndexStoreDir = (
  baseUrl: string,
  env: (key: string) => string | undefined = (key) => Deno.env.get(key),
): string => join(patternIndexStoreRoot(env), new URL(baseUrl).host);

/**
 * The store, among those under `root`, that recorded the piece `pieceId` as
 * created from a published pattern, and that pattern; `undefined` for none.
 * A piece remembers the index it came from only through this record.
 */
export const findIndexedPiece = async (
  root: string,
  pieceId: string,
): Promise<{ store: PatternIndexStore; patternId: string } | undefined> => {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(root));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const store = new PatternIndexStore(join(root, entry.name));
    const patternId = await store.indexedPiece(pieceId);
    if (patternId !== undefined) return { store, patternId };
  }
  return undefined;
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
    await this.#checkPrivate();
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

  /**
   * Records the membership a join answered, keeping the chains held when the
   * root is unchanged. A new root drops them: chains from the old one no
   * longer reach the member.
   */
  async recordMembership(record: IndexMembershipRecord): Promise<void> {
    const file = await this.#readMembership();
    await this.#writeJson(
      MEMBERSHIP,
      {
        format: MEMBERSHIP_FORMAT,
        ...record,
        chains: file !== undefined && file.root === record.root
          ? file.chains
          : {},
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

  /**
   * The CID of a root-move delegation this machine sent and has not seen
   * answered, or `undefined`. A rerun of that same move may find it already
   * spent, and this is what says the move was this machine's to finish.
   */
  async pendingRootMove(): Promise<string | undefined> {
    await this.#checkPrivate();
    try {
      return (await Deno.readTextFile(join(this.#dir, PENDING_MOVE))).trim();
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /** Records `cid` as the root move being sent, or clears it with `undefined`. */
  async recordPendingRootMove(cid: string | undefined): Promise<void> {
    await this.#ensureDir();
    const path = join(this.#dir, PENDING_MOVE);
    if (cid === undefined) {
      await Deno.remove(path).catch((error) => {
        if (!isNotFound(error)) throw error;
      });
      return;
    }
    await Deno.writeTextFile(path, `${cid}\n`, { mode: 0o600 });
  }

  /**
   * Whether this index has answered as one that keeps private versions. An
   * index from before them stores whatever it is sent where anyone may
   * fetch it by id, so `cf` sends a deploy's source only once this is true.
   */
  async keepsVersions(): Promise<boolean> {
    return await this.#hasMarker(KEEPS_VERSIONS);
  }

  /** Records that this index keeps private versions. */
  async recordKeepsVersions(): Promise<void> {
    await this.#ensureDir();
    await Deno.writeTextFile(join(this.#dir, KEEPS_VERSIONS), "", {
      mode: 0o600,
    });
  }

  /**
   * The secret this machine keys lineage slots of files outside a git
   * checkout with, made on first use, so the index cannot confirm a guessed
   * path from a slot. It never leaves this directory.
   */
  async slotKey(): Promise<Uint8Array> {
    await this.#ensureDir();
    const path = join(this.#dir, SLOT_KEY);
    const existing = await this.#readSlotKey(path);
    if (existing !== undefined) return existing;
    // Written beside and linked into place, so the key appears only once
    // whole; a process that loses the race to make it reads the winner's.
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeFile(temp, crypto.getRandomValues(new Uint8Array(32)), {
      createNew: true,
      mode: 0o600,
    });
    const linked = await Deno.link(temp, path).then(
      () => undefined,
      (error: unknown) => error,
    );
    await Deno.remove(temp);
    // Linked, or another process linked its key first: either way the key
    // is there now, and only a link that failed for another reason left
    // none.
    const key = await this.#readSlotKey(path);
    if (key === undefined) throw linked;
    return key;
  }

  /**
   * Whether `cf` has told the person that it keeps no versions because this
   * machine never joined the index, which it says only once.
   */
  async notedNotJoined(): Promise<boolean> {
    return await this.#hasMarker(NOTED_NOT_JOINED);
  }

  /** Records that the person has been told. */
  async recordNotedNotJoined(): Promise<void> {
    await this.#ensureDir();
    await Deno.writeTextFile(join(this.#dir, NOTED_NOT_JOINED), "", {
      mode: 0o600,
    });
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

  /**
   * The slot key at `path`, `undefined` where there is none.
   *
   * @throws Error for a key file that is not 32 bytes, which no version of
   *   this store wrote.
   */
  async #readSlotKey(path: string): Promise<Uint8Array | undefined> {
    let key: Uint8Array;
    try {
      key = await Deno.readFile(path);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    if (key.length !== 32) {
      throw new Error(`${path} is not a slot key; remove it to make a new one`);
    }
    return key;
  }
  /** Whether the marker file `name` exists in the store. */
  async #hasMarker(name: string): Promise<boolean> {
    await this.#checkPrivate();
    try {
      await Deno.lstat(join(this.#dir, name));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
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
    await this.#checkPrivate();
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
    await this.#checkPrivate();
  }

  /**
   * Refuses a store directory that is a symbolic link or that anyone but
   * the user can read or write: it holds the key the membership is rooted
   * at. A directory that does not exist yet has nothing to refuse.
   */
  async #checkPrivate(): Promise<void> {
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(this.#dir);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (
      info.isSymlink || !info.isDirectory ||
      (info.mode !== null && (info.mode & 0o077) !== 0)
    ) {
      throw new Error(
        `${this.#dir} must be a directory only you can read (mode 0700), not a symbolic link`,
      );
    }
  }
}
