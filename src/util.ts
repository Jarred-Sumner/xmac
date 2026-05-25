/** Shared constants, errors and small helpers. */

export const VERSION = "0.1.0";

/**
 * Apple's merged software-update catalog. The leading numbers are the macOS
 * major versions the catalog covers; the "26-..." catalog is a strict
 * superset of the older ones and includes every Command Line Tools release
 * back to ~2021 plus the newest ones.
 */
export const DEFAULT_SUCATALOG =
  "https://swscan.apple.com/content/catalogs/others/index-26-15-14-13-12-10.16-10.15-10.14-10.13-10.12-10.11-10.10-10.9-mountainlion-lion-snowleopard-leopard.merged-1.sucatalog.gz";

export const USER_AGENT = `xmac/${VERSION} (Software%20Update; like swupd)`;

/** An expected, user-facing failure. Printed without a stack trace. */
export class XmacError extends Error {}

/** Options shared by every command. */
export interface GlobalOpts {
  cacheDir: string;
  catalog: string;
  offline: boolean;
  json: boolean;
}

export function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

let quiet = false;
export function setQuiet(q: boolean) {
  quiet = q;
}
export function isQuiet(): boolean {
  return quiet;
}

/** Status logging — always to stderr, suppressed by --quiet. */
export function log(msg: string) {
  if (!quiet) console.error(msg);
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function thousands(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Zero-copy view of any Uint8Array as a Buffer, for readUInt32BE / readBigUInt64BE
 * / compare / toString("hex"). Safe on subarray views with a non-zero byteOffset.
 */
export function asBuffer(u8: Uint8Array): Buffer {
  return Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

export function sha1Hex(buf: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(buf);
  return h.digest("hex");
}

/** Natural-ish version compare: "15.2" > "15.0" > "14.6". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
