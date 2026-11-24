---
status: historical
created: 2026-10-16
archived: 2026-10-16
reason: "Second calibration of the default discretionary target, after coverage gates came to be chosen by score; 575 seconds stood."
---

# Recalibrating the lanes a pull request counts for itself

Measured on 2026-10-16. The day before,
[the first calibration](2026-10-15-pull-request-lane-count-calibration.md)
set `DISCRETIONARY_SECONDS`, the seconds of tests chosen by score a pull
request runs beside its mandatory work, to 575, from a replay of 89 pull
requests. That replay counted, as mandatory, every test of each measured set
a change reached, because each set's coverage gate forced them in. On
2026-10-16 each gate became a test the value, density and exploration passes
choose by score, which takes most of that work out of what a pull request
must run. The same 89 pull requests were replayed again with that code and
the lane count merged, over the same heads, diffs and manifests, by the
method and script the first record gives.

Five lanes, packed under the new rule, chose nothing by score in 15 of the
89, whose mandatory work was projected at a median of 2,908 seconds; across
all 89 the median was 492 seconds. 74 fit in five lanes.

| Target (s) | All: median | All: mean | Fit today: median | Fit today: five lanes | Chose nothing: median | At the cap of 30 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 3 | 4.5 | 2 | 10 of 74 | 14 | 1 |
| 230 | 4 | 5.5 | 3 | 8 of 74 | 15 | 1 |
| 460 | 5 | 6.5 | 4 | 18 of 74 | 16 | 1 |
| 575 | 5 | 7.0 | 5 | 33 of 74 | 16 | 1 |
| 690 | 6 | 7.5 | 5 | 24 of 74 | 17 | 1 |
| 805 | 6 | 7.9 | 6 | 12 of 74 | 17 | 1 |
| 920 | 7 | 8.5 | 6 | 14 of 74 | 18 | 1 |
| 1150 | 8 | 9.5 | 7 | 0 of 74 | 19 | 1 |

575 seconds still puts the pull requests that fit in five lanes at five
more often than any other count, 33 of 74, and at the median. Their counts
were 3 lanes for 8 of them, 4 for 12, 5 for 33, 6 for 8, 7 for 10, and 8 for
3. By the same minute model, a run averages 18.8 billed lane-minutes in five
lanes under the new rule, and 20.9 with this change, plus one for the job
that counts the lanes: 16% more.

The figures carry the same omission as the first calibration's: no manifest
the replay read carried the per-file hook charges the packer had begun to
apply.
