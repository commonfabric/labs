#!/usr/bin/env -S deno run --allow-read

import { Identity } from "@commonfabric/identity";
import { encode } from "@commonfabric/text/utf8";

/**
 * Usage:
 * `./key-did.ts KEY_PATH`
 */

async function main() {
  const keyFilePath = Deno.args[0];
  if (!keyFilePath) {
    throw new Error("No KEY_PATH argument provided.");
  }
  const keyBuffer = await Deno.readFile(keyFilePath);
  const identity = await Identity.fromPkcs8(keyBuffer);
  await Deno.stdout.write(encode(identity.did()));
}

if (import.meta.main) {
  main();
}
