---
status: historical
created: 2026-11-19
archived: 2026-11-19
reason: "Measurement of the currency index on a synthetic Topics board under a serving worker: what a view costs with the index off, recording, and leaving current pieces unstarted, what the index's own requests cost on the memory server's thread, and a browser check of an unstarted piece"
---

# What the currency index does for a view of a Topics board, November 2026

## Where this starts

The currency index
([the plan](../../../plans/stored-output-currency.md), stage 3) records, per
piece, what its computations read, what they write, and which stored outputs
they vouch for. In its `skip` mode a serving loop leaves unstarted a demanded
piece whose record proves every demanded output of it current. This record
measures what that saves for a new viewer of a Topics board, what the index
costs, and whether a browser client renders a piece the server left
unstarted. It was taken to decide whether `skip` is turned on.

## Method

`skills/perf-investigation/scripts/currency-worker-probe.ts` serves a fresh
board from a `ServingWorkerPool` over a file store, as a toolshed does, and
files N Topics through the board's `addTopic` stream with the index in
`record`. It then views the board four times. Each view is a new client
session over a new worker pool, as a restart leaves them, and the probe
removes the previous view's sessions first, so a view's demand is its own.
The views run, in order, in `record`, in `record` again, in `skip`, and with
no index. Nothing demands a Topic while the board is built, so the first view
is the one that records the Topics.

Two kinds of view were measured:

- **refs** resolves each Topic reference in the board's `topics` list and
  subscribes to it, as a card's link does.
- **index** reads the board's `index` under its schema, as `cf cell get`
  does.

A view ends when two wave cycles in a row leave the serving loop's counters
and the store's document count unchanged. Each view reports its wall time, the
serving loop's `currency` and demand counters, the documents it left in the
store, the main-thread time of the three currency requests the memory server
answered, and the worker's heap after a forced collection.

The board is synthetic: Topics with a title, a short body and an author, no
comments, no references between them. The machine was a four-core cloud
container with nothing else running during the runs reported here. The refs
view ran twice at each size, before and after the fix described under "What
the index holds", and the two runs agreed within about ten percent apart from
the time spent storing records; the tables give the second, taken at commit
`24e20e014` of the branch. The index view ran once at each size. The
production board was not measured.

## A view of every Topic

The **refs** view, by board size and mode:

| Topics | Mode           | Seconds | Roots judged servable | Pieces left unstarted | Documents written | Owned defaults seeded | Worker heap, MB |
| -----: | -------------- | ------: | --------------------: | --------------------: | ----------------: | --------------------: | --------------: |
|     50 | `record`       |    12.4 |               0 of 52 |                     0 |             1,002 |                    51 |             180 |
|     50 | `record` again |    11.9 |              51 of 52 |                     0 |               902 |                    51 |             179 |
|     50 | `skip`         |     0.8 |              51 of 52 |                    51 |                 0 |                     0 |              49 |
|     50 | no index       |    11.6 |                     — |                     0 |               902 |                    51 |             179 |
|    200 | `record`       |    72.1 |              0 of 202 |                     0 |             4,002 |                   201 |             491 |
|    200 | `record` again |    64.2 |            201 of 202 |                     0 |             3,602 |                   201 |             470 |
|    200 | `skip`         |     1.9 |            330 of 331 |                   201 |                 0 |                     0 |              51 |
|    200 | no index       |    70.4 |                     — |                     0 |             3,602 |                   201 |             471 |

The one root never judged servable is the probe's own poke document, which no
piece writes. In `skip` at 200 Topics the loop judged twice, which is why its
count of judged roots is higher.

With no index, a new viewer of 200 Topics waits 70 seconds, the store gains
3,602 session-scoped documents (18 for each Topic), and the worker holds
471 MB. In `skip` the same view takes 1.9 seconds, writes nothing, and leaves
the worker at 51 MB, which is what it holds when it starts no piece (48 to
50 MB in the index view below). The time with no index grows faster than the board does: 11.6 seconds
at 50 Topics and 70.4 at 200.

`record` costs nothing that these runs can see: 12.4 and 11.9 seconds against
11.6 at 50 Topics, and 72.1 and 64.2 against 70.4 at 200.

`currency.falseClean` stayed at zero in every run. The second `record` view is
the one that can find a false judgment, since it starts pieces the index holds
clean: 51 and 201 pieces were started that way and none wrote a vouched output
again.

## A view that reads no Topic

The **index** view reads one value the board's handlers maintain, and demands
no Topic:

