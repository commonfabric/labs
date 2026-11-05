# Common Fabric agent connector

`@commonfabric/agents-connector` copies persisted coding-agent sessions into a
Common Fabric space. It also accepts commands for those sessions and publishes
durable receipts for each command.

The package contains drivers for the Claude Agent SDK, the Codex App Server, and
Agent Client Protocol servers. Each driver converts its provider's native
session representation into one connector-owned model. The Fabric target stores
that model as stable session, chunk, index, health, command, and receipt cells.

The package does not supervise its host process or choose product configuration.
A host supplies source configuration, starts and stops drivers, connects a
Common Fabric runtime, chooses the target space, schedules collection, and
decides how health is reported.

## Documentation

- [Architecture](docs/architecture.md) explains the components, data paths,
  state ownership, lifecycle, and concurrency model.
- [Interfaces and protocols](docs/interfaces.md) specifies every package
  boundary. It covers host orchestration, provider drivers, native provider
  protocols and file access, Fabric cells, command values, the local ledger, Git
  metadata, identity, hashing, and chunking.

## Public entry points

The package root exports the normalized types, collection helpers, Fabric
target, command worker, command ledger, stable graph helpers, identity helpers,
and schema constants.

Provider integrations use separate entry points:

- `@commonfabric/agents-connector/create-driver`
- `@commonfabric/agents-connector/drivers/acp`
- `@commonfabric/agents-connector/drivers/claude-agent-sdk`
- `@commonfabric/agents-connector/drivers/codex-app-server`

Importing the package root does not load provider SDKs or start provider
processes.

## Tests

Run the package tests from this directory:

```sh
deno task test
```
