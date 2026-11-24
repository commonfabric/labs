import type { JSONSchema } from "@commonfabric/api";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { isObjectOrArray } from "@commonfabric/js-values/types";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";
import {
  interfaceNetworks,
  isOpenInternetAddress,
  type LocalNetwork,
  normalizeHostname,
  parseIpAddress,
} from "../network-address.ts";

export interface WebFetchToolInput {
  url: string;
  maxBytes?: number;
  maxTextChars?: number;
  timeoutMs?: number;
}

export interface WebFetchLink {
  text: string;
  href: string;
}

export interface WebFetchRedirect {
  status: number;
  url: string;
  location: string;
}

export interface WebFetchToolSuccessOutput {
  type: "cf-harness.web-fetch-result";
  outputId: string;
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType?: string;
  bytes: number;
  rawContentDigest: string;
  rawContentTruncated: boolean;
  rawContent: string;
  text: string;
  textTruncated: boolean;
  title?: string;
  links?: readonly WebFetchLink[];
  redirects?: readonly WebFetchRedirect[];
  fetchedAt: string;
}

export type WebFetchErrorCode =
  | "invalid_url"
  | "blocked_url"
  | "too_many_redirects"
  | "unsupported_content_type"
  | "fetch_failed"
  | "timeout";

export interface WebFetchToolErrorOutput {
  type: "cf-harness.web-fetch-error";
  outputId: string;
  url: string;
  code: WebFetchErrorCode;
  message: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  fetchedAt: string;
}

export type WebFetchToolOutput =
  | WebFetchToolSuccessOutput
  | WebFetchToolErrorOutput;

export type WebFetchModelFacingOutput =
  | Omit<WebFetchToolSuccessOutput, "rawContent">
  | WebFetchToolErrorOutput;

type WebFetchBytes = Uint8Array;

type WebFetchReader = ReadableStreamDefaultReader<WebFetchBytes>;

/** A connection web_fetch speaks HTTP/1.1 over. */
export interface WebFetchConnection {
  readonly readable: ReadableStream<WebFetchBytes>;
  readonly writable: WritableStream<Uint8Array>;
  close(): void;
}

export interface WebFetchTlsOptions {
  /** The host name or IP address the server's certificate must name. */
  hostname: string;
  /**
   * PEM certificates of authorities to trust beside the default roots. Only
   * tests pass this, to trust a local test authority.
   */
  caCerts?: string[];
}

/**
 * The network operations web_fetch performs: looking up a host name's
 * addresses, opening a TCP connection to an address it validated, and
 * completing a TLS handshake over a connection `connect` opened, for an
 * `https:` URL. Each is a property, so that a network whose `startTls` takes
 * only its own `Conn` is not one for any other kind of connection.
 *
 * `startTls` owns `conn` from the moment it is called: the connection it
 * returns closes `conn` when it closes, and if it fails, it closes `conn`
 * itself. web_fetch never closes a `conn` it has handed to `startTls`.
 */
export interface WebFetchNetwork<Conn extends WebFetchConnection> {
  readonly resolveDns: (
    query: string,
    recordType: "A" | "AAAA",
    options: { signal: AbortSignal },
  ) => Promise<string[]>;
  readonly connect: (options: Deno.ConnectOptions) => Promise<Conn>;
  readonly startTls: (
    conn: Conn,
    options: WebFetchTlsOptions,
  ) => Promise<WebFetchConnection>;
}

/**
 * `Deno`'s DNS, TCP and TLS. `startTls` offers only HTTP/1.1, and settles
 * once the handshake has completed, so that a certificate the server presents
 * is checked before web_fetch sends a request. A handshake the server never answers keeps the socket open until
 * the server closes it, after web_fetch has given up: closing a `Deno.TlsConn`
 * whose handshake is pending does not close its socket.
 */
export const defaultWebFetchNetwork: WebFetchNetwork<Deno.TcpConn> = {
  resolveDns: Deno.resolveDns,
  connect: Deno.connect,
  startTls: async (conn, { hostname, caCerts }) => {
    let tls: Deno.TlsConn | undefined;
    try {
      tls = await Deno.startTls(conn, {
        hostname,
        caCerts,
        alpnProtocols: ["http/1.1"],
      });
      await tls.handshake();
      return tls;
    } catch (error) {
      // Before `Deno.startTls` settles, it may or may not have taken `conn`.
      closeConnection(tls ?? conn);
      throw error;
    }
  },
};

/**
 * How web_fetch resolves names and connects, over one network, and the
 * networks this device's interfaces are on, read for each check.
 */
