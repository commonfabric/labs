---
status: historical
created: 2026-09-16
archived: 2026-09-16
reason: "PR 7604 review verification of browser evidence hashes and capture paths."
---

# CFC browser evidence reproduction

The [round-two evidence](2026-09-16-cfc-commit-preparation-round2/browser.json)
and
[cache follow-up evidence](2026-09-16-cfc-prepare-cache-followup/browser.json)
record different normalization versions. Both sets of hashes were reproduced
against the retained captures during PR 7604 review on September 16, 2026.

The original twelve pairs used the comparator at commit
`6fca211368ffc829ee99d8fe0d24c7dcb5acfd3f`, which emitted `<space0>`. The strict
comparator at commit `372faff7ba89824e7c8d70f646be396b4f8e4597` rejects
cross-space captures and emits `<harness-space>`. Its hashes for those same
twelve pairs are recorded separately in
[original-browser-equivalence.json](2026-09-16-cfc-prepare-cache-followup/original-browser-equivalence.json).
The follow-up's three pairs also use the strict comparator. Every recorded hash
matched its respective comparator; the historical manifests retain their
original results.

For the original manifest, extract the original comparator into a chosen
`OUTPUT` directory, then supply the two captured observation directories:

```sh
git show 6fca211368ffc829ee99d8fe0d24c7dcb5acfd3f:docs/history/development/performance/2026-09-16-cfc-commit-preparation-round2/compare-browser.py > "$OUTPUT/original-compare.py"
python3 "$OUTPUT/original-compare.py" "$OUTPUT/baseline" "$OUTPUT/final"
```

For the strict recomparison and follow-up, extract the same file at
`372faff7ba89824e7c8d70f646be396b4f8e4597` and supply the corresponding arms.
Each arm contains `n<N>-r<R>.json` observations. A fresh experiment sets
`CF_CFC_PREPARE_OUT` to its chosen arm directory, as described by the recorded
launch command.

The `/tmp` names in the follow-up manifest are capture provenance. To analyze
captures on another machine, map these prefixes to the local observation
directories; the comparator accepts both paths as arguments:

| Recorded capture prefix                     | Portable analysis location |
| ------------------------------------------- | -------------------------- |
| `/tmp/cfc-round2-followup-browser-baseline` | `OUTPUT/baseline`          |
| `/tmp/cfc-round2-followup-browser-final`    | `OUTPUT/final`             |

Raw observation and CPU-profile files are external capture artifacts, not files
included in this checkout. The checked-in manifests contain summaries, source
hashes, and comparison results. Reproducing the exact captured hashes requires
those observations; running a fresh experiment produces a new measurement.
Relative paths would not make absent capture files available.
