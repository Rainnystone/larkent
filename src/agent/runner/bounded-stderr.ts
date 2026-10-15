export const STDERR_SEGMENT_BYTES = 32 * 1024;

/** Retains the first and last N KB of a stderr stream so matching stays cheap. */
export class BoundedStderr {
  private head = Buffer.alloc(0);
  private tailChunks: Buffer[] = [];
  private tailBytes = 0;
  totalBytes = 0;

  constructor(private readonly segmentBytes = STDERR_SEGMENT_BYTES) {}

  get retainedBytes(): number {
    return this.head.length + this.tailBytes;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.totalBytes += chunk.length;
    let rest = chunk;
    if (this.head.length < this.segmentBytes) {
      const take = Math.min(this.segmentBytes - this.head.length, rest.length);
      this.head = Buffer.concat([this.head, rest.subarray(0, take)]);
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.tailChunks.push(rest);
    this.tailBytes += rest.length;
    this.trimTail();
  }

  snapshot(): string {
    if (this.tailBytes === 0) return this.head.toString('utf8');
    const tail = Buffer.concat(this.tailChunks, this.tailBytes);
    return Buffer.concat([this.head, tail]).toString('utf8');
  }

  private trimTail(): void {
    while (this.tailBytes > this.segmentBytes && this.tailChunks.length > 0) {
      const extra = this.tailBytes - this.segmentBytes;
      const first = this.tailChunks[0]!;
      if (first.length <= extra) {
        this.tailChunks.shift();
        this.tailBytes -= first.length;
      } else {
        this.tailChunks[0] = first.subarray(extra);
        this.tailBytes -= extra;
      }
    }
  }
}
