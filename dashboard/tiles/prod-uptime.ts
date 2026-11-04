/**
 * Checks that production is up, with synthetic round trips to the commonfabric.com
 * site and the estuary and rapids servers, plus a name or reachability check for
 * the company hosts they depend on or run beside. Each server health request
 * goes to /_health on the configured origin. Successful server-check times stay
 * visible in the healthy and warning states. The public site appears only when
 * it is not good. A red state shows only the hosts that are not good, and a
 * host that answers stays out of the body.
 *
 * The commonfabric.com request runs first until it receives an HTTP response. The
 * tile does not check the other hosts before that independent signal confirms
 * the dashboard's own connectivity.
 *
 * Both servers are on the tailnet. PROD_PROXY routes the health requests
 * through a proxy when the dashboard cannot reach the tailnet directly.
 * Tailnet names live in Tailscale's MagicDNS, which the resolver of a
 * dashboard behind such a proxy does not see, so tailnet hosts are checked
 * through the proxy instead: a host with a health endpoint by its /_health
 * request, and a host without one by a SOCKS5 connect that leaves the name for
 * the proxy to resolve. Every other host is checked with an A and AAAA lookup
 * from the dashboard itself.
 */

import { STATUS_RANK, worstStatus } from "../lib.ts";
import { type DetailRow, detailList } from "../detail-list.ts";
import type { Status, Tile, TileView } from "../types.ts";

const HEALTH_PATH = "/_health";
const WARN_LATENCY_MS = 500;
const BAD_LATENCY_MS = 1000;
const SITE_WARN_LATENCY_MS = 2500;
const SITE_FAIL_THRESHOLD = 3;
const TAILNET_SUFFIX = ".ts.net";
// A connect that reaches a host opens and closes a session the host records in
// its own logs, so a host that answers is left alone for this long and counts as
// reachable in between. A connect that reaches nothing leaves nothing behind, so
// a host that does not answer is asked again on the next refresh.
const PROBE_INTERVAL_MS = 3_600_000;
const SOCKS5_VERSION = 5;
const SOCKS5_NO_AUTHENTICATION = 0;
const SOCKS5_CONNECT = 1;
const SOCKS5_DOMAIN_NAME = 3;
const SOCKS5_SUCCEEDED = 0;
const SOCKS5_DEFAULT_PORT = 1080;

type CreateHttpClient = typeof Deno.createHttpClient;
type HttpClientOptions = Parameters<CreateHttpClient>[0];
type ProxyFetchInit = RequestInit & { client?: Deno.HttpClient };
type ResolveDns = (
  query: string,
  recordType: "A" | "AAAA",
) => Promise<readonly string[]>;
type ElapsedMs = (targetName: string, startedAt: number) => number;

/** The part of a TCP connection the SOCKS5 exchange below uses. */
export interface ProxyStream {
  read(buffer: Uint8Array): Promise<number | null>;
  write(buffer: Uint8Array): Promise<number>;
  close(): void;
}

type OpenProxyStream = (
  options: Deno.ConnectOptions,
) => Promise<ProxyStream>;

interface Target {
  name: string;
  href?: string;
  hostname: string;
  port: number;
  http: {
    kind: "health" | "site";
    url: string;
  } | null;
}

interface Check {
  status: Status;
  detail: string;
  // Set when the check found no host at the other end at all, as opposed to
  // finding one that answered badly or slowly. The headline names these.
  down?: true;
  headline?: {
    text: string;
    priority: number;
    magnitude: number;
  };
}

interface TargetResult {
  target: Target;
  http: Check;
  reach: Check;
  status: Status;
}

let createHttpClient: CreateHttpClient = Deno.createHttpClient;
let resolveDns: ResolveDns = (query, recordType) =>
  Deno.resolveDns(query, recordType);
let openProxyStream: OpenProxyStream = Deno.connect;
let elapsedMs: ElapsedMs = (_targetName, startedAt) => Date.now() - startedAt;
const reachedAt = new Map<string, number>();
let connectivityConfirmed = false;
let siteFailures = 0;

/** Sets the production connectivity state for a test and returns its restorer. */
export function setProdUptimeConnectivityForTest(
  value: boolean,
): () => void {
  const previousConfirmed = connectivityConfirmed;
  const previousFailures = siteFailures;
  connectivityConfirmed = value;
  siteFailures = 0;
  return () => {
    connectivityConfirmed = previousConfirmed;
    siteFailures = previousFailures;
  };
}