interface WebFetchEnvironment {
  resolveDns: WebFetchNetwork<WebFetchConnection>["resolveDns"];
  /** A connection to `address`, with TLS for an `https:` `url`. */
  openConnection: (
    url: URL,
    address: string,
    port: number,
    signal: AbortSignal,
  ) => Promise<WebFetchConnection>;
  localNetworks: () => readonly LocalNetwork[];
}

const webFetchEnvironment = <Conn extends WebFetchConnection>(
  network: WebFetchNetwork<Conn>,
  localNetworks: () => readonly LocalNetwork[],
): WebFetchEnvironment => ({
  resolveDns: network.resolveDns,
  openConnection: (url, address, port, signal) =>
    openPinnedConnection(url, address, port, network, signal),
  localNetworks,
});

const DEFAULT_MAX_BYTES = 200_000;
const MAX_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_TEXT_CHARS = 20_000;
const MAX_MAX_TEXT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const MAX_LINKS = 50;
const MAX_CHUNKED_LINE_BYTES = 4096;
const MAX_CHUNKED_TRAILER_BYTES = 16 * 1024;
const MAX_CHUNKED_TRAILER_LINES = 100;

const USER_AGENT = "cf-harness-web-fetch/1.0";

export const webFetchToolDescriptor: HarnessToolDescriptor = {
  toolId: "web_fetch",
  title: "Web Fetch",
  description:
    "Fetch an HTTP(S) URL on the open internet, with bounded output, redirect validation and extracted text. Refuses local, private, reserved and this device's own network addresses. Uses no cookies or browser state.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      maxBytes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_MAX_BYTES,
      },
      maxTextChars: {
        type: "integer",
        minimum: 1,
        maximum: MAX_MAX_TEXT_CHARS,
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
      },
    },
    required: ["url"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        type: { type: "string", const: "cf-harness.web-fetch-result" },
        outputId: { type: "string" },
        url: { type: "string" },
        finalUrl: { type: "string" },
        status: { type: "number" },
        ok: { type: "boolean" },
        contentType: { type: "string" },
        bytes: { type: "number" },
        rawContentDigest: { type: "string" },
        rawContentTruncated: { type: "boolean" },
        rawContent: { type: "string" },
        text: { type: "string" },
        textTruncated: { type: "boolean" },
        title: { type: "string" },
        links: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              href: { type: "string" },
            },
            required: ["text", "href"],
            additionalProperties: false,
          },
        },
        redirects: {
          type: "array",
          items: {
            type: "object",
            properties: {
              status: { type: "number" },
              url: { type: "string" },
              location: { type: "string" },
            },
            required: ["status", "url", "location"],
            additionalProperties: false,
          },
        },
        fetchedAt: { type: "string" },
      },
      required: [
        "type",
        "outputId",
        "url",
        "finalUrl",
        "status",
        "ok",
        "bytes",
        "rawContentDigest",
        "rawContentTruncated",
        "rawContent",
        "text",
        "textTruncated",
        "fetchedAt",
      ],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        type: { type: "string", const: "cf-harness.web-fetch-error" },
        outputId: { type: "string" },
        url: { type: "string" },
        code: {
          type: "string",
          enum: [
            "invalid_url",
            "blocked_url",
            "too_many_redirects",
            "unsupported_content_type",
            "fetch_failed",
            "timeout",
          ],
        },
        message: { type: "string" },
        finalUrl: { type: "string" },
        status: { type: "number" },
        contentType: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["type", "outputId", "url", "code", "message", "fetchedAt"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["web", "fetch", "read"],
};

export interface CreateWebFetchToolOptions<Conn extends WebFetchConnection> {
  /** By default, the networks Deno reports (`interfaceNetworks`). */
  localNetworks?: () => readonly LocalNetwork[];
  /** By default, {@link defaultWebFetchNetwork}. */
  network?: WebFetchNetwork<Conn>;
}

export const createWebFetchTool = <
  Conn extends WebFetchConnection = Deno.TcpConn,
