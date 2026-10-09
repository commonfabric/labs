/**
 * Engine options that build the direct runsc driver from a binary and a
 * rootfs that are not there, for a case that builds an engine without handing
 * it a runtime and is not about the sandbox. The driver resolves both paths
 * without reading or running either, so nothing of the machine the suite runs
 * on is touched; a case that runs a command hands the engine a process runner
 * of its own as well.
 */
export const INERT_RUNSC = {
  sandboxRunscBinary: "/nonexistent/cf-harness-test/runsc",
  sandboxRootfs: "/nonexistent/cf-harness-test/rootfs",
} as const;

/**
 * {@link INERT_RUNSC}, with a CFC policy that is not there either, for such a
 * case that runs in a mode that enforces CFC: an enforcing run on the driver
 * refuses to start without a policy named, and nothing reads this one unless
 * a command runs.
 */
export const INERT_ENFORCING_RUNSC = {
  ...INERT_RUNSC,
  sandboxCfcPolicy: "/nonexistent/cf-harness-test/cfc-policy.json",
} as const;
