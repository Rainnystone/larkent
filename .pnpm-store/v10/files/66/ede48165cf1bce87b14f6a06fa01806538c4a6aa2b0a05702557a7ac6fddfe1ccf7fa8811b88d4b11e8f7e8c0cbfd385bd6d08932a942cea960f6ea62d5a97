/**
 * Incrementally splits a byte stream into newline-terminated lines.
 *
 * Only the newly pushed chunk is scanned for newlines, so splitting costs
 * O(total bytes) no matter how many chunks a line spans.
 *
 * Chunks passed to {@link push} must not be mutated while its iterator is
 * in use.
 */
export declare class LineBuffer {
    #private;
    constructor(maxMessageBytes?: number);
    /**
     * Consumes a chunk, yielding each complete line without its trailing
     * LF or CRLF.
     */
    push(chunk: Uint8Array): Generator<Uint8Array>;
    /**
     * Returns the trailing unterminated line and resets the buffer, or
     * undefined if no bytes are buffered.
     */
    flush(): Uint8Array | undefined;
    clear(): void;
}
