import type { FileHandle } from 'node:fs/promises';

/**
 * Lightweight positional reader over a FileHandle or in-memory Buffer.
 * Caches the initial header chunk (default 256 KB) in memory so TIFF IFD walks
 * and ISOBMFF box parsing typically complete with 1 syscall and zero full-file reads.
 */
export class BinaryReader {
  private readonly fh: FileHandle | null;
  private readonly memBuf: Buffer | null;
  public readonly fileSize: number;
  private headerBuf: Buffer | null = null;
  private headerLoadedSize = 0;

  private constructor(fh: FileHandle | null, memBuf: Buffer | null, fileSize: number) {
    this.fh = fh;
    this.memBuf = memBuf;
    this.fileSize = fileSize;
  }

  static async fromFileHandle(fh: FileHandle, fileSize: number, preloadHeaderBytes = 262144): Promise<BinaryReader> {
    const reader = new BinaryReader(fh, null, fileSize);
    const toRead = Math.min(fileSize, preloadHeaderBytes);
    if (toRead > 0) {
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await fh.read(buf, 0, toRead, 0);
      reader.headerBuf = bytesRead === toRead ? buf : buf.subarray(0, bytesRead);
      reader.headerLoadedSize = bytesRead;
    } else {
      reader.headerBuf = Buffer.alloc(0);
      reader.headerLoadedSize = 0;
    }
    return reader;
  }

  static fromBuffer(buf: Buffer): BinaryReader {
    return new BinaryReader(null, buf, buf.length);
  }

  async readSlice(offset: number, length: number): Promise<Buffer> {
    if (offset < 0 || length <= 0 || offset >= this.fileSize) {
      return Buffer.alloc(0);
    }
    const clampedLen = Math.min(length, this.fileSize - offset);
    if (this.memBuf) {
      return this.memBuf.subarray(offset, offset + clampedLen);
    }
    if (this.headerBuf && offset + clampedLen <= this.headerLoadedSize) {
      return this.headerBuf.subarray(offset, offset + clampedLen);
    }
    if (!this.fh) return Buffer.alloc(0);

    const out = Buffer.allocUnsafe(clampedLen);
    let totalRead = 0;
    while (totalRead < clampedLen) {
      const { bytesRead } = await this.fh.read(out, totalRead, clampedLen - totalRead, offset + totalRead);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    return totalRead === clampedLen ? out : out.subarray(0, totalRead);
  }
}

export function readUInt16(buf: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
}

export function readUInt32(buf: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

export function readInt32(buf: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buf.readInt32LE(offset) : buf.readInt32BE(offset);
}

export function readUInt64AsNumber(buf: Buffer, offset: number, littleEndian: boolean): number {
  const big = littleEndian ? buf.readBigUInt64LE(offset) : buf.readBigUInt64BE(offset);
  return Number(big);
}
