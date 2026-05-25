/** HTTP fetching and verified downloads. */

import * as fs from "node:fs";
import * as path from "node:path";
import { humanSize, log, USER_AGENT, XmacError } from "./util";
import { note, ok, Progress } from "./ui";

export async function httpGet(
  url: string,
  opts: { range?: [number, number]; retries?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      await Bun.sleep(delay);
      log(`  retrying (${attempt}/${retries}) ${url}`);
    }
    try {
      const headers: Record<string, string> = { "User-Agent": USER_AGENT };
      if (opts.range) headers["Range"] = `bytes=${opts.range[0]}-${opts.range[1]}`;
      const res = await fetch(url, { headers, redirect: "follow" });
      if (res.status === 200 || res.status === 206) return res;
      // 4xx other than 429 won't get better with retries.
      if (res.status >= 400 && res.status < 500 && res.status !== 429)
        throw new XmacError(`GET ${url}: HTTP ${res.status}`);
      lastErr = new XmacError(`GET ${url}: HTTP ${res.status}`);
    } catch (e) {
      if (e instanceof XmacError) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new XmacError(`GET ${url}: ${lastErr}`);
}

export async function httpGetBytes(url: string, range?: [number, number]): Promise<Uint8Array> {
  const res = await httpGet(url, { range });
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Download a URL to a file. Verifies the byte count and, when given, a SHA-1.
 * Existing files with the right size (and digest) are reused.
 */
export async function downloadTo(
  url: string,
  dest: string,
  expectedSize: number,
  expectedSha1?: string,
  label?: string,
): Promise<void> {
  const name = label ?? path.basename(dest);
  if (fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    if (st.size === expectedSize) {
      if (!expectedSha1) {
        note(`${name}: cached`);
        return;
      }
      const h = new Bun.CryptoHasher("sha1");
      const fd = fs.openSync(dest, "r");
      try {
        const buf = Buffer.alloc(4 << 20);
        let r: number;
        while ((r = fs.readSync(fd, buf, 0, buf.length, -1)) > 0) h.update(buf.subarray(0, r));
      } finally {
        fs.closeSync(fd);
      }
      if (h.digest("hex") === expectedSha1.toLowerCase()) {
        note(`${name}: cached (checksum ok)`);
        return;
      }
      note(`${name}: cached file failed checksum, re-downloading`);
    }
    fs.rmSync(dest, { force: true });
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await httpGet(url);
  const total = Number(res.headers.get("content-length") ?? expectedSize) || expectedSize;
  const prog = new Progress(name, total);
  const hasher = new Bun.CryptoHasher("sha1");
  const sink = fs.createWriteStream(tmp);
  let done = 0;
  try {
    if (!res.body) throw new XmacError(`GET ${url}: empty body`);
    for await (const chunk of res.body) {
      const u8 = chunk as Uint8Array;
      hasher.update(u8);
      done += u8.byteLength;
      prog.update(done);
      if (!sink.write(u8)) await new Promise<void>((r) => sink.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) =>
      sink.end((err: unknown) => (err ? reject(err) : resolve())),
    );
    if (expectedSize && done !== expectedSize)
      throw new XmacError(`${url}: size mismatch (got ${done}, expected ${expectedSize})`);
    const got = hasher.digest("hex");
    if (expectedSha1 && got !== expectedSha1.toLowerCase())
      throw new XmacError(`${url}: SHA-1 mismatch (got ${got}, expected ${expectedSha1})`);
  } catch (e) {
    sink.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.renameSync(tmp, dest);
  prog.finish();
  ok(`downloaded ${name} (${humanSize(done)})`);
}
