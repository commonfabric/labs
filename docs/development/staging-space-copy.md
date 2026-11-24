# Serving a copy of a space on staging

A **staging copy** is one space's SQLite store, snapshotted from the host that
serves it and installed on rapids, so that real content can be exercised against
the deployed staging system. This document is the procedure, and the decisions
that have to be made before it starts.

Two neighbors, so the reader lands in the right one:

- [`space-clone-rehearsal.md`](space-clone-rehearsal.md) makes a writable copy
  on your own machine. It is the cheaper tool and the one to reach for first.
- [`deploying.md`](deploying.md) is how a commit reaches a host. A staging copy
  moves data and nothing else; it does not change which binary rapids runs, and
  a deploy does not disturb a copy already installed.

Nothing automates this. `cf space` builds and judges local clones, and the only
remote store surface a server offers is the dump endpoint, which reads. A copy
onto a host is therefore an operator placing a file, which is why the traps
below are worth reading before the file moves.

## Reach for the local clone first

The clone answers most of the questions a copy gets built for — did content
survive an update, what did a migration rewrite, how long did the write storm
run — offline, resettable, and without anyone else's work in the blast radius.

A staging copy earns its cost only when the question is about the *deployment*:
the shell bundle the staging site serves, the sharded server, several browsers
at once, concurrent human traffic, the tailnet. A laptop clone shows none of
those, and every question that is not one of them is cheaper somewhere else.

## What installing a copy commits you to

Four things, none of which the procedure can decide for you:

- **A copy of a space is the whole of its contents.** Moving one onto a shared
  host is a confidentiality decision, and it belongs to whoever owns that
  content.
- **Rapids serves the dump endpoint** — it is staging, and the flag is on
  there — and its allowlist gates the *caller*, not the space: any identity in
  `MEMORY_DUMP_DIDS ∪ MEMORY_SERVICE_DIDS` can download any space on the host,
  the copy included.
- **Access control travels inside the file.** A space's ACL is a document in
  that space, so the copy grants the same principals the same capabilities it
  granted on the source host. `MEMORY_ACL_MODE` decides whether they are
  enforced; the shipped default is `enforce`.
- **Installing the copy restarts every toolshed instance on rapids**, which
  interrupts everyone else using staging. Say so before you do it.

## The copy keeps the source DID

There is no rename. A space's id is the subject of every invocation the store
has recorded, and the authorizations beside them are signed over those
invocations — so a store served under a different id would carry a history
naming an id nobody served. Both the local clone and the staging copy keep the
source DID for that reason.

Two consequences worth holding on to:

- **A legacy space name resolves to the same DID everywhere**, from the name
  alone (`legacySpaceDid` in `base/identity/src/legacy-space.ts`, which
  `resolveSpace` in `runtime/state-inspector/discover.ts` uses for a name).
  Open the same name on rapids and you reach the copy. This is what makes the
  copy of a legacy space usable without anyone typing a DID. A space created
  with a random DID has no name that resolves to it, so its copy is opened by
  that DID.
- **Two hosts now answer for one space id, with content that diverges from the
  moment anything writes.** The api-url is the only thing that tells them
  apart, so pin it explicitly in every command that touches either. A copy is
  not a mirror, and content never travels back the way it came.

## The host

Rapids runs the same configuration as the other toolshed hosts, and the parts
that matter here are:

- **21 server instances**, `toolshed-binary@8001` through
  `toolshed-binary@8021` — one systemd template unit, one instance per port,
  all reading the store the service env names. The instance count and port base
  are `toolshed_instances` and `toolshed_ports_start` in the infra repository's
  `ansible/vars/toolshed-binary.yml`.
- **nginx shards memory requests** across sixteen of those instances by the last
  character of the request URI, so one space is normally served by one instance.
  That is a property of the URL rather than of the store: every instance can
  open every file, so treat the store as shared by all 21 and restart all 21.
- **The service env is `/opt/cf/releases/.env`**, deployed vaulted by ansible
  and read by every instance. `MEMORY_DIR` (or `DB_PATH`) is in it. Read the
  value on the host rather than assuming one; provisioning creates `/data` from
  the attached data disk and `/data/memory` under it, which is what you should
  expect to find.
- **SSH is `deploy@rapids.saga-castor.ts.net`** over the tailnet, with team keys
  deployed by the `toolshed-ssh` role. That user runs the services and has
  passwordless sudo.