export function setProdUptimeHttpClientFactoryForTest(
  factory: CreateHttpClient,
): () => void {
  const previous = createHttpClient;
  createHttpClient = factory;
  return () => {
    createHttpClient = previous;
  };
}

export function setProdUptimeDnsResolverForTest(
  resolver: ResolveDns,
): () => void {
  const previous = resolveDns;
  resolveDns = resolver;
  return () => {
    resolveDns = previous;
  };
}

export function setProdUptimeElapsedMsForTest(
  measure: ElapsedMs,
): () => void {
  const previous = elapsedMs;
  elapsedMs = measure;
  return () => {
    elapsedMs = previous;
  };
}

export function setProdUptimeProxyStreamOpenerForTest(
  opener: OpenProxyStream,
): () => void {
  const previous = openProxyStream;
  openProxyStream = opener;
  reachedAt.clear();
  return () => {
    openProxyStream = previous;
    reachedAt.clear();
  };
}

function proxyUrl(proxy: string): URL {
  let url: URL;
  try {
    url = new URL(proxy);
  } catch (cause) {
    throw new TypeError(`invalid PROD_PROXY URL: ${proxy}`, { cause });
  }

  if (url.username !== "" || url.password !== "") {
    throw new TypeError("PROD_PROXY URL must not contain credentials");
  }
  if (!isSocks5(url) && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`unsupported PROD_PROXY URL scheme: ${url.protocol}`);
  }
  return url;
}

function optionsForProxy(url: URL, proxy: string): HttpClientOptions {
  return isSocks5(url)
    ? { proxy: { transport: "socks5", url: proxy } }
    : { proxy: { url: proxy } };
}

function isSocks5(url: URL): boolean {
  return url.protocol === "socks5:" || url.protocol === "socks5h:";
}

function isTailnetName(hostname: string): boolean {
  return hostname.endsWith(TAILNET_SUFFIX);
}

function portOf(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "http:" ? 80 : 443;
}

function healthTarget(name: string, value: string): Target {
  const url = new URL(value);
  return {
    name,
    href: url.origin,
    hostname: url.hostname,
    port: portOf(url),
    http: { kind: "health", url: `${url.origin}${HEALTH_PATH}` },
  };
}

function siteTarget(name: string, value: string): Target {
  const url = new URL(value);
  return {
    name,
    href: url.href,
    hostname: url.hostname,
    port: portOf(url),
    http: { kind: "site", url: url.href },
  };
}

function hostTarget(
  name: string,
  value: string,
  port: number,
  href?: string,
): Target {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  return {
    name,
    hostname: url.hostname,
    port: url.port === "" ? port : Number(url.port),
    href,
    http: null,
  };
}

// A host nothing answered for is the plainest thing the tile can say, so it
// takes the headline over any host that answered.
function downHeadline(results: readonly TargetResult[]): string | undefined {
  const down = results.filter(
    (result) => result.http.down === true || result.reach.down === true,
  );
  if (down.length === 0) return undefined;
  return down.length === 1
    ? `${down[0].target.name} down`
    : `${down.length} hosts down`;
}

function worstHeadline(results: readonly TargetResult[]): string | undefined {
  const candidates = results.flatMap((result) => [result.http, result.reach])
    .filter((check) => check.headline !== undefined);
  candidates.sort((a, b) =>
    STATUS_RANK[b.status] - STATUS_RANK[a.status] ||
    (b.headline?.priority ?? 0) - (a.headline?.priority ?? 0) ||
    (b.headline?.magnitude ?? 0) - (a.headline?.magnitude ?? 0)
  );
  return candidates[0]?.headline?.text;
}

async function writeAll(
  stream: ProxyStream,
  bytes: Uint8Array,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await stream.write(bytes.subarray(written));
  }
}

async function readExactly(
  stream: ProxyStream,
  count: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(count);
  let filled = 0;
  while (filled < count) {
    const read = await stream.read(bytes.subarray(filled));
    if (read === null) throw new Error("the proxy closed the connection");
    filled += read;
  }
  return bytes;
}

