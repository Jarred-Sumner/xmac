/**
 * pbzx payload reader.
 *
 * `pbzx` magic, u64be max-chunk-size, then chunks of
 * (u64be uncompressedSize, u64be compressedSize, data[compressedSize]).
 * A chunk whose compressed size equals its uncompressed size is stored raw;
 * otherwise it is an independent XZ stream.
 *
 * Older Command Line Tools payloads are plain gzip- or xz-compressed cpio
 * instead; `decompressPayload` sniffs the magic and picks the right decoder.
 */

import { asBuffer, XmacError } from "./util";
import { ByteReader } from "./bytes";
import { requireTool } from "./exec";

export const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);

interface PbzxChunk {
  uncompressedSize: number;
  compressedSize: number;
  raw: boolean;
}

/**
 * Decompress a pbzx stream into a stream of decompressed byte chunks.
 * Runs of consecutive XZ chunks are piped through a single `xz -dc` process
 * (xz natively handles concatenated streams), so the typical payload spawns
 * exactly one subprocess and stays fully streaming end-to-end.
 */
async function* pbzxDecompress(
  source: AsyncIterable<Uint8Array>,
  onProgress?: (compressedBytes: number) => void,
): AsyncGenerator<Uint8Array> {
  const reader = new ByteReader(source[Symbol.asyncIterator]());
  const magic = await reader.readExact(4);
  if (!magic || new TextDecoder().decode(magic) !== "pbzx")
    throw new XmacError("payload: missing pbzx magic");
  await reader.skip(8); // max chunk size; informational
  let consumed = 12;

  // Read the next chunk header, or null at EOF.
  const nextChunk = async (): Promise<PbzxChunk | null> => {
    const hdr = await reader.readExact(16);
    if (hdr === null) return null;
    const b = asBuffer(hdr);
    const uncompressedSize = Number(b.readBigUInt64BE(0));
    const compressedSize = Number(b.readBigUInt64BE(8));
    if (compressedSize <= 0 || uncompressedSize < 0)
      throw new XmacError("payload: corrupt pbzx chunk header");
    consumed += 16;
    return {
      uncompressedSize,
      compressedSize,
      raw: compressedSize === uncompressedSize,
    };
  };

  let pending: PbzxChunk | null = await nextChunk();
  while (pending !== null) {
    if (pending.raw) {
      for await (const piece of reader.readStream(pending.compressedSize)) {
        consumed += piece.byteLength;
        onProgress?.(consumed);
        yield piece;
      }
      pending = await nextChunk();
      continue;
    }

    // A run of XZ chunks → one xz process.
    const proc = Bun.spawn([requireTool("xz"), "-dc", "-T0"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let writerError: unknown = null;
    const writer = (async () => {
      try {
        while (pending !== null && !pending.raw) {
          let first = true;
          for await (const piece of reader.readStream(pending.compressedSize)) {
            if (first) {
              first = false;
              if (piece.byteLength >= 6 && Buffer.compare(piece.subarray(0, 6), XZ_MAGIC) !== 0)
                throw new XmacError(
                  "payload: pbzx chunk is neither raw nor XZ — unsupported variant",
                );
            }
            consumed += piece.byteLength;
            onProgress?.(consumed);
            const r = proc.stdin.write(piece);
            if (r && typeof (r as Promise<unknown>).then === "function") await r;
            await proc.stdin.flush();
          }
          pending = await nextChunk();
        }
      } catch (e) {
        writerError = e;
        try {
          proc.kill();
        } catch {}
      } finally {
        try {
          await proc.stdin.end();
        } catch {}
      }
    })();

    for await (const out of proc.stdout) {
      yield out as Uint8Array;
    }
    await writer;
    const code = await proc.exited;
    if (writerError) throw writerError;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new XmacError(`xz failed while decompressing payload: ${err.trim() || `exit ${code}`}`);
    }
  }
}

/** Pipe an entire byte stream through one decompressor process. */
async function* pipeThrough(
  cmd: string[],
  source: AsyncIterable<Uint8Array>,
  onProgress?: (n: number) => void,
): AsyncGenerator<Uint8Array> {
  const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let writerError: unknown = null;
  const writer = (async () => {
    try {
      let n = 0;
      for await (const piece of source) {
        n += piece.byteLength;
        onProgress?.(n);
        const r = proc.stdin.write(piece);
        if (r && typeof (r as Promise<unknown>).then === "function") await r;
        await proc.stdin.flush();
      }
    } catch (e) {
      writerError = e;
      try {
        proc.kill();
      } catch {}
    } finally {
      try {
        await proc.stdin.end();
      } catch {}
    }
  })();
  for await (const out of proc.stdout) yield out as Uint8Array;
  await writer;
  const code = await proc.exited;
  if (writerError) throw writerError;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new XmacError(
      `${cmd[0]} failed while decompressing payload: ${err.trim() || `exit ${code}`}`,
    );
  }
}

/** Detect the payload flavour and return a decompressed byte stream. */
export async function* decompressPayload(
  source: AsyncIterable<Uint8Array>,
  onProgress?: (compressedBytes: number) => void,
): AsyncGenerator<Uint8Array> {
  // Peek at the first few bytes to pick a decoder.
  const it = source[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done || !first.value) throw new XmacError("payload: empty");
  const head = first.value;
  const rest: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      yield head;
      while (true) {
        const n = await it.next();
        if (n.done) return;
        yield n.value;
      }
    },
  };
  if (head.byteLength >= 4 && new TextDecoder().decode(head.subarray(0, 4)) === "pbzx") {
    yield* pbzxDecompress(rest, onProgress);
    return;
  }
  if (head[0] === 0x1f && head[1] === 0x8b) {
    // Older CLT payloads: plain gzip-compressed cpio.
    yield* pipeThrough([requireTool("gzip"), "-dc"], rest, onProgress);
    return;
  }
  if (head.byteLength >= 6 && Buffer.compare(head.subarray(0, 6), XZ_MAGIC) === 0) {
    yield* pipeThrough([requireTool("xz"), "-dc", "-T0"], rest, onProgress);
    return;
  }
  throw new XmacError(
    `payload: unrecognized format (first bytes: ${Buffer.from(head.subarray(0, 8)).toString("hex")})`,
  );
}
