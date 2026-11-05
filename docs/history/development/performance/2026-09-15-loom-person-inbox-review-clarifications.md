---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Reconciled source-document roles and independent medians during review of the Loom investigation."
---

# Loom investigation: review clarifications

This supplement records checks prompted by review of the investigation reports.
The original reports remain frozen; the corrections and bounds below accompany
their point-in-time observations.

## The dominant commit reads 203 source documents

The role enumeration in
[policy processing](2026-09-14-loom-person-inbox-policy-processing.md#the-dominant-commit)
accounts for 201 of the 203 documents recorded in the dominant commit.
Regrouping the retained probe's read addresses by document and scope accounts
for all 203:

| Read-path shape                                                                     | Scope   | Documents |
| ----------------------------------------------------------------------------------- | ------- | --------: |
| Pattern-root metadata                                                               | Session |        50 |
| Element, array, index, and parameter arguments                                      | Session |        50 |
| Simple root/link documents                                                          | Session |       100 |
| Array read at indices 0–49                                                          | Session |         1 |
| Additional array read at per-message `isSelf`, `senderName`, and `showSender` paths | Session |         1 |
| Root and link-marker paths only                                                     | Space   |         1 |
| Total                                                                               |         |       203 |

The last two rows were omitted from the original enumeration. The additional
session array has both indexed link-marker reads and the named message fields;
the space-scoped document has two read paths, the root and `/link@1`. These are
observed access shapes. The probe does not establish the space document's
application-level purpose, and no conversation or person identity is inferred
from it. The 100 simple session documents likewise remain classified by shape.
The scope totals remain 202 session documents and one space document, matching
[the count artifact](2026-09-14-loom-person-inbox-policy-counts.json).

## Policy and opening medians are independent statistics

The R6 row in
[the policy-budget report](2026-09-15-loom-person-inbox-policy-budget.md#other-experiments-and-why-they-were-not-retained)
uses the following three repetitions from `phase6` in its accompanying CSV:

| Runtime | Policy preparation, raw ms | Policy median ms | Opening, raw ms     | Opening median ms |
| ------- | -------------------------- | ---------------: | ------------------- | ----------------: |
| R4      | 397.4, 387.8, 402.3        |            397.4 | 808.3, 810.0, 859.4 |             810.0 |
| R6      | 351.0, 364.6, 414.8        |            364.6 | 797.7, 824.5, 964.1 |             824.5 |

For R4, the median policy observation is repetition 1 and the median opening
observation is repetition 2. Reporting both column medians does not assert that
one repetition produced both. Substituting the opening time from the median
policy repetition would change the statistic: 808.3 ms is a raw observation, not
the opening median. The report's 810.0 to 824.5 ms comparison is unchanged.
