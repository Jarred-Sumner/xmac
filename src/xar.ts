/**
 * xar (.pkg container) reader.
 *
 * Layout: 28+ byte big-endian header, zlib-compressed XML table of contents,
 * then a heap of file data. TOC <file> entries carry heap offsets.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { asBuffer, sha1Hex, XmacError } from "./util";
import { childText, firstChild, parseXml, type XmlNode } from "./xml";
import { decompressWith } from "./exec";

export interface XarEntry {
  /** Full path within the archive. */
  name: string;
  /** file | directory | symlink | hardlink */
  type: string;
  /** Heap-relative offset of the (possibly compressed) data. */
  offset: number;
  /** Byte length of the data as stored in the heap. */
  size: number;
  /** Byte length after decoding. */
  length: number;
  encoding: string;
  archivedChecksum?: { style: string; value: string };
}

export interface XarHeader {
  headerSize: number;
  tocCompressedLength: number;
  tocUncompressedLength: number;
  /** Absolute file offset where the heap begins. */
  heapStart: number;
}

const XAR_MAGIC = 0x78617221; // "xar!"

export function parseXarHeader(buf: Uint8Array): XarHeader {
  if (buf.length < 28) throw new XmacError("xar: file too small");
  const b = asBuffer(buf);
  if (b.readUInt32BE(0) !== XAR_MAGIC)
    throw new XmacError("xar: bad magic — this does not look like a flat .pkg/.xar file");
  const headerSize = b.readUInt16BE(4);
  const version = b.readUInt16BE(6);
  if (version !== 1) throw new XmacError(`xar: unsupported version ${version}`);
  const tocCompressedLength = Number(b.readBigUInt64BE(8));
  const tocUncompressedLength = Number(b.readBigUInt64BE(16));
  return {
    headerSize,
    tocCompressedLength,
    tocUncompressedLength,
    heapStart: headerSize + tocCompressedLength,
  };
}

export function parseXarToc(tocXml: string): XarEntry[] {
  const root = parseXml(tocXml);
  const xar = firstChild(root, "xar");
  const toc = xar && firstChild(xar, "toc");
  if (!toc) throw new XmacError("xar: missing <toc>");
  const entries: XarEntry[] = [];
  const walk = (node: XmlNode, prefix: string) => {
    for (const f of node.children) {
      if (f.tag !== "file") continue;
      const name = childText(f, "name") ?? "";
      const full = prefix ? `${prefix}/${name}` : name;
      const type = childText(f, "type") ?? "file";
      const data = firstChild(f, "data");
      let offset = 0,
        size = 0,
        length = 0,
        encoding = "application/octet-stream";
      let archivedChecksum: XarEntry["archivedChecksum"];
      if (data) {
        offset = parseInt(childText(data, "offset") ?? "0", 10);
        size = parseInt(childText(data, "size") ?? "0", 10);
        length = parseInt(childText(data, "length") ?? "0", 10);
        const enc = firstChild(data, "encoding");
        if (enc?.attrs["style"]) encoding = enc.attrs["style"];
        const ac = firstChild(data, "archived-checksum");
        if (ac)
          archivedChecksum = {
            style: ac.attrs["style"] ?? "",
            value: ac.text.trim(),
          };
      }
      entries.push({
        name: full,
        type,
        offset,
        size,
        length,
        encoding,
        archivedChecksum,
      });
      walk(f, full); // nested files (directories)
    }
  };
  walk(toc, "");
  return entries;
}

/** Decode a xar heap blob according to its declared encoding. */
export async function xarDecode(data: Uint8Array, encoding: string): Promise<Uint8Array> {
  switch (encoding) {
    case "application/octet-stream":
      return data;
    case "application/x-gzip": // xar misnomer: raw zlib stream
    case "application/zlib":
    case "application/x-zlib":
      return zlib.inflateSync(data);
    case "application/x-bzip2":
    case "application/bzip2":
      return decompressWith("bzip2", ["-dc"], data);
    case "application/x-lzma":
    case "application/x-xz":
      return decompressWith("xz", ["-dc", "-T0"], data);
    default:
      throw new XmacError(`xar: unsupported encoding '${encoding}'`);
  }
}

/** A xar archive backed by a local file. */
export class XarFile {
  private constructor(
    readonly fd: number,
    readonly header: XarHeader,
    readonly entries: XarEntry[],
    readonly filePath: string,
  ) {}

  static open(filePath: string): XarFile {
    const fd = fs.openSync(filePath, "r");
    try {
      const head = Buffer.alloc(28);
      fs.readSync(fd, head, 0, 28, 0);
      const header = parseXarHeader(head);
      const ctoc = Buffer.alloc(header.tocCompressedLength);
      fs.readSync(fd, ctoc, 0, ctoc.length, header.headerSize);
      const toc = zlib.inflateSync(ctoc);
      const entries = parseXarToc(new TextDecoder().decode(toc));
      return new XarFile(fd, header, entries, filePath);
    } catch (e) {
      fs.closeSync(fd);
      throw e;
    }
  }

  close() {
    fs.closeSync(this.fd);
  }

  find(name: string): XarEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  /** Read + decode a (small) entry entirely into memory. */
  async readEntry(entry: XarEntry): Promise<Uint8Array> {
    const raw = Buffer.alloc(entry.size);
    fs.readSync(this.fd, raw, 0, entry.size, this.header.heapStart + entry.offset);
    if (entry.archivedChecksum?.style === "sha1") {
      const got = sha1Hex(raw);
      if (got !== entry.archivedChecksum.value.toLowerCase())
        throw new XmacError(
          `xar: checksum mismatch for '${entry.name}' in ${path.basename(this.filePath)}`,
        );
    }
    return xarDecode(raw, entry.encoding);
  }

  /**
   * Stream a stored (octet-stream) entry's raw bytes in slices, verifying
   * the TOC's archived checksum once the whole entry has been read.
   */
  async *streamRaw(entry: XarEntry, sliceSize = 4 << 20): AsyncGenerator<Uint8Array> {
    if (entry.encoding !== "application/octet-stream")
      throw new XmacError(`xar: cannot stream '${entry.name}' with encoding ${entry.encoding}`);
    const algo = entry.archivedChecksum?.style;
    const hasher =
      algo === "sha1" || algo === "sha256" || algo === "sha512" || algo === "md5"
        ? new Bun.CryptoHasher(algo)
        : undefined;
    let pos = 0;
    while (pos < entry.size) {
      const n = Math.min(sliceSize, entry.size - pos);
      const buf = Buffer.alloc(n);
      const r = fs.readSync(this.fd, buf, 0, n, this.header.heapStart + entry.offset + pos);
      if (r !== n) throw new XmacError(`xar: short read in '${entry.name}'`);
      pos += n;
      hasher?.update(buf);
      yield buf;
    }
    if (hasher) {
      const got = hasher.digest("hex");
      if (got !== entry.archivedChecksum!.value.toLowerCase())
        throw new XmacError(
          `xar: ${algo} checksum mismatch for '${entry.name}' in ${path.basename(this.filePath)} — the download is corrupt; delete it from the cache and retry`,
        );
    }
  }
}
