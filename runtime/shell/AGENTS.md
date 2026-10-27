# Shell — Agent Guide

The browser-based shell: a Lit web-component application that hosts the piece
runtime and gives a user a way to move around their spaces. Entry point is
`src/index.ts`.

## Facts that will bite you

- `deno task dev` points at the **production** backend. For local work run
  `deno task dev-local`, which serves on `127.0.0.1:5173` and is reached through
  the toolshed proxy on port 8000, not directly. See
  [`LOCAL_DEV_SERVERS.md`](../../docs/development/LOCAL_DEV_SERVERS.md).
- Type checks and tests run from the workspace root, not from this package.
- The vocabulary of "where am I pointing" — `AppView`, the URL scheme that
  encodes it, and the `cf-navigate` family of events that ask to go there —
  belongs to `@commonfabric/navigation`, not to this package. The `ui`
  components and `lib-shell` use it too, so a change there is a change to
  several packages. This package's only export is `./app-state`, which the
  integration-test harness reads.
- A component never writes application state. It calls `this.command(...)` from
  `BaseView`, which dispatches a composed, bubbling `shell-command` event that
  `XRootView` catches and routes to one of its own methods. `Command` is a
  closed union in `src/views/BaseView.ts`, so a new kind of state change means a
  new arm on that union and a new method on `XRootView`, not reaching past
  either. That event carries an unchecked `detail` across the DOM, so
  `setConfig` re-checks the config key it is handed.
- `XRootView` owns every write to `AppState`, through `setView`, `setIdentity`
  and `setConfig`. `src/lib/app-state.ts` names the part of that surface a
  caller outside the element sees as `ShellApp`: the shell's `Navigation` takes
  one, and `src/index.ts` publishes the root element on `globalThis.app` under
  that type, which is how integration tests drive the page. That publication is
  the last step of bootstrap, after the key store opens and `Navigation` is
  installed, so a page that has fired `load` has not necessarily reached it. A
  navigation through a page `ShellIntegration` attached waits for that
  publication before it returns, so a test that navigates or reloads through one
  reaches a shell that is there. A driver holding a page from anywhere else
  waits for itself — `login` in `runtime/integration/shell-utils.ts` does, and
  `runtime/shell/integration/login.test.ts` holds it to that.
- Navigation is the other way in, and it does not come from a shell view. Anyone
  holding `@commonfabric/navigation` calls `navigate(...)`, which dispatches a
  `cf-navigate` event on `globalThis`; the `Navigation` class in
  `src/lib/navigation.ts` listens, writes browser history, and calls `setView`
  on the `ShellApp` it holds. `cf-cell-link`, `cf-space-link`, `cf-render`, and
  `cf-profile-badge` navigate this way, so a piece being rendered can move the
  whole shell. The events an embedding host may bind to instead are listed in
  [`host-embedding.md`](../../docs/features/host-embedding.md).
- `XRootView` is where a `cf-` component gets its runtime. It holds the only
  `@provide` of `runtimeContext` and `spaceContext`, the two Lit contexts
  defined in the `ui` package, and five components there `@consume` them:
  `cf-cell-link`, `cf-code-editor`, `cf-file-input`, `cf-profile-badge`, and
  `cf-prompt-input`. One of those mounted outside this tree sees `undefined` for
  both and renders as though nothing is connected.
- `src/lib/runtime.ts` and `src/lib/credentials.ts` are one-line re-exports of
  `@commonfabric/lib-shell`, which is where `RuntimeInternals` and the key
  handling actually live. The pattern integration tests import that package
  directly, so editing it changes something outside this package too. Look there
  first when a runtime question is not answered by the files under `src/`.
- Embed mode is a property of the route, not of a component. The `.embed` path
  prefix (`runtime/navigation/src/view.ts`) strips shell-owned chrome, and every
  navigation has to preserve it — including one issued by a rendered pattern. A
  navigation that drops the prefix escapes the embedding host.
- The build tool is `@commonfabric/felt`, which lives in this repository at
  `base/felt` rather than coming from a registry. Its configuration is
  `felt.config.ts`.
- Views use `@lit/task` for asynchronous work, and cleanup belongs in the
  component lifecycle. A task that outlives its component keeps writing into a
  disconnected tree.
- `BodyView` opens the piece menu over the surface a piece failed to load into.
  Everywhere else a right-click reaches `cf-render`, and there is no `cf-render`
  on that surface, so the view stands in for it and hands the menu the space
  with no piece. That is why it takes a `space` property it otherwise would not
  need.

## Where answers live

| Question                       | Read                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| The state shape                | `src/lib/app-state.ts`                                                                                       |
| What commands exist            | `Command` in `src/views/BaseView.ts`                                                                         |
| How a command is applied       | `onCommand` and the state setters in `src/views/RootView.ts`                                                 |
| How a navigation becomes one   | `Navigation` in `src/lib/navigation.ts`                                                                      |
| What a URL means, embed mode   | `runtime/navigation/src/view.ts`                                                                             |
| How a slug reaches a piece     | `handleSlugResolve` in `runtime/runtime-client/src/backends/runtime-processor.ts`                            |
| How the runtime is mounted     | `RuntimeInternals` in `runtime/lib-shell/src/runtime.ts`                                                     |
| Coding style and test commands | [`DEVELOPMENT.md`](../../docs/development/DEVELOPMENT.md), [`TESTING.md`](../../docs/development/TESTING.md) |
| Writing a `cf-` component      | the `lit-component` skill                                                                                    |
