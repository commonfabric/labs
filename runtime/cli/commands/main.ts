import { fullRootCommand } from "./root.ts";

/**
 * The whole command tree, loaded. A run of `cf` loads only the command it
 * addresses, through `rootCommandFor()`; this is for a tool that walks them.
 */
export const main = await fullRootCommand();
