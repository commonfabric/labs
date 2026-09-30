---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Paired statistical summary of the prepared-digest unit ladder."
---

# Prepared digest unit ladder: paired summary

This supplements the [initial report](2026-09-15-prepared-digest.md) using its
unchanged [raw measurements](2026-09-15-prepared-digest-data.json). The initial
table divides independent minimum timings; that quotient is not a paired
speedup. Use the paired ratios below when assessing improvement.

Each time column is the median of the five per-run 75th percentiles in
milliseconds. Each speedup is the median of the five same-round baseline /
optimized ratios, not the ratio of the time columns. Setup, workload, cache
counts, and the machine-load limitations are as recorded in the initial report.

| Writes | KiB | Phase | Baseline median ms | Optimized median ms | Median paired speedup |
| --- | --- | --- | ---: | ---: | ---: |
| 5 | 1 | first | 6.3245 | 11.8347 | 0.59x |
| 5 | 1 | unchanged | 5.2375 | 0.0027 | 2002.71x |
| 5 | 1 | one-write | 5.5231 | 5.4434 | 1.05x |
| 5 | 1 | warm-parts | 4.5274 | 0.8771 | 5.48x |
| 5 | 10 | first | 5.6840 | 10.0072 | 0.57x |
| 5 | 10 | unchanged | 5.3447 | 0.0032 | 1759.93x |
| 5 | 10 | one-write | 5.1202 | 5.1046 | 1.01x |
| 5 | 10 | warm-parts | 4.7713 | 0.8783 | 6.08x |
| 50 | 1 | first | 6.0118 | 13.1215 | 0.56x |
| 50 | 1 | unchanged | 6.1502 | 0.0034 | 1792.08x |
| 50 | 1 | one-write | 6.1887 | 7.0873 | 0.83x |
| 50 | 1 | warm-parts | 5.2146 | 0.8562 | 6.09x |
| 50 | 10 | first | 6.9019 | 11.9053 | 0.62x |
| 50 | 10 | unchanged | 5.9920 | 0.0022 | 2681.35x |
| 50 | 10 | one-write | 6.5907 | 6.1030 | 1.08x |
| 50 | 10 | warm-parts | 5.3818 | 0.8815 | 6.11x |
| 200 | 1 | first | 10.5035 | 19.1918 | 0.58x |
| 200 | 1 | unchanged | 11.9891 | 0.0025 | 5301.32x |
| 200 | 1 | one-write | 11.5825 | 9.6728 | 1.20x |
| 200 | 1 | warm-parts | 8.3699 | 1.1217 | 7.59x |
| 200 | 10 | first | 12.0572 | 20.7183 | 0.63x |
| 200 | 10 | unchanged | 10.5746 | 0.0026 | 4093.92x |
| 200 | 10 | one-write | 10.4186 | 10.1743 | 1.04x |
| 200 | 10 | warm-parts | 7.7843 | 1.1990 | 6.73x |

The microsecond-scale unchanged path measures a memo lookup, so its large
ratio should be read as elimination of digest computation, not a precise
end-to-end speedup. Cold composition remains slower. The shared arm-B table
already reports paired ratios and needs no statistical correction.
