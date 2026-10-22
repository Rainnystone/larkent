export const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export class MessageTooLargeError extends Error {
    maxMessageBytes;
    constructor(maxMessageBytes) {
        super(`Incoming ACP data exceeds the configured ${maxMessageBytes} byte limit`);
        this.maxMessageBytes = maxMessageBytes;
        this.name = "MessageTooLargeError";
    }
}
export function resolveMaxMessageBytes(value) {
    const maxMessageBytes = value ?? DEFAULT_MAX_MESSAGE_BYTES;
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
        throw new RangeError("maxMessageBytes must be a positive safe integer");
    }
    return maxMessageBytes;
}
export class MessageBuffer {
    #buffer = new Uint8Array(0);
    #length = 0;
    #maxMessageBytes;
    constructor(maxMessageBytes) {
        this.#maxMessageBytes = resolveMaxMessageBytes(maxMessageBytes);
    }
    get byteLength() {
        return this.#length;
    }
    get lastByte() {
        return this.#buffer[this.#length - 1];
    }
    #checkAppend(byteLength) {
        if (byteLength > this.#maxMessageBytes - this.#length) {
            this.clear();
            throw new MessageTooLargeError(this.#maxMessageBytes);
        }
    }
    append(bytes) {
        this.#checkAppend(bytes.byteLength);
        const length = this.#length + bytes.byteLength;
        if (length > this.#buffer.byteLength) {
            const capacity = Math.min(this.#maxMessageBytes, Math.max(length, this.#buffer.byteLength * 2, 1024));
            const buffer = new Uint8Array(capacity);
            buffer.set(this.#buffer.subarray(0, this.#length));
            this.#buffer = buffer;
        }
        this.#buffer.set(bytes, this.#length);
        this.#length = length;
    }
    take() {
        const bytes = this.#buffer.subarray(0, this.#length);
        this.clear();
        return bytes;
    }
    clear() {
        this.#buffer = new Uint8Array(0);
        this.#length = 0;
    }
}
//# sourceMappingURL=stream-limits.js.map