>(
  options: CreateWebFetchToolOptions<Conn> = {},
): HarnessToolDefinition<WebFetchToolInput, WebFetchToolOutput> => {
  const localNetworks = options.localNetworks ?? interfaceNetworks;
  const environment = options.network === undefined
    ? webFetchEnvironment(defaultWebFetchNetwork, localNetworks)
    : webFetchEnvironment(options.network, localNetworks);
  return {
    descriptor: webFetchToolDescriptor,
    async invoke(context, input) {
      const outputId = context.nextOutputId("web_fetch");
      const fetchedAt = context.now();
      const maxBytes = boundedIntegerOrDefault(
        input.maxBytes,
        DEFAULT_MAX_BYTES,
        MAX_MAX_BYTES,
        "web_fetch maxBytes",
      );
      const maxTextChars = boundedIntegerOrDefault(
        input.maxTextChars,
        DEFAULT_MAX_TEXT_CHARS,
        MAX_MAX_TEXT_CHARS,
        "web_fetch maxTextChars",
      );
      const timeoutMs = boundedIntegerOrDefault(
        input.timeoutMs,
        DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
        "web_fetch timeoutMs",
      );
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(createWebFetchAbortError());
      }, timeoutMs);
      let resultUrl = input.url;
      try {
        const initialUrl = await validatePublicHttpUrl(
          input.url,
          environment,
          controller.signal,
        );
        if (!initialUrl.ok) {
          return webFetchError({
            outputId,
            url: input.url,
            code: initialUrl.code,
            message: initialUrl.message,
            fetchedAt,
          });
        }
        resultUrl = initialUrl.url;
        const fetchResult = await fetchWithRedirects({
          url: initialUrl.url,
          environment,
          signal: controller.signal,
        });

        if (!fetchResult.ok) {
          return webFetchError({
            outputId,
            url: initialUrl.url,
            code: fetchResult.code,
            message: fetchResult.message,
            finalUrl: fetchResult.finalUrl,
            fetchedAt,
          });
        }

        const response = fetchResult.response;
        const contentType = response.headers.get("content-type") ?? undefined;
        if (!isSupportedContentType(contentType)) {
          await response.body?.cancel();
          return webFetchError({
            outputId,
            url: initialUrl.url,
            code: "unsupported_content_type",
            message: contentType === undefined
              ? "web_fetch response did not include a supported text content-type"
              : `web_fetch content-type ${contentType} is not supported`,
            finalUrl: fetchResult.finalUrl,
            status: response.status,
            contentType,
            fetchedAt,
          });
        }

        const body = await readResponseBody(
          response,
          maxBytes,
          controller.signal,
        );
        const rawContent = new TextDecoder().decode(body.bytes);
        const extraction = extractText(
          rawContent,
          fetchResult.finalUrl,
          contentType,
        );
        const text = truncateString(extraction.text, maxTextChars);
        return {
          type: "cf-harness.web-fetch-result",
          outputId,
          url: initialUrl.url,
          finalUrl: fetchResult.finalUrl,
          status: response.status,
          ok: response.ok,
          ...(contentType !== undefined ? { contentType } : {}),
          bytes: body.bytes.byteLength,
          rawContentDigest: await digestBytes(body.bytes),
          rawContentTruncated: body.truncated,
          rawContent,
          text: text.value,
          textTruncated: text.truncated,
          ...(extraction.title !== undefined
            ? { title: extraction.title }
            : {}),
          ...(extraction.links.length > 0
            ? { links: extraction.links.slice(0, MAX_LINKS) }
            : {}),
          ...(fetchResult.redirects.length > 0
            ? { redirects: fetchResult.redirects }
            : {}),
          fetchedAt,
        };
      } catch (error) {
        return webFetchError({
          outputId,
          url: resultUrl,
          code: isAbortError(error) ? "timeout" : "fetch_failed",
          message: describeFailure(error),
          fetchedAt,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
};

export const isWebFetchToolSuccessOutput = (
  output: unknown,
): output is WebFetchToolSuccessOutput =>
  isObjectOrArray(output) &&
  "type" in output &&
  output.type === "cf-harness.web-fetch-result" &&
  "outputId" in output &&
  typeof output.outputId === "string";

export const isWebFetchToolErrorOutput = (
  output: unknown,
): output is WebFetchToolErrorOutput =>
  isObjectOrArray(output) &&
  "type" in output &&
  output.type === "cf-harness.web-fetch-error" &&
  "outputId" in output &&
  typeof output.outputId === "string";

export const toModelFacingWebFetchOutput = (
  output: WebFetchToolOutput,
): WebFetchModelFacingOutput => {
  if (!isWebFetchToolSuccessOutput(output)) {
    return output;
  }
  const { rawContent: _rawContent, ...modelFacing } = output;
  return modelFacing;
};

interface WebFetchErrorOptions {
  outputId: string;
  url: string;
  code: WebFetchErrorCode;
  message: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  fetchedAt: string;
}

const webFetchError = (
  options: WebFetchErrorOptions,
): WebFetchToolErrorOutput => ({
  type: "cf-harness.web-fetch-error",
  outputId: options.outputId,
  url: options.url,
  code: options.code,
  message: options.message,
  ...(options.finalUrl !== undefined ? { finalUrl: options.finalUrl } : {}),
  ...(options.status !== undefined ? { status: options.status } : {}),
  ...(options.contentType !== undefined
    ? { contentType: options.contentType }
    : {}),
  fetchedAt: options.fetchedAt,
});

const boundedIntegerOrDefault = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number => {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
};

type PublicHttpUrlResult =
  | { ok: true; url: string }
  | { ok: false; code: "invalid_url" | "blocked_url"; message: string };

class WebFetchBlockedUrlError extends Error {
  readonly code = "blocked_url" as const;
}

const validatePublicHttpUrl = async (
  input: string,
  environment: WebFetchEnvironment,
  signal: AbortSignal,
): Promise<PublicHttpUrlResult> => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return {
      ok: false,
      code: "invalid_url",
      message: `web_fetch url is not valid: ${input}`,
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      code: "invalid_url",
      message: `web_fetch protocol ${url.protocol} is not supported`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      code: "blocked_url",
      message: "web_fetch URLs may not include credentials",
    };
  }
  const hostBlockReason = blockedHostReason(url.hostname, environment);
  if (hostBlockReason !== undefined) {
    return {
      ok: false,
      code: "blocked_url",
      message: hostBlockReason,
    };
  }
  const resolution = await resolveValidatedPublicAddresses(
    url.hostname,
    environment,
    signal,
  );
  if (!resolution.ok) {
    return {
      ok: false,
      code: "blocked_url",
      message: resolution.message,
    };
  }
  return { ok: true, url: url.toString() };
};

const blockedHostReason = (
  hostname: string,
  environment: WebFetchEnvironment,
): string | undefined => {
  const normalized = normalizeHostname(hostname);
  if (
    normalized === "localhost" ||
    normalized === "host.docker.internal" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return `web_fetch host ${hostname} is local and is not allowed`;
  }
  const address = parseIpAddress(normalized);
  if (
    address !== undefined &&
    !isOpenInternetAddress(address, environment.localNetworks())
  ) {
    return `web_fetch host ${hostname} is not on the open internet and is not allowed`;
  }
  return undefined;
};

const resolveValidatedPublicAddresses = async (
  hostname: string,
  environment: WebFetchEnvironment,
  signal: AbortSignal,
): Promise<
  | { ok: true; addresses: readonly string[] }
  | { ok: false; message: string }
> => {
  let addresses: readonly string[];
  try {
    signal.throwIfAborted();
    addresses = await resolveHostAddresses(
      hostname,
      environment.resolveDns,
      signal,
    );
    signal.throwIfAborted();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      ok: false,
      message:
        `web_fetch host ${hostname} could not be resolved to a public address: ${
          describeFailure(error)
        }`,
    };
  }
  if (addresses.length === 0) {
    return {
      ok: false,
      message:
        `web_fetch host ${hostname} could not be resolved to a public address`,
    };
  }
  const networks = environment.localNetworks();
  for (const address of addresses) {
    const addressBlockReason = blockedResolvedAddressReason(
      hostname,
      address,
      networks,
    );
    if (addressBlockReason !== undefined) {
      return { ok: false, message: addressBlockReason };
    }
  }
  return { ok: true, addresses };
};

