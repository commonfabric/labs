# Shared Identity Development Workflow

Use one identity across the browser, `cf` CLI, FUSE, and browser-driving agents
when testing identity-sensitive behavior. Scoped cells make this important:
`PerUser<T>` and `PerSession<T>` data is keyed by the active user DID, not only
by the space DID.

The workflows here are also the reason an identity is not a reliable stand-in
for a person: one human routinely holds several identities, and one identity is
routinely driven by several actors. See
[`active-user-counting.md`](active-user-counting.md) for what that means when
counting users.

> **Use a unique key (`id new`) for your own identity.** `cf id derive "implicit
> trust"` produces a *fixed, publicly-derivable* DID — the one the local toolshed
> runs as in dev mode — so every developer who derives it shares the exact same
> identity. That is fine on your own single-tenant localhost (it lets the CLI,
> browser, and server act as one admin identity), but against a **shared or remote
> server** (a teammate's box, staging, anything on a tailnet) it collapses
> everyone into one principal: you see and overwrite each other's `PerUser` data
> and act as each other. **Never derive or browser-import `implicit trust` against
> a server other people use.** Reserve it for the one case below.

## When To Derive `implicit trust`

Only to deliberately act *as the local dev server's own identity* — i.e. for
operator/admin tasks on your own localhost where the caller must match toolshed's
dev identity (e.g. deploying system home patterns). For everything else — your
personal identity, normal pattern dev, and any shared or remote server — use
`id new`.

## Recommended Local Workflow

Create one repo-local key and use it everywhere:

```bash
mkdir -p .cf
deno run -A packages/cli/mod.ts id new > .cf/shared-dev.key
export CF_IDENTITY="$PWD/.cf/shared-dev.key"
export CF_API_URL="http://localhost:8000"
deno run -A packages/cli/mod.ts id did "$CF_IDENTITY"
```

Then import the same key in the browser:

1. Open `http://localhost:8000`.
2. On the login screen, choose `Login` or `Register`.
3. Choose `Import CLI Key`.
4. Select `.cf/shared-dev.key`.

The browser stores the imported identity in IndexedDB via `KeyStore`, the same
place passphrase and passkey login stores root keys. After import, browser code,
CLI commands, FUSE mounts, and browser agents using that browser profile all
act as the same DID.

## Existing Browser Mnemonic To CLI

If the browser identity already exists and you need a matching CLI key, derive a
PKCS8 key from the browser recovery phrase with `cf id from-mnemonic`. Give it
the phrase as a file (`-- <file>`) or on stdin (`-`) so the recovery phrase
never lands in your shell history or the process argument list:

```bash
# Read the phrase from a file (the phrase never appears on the command line):
deno run -A packages/cli/mod.ts id from-mnemonic -- phrase.txt > .cf/browser.key

# Or read it from stdin — pipe it in, or type/paste it then press Ctrl-D:
deno run -A packages/cli/mod.ts id from-mnemonic - > .cf/browser.key

export CF_IDENTITY="$PWD/.cf/browser.key"
deno run -A packages/cli/mod.ts id did "$CF_IDENTITY"
```

A single trailing newline is stripped from file or stdin input, so a phrase
saved with `echo` or a text editor works as-is. You can still pass the phrase as
a quoted inline argument (`id from-mnemonic "word1 ... word24"`), but avoid it
for real recovery phrases: arguments are visible in shell history and to other
processes via `ps`.

Do not use `cf id derive <mnemonic>` for this. `from-mnemonic` uses
`Identity.fromMnemonic()` (the same path as browser mnemonic login), while
`cf id derive` uses `Identity.fromPassphrase()`. The same text produces
different DIDs.

### The phrase is 24 words, and the shell calls it a passphrase

The shell's login offers **"Login with Passphrase"** and a field reading
**"Enter your passphrase"**, and both take a **BIP-39 recovery phrase** —
`XLoginView` calls `Identity.fromMnemonic()`. Anything that is not a valid
BIP-39 phrase fails with `Invalid mnemonic`, so a passphrase in the ordinary
sense cannot be typed there at all, whatever the field says. The CLI equivalent
of that field is `cf id from-mnemonic`, not `cf id derive`.

**It must be 24 words.** A 12-word phrase is valid BIP-39 and still fails:
twelve words carry 128 bits of entropy and an Ed25519 signer seeds from 32
bytes. The failure surfaces from the Ed25519 dependency rather than from
anything in this repository, so its wording is not ours to promise — observed
on 2026-08-28 it was `expected Uint8Array of length 32, got length=16`, in the
browser console and identically from `cf id from-mnemonic`. What holds
regardless of the wording is the shape: a phrase that works in one works in
the other, and a 12-word phrase works in neither.

> Use `deno run -A packages/cli/mod.ts`, not `deno task cf`, when redirecting to
> a key file: the `deno task` wrapper prints colored preamble to stdout that
> would corrupt the key.

## Existing CLI Key To Browser

If the CLI key already exists, import it directly in the browser with
`Import CLI Key`. This works for keys generated by:

```bash
deno run -A packages/cli/mod.ts id new > .cf/shared-dev.key
# `id derive` also reads the passphrase from a file (`-- <file>`) or stdin
# (`-`), keeping it out of shell history (recommended for anything sensitive):
deno run -A packages/cli/mod.ts id derive -- passphrase.txt > .cf/shared-dev.key
```

The file must be a PKCS8/PEM private key. `*.key` and `.cf/` are gitignored in
this repository.

## Verify Before Debugging

Always compare DIDs before testing scoped behavior:

```bash
deno run -A packages/cli/mod.ts id did "$CF_IDENTITY"
```

In the browser, shell startup logs the active user DID under the
`shell.identity` logger. If those DIDs differ, `PerUser` fields, home-space
settings, favorites, and session-scoped state are expected to differ too.

## Agent Browser Workflow

Agents should import the same key into the browser session they control before
testing identity-sensitive behavior:

```bash
agent-browser --session cf-shared open http://localhost:8000/<space>/<piece>
agent-browser --session cf-shared snapshot -i
# Click Login, then Import CLI Key.
agent-browser --session cf-shared upload @<choose-file-ref> "$CF_IDENTITY"
agent-browser --session cf-shared click @<import-key-ref>
agent-browser --session cf-shared console
```

Check the console for:

```text
[Identity] User DID: did:key:...
```

That DID must match:

```bash
deno run -A packages/cli/mod.ts id did "$CF_IDENTITY"
```

Use distinct `agent-browser --session` names when comparing identities. Do not
infer the active identity from the session name, browser URL, or the key you
intended to upload; verify the `shell.identity` log every time. Reusing a browser
session can also reuse stored credentials, so a stale session can silently test
the wrong user.

Avoid creating a fresh browser identity during debugging unless the test
explicitly needs a second user.

## Visibility Model

Different identities do not hide an entire piece in the same space. They change
which scoped instances are addressed.

Expected results when the CLI and browser use different DIDs:

| Data kind | Different identity result |
| --- | --- |
| Unscoped or `PerSpace<T>` | Visible in the same space |
| `PerUser<T>` | Resolves to that user's own value, often default or missing |
| `PerSession<T>` | Resolves to that user's current session value, often default or missing |
| Home space data | Different, because home space DID equals user DID |

If the whole piece fails to load, do not blame identity mismatch first. Check the
space, slug or piece id, local server state, source errors, and authorization
path. If only personal fields, drafts, favorites, selected tabs, or home-space
settings look empty, check the active DID first.

## Scoped Visibility Smoke Test

Use this shape when a report says "the data disappeared":

1. Deploy or open a piece with unscoped or `PerSpace<T>` data and verify both
   identities can see it.
2. Write a `PerUser<T>` field as identity A.
3. Open the same piece as identity A and confirm the value is present.
4. Open the same piece as identity B and confirm shared data remains visible,
   but the `PerUser<T>` field is default or missing.

This proves the runtime is resolving scoped instances correctly and prevents
debugging a deliberate scope boundary as a storage loss.

## Scope Expectations

- `PerSpace<T>` and unscoped data should be shared by everyone in the same
  space.
- `PerUser<T>` data is per active user DID.
- `PerSession<T>` data is per active user DID and memory session.
- Home space data is keyed by the user DID because the home space DID equals the
  identity DID.

When CLI and browser identities differ, the failure mode is usually not
"storage is missing"; it is "the read is resolving a different scoped instance."
