---
status: historical
created: 2026-09-28
archived: 2026-09-28
reason: "Measurements behind reading a test's cost as one percentile of its whole cost window, stored as per-day bucket counts."
---

# Reading a test's cost over its whole window

Measured on 2026-09-28 against labs `9d206e3faa`. Two questions were
settled here. The first was which stored form of a day's durations lets the
test-selection publisher read a test's cost as the ninetieth percentile of
every passing execution in the seven-day cost window, exactly or erring
only high. The second was whether the less padded costs that reading gives
would pack pull-request lanes past their bound.

Before this change, a test's cost was the largest of the per-day ninetieth
percentiles in the window. Each day stored its 64 slowest passing
durations and a count of all of them.

## Sources

- **Durations.** Every passing execution recorded by a
  continuous-integration runner on 2026-09-14 to 2026-09-21. These were
  read from the store's daily rollups through `readReport()` in
  `tasks/test-selection/build.ts`, the publisher's own reader. That comes
  to 49,479,139 executions of 38,710 test identities. The window was taken
  as it stood on 2026-09-21, the last day the rollups covered on
  2026-09-28.
- **Stored state.** The publisher's aggregate written at
  2026-09-28T16:32Z. It holds 56,067 identities and 336,410 stored days.
- **Lanes.** The 477 lane reports from five-lane pull-request runs, and the
  2,252 from 30-lane full runs, submitted on 2026-09-22 to 2026-09-27. They
  were read against the calibration in the manifest published at
  2026-09-28T16:32Z.

## How much a day keeps now

In the stored state, a stored day's execution count has a median of 215, a
ninetieth percentile of 310, and a maximum of 1,070. 57% of stored days
held more than 64 executions and had dropped some. The stored days take
59.0 MB of the aggregate's 170 MB of JSON.

## Stored forms against the exact percentile

Each form below was read for every identity over the eight days of the
window. It was compared with the nearest-rank ninetieth percentile of all
that identity's executions. The ratio columns are the reading divided by
the exact value, taken across identities. "Sum" is the total of all
identities' readings over the total of the exact values. "Size" is the
JSON of each identity's stored days, day keys included, summed over all
identities.

| Form | Exact | Low | High | 99th pct ratio | Max ratio | Sum | Size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Largest per-day percentile, 64 kept | 23,610 | 0 | 15,100 | 2.000 | 21.10 | 1.088 | 50.9 MB |
| Union of 64 kept, dropped runs ignored | 36,584 | 2,126 | 0 | 1.000 | 1.00 | 0.982 | 50.9 MB |
| Union of 64 kept, dropped runs at the least kept | 36,127 | 0 | 2,583 | 1.273 | 12.00 | 1.016 | 50.9 MB |
| Same, 128 kept | 38,458 | 0 | 252 | 1.000 | 10.00 | 1.002 | 85.4 MB |
| Same, 256 kept | 38,710 | 0 | 0 | 1.000 | 1.00 | 1.000 | 135.6 MB |
| Bucket counts, 16 per doubling | 16,044 | 0 | 22,666 | 1.042 | 1.04 | 1.022 | 22.0 MB |
| Bucket counts, 32 per doubling | 16,044 | 0 | 22,666 | 1.021 | 1.02 | 1.011 | 31.5 MB |
| Bucket counts, 64 per doubling | 16,044 | 0 | 22,666 | 1.011 | 1.01 | 1.006 | 50.3 MB |

The reading being replaced is above the exact value for 39% of
identities. For one identity in a hundred it is at least twice the exact
value.

Taking the union of what each day kept, and ignoring what it dropped,
reads low for 5.5% of identities. Counting each dropped run at the least
duration its day kept errs only high. It is still twelve times too high
for one identity, and at the 99th percentile of identities it is 27% too
high. Keeping 256 per day was exact over this window. It stores 2.7 times
what 64 does, and nothing bounds how many a day needs.

Bucket counts are exact to within one bucket, whatever the days hold. Each
bucket is read as the largest duration it counts. The bucket bounds are the
powers of two raised to multiples of one over the number of buckets per
doubling. An identity is read exactly only where its percentile falls on a
bound, which is why that column does not move with the resolution. At 32
buckets per doubling, the reading is at most 2.2% above the exact value.
It stores 38% less than the 64 kept durations did. Stored as the lowest
bucket and a dense list of counts from it, it was smaller than a map from
bucket to count: 28.5 MB against 32.2 MB, without day keys. At the 99th
percentile of stored days the list is 181 counts long, and at the maximum
it is 556. Every recorded duration was a whole number of milliseconds.

## What the lanes would do

A lane's projection charges each batch's fitted slope against the
manifest's cost of each test the batch holds. The slope was fitted against
what those tests took. The part of a lane's projection that a cost reading
changes is therefore the slope times the sum, over the lane's passing
tests, of cost minus the duration each test took. That is the cost margin
in the table below.

The new cost for this check was read from the stored 64-per-day samples,
once ignoring dropped runs and once counting them at the least kept.
Those two readings bound it from below and from above, and they were
within 1.2 s of each other at the 99th percentile of lanes. The table gives
the lower of the two, which is the direction that makes an overrun more
likely.

For each of the 477 pull-request lane reports:

| Figure | 10th pct | Median | 90th pct | 99th pct |
| --- | ---: | ---: | ---: | ---: |
| Cost margin, current reading | 3.0 s | 27.5 s | 77.4 s | 539.7 s |
| Cost margin, window percentile | 1.1 s | 9.0 s | 44.2 s | 270.1 s |
| Spend past the projection at measured test time | −71.0 s | −30.4 s | −5.6 s | 37.5 s |
| Spend past the projection, current reading | | | −28.1 s | 5.8 s |
| Spend past the projection, window percentile | | | −12.8 s | 12.6 s |

The third row does not depend on the cost reading. It shows the
calibration's charges projecting more than the lane spent in nine lanes
out of ten, because each charge is read at a ninetieth percentile.

The last two rows are what a lane packed exactly to its budget would spend
past it. The safety margin `LANE_SAFETY_SECONDS` of 30 s is what absorbs
that. Under the current reading, 2 of the 477 lanes spent more than 30 s
past their projection. Under the window percentile, 3 did (2 under the
upper-bound reading).

30 of the 477 lanes spent more than the 260 s that a 300 s bound leaves
after the 40 s prologue. Every one of those 30 was projected past its
230 s budget before any cost margin was counted. They held more mandatory
work than a lane's budget. The cost reading did not put them there.

The 2,252 lanes of the 30-lane full run are not packed to a budget that a
cost margin could fill. The tenth percentile of what they spent is 668 s,
and the median is 950 s, against a budget of 530 s. A full run runs every
test, so the cost reading there decides only how the work is divided among
lanes.

No dial was changed. The margin that less padded costs remove was not
what kept these lanes inside their bound.