const resolveHostAddresses = async (
  hostname: string,
  resolveDns: WebFetchEnvironment["resolveDns"],
  signal: AbortSignal,
): Promise<readonly string[]> => {
  const normalized = normalizeHostname(hostname);
  if (parseIpAddress(normalized) !== undefined || normalized.includes(":")) {
    return [normalized];
  }
  const results = await withWebFetchAbort(
    Promise.allSettled([
      resolveDns(normalized, "A", { signal }),
      resolveDns(normalized, "AAAA", { signal }),
    ]),
    signal,
  );
  const addresses = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
  if (addresses.length === 0) {
    const firstError = results.find((
      result,
    ): result is PromiseRejectedResult => result.status === "rejected");
    if (firstError !== undefined) {
      throw firstError.reason;
    }
  }
  return addresses;
};

const blockedResolvedAddressReason = (
  hostname: string,
  address: string,
  networks: readonly LocalNetwork[],
): string | undefined => {
  const parsed = parseIpAddress(normalizeHostname(address));
  if (parsed === undefined) {
    return `web_fetch host ${hostname} resolved to ${address}, which is not an IP address`;
  }
  if (!isOpenInternetAddress(parsed, networks)) {
    return `web_fetch host ${hostname} resolved to ${address}, which is not on the open internet, and is not allowed`;
  }
  return undefined;
};

const fetchPinnedPublic = async (
  input: string,
  environment: WebFetchEnvironment,
  signal: AbortSignal,
): Promise<Response> => {
  const url = new URL(input);
  const resolution = await resolveValidatedPublicAddresses(
    url.hostname,
    environment,
    signal,
  );
  if (!resolution.ok) {
    throw new WebFetchBlockedUrlError(resolution.message);
  }
  const errors: string[] = [];
  for (const address of resolution.addresses) {
    try {
      return await fetchPinnedToAddress(url, address, environment, signal);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      errors.push(describeFailure(error));
    }
  }
  throw new Error(
    `web_fetch could not connect to public host ${url.hostname}: ${
      errors.join("; ")
    }`,
  );
};

