/**
 * Whether a TCP connection to `port` on `127.0.0.1` is accepted: `false` when
 * it is refused, and any other connection failure is thrown.
 */
export async function connects(port: number): Promise<boolean> {
  try {
    const connection = await Deno.connect({ hostname: "127.0.0.1", port });
    connection.close();
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.ConnectionRefused) return false;
    throw error;
  }
}
