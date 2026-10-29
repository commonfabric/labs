# Test corpus

This directory contains preserved real-world or historical byte samples used by
bespoke regression tests. Unlike `test/fixtures`, these files are not
transformer input/expected-output pairs and are not discovered by the generic
fixture harness.

Treat corpus files as opaque evidence: tests should read them explicitly, and
the samples should not be regenerated from current implementation constants.
