import { computed } from "commonfabric";

// FIXTURE: computed-alias-const-rewrite
// Verifies: stable const aliases to `computed()` still lower to `derive()`.
const alias = computed;

export default alias(() => 1);
