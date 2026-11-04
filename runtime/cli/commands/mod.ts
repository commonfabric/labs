import { main } from "./main.ts";

export async function parse(args: string[]) {
  return await main.parse(args);
}
