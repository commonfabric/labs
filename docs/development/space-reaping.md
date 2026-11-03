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
[the compaction procedure](space-compaction.md)'s rails, and this is that
procedure's host run with the reap in place of the compaction:

- it runs only once every instance has stopped, against a copy of the backup
  taken after the stop, never the backup and never a served file;
- the tool checks its result against the store it read before reporting, and
  removes a result that fails;
- the swap moves the live file aside, never deletes it, and rolling back is the
  compaction procedure's rollback.

Reap only a space that is deleted, which the tool checks, and only once its
owner no longer needs the history the backup keeps. The backup is the archive
of everything the reap removes; keeping it is the space owner's decision.

## The host run

```bash
# 0. The space is deleted: the dry run refuses any other store. Read the
#    report, and note the cell databases it names beside the live store.
#    It refuses when another space's store there has cell databases under
#    the same prefix, which is a 32-bit hash of the DID: then the files
#    under it cannot be told apart, and step 4 leaves every cell database
#    in place.
sqlite3 -readonly '/data/memory/engine-v3/engine-v3/<did>.sqlite' \
  "VACUUM INTO '/data/replaced/<did>.dry-run-<date>.sqlite'"
cf space reap '/data/replaced/<did>.dry-run-<date>.sqlite' --dry-run \
  --live '/data/memory/engine-v3/engine-v3/<did>.sqlite'

# 1. Stop every instance. (sudo.) Nothing writes any space from here on.
for p in $(seq 8001 8021); do sudo systemctl stop toolshed-binary@$p; done

# 2. The authoritative backup, AFTER the stop, checksummed: the rollback, the
#    archive, and the source.
sqlite3 -readonly '/data/memory/engine-v3/engine-v3/<did>.sqlite' \
  "VACUUM INTO '/data/replaced/<did>.pre-reap-<date>.sqlite'"
sha256sum '/data/replaced/<did>.pre-reap-<date>.sqlite'

# 3. Reap a COPY of the backup into a fresh result. The command checks the
#    result against the copy and exits nonzero, leaving no result, when a
#    check fails. Go on to the swap only when it exits 0: the swap moves the
#    live store aside before installing the result, and a server finding no
#    store gives the DID a fresh space.
cp '/data/replaced/<did>.pre-reap-<date>.sqlite' '/data/replaced/<did>.work.sqlite'
if cf space reap '/data/replaced/<did>.work.sqlite' \
  --out '/data/replaced/<did>.reaped.sqlite'; then
  echo 'reaped; go on to step 4'
else
  echo 'the reap failed; stop here, with every instance stopped'
fi
rm '/data/replaced/<did>.work.sqlite'

# 4. Swap, as the compaction procedure's step 6 does, and move the space's
#    cell databases aside too: the report names their prefix,
#    cell-<hash>-, and a reap of a copy cannot reach them. (sudo.) Leave
#    the pattern out of the mv when step 0 named no cell file, or refused
#    because another space shares the prefix.
cd /data/memory/engine-v3/engine-v3/
ls -la '<did>.sqlite'* 'cell-<hash>-'*.sqlite
sudo mv '<did>.sqlite'* 'cell-<hash>-'*.sqlite /data/replaced/
sudo install -o deploy -g deploy -m 644 '/data/replaced/<did>.reaped.sqlite' '<did>.sqlite'

# 5. Start them all, and confirm the space reads as deleted. (sudo.)
for p in $(seq 8001 8021); do sudo systemctl start toolshed-binary@$p; done
for p in $(seq 8001 8021); do systemctl is-active toolshed-binary@$p; done
cf inspect summary '/data/memory/engine-v3/engine-v3/<did>.sqlite'
```

The summary's `deleted:` line names who deleted the space and the deletion
commit's seq. Opening the space refuses with the deleted `AuthorizationError`,
carrying the same `aclRevision` as before the reap.

## Rolling back

Rolling back is
[the compaction procedure's rollback](space-compaction.md#rolling-back): stop
every instance, move the result out with its companions, and move the original
and the cell databases back from `/data/replaced/`.
