export declare const DEFAULT_MAX_MESSAGE_BYTES: number;
export declare class MessageTooLargeError extends Error {
    readonly maxMessageBytes: number;
    constructor(maxMessageBytes: number);
}
export declare function resolveMaxMessageBytes(value: number | undefined): number;
export declare class MessageBuffer {
    #private;
    constructor(maxMessageBytes: number);
    get byteLength(): number;
    get lastByte(): number | undefined;
    append(bytes: Uint8Array): void;
    take(): Uint8Array;
    clear(): void;
}
