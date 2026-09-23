# Toolshed

Toolshed is where we organize all of our backend platform tools that are needed
to run our system.

## Project Overview

### API Endpoints

For a detailed list of endpoints, their documentation, and an interactive API
playground, take a look at the Toolshed API reference playground:
<https://toolshed.commontools.dev/reference>

### Philosophy and Structure

Toolshed is built as a single monolithic [Deno2](https://deno.com/blog/v2.0)
[Hono HTTP API](https://hono.dev/) with the following key principles:

1. **Personal Computing, Not Webscale** - Each user will have their own
   instance, so optimize for individual-user-scale
2. **Minimize Complexity** - Keep implementations and endpoints simple and
   shallow
3. **Product Before Protocol** - Focus on building features that enable
   user-facing use cases
4. **Ship First, Optimize Later** - Use proven technology and iterate quickly

The project follows a structured layout:

```sh
toolshed/
├── lib/          # Shared utilities and configuration
├── middlewares/  # Global hono middleware
├── routes/       # API endpoints
│   ├── ai/       # AI-related services
│   │   └── llm/   # LLM services
│   │   └── img/   # Image generation services
│   │   └── spell/ # Spell casting and other spell related things.
│   │   └── voice/ # Voice transcription services
│   └── health/   # Health checks
├── app.ts        # Main app setup, where we mount all the routes
├── env.ts        # Environment variable configuration
└── index.ts      # Main hono entry point
```

### The LLM provider abstraction

The model catalog, the aliases, the capability records, the provider clients,
and the chain that decides what `default` means are all in
[`routes/ai/llm/models.ts`](routes/ai/llm/models.ts). `@commonfabric/llm` is the
caller's side of that boundary and holds none of it: it names a model and posts
the request here.
[`docs/features/llm-provider-boundary.md`](../../docs/features/llm-provider-boundary.md)
gives the reasoning.

### Gateway request provenance

The LLM gateway attributes its spend by what a caller says about itself, so the
requests toolshed sends it carry the same `x-cf-harness-*` headers and
`User-Agent` that `cf-harness` sends. The headers are built by
`lib/gateway-provenance.ts` from
[`@commonfabric/cf-harness/provenance`](../cf-harness/src/provenance.ts), and
they go on requests to the gateway alone: the other providers in
`routes/ai/llm/models.ts` address a model vendor's own API, which has nothing in
front of it to remove an internal header.

A request reports `service=toolshed`, a principal for the machine, a session for
this toolshed process, and a `command` naming the route it came from —
`generate-text`, `generate-object`, `list-models`, or `web-search`. The access
log records the user agent of every request, so in Cloud Logging:

```text
resource.type="k8s_container"
resource.labels.namespace_name="envoy-gateway-system"
jsonPayload."user-agent"=~"^toolshed "
```

`jsonPayload.caller_command` splits that traffic by route, and
`jsonPayload.caller_session` groups the requests of one toolshed process.

The principal is kept in `$CF_HARNESS_HOME/principal`, or under `HOME` when that
is unset, so a deployment whose filesystem does not survive a restart draws a
new one each time. Setting `CF_HARNESS_PRINCIPAL` pins it to the deployment.

What a value may contain is fixed by the invariants in
[`docs/features/gateway-request-provenance.md`](../../docs/features/gateway-request-provenance.md):
no request content, and nothing that identifies a person. The gateway removes
these headers from the request by name, so a field added here without the
matching change to the gateway manifests reaches the model vendor instead.

## Getting Started

Follow the repository
[development quick start](../../README.md#quick-start-development) to clone the
repository and install the pinned toolchain. Then configure the Toolshed
environment.

### Environment Setup

To set up your environment, you'll need to create a `.env` file in the root of
the toolshed application. You can use the `.env.example` file as a reference.

```shell
cd packages/toolshed
cp .env.example .env
```

The single source of truth for environment variables is the `env.ts` file; it
specifies the types and the defaults for all environment variables in toolshed.

## Development

To run the toolshed development server, you'll want to cd into the toolshed
directory, and then run the following command:

```shell
deno task dev
```

### Running in the background

Passing `--background` starts the server without the caller having to put it in
the background and then wait for it to come up. The command spawns the server as
a child, waits until it has bound its port, and only then returns. Its exit code
reports whether the server started: zero once the server is listening, non-zero
if the server exits before it binds. So a script can start the toolshed and move
straight on to work that needs it, with no readiness poll of its own:

```shell
./toolshed --port=8000 --background --log-file=/tmp/toolshed.log
```

The background server sends its own output to `--log-file` (a temporary file
when the flag is omitted); the command prints that path on success and dumps the
file if the server exits before binding. Readiness travels from the child to the
command over a pipe, so the wait resolves on the event rather than on a poll.
`--background` re-runs the program, so it needs the compiled binary or a
`deno run` launch, not `deno --watch`.

To run the tests:

```shell
deno task test
```

## Editor Setup

The simplest thing to do is open the toolshed directory in vscode/cursor, and
everything should work; as there is configuration in
/toolshed/.vscode/settings.json`.

You'll want to install the
[Deno extension](https://docs.deno.com/runtime/reference/vscode/), and the
[Prettier extension](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode).

## Contributing

1. Fork the repository
2. Create a feature branch
3. Open a pull request
4. If you want a review, ask for a review!
5. Merge!

All code that gets merged into the `main` branch will be immediately deployed to
production.

If you break it, you are responsible for fixing it.

## Space invitations

`GET /api/space-invites` advertises protocol version 1 and its host limits:
1,000 distinct identities per invitation and 2,592,000 seconds (30 days) of
admission lifetime. `maxUses` defaults to 1. Unsupported hosts return 404;
clients must report that state without falling back to wildcard grants.

All invitation operations are signed JSON POSTs under
`/api/spaces/:space/invites/`: `create`, `redeem`, `list`, `revoke`, and
`receipts`. They use the existing CF1 proof, binding method, authority, path,
body hash, and signer DID, with a maximum 300-second lifetime and 60 seconds of
future clock skew. Bodies are limited to 4 KiB and unknown fields are refused.
Redemption does not require an existing target-space session. Its recipient is
always the proof signer. Creation, listing, revocation, and receipt listing
require a current explicit OWNER entry in the space ACL. First redemption also
requires the issuer to remain an explicit OWNER.

Configure `API_URL` as the canonical public HTTPS origin, or loopback HTTP in
local development. It is the audience authority and verifier origin for this
service, including behind a reverse proxy. Forwarded headers cannot override it.
Signed POST CORS permits the CF1 headers without cookies; deploy the service at
a host reachable by the intended shell. Request logging records no bodies. Codes
belong only in POST bodies and browser fragments, never URL queries.

The server prints that origin as its configured first-party authority at
startup, and a refused proof is logged at `warn` with the request path, its
method, that authority, and the verification failure — enough to tell a
misconfigured origin from a bad signature without recording the proof, the
signature, or any code. The signed inbox routes under `/api/inbox/` take the
same origin and log the same way.

The reusable client is `SpaceInviteClient` from
`@commonfabric/runner/space-invites`. The same export provides
`createInviteCredentials`, `inviteCodeVerifier`, `buildInviteLink`, and
`parseInviteLink`. A join link is `/join?host&space&invite#code`, with an
optional `inviter` DID key in the query; the parser refuses any other query key.
`inviter` is a display hint that anyone holding the link can change; it is
checked only syntactically and is not part of the code verifier. A recipient
cannot read the space ACL before redeeming, and afterwards an ACL check can show
at most that the DID is an owner, not that it issued the link. Like the space
DID, it travels in the query, so it reaches the shell host's access logs.
`issue` accepts a prepared request containing `inviteId`, `codeVerifier`,
`access`, `ttlSeconds`, and optional `maxUses`. Retain the credentials before
calling it so an uncertain response can be retried with the same ID. The
convenience `create` accepts the same access/lifetime/limit options and optional
paired `inviteId` and `code`, and returns flat active metadata plus `code`. If
the create request fails, `SpaceInviteCreateError` retains its credentials and
original options in the frozen `retry` getter. Retry with
`client.create(error.retry)` on the same client. The getter contains the bearer
code: keep it private, and use it only to recover or retry this invitation.
Ordinary error inspection and JSON serialization omit these credentials. The
error preserves a structured refusal code; uncertain transport or response
parsing failures use `create-outcome-unknown`. Validation failures before
sending remain `SpaceInviteError` refusals. `redeem` accepts only `inviteId` and
`code`; `list` and `receipts` return arrays; `revoke` returns
`{ "revoked": true }`.

Successful redemption returns `outcome` (`redeemed` or `already-redeemed`),
`redemption` (`inviteId` and `did`), and `currentAccess` (`READ`, `WRITE`,
`OWNER`, or null). Current access is an observation, and the ordinary session
checks it again. A receipt-first retry never regrants removed access. New
identities see `invite-unavailable` for unknown, wrong-code, expired, revoked,
exhausted, or issuer-invalid invitations. Proof failures use `invalid-proof`;
owner failures use `not-owner`. Outside the convenience `create` operation,
transport failures remain transport failures. Malformed error responses use
`service-error`.

Admission uses private tables in the target space's SQLite engine, inside the
same serialized transaction as its ACL-only public commit. A unique receipt pair
consumes one use, including when the recipient already has sufficient access.
Stronger explicit or wildcard access remains intact. Exhaustion, revocation, and
expiration remove the active verifier; successful receipt pairs remain.
Expiration is checked on each operation, with lazy physical cleanup. Unredeemed
retired IDs have secret-free rejection markers for 361 seconds, covering replay
of every still-fresh accepted create proof.

A full SQLite backup includes private invite tables and receipts atomically.
Restore the complete store; restoring only the graph must not be used to
reconstruct active invitations. Ordinary graph exports contain neither the
active rows nor receipt tables. Administrative whole-store snapshots contain
private verifiers and must receive the same protection as the live store.
Deletion of an active row does not erase retained backups, WAL pages, or old
filesystem bytes. Expiry and revocation stop admission; removing a member is a
separate ACL operation.

## DID inbox delivery

`GET /api/inbox` advertises the generic private inbox protocol. Signed POSTs
under `/api/inbox/` enable, inspect readiness, send, list, get, and acknowledge
inert messages. The verified signer owns recipient operations and identifies the
sender; delivery grants no space access. See
[DID inboxes](../../docs/features/did-inboxes.md) for limits, retry receipts,
storage, and the `@commonfabric/runner/inbox` SDK.