/** The statuses whose response has no body, and cannot be given one. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

const fetchPinnedToAddress = async (
  url: URL,
  address: string,
  environment: WebFetchEnvironment,
  signal: AbortSignal,
): Promise<Response> => {
  const port = url.port === ""
    ? (url.protocol === "https:" ? 443 : 80)
    : Number(url.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`web_fetch URL port is not valid: ${url.port}`);
  }
  const conn = await environment.openConnection(url, address, port, signal);
  const abortHandler = () => closeConnection(conn);
  signal.addEventListener("abort", abortHandler, { once: true });
  try {
    await withWebFetchAbort(
      conn.writable.getWriter().write(
        new TextEncoder().encode(serializeHttpRequest(url)),
      ),
      signal,
    );
    const reader = conn.readable.getReader();
    const response = await readHttpResponseHead(reader, signal);
    if (NULL_BODY_STATUSES.has(response.status)) {
      closeConnection(conn);
      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    }
    return new Response(
      createHttpResponseBodyStream(
        conn,
        reader,
        response.bodyPrefix,
        response.headers,
        signal,
      ),
      {
        status: response.status,
        headers: response.headers,
      },
    );
  } catch (error) {
    closeConnection(conn);
    throw error;
  } finally {
    signal.removeEventListener("abort", abortHandler);
  }
};

const openPinnedConnection = async <Conn extends WebFetchConnection>(
  url: URL,
  address: string,
  port: number,
  network: WebFetchNetwork<Conn>,
  signal: AbortSignal,
): Promise<WebFetchConnection> => {
  const conn = await withWebFetchAbort(
    network.connect({ hostname: address, port, signal }),
    signal,
    closeConnection,
  );
  if (url.protocol === "http:") {
    return conn;
  }
  return await withWebFetchAbort(
    network.startTls(conn, { hostname: normalizeHostname(url.hostname) }),
    signal,
    closeConnection,
  );
};

const serializeHttpRequest = (url: URL): string => {
  const requestTarget = `${
    url.pathname === "" ? "/" : url.pathname
  }${url.search}`;
  const lines = [
    `GET ${requestTarget} HTTP/1.1`,
    `Host: ${url.host}`,
    "Connection: close",
    "Accept-Encoding: identity",
    "Accept: text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1",
    `User-Agent: ${USER_AGENT}`,
  ];
  return `${lines.join("\r\n")}\r\n\r\n`;
};

interface HttpResponseHead {
  status: number;
  headers: Headers;
  bodyPrefix: WebFetchBytes;
}

const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;

const readHttpResponseHead = async (
  reader: WebFetchReader,
  signal: AbortSignal,
): Promise<HttpResponseHead> => {
  let buffered: WebFetchBytes = new Uint8Array();
  // The bytes of interim heads already discarded, so that the size limit
  // covers every head the server sends before its final one.
  let discarded = 0;
  while (discarded + buffered.byteLength <= MAX_RESPONSE_HEADER_BYTES) {
    const headerEnd = findHeaderEnd(buffered);
    if (headerEnd !== -1) {
      const head = parseHttpResponseHead(buffered.slice(0, headerEnd));
      buffered = buffered.slice(headerEnd + 4);
      discarded += headerEnd + 4;
      if (head.status === 101) {
        // A 101 switches the connection to another protocol, which only a
        // request carrying `Upgrade` can ask for, and web_fetch never sends
        // one.
        throw new Error(
          "web_fetch received 101 Switching Protocols, which it did not ask for",
        );
      }
      if (head.status < 100 || head.status >= 200) {
        return { ...head, bodyPrefix: buffered };
      }
      // RFC 9110 §15.2: a client discards an interim (1xx) response and
      // reads the next head.
      continue;
    }
    const chunk = await readChunk(reader, signal);
    if (chunk === undefined) {
      break;
    }
    buffered = concatBytes(buffered, chunk);
  }
  throw new Error("web_fetch response headers were incomplete or too large");
};

const parseHttpResponseHead = (
  headerBytes: WebFetchBytes,
): Omit<HttpResponseHead, "bodyPrefix"> => {
  const headerText = new TextDecoder().decode(headerBytes);
  const lines = headerText.split("\r\n");
  const statusLine = lines.shift() ?? "";
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/.exec(
    statusLine,
  );
  if (statusMatch === null) {
    throw new Error(`web_fetch received an invalid HTTP status line`);
  }
  const status = Number(statusMatch[1]);
  const headers = new Headers();
  let lastHeaderName: string | undefined;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && lastHeaderName !== undefined) {
      headers.set(
        lastHeaderName,
        `${headers.get(lastHeaderName) ?? ""} ${line.trim()}`,
      );
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    headers.append(name, value);
    lastHeaderName = name;
  }
  return { status, headers };
};

const findHeaderEnd = (bytes: WebFetchBytes): number => {
  for (let index = 0; index <= bytes.byteLength - 4; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
};

const createHttpResponseBodyStream = (
  conn: WebFetchConnection,
  reader: WebFetchReader,
  bodyPrefix: WebFetchBytes,
  headers: Headers,
  signal: AbortSignal,
): ReadableStream<Uint8Array> => {
  let buffered = bodyPrefix;
  let contentLengthRemaining = parseContentLength(headers);
  let chunkBytesRemaining = 0;
  let closed = false;
  const isChunked = (headers.get("transfer-encoding") ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim())
    .includes("chunked");

  let abortHandler = () => {};
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    signal.removeEventListener("abort", abortHandler);
    closeConnection(conn);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      abortHandler = () => {
        close();
        controller.error(signal.reason);
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    },
    async pull(controller) {
      try {
        signal.throwIfAborted();
        if (isChunked) {
          await pullChunkedBodyChunk({
            reader,
            signal,
            controller,
            close,
            get buffered() {
              return buffered;
            },
            set buffered(value) {
              buffered = value;
            },
            get chunkBytesRemaining() {
              return chunkBytesRemaining;
            },
            set chunkBytesRemaining(value) {
              chunkBytesRemaining = value;
            },
          });
          return;
        }
        if (contentLengthRemaining !== undefined) {
          if (contentLengthRemaining <= 0) {
            close();
            controller.close();
            return;
          }
          if (buffered.byteLength === 0) {
            const chunk = await readChunk(reader, signal);
            if (chunk === undefined) {
              throw new Error(
                "web_fetch response ended before its Content-Length",
              );
            }
            buffered = chunk;
          }
          const bytesToSend = Math.min(
            buffered.byteLength,
            contentLengthRemaining,
          );
          controller.enqueue(buffered.slice(0, bytesToSend));
          buffered = buffered.slice(bytesToSend);
          contentLengthRemaining -= bytesToSend;
          return;
        }
        if (buffered.byteLength > 0) {
          controller.enqueue(buffered);
          buffered = new Uint8Array();
          return;
        }
        const chunk = await readChunk(reader, signal);
        if (chunk === undefined) {
          close();
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel() {
      close();
    },
  }, {
    // Read only when web_fetch asks, so a body it discards is never read
    // and cannot fail before it is canceled.
    highWaterMark: 0,
  });
};

interface ChunkedBodyState {
  reader: WebFetchReader;
  signal: AbortSignal;
  controller: ReadableStreamDefaultController<Uint8Array>;
  close: () => void;
  buffered: WebFetchBytes;
  chunkBytesRemaining: number;
}

const pullChunkedBodyChunk = async (
  state: ChunkedBodyState,
): Promise<void> => {
  while (true) {
    if (state.chunkBytesRemaining > 0) {
      await fillBodyBuffer(state, 1);
      const bytesToSend = Math.min(
        state.buffered.byteLength,
        state.chunkBytesRemaining,
      );
      const chunk = state.buffered.slice(0, bytesToSend);
      state.buffered = state.buffered.slice(bytesToSend);
      state.chunkBytesRemaining -= bytesToSend;
      if (state.chunkBytesRemaining === 0) {
        await fillBodyBuffer(state, 2);
        if (state.buffered[0] !== 13 || state.buffered[1] !== 10) {
          throw new Error("web_fetch received an invalid chunked response");
        }
        state.buffered = state.buffered.slice(2);
      }
      state.controller.enqueue(chunk);
      return;
    }
    const line = await readChunkedLine(state);
    const chunkSizeText = line.split(";", 1)[0]!.trim();
    if (!/^[0-9a-f]+$/i.test(chunkSizeText)) {
      throw new Error("web_fetch received an invalid chunked response");
    }
    const chunkSize = Number.parseInt(chunkSizeText, 16);
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 0) {
      throw new Error("web_fetch received an invalid chunked response");
    }
    if (chunkSize === 0) {
      await discardChunkedTrailers(state);
      state.close();
      state.controller.close();
      return;
    }
    state.chunkBytesRemaining = chunkSize;
  }
};

const readChunkedLine = async (state: ChunkedBodyState): Promise<string> => {
  while (true) {
    const lineEnd = findCrlf(state.buffered);
    if (lineEnd !== -1) {
      if (lineEnd > MAX_CHUNKED_LINE_BYTES) {
        throw new Error("web_fetch chunked line exceeded size limit");
      }
      const line = new TextDecoder().decode(state.buffered.slice(0, lineEnd));
      state.buffered = state.buffered.slice(lineEnd + 2);
      return line;
    }
    if (state.buffered.byteLength > MAX_CHUNKED_LINE_BYTES + 1) {
      throw new Error("web_fetch chunked line exceeded size limit");
    }
    await fillBodyBuffer(state, state.buffered.byteLength + 1);
  }
};

const discardChunkedTrailers = async (
  state: ChunkedBodyState,
): Promise<void> => {
  let trailerBytes = 0;
  let trailerLines = 0;
  while (true) {
    const line = await readChunkedLine(state);
    trailerBytes += new TextEncoder().encode(line).byteLength + 2;
    if (trailerBytes > MAX_CHUNKED_TRAILER_BYTES) {
      throw new Error("web_fetch chunked trailers exceeded size limit");
    }
    if (line === "") {
      return;
    }
    trailerLines += 1;
    if (trailerLines > MAX_CHUNKED_TRAILER_LINES) {
      throw new Error("web_fetch chunked trailers exceeded line limit");
    }
  }
};

const fillBodyBuffer = async (
  state: ChunkedBodyState,
  minBytes: number,
): Promise<void> => {
  while (state.buffered.byteLength < minBytes) {
    const chunk = await readChunk(state.reader, state.signal);
    if (chunk === undefined) {
      throw new Error("web_fetch response ended unexpectedly");
    }
    state.buffered = concatBytes(state.buffered, chunk);
  }
};

const findCrlf = (bytes: WebFetchBytes): number => {
  for (let index = 0; index <= bytes.byteLength - 2; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) {
      return index;
    }
  }
  return -1;
};

const parseContentLength = (headers: Headers): number | undefined => {
  const value = headers.get("content-length");
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const readChunk = async (
  reader: WebFetchReader,
  signal: AbortSignal,
): Promise<WebFetchBytes | undefined> => {
  const { done, value } = await withWebFetchAbort(reader.read(), signal);
  return done ? undefined : value;
};

const concatBytes = (
  left: WebFetchBytes,
  right: WebFetchBytes,
): WebFetchBytes => {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
};

const closeConnection = (conn: WebFetchConnection): void => {
  try {
    conn.close();
  } catch {
    // The connection may already be closed by the peer or by abort cleanup.
  }
};

interface FetchWithRedirectsOptions {
  url: string;
  environment: WebFetchEnvironment;
  signal: AbortSignal;
}

type FetchWithRedirectsResult =
  | {
    ok: true;
    response: Response;
    finalUrl: string;
    redirects: WebFetchRedirect[];
  }
  | {
    ok: false;
    code: "blocked_url" | "too_many_redirects";
    message: string;
    finalUrl?: string;
  };

const fetchWithRedirects = async (
  options: FetchWithRedirectsOptions,
): Promise<FetchWithRedirectsResult> => {
  let currentUrl = options.url;
  const redirects: WebFetchRedirect[] = [];
  for (let redirectCount = 0;; redirectCount += 1) {
    options.signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetchPinnedPublic(
        currentUrl,
        options.environment,
        options.signal,
      );
    } catch (error) {
      if (error instanceof WebFetchBlockedUrlError) {
        return {
          ok: false,
          code: error.code,
          message: error.message,
          finalUrl: currentUrl,
        };
      }
      throw error;
    }
    const location = response.headers.get("location");
    if (
      response.status < 300 ||
      response.status >= 400 ||
      location === null
    ) {
      return {
        ok: true,
        response,
        finalUrl: currentUrl,
        redirects,
      };
    }
    if (redirectCount === MAX_REDIRECTS) {
      await response.body?.cancel();
      return {
        ok: false,
        code: "too_many_redirects",
        message: `web_fetch exceeded ${MAX_REDIRECTS} redirects`,
        finalUrl: currentUrl,
      };
    }
    await response.body?.cancel();
    const nextUrl = new URL(location, currentUrl).toString();
    const validation = await validatePublicHttpUrl(
      nextUrl,
      options.environment,
      options.signal,
    );
    if (!validation.ok) {
      return {
        ok: false,
        code: validation.code === "invalid_url"
          ? "blocked_url"
          : validation.code,
        message: `web_fetch redirect target denied: ${validation.message}`,
        finalUrl: currentUrl,
      };
    }
    redirects.push({
      status: response.status,
      url: currentUrl,
      location: validation.url,
    });
    currentUrl = validation.url;
  }
};

const createWebFetchAbortError = (): DOMException =>
  new DOMException("web_fetch timed out", "AbortError");

/**
 * What `promise` settles to, unless `signal` aborts first, in which case its
 * reason. A value `promise` settles to after the abort reaches no caller, so
 * it goes to `discard`, which releases whatever it holds.
 */
