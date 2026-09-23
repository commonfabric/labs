<!-- @reviewed 2025-12-11 docs-rationalization -->

# Local Development Servers - Troubleshooting

## Quick Reference

**Use the scripts** (see the cf skill for full documentation):

```bash
./scripts/start-local-dev.sh          # Start both servers
./scripts/stop-local-dev.sh           # Stop both servers
./scripts/restart-local-dev.sh        # Restart both
./scripts/restart-local-dev.sh --force       # Force kill first
./scripts/restart-local-dev.sh --clear-cache # Clear disposable caches (preserves spaces)
./scripts/restart-local-dev.sh --dangerously-clear-all-spaces # Clear databases/spaces
./scripts/restart-local-dev.sh --bg-updater  # Also start background-piece-service
./scripts/start-local-dev.sh --cf-harness    # ...and a cf-harness console
./scripts/check-local-dev.sh          # Health check both servers
./scripts/share-pattern-via-tailscale.sh packages/patterns/lunch-poll/main.tsx  # Host a pattern + share on your tailnet
./scripts/share-pattern-via-tailscale.sh --down                                 # Tear that down
```

### `--cf-harness`

`--cf-harness` starts a cf-harness console against the fabric these scripts are
starting, on the port Weaver pairs with, and stops it with the pair.
`restart-local-dev.sh` forwards the flag. The console resolves the rest from
that fabric — the toolshed URL and store from this script's own values, the
sandbox's sidecar directories from Docker's runtime registration — and prints
every value beside the record that decided it, so a wrong one names where to fix
it. Two values it cannot derive: set `CF_IDENTITY` to an identity keyfile and
`CF_SPACE` to a space name, or the console's own `CF_HARNESS_FABRIC_IDENTITY`
and `CF_HARNESS_FABRIC_SPACE`, which name the same two and win over them. Under
loom there is no need — loom exports `LOOM_INSTANCE_ID`, and the console reads
the identity and space off that instance's `pieces.json`.

Each value the console needs is settled the same way: what the command line
named, then what the instance recorded, then what the shell exported, then an
error naming the flag and the variable that supply it. **A loom instance's
record outranks the environment**, so a shell that happens to export
`MEMORY_DIR` or `CF_IDENTITY` cannot quietly send the console to another
instance's store or sign with another key. The printout says which of the three
decided each value.

`--allow-skill-scripts` alongside `--cf-harness` lets that console run the
scripts of the skills it holds, in its sandbox, registry and acquired alike; it
is off unless named. `start-local-dev.sh` passes it to `console:launch`, which
resolves it and prints it beside the record that decided it.
`packages/cf-harness/console/README.md` has the rest.

The console is a surface on the fabric rather than part of it. It needs Docker
and a connected model provider, and when it cannot start — either of those
missing, its port taken, a value underivable — it says so in the script's output
and in `packages/cf-harness/local-dev-console.log`, and the shell and toolshed
keep running. `packages/cf-harness/console/README.md` covers the console itself,
and [`../../packages/cf-harness/docs/WEAVER.md`](../../packages/cf-harness/docs/WEAVER.md)
the operator procedure it belongs to.

Source-run build metadata describes the checkout the same way compiled
binaries do: `start-local-dev.sh` defaults `COMMIT_SHA` to the checkout's
current HEAD, and an explicit value in the environment overrides that default:

```bash
COMMIT_SHA="<some-other-sha>" ./scripts/start-local-dev.sh --bg-updater
```

The script's children inherit the value: toolshed uses it as the source-run
fallback for `/api/meta.gitSha`, and shell surfaces it in diagnostics. The
source-run shell still loads its mutable worker graph from `/scripts`; only a
deployed shell selects the immutable `/builds/<sha>` namespace. `COMMIT_SHA` is
descriptive metadata, not a system-pattern update gate. The updater instead
compiles the downloaded source/import closure and requires its entry identity
to equal `?identity` before changing the persisted root.

