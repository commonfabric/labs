import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import type { PieceController } from "@commonfabric/piece/ops";
import { linkRefFrom } from "@commonfabric/runner/shared";

import { CfcProjectionAnnotator } from "../annotations.ts";
import {
  CFC_WRITEBACK_FINALIZE_XATTR,
  CFC_WRITEBACK_PREPARE_XATTR,
  type CfcEnforcementMode,
  CfcWritebackStore,
} from "../cfc-writeback.ts";
import {
  createFuseOperations,
  dumpOpRing,
  type FuseOperations,
  type FuseOperationsOptions,
  type FuseReplySymbols,
  registerFuseOperations,
} from "../operations.ts";
import darwinPlatform from "../platform-darwin.ts";
import linuxPlatform, { STAT_LAYOUT } from "../platform-linux.ts";
import {
  DIR_MODE,
  EACCES,
  EBADF,
  EINVAL,
  EIO,
  EISDIR,
  ENOENT,
  ENOTDIR,
  ERANGE,
  EROFS,
  EXDEV,
  FILE_MODE,
  FILE_MODE_RW,
  O_RDONLY,
  O_RDWR,
  O_WRONLY,
} from "../platform.ts";
import { FsTree } from "../tree.ts";
import { EMPTY, FakeBridge, fakePiece, writePath } from "./fake-bridge.ts";

//
// Recording replies
//

/** The attributes a reply carried, as the kernel would read them. */
interface Attr {
  ino: bigint;
  mode: number;
  size: number;
  mtimeSeconds: bigint;
}

/** One reply the operations sent, decoded from the structs it pointed at. */
type Reply =
  | { kind: "err"; errno: number }
  | { kind: "entry"; ino: bigint; attr: Attr; timeout: number }
  | { kind: "attr"; attr: Attr; timeout: number }
  | { kind: "data"; text: string }
  | { kind: "dirents"; names: string[]; offsets: bigint[] }
  | { kind: "open"; fh: bigint }
  | { kind: "readlink"; target: string }
  | { kind: "write"; size: number }
  | { kind: "create"; ino: bigint; attr: Attr; fh: bigint }
  | { kind: "xattr"; size: number }
  | { kind: "none" };

const decoder = new TextDecoder();
const STAT_SIZE = linuxPlatform.STAT_SIZE;

function decodeStat(view: Deno.UnsafePointerView, offset: number): Attr {
  return {
    ino: view.getBigUint64(offset + 8),
    mode: view.getUint32(offset + STAT_LAYOUT.mode),
    size: Number(view.getBigInt64(offset + linuxPlatform.STAT_ST_SIZE_OFFSET)),
    mtimeSeconds: view.getBigInt64(
      offset + linuxPlatform.STAT_ST_MTIM_OFFSET,
    ),
  };
}

function decodeEntry(
  pointer: Deno.PointerValue,
): { ino: bigint; attr: Attr; timeout: number } {
  const view = new Deno.UnsafePointerView(pointer!);
  return {
    ino: view.getBigUint64(0),
    attr: decodeStat(view, 16),
    timeout: view.getFloat64(16 + STAT_SIZE + 8),
  };
}

function requestId(req: Deno.PointerValue): number {
  return Number(Deno.UnsafePointer.value(req));
}

/**
 * Stands in for libfuse's reply functions, recording each reply by the request
 * it answers. A test hands a request an id of its own and reads back what the
 * operations replied to it.
 */
class FakeFuse {
  /** Kinds of reply the kernel refuses, as when the request was interrupted. */
  readonly refused = new Set<Reply["kind"]>();
  readonly #replies = new Map<number, Reply[]>();
  readonly #waiters = new Map<number, (reply: Reply) => void>();
  readonly #dirents = new Map<number, { name: string; offset: bigint }[]>();

  /** Every reply sent to request `id`, in order. */
  repliesTo(id: number): Reply[] {
    return this.#replies.get(id) ?? [];
  }

  /** The one reply sent to request `id`. */
  replyTo(id: number): Reply {
    const replies = this.repliesTo(id);
    expect(replies.length).toBe(1);
    return replies[0];
  }

  /** Resolves with the first reply to request `id`. */
  nextReply(id: number): Promise<Reply> {
    const sent = this.repliesTo(id);
    if (sent.length > 0) return Promise.resolve(sent[0]);
    return new Promise((resolve) => this.#waiters.set(id, resolve));
  }

  #record(req: Deno.PointerValue, reply: Reply): number {
    const id = requestId(req);
    const replies = this.#replies.get(id) ?? [];
    replies.push(reply);
    this.#replies.set(id, replies);
    const waiter = this.#waiters.get(id);
    this.#waiters.delete(id);
    waiter?.(reply);
    return this.refused.has(reply.kind) ? -ENOENT : 0;
  }

  readonly symbols: FuseReplySymbols = {
    fuse_reply_err: (req, errno) => this.#record(req, { kind: "err", errno }),
    fuse_reply_entry: (req, entry) =>
      this.#record(req, { kind: "entry", ...decodeEntry(entry) }),
    fuse_reply_attr: (req, stat, timeout) =>
      this.#record(req, {
        kind: "attr",
        attr: decodeStat(new Deno.UnsafePointerView(stat!), 0),
        timeout,
      }),
    fuse_reply_buf: (req, buffer, size) => {
      const dirents = this.#dirents.get(requestId(req));
      if (dirents) {
        this.#dirents.delete(requestId(req));
        return this.#record(req, {
          kind: "dirents",
          names: dirents.map((entry) => entry.name),
          offsets: dirents.map((entry) => entry.offset),
        });
      }
      const bytes = new Uint8Array(Number(size));
      if (buffer) new Deno.UnsafePointerView(buffer).copyInto(bytes);
      return this.#record(req, { kind: "data", text: decoder.decode(bytes) });
    },
    fuse_reply_open: (req, fi) =>
      this.#record(req, {
        kind: "open",
        fh: linuxPlatform.readFileInfo(fi).fh,
      }),
    fuse_reply_readlink: (req, target) =>
      this.#record(req, {
        kind: "readlink",
        target: decoder.decode(target ?? undefined).replace(/\0$/, ""),
      }),
    fuse_reply_write: (req, size) =>
      this.#record(req, { kind: "write", size: Number(size) }),
    fuse_reply_create: (req, entry, fi) => {
      const { ino, attr } = decodeEntry(entry);
      return this.#record(req, {
        kind: "create",
        ino,
        attr,
        fh: linuxPlatform.readFileInfo(fi).fh,
      });
    },
    fuse_reply_xattr: (req, size) =>
      this.#record(req, { kind: "xattr", size: Number(size) }),
    fuse_reply_none: (req) => {
      this.#record(req, { kind: "none" });
    },
    // libfuse writes the entry only when it fits, and returns the space it
    // needs either way: a header of 24 bytes and the name, padded to 8.
    fuse_add_direntry: (req, _buffer, size, name, _stat, offset) => {
      const nameText = decoder.decode(name ?? undefined).replace(/\0$/, "");
      const needed = (24 + new TextEncoder().encode(nameText).length + 7) &
        ~7;
      if (needed <= Number(size)) {
        const dirents = this.#dirents.get(requestId(req)) ?? [];
        dirents.push({ name: nameText, offset: BigInt(offset) });
        this.#dirents.set(requestId(req), dirents);
      }
      return BigInt(needed);
    },
  };
}

//
// Console output
//

/**
 * Captures what the operations log, so a case can read it and wait for a line
 * that marks a step finishing.
 */
