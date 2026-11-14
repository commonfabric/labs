/**
 * A client of touch-gate, a server that creates and merges pull requests on
 * GitHub once a person approves each request by touching a FIDO2 security
 * key. The touch-gate project's `PROTOCOL.md` defines the protocol. The
 * client reads the server's address, its certificate, the secret its clients
 * share, and the credential of each registered security key from
 * `~/.config/touch-gate`, and talks to security keys through libfido2's
 * `fido2-token` and `fido2-assert` tools.
 */

import { connect as connectTls } from "@node/tls";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { join } from "@std/path";
import {
  type CreateRequest,
  type MergeRequest,
  type PullRequestService,
  pullRequestUrl,
} from "./github.ts";
import { feed } from "./blame.ts";

/** What one of libfido2's tools did. */
export interface ToolResult {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `program`, one of libfido2's tools, with `input` on its standard
 * input, stopping it when `signal` aborts. */
export type ToolRunner = (
  program: string,
  args: readonly string[],
  input: string,
  signal: AbortSignal,
) => Promise<ToolResult>;

/** A TLS connection to the server. */
export interface Connection {
  write(bytes: Uint8Array): void;

  /** Resolves with the next `length` bytes the server sends, and rejects
   * when the connection ends or fails first. */
  read(length: number): Promise<Uint8Array>;

  /** Resolves with true once the server has ended the connection with
   * nothing more to read, and with false once there is more to read. Rejects
   * when the connection fails first. */
  ended(): Promise<boolean>;

  close(): void;
}

/** Opens a TLS 1.3 connection to `host` at `port`, which must present
 * exactly the certificate whose DER encoding is `certificate`, and closes it
 * when `signal` aborts. */
export type Connect = (
  host: string,
  port: number,
  certificate: Uint8Array,
  signal: AbortSignal,
) => Promise<Connection>;

/** What the client works with. */
export interface TouchGateIo {
  /** The configuration directory. */
  readonly directory: string;

  readonly tool: ToolRunner;
  readonly connect: Connect;
}

/** The relying party that touch-gate's credentials are for. */
const RELYING_PARTY = "touch-gate";

/** The longest message the client accepts from the server, in bytes. */
const MESSAGE_LIMIT = 1 << 20;

const CREATE_PULL_REQUEST = 1;
const MERGE_PULL_REQUEST = 2;

/** A field of a request: a string, or a number sent as a u64. */
type Field = string | number;

/** Whether `name` can name a key or a token on the server. */
function validName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Returns the bytes of `parts` one after another. */
function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Returns `value` as a little-endian u32. */
function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/** Returns `value` as a protocol string: its UTF-8 bytes and a 0x00 byte. */
function encodeString(value: string): Uint8Array {
  if (value.includes("\0") || !value.isWellFormed()) {
    throw new Error(`touch-gate cannot send ${JSON.stringify(value)}`);
  }
  return concat([encoder.encode(value), new Uint8Array(1)]);
}

/** Returns the bytes of a request of type `type`, approved by the key named
 * `key`. */
export function encodeRequest(
  type: number,
  key: string,
  fields: readonly Field[],
): Uint8Array {
  return concat([
    u32(type),
    encodeString(key),
    ...fields.map((field) => {
      if (typeof field === "string") return encodeString(field);
      const out = new Uint8Array(8);
      new DataView(out.buffer).setBigUint64(0, BigInt(field), true);
      return out;
    }),
  ]);
}

/** Returns the SHA-256 hash of `bytes`. */
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** The hash a security key signs to approve `request`: the SHA-256 hash of
 * the challenge, the SHA-256 hash of the server's certificate, and the
 * request. */
export function clientDataHash(
  challenge: Uint8Array,
  certificateHash: Uint8Array,
  request: Uint8Array,
): Promise<Uint8Array> {
  return sha256(concat([challenge, certificateHash, request]));
}

/** The client's configuration. */
interface Config {
  readonly host: string;
  readonly port: number;
  readonly certificate: Uint8Array<ArrayBuffer>;
  readonly secret: Uint8Array;

