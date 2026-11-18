import {
  defaultWebFetchNetwork,
  type WebFetchNetwork,
} from "../../src/tools/web-fetch.ts";

//
// Public test data: an Ed25519 certificate authority and two certificates it
// issued for one key, each valid for a century. A client trusts them only by
// naming TEST_TLS_AUTHORITY as an authority, so certificate checks stay on.
// They are made together, with OpenSSL 3 or later, by:
//
//   openssl genpkey -algorithm ed25519 -out ca.key
//   openssl req -x509 -key ca.key -days 36500 \
//     -subj "/CN=web_fetch test authority" \
//     -addext "basicConstraints=critical,CA:TRUE" \
//     -addext "keyUsage=critical,keyCertSign" -out ca.pem
//   openssl genpkey -algorithm ed25519 -out server.key
//   echo basicConstraints=critical,CA:FALSE > common-name-only.cnf
//   echo extendedKeyUsage=serverAuth >> common-name-only.cnf
//   cp common-name-only.cnf server.cnf
//   echo subjectAltName=DNS:public.example,DNS:host.example,DNS:slow.example,IP:81.2.70.160,IP:2a02:8071:1234:5601::99 >> server.cnf
//   for name in server common-name-only; do
//     openssl req -new -key server.key -subj /CN=public.example |
//       openssl x509 -req -CA ca.pem -CAkey ca.key -days 36500 \
//         -extfile $name.cnf -out $name.pem
//   done
//
// TEST_TLS_AUTHORITY is ca.pem, TEST_TLS_KEY is server.key, and the
// certificates of TEST_TLS_SERVER and TEST_TLS_COMMON_NAME_ONLY are
// server.pem and common-name-only.pem. ca.key is not kept.
//

/** The authority every certificate here chains to. */
export const TEST_TLS_AUTHORITY = `-----BEGIN CERTIFICATE-----
MIIBSzCB/qADAgECAhQMRiBSSs8OZ7DDk0mrZBzsWmnjwzAFBgMrZXAwIzEhMB8G
A1UEAwwYd2ViX2ZldGNoIHRlc3QgYXV0aG9yaXR5MCAXDTI2MTExMzA3MDUwNloY
DzIxMjYxMDIwMDcwNTA2WjAjMSEwHwYDVQQDDBh3ZWJfZmV0Y2ggdGVzdCBhdXRo
b3JpdHkwKjAFBgMrZXADIQB9b9/5u4vLndgMO4krD31XDSzz1GYkon5tOUA9P8yf
u6NCMEAwHQYDVR0OBBYEFCYnLuKlxt0tuLj2jbUHPGb9WalJMA8GA1UdEwEB/wQF
MAMBAf8wDgYDVR0PAQH/BAQDAgIEMAUGAytlcANBABUM8gmZCHJGG0pnit1eCHrJ
nCiR3jIOUOtriJVXkn7Ex9KHI8sX9eTaB8NeTe0A6eGucNYgqvUSnR4x1t6avgU=
-----END CERTIFICATE-----
`;

/** A certificate and the key that proves a server holds it. */
export interface TlsIdentity {
  cert: string;
  key: string;
}

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIODVnH1GSj5554aB6Z1GXP2IjjSVgqyDUl2jv0m0wGM4
-----END PRIVATE KEY-----
`;

/**
 * A certificate whose subject alternative names are the hosts tests fetch
 * over HTTPS: `public.example`, `host.example`, `slow.example`, `81.2.70.160`
 * and `2a02:8071:1234:5601::99`.
 */
export const TEST_TLS_SERVER: TlsIdentity = {
  cert: `-----BEGIN CERTIFICATE-----
MIIBdDCCASagAwIBAgIUO7Pb5TbpdeVjDny28jLhy9+cDfAwBQYDK2VwMCMxITAf
BgNVBAMMGHdlYl9mZXRjaCB0ZXN0IGF1dGhvcml0eTAgFw0yNjExMTMwNzA1MDZa
GA8yMTI2MTAyMDA3MDUwNlowGTEXMBUGA1UEAwwOcHVibGljLmV4YW1wbGUwKjAF
BgMrZXADIQCaBTJbpERGA6WoM8wW39Hrw59JU0/20+LmBSL1wDwT0aN0MHIwDAYD
VR0TAQH/BAIwADATBgNVHSUEDDAKBggrBgEFBQcDATBNBgNVHREERjBEgg5wdWJs
aWMuZXhhbXBsZYIMaG9zdC5leGFtcGxlggxzbG93LmV4YW1wbGWHBFECRqCHECoC
gHESNFYBAAAAAAAAAJkwBQYDK2VwA0EA/6dpst5EZbH/Ms9ybLnGW5yd4Zw5lvR0
p0OGBf+BeFE0MMLHslkWmgeKsajR80+HfSojJDfPbMqVArR/a3EGCA==
-----END CERTIFICATE-----
`,
  key: TEST_TLS_KEY,
};

/**
 * A certificate with no subject alternative names, naming `public.example`
 * only as its subject's common name.
 */
export const TEST_TLS_COMMON_NAME_ONLY: TlsIdentity = {
  cert: `-----BEGIN CERTIFICATE-----