const withWebFetchAbort = <T>(
  promise: Promise<T>,
  signal: AbortSignal,
  discard?: (value: T) => void,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    // Handled before the abort check, so that the promise rejecting after an
    // abort, even one that came before this call, is not left unhandled.
    promise.then((value) => {
      if (signal.aborted) {
        discard?.(value);
      } else {
        resolve(value);
      }
    }, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

const cancelReaderAfterAbort = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<void> => {
  if (!signal.aborted) {
    return;
  }
  try {
    await reader.cancel(signal.reason);
  } catch {
    // Ignore cancellation cleanup failures; the timeout itself is the result.
  }
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const isSupportedContentType = (contentType: string | undefined): boolean => {
  if (contentType === undefined) {
    return false;
  }
  const normalized = contentType.split(";")[0]!.trim().toLowerCase();
  return normalized === "text/html" ||
    normalized === "application/xhtml+xml" ||
    normalized === "text/plain" ||
    normalized === "application/json" ||
    normalized.endsWith("+json");
};

export const webFetchTool = createWebFetchTool();

interface ReadBodyResult {
  bytes: Uint8Array<ArrayBuffer>;
  truncated: boolean;
}

const readResponseBody = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ReadBodyResult> => {
  if (response.body === null) {
    return { bytes: new Uint8Array(), truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await withWebFetchAbort(reader.read(), signal);
      if (done) {
        break;
      }
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining));
          total += remaining;
        }
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await cancelReaderAfterAbort(reader, signal);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
};

interface ExtractedText {
  text: string;
  title?: string;
  links: WebFetchLink[];
}

const extractText = (
  rawContent: string,
  finalUrl: string,
  contentType: string | undefined,
): ExtractedText => {
  const normalizedContentType = contentType?.split(";")[0]?.trim()
    .toLowerCase();
  const looksHtml = normalizedContentType === "text/html" ||
    normalizedContentType === "application/xhtml+xml" ||
    (contentType === undefined && /<\/?[a-z][\s\S]*>/i.test(rawContent));
  if (!looksHtml) {
    return { text: rawContent, links: [] };
  }
  const title = extractTitle(rawContent);
  const links = extractLinks(rawContent, finalUrl);
  return {
    text: htmlToText(rawContent),
    ...(title !== undefined ? { title } : {}),
    links,
  };
};

const extractTitle = (html: string): string | undefined => {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) {
    return undefined;
  }
  const title = normalizeWhitespace(decodeHtmlEntities(stripTags(match[1]!)));
  return title === "" ? undefined : title;
};

const extractLinks = (html: string, finalUrl: string): WebFetchLink[] => {
  const links: WebFetchLink[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null && links.length < MAX_LINKS) {
    const attrs = match[1] ?? "";
    const href = extractHref(attrs);
    if (href === undefined) {
      continue;
    }
    let resolved: URL;
    try {
      resolved = new URL(decodeHtmlEntities(href), finalUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      continue;
    }
    const text = normalizeWhitespace(
      decodeHtmlEntities(stripTags(match[2] ?? "")),
    );
    links.push({
      text,
      href: resolved.toString(),
    });
  }
  return links;
};

const extractHref = (attrs: string): string | undefined => {
  const quoted = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(attrs);
  if (quoted !== null) {
    return quoted[2];
  }
  const unquoted = /\bhref\s*=\s*([^\s"'=<>`]+)/i.exec(attrs);
  return unquoted?.[1];
};

const htmlToText = (html: string): string => {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");
  const withBreaks = withoutNoise
    .replace(
      /<\/(p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|tr|table|blockquote)>/gi,
      "\n",
    )
    .replace(/<br\s*\/?>/gi, "\n");
  return decodeHtmlEntities(stripTags(withBreaks))
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0)
    .join("\n");
};

const stripTags = (input: string): string => input.replace(/<[^>]*>/g, " ");

const normalizeWhitespace = (input: string): string =>
  input.replace(/\s+/g, " ").trim();

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

const decodeHtmlEntities = (input: string): string =>
  input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, body) => {
    const normalized = String(body).toLowerCase();
    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint)
        ? safeCodePoint(codePoint, entity)
        : entity;
    }
    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint)
        ? safeCodePoint(codePoint, entity)
        : entity;
    }
    return HTML_ENTITY_MAP[normalized] ?? entity;
  });

const safeCodePoint = (codePoint: number, fallback: string): string => {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
};

const truncateString = (
  value: string,
  maxChars: number,
): { value: string; truncated: boolean } =>
  value.length > maxChars
    ? { value: value.slice(0, maxChars), truncated: true }
    : { value, truncated: false };

const digestBytes = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
};