| Topics | Mode           | Seconds | Roots judged servable | Documents written | Worker heap, MB |
| -----: | -------------- | ------: | --------------------: | ----------------: | --------------: |
|     50 | `record`       |     4.2 |                0 of 3 |                 2 |              78 |
|     50 | `record` again |     4.1 |                2 of 3 |                 2 |              78 |
|     50 | `skip`         |     0.8 |                2 of 3 |                 0 |              48 |
|     50 | no index       |     3.9 |                     — |                 2 |              78 |
|    200 | `record`       |     6.5 |                0 of 3 |                 2 |             113 |
|    200 | `record` again |     6.1 |                2 of 3 |                 2 |             113 |
|    200 | `skip`         |     1.4 |                2 of 3 |                 0 |              50 |
|    200 | no index       |     6.2 |                     — |                 2 |             113 |

With no index the board piece starts to serve a value no computation of it
writes. In `skip` it does not start.

## What the index holds and what its requests cost

After the refs view of 200 Topics the index holds 401 pieces (two for each
Topic and the board), 2,401 read rows, 16,021 write rows and 2,600 vouch rows:
about 80 write rows for each Topic.

Main-thread time on the memory server, refs view:

| Topics | Mode           | Store records | Judge roots  | Advance the cursor |
| -----: | -------------- | ------------- | ------------ | ------------------ |
|     50 | `record`       | 1 call, 92 ms | 1 call, 4 ms | —                  |
|     50 | `record` again | 1 call, 65 ms | 1 call, 7 ms | —                  |
|     50 | `skip`         | —             | 1 call, 6 ms | 3 calls, 0.7 ms    |
|    200 | `record`       | 4 calls, 589 ms | 2 calls, 13 ms | —              |
|    200 | `record` again | 4 calls, 322 ms | 2 calls, 43 ms | —              |
|    200 | `skip`         | —             | 2 calls, 50 ms | 6 calls, 1.2 ms  |

Storing a record takes 1.3 to 2.9 ms for a Topic's shape. Before this
measurement it took longer the more pieces the index held: three statements
that find the readers of a piece's writes, and the marked producers of its
reads, were planned from the wrong table and read every row of the branch.
The first run of the 200-Topic refs view spent 1,803 and 1,901 ms in its four
store calls. Commit `24e20e014` names the join order of those statements; the
table above is from after it.

A judgment's time follows the number of demand rows the space's sessions
hold, not the number of roots: the memory server looks up the owners of each
demanded document instance. Timed directly against an index of synthetic
records (40 write rows, 9 read rows and 7 vouch rows for each piece):

| Pieces | Demand rows | Judge every root | Judge one enclosing root | Store 64 records | Advance, nothing new | Advance after one commit |
| -----: | ----------: | ---------------: | -----------------------: | ---------------: | -------------------: | -----------------------: |
|    256 |       1,792 |            25 ms |                    24 ms |      30 to 48 ms |               0.2 ms |                   0.5 ms |
|  6,528 |      45,696 |           715 ms |             584 to 720 ms |      27 to 43 ms |               0.4 ms |                   0.6 ms |

That is about 15 µs for each demand row. 6,528 pieces is the index of a board
of 3,264 Topics, and 45,696 rows is a session that demands every one of them.
A judgment runs when a session's demand changes while roots are left
unstarted, so a space whose sessions hold tens of thousands of demand rows
pays several hundred milliseconds on the memory server's thread at each such
change. Nothing here measured how many rows a real viewer of the production
board holds.

## A browser client and an unstarted piece

The probe's clients are Deno runtimes. A browser client replicates by view
(`viewScopedReplication`, on by default for a web client under server
execution), and a view plan names no producers for a piece that is not
started. To see what that client does, a counter (`patterns/examples/counter`)
was deployed to a local toolshed running `skip` with a fixed
`SERVER_EXECUTION_CURRENCY_EPOCH`, opened in the shell with headless Chromium,
and clicked. The toolshed was then restarted, and the piece opened in a new
browser:

- The page rendered the stored value ("Counter is the 5th number").
- The memory server judged the counter's root, and the roots of its argument
  and internal documents that lead to it, servable. The space's commit head
  was 28 before the view and 28 after, and the store gained no document.
- A click on the increment button started the piece and the page showed the
  next value.

The space's default-app root was refused every time: it records a source
origin, and a piece that does is always started.

## What this does not show

- The production Topics board, with comments, references and 3,264 Topics.
- A deployed space, or any run longer than a view.
- A piece whose output depends on something that is not a read, such as a
  clock. Such a piece would be held clean while what it would compute moves.
- The case where a producer of a demanded piece is stale and not demanded
  (stage 5 of the plan). A demanded piece whose producer is marked is started,
  and reads what that producer last wrote, as it does with no index.

## What was decided

The toolshed runs `skip` unless `SERVER_EXECUTION_CURRENCY_INDEX` says
otherwise, under the epoch of its build. The judgment's cost for each demand
row is the open item for a space whose sessions demand tens of thousands of
document instances.
