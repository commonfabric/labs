import { GithubHostProcessLock } from "../src/process-lock.ts";

const path = Deno.args[0];
if (!path) throw new Error("lock path is required");

const lock = await GithubHostProcessLock.acquire(path);
console.log("locked");
const buffer = new Uint8Array(1);
await Deno.stdin.read(buffer);
await lock.release();
