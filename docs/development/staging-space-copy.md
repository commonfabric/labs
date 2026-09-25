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

- **A named space derives the same DID everywhere**, from its name alone
  (`deriveSpaceDid` in `packages/state-inspector/discover.ts`). Open the same
  name on rapids and you reach the copy. This is what makes the copy usable
  without anyone typing a DID.
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
`packages/toolshed/routes/storage/memory-path.ts` and `resolveSpaceStoreUrl` in
`packages/memory/v2/storage-path.ts` — and each appends `engine-v3`, so in
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
(`packages/toolshed/routes/storage/memory.ts` passes it as `store`), so the
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
sha256sum /tmp/<did>.sqlite      # same digest as step 1, or stop here

# 5. Stop everything that can hold the store open, or write through it.
for p in $(seq 8001 8021); do sudo systemctl stop toolshed-binary@$p; done

# 6. Move any existing file for that DID ASIDE — never delete it, and take its
#    -wal and -shm companions with it. The engine runs in WAL mode, and a stale
#    write-ahead log left beside a replaced database is recovered onto the file
#    you just installed. List before you move: nothing listed means there is
#    nothing to set aside, and the move is skipped rather than silenced.
cd <store>/engine-v3/engine-v3/
ls -la '<did>.sqlite'*
sudo install -d -o deploy -g deploy /data/replaced
sudo mv '<did>.sqlite'* /data/replaced/

# 7. Install the copy, owned by the user the services run as.
sudo install -o deploy -g deploy -m 644 /tmp/<did>.sqlite '<did>.sqlite'

# 8. Start the servers, and confirm they came up.
for p in $(seq 8001 8021); do sudo systemctl start toolshed-binary@$p; done
for p in $(seq 8001 8021); do systemctl is-active toolshed-binary@$p; done
```

Steps 5 through 8 are one continuous window in which staging is down. Have the
file on the host and its checksum checked before you begin it.

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
reasons that have nothing to do with whether the transfer was clean. Step 4 is
where that question gets settled.

## What a staging copy shows, and what it does not

It adds, over a local clone: the deployed binary and the shell it serves, the
sharded server under nginx, the tailnet, real browsers, and other people using
the space at the same time as you.

It still does not show:

- **Production's commit.** Rapids runs main on every push; the production host
  runs whatever ref was last dispatched to it. A copy from production is being
  served by a *different* build than the one that produced it — usually the
  point, and always worth stating when reporting what the copy showed.
- **Production's configuration.** The vaulted env differs per host, and a
  behavior that turns on a flag is a property of the host, not of the data.
- **Cross-space links.** A memory server creates space stores on demand, so a
  link into a space you did not copy resolves to a silently manufactured empty
  one rather than to an error. A space with cross-space reads looks *cleaner* on
  a copy than it does at home. Copy those spaces too, or discount what you see.

## Removing the copy

A staging copy is real content on a shared host, so it comes down when the
question that justified it has been answered. Removal is steps 5 to 8 in
reverse: stop the instances, move the copy out of the store directory with its
`-wal` and `-shm` companions, move back whatever step 6 set aside, start
everything. If nothing was set aside, leaving the space absent is the correct
end state — the server will create an empty one if anyone asks for it again.

Write the rollback down before step 5, not after: the path step 6 moved things
to, and the commands that put them back.