### Where the file goes

The store location the env names is not the directory the per-space files live
in. A server composes the realized path from two functions —
`resolveMemoryEngineStoreRootUrl` in
`runtime/toolshed/routes/storage/memory-path.ts` and `resolveSpaceStoreUrl` in
`runtime/memory/v2/storage-path.ts` — and each appends `engine-v3`, so in
directory mode the file is:

```
<MEMORY_DIR>/engine-v3/engine-v3/<did>.sqlite
```

The doubling is real and every existing store depends on it. Single-file mode
(`DB_PATH`) composes the same two functions to a different shape: one directory
beside the database file rather than a nested pair, and the doubling lands in
that directory's name. `DB_PATH=/data/cf.sqlite` puts the per-space files in
`/data/cf..engine-v3/` — two dots — holding filenames that keep their
percent-encoding rather than reading as literal DIDs.

Reading either function on its own gives a different answer than the server
gets. The server is constructed with the root the first one returns
(`runtime/toolshed/routes/storage/memory.ts` passes it as `store`), so the
second composes on `<stem>.engine-v3/` rather than on `DB_PATH`, which is where
the second dot comes from. Check the composition, not the parts.

Do not compose either path from memory. **List the store directory on the host
and put your file beside the space files already there** — the neighbors are
the authority on both the directory and the filename encoding, and they cost
one `ls` to consult.

## The procedure

Steps 1 and 2 are the local rehearsal, and they are not optional: a staging copy
is far more expensive to iterate on than a clone, and every failure the clone
catches is one you do not debug on a shared host.

```bash
# 1. Snapshot the source space, on the host that serves it. VACUUM INTO never
#    mutates the source and emits one consistent file with no -wal/-shm
#    companions. Copy it down and record its checksum.
sqlite3 <store>/engine-v3/engine-v3/<did>.sqlite "VACUUM INTO '/tmp/<did>.sqlite'"
sha256sum /tmp/<did>.sqlite
```

Two notes, both specific to estuary:

- `<store>` is currently `/data/memory` there.
- `/tmp` does not have room for a new snapshot (as of 2026-08-31), so put them
  into that same `/data/memory` directory for now and clean them up as you go.
  Substitute that path for `/tmp` everywhere above — the `VACUUM INTO` target,
  the checksum, and the source of the copy down. The `/tmp` in step 3 is your
  own machine's and stays as it is.

**2. Rehearse it locally first**, following
[`space-clone-rehearsal.md`](space-clone-rehearsal.md): clone, serve, run
whatever the copy exists to exercise, and check that the acceptance checks for
this specific space pass. Fingerprint the snapshot while you have it locally
(`cf space fingerprint <snapshot>`), so that "did the right file arrive" is a
question with an answer.

```bash
# 3. Copy it up. The tailnet is the perimeter; there is no host-to-host hop.
scp /tmp/<did>.sqlite deploy@rapids.saga-castor.ts.net:/tmp/

# 4. On rapids: find the store, and look at what is already there.
grep -E '^(MEMORY_DIR|DB_PATH)=' /opt/cf/releases/.env
ls -la <store>/engine-v3/engine-v3/
```

Steps 5 through 8 are one continuous window in which staging is down, and they
are one script on rapids. It stops at the first command that fails, so no step
runs on the strength of one that did not finish, and it checks the copy's
checksum before it stops anything. Set the names at its top first: the space's
DID, the file step 3 copied up, step 1's digest, the directory step 4 listed,
a date for the file names, and the directory that receives what the install
replaces, which has to be on the store's file system for the copy to be quick. The store's file name is derived from the DID and the directory, as the
memory server derives it, rather than typed. The run prints an id, the date
and a random suffix, which names what it keeps; the way back takes it.