class ConsoleCapture {
  readonly lines: string[] = [];
  readonly #waiters: { pattern: RegExp; resolve: (line: string) => void }[] =
    [];
  readonly #original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  constructor() {
    const capture = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      this.lines.push(line);
      for (const waiter of [...this.#waiters]) {
        if (waiter.pattern.test(line)) {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(line);
        }
      }
    };
    console.log = capture;
    console.warn = capture;
    console.error = capture;
  }

  /** Resolves with the first line matching `pattern`, logged or to come. */
  line(pattern: RegExp): Promise<string> {
    const logged = this.lines.find((line) => pattern.test(line));
    if (logged !== undefined) return Promise.resolve(logged);
    return new Promise((resolve) => this.#waiters.push({ pattern, resolve }));
  }

  restore(): void {
    Object.assign(console, this.#original);
  }
}

//
// The mount under test
//

/** Memory that the operations read their arguments from. */
class Arguments {
  readonly #held: Uint8Array[] = [];

  /** A pointer to `text` as a C string. */
  string(text: string): Deno.PointerValue {
    const bytes = new TextEncoder().encode(`${text}\0`);
    this.#held.push(bytes);
    return Deno.UnsafePointer.of(bytes);
  }

  /** A pointer to `bytes`. */
  bytes(bytes: Uint8Array): Deno.PointerValue {
    this.#held.push(bytes);
    return Deno.UnsafePointer.of(bytes);
  }

  /** A pointer to a `fuse_file_info` holding `flags` and `fh`. */
  fileInfo(flags: number, fh = 0n): Deno.PointerValue {
    const bytes = new Uint8Array(linuxPlatform.FUSE_FILE_INFO_SIZE);
    const pointer = this.bytes(bytes);
    new DataView(bytes.buffer).setInt32(0, flags, true);
    linuxPlatform.writeFileInfo(pointer, fh);
    return pointer;
  }

  /** A pointer to a `struct stat` whose size is `size`. */
  statWithSize(size: number): Deno.PointerValue {
    const buffer = new ArrayBuffer(STAT_SIZE);
    linuxPlatform.writeStat(buffer, { ino: 0n, mode: 0, nlink: 1, size });
    return this.bytes(new Uint8Array(buffer));
  }
}

let nextRequest = 1;

/** A request pointer carrying a new id, and the id. */
function request(): { req: Deno.PointerValue; id: number } {
  const id = nextRequest++;
  return { req: Deno.UnsafePointer.create(BigInt(id)), id };
}

interface Mount {
  tree: FsTree;
  fuse: FakeFuse;
  bridge: FakeBridge;
  operations: FuseOperations;
  args: Arguments;
  cfcWritebacks: CfcWritebackStore;
}

function mount(
  options: Partial<Omit<FuseOperationsOptions, "bridge">> & {
    bridge?: FakeBridge | null;
  } = {},
): Mount {
  const tree = options.tree ?? new FsTree();
  const fuse = new FakeFuse();
  const bridge = options.bridge === undefined
    ? new FakeBridge()
    : options.bridge;
  const cfcWritebacks = options.cfcWritebacks ?? new CfcWritebackStore();
  const operations = createFuseOperations({
    tree,
    bridge,
    fuse,
    platform: linuxPlatform,
    cfcMode: "disabled",
    cfcAnnotationsEnabled: false,
    cfcWritebackXattrs: false,
    cfcXattrNamespace: "both",
    dangerouslyAllowIncompatibleSchema: false,
    ...options,
    cfcWritebacks,
  });
  return {
    tree,
    fuse,
    bridge: bridge ?? new FakeBridge(),
    operations,
    args: new Arguments(),
    cfcWritebacks,
  };
}

/** Opens `ino` with `flags` and returns the file handle the reply carried. */
function openFile(m: Mount, ino: bigint, flags: number): bigint {
  const { req, id } = request();
  m.operations.handlers.open(req, ino, m.args.fileInfo(flags));
  const reply = m.fuse.replyTo(id);
  expect(reply.kind).toBe("open");
  assert(reply.kind === "open");
  return reply.fh;
}

/** Writes `text` at `offset` through descriptor `fh`, returning the reply. */
function writeText(
  m: Mount,
  ino: bigint,
  fh: bigint,
  text: string,
  offset = 0,
): Reply {
  const bytes = new TextEncoder().encode(text);
  const { req, id } = request();
  m.operations.handlers.write(
    req,
    ino,
    m.args.bytes(bytes),
    BigInt(bytes.length),
    BigInt(offset),
    m.args.fileInfo(O_WRONLY, fh),
  );
  return m.fuse.replyTo(id);
}

function flushFile(m: Mount, ino: bigint, fh: bigint): Reply {
  const { req, id } = request();
  m.operations.handlers.flush(req, ino, m.args.fileInfo(O_WRONLY, fh));
  return m.fuse.replyTo(id);
}

function releaseFile(m: Mount, ino: bigint, fh: bigint): Reply {
  const { req, id } = request();
  m.operations.handlers.release(req, ino, m.args.fileInfo(O_WRONLY, fh));
  return m.fuse.replyTo(id);
}

/** The text a file node holds. */
function contentOf(tree: FsTree, ino: bigint): string {
  const node = tree.getNode(ino);
  assert(node?.kind === "file");
  return decoder.decode(node.content);
}

function errno(reply: Reply): number | undefined {
  return reply.kind === "err" ? reply.errno : undefined;
}

describe("operations", () => {
  let output: ConsoleCapture;

  beforeEach(() => {
    output = new ConsoleCapture();
  });

  afterEach(() => {
    output.restore();
  });

  describe("createFuseOperations()", () => {
    describe("lookup", () => {
      it("replies with the entry of a name the tree holds", () => {
        const m = mount({ bridge: null });
        const ino = m.tree.addFile(m.tree.rootIno, "hello.txt", "hi", "string");
        const { req, id } = request();

        m.operations.handlers.lookup(
          req,
          m.tree.rootIno,
          m.args.string("hello.txt"),
        );

        const reply = m.fuse.replyTo(id);
        assert(reply.kind === "entry");
        expect(reply.ino).toBe(ino);
        expect(reply.attr).toMatchObject({ ino, mode: FILE_MODE, size: 2 });
        // A static inode is cached by the kernel for a second.
        expect(reply.timeout).toBe(1);
      });

      it("replies `ENOENT` for a name the tree does not hold", () => {
        const m = mount({ bridge: null });
        const { req, id } = request();

        m.operations.handlers.lookup(
          req,
          m.tree.rootIno,
          m.args.string("missing"),
        );

        expect(m.fuse.replyTo(id)).toEqual({ kind: "err", errno: ENOENT });
      });

      it("connects a space named at the root before replying with its directory", async () => {
        const drained = Promise.withResolvers<void>();
        const m = mount();
        m.operations.onPendingRepliesDrained = () => drained.resolve();
        const connected: string[] = [];
        m.bridge.connectSpace = (name) => {
          connected.push(name);
          m.tree.addDir(m.tree.rootIno, "my%3Aspace");
          return Promise.resolve();
        };
        const { req, id } = request();

        m.operations.handlers.lookup(
          req,
          m.tree.rootIno,
          m.args.string("my%3Aspace"),
        );

        expect(m.fuse.repliesTo(id)).toEqual([]);
        expect(m.operations.pendingReplyCount()).toBe(1);
        const reply = await m.fuse.nextReply(id);
        expect(connected).toEqual(["my:space"]);
        assert(reply.kind === "entry");
        expect(reply.attr.mode).toBe(DIR_MODE);
        await drained.promise;
        expect(m.operations.pendingReplyCount()).toBe(0);
      });

      it("replies from the tree without connecting when the space is already there", () => {
        const m = mount();
        const spaceIno = m.tree.addDir(m.tree.rootIno, "home");
        const connected: string[] = [];
        m.bridge.connectSpace = (name) => {
          connected.push(name);
          return Promise.resolve();
        };
        const { req, id } = request();

        m.operations.handlers.lookup(
          req,
          m.tree.rootIno,
          m.args.string("home"),
        );

        expect(m.fuse.replyTo(id)).toMatchObject({
          kind: "entry",
          ino: spaceIno,
        });
        expect(connected).toEqual([]);
      });

      it("replies `ENOENT` when connecting the space fails or leaves nothing to find", async () => {
        const drained = Promise.withResolvers<void>();
        const m = mount();
        m.operations.onPendingRepliesDrained = () => drained.resolve();
        const failing = request();
        m.operations.handlers.lookup(
          failing.req,
          m.tree.rootIno,
          m.args.string("nowhere"),
        );
        m.bridge.connectSpace = () => Promise.resolve();
        const empty = request();
        m.operations.handlers.lookup(
          empty.req,
          m.tree.rootIno,
          m.args.string("empty"),
        );
        expect(m.operations.pendingReplyCount()).toBe(2);

        expect(await m.fuse.nextReply(failing.id)).toEqual({
          kind: "err",
          errno: ENOENT,
        });
        expect(await m.fuse.nextReply(empty.id)).toEqual({
          kind: "err",
          errno: ENOENT,
        });
        await drained.promise;
        expect(m.operations.pendingReplyCount()).toBe(0);
      });

      it("does not connect a space for a hidden name at the root", () => {
        const m = mount();
        const connected: string[] = [];
        m.bridge.connectSpace = (name) => {
          connected.push(name);
          return Promise.resolve();
        };
        const { req, id } = request();

        m.operations.handlers.lookup(
          req,
          m.tree.rootIno,
          m.args.string(".hidden"),
        );

        expect(m.fuse.replyTo(id)).toEqual({ kind: "err", errno: ENOENT });
        expect(connected).toEqual([]);
      });

      it("hydrates a name the bridge prepares before replying with it", async () => {
        const m = mount();
        const dir = m.tree.addDir(m.tree.rootIno, "pieces");
        m.bridge.shouldPrepareLookup = (parent) => parent === dir;
        m.bridge.prepareLookup = (parent, name) => {
          m.tree.addDir(parent, name);
          return Promise.resolve(true);
        };
        const { req, id } = request();

        m.operations.handlers.lookup(req, dir, m.args.string("notes"));

        const reply = await m.fuse.nextReply(id);
        assert(reply.kind === "entry");
        expect(reply.ino).toBe(m.tree.lookup(dir, "notes"));
        // A hydrated inode is never cached by the kernel.
        expect(reply.timeout).toBe(0);
      });

      it("replies `ENOENT` when hydration finds nothing or fails", async () => {
        const m = mount();
        const dir = m.tree.addDir(m.tree.rootIno, "pieces");
        m.bridge.shouldPrepareLookup = () => true;
        m.bridge.prepareLookup = () => Promise.resolve(false);
        const nothing = request();
        m.operations.handlers.lookup(nothing.req, dir, m.args.string("x"));
        m.bridge.prepareLookup = () => Promise.reject(new Error("offline"));
        const failed = request();
        m.operations.handlers.lookup(failed.req, dir, m.args.string("y"));

        expect(await m.fuse.nextReply(nothing.id)).toEqual({
          kind: "err",
          errno: ENOENT,
        });
        expect(await m.fuse.nextReply(failed.id)).toEqual({
          kind: "err",
          errno: ENOENT,
        });
      });

      it("replies `ENOENT` when hydration names an inode that has since gone", async () => {
        const m = mount();
        const dir = m.tree.addDir(m.tree.rootIno, "pieces");
        const gone = m.tree.addDir(dir, "gone");
        m.tree.removeChild(dir, "gone");
        m.bridge.shouldPrepareLookup = () => true;
        m.bridge.prepareLookupForReply = () => Promise.resolve(gone);
        const { req, id } = request();

        m.operations.handlers.lookup(req, dir, m.args.string("gone"));

        expect(await m.fuse.nextReply(id)).toEqual({
          kind: "err",
          errno: ENOENT,
        });
      });

      it("replies at once with an entry already hydrated and refreshes it afterwards", async () => {
        using time = new FakeTime();
        const m = mount();
        const dir = m.tree.addDir(m.tree.rootIno, "pieces");
        const notes = m.tree.addDir(dir, "notes");
        m.bridge.shouldPrepareLookup = () => true;
        const refreshed: string[] = [];
        m.bridge.prepareLookup = (_parent, name) => {
          refreshed.push(name);
          return Promise.reject(new Error("refresh failures are ignored"));
        };
        const { req, id } = request();

        m.operations.handlers.lookup(req, dir, m.args.string("notes"));

        expect(m.fuse.replyTo(id)).toMatchObject({ kind: "entry", ino: notes });
        expect(refreshed).toEqual([]);
        await time.tickAsync(0);
        expect(refreshed).toEqual(["notes"]);
      });

      it("hydrates before replying when the bridge says the lookup must synchronize", async () => {
        const m = mount();
        const dir = m.tree.addDir(m.tree.rootIno, "entities");
        m.tree.addDir(dir, "stale");
        m.bridge.shouldPrepareLookup = () => true;
        m.bridge.shouldSynchronizeLookup = () => true;
        const prepared: string[] = [];
        m.bridge.prepareLookup = (_parent, name) => {
          prepared.push(name);
          return Promise.resolve(true);
        };
        const { req, id } = request();

        m.operations.handlers.lookup(req, dir, m.args.string("stale"));

        expect(m.fuse.repliesTo(id)).toEqual([]);
        await m.fuse.nextReply(id);
        expect(prepared).toEqual(["stale"]);
      });
    });

    describe("replies the kernel refuses", () => {
      // The kernel refuses a reply to a request that was interrupted. What
      // the reply would have handed it, a lookup reference or an open
      // descriptor, then has no owner, so the mount gives it back.

      it("gives back the lookup reference of a refused entry", () => {
        const m = mount();
        const dir = m.tree.addDir(m.tree.rootIno, "d");
        const file = m.tree.addFile(dir, "f", "", "string");
        m.fuse.refused.add("entry");
        const { req, id } = request();

        m.operations.handlers.lookup(req, dir, m.args.string("f"));

        expect(m.fuse.replyTo(id)).toMatchObject({ kind: "entry", ino: file });
        expect(m.bridge.retained).toEqual([`lookup+${file}`, `lookup-${file}`]);

        // An accepted entry keeps its reference until the kernel forgets it.
        m.fuse.refused.clear();
        m.operations.handlers.lookup(request().req, dir, m.args.string("f"));
        expect(m.bridge.retained.at(-1)).toBe(`lookup+${file}`);
        m.operations.handlers.forget(request().req, file, 1n);
        expect(m.bridge.retained.at(-1)).toBe(`lookup-${file}`);
      });

      it("closes the descriptor of a refused open or create", () => {
        const m = mount();
        const dir = m.tree.addDir(m.tree.rootIno, "d");
        m.bridge.writePaths.set(dir, writePath(fakePiece(EMPTY), ["d"]));
        const file = m.tree.addFile(dir, "f", "x", "string");
        m.fuse.refused.add("open");
        m.fuse.refused.add("create");

        const open = request();
        m.operations.handlers.open(open.req, file, m.args.fileInfo(O_RDONLY));
        const created = request();
        m.operations.handlers.create(
          created.req,
          dir,
          m.args.string("new"),
          0o644,
          m.args.fileInfo(O_RDWR),
        );
        const sidecar = request();
        m.operations.handlers.create(
          sidecar.req,
          dir,
          m.args.string("._new"),
          0o644,
          m.args.fileInfo(O_RDWR),
        );
        const dirOpen = request();
        m.operations.handlers.opendir(
          dirOpen.req,
          dir,
          m.args.fileInfo(O_RDONLY),
        );

        const newIno = m.tree.lookup(dir, "new")!;
        const sidecarIno = m.tree.lookup(dir, "._new")!;
        expect(m.bridge.retained).toEqual([
          `open+${file}`,
          `open-${file}`,
          `lookup+${newIno}`,
          `open+${newIno}`,
          `lookup-${newIno}`,
          `open-${newIno}`,
          `lookup+${sidecarIno}`,
          `open+${sidecarIno}`,
          `lookup-${sidecarIno}`,
          `open-${sidecarIno}`,
          `open+${dir}`,
          `open-${dir}`,
        ]);
        const opened = m.fuse.replyTo(open.id);
        assert(opened.kind === "open");
        const read = request();
        m.operations.handlers.read(
          read.req,
          file,
          10n,
          0n,
          m.args.fileInfo(O_RDONLY, opened.fh),
        );
        // The closed descriptor no longer serves its snapshot; the read is
        // answered from the node instead.
        expect(m.fuse.replyTo(read.id)).toEqual({ kind: "data", text: "x" });
      });
    });

    describe("dumpOpRing()", () => {
      it("logs the operations the mount handled most recently", () => {
        const m = mount({ bridge: null });
        m.operations.handlers.getattr(request().req, 424242n, null);

        dumpOpRing();

        expect(output.lines).toContain("[fuse:crash] Last operations:");
        expect(output.lines.at(-1)).toMatch(/^ {2}\d+ getattr 424242$/);
      });
    });

    describe("forget", () => {
      it("replies with no data", () => {
        const m = mount({ bridge: null });
        const { req, id } = request();

        m.operations.handlers.forget(req, 5n, 1n);

        expect(m.fuse.replyTo(id)).toEqual({ kind: "none" });
      });
    });

    describe("getattr", () => {
      it("replies with the attributes of a node", () => {
        const m = mount({ bridge: null });
        const dir = m.tree.addDir(m.tree.rootIno, "d");
        const { req, id } = request();

        m.operations.handlers.getattr(req, dir, null);

        expect(m.fuse.replyTo(id)).toMatchObject({
          kind: "attr",
          attr: { ino: dir, mode: DIR_MODE },
          timeout: 1,
        });
      });

      it("replies `ENOENT` for an inode the tree does not hold", () => {
        const m = mount({ bridge: null });
        const { req, id } = request();

        m.operations.handlers.getattr(req, 999n, null);

        expect(m.fuse.replyTo(id)).toEqual({ kind: "err", errno: ENOENT });
      });

      it("reports a writable mode for a file the bridge can write", () => {
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "title", "x", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["title"]));
        const { req, id } = request();

        m.operations.handlers.getattr(req, file, null);

        expect(m.fuse.replyTo(id)).toMatchObject({
          kind: "attr",
          attr: { mode: FILE_MODE_RW },
        });
      });

      it("reports every file read-only while the bridge is disconnected", () => {
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "title", "x", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["title"]));
        m.bridge.disconnected = true;
        const { req, id } = request();

        m.operations.handlers.getattr(req, file, null);

        expect(m.fuse.replyTo(id)).toMatchObject({
          kind: "attr",
          attr: { mode: FILE_MODE },
        });
      });

      it("reports the size of the render an open descriptor serves, and publishes a new render without one", () => {
        const m = mount({ bridge: null });
        let render = "first";
        const status = m.tree.addGeneratedFile(
          m.tree.rootIno,
          ".status",
          () => render,
          "object",
        );
        const fh = openFile(m, status, O_RDONLY);
        render = "a much longer second render";

        const withDescriptor = request();
        m.operations.handlers.getattr(
          withDescriptor.req,
          status,
          m.args.fileInfo(O_RDONLY, fh),
        );
        const bare = request();
        m.operations.handlers.getattr(bare.req, status, null);

        expect(m.fuse.replyTo(withDescriptor.id)).toMatchObject({
          kind: "attr",
          attr: { size: "first".length },
          timeout: 0,
        });
        expect(m.fuse.replyTo(bare.id)).toMatchObject({
          kind: "attr",
          attr: { size: render.length },
        });
      });
    });

    describe("getattr of a generated file", () => {
      it("publishes a new render when the descriptor named does not serve the file", () => {
        const m = mount({ bridge: null });
        let render = "first";
        const status = m.tree.addGeneratedFile(
          m.tree.rootIno,
          ".status",
          () => render,
          "object",
        );
        const other = m.tree.addFile(m.tree.rootIno, "other", "", "string");
        const otherFh = openFile(m, other, O_RDONLY);
        render = "the second render";
        const { req, id } = request();

        m.operations.handlers.getattr(
          req,
          status,
          m.args.fileInfo(O_RDONLY, otherFh),
        );

        expect(m.fuse.replyTo(id)).toMatchObject({
          kind: "attr",
          attr: { size: render.length },
        });
      });
    });

    describe("readlink", () => {
      it("replies with the target of a symbolic link", () => {
        const m = mount({ bridge: null });
        const link = m.tree.addSymlink(m.tree.rootIno, "link", "../target");
        const { req, id } = request();

        m.operations.handlers.readlink(req, link);

        expect(m.fuse.replyTo(id)).toEqual({
          kind: "readlink",
          target: "../target",
        });
      });

      it("replies `ENOENT` for a node that is not a symbolic link", () => {
        const m = mount({ bridge: null });
        const file = m.tree.addFile(m.tree.rootIno, "f", "", "string");
        const { req, id } = request();

        m.operations.handlers.readlink(req, file);

        expect(m.fuse.replyTo(id)).toEqual({ kind: "err", errno: ENOENT });
      });
    });

    describe("open and read", () => {
      it("serves a file's bytes from the offset asked for", () => {
        const m = mount({ bridge: null });
        const file = m.tree.addFile(
          m.tree.rootIno,
          "f",
          "hello world",
          "string",
        );
        const fh = openFile(m, file, O_RDONLY);
        const { req, id } = request();

        m.operations.handlers.read(
          req,
          file,
          5n,
          6n,
          m.args.fileInfo(O_RDONLY, fh),
        );

        expect(m.fuse.replyTo(id)).toEqual({ kind: "data", text: "world" });
      });

      it("replies with no bytes at or past the end of a file", () => {
        const m = mount({ bridge: null });
        const file = m.tree.addFile(m.tree.rootIno, "f", "abc", "string");
        const fh = openFile(m, file, O_RDONLY);
        const open = request();
        m.operations.handlers.read(
          open.req,
          file,
          10n,
          3n,
          m.args.fileInfo(O_RDONLY, fh),
        );
        const unopened = request();
        m.operations.handlers.read(unopened.req, file, 10n, 3n, null);

        expect(m.fuse.replyTo(open.id)).toEqual({ kind: "data", text: "" });
        expect(m.fuse.replyTo(unopened.id)).toEqual({
          kind: "data",
          text: "",
        });
      });

      it("serves the current content when no descriptor is open", () => {
        const m = mount({ bridge: null });
        const file = m.tree.addFile(m.tree.rootIno, "f", "abcdef", "string");
        const script = m.tree.addCallable(
          m.tree.rootIno,
          "run.tool",
          "tool",
          "run",
          "result",
          new TextEncoder().encode("#!/bin/sh\n"),
        );
        const fromFile = request();
        m.operations.handlers.read(fromFile.req, file, 3n, 1n, null);
        const fromScript = request();
        m.operations.handlers.read(fromScript.req, script, 100n, 0n, null);

        expect(m.fuse.replyTo(fromFile.id)).toEqual({
          kind: "data",
          text: "bcd",
        });
        expect(m.fuse.replyTo(fromScript.id)).toEqual({
          kind: "data",
          text: "#!/bin/sh\n",
        });
      });

      it("replies `ENOENT` to a read of a directory or a missing inode", () => {
        const m = mount({ bridge: null });
        const dir = m.tree.addDir(m.tree.rootIno, "d");
        const ofDir = request();
        m.operations.handlers.read(ofDir.req, dir, 10n, 0n, null);
        const ofMissing = request();
        m.operations.handlers.read(ofMissing.req, 999n, 10n, 0n, null);

        expect(m.fuse.replyTo(ofDir.id)).toEqual({
          kind: "err",
          errno: ENOENT,
        });
        expect(m.fuse.replyTo(ofMissing.id)).toEqual({
          kind: "err",
          errno: ENOENT,
        });
      });

      it("refuses to open a directory or a missing inode", () => {
        const m = mount({ bridge: null });
        const dir = m.tree.addDir(m.tree.rootIno, "d");
        const ofDir = request();
        m.operations.handlers.open(ofDir.req, dir, m.args.fileInfo(O_RDONLY));
        const ofMissing = request();
        m.operations.handlers.open(
          ofMissing.req,
          999n,
          m.args.fileInfo(O_RDONLY),
        );

        expect(m.fuse.replyTo(ofDir.id)).toEqual({
          kind: "err",
          errno: EISDIR,
        });
        expect(m.fuse.replyTo(ofMissing.id)).toEqual({
          kind: "err",
          errno: ENOENT,
        });
      });

      it("keeps serving the render a generated file had when it was opened", () => {
        const m = mount({ bridge: null });
        let render = "before";
        const status = m.tree.addGeneratedFile(
          m.tree.rootIno,
          ".status",
          () => render,
          "object",
        );
        const fh = openFile(m, status, O_RDONLY);
        render = "after";
        m.tree.refreshGenerated(status);
        const { req, id } = request();

        m.operations.handlers.read(
          req,
          status,
          100n,
          0n,
          m.args.fileInfo(O_RDONLY, fh),
        );

        expect(m.fuse.replyTo(id)).toEqual({ kind: "data", text: "before" });
      });

      it("refuses a write open of a file the bridge cannot write", () => {
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "f", "x", "string");
        const { req, id } = request();

        m.operations.handlers.open(req, file, m.args.fileInfo(O_WRONLY));

        expect(m.fuse.replyTo(id)).toEqual({ kind: "err", errno: EACCES });
      });

      it("refuses a write open with `EROFS` while the bridge is disconnected", () => {
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "f", "x", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["f"]));
        m.bridge.disconnected = true;
        const { req, id } = request();

        m.operations.handlers.open(req, file, m.args.fileInfo(O_RDWR));

        expect(m.fuse.replyTo(id)).toEqual({ kind: "err", errno: EROFS });
        expect(m.operations.status().writes.opened).toBe(0);
      });
    });

    describe("opendir, readdir, and releasedir", () => {
      it("lists a directory's entries after `.` and `..`, resuming at an offset", () => {
        const m = mount({ bridge: null });
        const dir = m.tree.addDir(m.tree.rootIno, "d");
        m.tree.addFile(dir, "a", "", "string");
        m.tree.addFile(dir, "b", "", "string");
        const open = request();
        m.operations.handlers.opendir(
          open.req,
          dir,
          m.args.fileInfo(O_RDONLY),
        );
        const opened = m.fuse.replyTo(open.id);
        assert(opened.kind === "open");
        const fi = m.args.fileInfo(O_RDONLY, opened.fh);

        const first = request();
        m.operations.handlers.readdir(first.req, dir, 4096n, 0n, fi);
        const rest = request();
        m.operations.handlers.readdir(rest.req, dir, 4096n, 3n, fi);

        expect(m.fuse.replyTo(first.id)).toEqual({
          kind: "dirents",
          names: [".", "..", "a", "b"],
          offsets: [1n, 2n, 3n, 4n],
        });
        expect(m.fuse.replyTo(rest.id)).toMatchObject({
          kind: "dirents",
          names: ["b"],
        });

        const release = request();
        m.operations.handlers.releasedir(release.req, dir, fi);
        expect(m.fuse.replyTo(release.id)).toEqual({ kind: "err", errno: 0 });
      });

      it("stops listing at the first entry that does not fit the buffer", () => {
        const m = mount({ bridge: null });
        const dir = m.tree.addDir(m.tree.rootIno, "d");
        m.tree.addFile(dir, "a-long-name", "", "string");
        const { req, id } = request();

        // Room for `.` and `..` (32 bytes each), not for the third entry.
        m.operations.handlers.readdir(req, dir, 64n, 0n, null);

        expect(m.fuse.replyTo(id)).toMatchObject({
          kind: "dirents",
          names: [".", ".."],
        });
      });

      it("refuses to open or list a missing directory or a file", () => {
        const m = mount({ bridge: null });
        const file = m.tree.addFile(m.tree.rootIno, "f", "", "string");
        const openMissing = request();
        m.operations.handlers.opendir(
          openMissing.req,
          999n,
          m.args.fileInfo(O_RDONLY),
        );
        const listFile = request();
        m.operations.handlers.readdir(listFile.req, file, 4096n, 0n, null);
        const releaseNothing = request();
        m.operations.handlers.releasedir(releaseNothing.req, file, null);

        expect(m.fuse.replyTo(openMissing.id)).toEqual({
          kind: "err",
          errno: ENOENT,
        });
        expect(m.fuse.replyTo(listFile.id)).toEqual({
          kind: "err",
          errno: ENOENT,
        });
        expect(m.fuse.replyTo(releaseNothing.id)).toEqual({
          kind: "err",
          errno: 0,
        });
      });

      it("lists a directory the bridge prepares once preparation finishes", async () => {
        const m = mount();
        const dir = m.tree.addDir(m.tree.rootIno, "pieces");
        m.bridge.shouldPrepareDirectory = (ino) => ino === dir;
        m.bridge.prepareDirectory = () => {
          m.tree.addDir(dir, "notes");
          return Promise.resolve(true);
        };
        const open = request();
        m.operations.handlers.opendir(
          open.req,
          dir,
          m.args.fileInfo(O_RDONLY),
        );
        const opened = m.fuse.replyTo(open.id);
        assert(opened.kind === "open");
        const { req, id } = request();

        m.operations.handlers.readdir(
          req,
          dir,
          4096n,
          0n,
          m.args.fileInfo(O_RDONLY, opened.fh),
        );

        expect(await m.fuse.nextReply(id)).toMatchObject({
          kind: "dirents",
          names: [".", "..", "notes"],
        });
      });

      it("replies `ENOENT` when preparing a directory fails", async () => {
        const m = mount();
        const dir = m.tree.addDir(m.tree.rootIno, "pieces");
        m.bridge.shouldPrepareDirectory = () => true;
        m.bridge.prepareDirectory = () => Promise.reject(new Error("offline"));
        const open = request();
        m.operations.handlers.opendir(
          open.req,
          dir,
          m.args.fileInfo(O_RDONLY),
        );
        const opened = m.fuse.replyTo(open.id);
        assert(opened.kind === "open");
        const { req, id } = request();

        m.operations.handlers.readdir(
          req,
          dir,
          4096n,
          0n,
          m.args.fileInfo(O_RDONLY, opened.fh),
        );

        expect(await m.fuse.nextReply(id)).toEqual({
          kind: "err",
          errno: ENOENT,
        });
      });
    });

    describe("getxattr and listxattr", () => {
      it("reports a JSON node's type as `user.json.type`", () => {
        const m = mount({ bridge: null });
        const file = m.tree.addFile(m.tree.rootIno, "n", "1", "number");
        const sizeQuery = request();
        m.operations.handlers.getxattr(
          sizeQuery.req,
          file,
          m.args.string("user.json.type"),
          0n,
        );
        const value = request();
        m.operations.handlers.getxattr(
          value.req,
          file,
          m.args.string("user.json.type"),
          64n,
        );
        const tooSmall = request();
        m.operations.handlers.getxattr(
          tooSmall.req,
          file,
          m.args.string("user.json.type"),
          2n,
        );

        expect(m.fuse.replyTo(sizeQuery.id)).toEqual({
          kind: "xattr",
          size: "number".length,
        });
        expect(m.fuse.replyTo(value.id)).toEqual({
          kind: "data",
          text: "number",
        });
        expect(m.fuse.replyTo(tooSmall.id)).toEqual({
          kind: "err",
          errno: ERANGE,
        });
      });

      it("replies `ENODATA` for an attribute the node does not carry", () => {
        const m = mount({ bridge: null });
        const dir = m.tree.addDir(m.tree.rootIno, "d");
        const symlink = m.tree.addSymlink(m.tree.rootIno, "l", "d");
        const unknown = request();
        m.operations.handlers.getxattr(
          unknown.req,
          dir,
          m.args.string("user.other"),
          64n,
        );
        const untyped = request();
        m.operations.handlers.getxattr(
          untyped.req,
          symlink,
          m.args.string("user.json.type"),
          64n,
        );

        expect(m.fuse.replyTo(unknown.id)).toEqual({
          kind: "err",
          errno: linuxPlatform.ENODATA,
        });
        expect(m.fuse.replyTo(untyped.id)).toEqual({
          kind: "err",
          errno: linuxPlatform.ENODATA,
        });
      });

      it("lists `user.json.type` for a typed node and nothing for an untyped one", () => {
        const m = mount({ bridge: null });
        const dir = m.tree.addDir(m.tree.rootIno, "d", "array");
        const symlink = m.tree.addSymlink(m.tree.rootIno, "l", "d");
        const size = request();
        m.operations.handlers.listxattr(size.req, dir, 0n);
        const list = request();
        m.operations.handlers.listxattr(list.req, dir, 64n);
        const tooSmall = request();
        m.operations.handlers.listxattr(tooSmall.req, dir, 4n);
        const emptySize = request();
        m.operations.handlers.listxattr(emptySize.req, symlink, 0n);
        const emptyList = request();
        m.operations.handlers.listxattr(emptyList.req, symlink, 64n);

        expect(m.fuse.replyTo(size.id)).toEqual({
          kind: "xattr",
          size: "user.json.type\0".length,
        });
        expect(m.fuse.replyTo(list.id)).toEqual({
          kind: "data",
          text: "user.json.type\0",
        });
        expect(m.fuse.replyTo(tooSmall.id)).toEqual({
          kind: "err",
          errno: ERANGE,
        });
        expect(m.fuse.replyTo(emptySize.id)).toEqual({
          kind: "xattr",
          size: 0,
        });
        expect(m.fuse.replyTo(emptyList.id)).toEqual({
          kind: "data",
          text: "",
        });
      });
    });

    describe("writing a file", () => {
      // A write lands in the descriptor's buffer, and the buffer goes to the
      // cell when the descriptor is flushed or released. Each case uses fake
      // time, because a write also schedules a flush that covers a writer
      // whose flush and release never reach the mount.

      it("sends a scalar file's text to its cell as the JSON value it spells", async () => {
        using _time = new FakeTime();
        const m = mount();
        const cases: [string, unknown][] = [
          ["42\n", 42],
          ["true", true],
          ["null", null],
          ['"quoted"', "quoted"],
          ['{"a":1}', '{"a":1}'],
          ["plain text\n", "plain text"],
        ];
        for (const [index, [text, value]] of cases.entries()) {
          const file = m.tree.addFile(m.tree.rootIno, `v${index}`, "", "null");
          m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), [index]));
          const fh = openFile(m, file, O_WRONLY);
          const flushed = output.line(
            new RegExp(`flush-ok ino=${file} kind=value`),
          );

          expect(writeText(m, file, fh, text)).toEqual({
            kind: "write",
            size: text.length,
          });
          expect(flushFile(m, file, fh)).toEqual({ kind: "err", errno: 0 });
          await flushed;

          expect(m.bridge.callsTo("writeValue").at(-1)).toEqual({
            method: "writeValue",
            jsonPath: [index],
            value,
          });
          expect(m.bridge.callsTo("finalizeWritePath").at(-1)).toEqual({
            method: "finalizeWritePath",
            jsonPath: [index],
          });
          expect(contentOf(m.tree, file)).toBe(text);
        }
        expect(m.operations.status().writes).toMatchObject({
          opened: cases.length,
          written: cases.length,
          flushed: cases.length,
          flushErrors: 0,
        });
      });

      it("sends a `.json` file's parsed value, and nothing for text that is not JSON", async () => {
        using _time = new FakeTime();
        const m = mount();
        const good = m.tree.addFile(m.tree.rootIno, "good.json", "", "object");
        const bad = m.tree.addFile(m.tree.rootIno, "bad.json", "", "object");
        for (const ino of [good, bad]) {
          m.bridge.writePaths.set(
            ino,
            writePath(fakePiece(EMPTY), [`${ino}`], { isJsonFile: true }),
          );
        }
        const goodFh = openFile(m, good, O_WRONLY);
        const badFh = openFile(m, bad, O_WRONLY);
        writeText(m, good, goodFh, '{"a":[1,2]}');
        writeText(m, bad, badFh, "{not json");

        const goodClosed = m.bridge.next(`close ${good}`);
        const badClosed = m.bridge.next(`close ${bad}`);
        expect(releaseFile(m, good, goodFh)).toEqual({ kind: "err", errno: 0 });
        expect(releaseFile(m, bad, badFh)).toEqual({ kind: "err", errno: 0 });
        await goodClosed;
        await badClosed;

        expect(m.bridge.callsTo("writeValue")).toEqual([
          { method: "writeValue", jsonPath: [`${good}`], value: { a: [1, 2] } },
        ]);
      });

      it("logs the trace lines the FUSE integration suite reads", async () => {
        // `runtime/cli/integration/fuse-exec.sh` reads these lines out of the
        // daemon log. Its check that a truncate disarmed a descriptor passes
        // when a line is absent, so a reworded line would turn that check
        // into one that always passes. The release line reports the handle
        // as the release found it, before the flush changes it.

        using _time = new FakeTime();
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "title", "", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["title"]));
        const fh = openFile(m, file, O_WRONLY);
        writeText(m, file, fh, "abc");
        const flushed = output.line(/flush-ok/);
        flushFile(m, file, fh);
        await flushed;
        writeText(m, file, fh, "abcd");
        const closed = m.bridge.next(`close ${file}`);
        releaseFile(m, file, fh);
        await closed;

        expect(output.lines.filter((line) => line.includes("write-trace")))
          .toEqual(
            expect.arrayContaining([
              `[write-trace] open ino=${file} fh=${fh} target=value`,
              `[write-trace] write fh=${fh} size=3 offset=0`,
              `[write-trace] flush-fire fh=${fh}`,
              `[write-trace] release fh=${fh} dirty=true flushing=false pending=true`,
            ]),
          );
      });

      it("writes an [FS] projection file through the bridge's file writer", async () => {
        using _time = new FakeTime();
        const m = mount();
        const accepted = m.tree.addFile(m.tree.rootIno, "a.md", "", "string");
        const refused = m.tree.addFile(m.tree.rootIno, "b.json", "", "string");
        m.bridge.writePaths.set(
          accepted,
          writePath(fakePiece(EMPTY), ["a"], { fsProjection: "json" }),
        );
        m.bridge.writePaths.set(
          refused,
          writePath(fakePiece(EMPTY), ["b"], { fsProjection: "json" }),
        );
        m.bridge.writeFsFile = (path, text) => {
          m.bridge.calls.push({
            method: "writeFsFile",
            jsonPath: path.jsonPath,
            text,
          });
          return Promise.resolve(path.jsonPath[0] === "a");
        };
        for (
          const [ino, text] of [[accepted, "# A"], [refused, "{"]] as const
        ) {
          const fh = openFile(m, ino, O_WRONLY);
          writeText(m, ino, fh, text);
          const closed = m.bridge.next(`close ${ino}`);
          releaseFile(m, ino, fh);
          await closed;
        }

        expect(m.bridge.callsTo("writeFsFile").map((call) => call.text))
          .toEqual(["# A", "{"]);
        expect(m.bridge.callsTo("finalizeWritePath")).toEqual([
          { method: "finalizeWritePath", jsonPath: ["a"] },
        ]);
        expect(contentOf(m.tree, accepted)).toBe("# A");
        expect(contentOf(m.tree, refused)).toBe("");
      });

      it("delays the commit of a markdown projection until its writes settle", async () => {
        using time = new FakeTime();
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "note.md", "", "string");
        m.bridge.writePaths.set(
          file,
          writePath(fakePiece(EMPTY), ["note"], { fsProjection: "markdown" }),
        );
        const fh = openFile(m, file, O_WRONLY);
        writeText(m, file, fh, "# Title");
        flushFile(m, file, fh);
        writeText(m, file, fh, "# Title\n\nBody", 0);
        flushFile(m, file, fh);

        expect(m.bridge.callsTo("writeFsFile")).toEqual([]);
        const flushed = output.line(/kind=fsProjection/);
        await time.tickAsync(25);
        await flushed;
        expect(m.bridge.callsTo("writeFsFile").map((call) => call.text))
          .toEqual(["# Title\n\nBody"]);

        // A release schedules the commit too, rather than making it at once,
        // and closes the descriptor once the release has been answered.
        writeText(m, file, fh, "# Final", 0);
        const closed = m.bridge.next(`close ${file}`);
        releaseFile(m, file, fh);
        await closed;
        expect(m.bridge.callsTo("writeFsFile").length).toBe(1);
        const final = m.bridge.next("finalizeWritePath");
        await time.tickAsync(0);
        await final;
        expect(m.bridge.callsTo("writeFsFile").map((call) => call.text))
          .toEqual(["# Title\n\nBody", "# Final\n\nBody"]);
      });

      it("commits a write whose flush and release never arrive, half a second after the last write", async () => {
        using time = new FakeTime();
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "title", "", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["title"]));
        const fh = openFile(m, file, O_WRONLY);
        writeText(m, file, fh, "draft");
        await time.tickAsync(400);
        writeText(m, file, fh, "final", 0);
        await time.tickAsync(400);

        expect(m.bridge.callsTo("writeValue")).toEqual([]);
        const flushed = output.line(/flush-ok/);
        await time.tickAsync(100);
        await flushed;
        expect(m.bridge.callsTo("writeValue")).toEqual([
          { method: "writeValue", jsonPath: ["title"], value: "final" },
        ]);
      });

      it("commits the latest buffer again when a write lands while a commit is in flight", async () => {
        using time = new FakeTime();
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "title", "", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["title"]));
        const firstWrite = Promise.withResolvers<void>();
        const original = m.bridge.writeValue;
        m.bridge.writeValue = (path, value) => {
          const done = original(path, value);
          return value === "one" ? firstWrite.promise.then(() => done) : done;
        };
        const fh = openFile(m, file, O_WRONLY);
        writeText(m, file, fh, "one");
        flushFile(m, file, fh);
        // A second write while the first commit is in flight; its own timer
        // finds the commit in flight and waits for it.
        writeText(m, file, fh, "two", 0);
        await time.tickAsync(500);
        expect(m.bridge.callsTo("writeValue").map((call) => call.value))
          .toEqual(["one"]);

        const second = output.line(/flush-ok.*\n?/);
        firstWrite.resolve();
        await second;
        const both = Promise.withResolvers<void>();
        m.bridge.next("finalizeWritePath").then(() => both.resolve());
        await time.tickAsync(10);
        await both.promise;

        expect(m.bridge.callsTo("writeValue").map((call) => call.value))
          .toEqual(["one", "two"]);
      });

      it("does not commit a buffer whose scheduled flush finds the bridge disconnected", async () => {
        using time = new FakeTime();
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "title", "", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["title"]));
        const fh = openFile(m, file, O_WRONLY);
        writeText(m, file, fh, "draft");
        m.bridge.disconnected = true;

        await time.tickAsync(500);

        expect(m.bridge.calls).toEqual([]);
        expect(m.operations.status().writes.flushed).toBe(0);
      });

      it("lets a reader holding the file open read it empty once another descriptor opens it with `O_TRUNC`", () => {
        using _time = new FakeTime();
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "f", "abcdef", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["f"]));
        const reader = openFile(m, file, O_RDONLY);

        openFile(m, file, O_WRONLY | linuxPlatform.O_TRUNC);
        const { req, id } = request();
        m.operations.handlers.read(
          req,
          file,
          100n,
          0n,
          m.args.fileInfo(O_RDONLY, reader),
        );

        expect(m.fuse.replyTo(id)).toEqual({ kind: "data", text: "" });
      });

      it("lets a reader holding the file open read the truncated content after a truncate by path", () => {
        using _time = new FakeTime();
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "f", "abcdef", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["f"]));
        const reader = openFile(m, file, O_RDONLY);

        m.operations.handlers.setattr(
          request().req,
          file,
          m.args.statWithSize(2),
          8,
          null,
        );
        const { req, id } = request();
        m.operations.handlers.read(
          req,
          file,
          100n,
          0n,
          m.args.fileInfo(O_RDONLY, reader),
        );

        expect(m.fuse.replyTo(id)).toEqual({ kind: "data", text: "ab" });
      });

      it("refuses a truncate through a read-only descriptor with `EINVAL`, as `ftruncate()` does", () => {
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "f", "abcdef", "string");
        const tool = m.tree.addCallable(
          m.tree.rootIno,
          "t.tool",
          "tool",
          "t",
          "result",
          new TextEncoder().encode("#!/bin/sh\n"),
        );
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["f"]));
        const replies = [file, tool].map((ino) => {
          const fh = openFile(m, ino, O_RDONLY);
          const { req, id } = request();
          m.operations.handlers.setattr(
            req,
            ino,
            m.args.statWithSize(2),
            8,
            m.args.fileInfo(O_RDONLY, fh),
          );
          return m.fuse.replyTo(id);
        });

        expect(replies).toEqual([
          { kind: "err", errno: EINVAL },
          { kind: "err", errno: EINVAL },
        ]);
        expect(contentOf(m.tree, file)).toBe("abcdef");
        expect(m.bridge.calls).toEqual([]);
      });

      it("refuses a write through a read-only descriptor with `EBADF`", () => {
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "f", "abcdef", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["f"]));
        const fh = openFile(m, file, O_RDONLY);

        expect(writeText(m, file, fh, "xy")).toEqual({
          kind: "err",
          errno: EBADF,
        });
        expect(contentOf(m.tree, file)).toBe("abcdef");
        expect(m.bridge.calls).toEqual([]);
      });

      it("ignores `O_TRUNC` on a read-only open, serving the file whole", () => {
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "f", "abcdef", "string");
        const fh = openFile(m, file, O_RDONLY | linuxPlatform.O_TRUNC);
        const { req, id } = request();

        m.operations.handlers.read(
          req,
          file,
          100n,
          0n,
          m.args.fileInfo(O_RDONLY, fh),
        );

        expect(m.fuse.replyTo(id)).toEqual({ kind: "data", text: "abcdef" });
        expect(contentOf(m.tree, file)).toBe("abcdef");
      });

      it("counts a flush that fails while reporting its own failure", async () => {
        using _time = new FakeTime();
        class FailingStore extends CfcWritebackStore {
          override markRunnerCommitFailed(): never {
            throw new Error("state file is read-only");
          }
        }
        const m = mount({ cfcWritebacks: new FailingStore() });
        const file = m.tree.addFile(m.tree.rootIno, "title", "", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["title"]));
        m.bridge.writeValue = () => Promise.reject(new Error("denied"));
        const fh = openFile(m, file, O_WRONLY);
        writeText(m, file, fh, "x");
        const logged = output.line(/flush write error/);

        flushFile(m, file, fh);

        expect(await logged).toBe(
          "[fuse] flush write error: state file is read-only",
        );
        expect(m.operations.status().writes.lastError).toBe(
          "state file is read-only",
        );
      });

      it("discards writes to an AppleDouble sidecar instead of sending them", async () => {
        using _time = new FakeTime();
        const m = mount();
        const sidecar = m.tree.addFile(m.tree.rootIno, "._notes", "", "string");
        const fh = openFile(m, sidecar, O_WRONLY);
        expect(writeText(m, sidecar, fh, "resource fork")).toEqual({
          kind: "write",
          size: "resource fork".length,
        });
        const closed = m.bridge.next(`close ${sidecar}`);
        releaseFile(m, sidecar, fh);
        await closed;

        expect(m.bridge.calls).toEqual([]);
        expect(output.lines).toContain(
          `[write-trace] open ino=${sidecar} fh=${fh} target=ignored`,
        );
      });

      it("counts a write that the cell refused, and marks the bridge disconnected for an outage", async () => {
        using _time = new FakeTime();
        const m = mount();
        const refused = m.tree.addFile(m.tree.rootIno, "a", "", "string");
        const outage = m.tree.addFile(m.tree.rootIno, "b", "", "string");
        m.bridge.writePaths.set(refused, writePath(fakePiece(EMPTY), ["a"]));
        m.bridge.writePaths.set(outage, writePath(fakePiece(EMPTY), ["b"]));
        m.bridge.writeValue = (path) =>
          Promise.reject(
            new Error(
              path.jsonPath[0] === "a" ? "schema mismatch" : "transport closed",
            ),
          );

        for (const ino of [refused, outage]) {
          const fh = openFile(m, ino, O_WRONLY);
          writeText(m, ino, fh, "x");
          const failed = output.line(new RegExp(`flush-err ino=${ino}`));
          flushFile(m, ino, fh);
          await failed;
        }

        expect(output.lines).toContain(
          "[fuse] flush error: Error: schema mismatch",
        );
        expect(m.bridge.disconnectReasons).toEqual([
          expect.stringContaining("transport closed"),
        ]);
        expect(m.operations.status().writes).toMatchObject({
          flushed: 0,
          flushErrors: 2,
          lastError: expect.stringContaining("transport closed"),
        });
      });

      it("refuses writes, flushes, and releases with `EROFS` once the bridge is disconnected", () => {
        using _time = new FakeTime();
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "title", "", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["title"]));
        const fh = openFile(m, file, O_WRONLY);
        writeText(m, file, fh, "draft");
        m.bridge.disconnected = true;

        expect(writeText(m, file, fh, "more")).toEqual({
          kind: "err",
          errno: EROFS,
        });
        expect(flushFile(m, file, fh)).toEqual({ kind: "err", errno: EROFS });
        expect(releaseFile(m, file, fh)).toEqual({ kind: "err", errno: EROFS });
        expect(m.bridge.retained).toContain(`open-${file}`);
        expect(m.bridge.calls).toEqual([]);
      });

      it("replies `EIO` to a write through an unknown descriptor and a range error to a write past the size limit", () => {
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "title", "", "string");
        const unknown = request();
        m.operations.handlers.write(
          unknown.req,
          file,
          m.args.bytes(new Uint8Array(1)),
          1n,
          0n,
          m.args.fileInfo(O_WRONLY, 4242n),
        );
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["title"]));
        const fh = openFile(m, file, O_WRONLY);
        const tooFar = request();
        m.operations.handlers.write(
          tooFar.req,
          file,
          null,
          1n,
          BigInt(Number.MAX_SAFE_INTEGER),
          m.args.fileInfo(O_WRONLY, fh),
        );
        const negative = request();
        m.operations.handlers.write(
          negative.req,
          file,
          null,
          1n,
          -1n,
          m.args.fileInfo(O_WRONLY, fh),
        );

        expect(m.fuse.replyTo(unknown.id)).toEqual({ kind: "err", errno: EIO });
        expect(errno(m.fuse.replyTo(tooFar.id))).toBe(27); // EFBIG
        expect(m.fuse.replyTo(negative.id)).toEqual({
          kind: "err",
          errno: EINVAL,
        });
      });

      it("answers a flush with nothing to commit without touching the bridge", () => {
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "f", "x", "string");
        const fh = openFile(m, file, O_RDONLY);

        expect(flushFile(m, file, fh)).toEqual({ kind: "err", errno: 0 });
        expect(releaseFile(m, file, fh)).toEqual({ kind: "err", errno: 0 });
        expect(m.bridge.calls).toEqual([]);
        expect(m.bridge.retained).toEqual([`open+${file}`, `open-${file}`]);
      });

      it("empties a file opened with `O_TRUNC` and commits the empty value", async () => {
        using time = new FakeTime();
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "title", "old", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["title"]));
        const fh = openFile(m, file, O_WRONLY | linuxPlatform.O_TRUNC);
        const read = request();
        m.operations.handlers.read(
          read.req,
          file,
          10n,
          0n,
          m.args.fileInfo(O_WRONLY, fh),
        );
        expect(m.fuse.replyTo(read.id)).toEqual({ kind: "data", text: "" });

        // The flush of an empty truncating open waits briefly for content.
        flushFile(m, file, fh);
        const flushed = output.line(/flush-ok/);
        await time.tickAsync(25);
        await flushed;
        expect(m.bridge.callsTo("writeValue")).toEqual([
          { method: "writeValue", jsonPath: ["title"], value: "" },
        ]);
      });
      it("commits the empty value when a descriptor opened with `O_TRUNC` is released unwritten", async () => {
        using _time = new FakeTime();
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "title", "old", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["title"]));
        const fh = openFile(m, file, O_WRONLY | linuxPlatform.O_TRUNC);
        const closed = m.bridge.next(`close ${file}`);

        releaseFile(m, file, fh);
        await closed;

        expect(m.bridge.callsTo("writeValue")).toEqual([
          { method: "writeValue", jsonPath: ["title"], value: "" },
        ]);
      });
    });

    describe("writing to a handler", () => {
      it("sends what is written to a handler as the value it spells", async () => {
        using _time = new FakeTime();
        const m = mount();
        const handler = m.tree.addCallable(
          m.tree.rootIno,
          "addItem.handler",
          "handler",
          "addItem",
          "input",
          new TextEncoder().encode("#!/bin/sh\n"),
        );
        m.bridge.handlerTargets.set(handler, {
          piece: fakePiece(EMPTY),
          cellProp: "input",
          cellKey: "addItem",
        });
        for (
          const [text, value] of [["book\n", "book"], ['{"n":1}', { n: 1 }]]
        ) {
          const fh = openFile(m, handler, O_WRONLY | linuxPlatform.O_TRUNC);
          writeText(m, handler, fh, text as string);
          const sent = output.line(/kind=handler/);
          flushFile(m, handler, fh);
          await time();
          await sent;
          output.lines.length = 0;
          releaseFile(m, handler, fh);
          expect(m.bridge.callsTo("sendToHandlerTarget").at(-1)).toEqual({
            method: "sendToHandlerTarget",
            cellKey: "addItem",
            value,
          });
        }
        expect(output.lines).not.toContain(expect.stringContaining("error"));

        async function time() {
          await _time.tickAsync(25);
        }
      });

      it("truncates what was written to a handler before it is sent", async () => {
        using _time = new FakeTime();
        const m = mount();
        const handler = m.tree.addCallable(
          m.tree.rootIno,
          "addItem.handler",
          "handler",
          "addItem",
          "input",
          new Uint8Array(0),
        );
        m.bridge.handlerTargets.set(handler, {
          piece: fakePiece(EMPTY),
          cellProp: "input",
          cellKey: "addItem",
        });
        const fh = openFile(m, handler, O_WRONLY);
        writeText(m, handler, fh, "bookshelf");
        const { req, id } = request();

        m.operations.handlers.setattr(
          req,
          handler,
          m.args.statWithSize(4),
          8,
          m.args.fileInfo(O_WRONLY, fh),
        );
        const sent = m.bridge.next("sendToHandlerTarget");
        releaseFile(m, handler, fh);
        await sent;

        expect(m.fuse.replyTo(id)).toMatchObject({ kind: "attr" });
        expect(m.bridge.callsTo("sendToHandlerTarget")).toEqual([
          { method: "sendToHandlerTarget", cellKey: "addItem", value: "book" },
        ]);
      });

      it("sends again through a descriptor truncated after its first send", async () => {
        const m = mount();
        const handler = m.tree.addCallable(
          m.tree.rootIno,
          "addItem.handler",
          "handler",
          "addItem",
          "input",
          new Uint8Array(0),
        );
        m.bridge.handlerTargets.set(handler, {
          piece: fakePiece(EMPTY),
          cellProp: "input",
          cellKey: "addItem",
        });
        const fh = openFile(m, handler, O_WRONLY);
        const send = async (text: string) => {
          writeText(m, handler, fh, text);
          const { req, id } = request();
          m.operations.handlers.flush(
            req,
            handler,
            m.args.fileInfo(O_WRONLY, fh),
          );
          return await m.fuse.nextReply(id);
        };
        expect(await send("book")).toEqual({ kind: "err", errno: 0 });
        const truncate = request();

        m.operations.handlers.setattr(
          truncate.req,
          handler,
          m.args.statWithSize(0),
          8,
          m.args.fileInfo(O_WRONLY, fh),
        );

        expect(m.fuse.replyTo(truncate.id)).toMatchObject({ kind: "attr" });
        expect(await send("pen")).toEqual({ kind: "err", errno: 0 });
        releaseFile(m, handler, fh);
        expect(m.bridge.callsTo("sendToHandlerTarget")).toEqual([
          { method: "sendToHandlerTarget", cellKey: "addItem", value: "book" },
          { method: "sendToHandlerTarget", cellKey: "addItem", value: "pen" },
        ]);
      });

      it("serves a callable's script to a reader and refuses a write to a tool", () => {
        const m = mount();
        const tool = m.tree.addCallable(
          m.tree.rootIno,
          "search.tool",
          "tool",
          "search",
          "result",
          new TextEncoder().encode("#!/bin/sh\necho hi\n"),
        );
        const fh = openFile(m, tool, O_RDONLY);
        const read = request();
        m.operations.handlers.read(
          read.req,
          tool,
          100n,
          0n,
          m.args.fileInfo(O_RDONLY, fh),
        );
        const write = request();
        m.operations.handlers.open(write.req, tool, m.args.fileInfo(O_WRONLY));

        expect(m.fuse.replyTo(read.id)).toEqual({
          kind: "data",
          text: "#!/bin/sh\necho hi\n",
        });
        expect(m.fuse.replyTo(write.id)).toEqual({
          kind: "err",
          errno: EACCES,
        });
      });

      it("refuses to open a handler for writing without a target, while disconnected, or while CFC is enforced", () => {
        const script = new TextEncoder().encode("#!/bin/sh\n");
        const open = (m: Mount, ino: bigint) => {
          const { req, id } = request();
          m.operations.handlers.open(req, ino, m.args.fileInfo(O_WRONLY));
          return m.fuse.replyTo(id);
        };
        const untargeted = mount();
        const a = untargeted.tree.addCallable(
          untargeted.tree.rootIno,
          "a.handler",
          "handler",
          "a",
          "input",
          script,
        );
        const disconnected = mount();
        const b = disconnected.tree.addCallable(
          disconnected.tree.rootIno,
          "b.handler",
          "handler",
          "b",
          "input",
          script,
        );
        disconnected.bridge.disconnected = true;
        const enforced = mount({ cfcMode: "enforce-strict" });
        const c = enforced.tree.addCallable(
          enforced.tree.rootIno,
          "c.handler",
          "handler",
          "c",
          "input",
          script,
        );

        expect(open(untargeted, a)).toEqual({ kind: "err", errno: EACCES });
        expect(open(disconnected, b)).toEqual({ kind: "err", errno: EROFS });
        expect(open(enforced, c)).toEqual({ kind: "err", errno: EACCES });
      });
    });

    describe("writing a pattern's source", () => {
      const program = {
        main: "/main.tsx",
        mainExport: "default",
        files: [
          { name: "/main.tsx", contents: "export default 1;" },
          { name: "util.ts", contents: "export const u = 1;" },
        ],
        sourceRoots: ["/main.test.tsx"],
        dataFiles: ["/data.json"],
      };
      const receipt = {
        status: "committed" as const,
        ref: { identity: "A".repeat(43), symbol: "default" },
        revisionId: "revision-1",
        detachedOrigin: null,
        space: "did:key:test" as const,
        seq: 7,
        refresh: { status: "completed" as const },
      };

      /** A mount with `.src/main.tsx` and `.src/util.ts` for a piece. */
      function sourceMount(
        source: Partial<
          Pick<PieceController, "getPatternSourceProgram" | "setPattern">
        >,
      ) {
        const m = mount({ dangerouslyAllowIncompatibleSchema: true });
        const src = m.tree.addDir(m.tree.rootIno, ".src");
        const piece = fakePiece(EMPTY, source);
        const files = new Map<string, bigint>();
        for (const name of ["main.tsx", "util.ts", "gone.ts"]) {
          const ino = m.tree.addFile(src, name, "old", "string");
          files.set(name, ino);
          m.bridge.sourceWritePaths.set(ino, {
            spaceName: "home",
            pieceName: "notes",
            relPath: name,
            piece,
            srcIno: src,
          });
        }
        return { m, files };
      }

      async function writeSource(
        m: Mount,
        ino: bigint,
        text: string | Uint8Array,
      ): Promise<void> {
        const fh = openFile(m, ino, O_WRONLY);
        const bytes = typeof text === "string"
          ? new TextEncoder().encode(text)
          : text;
        const { req } = request();
        m.operations.handlers.write(
          req,
          ino,
          m.args.bytes(bytes),
          BigInt(bytes.length),
          0n,
          m.args.fileInfo(O_WRONLY, fh),
        );
        const closed = m.bridge.next(`close ${ino}`);
        releaseFile(m, ino, fh);
        await closed;
      }

      it("rebuilds the pattern with the edited file and keeps its roots and data files", async () => {
        using _time = new FakeTime();
        const updates: unknown[] = [];
        const { m, files } = sourceMount({
          getPatternSourceProgram: () => Promise.resolve(program),
          setPattern: (next, options) => {
            updates.push({ next, options });
            return Promise.resolve(receipt);
          },
        });

        await writeSource(m, files.get("util.ts")!, "export const u = 2;");

        expect(updates).toEqual([{
          next: {
            main: "/main.tsx",
            mainExport: "default",
            files: [
              { name: "/main.tsx", contents: "export default 1;" },
              { name: "util.ts", contents: "export const u = 2;" },
            ],
            sourceRoots: ["/main.test.tsx"],
            dataFiles: ["/data.json"],
          },
          options: { dangerouslyAllowIncompatibleSchema: true },
        }]);
        expect(m.bridge.calls).toEqual([
          { method: "writeSourceErrorLog", relPath: "util.ts", text: "" },
          { method: "finalizeSourceWritePath", relPath: "util.ts", receipt },
        ]);
        expect(contentOf(m.tree, files.get("util.ts")!)).toBe(
          "export const u = 2;",
        );
      });

      it("records a refresh failure after the commit in the error log", async () => {
        using _time = new FakeTime();
        const { m, files } = sourceMount({
          getPatternSourceProgram: () => Promise.resolve(program),
          setPattern: () => Promise.resolve(receipt),
        });
        m.bridge.finalizeSourceWritePath = () =>
          Promise.reject(new Error("transport closed"));

        await writeSource(m, files.get("main.tsx")!, "export default 2;");

        const logged = m.bridge.callsTo("writeSourceErrorLog");
        expect(logged.length).toBe(2);
        expect(logged[1].text).toContain(
          "refreshing the FUSE projection failed",
        );
        expect(m.bridge.disconnectReasons.length).toBe(1);
      });

      it("records a compile error in the error log and sends nothing for a write that is not UTF-8", async () => {
        using _time = new FakeTime();
        const { m, files } = sourceMount({
          getPatternSourceProgram: () => Promise.resolve(program),
          setPattern: () => Promise.reject(new Error("Type error in main")),
        });

        await writeSource(m, files.get("main.tsx")!, "export default ;");
        await writeSource(
          m,
          files.get("util.ts")!,
          new Uint8Array([0xff, 0xfe]),
        );

        expect(m.bridge.calls).toEqual([
          {
            method: "writeSourceErrorLog",
            relPath: "main.tsx",
            text: "Type error in main",
          },
        ]);
        expect(output.lines).toContain(
          "[source] Write to util.ts is not valid UTF-8 text",
        );
      });

      it("refuses a write when the source cannot be recovered or does not hold the file", async () => {
        using _time = new FakeTime();
        const lost = sourceMount({
          getPatternSourceProgram: () => Promise.reject(new Error("gone")),
        });
        const empty = sourceMount({
          getPatternSourceProgram: () => Promise.resolve(undefined),
        });
        const partial = sourceMount({
          getPatternSourceProgram: () => Promise.resolve(program),
        });

        await writeSource(lost.m, lost.files.get("main.tsx")!, "x");
        await writeSource(empty.m, empty.files.get("main.tsx")!, "x");
        await writeSource(partial.m, partial.files.get("gone.ts")!, "x");

        expect(output.lines).toEqual(expect.arrayContaining([
          "[source] Failed to get pattern source: Error: gone",
          "[source] No recoverable source program for main.tsx",
          '[source] File "gone.ts" not found in pattern files: [/main.tsx, util.ts]',
        ]));
        for (const { m } of [lost, empty, partial]) {
          expect(m.bridge.calls).toEqual([]);
          expect(m.operations.status().writes.flushed).toBe(0);
        }
      });

      it("marks the bridge disconnected when reading or committing the source finds an outage", async () => {
        using _time = new FakeTime();
        const reading = sourceMount({
          getPatternSourceProgram: () =>
            Promise.reject(new Error("transport closed")),
        });
        const committing = sourceMount({
          getPatternSourceProgram: () => Promise.resolve(program),
          setPattern: () => Promise.reject(new Error("ConnectionError")),
        });

        await writeSource(reading.m, reading.files.get("main.tsx")!, "x");
        await writeSource(committing.m, committing.files.get("main.tsx")!, "x");

        expect(reading.m.bridge.disconnectReasons.length).toBe(1);
        expect(committing.m.bridge.disconnectReasons.length).toBe(1);
        expect(committing.m.bridge.calls).toEqual([]);
      });
    });

    describe("setattr", () => {
      it("replies `ENOENT` for a missing inode", () => {
        const m = mount();
        const { req, id } = request();

        m.operations.handlers.setattr(req, 999n, null, 0, null);

        expect(m.fuse.replyTo(id)).toEqual({ kind: "err", errno: ENOENT });
      });

      it("accepts a change of mode or times and replies with the attributes unchanged", () => {
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "f", "abc", "string");
        const sidecar = m.tree.addFile(m.tree.rootIno, "._f", "", "string");
        const chmod = request();
        m.operations.handlers.setattr(chmod.req, file, null, 1, null);
        const touchSidecar = request();
        m.operations.handlers.setattr(touchSidecar.req, sidecar, null, 8, null);

        expect(m.fuse.replyTo(chmod.id)).toMatchObject({
          kind: "attr",
          attr: { ino: file, size: 3 },
        });
        expect(m.fuse.replyTo(touchSidecar.id)).toMatchObject({
          kind: "attr",
          attr: { ino: sidecar },
        });
      });

      it("truncates the buffer of an open descriptor to the size asked for", () => {
        using _time = new FakeTime();
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "f", "", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["f"]));
        const fh = openFile(m, file, O_RDWR);
        writeText(m, file, fh, "abcdef");
        const { req, id } = request();

        m.operations.handlers.setattr(
          req,
          file,
          m.args.statWithSize(2),
          8,
          m.args.fileInfo(O_RDWR, fh),
        );

        expect(m.fuse.replyTo(id)).toMatchObject({ kind: "attr" });
        const read = request();
        m.operations.handlers.read(
          read.req,
          file,
          100n,
          0n,
          m.args.fileInfo(O_RDWR, fh),
        );
        expect(m.fuse.replyTo(read.id)).toEqual({ kind: "data", text: "ab" });
      });

      it("truncates a file without a descriptor and commits the shortened value", async () => {
        using _time = new FakeTime();
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "f", "abcdef", "string");
        m.bridge.writePaths.set(file, writePath(fakePiece(EMPTY), ["f"]));
        const closed = m.bridge.next(`close ${file}`);
        const { req, id } = request();

        m.operations.handlers.setattr(
          req,
          file,
          m.args.statWithSize(3),
          8,
          null,
        );

        expect(m.fuse.replyTo(id)).toMatchObject({
          kind: "attr",
          attr: { size: 3 },
        });
        expect(contentOf(m.tree, file)).toBe("abc");
        await m.bridge.next("finalizeWritePath");
        expect(m.bridge.callsTo("writeValue")).toEqual([
          { method: "writeValue", jsonPath: ["f"], value: "abc" },
        ]);
        void closed;
      });

      it("accepts a truncate of a handler without a descriptor and refuses one it cannot write", () => {
        const m = mount();
        const handler = m.tree.addCallable(
          m.tree.rootIno,
          "go.handler",
          "handler",
          "go",
          "input",
          new Uint8Array(0),
        );
        const dir = m.tree.addDir(m.tree.rootIno, "d");
        const unwritable = m.tree.addFile(m.tree.rootIno, "u", "x", "string");
        const results = [handler, dir, unwritable].map((ino) => {
          const { req, id } = request();
          m.operations.handlers.setattr(
            req,
            ino,
            m.args.statWithSize(0),
            8,
            null,
          );
          return m.fuse.replyTo(id);
        });

        expect(results[0]).toMatchObject({ kind: "attr" });
        expect(results[1]).toEqual({ kind: "err", errno: EACCES });
        expect(results[2]).toEqual({ kind: "err", errno: EACCES });
      });

      it("refuses a size change past the size limit, and any change while disconnected", () => {
        const m = mount();
        const file = m.tree.addFile(m.tree.rootIno, "f", "x", "string");
        const tooLarge = request();
        m.operations.handlers.setattr(
          tooLarge.req,
          file,
          m.args.statWithSize(Number.MAX_SAFE_INTEGER),
          8,
          null,
        );
        m.bridge.disconnected = true;
        const disconnected = request();
        m.operations.handlers.setattr(disconnected.req, file, null, 1, null);

        expect(errno(m.fuse.replyTo(tooLarge.id))).toBe(27); // EFBIG
        expect(m.fuse.replyTo(disconnected.id)).toEqual({
          kind: "err",
          errno: EROFS,
        });
      });
    });

    describe("changing a directory", () => {
      // A directory of a piece's cell is an object or an array in the cell.
      // Each change is made to the tree and answered at once, and the cell
      // write follows.

      /**
       * A mount with directory `items`, whose cell value is `items`, holding
       * an entry per key of that value; each resolves to a write path.
       */
      function directoryMount(
        items: Record<string, unknown> | unknown[],
        options: Parameters<typeof mount>[0] = {},
      ) {
        const m = mount(options);
        const piece = fakePiece({ input: { items }, result: {} });
        const dir = m.tree.addDir(
          m.tree.rootIno,
          "items",
          Array.isArray(items) ? "array" : "object",
        );
        m.bridge.writePaths.set(dir, writePath(piece, ["items"]));
        const children = new Map<string, bigint>();
        for (const [key, value] of Object.entries(items)) {
          const ino = typeof value === "object"
            ? m.tree.addDir(dir, key, "object")
            : m.tree.addFile(dir, key, String(value), "string");
          children.set(key, ino);
          m.bridge.writePaths.set(ino, writePath(piece, ["items", key]));
        }
        return { m, piece, dir, children };
      }

      function namespaceRequest(
        m: Mount,
        operation: "unlink" | "rmdir" | "mkdir",
        parent: bigint,
        name: string,
      ): Reply {
        const { req, id } = request();
        if (operation === "mkdir") {
          m.operations.handlers.mkdir(req, parent, m.args.string(name), 0o755);
        } else {
          m.operations.handlers[operation](req, parent, m.args.string(name));
        }
        return m.fuse.replyTo(id);
      }

      function rename(
        m: Mount,
        oldParent: bigint,
        oldName: string,
        newParent: bigint,
        newName: string,
      ): Reply {
        const { req, id } = request();
        m.operations.handlers.rename(
          req,
          oldParent,
          m.args.string(oldName),
          newParent,
          m.args.string(newName),
        );
        return m.fuse.replyTo(id);
      }

      describe("create", () => {
        it("adds an empty file, replies with it opened, and writes an empty string to the cell", async () => {
          const { m, dir } = directoryMount({});
          const finalized = m.bridge.next("finalizeWritePath");
          const { req, id } = request();

          m.operations.handlers.create(
            req,
            dir,
            m.args.string("of%3Anote"),
            0o644,
            m.args.fileInfo(O_RDWR),
          );

          const ino = m.tree.lookup(dir, "of%3Anote");
          assert(ino !== undefined);
          expect(m.fuse.replyTo(id)).toMatchObject({
            kind: "create",
            ino,
            attr: { mode: FILE_MODE_RW, size: 0 },
          });
          await finalized;
          expect(m.bridge.calls).toEqual([
            { method: "writeValue", jsonPath: ["items", "of:note"], value: "" },
            { method: "finalizeWritePath", jsonPath: ["items"] },
          ]);
        });

        it("keeps an AppleDouble sidecar in the tree only", () => {
          const { m, dir } = directoryMount({});
          const existing = m.tree.addFile(dir, "._b", "", "string");
          const replies = ["._a", "._b"].map((name) => {
            const { req, id } = request();
            m.operations.handlers.create(
              req,
              dir,
              m.args.string(name),
              0o644,
              m.args.fileInfo(O_RDWR),
            );
            return m.fuse.replyTo(id);
          });

          expect(replies[0]).toMatchObject({
            kind: "create",
            ino: m.tree.lookup(dir, "._a"),
          });
          expect(replies[1]).toMatchObject({ kind: "create", ino: existing });
          expect(m.bridge.calls).toEqual([]);
        });

        it("refuses a file where nothing can be written, and while disconnected", () => {
          const { m } = directoryMount({});
          const unwritable = m.tree.addDir(m.tree.rootIno, "unwritable");
          const staticMount = mount({ bridge: null });
          const results = [
            [staticMount, staticMount.tree.rootIno],
            [m, unwritable],
          ].map(([target, parent]) => {
            const { req, id } = request();
            (target as Mount).operations.handlers.create(
              req,
              parent as bigint,
              (target as Mount).args.string("x"),
              0o644,
              (target as Mount).args.fileInfo(O_RDWR),
            );
            return (target as Mount).fuse.replyTo(id);
          });
          const disconnected = directoryMount({});
          disconnected.m.bridge.disconnected = true;
          const { req, id } = request();
          disconnected.m.operations.handlers.create(
            req,
            disconnected.dir,
            disconnected.m.args.string("x"),
            0o644,
            disconnected.m.args.fileInfo(O_RDWR),
          );

          expect(results).toEqual([
            { kind: "err", errno: EACCES },
            { kind: "err", errno: EACCES },
          ]);
          expect(disconnected.m.fuse.replyTo(id)).toEqual({
            kind: "err",
            errno: EROFS,
          });
          expect(disconnected.m.tree.lookup(disconnected.dir, "x"))
            .toBeUndefined();
        });

        it("logs a cell write that fails after the reply", async () => {
          const { m, dir } = directoryMount({});
          m.bridge.writeValue = () => Promise.reject(new Error("denied"));
          const logged = output.line(/create write error/);
          const { req } = request();

          m.operations.handlers.create(
            req,
            dir,
            m.args.string("x"),
            0o644,
            m.args.fileInfo(O_RDWR),
          );

          expect(await logged).toBe("[fuse] create write error: denied");
          expect(m.operations.status().writes.flushErrors).toBe(1);
        });
      });

      describe("mkdir", () => {
        it("adds a directory, replies with its entry, and writes an empty object to the cell", async () => {
          const { m, dir } = directoryMount({});
          const finalized = m.bridge.next("finalizeWritePath");

          const reply = namespaceRequest(m, "mkdir", dir, "sub");

          expect(reply).toMatchObject({
            kind: "entry",
            ino: m.tree.lookup(dir, "sub"),
            attr: { mode: DIR_MODE },
          });
          await finalized;
          expect(m.bridge.calls).toEqual([
            { method: "writeValue", jsonPath: ["items", "sub"], value: {} },
            { method: "finalizeWritePath", jsonPath: ["items"] },
          ]);
        });

        it("refuses a directory where nothing can be written, and while disconnected", async () => {
          const staticMount = mount({ bridge: null });
          const { m } = directoryMount({});
          const unwritable = m.tree.addDir(m.tree.rootIno, "unwritable");
          const disconnected = directoryMount({});
          disconnected.m.bridge.disconnected = true;
          const failing = directoryMount({});
          failing.m.bridge.writeValue = () =>
            Promise.reject(new Error("denied"));
          const logged = output.line(/mkdir write error/);

          expect(
            namespaceRequest(
              staticMount,
              "mkdir",
              staticMount.tree.rootIno,
              "x",
            ),
          ).toEqual({ kind: "err", errno: EACCES });
          expect(namespaceRequest(m, "mkdir", unwritable, "x"))
            .toEqual({ kind: "err", errno: EACCES });
          expect(
            namespaceRequest(disconnected.m, "mkdir", disconnected.dir, "x"),
          ).toEqual({ kind: "err", errno: EROFS });
          namespaceRequest(failing.m, "mkdir", failing.dir, "x");
          expect(await logged).toBe("[fuse] mkdir write error: denied");
        });
      });

      describe("unlink", () => {
        it("removes a key and its `.json` sibling from an object and writes the object back", async () => {
          const { m, dir, children } = directoryMount({ a: "1", b: "2" });
          m.tree.addFile(dir, "a.json", '"1"', "string");
          const finalized = m.bridge.next("finalizeWritePath");

          expect(namespaceRequest(m, "unlink", dir, "a")).toEqual({
            kind: "err",
            errno: 0,
          });

          expect(m.tree.lookup(dir, "a")).toBeUndefined();
          expect(m.tree.lookup(dir, "a.json")).toBeUndefined();
          expect(m.tree.lookup(dir, "b")).toBe(children.get("b"));
          await finalized;
          expect(m.bridge.calls).toEqual([
            { method: "writeValue", jsonPath: ["items"], value: { b: "2" } },
            { method: "finalizeWritePath", jsonPath: ["items"] },
          ]);
        });

        it("removes the directory beside a `.json` file it unlinks", () => {
          const { m, dir, children } = directoryMount({ a: { x: 1 } });
          const json = m.tree.addFile(dir, "a.json", "{}", "object");
          m.bridge.writePaths.set(json, writePath(fakePiece(EMPTY), ["a"]));

          namespaceRequest(m, "unlink", dir, "a.json");

          expect(m.tree.lookup(dir, "a")).toBeUndefined();
          expect(m.tree.getNode(children.get("a")!)).toBeUndefined();
        });

        it("splices an element out of an array, and writes nothing for an index past its end", async () => {
          const { m, dir } = directoryMount(["x", "y", "z"]);
          const stray = m.tree.addFile(dir, "7", "", "string");
          m.bridge.writePaths.set(stray, writePath(fakePiece(EMPTY), ["7"]));
          const finalized = m.bridge.next("finalizeWritePath");

          namespaceRequest(m, "unlink", dir, "1");
          await finalized;
          namespaceRequest(m, "unlink", dir, "7");

          expect(m.bridge.callsTo("writeValue")).toEqual([
            { method: "writeValue", jsonPath: ["items"], value: ["x", "z"] },
          ]);
          expect(m.tree.lookup(dir, "7")).toBeUndefined();
        });

        it("deletes an AppleDouble sidecar from the tree only", () => {
          const { m, dir } = directoryMount({});
          m.tree.addFile(dir, "._a", "", "string");

          expect(namespaceRequest(m, "unlink", dir, "._a")).toEqual({
            kind: "err",
            errno: 0,
          });
          expect(m.tree.lookup(dir, "._a")).toBeUndefined();
          expect(m.bridge.calls).toEqual([]);
        });

        it("refuses a name that is missing, unwritable, or under an unwritable parent, and any while disconnected", () => {
          const { m, dir, children } = directoryMount({ a: "1", b: "2" });
          const loose = m.tree.addFile(dir, "loose", "", "string");
          const orphanParent = m.tree.addDir(m.tree.rootIno, "orphans");
          const orphan = m.tree.addFile(orphanParent, "o", "", "string");
          m.bridge.writePaths.set(orphan, writePath(fakePiece(EMPTY), ["o"]));
          const staticMount = mount({ bridge: null });

          expect(namespaceRequest(m, "unlink", dir, "missing")).toEqual({
            kind: "err",
            errno: ENOENT,
          });
          expect(namespaceRequest(m, "unlink", dir, "loose")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(namespaceRequest(m, "unlink", orphanParent, "o")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(
            namespaceRequest(
              staticMount,
              "unlink",
              staticMount.tree.rootIno,
              "x",
            ),
          ).toEqual({ kind: "err", errno: EACCES });
          m.bridge.disconnected = true;
          expect(namespaceRequest(m, "unlink", dir, "a")).toEqual({
            kind: "err",
            errno: EROFS,
          });
          expect(m.tree.lookup(dir, "a")).toBe(children.get("a"));
          expect(m.tree.lookup(dir, "loose")).toBe(loose);
        });

        it("logs a cell write that fails after the reply", async () => {
          const { m, dir } = directoryMount({ a: "1" });
          m.bridge.writeValue = () => Promise.reject(new Error("denied"));
          const logged = output.line(/unlink write error/);

          namespaceRequest(m, "unlink", dir, "a");

          expect(await logged).toBe("[fuse] unlink write error: denied");
        });
      });

      describe("rmdir", () => {
        it("removes a directory and its `.json` sibling from an object and writes the object back", async () => {
          const { m, dir } = directoryMount({ a: { x: 1 }, b: "2" });
          m.tree.addFile(dir, "a.json", "{}", "object");
          const finalized = m.bridge.next("finalizeWritePath");

          expect(namespaceRequest(m, "rmdir", dir, "a")).toEqual({
            kind: "err",
            errno: 0,
          });

          expect(m.tree.lookup(dir, "a")).toBeUndefined();
          expect(m.tree.lookup(dir, "a.json")).toBeUndefined();
          await finalized;
          expect(m.bridge.callsTo("writeValue")).toEqual([
            { method: "writeValue", jsonPath: ["items"], value: { b: "2" } },
          ]);
        });

        it("splices a directory out of an array", async () => {
          const { m, dir } = directoryMount([{ n: 1 }, { n: 2 }]);
          const finalized = m.bridge.next("finalizeWritePath");

          namespaceRequest(m, "rmdir", dir, "0");
          await finalized;

          expect(m.bridge.callsTo("writeValue")).toEqual([
            { method: "writeValue", jsonPath: ["items"], value: [{ n: 2 }] },
          ]);
        });

        it("refuses a name that is missing, a file, unwritable, or under an unwritable parent, and any while disconnected", () => {
          const { m, dir } = directoryMount({ a: { x: 1 }, f: "1" });
          m.tree.addDir(dir, "loose");
          const orphanParent = m.tree.addDir(m.tree.rootIno, "orphans");
          const orphan = m.tree.addDir(orphanParent, "o");
          m.bridge.writePaths.set(orphan, writePath(fakePiece(EMPTY), ["o"]));
          const staticMount = mount({ bridge: null });

          expect(namespaceRequest(m, "rmdir", dir, "missing")).toEqual({
            kind: "err",
            errno: ENOENT,
          });
          expect(namespaceRequest(m, "rmdir", dir, "f")).toEqual({
            kind: "err",
            errno: ENOTDIR,
          });
          expect(namespaceRequest(m, "rmdir", dir, "loose")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(namespaceRequest(m, "rmdir", orphanParent, "o")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(
            namespaceRequest(
              staticMount,
              "rmdir",
              staticMount.tree.rootIno,
              "x",
            ),
          ).toEqual({ kind: "err", errno: EACCES });
          m.bridge.disconnected = true;
          expect(namespaceRequest(m, "rmdir", dir, "a")).toEqual({
            kind: "err",
            errno: EROFS,
          });
        });

        it("logs a cell write that fails after the reply", async () => {
          const { m, dir } = directoryMount({ a: { x: 1 } });
          m.bridge.finalizeWritePath = () =>
            Promise.reject(new Error("transport closed"));
          const logged = output.line(/rmdir write error/);

          namespaceRequest(m, "rmdir", dir, "a");

          expect(await logged).toContain("transport closed");
          expect(m.bridge.disconnectReasons.length).toBe(1);
        });
      });

      describe("rename", () => {
        it("moves a value to its new name in an object and deletes the old key", async () => {
          const { m, dir, children } = directoryMount({ a: "1", b: "2" });
          const finalized = m.bridge.next("finalizeWritePath");

          expect(rename(m, dir, "a", dir, "c")).toEqual({
            kind: "err",
            errno: 0,
          });

          expect(m.tree.lookup(dir, "c")).toBe(children.get("a"));
          expect(m.tree.lookup(dir, "a")).toBeUndefined();
          await finalized;
          expect(m.bridge.calls).toEqual([
            { method: "writeValue", jsonPath: ["items", "c"], value: "1" },
            { method: "writeValue", jsonPath: ["items"], value: { b: "2" } },
            { method: "finalizeWritePath", jsonPath: ["items"] },
          ]);
        });

        it("splices the old element out of an array parent and finalizes both directories", async () => {
          const m = mount();
          const piece = fakePiece({
            input: { list: ["x", "y"], other: {} },
            result: {},
          });
          const list = m.tree.addDir(m.tree.rootIno, "list", "array");
          const other = m.tree.addDir(m.tree.rootIno, "other", "object");
          const element = m.tree.addFile(list, "0", "x", "string");
          m.bridge.writePaths.set(list, writePath(piece, ["list"]));
          m.bridge.writePaths.set(other, writePath(piece, ["other"]));
          m.bridge.writePaths.set(element, writePath(piece, ["list", 0]));
          const finalizedOld = Promise.withResolvers<void>();
          m.bridge.finalizeWritePath = (path) => {
            m.bridge.calls.push({
              method: "finalizeWritePath",
              jsonPath: path.jsonPath,
            });
            if (path.jsonPath[0] === "list") finalizedOld.resolve();
            return Promise.resolve();
          };

          rename(m, list, "0", other, "moved");
          await finalizedOld.promise;

          expect(m.bridge.calls).toEqual([
            { method: "writeValue", jsonPath: ["other", "moved"], value: "x" },
            { method: "writeValue", jsonPath: ["list"], value: ["y"] },
            { method: "finalizeWritePath", jsonPath: ["other"] },
            { method: "finalizeWritePath", jsonPath: ["list"] },
          ]);
        });

        it("refuses a move to another cell with `EXDEV`", () => {
          const { m, dir } = directoryMount({ a: "1" });
          const elsewhere = m.tree.addDir(m.tree.rootIno, "elsewhere");
          m.bridge.writePaths.set(
            elsewhere,
            writePath(fakePiece(EMPTY), [], { cell: "result" }),
          );

          expect(rename(m, dir, "a", elsewhere, "a")).toEqual({
            kind: "err",
            errno: EXDEV,
          });
          expect(m.tree.lookup(dir, "a")).toBeDefined();
        });

        it("refuses a name that is missing or unwritable, a destination or source directory that is unwritable, and any move while disconnected", () => {
          const { m, dir } = directoryMount({ a: "1" });
          m.tree.addFile(dir, "loose", "", "string");
          const unwritable = m.tree.addDir(m.tree.rootIno, "unwritable");
          const orphan = m.tree.addFile(unwritable, "o", "", "string");
          m.bridge.writePaths.set(orphan, writePath(fakePiece(EMPTY), ["o"]));
          const staticMount = mount({ bridge: null });

          expect(rename(m, dir, "missing", dir, "x")).toEqual({
            kind: "err",
            errno: ENOENT,
          });
          expect(rename(m, dir, "loose", dir, "x")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(rename(m, dir, "a", unwritable, "x")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(rename(m, unwritable, "o", dir, "x")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(
            rename(
              staticMount,
              staticMount.tree.rootIno,
              "x",
              staticMount.tree.rootIno,
              "y",
            ),
          ).toEqual({ kind: "err", errno: EACCES });
          m.bridge.disconnected = true;
          expect(rename(m, dir, "a", dir, "b")).toEqual({
            kind: "err",
            errno: EROFS,
          });
        });

        it("logs a cell write that fails after the reply", async () => {
          const { m, dir } = directoryMount({ a: "1" });
          m.bridge.writeValue = () => Promise.reject(new Error("denied"));
          const logged = output.line(/rename write error/);

          rename(m, dir, "a", dir, "b");

          expect(await logged).toBe("[fuse] rename write error: denied");
        });
      });

      describe("symlink", () => {
        function symlink(
          m: Mount,
          target: string,
          parent: bigint,
          name: string,
        ): Reply {
          const { req, id } = request();
          m.operations.handlers.symlink(
            req,
            m.args.string(target),
            parent,
            m.args.string(name),
          );
          return m.fuse.replyTo(id);
        }

        it("adds a link, replies with its entry, and writes the cell link its target names", async () => {
          const { m, dir } = directoryMount({});
          const invalidated = m.bridge.next("invalidateWritePath");

          const reply = symlink(m, "../of:target", dir, "ref");

          const ino = m.tree.lookup(dir, "ref");
          expect(reply).toMatchObject({ kind: "entry", ino });
          expect(m.tree.getNode(ino!)).toMatchObject({
            kind: "symlink",
            target: "../of:target",
          });
          await invalidated;
          expect(m.bridge.calls).toEqual([
            {
              method: "writeValue",
              jsonPath: ["items", "ref"],
              value: linkRefFrom({ id: "of:target" }),
            },
            { method: "invalidateWritePath", jsonPath: ["items"] },
          ]);
        });

        it("finalizes the parent instead of invalidating it when CFC annotations are on", async () => {
          const { m, dir } = directoryMount({}, {
            cfcAnnotationsEnabled: true,
          });
          const finalized = m.bridge.next("finalizeWritePath");

          symlink(m, "../of:target", dir, "ref");
          await finalized;

          expect(m.bridge.callsTo("invalidateWritePath")).toEqual([]);
        });

        it("refuses a target that names no cell, an unwritable directory, and any link while disconnected", async () => {
          const { m, dir } = directoryMount({});
          const unwritable = m.tree.addDir(m.tree.rootIno, "unwritable");
          const staticMount = mount({ bridge: null });

          expect(symlink(m, "/etc/passwd", dir, "x")).toEqual({
            kind: "err",
            errno: EINVAL,
          });
          expect(symlink(m, "../of:t", unwritable, "x")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(symlink(staticMount, "../t", staticMount.tree.rootIno, "x"))
            .toEqual({ kind: "err", errno: EACCES });
          m.bridge.disconnected = true;
          expect(symlink(m, "../of:t", dir, "x")).toEqual({
            kind: "err",
            errno: EROFS,
          });
          expect(m.tree.lookup(dir, "x")).toBeUndefined();

          const failing = directoryMount({});
          failing.m.bridge.writeValue = () =>
            Promise.reject(new Error("denied"));
          const logged = output.line(/symlink write error/);
          symlink(failing.m, "../of:t", failing.dir, "x");
          expect(await logged).toBe("[fuse] symlink write error: denied");
        });
      });
    });

    describe("Contextual Flow Control", () => {
      // A labeled node may change only through a writeback the writer
      // announced first, by setting the prepare extended attribute. These
      // cases run the mount as an enforcing one unless they say otherwise.

      const SECRET = {
        confidentiality: [{ type: "test-label", value: "secret" }],
      };

      /**
       * A mount over a labeled `result` directory holding a labeled `title`,
       * each resolving to a write path of the piece's result cell.
       */
      function labeledMount(
        cfcMode: CfcEnforcementMode = "enforce-strict",
      ) {
        const m = mount({
          cfcMode,
          cfcAnnotationsEnabled: true,
          cfcWritebackXattrs: true,
        });
        const annotator = new CfcProjectionAnnotator(m.tree, {
          space: "did:key:zSpace",
          entity: "of:piece",
          rootKind: "pieces",
          cell: "result",
          generation: "generation-1",
          labelView: {
            version: 1,
            entries: [{ path: ["title"], label: SECRET }],
          },
        });
        const dir = m.tree.addDir(m.tree.rootIno, "result", "object");
        annotator.annotateJsonDirectory(dir, [], { title: "old" });
        const file = m.tree.addFile(dir, "title", "old", "string");
        annotator.annotateJsonScalar(file, ["title"], "old");
        annotator.annotateEntry(dir, "title", file, { labelPath: ["title"] });
        const piece = fakePiece({ input: {}, result: { title: "old" } });
        m.bridge.writePaths.set(
          dir,
          writePath(piece, [], { cell: "result" }),
        );
        m.bridge.writePaths.set(
          file,
          writePath(piece, ["title"], { cell: "result" }),
        );
        const fileRef = m.tree.getCfcAnnotation(file)!.ref!;
        const dirRef = m.tree.getCfcAnnotation(dir)!.ref!;
        return { m, dir, file, fileRef, dirRef };
      }

      function prepareJson(
        operation: string,
        ref: unknown,
        target: Record<string, unknown> = {},
      ): string {
        return JSON.stringify({
          version: 1,
          operation,
          target: { ref, ...target },
          expectedGeneration: "generation-1",
          labels: {
            contentLabel: SECRET,
            nameLabel: SECRET,
            existenceLabel: SECRET,
            namespaceLabel: SECRET,
            metadataLabels: { type: SECRET, mode: SECRET },
          },
        });
      }

      function setXattr(
        m: Mount,
        ino: bigint,
        name: string,
        value: string,
      ): Reply {
        const bytes = new TextEncoder().encode(value);
        const { req, id } = request();
        m.operations.handlers.setxattr(
          req,
          ino,
          m.args.string(name),
          m.args.bytes(bytes),
          BigInt(bytes.length),
          0,
        );
        return m.fuse.replyTo(id);
      }

      function removeXattr(m: Mount, ino: bigint, name: string): Reply {
        const { req, id } = request();
        m.operations.handlers.removexattr(req, ino, m.args.string(name));
        return m.fuse.replyTo(id);
      }

      function prepare(
        m: Mount,
        ino: bigint,
        operation: string,
        ref: unknown,
        target: Record<string, unknown> = {},
      ): void {
        expect(
          setXattr(
            m,
            ino,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareJson(operation, ref, target),
          ),
        ).toEqual({ kind: "err", errno: 0 });
      }

      function openReply(m: Mount, ino: bigint, flags: number): Reply {
        const { req, id } = request();
        m.operations.handlers.open(req, ino, m.args.fileInfo(flags));
        return m.fuse.replyTo(id);
      }

      describe("writing a labeled file", () => {
        it("refuses to open the file for writing without a prepared writeback", () => {
          const { m, file } = labeledMount();

          expect(openReply(m, file, O_WRONLY)).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(output.lines).toContainEqual(
            expect.stringContaining("[FUSE:CFC] denied write:"),
          );
        });

        it("writes the file a prepare announced, and retires the prepared writeback once the cell commits", async () => {
          using _time = new FakeTime();
          const { m, file, fileRef } = labeledMount();
          prepare(m, file, "write", fileRef);
          expect(m.cfcWritebacks.getPrepared(file, "write")).toBeDefined();

          const fh = openFile(m, file, O_WRONLY);
          writeText(m, file, fh, "new");
          const flushed = output.line(/flush-ok/);
          flushFile(m, file, fh);
          await flushed;

          expect(m.bridge.callsTo("writeValue")).toEqual([
            { method: "writeValue", jsonPath: ["title"], value: "new" },
          ]);
          expect(m.cfcWritebacks.getPrepared(file, "write")).toBeUndefined();
        });

        it("needs a prepared write as well as a truncate to write through a truncating descriptor", () => {
          using _time = new FakeTime();
          const { m, file, fileRef } = labeledMount();
          prepare(m, file, "truncate", fileRef);
          const fh = openFile(m, file, O_WRONLY | linuxPlatform.O_TRUNC);

          expect(writeText(m, file, fh, "x")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          prepare(m, file, "write", fileRef);
          expect(writeText(m, file, fh, "x")).toEqual({
            kind: "write",
            size: 1,
          });
          expect(writeText(m, file, fh, "xy")).toEqual({
            kind: "write",
            size: 2,
          });
        });

        it("allows an unprepared write in observe mode and records why it would have been refused", () => {
          const { m, file } = labeledMount("observe");

          expect(openReply(m, file, O_WRONLY)).toMatchObject({ kind: "open" });
          const { cfc } = m.operations.status();
          expect(cfc).toMatchObject({
            mode: "observe",
            annotations: true,
            writebackXattrs: true,
          });
          expect((cfc.diagnostics as string[]).length).toBeGreaterThan(0);
        });

        it("refuses a truncate without a prepared writeback and applies one that was prepared", () => {
          const { m, file, fileRef } = labeledMount();
          const refused = request();
          m.operations.handlers.setattr(
            refused.req,
            file,
            m.args.statWithSize(0),
            8,
            null,
          );
          prepare(m, file, "truncate", fileRef);
          const allowed = request();
          m.operations.handlers.setattr(
            allowed.req,
            file,
            m.args.statWithSize(0),
            8,
            null,
          );

          expect(m.fuse.replyTo(refused.id)).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(m.fuse.replyTo(allowed.id)).toMatchObject({
            kind: "attr",
            attr: { size: 0 },
          });
        });
      });

      describe("changing a labeled file's metadata", () => {
        it("refuses a mode change without a prepared writeback", () => {
          const { m, file } = labeledMount();
          const { req, id } = request();

          m.operations.handlers.setattr(req, file, null, 1, null);

          expect(m.fuse.replyTo(id)).toEqual({ kind: "err", errno: EACCES });
        });

        it("applies a prepared mode change and finalizes it through the cell's write path", async () => {
          const { m, file, fileRef } = labeledMount();
          prepare(m, file, "setattr-metadata", fileRef, {
            metadataFields: ["mode"],
          });
          const finalized = m.bridge.next("finalizeWritePath");
          const { req, id } = request();

          m.operations.handlers.setattr(req, file, null, 1, null);

          expect(m.fuse.replyTo(id)).toMatchObject({ kind: "attr" });
          await finalized;
          await Promise.resolve();
          expect(m.cfcWritebacks.getPrepared(file, "setattr-metadata"))
            .toBeUndefined();
        });

        it("finalizes a prepared mode change of a source file through the source write path, and records a failed finalize", async () => {
          const { m, file, fileRef } = labeledMount();
          m.bridge.writePaths.delete(file);
          m.bridge.sourceWritePaths.set(file, {
            spaceName: "home",
            pieceName: "notes",
            relPath: "main.tsx",
            piece: fakePiece(EMPTY),
            srcIno: m.tree.rootIno,
          });
          prepare(m, file, "setattr-metadata", fileRef, {
            metadataFields: ["mode"],
          });
          const finalized = m.bridge.next("finalizeSourceWritePath");
          m.operations.handlers.setattr(request().req, file, null, 1, null);
          await finalized;

          const failing = labeledMount();
          prepare(
            failing.m,
            failing.file,
            "setattr-metadata",
            failing.fileRef,
            {
              metadataFields: ["mode"],
            },
          );
          failing.m.bridge.finalizeWritePath = () =>
            Promise.reject(new Error("commit refused"));
          const logged = output.line(/metadata finalize error/);
          failing.m.operations.handlers.setattr(
            request().req,
            failing.file,
            null,
            1,
            null,
          );

          expect(await logged).toBe(
            "[fuse] metadata finalize error: Error: commit refused",
          );

          const failingSource = labeledMount();
          failingSource.m.bridge.writePaths.delete(failingSource.file);
          failingSource.m.bridge.sourceWritePaths.set(failingSource.file, {
            spaceName: "home",
            pieceName: "notes",
            relPath: "main.tsx",
            piece: fakePiece(EMPTY),
            srcIno: failingSource.m.tree.rootIno,
          });
          prepare(
            failingSource.m,
            failingSource.file,
            "setattr-metadata",
            failingSource.fileRef,
            { metadataFields: ["mode"] },
          );
          failingSource.m.bridge.finalizeSourceWritePath = () =>
            Promise.reject(new Error("commit refused"));
          const loggedSource = output.line(/metadata source finalize error/);
          failingSource.m.operations.handlers.setattr(
            request().req,
            failingSource.file,
            null,
            1,
            null,
          );
          expect(await loggedSource).toBe(
            "[fuse] metadata source finalize error: Error: commit refused",
          );
        });
      });

      describe("changing a labeled directory", () => {
        it("refuses to create or make a directory without a prepared writeback, and creates what was prepared", () => {
          // Applying a prepared change moves the directory to a new
          // generation, which leaves a second change prepared against the old
          // one stale, so each prepared change gets a mount of its own.

          const create = (m: Mount, dir: bigint, name: string) => {
            const { req, id } = request();
            m.operations.handlers.create(
              req,
              dir,
              m.args.string(name),
              0o644,
              m.args.fileInfo(O_RDWR),
            );
            return m.fuse.replyTo(id);
          };
          const mkdir = (m: Mount, dir: bigint, name: string) => {
            const { req, id } = request();
            m.operations.handlers.mkdir(req, dir, m.args.string(name), 0o755);
            return m.fuse.replyTo(id);
          };
          const unprepared = labeledMount();
          const created = labeledMount();
          prepare(created.m, created.dir, "create", created.dirRef, {
            name: "a",
          });
          const made = labeledMount();
          prepare(made.m, made.dir, "mkdir", made.dirRef, { name: "b" });

          expect(create(unprepared.m, unprepared.dir, "a")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(mkdir(unprepared.m, unprepared.dir, "b")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(create(created.m, created.dir, "a")).toMatchObject({
            kind: "create",
          });
          expect(mkdir(made.m, made.dir, "b")).toMatchObject({
            kind: "entry",
          });
          expect(
            created.m.tree.getCfcAnnotation(
              created.m.tree.lookup(created.dir, "a")!,
            ),
          ).toBeDefined();
        });

        it("refuses to unlink, remove, rename, or link without a prepared writeback", () => {
          const { m, dir } = labeledMount();
          const sub = m.tree.addDir(dir, "sub", "object");
          m.bridge.writePaths.set(sub, writePath(fakePiece(EMPTY), ["sub"]));
          const replies: Reply[] = [];
          const record = (send: (req: Deno.PointerValue) => void) => {
            const { req, id } = request();
            send(req);
            replies.push(m.fuse.replyTo(id));
          };

          record((req) =>
            m.operations.handlers.unlink(req, dir, m.args.string("title"))
          );
          record((req) =>
            m.operations.handlers.rmdir(req, dir, m.args.string("sub"))
          );
          record((req) =>
            m.operations.handlers.rename(
              req,
              dir,
              m.args.string("title"),
              dir,
              m.args.string("name"),
            )
          );
          record((req) =>
            m.operations.handlers.symlink(
              req,
              m.args.string("../of:x"),
              dir,
              m.args.string("link"),
            )
          );

          expect(replies).toEqual([
            { kind: "err", errno: EACCES },
            { kind: "err", errno: EACCES },
            { kind: "err", errno: EACCES },
            { kind: "err", errno: EACCES },
          ]);
          expect(m.tree.lookup(dir, "title")).toBeDefined();
          expect(m.tree.lookup(dir, "sub")).toBe(sub);
        });

        it("unlinks, renames, and links what was prepared", async () => {
          const unlinked = labeledMount();
          const { m: um, dir: udir } = unlinked;
          prepare(um, udir, "unlink", unlinked.dirRef, { name: "title" });
          const renamed = labeledMount();
          const target = {
            sourceName: "title",
            destinationName: "heading",
          };
          prepare(renamed.m, renamed.dir, "rename-source", renamed.dirRef, {
            name: "title",
            ...target,
          });
          prepare(
            renamed.m,
            renamed.dir,
            "rename-destination",
            renamed.dirRef,
            { name: "heading", ...target },
          );
          const removed = labeledMount();
          const sub = removed.m.tree.addDir(removed.dir, "sub", "object");
          removed.m.bridge.writePaths.set(
            sub,
            writePath(fakePiece(EMPTY), ["sub"], { cell: "result" }),
          );
          prepare(removed.m, removed.dir, "rmdir", removed.dirRef, {
            name: "sub",
          });
          const linked = labeledMount();
          prepare(linked.m, linked.dir, "symlink", linked.dirRef, {
            name: "link",
            targetText: "../of:x",
          });
          const settled = linked.m.bridge.next("finalizeWritePath");
          const send = (m: Mount, call: (req: Deno.PointerValue) => void) => {
            const { req, id } = request();
            call(req);
            return m.fuse.replyTo(id);
          };

          expect(
            send(
              um,
              (req) =>
                um.operations.handlers.unlink(
                  req,
                  udir,
                  um.args.string("title"),
                ),
            ),
          ).toEqual({ kind: "err", errno: 0 });
          expect(
            send(renamed.m, (req) =>
              renamed.m.operations.handlers.rename(
                req,
                renamed.dir,
                renamed.m.args.string("title"),
                renamed.dir,
                renamed.m.args.string("heading"),
              )),
          ).toEqual({ kind: "err", errno: 0 });
          expect(
            send(linked.m, (req) =>
              linked.m.operations.handlers.symlink(
                req,
                linked.m.args.string("../of:x"),
                linked.dir,
                linked.m.args.string("link"),
              )),
          ).toMatchObject({ kind: "entry" });
          expect(
            send(removed.m, (req) =>
              removed.m.operations.handlers.rmdir(
                req,
                removed.dir,
                removed.m.args.string("sub"),
              )),
          ).toEqual({ kind: "err", errno: 0 });
          expect(removed.m.tree.lookup(removed.dir, "sub")).toBeUndefined();
          expect(um.tree.lookup(udir, "title")).toBeUndefined();
          expect(renamed.m.tree.lookup(renamed.dir, "heading")).toBeDefined();
          expect(linked.m.tree.lookup(linked.dir, "link")).toBeDefined();
          await settled;
        });
      });

      describe("in an enforcing mount", () => {
        it("refuses an unprepared change to a labeled directory alike whether or not the name exists", () => {
          // A refusal that came only after the lookup would answer `ENOENT`
          // for a missing name and `EEXIST` or a success for a present one,
          // telling a writer without a prepared writeback which names exist.

          const { m, dir } = labeledMount();
          const sub = m.tree.addDir(dir, "sub", "object");
          m.bridge.writePaths.set(sub, writePath(fakePiece(EMPTY), ["sub"]));
          const send = (call: (req: Deno.PointerValue) => void) => {
            const { req, id } = request();
            call(req);
            return m.fuse.replyTo(id);
          };
          const removals = ["title", "missing"].flatMap((name) => [
            send((req) =>
              m.operations.handlers.unlink(req, dir, m.args.string(name))
            ),
            send((req) =>
              m.operations.handlers.rename(
                req,
                dir,
                m.args.string(name),
                dir,
                m.args.string("other"),
              )
            ),
          ]);
          const directoryRemovals = ["sub", "missing"].map((name) =>
            send((req) =>
              m.operations.handlers.rmdir(req, dir, m.args.string(name))
            )
          );
          const additions = ["title", "missing"].flatMap((name) => [
            send((req) =>
              m.operations.handlers.create(
                req,
                dir,
                m.args.string(name),
                0o644,
                m.args.fileInfo(O_RDWR),
              )
            ),
            send((req) =>
              m.operations.handlers.mkdir(req, dir, m.args.string(name), 0o755)
            ),
          ]);

          for (
            const reply of [...removals, ...directoryRemovals, ...additions]
          ) {
            expect(reply).toEqual({ kind: "err", errno: EACCES });
          }
          expect(m.tree.lookup(dir, "title")).toBeDefined();
          expect(m.tree.lookup(dir, "missing")).toBeUndefined();
        });

        it("refuses a change in a directory that cannot be written before looking the name up", () => {
          const m = mount({ cfcMode: "enforce-strict" });
          const dir = m.tree.addDir(m.tree.rootIno, "d");
          const writable = m.tree.addDir(m.tree.rootIno, "w");
          m.bridge.writePaths.set(writable, writePath(fakePiece(EMPTY), []));
          const replies = [
            (req: Deno.PointerValue) =>
              m.operations.handlers.unlink(req, dir, m.args.string("x")),
            (req: Deno.PointerValue) =>
              m.operations.handlers.rmdir(req, dir, m.args.string("x")),
            (req: Deno.PointerValue) =>
              m.operations.handlers.rename(
                req,
                dir,
                m.args.string("x"),
                writable,
                m.args.string("y"),
              ),
            (req: Deno.PointerValue) =>
              m.operations.handlers.rename(
                req,
                writable,
                m.args.string("x"),
                dir,
                m.args.string("y"),
              ),
          ].map((send) => {
            const { req, id } = request();
            send(req);
            return m.fuse.replyTo(id);
          });

          // A mount that does not enforce says the name is missing instead.
          const open = mount();
          const openDir = open.tree.addDir(open.tree.rootIno, "d");
          const { req, id } = request();
          open.operations.handlers.unlink(req, openDir, open.args.string("x"));

          expect(replies).toEqual(
            Array(4).fill({ kind: "err", errno: EACCES }),
          );
          expect(open.fuse.replyTo(id)).toEqual({ kind: "err", errno: ENOENT });
        });
      });

      describe("linking by target identity", () => {
        it("links when the target resolves to the cell the prepare named, and refuses another", () => {
          const matching = labeledMount();
          prepare(matching.m, matching.dir, "symlink", matching.dirRef, {
            name: "link",
            targetIdentity: { id: "of:x" },
          });
          const other = labeledMount();
          prepare(other.m, other.dir, "symlink", other.dirRef, {
            name: "link",
            targetIdentity: { id: "of:y" },
          });
          const link = (m: Mount, dir: bigint) => {
            const { req, id } = request();
            m.operations.handlers.symlink(
              req,
              m.args.string("../of:x"),
              dir,
              m.args.string("link"),
            );
            return m.fuse.replyTo(id);
          };

          expect(link(matching.m, matching.dir)).toMatchObject({
            kind: "entry",
          });
          expect(link(other.m, other.dir)).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(other.m.tree.lookup(other.dir, "link")).toBeUndefined();
        });
      });

      it("renames into another labeled directory what both directories prepared", async () => {
        const { m, dir, dirRef } = labeledMount();
        const annotator = new CfcProjectionAnnotator(m.tree, {
          space: "did:key:zSpace",
          entity: "of:piece",
          rootKind: "pieces",
          cell: "result",
          generation: "generation-1",
          labelView: { version: 1, entries: [] },
        });
        const nested = m.tree.addDir(dir, "nested", "object");
        annotator.annotateJsonDirectory(nested, ["nested"], {});
        m.bridge.writePaths.set(
          nested,
          writePath(fakePiece({ input: {}, result: { nested: {} } }), [
            "nested",
          ], { cell: "result" }),
        );
        const nestedRef = m.tree.getCfcAnnotation(nested)!.ref!;
        const names = { sourceName: "title", destinationName: "heading" };
        prepare(m, dir, "rename-source", dirRef, { name: "title", ...names });
        prepare(m, nested, "rename-destination", nestedRef, {
          name: "heading",
          ...names,
        });
        const finalized = m.bridge.next("finalizeWritePath");
        const { req, id } = request();

        m.operations.handlers.rename(
          req,
          dir,
          m.args.string("title"),
          nested,
          m.args.string("heading"),
        );

        expect(m.fuse.replyTo(id)).toEqual({ kind: "err", errno: 0 });
        expect(m.tree.lookup(nested, "heading")).toBeDefined();
        await finalized;
      });

      it("reports the 50 most recent diagnostics", () => {
        const { m, dir } = labeledMount("observe");
        const names = Array.from(
          { length: 60 },
          (_, i) => `n${String(i).padStart(2, "0")}`,
        );
        for (const name of names) {
          m.operations.handlers.mkdir(
            request().req,
            dir,
            m.args.string(name),
            0o755,
          );
        }

        expect(m.operations.status().cfc.diagnostics).toEqual(
          names.slice(10).map((name) =>
            `missing prepared CFC writeback metadata for mkdir:${name}`
          ),
        );
      });

      it("applies a prepared mode change of a mount without a bridge and leaves it unfinalized", () => {
        const { m, file, fileRef } = labeledMount();
        const staticMount = mount({
          tree: m.tree,
          bridge: null,
          cfcMode: "enforce-strict",
          cfcWritebackXattrs: true,
        });
        prepare(staticMount, file, "setattr-metadata", fileRef, {
          metadataFields: ["mode"],
        });
        const { req, id } = request();

        staticMount.operations.handlers.setattr(req, file, null, 1, null);

        expect(staticMount.fuse.replyTo(id)).toMatchObject({ kind: "attr" });
        expect(
          staticMount.cfcWritebacks.getPrepared(file, "setattr-metadata"),
        ).toBeDefined();
      });

      describe("the writeback extended attributes", () => {
        it("refuses them unless writeback attributes are on, and while disconnected", () => {
          const off = mount();
          const file = off.tree.addFile(off.tree.rootIno, "f", "", "string");
          const { m, file: labeled } = labeledMount();
          m.bridge.disconnected = true;

          expect(setXattr(off, file, CFC_WRITEBACK_PREPARE_XATTR, "{}"))
            .toEqual({ kind: "err", errno: EACCES });
          expect(removeXattr(off, file, CFC_WRITEBACK_PREPARE_XATTR))
            .toEqual({ kind: "err", errno: EACCES });
          expect(setXattr(m, labeled, CFC_WRITEBACK_PREPARE_XATTR, "{}"))
            .toEqual({ kind: "err", errno: EROFS });
          expect(removeXattr(m, labeled, CFC_WRITEBACK_PREPARE_XATTR))
            .toEqual({ kind: "err", errno: EROFS });
        });

        it("refuses other attribute names, and a payload that does not parse", () => {
          const { m, file } = labeledMount();

          expect(setXattr(m, file, "user.other", "x")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(removeXattr(m, file, "user.other")).toEqual({
            kind: "err",
            errno: EACCES,
          });
          expect(setXattr(m, file, CFC_WRITEBACK_PREPARE_XATTR, "{"))
            .toEqual({ kind: "err", errno: EINVAL });
          expect(setXattr(m, file, CFC_WRITEBACK_PREPARE_XATTR, ""))
            .toEqual({ kind: "err", errno: EINVAL });
          expect(output.lines).toContainEqual(
            expect.stringContaining(
              `[FUSE:CFC] rejected ${CFC_WRITEBACK_PREPARE_XATTR}`,
            ),
          );
        });

        it("retires a prepared writeback through the finalize attribute, and drops them all through removal", () => {
          const { m, file, fileRef } = labeledMount();
          prepare(m, file, "write", fileRef);

          expect(
            setXattr(
              m,
              file,
              CFC_WRITEBACK_FINALIZE_XATTR,
              JSON.stringify({
                version: 1,
                operation: "write",
                committedGeneration: "generation-2",
              }),
            ),
          ).toEqual({ kind: "err", errno: 0 });
          expect(m.cfcWritebacks.getPrepared(file, "write")).toBeUndefined();

          prepare(m, file, "write", fileRef);
          prepare(m, file, "truncate", fileRef);
          expect(removeXattr(m, file, CFC_WRITEBACK_PREPARE_XATTR)).toEqual({
            kind: "err",
            errno: 0,
          });
          expect(m.cfcWritebacks.getPrepared(file, "write")).toBeUndefined();
          expect(m.cfcWritebacks.getPrepared(file, "truncate"))
            .toBeUndefined();
        });
      });

      describe("reading labels", () => {
        it("reports a node's labels as extended attributes in both namespaces", () => {
          const { m, file } = labeledMount("observe");
          const list = request();
          m.operations.handlers.listxattr(list.req, file, 4096n);
          const label = request();
          m.operations.handlers.getxattr(
            label.req,
            file,
            m.args.string("trusted.cfc.contentLabel"),
            4096n,
          );

          const listed = m.fuse.replyTo(list.id);
          assert(listed.kind === "data");
          const names = listed.text.split("\0").filter(Boolean);
          expect(names).toEqual(expect.arrayContaining([
            "user.json.type",
            "trusted.cfc.contentLabel",
            "user.commonfabric.cfc.contentLabel",
          ]));
          const value = m.fuse.replyTo(label.id);
          assert(value.kind === "data");
          expect(JSON.parse(value.text)).toEqual(SECRET);
        });
      });
    });
  });

  describe("registerFuseOperations()", () => {
    // Each case calls the table's entries back through a native function
    // pointer with the C signature libfuse calls them with, so a callback
    // declared with the wrong parameters fails here rather than in a mount.

    type NativeType = Deno.NativeType;

    /** Every operation's C parameters, and those its handler is given. */
    function signatures(platform: "linux" | "darwin") {
      const common: Record<string, NativeType[]> = {
        lookup: ["pointer", "u64", "pointer"],
        forget: ["pointer", "u64", "u64"],
        getattr: ["pointer", "u64", "pointer"],
        setattr: ["pointer", "u64", "pointer", "i32", "pointer"],
        readlink: ["pointer", "u64"],
        symlink: ["pointer", "pointer", "u64", "pointer"],
        mkdir: ["pointer", "u64", "pointer", "u32"],
        unlink: ["pointer", "u64", "pointer"],
        rmdir: ["pointer", "u64", "pointer"],
        open: ["pointer", "u64", "pointer"],
        read: ["pointer", "u64", "usize", "i64", "pointer"],
        write: ["pointer", "u64", "pointer", "usize", "i64", "pointer"],
        flush: ["pointer", "u64", "pointer"],
        release: ["pointer", "u64", "pointer"],
        opendir: ["pointer", "u64", "pointer"],
        readdir: ["pointer", "u64", "usize", "i64", "pointer"],
        releasedir: ["pointer", "u64", "pointer"],
        listxattr: ["pointer", "u64", "usize"],
        removexattr: ["pointer", "u64", "pointer"],
        create: ["pointer", "u64", "pointer", "u32", "pointer"],
      };
      // The parameter each platform passes that its handler is not given.
      const extra: Record<
        string,
        { parameters: NativeType[]; dropped: number }
      > = platform === "linux"
        ? {
          getxattr: {
            parameters: ["pointer", "u64", "pointer", "usize"],
            dropped: -1,
          },
          setxattr: {
            parameters: [
              "pointer",
              "u64",
              "pointer",
              "pointer",
              "usize",
              "i32",
            ],
            dropped: -1,
          },
          rename: {
            parameters: ["pointer", "u64", "pointer", "u64", "pointer", "u32"],
            dropped: 5,
          },
        }
        : {
          getxattr: {
            parameters: ["pointer", "u64", "pointer", "usize", "u32"],
            dropped: 4,
          },
          setxattr: {
            parameters: [
              "pointer",
              "u64",
              "pointer",
              "pointer",
              "usize",
              "i32",
              "u32",
            ],
            dropped: 6,
          },
          rename: {
            parameters: ["pointer", "u64", "pointer", "u64", "pointer"],
            dropped: -1,
          },
        };
      return [
        ...Object.entries(common).map(([name, parameters]) => ({
          name,
          parameters,
          dropped: -1,
        })),
        ...Object.entries(extra).map(([name, entry]) => ({ name, ...entry })),
      ];
    }

    /** An argument for each parameter, distinct from every other. */
    function argumentFor(type: NativeType, index: number): unknown {
      const value = 1000 + index;
      if (type === "pointer") return Deno.UnsafePointer.create(BigInt(value));
      if (type === "u64" || type === "usize" || type === "i64") {
        return BigInt(value);
      }
      return value;
    }

    /** An argument as a comparable value. */
    function normalized(argument: unknown): string {
      if (argument === null) return "null";
      if (typeof argument === "object") {
        return `pointer ${
          Deno.UnsafePointer.value(argument as Deno.PointerObject)
        }`;
      }
      return `${BigInt(argument as number | bigint)}`;
    }

    function recordingHandlers(calls: [string, string[]][]) {
      const handler = (name: string) => (...args: unknown[]) => {
        calls.push([name, args.map(normalized)]);
      };
      return {
        lookup: handler("lookup"),
        forget: handler("forget"),
        getattr: handler("getattr"),
        setattr: handler("setattr"),
        readlink: handler("readlink"),
        symlink: handler("symlink"),
        mkdir: handler("mkdir"),
        unlink: handler("unlink"),
        rmdir: handler("rmdir"),
        rename: handler("rename"),
        open: handler("open"),
        read: handler("read"),
        write: handler("write"),
        flush: handler("flush"),
        release: handler("release"),
        opendir: handler("opendir"),
        readdir: handler("readdir"),
        releasedir: handler("releasedir"),
        getxattr: handler("getxattr"),
        setxattr: handler("setxattr"),
        listxattr: handler("listxattr"),
        removexattr: handler("removexattr"),
        create: handler("create"),
      };
    }

    for (
      const [name, platform] of [
        ["linux", linuxPlatform],
        ["darwin", darwinPlatform],
      ] as const
    ) {
      describe(`with the ${name} layout`, () => {
        it("places each operation's callback at its offset, passing libfuse's arguments to the handler", () => {
          const calls: [string, string[]][] = [];
          const registered = registerFuseOperations(
            platform,
            recordingHandlers(calls),
            true,
          );
          const view = new DataView(registered.table);
          try {
            for (const operation of signatures(name)) {
              const address = view.getBigUint64(
                platform.OPS_OFFSETS[operation.name],
                true,
              );
              expect(address).not.toBe(0n);
              const args = operation.parameters.map(argumentFor);
              const call = new Deno.UnsafeFnPointer(
                Deno.UnsafePointer.create(address)!,
                { parameters: operation.parameters, result: "void" },
              );
              (call.call as (...args: unknown[]) => void)(...args);

              const passed = args.filter((_, index) =>
                index !== operation.dropped
              );
              expect(calls.at(-1)).toEqual([
                operation.name,
                passed.map(normalized),
              ]);
            }
          } finally {
            registered.close();
          }
          expect(calls.length).toBe(23);
        });

        it("leaves the extended attribute writes to the kernel unless CFC writeback attributes are on", () => {
          const registered = registerFuseOperations(
            platform,
            recordingHandlers([]),
            false,
          );
          const view = new DataView(registered.table);
          const at = (operation: string) =>
            view.getBigUint64(platform.OPS_OFFSETS[operation], true);
          try {
            expect(at("setxattr")).toBe(0n);
            expect(at("removexattr")).toBe(0n);
            expect(at("getxattr")).not.toBe(0n);
            expect(at("listxattr")).not.toBe(0n);
          } finally {
            registered.close();
          }
        });
      });
    }
  });
});
