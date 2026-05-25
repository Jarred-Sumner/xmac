/** cpio reader (odc "070707" and newc "070701"/"070702" variants). */

import { asBuffer, XmacError } from "./util";
import { ByteReader } from "./bytes";

export interface CpioEntry {
  path: string;
  mode: number;
  size: number;
  /** Present for symlinks. */
  linkTarget?: string;
  /** Pull the file body. Must be fully consumed (or skipped) before the next entry. */
  body: () => AsyncGenerator<Uint8Array>;
  skip: () => Promise<void>;
}

export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

function parseOctal(buf: Uint8Array, off: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) {
    const ch = buf[off + i];
    if (ch === 0x20 || ch === 0) continue;
    v = v * 8 + (ch - 0x30);
  }
  return v;
}

function parseHex(buf: Uint8Array, off: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) {
    const ch = buf[off + i];
    let d: number;
    if (ch >= 0x30 && ch <= 0x39) d = ch - 0x30;
    else if (ch >= 0x41 && ch <= 0x46) d = ch - 0x37;
    else if (ch >= 0x61 && ch <= 0x66) d = ch - 0x57;
    else continue;
    v = v * 16 + d;
  }
  return v;
}

export async function* cpioEntries(source: AsyncIterable<Uint8Array>): AsyncGenerator<CpioEntry> {
  const reader = new ByteReader(source[Symbol.asyncIterator]());
  const dec = new TextDecoder();
  // Track position for newc 4-byte alignment.
  let offset = 0;
  const readExact = async (n: number) => {
    const b = await reader.readExact(n);
    if (b !== null) offset += n;
    return b;
  };
  const skipN = async (n: number) => {
    if (n <= 0) return;
    await reader.skip(n);
    offset += n;
  };

  let sawTrailer = false;
  while (true) {
    if (await reader.atEof()) return;
    const magicBuf = await readExact(6);
    if (magicBuf === null) return;
    const magic = dec.decode(magicBuf);

    let mode: number, namesize: number, filesize: number;
    let align = 1;
    if (magic === "070707") {
      // odc: dev[6] ino[6] mode[6] uid[6] gid[6] nlink[6] rdev[6] mtime[11] namesize[6] filesize[11]
      const h = await readExact(70);
      if (h === null) throw new XmacError("cpio: truncated odc header");
      mode = parseOctal(h, 12, 6);
      namesize = parseOctal(h, 53, 6);
      filesize = parseOctal(h, 59, 11);
    } else if (magic === "070701" || magic === "070702") {
      // newc: 13 8-char hex fields after the magic
      const h = await readExact(104);
      if (h === null) throw new XmacError("cpio: truncated newc header");
      mode = parseHex(h, 8, 8);
      filesize = parseHex(h, 48, 8);
      namesize = parseHex(h, 88, 8);
      align = 4;
    } else if (magicBuf.every((b) => b === 0)) {
      // Zero padding after the trailer (the pbzx payload is rounded up).
      while (!(await reader.atEof())) await reader.skip(reader.buffered || 1);
      return;
    } else if (sawTrailer) {
      // Garbage after a completed archive — ignore it.
      return;
    } else if (magicBuf[0] === 0xc7 && magicBuf[1] === 0x71) {
      throw new XmacError("cpio: binary (bin/crc) cpio archives are not supported");
    } else {
      throw new XmacError(
        `cpio: bad magic '${asBuffer(magicBuf).toString("hex")}' at offset ${offset - 6}`,
      );
    }

    const nameBuf = await readExact(namesize);
    if (nameBuf === null) throw new XmacError("cpio: truncated name");
    // Name is NUL-terminated; namesize includes the NUL.
    let nameEnd = namesize;
    while (nameEnd > 0 && nameBuf[nameEnd - 1] === 0) nameEnd--;
    const name = dec.decode(nameBuf.subarray(0, nameEnd));
    if (align > 1) await skipN((align - (offset % align)) % align);

    if (name === "TRAILER!!!") {
      await skipN(filesize);
      // Multiple concatenated cpio archives are possible; keep going until
      // EOF, but remember that anything malformed past here is just padding.
      sawTrailer = true;
      continue;
    }

    const type = mode & S_IFMT;
    let consumed = false;
    let linkTarget: string | undefined;
    if (type === S_IFLNK && filesize > 0 && filesize < 8192) {
      const t = await readExact(filesize);
      if (t === null) throw new XmacError("cpio: truncated symlink target");
      linkTarget = dec.decode(t);
      if (align > 1) await skipN((align - (offset % align)) % align);
      consumed = true;
    }

    const entry: CpioEntry = {
      path: name,
      mode,
      size: filesize,
      linkTarget,
      body: async function* () {
        if (consumed) return;
        consumed = true;
        for await (const piece of reader.readStream(filesize)) {
          offset += piece.byteLength;
          yield piece;
        }
        if (align > 1) await skipN((align - (offset % align)) % align);
      },
      skip: async () => {
        if (consumed) return;
        consumed = true;
        await skipN(filesize);
        if (align > 1) await skipN((align - (offset % align)) % align);
      },
    };
    yield entry;
    if (!consumed) await entry.skip();
  }
}
