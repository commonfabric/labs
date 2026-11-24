import { fullRootCommand } from "./root.ts";

/**
 * The whole command tree, loaded, for what walks all of it: the tools that check
 * it, and `cf completion`. Any other run of `cf` loads only the command it
 * addresses, through `rootCommandFor()`.
 */
export const main = await fullRootCommand();
