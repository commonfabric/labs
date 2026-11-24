# Laptop GitHub host

`@commonfabric/github-host` runs the GitHub connector on a workstation. It uses
local GitHub credentials and writes current pull-request state to a Common
Fabric space.

## Configuration

Create a JSONC file from `github-host.config.example.jsonc`. The collection
interval is a normal full reconciliation schedule. It is also the recovery path
after GitHub or network downtime. The host does not use a rapid retry loop.
`account` names the GitHub login the token must authenticate. Account and GitHub
host identify the connector's cells, so several users can publish into one
Fabric space without replacing one another.

The host reads GitHub credentials in this order:

1. `GH_TOKEN`
2. `GITHUB_TOKEN`
3. `gh auth token`

The token remains in process memory. It is not written to disk, logs, health, or
Fabric. The token needs access to every private repository whose pull requests
should appear. An existing `gh auth login` with repository access is the usual
laptop setup.

The Common Fabric options match `agents-host`:

```sh
deno task github-host --config ./github-host.jsonc \
  --api-url "$CF_API_URL" \
  --identity "$CF_IDENTITY" \
  --space "$CF_SPACE"
```

Use `--once` for one complete reconciliation and exit. In long-running mode,
send `SIGHUP` for an immediate collection. Send `SIGINT` or `SIGTERM` for a
graceful stop when running the host directly. For the launchd deployment, use
`launchctl bootout "gui/$(id -u)/com.commonfabric.github-host"` to stop it.

## Availability behavior

A complete collection replaces the current index. An incomplete collection does
not touch it. Health becomes `degraded` and records the failure. The next
scheduled or SIGHUP collection performs another complete scan.

After the laptop reconnects, one successful collection reconstructs the whole
current open-pull-request table. Consumers should display
`lastCompleteCollectionAt` and the health status so an old snapshot is visibly
stale. The connector records current state rather than every transient state
that occurred while the laptop was offline.

## macOS deployment

For a service that does not depend on an interactive shell, compile the host and
store its configuration under the user's Application Support directory:

```sh
mkdir -p "$HOME/Library/Application Support/CommonFabric/bin"
mkdir -p "$HOME/Library/Application Support/CommonFabric/github-host"
deno compile -A \
  -o "$HOME/Library/Application Support/CommonFabric/bin/github-host" \
  connectors/github/host/main.ts
cp connectors/github/host/github-host.config.example.jsonc \
  "$HOME/Library/Application Support/CommonFabric/github-host/config.jsonc"
```

Edit the copied configuration. Then copy and edit the launch-agent example.
Replace every value in angle brackets with an absolute path or value. Set the
first `PATH` entry to the directory containing `gh`, such as `/opt/homebrew/bin`
on an Apple Silicon Homebrew installation:

```sh
cp connectors/github/host/deploy/com.commonfabric.github-host.plist.example \
  "$HOME/Library/LaunchAgents/com.commonfabric.github-host.plist"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.commonfabric.github-host.plist"
```

The example uses `RunAtLoad` and `KeepAlive`. If the host cannot reach Toolshed
during startup, launchd starts it again. Once the host is running, GitHub
failures do not terminate it. The configured full reconciliation schedule
repairs the snapshot after connectivity returns.

The host holds an exclusive process lock for each API, space, GitHub host, and
account combination. A second host targeting the same cells exits instead of
racing index generations.

Recompile the binary after updating this checkout. Use
`launchctl kickstart -k "gui/$(id -u)/com.commonfabric.github-host"` to replace
the running process with the new binary.
