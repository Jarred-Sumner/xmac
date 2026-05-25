/**
 * External decompressors (xz, bzip2, gzip).
 *
 * Bun ships zlib/gzip natively for in-memory use; xz and bzip2 are delegated
 * to the system binaries, which exist on effectively every Linux/macOS image.
 */

import { XmacError } from "./util";

const toolCache = new Map<string, string>();

export function requireTool(name: string): string {
  let p = toolCache.get(name);
  if (p) return p;
  p = Bun.which(name) ?? "";
  if (!p)
    throw new XmacError(
      `required tool '${name}' not found on PATH. Install it (e.g. apt-get install ${
        name === "xz" ? "xz-utils" : name
      }) and retry.`,
    );
  toolCache.set(name, p);
  return p;
}

/** Run a decompressor over an in-memory buffer and return all of stdout. */
export async function decompressWith(
  tool: string,
  args: string[],
  input: Uint8Array,
  /** Tolerate a non-zero exit (e.g. truncated input when peeking). */
  allowFailure = false,
): Promise<Uint8Array> {
  const proc = Bun.spawn([requireTool(tool), ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: allowFailure ? "ignore" : "pipe",
  });
  // Write and read concurrently to avoid pipe-buffer deadlock.
  const writer = (async () => {
    try {
      proc.stdin.write(input);
      await proc.stdin.end();
    } catch {
      /* the reader side will surface real errors */
    }
  })();
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await writer;
  const code = await proc.exited;
  if (code !== 0 && !allowFailure) {
    const err = proc.stderr ? await new Response(proc.stderr).text() : `exit ${code}`;
    throw new XmacError(`${tool} failed: ${err.trim() || `exit ${code}`}`);
  }
  return out;
}