MIIBJDCB16ADAgECAhRK0SYC4+P6hrttPYsDj1PI5EGhdDAFBgMrZXAwIzEhMB8G
A1UEAwwYd2ViX2ZldGNoIHRlc3QgYXV0aG9yaXR5MCAXDTI2MTExMzA3MDUwNloY
DzIxMjYxMDIwMDcwNTA2WjAZMRcwFQYDVQQDDA5wdWJsaWMuZXhhbXBsZTAqMAUG
AytlcAMhAJoFMlukREYDpagzzBbf0evDn0lTT/bT4uYFIvXAPBPRoyUwIzAMBgNV
HRMBAf8EAjAAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMAUGAytlcANBAGvsC8nlETfj
DDAA93Wxa82FTZ2YIR8legw6RCy0J/RvFRIHf5MEHsKOzIyiRwIzoQYsNbEAaaE5
b7S2Rh0OaAg=
-----END CERTIFICATE-----
`,
  key: TEST_TLS_KEY,
};

/**
 * What a test server does with one accepted connection, given the request
 * head it read from it (everything up to the blank line).
 */
export type RawHttpHandler = (
  conn: Deno.Conn,
  requestHead: string,
) => Promise<void>;

/**
 * A server on `127.0.0.1` that hands each connection's raw bytes to a test,
 * so the test controls exactly what an HTTP client reads: malformed status
 * lines, folded headers, chunked framing and early ends included.
 */
export interface RawHttpServer {
  readonly port: number;

  /** The request head of every connection, in the order they arrived. */
  readonly requests: readonly string[];

  close(): Promise<void>;
}

const readRequestHead = async (conn: Deno.Conn): Promise<string> => {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(4096);
  let text = "";
  while (!text.includes("\r\n\r\n")) {
    const bytesRead = await conn.read(buffer);
    if (bytesRead === null) {
      break;
    }
    text += decoder.decode(buffer.subarray(0, bytesRead));
  }
  return text.split("\r\n\r\n", 1)[0]!;
};

/** Writes `response` to `conn` and closes it. */
export const respondWith =
  (response: string | Uint8Array): RawHttpHandler => async (conn) => {
    const bytes = typeof response === "string"
      ? new TextEncoder().encode(response)
      : response;
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += await conn.write(bytes.subarray(offset));
    }
    conn.close();
  };

const serve = (
  listener: Deno.Listener<Deno.Conn, Deno.NetAddr>,
  handler: RawHttpHandler,
): RawHttpServer => {
  const requests: string[] = [];
  const handled: Promise<void>[] = [];
  const accepting = (async () => {
    for await (const conn of listener) {
      handled.push((async () => {
        try {
          const head = await readRequestHead(conn);
          requests.push(head);
          await handler(conn, head);
        } catch {
          // The client may close first, which is what some tests are about.
        } finally {
          try {
            conn.close();
          } catch {
            // Already closed by the handler or the client.
          }
        }
      })());
    }
  })();
  return {
    port: listener.addr.port,
    requests,
    async close() {
      listener.close();
      await accepting;
      await Promise.all(handled);
    },
  };
};

export const serveRawHttp = (handler: RawHttpHandler): RawHttpServer =>
  serve(Deno.listen({ hostname: "127.0.0.1", port: 0 }), handler);

export const serveRawHttps = (
  handler: RawHttpHandler,
  identity: TlsIdentity = TEST_TLS_SERVER,
): RawHttpServer =>
  serve(
    Deno.listenTls({ hostname: "127.0.0.1", port: 0, ...identity }),
    handler,
  );

/**
 * A {@link WebFetchNetwork} that refuses every lookup and connection, for a
 * case that should never reach the network: if it does, it fails here rather
 * than on the internet.
 */
export const offlineNetwork = {
  resolveDns: (query: string): Promise<string[]> =>
    Promise.reject(new Error(`no DNS in this test: ${query}`)),
  connect: (options: Deno.ConnectOptions): Promise<never> =>
    Promise.reject(new Error(`no network in this test: ${options.hostname}`)),
  // Taking no connection, it serves as the TLS of any network.
  startTls: (): Promise<never> =>
    Promise.reject(new Error("no TLS in this test")),
} satisfies WebFetchNetwork<never>;

/**
 * A {@link WebFetchNetwork} whose every connection reaches `port` on
 * `127.0.0.1`, whatever address web_fetch validated and asked for, and whose
 * TLS is {@link defaultWebFetchNetwork}'s, trusting {@link TEST_TLS_AUTHORITY}
 * too. It records what web_fetch asked for, so a test sees which address and
 * port it pinned and which name it verified.
 */
export interface LoopbackNetwork extends WebFetchNetwork<Deno.TcpConn> {
  readonly connects: Array<{ hostname: string | undefined; port: number }>;
  readonly tlsHostnames: string[];
}

export const loopbackNetwork = (
  port: number,
  options: {
    resolveDns?: LoopbackNetwork["resolveDns"];
    /** Addresses whose connection is refused instead of reaching `port`. */
    unreachable?: readonly string[];
  } = {},
): LoopbackNetwork => {
  const connects: LoopbackNetwork["connects"] = [];
  const tlsHostnames: LoopbackNetwork["tlsHostnames"] = [];
  return {
    connects,
    tlsHostnames,
    resolveDns: options.resolveDns ??
      ((query) => Promise.reject(new Error(`no DNS in this test: ${query}`))),
    connect(connectOptions) {
      connects.push({
        hostname: connectOptions.hostname,
        port: connectOptions.port,
      });
      if (options.unreachable?.includes(connectOptions.hostname ?? "")) {
        return Promise.reject(
          new Deno.errors.ConnectionRefused(
            `connection refused: ${connectOptions.hostname}`,
          ),
        );
      }
      return Deno.connect({
        hostname: "127.0.0.1",
        port,
        signal: connectOptions.signal,
      });
    },
    startTls(conn, { hostname }) {
      tlsHostnames.push(hostname);
      return defaultWebFetchNetwork.startTls(conn, {
        hostname,
        caCerts: [TEST_TLS_AUTHORITY],
      });
    },
  };
};