```bash
set -euo pipefail
DID='<did>'
COPY='/tmp/<did>.sqlite'
DIGEST='<the digest step 1 printed>'
LIVE='<store>/engine-v3/engine-v3'
DATE='<date>'
REPLACED=/data/replaced
cd "$LIVE"

# The store's file name is the memory server's for the DID
# (`resolveSpaceStoreUrl` in `runtime/memory/v2/storage-path.ts`), and the
# directory's own name says which: in directory mode, whose directory is
# .../engine-v3/engine-v3, the DID itself; in single-file mode, whose
# directory is <stem>.engine-v3, the DID as `encodeURIComponent` encodes it.
# A store under the other spelling means the names above are wrong.
uri_component() {
  local LC_ALL=C s=$1 i c
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in
      [A-Za-z0-9_.!~*\'\(\)-]) printf '%s' "$c" ;;
      *) printf '%%%02X' $(($(printf '%d' "'$c") & 255)) ;;
    esac
  done
}
encoded="$(uri_component "$DID").sqlite"
case "$(basename "$LIVE")" in
  engine-v3) STORE="$DID.sqlite" OTHER=$encoded ;;
  *.engine-v3) STORE=$encoded OTHER="$DID.sqlite" ;;
  *)
    echo "$LIVE is not a store directory: stop here" >&2
    exit 1
    ;;
esac
if [ "$OTHER" != "$STORE" ] && [ -e "$OTHER" ]; then
  echo "$LIVE holds $OTHER, not $STORE: stop here" >&2
  exit 1
fi
# The run's id names what it keeps in $REPLACED: the date and a random
# suffix, so a second run on the same day keeps its own. Note it down; the
# way back needs it.
RUN="$DATE-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
echo "run id: $RUN"

# The copy that arrived is the one step 1 made, or nothing else runs.
if [ "$(sha256sum "$COPY" | cut -d' ' -f1)" != "$DIGEST" ]; then
  echo "$COPY does not have step 1's digest: stop here" >&2
  exit 1
fi

# 5. Stop everything that can hold the store open, or write through it, and
#    stop here unless every instance reports itself inactive.
for p in $(seq 8001 8021); do sudo systemctl stop "toolshed-binary@$p"; done
for p in $(seq 8001 8021); do
  state=$(systemctl is-active "toolshed-binary@$p" || true)
  if [ "$state" != inactive ]; then
    echo "toolshed-binary@$p is ${state:-unknown}, not inactive: stop here" >&2
    exit 1
  fi
done

# 6. Set aside any existing store for the DID: never delete it. The engine
#    runs in WAL mode, and a stale log left beside a replaced database is
#    recovered onto the file installed over it, so a log that is not empty
#    stops the run (it holds what an instance did not write back), and the
#    empty ones and the -shm index go. The store itself is copied aside, and
#    stays in place until the install renames the copy over it, so the
#    directory never lacks a store for the DID.
for log in -wal -journal; do
  if [ -s "$STORE$log" ]; then
    echo "$STORE$log is not empty: stop here" >&2
    exit 1
  fi
done
sudo rm -f "$STORE-wal" "$STORE-shm" "$STORE-journal"
sudo install -d -o deploy -g deploy "$REPLACED"
if [ -e "$STORE" ]; then
  if [ -e "$REPLACED/$DID.staging-$RUN.sqlite" ]; then
    echo "$REPLACED/$DID.staging-$RUN.sqlite exists: stop here" >&2
    exit 1
  fi
  sudo cp -p "$STORE" "$REPLACED/$DID.staging-$RUN.sqlite"
fi

# 7. Install the copy, owned by the user the services run as, under a
#    temporary name, and rename it over the store.
sudo install -o deploy -g deploy -m 644 "$COPY" "$STORE.copy"
sudo mv -f "$STORE.copy" "$STORE"

# 8. Start the servers, and confirm they came up.
for p in $(seq 8001 8021); do sudo systemctl start "toolshed-binary@$p"; done
for p in $(seq 8001 8021); do systemctl is-active "toolshed-binary@$p"; done
```

Have the file on the host before the window begins.

## Confirming the copy is the one being served

Two checks, in this order, because they fail differently:

```bash
# The server can see it, and it is the size you installed. A space the server
# cannot find is simply absent from this list — it does not error. This needs
# a caller on the dump allowlist; without one, skip to the read-back below,
# which needs nothing special.
deno task cf inspect spaces --remote https://rapids.saga-castor.ts.net
```

Then read the content back through the API, pinned to rapids — the pieces you
expect, the counts you expect, and two or three bodies in full. A space in the
list proves the file landed where the server looks. Only a read proves it is the
space you meant to install.

Do not checksum the installed file after the services start. The server opens
it, migrates what it migrates, and writes a WAL beside it; the digest moves for
reasons that have nothing to do with whether the transfer was clean. The
digest check at the top of the window is where that question gets settled.

