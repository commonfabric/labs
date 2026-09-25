# Handler-callable egress

A pattern reaches the network through the runtime's fetch builtins —
`fetchJson`, `fetchText`, `fetchBinary`, `fetchJsonUnchecked`, `fetchProgram`.
Each is a node factory: calling one wires a node into the reactive graph at the
current build frame and hands back a reactive cell, and the runtime issues the
request on the pattern's behalf. That indirection is what lets the runtime
record the request as a Contextual Flow Control sink request, measure it against
the sink's confidentiality ceiling, resolve a relative URL against the executing
space's host, and sign it when it targets a first-party route.

No ambient route reaches the network beside them. A compartment endows no
`fetch`, and `fetch`, `Headers`, `Request`, and `Response` are withheld from the
type libraries, so authored code that reaches for one fails to compile. The
other runtime-managed sinks — `streamData`, and the llm class (`llm`,
`llmDialog`, `generateText`, `generateObject`) — reach the network the same way
the fetch builtins do, as nodes the runtime issues, and
`packages/runner/src/cfc/sink-inventory.ts` is the list of all of them.

## The shape that has no home

A node factory is not awaitable, and a node re-runs whenever its inputs change.
So one shape of program cannot be written as a pattern at all: a sequence of
requests where each depends on the last, driven from a handler, with mutations
among them. An API client for a provider that authenticates with OAuth is
exactly that shape — issue a request, read its status, refresh the token on a
401, retry, issue the next, and send something that changes state at the far
end.

Patterns of that shape used to exist for Gmail, Google Calendar, Google Docs,
and Airtable. They ran on the ambient `fetch` and were removed with it. The
capability they needed is a handler-callable egress the runtime can see: one
that produces the same sink record, the same ceiling check, and the same
first-party signature a node factory's request produces.

**Owner.** The Contextual Flow Control runtime, alongside the sink governance in
`packages/runner/src/cfc/sink-inventory.ts`.

**Retirement.** This plan is done when a handler can issue a request that the
runtime records and gates, and an OAuth API client can be written against it.

## The two routes, and what each costs

**Through the commit boundary, as the node factories do.**
`enqueueSinkRequestPostCommitEffect` stages the request inside the transaction
and sends it only once that transaction is durable, so a refused or abandoned
transaction sends nothing. That ordering is also why it cannot serve an awaited
call: the handler is still building the transaction the release waits on, so
awaiting the response inside the handler waits for a commit that the await is
blocking. Serving a handler this way means either finishing the handler's
transaction before the request goes out — which gives up reading the response in
the same handler — or giving a request its own transaction, which is a different
release than the one the boundary measures.

**Before the send, as a host egress does.** `decideSinkRelease` in
`packages/runner/src/cfc/prepare.ts` answers the same question synchronously for
an egress the host performs rather than a pattern: it reads what is about to be
released through a transaction and applies the committed sink gate's boundary,
trust, policy-selection, mode, exhaustion, and fit semantics. The host decision
is non-consuming, so a single-use grant cannot authorize it. A handler `fetch`
routed through `runtime.fetch` and refused by this check before any bytes leave
is reachable today.

What it does not give, and what a design taking this route owes an answer for:

- **No record.** The check refuses or permits; it writes nothing. A permitted
  request leaves no sink-request input for anything to audit afterwards.
- **A coarser measurement.** It measures the whole transaction's consumed join
  rather than the request's own reads, so it refuses flows the per-request check
  would allow.
- **No commit ordering.** The bytes leave before the handler's transaction
  commits, so a transaction that is later refused has already sent its request.
- **None of the request machinery.** Memoization, the cross-tab request mutex,
  and abandoned-request settlement all belong to the builtin.
- **A request instant the pattern chooses.** Channel 7 in
  `docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md` is closed today because a
  pattern has no request whose settlement it can observe. A handler-callable
  egress reopens that question and has to answer it.

## The rest of the stack is still there

The provider side of the removed patterns was not touched: the OAuth routes
under `packages/toolshed/routes/integrations/`, the `<cf-google-oauth>` and
`<cf-oauth>` components in `packages/ui`, and their entries in the environment
registry. They can mint a token; until this plan lands, no pattern can spend
one.
