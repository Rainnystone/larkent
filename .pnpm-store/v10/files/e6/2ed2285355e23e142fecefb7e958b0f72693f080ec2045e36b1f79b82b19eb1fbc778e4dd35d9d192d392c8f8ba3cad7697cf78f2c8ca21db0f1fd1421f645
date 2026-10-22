import type { OutboundLease } from "./connection.js";
/**
 * Streams the JSON text of each message a lease yields as an SSE event. The
 * body takes a message only when its reader asks for one, so messages its
 * client has not read stay queued, and counted, in their connection.
 */
export declare function createSseBody(lease: OutboundLease<string>): ReadableStream<Uint8Array>;
