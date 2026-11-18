/**
 * Where the FUSE bindings look for a FUSE library on each platform, in the
 * order they try. It imports nothing, so asking whether a machine has FUSE
 * loads no binding.
 */

/**
 * Candidate libfuse locations on macOS, in preference order. FUSE-T's
 * installer supports two layouts: the root install symlinks the library
 * into /usr/local/lib, and the per-user install (running the installer's
 * postinstall as a non-root user) places it under ~/.fuse-t/usr/local/lib.
 * macFUSE installs into /usr/local/lib only.
 */
export function darwinLibfusePaths(
  env: { get(name: string): string | undefined } = Deno.env,
): string[] {
  const paths = ["/usr/local/lib/libfuse-t.dylib"];
  const home = env.get("HOME");
  if (home) {
    paths.push(`${home}/.fuse-t/usr/local/lib/libfuse-t.dylib`);
  }
  paths.push("/usr/local/lib/libfuse.2.dylib"); // macFUSE (kernel extension)
  return paths;
}

/** Candidate libfuse3 locations on Linux, in preference order. */
export const LINUX_LIBFUSE_PATHS: readonly string[] = [
  "/usr/lib/x86_64-linux-gnu/libfuse3.so", // Debian/Ubuntu x86_64
  "/usr/lib/aarch64-linux-gnu/libfuse3.so", // Debian/Ubuntu aarch64
  "/usr/lib/libfuse3.so", // Arch, Fedora
  "/usr/lib64/libfuse3.so", // RHEL/CentOS
  "/usr/lib64/libfuse3.so.3", // Fedora
  "/usr/lib64/libfuse3.so.4", // Fedora
];
