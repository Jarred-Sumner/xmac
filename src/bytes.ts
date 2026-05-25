/** Pull-based reader over an async iterable of byte chunks. */

import { XmacError } from "./util";

export class ByteReader {
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0;
  private done = false;
  constructor(private src: AsyncIterator<Uint8Array>) {}

  /** Bytes currently buffered and unread. */
  get buffered(): number {
    return this.buf.length - this.pos;
  }

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const { value, done } = await this.src.next();
    if (done || !value) {
      this.done = true;
      return false;
    }
    if (value.byteLength === 0) return this.fill();
    if (this.pos >= this.buf.length) {
      this.buf = value;
    } else {
      // Buffer.concat accepts any Uint8Array and returns a Buffer (which is
      // itself a Uint8Array), so the field type is preserved.
      this.buf = Buffer.concat([this.buf.subarray(this.pos), value]);
    }
    this.pos = 0;
    return true;
  }

  /** Read exactly n bytes; returns null on clean EOF at a boundary. */
  async readExact(n: number): Promise<Uint8Array | null> {
    while (this.buffered < n) {
      if (!(await this.fill())) {
        if (this.buffered === 0) return null;
        throw new XmacError(`unexpected end of stream (wanted ${n} bytes, had ${this.buffered})`);
      }
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Yield up to n bytes in pieces as they become available. */
  async *readStream(n: number): AsyncGenerator<Uint8Array> {
    let remaining = n;
    while (remaining > 0) {
      if (this.buffered === 0 && !(await this.fill()))
        throw new XmacError(`unexpected end of stream (wanted ${remaining} more bytes)`);
      const take = Math.min(this.buffered, remaining);
      const out = this.buf.subarray(this.pos, this.pos + take);
      this.pos += take;
      remaining -= take;
      yield out;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.readStream(n)) {
      /* discard */
    }
  }

  async atEof(): Promise<boolean> {
    if (this.buffered > 0) return false;
    return !(await this.fill());
  }
}