// Ask a SOCKS5 proxy to open a connection to a host by name, which leaves both
// the lookup and the dial to the proxy. Tailscale answers with one failure code
// for a name it cannot resolve and for a host it cannot reach, so this reports
// the pair of them together.
async function reachesThroughSocks5(
  proxy: URL,
  hostname: string,
  port: number,
): Promise<boolean> {
  const name = new TextEncoder().encode(hostname);
  if (name.length > 255) return false;
  const stream = await openProxyStream({
    hostname: proxy.hostname,
    port: proxy.port === "" ? SOCKS5_DEFAULT_PORT : Number(proxy.port),
  });
  try {
    await writeAll(
      stream,
      new Uint8Array([SOCKS5_VERSION, 1, SOCKS5_NO_AUTHENTICATION]),
    );
    const greeting = await readExactly(stream, 2);
    if (
      greeting[0] !== SOCKS5_VERSION ||
      greeting[1] !== SOCKS5_NO_AUTHENTICATION
    ) {
      return false;
    }

    const request = new Uint8Array(7 + name.length);
    request.set([
      SOCKS5_VERSION,
      SOCKS5_CONNECT,
      0,
      SOCKS5_DOMAIN_NAME,
      name.length,
    ]);
    request.set(name, 5);
    request[5 + name.length] = port >> 8;
    request[6 + name.length] = port & 0xff;
    await writeAll(stream, request);

    const reply = await readExactly(stream, 2);
    return reply[0] === SOCKS5_VERSION && reply[1] === SOCKS5_SUCCEEDED;
  } finally {
    stream.close();
  }
}

async function checkReach(
  target: Target,
  proxy: URL | undefined,
): Promise<Check> {
  if (proxy === undefined || !isTailnetName(target.hostname)) {
    return checkDns(target.hostname);
  }
  // The health request travels the same proxy and covers the same ground.
  if (target.http !== null) return { status: "good", detail: "" };
  if (!isSocks5(proxy)) {
    return {
      status: "unknown",
      detail: "no proxy route",
      headline: { text: "no proxy route", priority: 3, magnitude: 0 },
    };
  }

  const key =
    `${proxy.protocol}//${proxy.host}|${target.hostname}:${target.port}`;
  const now = Date.now();
  const previous = reachedAt.get(key);
  if (previous !== undefined && now - previous < PROBE_INTERVAL_MS) {
    return { status: "good", detail: "" };
  }

  let reached = false;
  try {
    reached = await reachesThroughSocks5(proxy, target.hostname, target.port);
  } catch {
    // An exchange that breaks down reads the same as a connection refused.
  }
  if (!reached) {
    reachedAt.delete(key);
    return { status: "bad", detail: "unreachable", down: true };
  }
  reachedAt.set(key, now);
  return { status: "good", detail: "" };
}

async function checkDns(hostname: string): Promise<Check> {
  const answers = await Promise.allSettled([
    resolveDns(hostname, "A"),
    resolveDns(hostname, "AAAA"),
  ]);
  const resolves = answers.some((answer) =>
    answer.status === "fulfilled" && answer.value.length > 0
  );
  if (resolves) return { status: "good", detail: "" };
  const missing = answers.every((answer) =>
    answer.status === "fulfilled"
      ? answer.value.length === 0
      : answer.reason instanceof Deno.errors.NotFound
  );
  if (missing) return { status: "bad", detail: "DNS down", down: true };
  return {
    status: "warn",
    detail: "DNS unknown",
    headline: { text: "DNS unknown", priority: 3, magnitude: 0 },
  };
}

async function checkHttp(
  target: Target,
  client: Deno.HttpClient | undefined,
  invalidProxy: boolean,
): Promise<Check> {
  if (target.http === null) {
    return { status: "good", detail: "" };
  }
  if (target.http.kind === "health" && invalidProxy) {
    return {
      status: "warn",
      detail: "invalid proxy",
      headline: { text: "invalid proxy", priority: 2, magnitude: 0 },
    };
  }

  try {
    const t0 = Date.now();
    const init: ProxyFetchInit = {
      signal: AbortSignal.timeout(8000),
      redirect: "manual",
    };
    if (target.http.kind === "health" && client !== undefined) {
      init.client = client;
    }
    const res = await fetch(target.http.url, init);
    if (target.http.kind === "site") {
      connectivityConfirmed = true;
      siteFailures = 0;
    }
    const ms = elapsedMs(target.name, t0);
    try {
      await res.body?.cancel();
    } catch {
      // A received status establishes reachability when body cleanup fails.
    }
    const status: Status = target.http.kind === "site"
      ? res.status >= 500
        ? "bad"
        : res.status >= 400 || ms > SITE_WARN_LATENCY_MS
        ? "warn"
        : "good"
      : res.status !== 200 || ms > BAD_LATENCY_MS
      ? "bad"
      : ms > WARN_LATENCY_MS
      ? "warn"
      : "good";
    return {
      status,
      detail: target.http.kind === "site" || res.status !== 200
        ? `HTTP ${res.status} · ${ms} ms`
        : `${ms} ms`,
      headline: target.http.kind === "site" && res.status >= 400
        ? { text: `HTTP ${res.status}`, priority: 2, magnitude: res.status }
        : target.http.kind === "health" && res.status !== 200
        ? { text: `HTTP ${res.status}`, priority: 2, magnitude: res.status }
        : ms >
            (target.http.kind === "site"
              ? SITE_WARN_LATENCY_MS
              : WARN_LATENCY_MS)
        ? { text: `${ms} ms`, priority: 1, magnitude: ms }
        : undefined,
    };
  } catch {
    if (target.http.kind === "site") {
      siteFailures++;
      if (siteFailures < SITE_FAIL_THRESHOLD) {
        return { status: "unknown", detail: "unreachable" };
      }
    }
    return { status: "bad", detail: "unreachable", down: true };
  }
}

