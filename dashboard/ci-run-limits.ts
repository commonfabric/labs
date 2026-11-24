// Shared fetch window: the fetch stops at whichever of these two yields fewer
// workflow runs. Every CI tile slices from it.
export const CI_RUNS_MAX = 200; // workflow runs
export const CI_RUNS_MAX_AGE_DAYS = 60; // ~2 months

// ci-duration median window — the larger of these two (more runs wins).
export const DUR_MIN_RUNS = 20;
export const DUR_MAX_AGE_HOURS = 6;
