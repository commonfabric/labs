# Reaping a deleted space's store on a host

A **reap** reclaims a deleted space's storage. It reduces the space's SQLite
store to the deletion commit and what that commit needs to stand: the commit's
row, the invocation and authorization rows it references, the deletion
tombstone's revision and head rows, and the default branch's row. The space
goes on refusing every principal as deleted, under the same `aclRevision`, and
its DID never again has no history.
[Reaping a deleted space](../specs/random-space-identities.md#reaping-a-deleted-space)
is the specification, and the tool is `cf space reap`, described in
[the CLI README](../../runtime/cli/README.md#reaping-a-deleted-spaces-store).

A reap keeps
[the compaction procedure](space-compaction.md)'s rails, and its host run
follows that procedure's, with the reap in place of the compaction:

- it runs only once every instance has stopped, against a copy of the backup
  taken after the stop, never the backup and never a served file;
- the tool checks its result against the store it read before reporting, and
  removes a result that fails;
- the live directory always holds a store for the space: the swap keeps a copy
  of the live file, then renames the result over it in one step, since a
  server that finds no store gives the DID a fresh space, and history with it.

Reap only a space that is deleted, which the tool checks, and only once its
owner no longer needs the history the backup keeps. The backup is the archive
of everything the reap removes; keeping it is the space owner's decision.

## The host run

The run is one script. It stops at the first command that fails, so no step
runs on the strength of one that did not finish. Set the four names at its top
first: the space's DID, a date for the file names, the live directory, and the
directory that receives what the swap replaces, which has to be on the live
directory's file system for the copy to be quick.

```bash
set -euo pipefail
DID='<did>'
DATE='<date>'
LIVE=/data/memory/engine-v3/engine-v3
REPLACED=/data/replaced
cd "$LIVE"

# 0. The space is deleted: the dry run refuses any other store. Read the
#    report, and the cell databases it names beside the live store. It reads
#    the live store read-only, through the instances' own coordination when
#    one has it open, and writes nothing.
cf space reap "$LIVE/$DID.sqlite" --dry-run --live "$LIVE/$DID.sqlite"

# 1. Stop every instance. Nothing writes any space from here on. A log
#    beside the store that is not empty holds what an instance did not write
#    back, so it stops the run; an empty one goes, and so does the `-shm`
#    index, which holds no writes. Every instance has to report itself
#    inactive before anything is read.
for p in $(seq 8001 8021); do sudo systemctl stop "toolshed-binary@$p"; done
for p in $(seq 8001 8021); do
  state=$(systemctl is-active "toolshed-binary@$p" || true)
  if [ "$state" != inactive ]; then
    echo "toolshed-binary@$p is ${state:-unknown}, not inactive: stop here" >&2
    exit 1
  fi
done
for log in -wal -journal; do
  if [ -s "$DID.sqlite$log" ]; then
    echo "$DID.sqlite$log is not empty: stop here" >&2
    exit 1
  fi
done
sudo rm -f "$DID.sqlite-wal" "$DID.sqlite-shm" "$DID.sqlite-journal"

# 2. The authoritative backup, AFTER the stop, checksummed: the rollback, the
#    archive, and the source. Read as immutable: nothing writes the file now,
#    and no log beside it holds anything.
# SQLite decodes `%HH` in a URI's path and ends the path at `?` or `#`, so
# those three are escaped in the store's path.
STORE_URI="file:$(printf '%s' "$LIVE/$DID.sqlite" |
  sed -e 's/%/%25/g' -e 's/?/%3F/g' -e 's/#/%23/g')"
sqlite3 "$STORE_URI?immutable=1" \
  "VACUUM INTO '$REPLACED/$DID.pre-reap-$DATE.sqlite'"
sha256sum "$REPLACED/$DID.pre-reap-$DATE.sqlite"

# 3. Reap a COPY of the backup into a fresh result. The command checks the
#    result against the copy and exits nonzero, leaving no result, when a
#    check fails, which ends the script here.
cp "$REPLACED/$DID.pre-reap-$DATE.sqlite" "$REPLACED/$DID.work.sqlite"
cf space reap "$REPLACED/$DID.work.sqlite" \
  --out "$REPLACED/$DID.reaped.sqlite"
rm -f "$REPLACED/$DID.work.sqlite" "$REPLACED/$DID.work.sqlite-wal" \
  "$REPLACED/$DID.work.sqlite-shm"

# 4. Swap. First the cell databases, which a reap of a copy cannot reach:
#    the check lists, from the live directory as it stands, the files under
#    the space's prefix, a 32-bit hash of the DID. When another store there
#    shares the prefix, which are whose cannot be told by name, so the list
#    is empty and the check names that store. A check that fails ends the
#    script here, before anything moves. Then the live file is copied aside,
#    never deleted, the result is renamed over it, so the directory holds a
#    store throughout, and the listed cell databases are moved aside.
cf space reap "$REPLACED/$DID.pre-reap-$DATE.sqlite" --dry-run \
  --live "$LIVE/$DID.sqlite" --json >"$REPLACED/$DID.plan-$DATE.json"
jq -r '.sharedWith[] | "cell databases left in place: the prefix is shared with " + .' \
  "$REPLACED/$DID.plan-$DATE.json" >&2
jq -r '.cellDatabases[]' "$REPLACED/$DID.plan-$DATE.json" \
  >"$REPLACED/$DID.cells-$DATE.txt"
sudo cp -p "$DID.sqlite" "$REPLACED/$DID.live-$DATE.sqlite"
sudo install -o deploy -g deploy -m 644 "$REPLACED/$DID.reaped.sqlite" \
  "$DID.sqlite.reaped"
sudo mv -f "$DID.sqlite.reaped" "$DID.sqlite"
while read -r cell; do
  sudo mv -- "$cell" "$REPLACED/"
done <"$REPLACED/$DID.cells-$DATE.txt"

# 5. Start them all, and confirm the space reads as deleted.
for p in $(seq 8001 8021); do sudo systemctl start "toolshed-binary@$p"; done
for p in $(seq 8001 8021); do systemctl is-active "toolshed-binary@$p"; done
cf inspect summary "$LIVE/$DID.sqlite"
```

The summary's `deleted:` line names who deleted the space and the deletion
commit's seq. Opening the space refuses with the deleted `AuthorizationError`,
carrying the same `aclRevision` as before the reap.

## Rolling back

Rolling back is the swap in reverse, and like
[the compaction procedure's rollback](space-compaction.md#rolling-back) it
begins with the stop: once step 5 has run, every instance may have the result
open. With the same four names set:

```bash
set -euo pipefail
cd "$LIVE"
# Stop every instance, and stop here unless each reports itself inactive:
# nothing moves while an instance may still have the result open.
for p in $(seq 8001 8021); do sudo systemctl stop "toolshed-binary@$p"; done
for p in $(seq 8001 8021); do
  state=$(systemctl is-active "toolshed-binary@$p" || true)
  if [ "$state" != inactive ]; then
    echo "toolshed-binary@$p is ${state:-unknown}, not inactive: stop here" >&2
    exit 1
  fi
done
sudo rm -f "$DID.sqlite-wal" "$DID.sqlite-shm" "$DID.sqlite-journal"
sudo cp -p "$REPLACED/$DID.live-$DATE.sqlite" "$DID.sqlite.restored"
sudo mv -f "$DID.sqlite.restored" "$DID.sqlite"
while read -r cell; do
  sudo mv -- "$REPLACED/$cell" "$LIVE/"
done <"$REPLACED/$DID.cells-$DATE.txt"
for p in $(seq 8001 8021); do sudo systemctl start "toolshed-binary@$p"; done
```

The companions removed belong to the reaped result, which holds nothing the
copy of the live file lacks.