async function checkTarget(
  target: Target,
  client: Deno.HttpClient | undefined,
  invalidProxy: boolean,
  proxy: URL | undefined,
): Promise<TargetResult> {
  const [http, reach] = await Promise.all([
    checkHttp(target, client, invalidProxy),
    checkReach(target, proxy),
  ]);
  return {
    target,
    http,
    reach,
    status: worstStatus([http.status, reach.status]),
  };
}

function resultRow(result: TargetResult): DetailRow {
  return {
    status: result.status,
    name: result.target.name,
    detail: [result.http.detail, result.reach.detail].filter(Boolean)
      .join(" · "),
    href: result.target.href,
  };
}

function view(results: readonly TargetResult[]): TileView {
  const status = worstStatus(results.map((result) => result.status));
  const headline = downHeadline(results) ?? worstHeadline(results);
  const visible = results.filter(
    (result) =>
      result.status !== "good" ||
      (status !== "bad" && result.target.http?.kind === "health"),
  );
  const value = headline ??
    `${
      results.filter((result) => result.status === "good").length
    }/${results.length} hosts up`;
  return {
    status,
    value,
    valueLabel: value,
    extra: detailList(visible.map(resultRow), {
      subject: "Production target details",
      focusKey: "targets",
    }),
  };
}

export const prodUptime: Tile = {
  label: "production",
  intervalMs: 30_000,
  async collect(ctx): Promise<TileView> {
    const commonTools = siteTarget(
      "commonfabric.com",
      ctx.env("COMMON_FABRIC_URL") ?? "https://commonfabric.com/",
    );
    let commonToolsResult: TargetResult | undefined;
    if (!connectivityConfirmed) {
      commonToolsResult = await checkTarget(
        commonTools,
        undefined,
        false,
        undefined,
      );
      if (!connectivityConfirmed) {
        return commonToolsResult.status === "bad"
          ? view([commonToolsResult])
          : {
            status: "unknown",
            value: "—",
            sub: "waiting for connectivity",
          };
      }
    }
    const targets = [
      healthTarget(
        "estuary",
        ctx.env("ESTUARY_URL") ?? ctx.env("PROD_URL") ??
          "https://estuary.saga-castor.ts.net",
      ),
      healthTarget(
        "rapids",
        ctx.env("RAPIDS_URL") ?? "https://rapids.saga-castor.ts.net",
      ),
      hostTarget(
        "bastion",
        ctx.env("BASTION_HOST") ?? "bastion.saga-castor.ts.net",
        22,
      ),
      hostTarget(
        "prod shell",
        "production.commontools.dev",
        443,
        "https://production.commontools.dev",
      ),
      hostTarget(
        "stage shell",
        "staging.commontools.dev",
        443,
        "https://staging.commontools.dev",
      ),
      hostTarget(
        "LLM",
        "llm.stage.commontools.dev",
        443,
        "https://llm.stage.commontools.dev",
      ),
      hostTarget(
        "sandbox",
        "sandbox.stage.commontools.dev",
        443,
        "https://sandbox.stage.commontools.dev",
      ),
    ];
    const proxy = ctx.env("PROD_PROXY");
    let parsedProxy: URL | undefined;
    let client: Deno.HttpClient | undefined;
    let invalidProxy = false;
    try {
      if (proxy !== undefined) {
        parsedProxy = proxyUrl(proxy);
        client = createHttpClient(optionsForProxy(parsedProxy, proxy));
      }
    } catch {
      parsedProxy = undefined;
      invalidProxy = true;
    }

    try {
      const results = await Promise.all([
        commonToolsResult ??
          checkTarget(commonTools, undefined, false, undefined),
        ...targets.map((target) =>
          checkTarget(target, client, invalidProxy, parsedProxy)
        ),
      ]);
      return view(results);
    } finally {
      client?.close();
    }
  },
};