The cf CLI resolves its own commit the same way (baked build metadata for
compiled binaries, the checkout's HEAD for source runs) and compares it
against the server's self-reported commit on every server-touching command,
warning on stderr when the two differ. The server side rides the `/_health`
response the CLI's health check already fetches (the same value `/api/meta`
reports), so the check adds no request of its own.

The warning is graded, because the two directions are different problems. A
cf newer than its server is the normal local-dev state (the checkout moved
on; the server kept running) and prints nothing on a command that succeeds —
its note is held for failures, as context naming how far behind the server is.
Commit distance alone does not establish incompatibility or explain a failure.
For a local server you control, restarting it from the CLI's checkout aligns
the versions.
`cf piece call` suppresses the held note for a confirmed unknown verb, a rejected
payload, or argument validation that fails before dispatch. A cf **older** than
its server is the
dangerous direction — the server speaks a protocol this cf predates — and
gets a loud OUTDATED warning immediately, success or not. Direction is proven by git ancestry in the checkout's
history, so it is available to source runs whose history contains the
server's commit; diverged or unorderable pairs (including compiled binaries)
get the undirected wording. Set `CF_SKIP_VERSION_CHECK=1` to skip the check
when running mismatched versions on purpose.

To let teammates interact with a locally-hosted pattern (e.g. "host latest-main
`<pattern>` locally with `--inspect` and export it over Tailscale"), use
`share-pattern-via-tailscale.sh`. It starts an isolated toolshed (with
`--inspect`) + shell on offset ports, deploys the pattern, and `tailscale serve`s
it (tailnet-only). It launches the shell with `API_URL` set to your MagicDNS name
— the standard `dev-local` task bakes in `localhost`, which breaks remote
browsers.

`start-local-dev.sh` validates required commands before launching anything and
waits for both servers to bind their ports and return HTTP 200 before reporting
success. It then waits on the toolshed's `/`, the page a browser loads, which
the toolshed answers by fetching the shell dev server and passing the result
back; that is the one probe covering the hop between the two servers, which
can be broken while each of them answers on its own port. Set
`LOCAL_DEV_STARTUP_TIMEOUT` to adjust the readiness timeout in seconds.

**Exit codes (`start-local-dev.sh`):**
| Code | Meaning |
|------|---------|
| `0` | Both servers started and became ready. |
| `3` | A server could not bind because its port is already in use; retry on a different port offset. |
| `4` | A requested port is one clients refuse to connect to; change the port offset. |
| other non-zero | Any other startup failure (build error, crash, readiness timeout). |

Code `3` is reported only when a server's actual bind fails, not from a port
pre-check, so it carries no check-then-bind race. The toolshed and the shell dev
server exit with the same code, and `deno task integration` relies on it to
retry a generated offset on a collision while aborting on any other failure.

Code `4` is a pre-check, and binding is not what it is about. Browsers and
Deno's `fetch` both implement the WHATWG bad-port list, and reject a request to
a port on it before opening a connection. A server binds such a port normally:
it starts, logs that it is listening, and answers the `curl` health check the
script uses. Every client that matters then refuses it — the browser cannot load
the page, and toolshed's proxy hop to the shell dev server fails, so toolshed
serves its "Failed to proxy" text in place of the app. `ports.json` records the
list; `start-local-dev.sh` checks the shell and toolshed ports against it always
and the inspector port when `--inspect` is passed, and `deno task integration`
leaves every offset that reaches one out of the range it generates from. Within
the offsets that command generates, `827` puts the shell dev server on `6000`
and `851` puts the inspector on `10080`.

`restart-local-dev.sh` makes the same check on the ports it was asked for,
before it stops a server or acts on `--clear-cache` or
`--dangerously-clear-all-spaces`, so an offset the start it ends with would
refuse costs nothing on the way to that refusal.

**URLs:**
| What | URL |
|------|-----|
| Backend API | `http://localhost:8000` |
| Frontend/Shell | `http://localhost:8000` |
| Access a space | `http://localhost:8000/[space-name]` |

**Experimental flags:** Pass env vars to the start/restart scripts to enable
experiments on both servers:
```bash
EXPERIMENTAL_EXAMPLE_NAME_1=true \
EXPERIMENTAL_EXAMPLE_NAME_2=true \
./scripts/restart-local-dev.sh --force --dangerously-clear-all-spaces
```
The same env vars must also be set when running `cf` CLI commands against the
server. See `docs/development/EXPERIMENTAL_OPTIONS.md` for all available flags.

**Logs:**
- `packages/shell/local-dev-shell.log`
- `packages/toolshed/local-dev-toolshed.log`

**CLI identity for local dev:** For normal development — deploying pieces,
pattern work, anything acting as *you* — mint a unique key:
```bash
mkdir -p .cf
deno run -A packages/cli/mod.ts id new > .cf/shared-dev.key
export CF_IDENTITY="$PWD/.cf/shared-dev.key"
```
The local toolshed itself runs as the identity derived from the passphrase
`"implicit trust"`. Derive that key only when the CLI must act as the server's
operator/admin (`add-admin-piece`, the background piece service, deploying
system home patterns):
```bash
deno run -A packages/cli/mod.ts id derive "implicit trust" > claude.key
export CF_IDENTITY="$PWD/claude.key"
```
It is a shared, publicly-derivable key — every developer who derives it gets
the same DID. Never use it against a server other people use, and don't deploy
your own work as it even locally: it collapses you into the server principal
(and into one identity for user counting — see
[`active-user-counting.md`](../features/active-user-counting.md)). Full policy:
[`shared-identity.md`](../features/shared-identity.md).

For workflows that touch `PerUser`, `PerSession`, favorites, or home-space
state, use one shared identity in both browser and CLI. The browser login screen
can import a CLI PKCS8/PEM key via `Import CLI Key`. See
[`shared-identity.md`](../features/shared-identity.md).

**First-time browser login:**

When accessing a space for the first time, you'll need to register:
1. Click "➕ Register"
2. Click "🔑 Generate Passphrase"
3. Click "🔒 I've Saved It - Continue"

For Playwright testing, use:
```javascript
// Shown inside a pattern body.
await page.goto("http://localhost:8000/<SPACE>/<PIECE_ID>");
```

---

## Architecture

Common Fabric requires **two servers** for local development:

1. **Backend (Toolshed)** - Port 8000 - API, storage, runtime, proxies shell
2. **Frontend (Shell)** - Port 5173 - Dev server with hot reload (accessed via 8000 proxy)

You cannot access spaces without BOTH running. Access the application at **port 8000**, which proxies to shell. The scripts handle starting them in the correct order.

**Important:** Use `dev-local` (not `dev`) for shell when running against local Toolshed. The `dev` task points to production.

**After editing runtime code:** Restart the servers to pick up changes.

---

## Troubleshooting

### Scripts Not Working

**Check if ports are in use:**
```bash
# macOS or Linux with lsof
lsof -i :8000  # Toolshed
lsof -i :5173  # Shell

# Linux without lsof (use ss instead)
ss -tlnp 'sport = :8000'  # Toolshed
ss -tlnp 'sport = :5173'  # Shell
```

**Force restart:**
```bash
./scripts/restart-local-dev.sh --force
```

### Verifying Servers Are Running

```bash
./scripts/check-local-dev.sh
```

This checks both process presence and HTTP health, exiting non-zero if
anything is wrong. It reports three things: the toolshed on its own port, the
shell on its own port, and the shell through the toolshed — the last being the
page a browser loads, which can fail while the other two are healthy. It
supports the same `--port-offset`, `--shell-port`, and `--toolshed-port` flags
as the other scripts.

When `--port-offset` changes the toolshed port, `start-local-dev.sh` also sets
toolshed's internal `API_URL` and `MEMORY_URL` to the offset toolshed URL unless
those variables are already exported in the shell environment.

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Commands hang/timeout | Servers not running | Run `./scripts/restart-local-dev.sh` |
| Space shows errors | Only one server running | Ensure BOTH are running |
| Port already in use | Previous server didn't stop | Use `--force` flag |
| Stale data | Cache issues | Use `--clear-cache` flag (or `--dangerously-clear-all-spaces` for database issues) |
| `*.ts.net` URLs hang | Not on Tailscale | Connect to the Tailscale network |
| OAuth error: `Unexpected token '<'` | Fetching from wrong port | Use port 8000 for API calls ([see below](#oauth-returns-html-instead-of-json)) |
| UI component changes not appearing | Shell doesn't watch packages/ui | Restart local dev server |

### Manual Fallback

If scripts fail completely, manual process:

```bash
# 1. Kill by port (choose based on your system)
# macOS or Linux with lsof:
lsof -ti :8000 | xargs kill -9 2>/dev/null  # Toolshed
lsof -ti :5173 | xargs kill -9 2>/dev/null  # Shell

# Linux without lsof (use ss + awk):
ss -tlnp 'sport = :8000' | awk -F'pid=' 'NF>1{split($2,a,","); print a[1]}' | xargs kill -9 2>/dev/null
ss -tlnp 'sport = :5173' | awk -F'pid=' 'NF>1{split($2,a,","); print a[1]}' | xargs kill -9 2>/dev/null

# 2. Wait for cleanup
sleep 2

# 3. Start backend (Terminal 1)
cd packages/toolshed
SHELL_URL=http://localhost:5173 deno task dev

# 4. Start frontend (Terminal 2)
cd packages/shell
TOOLSHED_PORT=8000 deno task dev-local
```

**Alternative: Local shell with cloud backend:**
```bash
cd packages/toolshed
SHELL_URL=http://localhost:5173 API_URL=https://toolshed.saga-castor.ts.net/ deno task dev
```

**Environment setup:** Copy `.env.example` to `.env` in the toolshed directory. See [`CONFIGURATION.md`](./CONFIGURATION.md) for a categorized reference of all configuration (env vars, tasks, flags), or `packages/toolshed/env.ts` for the canonical Zod schema.

### Checking Logs

```bash
# View recent shell errors
tail -50 packages/shell/local-dev-shell.log

# View recent toolshed errors
tail -50 packages/toolshed/local-dev-toolshed.log

# Follow logs in real-time
tail -f packages/shell/local-dev-shell.log
tail -f packages/toolshed/local-dev-toolshed.log
```

### OAuth Returns HTML Instead of JSON

**Error:** `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`

This happens when OAuth or API calls hit port 5173 (frontend) instead of port 8000 (backend). The frontend returns HTML, which fails JSON parsing.

| Port | Server | Returns |
|------|--------|---------|
| **5173** | Frontend (Shell) | HTML |
| **8000** | Backend (Toolshed) | JSON |

**Fix:** Ensure API calls use port 8000:
- Deployment: `--api-url http://localhost:8000`
- In patterns: Check `getPatternEnvironment().apiUrl`
- Browser testing: Navigate to `http://localhost:5173` for UI, but API calls should target 8000

### UI Component Changes Not Appearing

When editing `cf-*` components in `packages/ui/`, restart the local dev server to ensure the updated code is running.

The shell's dev server watches `packages/shell/src` only, so a change anywhere
else in the workspace — `packages/ui`, `packages/runtime-client`, and the rest —
does not trigger a rebuild, and the browser keeps serving the previous bundle.
Touching any file under `packages/shell/src` rebuilds everything the shell
bundles, which is quicker than a restart.

---

## Agent Runner (Optional)

`cf agent runner` runs the agent requests a pattern makes with `agent()`. The
builtin is enabled by default through the `agentBuiltin` experimental flag;
requests stay queued until a runner claims them
([`EXPERIMENTAL_OPTIONS.md`](EXPERIMENTAL_OPTIONS.md)).

The runner holds one user's identity, so it takes the identity whose requests
it should run, and the toolshed serving that identity's home space. Against
`dev-local` on a port offset of 100:

```bash
# Shown for illustration only.
./scripts/start-local-dev.sh --port-offset=100

deno task cf agent runner \
  --identity ./my.key \
  --api-url http://localhost:8100
```

On start the runner creates the identity's home pattern if the home space has
none, writes its `agentRunner` entry into the home space's agent queue, and then
follows the queue. It prints a line when it claims a run and when the run ends,
and it runs until interrupted. The model provider is the one `cf-harness` is
configured with under `CF_HARNESS_HOME`; `--model` names a model, and
`--loom-retrieval-config` names the host-owned file backing the read-only Loom
tools. A run's workspace and artifacts go under `--work-root`, which defaults to
`$CF_HARNESS_HOME/agent-runs`.

A run's sandbox is the harness's Docker `runsc-cfc` sandbox, so
`CF_HARNESS_RUNSC_CFC_RESULT_DIR` and
`CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR` name the two sidecar directories
Docker's `runsc-cfc` runtime is registered with. A run's task is bound to the
prompt-slot role `context`, and the run returns its structured result through
the harness's `submit_result` tool, which the harness's default
`enforce-strict` mode admits under that role. Under that mode and role every
other tool is refused, reads included, so a run that should use its tools — a
Loom search, `describe_handle` — needs the runner started with
`CF_HARNESS_CFC_ENFORCEMENT_MODE=enforce-explicit`, which admits read tools.
That dial covers the harness's tool policy and sandbox; the fabric session's
own enforcement is a separate setting and is unchanged by it.

When the home space and the runner's own toolshed are different deployments,
`--api-url` names the first and `--local-api-url` the second. The
[CLI README](../../packages/cli/README.md#agent-runner) describes the command.

---

## Background Piece Service (Optional)

The background-piece-service polls registered pieces and triggers their `bgUpdater` handlers server-side. This is **optional** - only needed if you're testing background/scheduled piece execution.

### Quick Setup (Recommended)

Use the `--bg-updater` flag with the local dev scripts:

```bash
./scripts/start-local-dev.sh --bg-updater
# or
./scripts/restart-local-dev.sh --bg-updater
```

This waits for toolshed to be healthy, then starts the background service. The service log is at `packages/background-piece-service/local-dev-bg.log`. The stop script will also clean up the background service process. The system space cell is auto-created when a piece is first registered (e.g., during Google OAuth).

### Manual Setup

If you prefer manual control:

```bash
# 1. Ensure toolshed is running (uses "implicit trust" identity in dev mode)
./scripts/restart-local-dev.sh

# 2. Start the background service from source
cd packages/background-piece-service
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" deno task start
```

> **Optional:** The `add-admin-piece` task deploys an admin dashboard piece
> into the system space. It is **not** required for normal background-service
> operation -- the system space cell is bootstrapped automatically by
> `setBGPiece()` during the OAuth callback when a piece is first registered.
> Run it only if you want the admin dashboard:
>
> ```bash
> cd packages/background-piece-service
> OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" deno task add-admin-piece
> ```

### Registering a Piece for Background Updates

Pieces must be registered to receive background polling:

```bash
# Via curl
curl -X POST http://localhost:8000/api/integrations/bg \
  -H "Content-Type: application/json" \
  -d '{"pieceId":"fid1:abc...","space":"did:key:z6Mk...","integration":"my-integration"}'
```

Or use the `<cf-updater>` component in your piece's UI.

### Key Details

- **Polling interval**: 60 seconds (default)
- **Identity**: Must match toolshed's identity (in dev mode: `OPERATOR_PASS="implicit trust"`)
- **bgUpdater triggers**: Service sends `{}` to the piece's `bgUpdater` Stream
- **Logs**: Watch service output for `Successfully executed piece` messages

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `CompilerError: no exported member 'pattern'` | Binary version mismatch | Run `deno task build-binaries` |
| `AuthorizationError` on system space | System space not yet bootstrapped | Register a piece (e.g., via OAuth) to auto-create it, or run optional `add-admin-piece` |
| Piece not polling | Not registered | Register via `/api/integrations/bg` |

See `packages/background-piece-service/AGENTS.md` for more details.