  /** The credential ID of each registered security key, by its name. */
  readonly keys: ReadonlyArray<readonly [string, Uint8Array]>;
}

/** Reads the configuration in `directory`. Throws when it cannot. */
function readConfig(directory: string): Config {
  const read = (name: string) => {
    try {
      return Deno.readFileSync(join(directory, name));
    } catch (error) {
      throw new Error(
        `cannot read ${join(directory, name)}: ${describeFailure(error)}`,
      );
    }
  };
  const address = /^\[?(.+?)\]?:(\d+)$/.exec(
    new TextDecoder().decode(read("server")).trim(),
  );
  if (!address) {
    throw new Error("the touch-gate server address is not host:port");
  }
  const secret = read("secret");
  if (secret.length !== 32) {
    throw new Error("the touch-gate secret is not 32 bytes long");
  }
  let files: string[] = [];
  try {
    files = [...Deno.readDirSync(join(directory, "keys"))].map((e) => e.name)
      .filter((name) => !name.startsWith(".")).sort();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const keys = files.map((file) => {
    const name = file.endsWith(".credential")
      ? file.slice(0, -".credential".length)
      : "";
    if (!validName(name)) {
      throw new Error(
        `${join(directory, "keys", file)} is not named NAME.credential`,
      );
    }
    return [name, read(join("keys", file))] as const;
  });
  return {
    host: address[1],
    port: Number(address[2]),
    certificate: read("server.der"),
    secret,
    keys,
  };
}

/** Decodes the CBOR byte string that libfido2 wraps authenticator data in. */
function cborByteString(data: Uint8Array): Uint8Array {
  const head = data[0];
  const [length, start] = head >= 0x40 && head <= 0x57
    ? [head - 0x40, 1]
    : head === 0x58 && data.length >= 2
    ? [data[1], 2]
    : head === 0x59 && data.length >= 3
    ? [(data[1] << 8) | data[2], 3]
    : [-1, 0];
  if (length < 0 || data.length - start !== length) {
    throw new Error("the authenticator data is not a CBOR byte string");
  }
  return data.slice(start);
}

/** Returns `text`, base64 that a libfido2 tool printed, as bytes. */
function fromBase64(text: string | undefined): Uint8Array {
  try {
    return Uint8Array.fromBase64(text ?? "");
  } catch {
    throw new Error("a libfido2 tool printed something that is not base64");
  }
}

/** The security keys, as libfido2's tools reach them. */
function securityKeys(tool: ToolRunner, signal: AbortSignal) {
  const run = async (program: string, args: string[], input: string) => {
    const result = await tool(program, args, input, signal);
    if (!result.success) {
      throw new Error(`${program} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
  const input = (hash: Uint8Array, credential: Uint8Array) =>
    `${hash.toBase64()}\n${RELYING_PARTY}\n${credential.toBase64()}\n`;
  /** Whether `device` holds `credential`, asked without a touch. */
  const holds = async (device: string, credential: Uint8Array) => {
    const result = await tool(
      "fido2-assert",
      ["-G", "-t", "up=false", device],
      input(new Uint8Array(32), credential),
      signal,
    );
    const stderr = result.stderr.trim();
    // A key that speaks only U2F says it holds a credential by asking for a
    // touch.
    if (result.success || stderr.endsWith("FIDO_ERR_USER_PRESENCE_REQUIRED")) {
      return true;
    }
    if (stderr.endsWith("FIDO_ERR_NO_CREDENTIALS")) return false;
    throw new Error(`cannot ask the security key ${device}: ${stderr}`);
  };
  return {
    /**
     * Resolves with the name of a registered key that a connected security
     * key holds, that security key, and the credential. A security key that
     * cannot answer is passed over, and its failure reported only when no
     * other holds a credential.
     */
    find: async (keys: Config["keys"]) => {
      if (keys.length === 0) {
        throw new Error("no security key is registered with touch-gate");
      }
      const devices = (await run("fido2-token", ["-L"], "")).split("\n")
        .filter((line) => line.includes(": "))
        .map((line) => line.slice(0, line.indexOf(": ")));
      let failure: Error | null = null;
      for (const device of devices) {
        try {
          for (const [name, credential] of keys) {
            if (await holds(device, credential)) {
              return { name, device, credential };
            }
          }
        } catch (error) {
          signal.throwIfAborted();
          failure ??= new Error(describeFailure(error));
        }
      }
      if (failure !== null) throw failure;
      throw new Error(
        "no connected security key holds a credential registered with " +
          "touch-gate",
      );
    },

    /** Resolves with the authenticator data and the signature with which
     * `device` signs `hash`, once it is touched. */
    sign: async (device: string, hash: Uint8Array, credential: Uint8Array) => {
      const lines = (await run(
        "fido2-assert",
        ["-G", "-p", device],
        input(hash, credential),
      )).split("\n");
      return concat([
        ...[cborByteString(fromBase64(lines[2])), fromBase64(lines[3])]
          .flatMap((bytes) => [u32(bytes.length), bytes]),
      ]);
    },
  };
}

/**
 * Sends the request of type `type` with `fields` to the server, and once the
 * server sends its challenge, writes with `write` a request to touch the
 * security key to do `action`. Resolves with the server's message, and the
 * number of the pull request it created or 0, when it carried out the
 * request, and rejects with the message when it did not.
 */
async function send(
  io: TouchGateIo,
  type: number,
  fields: readonly Field[],
  action: string,
  write: (text: string) => void,
  signal: AbortSignal,
): Promise<{ readonly message: string; readonly number: number }> {
  const config = readConfig(io.directory);
  const keys = securityKeys(io.tool, signal);
  const { name, device, credential } = await keys.find(config.keys);
  const request = encodeRequest(type, name, fields);
  const connection = await io.connect(
    config.host,
    config.port,
    config.certificate,
    signal,
  );
  try {
    const view = async (length: number) => {
      const bytes = await connection.read(length);
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    const readU32 = async () => (await view(4)).getUint32(0, true);
    connection.write(concat([config.secret, request]));
    let status = await readU32();
    if (status === 0) {
      const challenge = await connection.read(32);
      const hash = await clientDataHash(
        challenge,
        await sha256(config.certificate),
        request,
      );
      write(`\nTouch the “${name}” security key to ${action}.\n`);
      connection.write(await keys.sign(device, hash, credential));
      status = await readU32();
    }
    const bytes: number[] = [];
    for (;;) {
      const [byte] = await connection.read(1);
      if (byte === 0) break;
      if (bytes.length === MESSAGE_LIMIT) {
        throw new Error("the touch-gate server sent a message too long");
      }
      bytes.push(byte);
    }
    let message: string;
    try {
      message = decoder.decode(new Uint8Array(bytes));
    } catch {
      throw new Error("the touch-gate server sent a message that is not UTF-8");
    }
    if (status !== 0) throw new Error(`touch-gate refused: ${message}`);
    // A server that names no pull request it created may end the connection
    // instead of sending a number.
    const number = type === CREATE_PULL_REQUEST && !await connection.ended()
      ? Number((await view(8)).getBigUint64(0, true))
      : 0;
    return { message, number };
  } finally {
    connection.close();
  }
}

/** Returns a service that asks the touch-gate server to create and merge
 * pull requests with the token named `token`. */
export function touchGate(token: string, io: TouchGateIo): PullRequestService {
  const check = () => {
    if (!validName(token)) {
      throw new Error(
        token === ""
          ? "no touch-gate token is set in the settings"
          : `“${token}” cannot name a touch-gate token`,
      );
    }
  };
  return {
    create: async (request: CreateRequest, write, signal) => {
      check();
      const { repository, head, base, title, body } = request;
      const { message, number } = await send(
        io,
        CREATE_PULL_REQUEST,
        [token, repository, head, base, title, body],
        "create a PR",
        write,
        signal,
      );
      return number > 0 ? pullRequestUrl(repository, number) : message;
    },
    merge: async (request: MergeRequest, write, signal) => {
      check();
      const { repository, number, method, sha } = request;
      const { message } = await send(
        io,
        MERGE_PULL_REQUEST,
        [token, repository, number, method, sha],
        "merge the PR",
        write,
        signal,
      );
      return message;
    },
  };
}

/** Runs one of libfido2's tools as a process. */
export const runTool: ToolRunner = async (program, args, input, signal) => {
  // A program started with a signal that has already aborted would run on.
  signal.throwIfAborted();
  const child = new Deno.Command(program, {
    args: [...args],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).spawn();
  // A program that exits without reading its input still has its output
  // read and its exit awaited.
  const [{ success, stdout, stderr }] = await Promise.all([
    child.output(),
    feed(child.stdin, encoder.encode(input)),
  ]);
  const text = new TextDecoder();
  return { success, stdout: text.decode(stdout), stderr: text.decode(stderr) };
};

/** Opens a TLS 1.3 connection that accepts exactly the expected certificate,
 * whatever names or dates it holds, and no other. */
export const connectPinned: Connect = (host, port, certificate, signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    // The certificate is compared with the expected one, byte for byte,
    // rather than checked against certificate authorities, names, or dates.
    const socket = connectTls({
      host,
      port,
      minVersion: "TLSv1.3",
      rejectUnauthorized: false,
    });
    let buffered: Uint8Array = new Uint8Array(0);
    let failure: Error | null = null;
    let finished = false;
    let wake = () => {};
    const fail = (error: Error) => {
      failure ??= error;
      wake();
    };
    const abort = () => socket.destroy(new Error("the request was aborted"));
    signal.addEventListener("abort", abort, { once: true });
    socket.on("data", (chunk: Uint8Array) => {
      buffered = concat([buffered, chunk]);
      wake();
    });
    socket.on("end", () => {
      finished = true;
      fail(new Error("the server closed the connection"));
    });
    socket.on("close", () => {
      signal.removeEventListener("abort", abort);
      fail(new Error("the server closed the connection"));
    });
    socket.on("error", (error: Error) => {
      fail(error);
      reject(error);
    });
    socket.on("secureConnect", () => {
      const presented: Uint8Array = socket.getPeerCertificate(true).raw;
      if (
        presented.length !== certificate.length ||
        presented.some((byte, i) => byte !== certificate[i])
      ) {
        socket.destroy();
        reject(
          new Error(
            "the touch-gate server's certificate is not the expected one",
          ),
        );
        return;
      }
      resolve({
        write: (bytes) => socket.write(bytes),
        read: async (length) => {
          while (buffered.length < length) {
            if (failure) throw failure;
            await new Promise<void>((done) => wake = done);
          }
          const out = buffered.slice(0, length);
          buffered = buffered.subarray(length);
          return out;
        },
        ended: async () => {
          while (buffered.length === 0) {
            if (finished) return true;
            if (failure) throw failure;
            await new Promise<void>((done) => wake = done);
          }
          return false;
        },
        close: () => socket.end(),
      });
    });
  });