## What a staging copy shows, and what it does not

It adds, over a local clone: the deployed binary and the shell it serves, the
sharded server under nginx, the tailnet, real browsers, and other people using
the space at the same time as you.

It still does not show:

- **Production's commit.** Rapids runs a coordinated candidate of verified
  green `main` revisions; the production host runs whatever ref was last
  dispatched to it. See [coordinated Rapids releases](deploying.md#coordinated-rapids-releases).
  A copy from production can be served by a *different* build than the one that
  produced it. Record both commits when reporting what the copy showed.
- **Production's configuration.** The vaulted env differs per host, and a
  behavior that turns on a flag is a property of the host, not of the data.
- **Cross-space links.** A memory server creates space stores on demand, so a
  link into a space you did not copy resolves to a silently manufactured empty
  one rather than to an error. A space with cross-space reads looks *cleaner* on
  a copy than it does at home. Copy those spaces too, or discount what you see.

## Removing the copy

A staging copy is real content on a shared host, so it comes down when the
question that justified it has been answered. Removal is the window in reverse,
and it begins with the stop: every instance may have the copy open, and by then
the copy has companions of its own, which go with it so that none is recovered
onto the store put back. The store step 6 set aside, if there was one, is
copied back and renamed over the copy, so the directory never lacks a store
for the DID. If nothing was set aside, leaving the space absent is the correct
end state — the server will create an empty one if anyone asks for it again.
Write these commands down before step 5, not after. With the same names set,
and the run id the window printed:

```bash
set -euo pipefail
RUN='<the run id the run printed>'
cd "$LIVE"

# The store's file name is the memory server's for the DID
# (`resolveSpaceStoreUrl` in `runtime/memory/v2/storage-path.ts`), and the
# directory's own name says which: in directory mode, whose directory is
# .../engine-v3/engine-v3, the DID itself; in single-file mode, whose
# directory is <stem>.engine-v3, the DID as `encodeURIComponent` encodes it.
# A store under the other spelling means the names above are wrong.
uri_component() {
  local LC_ALL=C s=$1 i c
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in
      [A-Za-z0-9_.!~*\'\(\)-]) printf '%s' "$c" ;;
      *) printf '%%%02X' $(($(printf '%d' "'$c") & 255)) ;;
    esac
  done
}
encoded="$(uri_component "$DID").sqlite"
case "$(basename "$LIVE")" in
  engine-v3) STORE="$DID.sqlite" OTHER=$encoded ;;
  *.engine-v3) STORE=$encoded OTHER="$DID.sqlite" ;;
  *)
    echo "$LIVE is not a store directory: stop here" >&2
    exit 1
    ;;
esac
if [ "$OTHER" != "$STORE" ] && [ -e "$OTHER" ]; then
  echo "$LIVE holds $OTHER, not $STORE: stop here" >&2
  exit 1
fi
for p in $(seq 8001 8021); do sudo systemctl stop "toolshed-binary@$p"; done
for p in $(seq 8001 8021); do
  state=$(systemctl is-active "toolshed-binary@$p" || true)
  if [ "$state" != inactive ]; then
    echo "toolshed-binary@$p is ${state:-unknown}, not inactive: stop here" >&2
    exit 1
  fi
done

# Keep the copy, with the companions it grew, out of the store directory.
sudo install -d -o deploy -g deploy "$REPLACED/removed-copy-$RUN"
for companion in -wal -shm -journal; do
  if [ -e "$STORE$companion" ]; then
    sudo mv "$STORE$companion" "$REPLACED/removed-copy-$RUN/"
  fi
done
if [ -e "$REPLACED/$DID.staging-$RUN.sqlite" ]; then
  sudo cp -p "$STORE" "$REPLACED/removed-copy-$RUN/$STORE"
  sudo cp -p "$REPLACED/$DID.staging-$RUN.sqlite" "$STORE.restored"
  sudo mv -f "$STORE.restored" "$STORE"
else
  sudo mv "$STORE" "$REPLACED/removed-copy-$RUN/"
fi

for p in $(seq 8001 8021); do sudo systemctl start "toolshed-binary@$p"; done
for p in $(seq 8001 8021); do systemctl is-active "toolshed-binary@$p"; done
```
