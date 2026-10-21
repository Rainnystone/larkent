import { Cache, Client, Domain, HttpInstance, Logger, LoggerLevel, WSClient, WSConfigOverrides, WSConnectionState, WSConnectionStatus, registerApp } from "@larksuiteoapi/node-sdk";

//#region src/comments.d.ts
/**
 * Cloud-doc comment surface (L4 outbound). Wraps the Feishu drive-comment
 * APIs and internalizes the quirks any bot integrating doc comments would
 * otherwise hit:
 *   - wiki node → underlying obj_token resolution
 *   - `fileComment.get` returning 1069307 for some comment types → `.list`
 *     pagination fallback
 *   - in-thread reply rejected with 1069302 on whole-document comments →
 *     fresh top-level comment fallback
 *   - comment reaction add/delete being the same endpoint with an `action`
 *     field (and not returning a reaction_id)
 *
 * Business concerns stay with the caller: which reply is "the question",
 * prompt assembly, markdown stripping, session mapping. This surface only
 * speaks the Feishu comment protocol.
 */
type CommentFileType = 'doc' | 'docx' | 'sheet' | 'file';
interface CommentTarget {
  fileToken: string;
  fileType: CommentFileType;
}
interface CommentReplyContentElement {
  type: 'text_run' | 'docs_link' | 'person';
  text_run?: {
    text: string;
  };
  docs_link?: {
    url: string;
  };
  person?: {
    user_id: string;
  };
}
interface CommentReply {
  reply_id?: string;
  content?: {
    elements?: CommentReplyContentElement[];
  };
}
interface FetchedComment {
  commentId: string;
  replies: CommentReply[];
  /** The text the user selected (inline comment); empty for whole-doc. */
  quote?: string;
  /** True when the comment targets the whole document rather than a selection. */
  isWhole: boolean;
}
declare class CommentSurface {
  private readonly client;
  private readonly logger;
  constructor(client: Client, logger: Logger);
  /**
   * Resolve the (fileToken, fileType) to hit for the comment APIs. If the
   * token is a wiki node, swap to its underlying obj_token; otherwise pass
   * through. Returns `null` when the file type is unsupported.
   */
  resolveTarget(fileToken: string, fileType: string): Promise<CommentTarget | null>;
  /**
   * Fetch a comment with its replies. Tries `fileComment.get`; for comment
   * types that return 1069307 there, falls back to paginating `.list` and
   * locating the comment by id. Returns `null` when not found.
   */
  fetch(target: CommentTarget, commentId: string): Promise<FetchedComment | null>;
  /**
   * Reply to a comment in-thread. Whole-document comments reject in-thread
   * replies with 1069302 (they have no thread, only a flat list) — in that
   * case post a fresh top-level comment instead.
   *
   * When the caller already knows the comment is whole-document (e.g. from
   * {@link FetchedComment.isWhole}), pass `{ topLevel: true }` to skip the
   * doomed in-thread probe and post top-level directly — saving one
   * round-trip. See {@link replyTopLevel} for the explicit form.
   */
  reply(target: CommentTarget, commentId: string, text: string, opts?: {
    topLevel?: boolean;
  }): Promise<void>;
  /**
   * Post a fresh top-level comment on the file (no in-thread probe). Use this
   * when you already know in-thread replies won't apply — chiefly
   * whole-document comments, where {@link reply} would otherwise waste a
   * round-trip discovering 1069302.
   */
  replyTopLevel(target: CommentTarget, text: string): Promise<void>;
  /**
   * Add a reaction to a comment reply. Doc-comment reactions use a dedicated
   * endpoint (separate from IM message reactions); add/delete are the same
   * POST distinguished by an `action` field, and it returns no reaction_id.
   * Returns `true` on success. Defaults to the "Typing" emoji.
   */
  addReaction(target: CommentTarget, replyId: string, emojiType?: string): Promise<boolean>;
  /** Remove a previously-added comment reaction. Same endpoint, action=delete. */
  removeReaction(target: CommentTarget, replyId: string, emojiType?: string): Promise<void>;
  private reaction;
  private findViaList;
}
//#endregion
//#region src/types.d.ts
type ChatType = 'p2p' | 'group';
interface NormalizedMessage {
  messageId: string;
  chatId: string;
  chatType: ChatType;
  /**
   * Finer-grained chat mode than {@link chatType}: distinguishes a topic
   * group ('topic') from an ordinary group ('group'). Only populated when
   * the channel is created with `resolveChatMode: true` — Feishu omits chat
   * mode from message events, so resolving it costs one cached `chat.get`
   * per chat. `undefined` when resolution is disabled or failed.
   */
  chatMode?: 'p2p' | 'group' | 'topic';
  senderId: string;
  senderName?: string;
  /**
   * Sender kind, passed through from the raw event's `sender.sender_type`
   * (`'user' | 'bot' | 'system' | 'anonymous'`; other values are possible, so
   * the type is a plain string). `undefined` when the event omits it — the kind
   * cannot be inferred, so treat `undefined` as "unknown", not "not a bot".
   */
  senderType?: string;
  /**
   * Convenience derived from {@link senderType}: `true` when it is `'bot'`,
   * `false` for any other present kind, `undefined` when `senderType` is absent
   * (so a missing signal is never mistaken for "not a bot").
   */
  senderIsBot?: boolean;
  content: string;
  rawContentType: string;
  resources: ResourceDescriptor[];
  mentions: MentionInfo[];
  mentionAll: boolean;
  mentionedBot: boolean;
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
  createTime: number;
  raw?: unknown;
}
interface ResourceDescriptor {
  type: 'image' | 'file' | 'audio' | 'video' | 'sticker';
  fileKey: string;
  fileName?: string;
  durationMs?: number;
  coverImageKey?: string;
}
interface MentionInfo {
  key: string;
  openId?: string;
  userId?: string;
  name?: string;
  isBot?: boolean;
}
interface BotIdentity {
  openId: string;
  userId?: string;
  name: string;
}
type SendInput = {
  markdown: string;
} | {
  text: string;
} | {
  post: object;
} | {
  image: {
    source: string | Buffer;
  };
} | {
  file: {
    source: string | Buffer;
    fileName: string;
  };
} | {
  audio: {
    source: string | Buffer;
    duration?: number;
  };
} | {
  video: {
    source: string | Buffer;
    duration?: number;
    coverImageKey?: string;
  };
} | {
  card: object;
} | {
  cardId: string;
} | {
  shareChat: {
    chatId: string;
  };
} | {
  shareUser: {
    userId: string;
  };
} | {
  sticker: {
    fileKey: string;
  };
};
interface MediaSource {
  source: string | Buffer;
}
interface SendOptions {
  replyTo?: string;
  replyInThread?: boolean;
  mentions?: MentionInfo[];
  /**
   * Rewrite plaintext `@<name>` tokens in a `{ text }` / `{ markdown }` body
   * into real `<at>` mentions, resolving each name against the target chat's
   * member roster. Unknown or ambiguous names are left as plaintext — an
   * unresolved `@xxx` is never turned into a mention. Off by default.
   */
  resolveMentionsInText?: boolean;
}
interface SendResult {
  messageId: string;
  chunkIds?: string[];
}
type StreamInput = {
  markdown: MarkdownStreamProducer;
} | {
  card: {
    initial: object;
    producer: CardStreamProducer;
  };
};
type MarkdownStreamProducer = (controller: MarkdownStreamController) => Promise<void>;
type CardStreamProducer = (controller: CardStreamController) => Promise<void>;
interface MarkdownStreamController {
  append(chunk: string): Promise<void>;
  setContent(full: string): Promise<void>;
  readonly messageId: string;
}
interface CardStreamController {
  update(next: object | ((current: object) => object)): Promise<void>;
  readonly messageId: string;
  readonly current: object;
}
/**
 * Response a `cardAction` handler may return to give the clicking user
 * native, immediate feedback (a toast, or an in-place card update). When a
 * handler returns one, the SDK passes it back to Feishu/Lark as the callback
 * response for that button click / form submit. Returning `undefined` (or
 * nothing) means "no immediate response" — the original, pre-existing
 * behavior.
 *
 * The shape is deliberately loose (passed through verbatim, not validated)
 * because Feishu's card-callback schema is broad and evolves. Common shapes:
 *
 *   // toast
 *   { toast: { type: 'success' | 'info' | 'error' | 'warning' | 'loading',
 *              content: string, i18n?: Record<string, string> } }
 *
 *   // update the card in place
 *   { card: { type: 'raw', data: { ... } } }
 *
 * Two caveats: the returned object is sent to Feishu as-is, so do **not** put
 * internal secrets / PII in it; and it must be JSON-serializable (cyclic
 * references / BigInt will throw when the response is encoded).
 */
type CardActionResponse = Record<string, unknown>;
interface EventMap {
  message: (msg: NormalizedMessage) => void | Promise<void>;
  /**
   * The bot was invited into a meeting. Single-slot like every other channel
   * event: one invite maps to one decision about whether to join.
   */
  meetingInvited: (evt: MeetingInvitedEvent) => void | Promise<void>;
  reject: (evt: RejectEvent) => void;
  cardAction: (evt: CardActionEvent) => void | CardActionResponse | Promise<void | CardActionResponse>;
  reaction: (evt: ReactionEvent) => void;
  botAdded: (evt: BotAddedEvent) => void;
  comment: (evt: CommentEvent) => void | Promise<void>;
  error: (err: LarkChannelError) => void;
  reconnecting: () => void;
  reconnected: () => void;
}
type EventName = keyof EventMap;
/**
 * Reason for a {@link RejectEvent}. These are the set of policy-level
 * decisions that deliberately reject a message and inform the caller.
 *
 * Internal defenses (duplicate dedup, stale/expired timestamps, in-flight
 * processing lock) silently drop their targets — they are not reject
 * reasons, because the caller cannot act on them meaningfully.
 *
 * `bot_loop` is emitted only by the opt-in {@link PolicyConfig.botLoopGuard}
 * when configured with `onTrip: 'reject'` (the default `'drop'` mode drops
 * silently, like the internal defenses).
 */
type RejectReason = 'group_not_allowed' | 'sender_not_allowed' | 'no_mention' | 'dm_disabled' | 'mention_all_blocked' | 'bot_loop';
interface RejectEvent {
  messageId: string;
  chatId: string;
  senderId: string;
  reason: RejectReason;
}
interface CardActionEvent {
  messageId: string;
  chatId: string;
  operator: {
    openId: string;
    userId?: string;
    name?: string;
  };
  action: {
    value: unknown;
    tag: string;
    name?: string;
    option?: string;
    /**
     * CardKit 2.0 form submission values, keyed by element name. Present
     * only on form-submit actions; `undefined` for plain button clicks.
     * Sunk from bridge, which previously had to enable `includeRawEvent`
     * just to read `action.form_value`.
     */
    formValue?: Record<string, unknown>;
  };
  raw?: unknown;
}
interface ReactionEvent {
  messageId: string;
  operator: {
    openId: string;
    userId?: string;
  };
  emojiType: string;
  action: 'added' | 'removed';
  actionTime?: number;
  raw?: unknown;
}
interface BotAddedEvent {
  chatId: string;
  operator: {
    openId: string;
    userId?: string;
  };
  /**
   * The bot's own name as carried in the `name` field of the Feishu event.
   * Not the chat's name — that requires a separate `getChatInfo(chatId)`
   * call, which callers can do on demand.
   */
  botName?: string;
  external?: boolean;
  raw?: unknown;
}
interface CommentEvent {
  fileToken: string;
  fileType: string;
  commentId: string;
  replyId?: string;
  operator: {
    openId: string;
    userId?: string;
    unionId?: string;
  };
  mentionedBot: boolean;
  timestamp: number;
  raw?: unknown;
}
type LarkChannelErrorCode = 'format_error' | 'target_revoked' | 'rate_limited' | 'permission_denied' | 'upload_failed' | 'ssrf_blocked' | 'send_timeout' | 'not_connected' /** The operation is unavailable in the current mode (e.g. posting from a followed meeting). */ | 'not_supported' /** No active meeting to follow, or the target meeting is no longer active. */ | 'meeting_not_found' /** {@link MeetingChannelConfig.maxConcurrentSessions} reached. */ | 'too_many_sessions' | 'unknown';
declare class LarkChannelError extends Error {
  code: LarkChannelErrorCode;
  cause?: unknown;
  context?: {
    to?: string;
    messageId?: string;
    attempt?: number;
    meetingId?: string;
    /**
     * Signed one-click authorization link returned with a permission failure.
     *
     * A credential in URL form, not a plain link: passed through byte for byte
     * because re-encoding invalidates the signature, validated as `https:` before
     * being surfaced at all, and never written to a log. Do not echo it into a
     * chat, a UI, or a support ticket.
     */
    consoleUrl?: string;
  };
  constructor(code: LarkChannelErrorCode, message: string, opts?: {
    cause?: unknown;
    context?: LarkChannelError['context'];
  });
}
interface LarkChannelOptions {
  appId: string;
  appSecret: string;
  transport?: 'websocket' | 'webhook';
  webhook?: WebhookOptions;
  safety?: SafetyConfig;
  policy?: PolicyConfig;
  outbound?: OutboundConfig;
  /**
   * Meeting-channel limits: concurrent sessions, idle reclamation, liveness
   * probing and the in-meeting send rate. See {@link MeetingChannelConfig}.
   */
  meeting?: MeetingChannelConfig;
  logger?: Logger;
  loggerLevel?: LoggerLevel;
  cache?: Cache;
  domain?: Domain | string;
  httpInstance?: HttpInstance;
  /** Caller tag appended to User-Agent as `source/<name>`. */
  source?: string;
  /**
   * Client-only WebSocket settings (currently `pingTimeout`). Forwarded
   * to the underlying WSClient. Server-pushed values like ping cadence,
   * reconnect interval / count are not exposed here — they stay
   * server-authoritative.
   */
  wsConfig?: WSConfigOverrides;
  /**
   * Maximum time (ms) a *single* WebSocket handshake (`open` / `error`) may
   * take before that attempt is aborted and the underlying retry loop tries
   * again. Forwarded as-is to the underlying WSClient. When unset, no
   * per-attempt timeout is enforced — one handshake can hang indefinitely on
   * stuck DNS / proxy / NAT paths.
   *
   * This is **not** the budget for how long `connect()` waits before giving
   * up; that is {@link connectTimeoutMs}.
   */
  handshakeTimeoutMs?: number;
  /**
   * Total time (ms) to wait for a WebSocket handshake to succeed before
   * giving up on the attempt. Applies both to `connect()` and to the
   * internal force-reconnect that keepalive triggers. On expiry the pending
   * `WSClient` is torn down and the caller gets a `not_connected`
   * `LarkChannelError` naming the elapsed budget.
   *
   * Defaults to 15000. `NaN`, `0`, negatives and non-finite values fall back
   * to the default; values above the timer's 32-bit ceiling (2147483647ms) are
   * clamped down to it. Both rules exist for the same reason: `setTimeout`
   * turns an out-of-domain delay into 1ms, which would silently invert both an
   * unset `Number(process.env.X)` and a deliberately generous budget.
   *
   * Distinct from {@link handshakeTimeoutMs}, which bounds one handshake
   * attempt; this bounds the wait as a whole.
   */
  connectTimeoutMs?: number;
  /**
   * Optional Node http(s) agent forwarded to the underlying WSClient for
   * the WebSocket transport. Useful for routing the WS through an HTTP(S)
   * proxy or for customizing TLS / keepalive.
   */
  agent?: any;
  /**
   * Attach the raw Feishu event body on every normalized event
   * (`message`, `cardAction`, `reaction`, `botAdded`, `comment`) as
   * `evt.raw`. Useful when a handler needs fields that the normalizer
   * dropped (e.g. `tenant_key`, `host`, `event_id`, vendor-specific
   * extensions). Off by default — payloads are smaller and stricter.
   */
  includeRawEvent?: boolean;
  /** @deprecated Use `includeRawEvent` instead. Retained for backward compatibility. */
  includeRawInMessage?: boolean;
  /**
   * Populate {@link NormalizedMessage.chatMode} on every inbound message by
   * resolving the chat's mode (p2p / group / topic) — which Feishu omits
   * from message events. Costs one cached `chat.get` per chat (best-effort;
   * falls back to 'group' on failure). Off by default to avoid the extra
   * API call for callers that don't need topic-group awareness.
   */
  resolveChatMode?: boolean;
  /**
   * Populate {@link NormalizedMessage.senderName} on inbound messages by
   * resolving the sender's display name from the chat's member roster (warmed
   * via a cached `getChatMembers`). Costs one cached members lookup per chat
   * (best-effort; degrades to `undefined` on failure). Off by default to avoid
   * the extra API call for callers that don't need names.
   */
  resolveSenderNames?: boolean;
  /**
   * Override how {@link LarkChannel.getChatMembers} obtains a chat's roster.
   * When provided and it returns a member array, that array is used and the
   * Feishu `im.v1.chatMembers.get` call is skipped (useful when the app already
   * has its own directory / cache). Return `undefined` to fall back to the API.
   * Results still flow through the internal roster cache.
   */
  resolveChatMembers?: (chatId: string) => ChatMember[] | undefined | Promise<ChatMember[] | undefined>;
  /**
   * App-level keepalive watchdog (defense-in-depth above the SDK's internal
   * ping). When enabled, an independent timer probes the connection and
   * force-reconnects the WebSocket if it looks stuck while the network is
   * reachable. `onUnrecoverable` fires when even a forced reconnect fails,
   * so the app can decide what to do (e.g. restart the process). WebSocket
   * transport only. Off by default.
   */
  keepalive?: {
    enabled?: boolean;
    onUnrecoverable?: (err: unknown) => void; /** Heartbeat interval in ms (default 15000). */
    intervalMs?: number;
  };
  /**
   * Per-request timeout (ms) for outbound REST calls. Without it a hung
   * Feishu API can block the bot indefinitely. Applied to node-sdk's shared
   * `defaultHttpInstance` (a process-wide singleton, so it also affects other
   * Clients using the default). Ignored when you supply your own
   * {@link httpInstance} — configure that instance yourself. Unset = no
   * client-side REST timeout.
   */
  httpTimeoutMs?: number;
  /**
   * Read `HTTPS_PROXY` / `HTTP_PROXY` from the environment and route traffic
   * through it: the WebSocket transport (via the WS `agent`, unless an
   * explicit {@link agent} is given) and outbound REST calls (via the shared
   * `defaultHttpInstance`, unless a custom {@link httpInstance} is supplied).
   * Off by default.
   */
  respectProxyEnv?: boolean;
}
interface WebhookOptions {
  verificationToken?: string;
  encryptKey?: string;
  adapter?: 'express' | 'koa' | 'koa-router';
}
interface SafetyConfig {
  dedup?: {
    ttl?: number;
    maxEntries?: number;
    sweepIntervalMs?: number;
  };
  chatQueue?: {
    enabled?: boolean;
    /**
     * While a chat's handler is in-flight, accumulate every newly-arrived
     * message and deliver them as a single merged batch the moment the
     * in-flight handler drains — instead of letting the debounce window
     * queue up multiple sequential batches. The `message` callback still
     * receives one merged {@link NormalizedMessage} (delivery shape
     * unchanged). Sunk from bridge's `pending-queue.ts`. Off by default.
     */
    mergeWhileBusy?: boolean;
    /**
     * Which per-chat queue `card.action.trigger` (the `cardAction` handler)
     * joins. Only meaningful while `enabled` is on.
     *
     * - `'same'` (default): card actions share the chat's queue with messages.
     *   A click runs after any in-flight work for that chat, and messages that
     *   arrive later wait for it — the 0.6.x behavior.
     * - `'separate'`: card actions get their own per-chat lane, independent of
     *   the message queue in both directions: a click no longer waits for an
     *   in-flight `message` handler, and messages do not wait for clicks.
     *   Clicks within one chat still run in arrival order. Use it when a
     *   `message` handler has to wait for a card click (agent tool approvals)
     *   — under `'same'` that is a deadlock.
     *
     * Any other value falls back to `'same'` with a warning at construction.
     * See the README's `cardAction` notes for what the application then owns.
     */
    cardActions?: 'same' | 'separate';
  };
  batch?: {
    text?: {
      delayMs?: number;
      longThresholdChars?: number;
      longDelayMs?: number;
      maxMessages?: number;
      maxChars?: number;
    };
    media?: {
      delayMs?: number;
      maxItems?: number;
    };
  };
  staleMessageWindowMs?: number;
}
interface PolicyConfig {
  /**
   * Chat allowlist for group messages — entries are **chat ids** (`oc_…`).
   * When non-empty, only listed chats are processed. Do **not** put an app id
   * (`cli_…`) here: it is not a chat id, so it silently matches nothing (the
   * SDK logs a warning if it sees one). This doubles as a lightweight
   * "allowFrom" for bot-at-bot: pair it with `requireMention` to scope the bot
   * to specific rooms without needing every sender's open_id.
   */
  groupAllowlist?: string[];
  dmMode?: 'open' | 'allowlist' | 'pair' | 'disabled';
  /**
   * Sender allowlist for DMs when `dmMode: 'allowlist'` — entries are **sender
   * ids** matching {@link NormalizedMessage.senderId}: an `open_id` (`ou_…`),
   * `user_id`, or `union_id`. Do **not** put an app id (`cli_…`) here: a real
   * sender is never a `cli_` id, so a `cli_` entry grants access to no one (the
   * SDK logs a warning if it sees one).
   */
  dmAllowlist?: string[];
  requireMention?: boolean;
  respondToMentionAll?: boolean;
  /**
   * Opt-in heuristic guard against two bots @-ing each other in an endless
   * ping-pong. Off by default. See {@link BotLoopGuardConfig} and the README:
   * the default `onTrip: 'drop'` silently mutes the bot, so prefer `'reject'`
   * when the app needs to know, and tune `windowMs` / `maxBotMentions` to the
   * expected collaboration tempo.
   */
  botLoopGuard?: BotLoopGuardConfig;
}
/** Configuration for the opt-in bot ping-pong guard ({@link PolicyConfig.botLoopGuard}). */
interface BotLoopGuardConfig {
  /** Enable the guard. Default `false`. */
  enabled?: boolean;
  /** Sliding-window width in ms. Default `60000`. */
  windowMs?: number;
  /** Trip once this many "another bot @'d me" messages fall inside the window. Default `5`. */
  maxBotMentions?: number;
  /** Count per chat, or per (chat, sender bot). Default `'chat'`. */
  scope?: 'chat' | 'chat+sender';
  /**
   * On trip: `'drop'` silently drops the message (debug log + one warn on the
   * first trip), `'reject'` emits a `reject` event with `reason: 'bot_loop'`.
   * Default `'drop'`.
   */
  onTrip?: 'drop' | 'reject';
}
interface OutboundConfig {
  textChunkLimit?: number;
  markdownConverter?: 'builtin' | ((md: string) => object);
  streamThrottleMs?: number;
  streamThrottleChars?: number;
  streamInitialText?: string;
  /**
   * Maximum character count of a single streaming card's markdown element
   * before the controller rolls over to a new card. Feishu enforces a
   * per-element size limit on `cardkit.cardElement.content` updates; once
   * cumulative AI output approaches that limit, further updates are
   * rejected with `code: 230099 / ErrCode: 11310 "element exceeds the
   * limit"`. The controller pre-emptively splits and creates a follow-up
   * card so generation can continue without interruption.
   *
   * Default: 30000.
   */
  streamMaxElementChars?: number;
  ssrfGuard?: boolean | {
    allowlist?: string[];
  };
  /**
   * Allowlist of directories that a **local file** media `source` may be read
   * from. **Required for local file sources: when unset (or empty), local file
   * paths are rejected outright** — only `Buffer` and `http(s)` URL sources
   * work without it. This default-deny avoids reading arbitrary files
   * (`~/.ssh/id_rsa`, `.env`, …) when `source` is attacker-influenced. When
   * set, every path must resolve inside one of these directories, a POSIX
   * blocklist (`/etc/`, `/proc/`, `/sys/`, `/dev/`) still applies, and symlink
   * targets are re-checked after `realpath`.
   */
  allowedFileDirs?: string[];
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
  };
}
interface ChatInfo {
  chatId: string;
  name?: string;
  description?: string;
  chatType: 'p2p' | 'group';
  ownerId?: string;
  memberCount?: number;
}
/** One member from {@link LarkChannel.getChatMembers}. */
interface ChatMember {
  /** Member id in the requested {@link idType} (default `open_id`). */
  id: string;
  idType?: IdType;
  name?: string;
  tenantKey?: string;
  /**
   * Whether the member is a bot. Members returned by `getChatMembers` are
   * always **users** — Feishu's chat-members API filters bots out — so this is
   * `false`/`undefined` there. It exists for roster entries harvested from
   * other sources (e.g. inbound mentions) that can carry bots.
   */
  isBot?: boolean;
}
type IdType = 'open_id' | 'user_id' | 'union_id';
interface CreateChatOptions {
  name: string;
  description?: string;
  /** Users to seed the new chat with. Interpreted per {@link userIdType}. */
  inviteUserIds?: string[];
  /** ID convention for {@link inviteUserIds}. Defaults to `'open_id'`. */
  userIdType?: IdType;
  /** Defaults to `'group'`. */
  chatMode?: 'group';
  /** Visibility — `'private'` (default) or `'public'`. */
  chatType?: 'private' | 'public';
}
/** One entry from {@link LarkChannel.listChats}. */
interface ChatSummary {
  id: string;
  name: string;
}
/** Subset of `application.v6.application.get` the channel surfaces. */
interface AppInfo {
  /** open_id (or the requested id type) of the app's owner/admin. */
  ownerId?: string;
  appName?: string;
}
type ResourceType = 'image' | 'file';
//#endregion
//#region src/meeting/types.d.ts
type Unsubscribe$1 = () => void;
/**
 * How the follow path obtains a user access token.
 *
 * A plain string is the simple case. A function is re-invoked before every poll round,
 * which lets a meeting outlast a shorter-lived token — this SDK never touches
 * `refresh_token` and never persists a credential.
 *
 * The name is kept under 20 characters because the repo's secret scanner reads a longer
 * type in a `userAccessToken:` annotation as a leaked credential.
 */
type MeetingTokenSource = string | (() => string | Promise<string>);
interface MeetingOptions {
  /**
   * Debounce window for caption settling, in ms. Default `0`.
   *
   * `0` forwards every update, so callers see a sentence grow word by word — the
   * right shape for streaming a caption or feeding a model continuously. A
   * positive value delivers a sentence only once it has stopped changing for
   * that long, at the cost of one window of latency (and of never settling while
   * someone talks without pause).
   */
  stabilizeMs?: number;
}
interface FollowMeetingOptions extends MeetingOptions {
  /** Required: path one authenticates as the user, never as the app. */
  userAccessToken: MeetingTokenSource;
  /** Which meeting to follow when the user is in several at once. */
  meetingNo?: string;
}
interface JoinMeetingOptions extends MeetingOptions {
  /** Password-protected meetings. Passed through to `bots/join`. */
  password?: string;
  /** From {@link MeetingInvitedEvent.callId}, when joining off an invite. */
  callId?: string;
}
interface MeetingChannelConfig {
  /**
   * Ceiling on concurrent sessions. Default `32`. Sessions are started by whoever calls
   * the bot into a meeting, so their number is not under the application's control.
   *
   * Admission is refused before `bots/join` goes out, so a refusal never parks the bot
   * in a meeting with no session behind it. A soft limit: overlapping joins for
   * *different* meetings can each pass the check and briefly exceed it by the number in
   * flight.
   */
  maxConcurrentSessions?: number;
  /**
   * Reclaim a TAT session that has seen no activity for this long, in ms.
   * **Default `0` — off.** Follow-mode sessions are unaffected.
   *
   * `0`: no reclamation. A session then ends only on `meeting_ended_v1`, on a probe
   * confirming the bot has left, or on an explicit {@link MeetingSession.leave} /
   * {@link MeetingSession.dispose}.
   *
   * A positive value: no activity for that long → end the session, call `bots/leave`,
   * return the concurrency slot. The leave is not optional, because a reclaimed session
   * leaves no handle to leave with. Any delivered activity resets the timer, including
   * what the probe pulls in while catching up.
   *
   * Enable it where the probe cannot be relied on (a missing scope, `bot.events`
   * unreachable for long stretches), or where handlers may block for a long time — a
   * blocked handler stops the timer being reset and also blocks the queue the probe
   * uses, leaving nothing to reclaim the session.
   */
  idleTimeoutMs?: number;
  /**
   * How often to confirm the bot is still in the meeting, in ms.
   * Default `300000` (5 min); `0` disables.
   *
   * Backstop for the cases that produce no `meeting_ended_v1` at all — the bot
   * being removed by a host, or the meeting changing hands.
   */
  livenessProbeIntervalMs?: number;
  /**
   * Cap on in-meeting messages per session per minute. Default `20`.
   *
   * A bot's own messages come back as `chat_received`, so a handler that
   * answers without checking `selfEcho` self-triggers at network speed. This
   * bounds the damage.
   */
  sendRateLimitPerMinute?: number;
}
interface MeetingActor {
  /**
   * The actor's `open_id`. The meeting APIs are always asked for `open_id`, so this
   * shares a namespace with the bot's own id and {@link MeetingEventBase.selfEcho} can
   * compare them.
   */
  id: string;
  /** Untrusted: a display name chosen by a participant, guests included. */
  name?: string;
  userType?: number;
  userRole?: number;
}
interface MeetingEventBase {
  meetingId: string;
  actor: MeetingActor;
  /**
   * The item was produced by this bot — a message echoed back, or its own speech
   * transcribed into the caption stream. Flagged but still delivered, so dropping it is
   * the caller's decision.
   *
   * Fails safe: reports `true` while the bot's own `open_id` is unresolved, since
   * `false` means "not me" and would let a self-sustaining loop through. Always `false`
   * in follow mode.
   */
  selfEcho: boolean;
  /** Raw platform payload; present only when `includeRawEvent` is set. */
  raw?: unknown;
}
interface MeetingTranscriptEvent extends MeetingEventBase {
  /** Untrusted: spoken content, transcribed verbatim. */
  text: string;
  /**
   * Stable id for one sentence. Deliveries of the same id supersede earlier ones —
   * nothing on the wire marks which send is final, so callers upsert on this rather than
   * append. "Later" is decided by {@link endMs} where both sends carry one, not by
   * arrival: a session ingests from two transports and they can interleave.
   */
  sentenceId?: string;
  language?: string;
  startMs?: number;
  endMs?: number;
}
interface MeetingChatEvent extends MeetingEventBase {
  /** Untrusted: written by a participant. */
  content: string;
  messageId?: string;
  messageType?: number;
  sendTime?: number;
}
interface MeetingParticipantEvent extends MeetingEventBase {
  action: 'joined' | 'left';
  joinTime?: number;
  leaveTime?: number;
  leaveReason?: number;
}
interface MeetingSharedDoc {
  /** Untrusted: a URL chosen by whoever shared the document. */
  url?: string;
  /** Untrusted: a document title. */
  title?: string;
}
interface MeetingShareEvent extends MeetingEventBase {
  action: 'started' | 'ended';
  shareId?: string;
  doc?: MeetingSharedDoc;
  time?: number;
}
/**
 * A context change inside a shared document. Identifiers only, never content: a comment
 * arrives as a `commentId`, an image or board as an `elementToken`. Fetching the text or
 * asset is left to the caller.
 */
interface MeetingDocumentContextEvent extends MeetingEventBase {
  /**
   * Derived from which sub-object is present: the `context_type` the prose docs describe
   * does not exist in the generated API surface. A platform-sent `context_type` wins
   * when it does show up.
   */
  contextType: 'commentFocus' | 'sectionLocation' | 'elementPreview';
  shareId?: string;
  doc?: MeetingSharedDoc;
  time?: number;
  commentFocus?: {
    commentId?: string;
    focused?: boolean;
  };
  sectionLocation?: {
    title?: string;
    level?: number;
    parentTitles?: string[];
  };
  elementPreview?: {
    action?: string;
    elementType?: string; /** Untrusted: an opaque token identifying a document element. */
    elementToken?: string;
    blockId?: string;
  };
}
interface MeetingEndEvent {
  meetingId: string;
  reason: MeetingEndReason;
}
type MeetingEndReason = /** TAT: `vc.bot.meeting_ended_v1` arrived. */'meeting_ended' /** UAT: the meeting left the active list. TAT: the probe confirmed departure. */ | 'no_longer_active' /** TAT: no activity for `idleTimeoutMs`. */ | 'idle_timeout' /** The event source stopped unrecoverably — a rejected token, or repeated failures. */ | 'error' /** {@link MeetingSession.leave} was called. */ | 'left' /** {@link MeetingSession.dispose} was called, directly or via `disconnect()`. */ | 'disposed';
interface MeetingEventMap {
  transcript: (e: MeetingTranscriptEvent) => void | Promise<void>;
  chat: (e: MeetingChatEvent) => void | Promise<void>;
  participant: (e: MeetingParticipantEvent) => void | Promise<void>;
  share: (e: MeetingShareEvent) => void | Promise<void>;
  documentContext: (e: MeetingDocumentContextEvent) => void | Promise<void>;
  end: (e: MeetingEndEvent) => void | Promise<void>;
  error: (err: LarkChannelError) => void;
}
type MeetingEventName = keyof MeetingEventMap;
/**
 * The bot was invited into a meeting. Channel-level rather than session-level: no
 * session exists yet when it arrives.
 */
interface MeetingInvitedEvent {
  /** The 9-digit number `joinMeeting` takes. */
  meetingNo: string;
  meetingId?: string;
  /** Untrusted: the meeting title, free text from its creator. */
  topic?: string;
  inviter?: MeetingActor;
  bot?: MeetingActor;
  /** Pass to `joinMeeting` when joining off a call-style invite. */
  callId?: string;
  inviteTime?: number;
  raw?: unknown;
}
interface MeetingActivityStats {
  /** Activities of this type received. */
  received: number;
  /** How many of them unpacked to no items at all. */
  empty: number;
}
/** A meeting the bot is a participant of, and the number needed to re-attach to it. */
interface MeetingMembership {
  meetingId: string;
  /** The 9-digit number {@link MeetingSession} was joined with — what `joinMeeting` takes. */
  meetingNo: string;
}
/** Activity counters for one inbound link. */
interface MeetingLinkHealth {
  received: number;
  lastAt?: number;
  stats: Record<string, MeetingActivityStats>;
}
/** Event pushes, which arrive over the channel's own connection. */
interface MeetingPushHealth extends MeetingLinkHealth {
  /**
   * Whether the channel's internal `vc.bot.*` handlers are registered — set by
   * `connect()`. It describes registration, not connectivity: it stays `true` across a
   * dropped and reconnecting WebSocket.
   */
  registered: boolean;
  /** Why registration has not taken effect, when it has not. */
  reason?: string;
}
/** REST reads: every follow session's poll loop, and the probe's gap-recovery read. */
interface MeetingPollHealth extends MeetingLinkHealth {
  /** Live follow sessions, so `received: 0` with no sessions is not a fault. */
  sessions: number;
}
/**
 * Diagnostics for the in-meeting event path, whose failures are silent: a missing
 * subscription, a missing scope and a renamed field all look the same from outside.
 *
 * Counted per link rather than in one total. The two are independent — pushes can stop
 * while polling keeps working — and a single total would let either one's traffic stand
 * in for the other's health. The split is by transport, not by session identity: an
 * app-identity session's liveness probe reads over REST, so what it recovers counts
 * under `poll`.
 *
 * Within a link, `received` and `empty` separate "the platform never sent it" from "it
 * arrived and could not be read" — opposite investigations.
 */
interface MeetingEventHealth {
  push: MeetingPushHealth;
  poll: MeetingPollHealth;
}
interface MeetingSession {
  /** Long meeting id, the one every API but `bots/join` takes. */
  readonly meetingId: string;
  /** 9-digit meeting number. */
  readonly meetingNo: string;
  /** Untrusted: free text from the meeting's creator. */
  readonly topic?: string;
  readonly mode: 'uat' | 'tat';
  /**
   * Subscribe. Multicast, unlike the channel's own single-slot `on()`: the returned
   * function removes only the handler it was returned for.
   *
   * Handlers are awaited before the next item is delivered, because order carries
   * meaning — a share hand-off arrives as an `ended` followed by a `started` in one
   * delivery. A slow handler therefore holds up the stream.
   */
  on<K extends MeetingEventName>(name: K, handler: MeetingEventMap[K]): Unsubscribe$1;
  /**
   * Send an in-meeting message. TAT only; in follow mode the bot is not in the
   * meeting, so this rejects with `not_supported`.
   */
  sendMessage(text: string): Promise<void>;
  /** Per-activity-type parse counters for this session. */
  getStats(): Record<string, MeetingActivityStats>;
  /**
   * Stop timers and subscriptions without calling any API. Idempotent.
   *
   * The bot stays in the meeting, so a reconnect does not evict it — which also means a
   * process must `leave()` before exiting.
   */
  dispose(): void;
  /**
   * Leave the meeting, give up the concurrency slot, then end the session. Idempotent,
   * and **still effective after the session has already ended** — including after
   * `dispose()` or `disconnect()`.
   *
   * Teardown does not depend on the API call succeeding: `bots/leave` is most likely to
   * fail exactly when a meeting has just ended. The failure surfaces through `error`.
   */
  leave(): Promise<void>;
}
//#endregion
//#region src/normalize/context.d.ts
interface RawMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: RawMention[];
  };
}
interface RawMention {
  key: string;
  id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  name?: string;
  tenant_key?: string;
}
interface ApiMessageItem {
  message_id?: string;
  upper_message_id?: string;
  msg_type?: string;
  body?: {
    content?: string;
  };
  mentions?: RawMention[];
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
  };
  create_time?: string | number;
}
//#endregion
//#region src/normalize/bot-added.d.ts
interface RawBotAddedEvent {
  chat_id?: string;
  operator_id?: {
    open_id?: string;
    user_id?: string | null;
    union_id?: string;
  };
  external?: boolean;
  /** The bot's name (NOT the chat's name). */
  name?: string;
  /** The bot's localized names. */
  i18n_names?: {
    zh_cn?: string;
    en_us?: string;
    ja_jp?: string;
  };
}
declare function normalizeBotAdded(event: RawBotAddedEvent, opts?: {
  includeRaw?: boolean;
}): BotAddedEvent | null;
//#endregion
//#region src/normalize/card-action.d.ts
interface RawCardActionEvent {
  /**
   * Current shape (observed from `card.action.trigger` v2): message/chat ids
   * are nested under `context`. Top-level variants kept as fallback in case
   * older or alternate surfaces (webhook vs WS, older schema) still deliver
   * them at the root.
   */
  context?: {
    open_message_id?: string;
    open_chat_id?: string;
  };
  open_message_id?: string;
  open_chat_id?: string;
  token?: string;
  operator?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
    name?: string;
  };
  action?: {
    value?: unknown;
    tag?: string;
    name?: string;
    option?: string;
    timezone?: string; /** CardKit 2.0 form submission values, keyed by element name. */
    form_value?: Record<string, unknown>;
  };
}
declare function normalizeCardAction(event: RawCardActionEvent, opts?: {
  includeRaw?: boolean;
}): CardActionEvent | null;
//#endregion
//#region src/normalize/comment.d.ts
interface RawCommentEvent {
  app_id?: string;
  file_token?: string;
  file_type?: string;
  comment_id?: string;
  reply_id?: string;
  /** Whether the bot was mentioned. Top-level in current payload. */
  is_mentioned?: boolean;
  /** Millisecond timestamp of the event. */
  create_time?: string;
  notice_meta?: {
    from_user_id?: {
      open_id?: string;
      user_id?: string | null;
      union_id?: string;
    };
    to_user_id?: {
      open_id?: string;
      user_id?: string | null;
      union_id?: string;
    };
    file_token?: string;
    file_type?: string;
    timestamp?: string;
    is_mentioned?: boolean;
    notice_type?: string;
  };
  is_mention?: boolean;
  user_id?: {
    open_id?: string;
    user_id?: string | null;
    union_id?: string;
  };
  action_time?: string;
}
declare function normalizeComment(event: RawCommentEvent, opts?: {
  includeRaw?: boolean;
}): CommentEvent | null;
//#endregion
//#region src/normalize/reaction.d.ts
interface RawReactionEvent {
  message_id?: string;
  reaction_type?: {
    emoji_type?: string;
  };
  operator_type?: string;
  user_id?: {
    open_id?: string;
    user_id?: string | null;
    union_id?: string;
  };
  action_time?: string;
}
declare function normalizeReaction(event: RawReactionEvent, action: 'added' | 'removed', opts?: {
  includeRaw?: boolean;
}): ReactionEvent | null;
//#endregion
//#region src/normalize/index.d.ts
interface NormalizeOptions {
  botIdentity: BotIdentity;
  stripBotMentions?: boolean;
  includeRaw?: boolean;
  fetchSubMessages?: (messageId: string) => Promise<ApiMessageItem[]>;
  resolveUserName?: (openId: string) => string | undefined;
  resolveSenderName?: (openId: string) => string | undefined;
  batchResolveNames?: (openIds: string[]) => Promise<void>;
}
/**
 * Normalize a raw Feishu message event into a NormalizedMessage.
 *
 * Pipeline:
 *   1. Extract mentions → build key/openId maps + bot detection
 *   2. For `interactive` type, fetch full v2 card content if capability available
 *   3. Build ConvertContext with injected capabilities
 *   4. Dispatch to the matching converter (uniform error containment inside)
 *   5. Run resolveMentions second pass — replace placeholders with @name
 *   6. Assemble and return NormalizedMessage
 */
declare function normalize(event: RawMessageEvent, opts: NormalizeOptions): Promise<NormalizedMessage>;
//#endregion
//#region src/channel.d.ts
type Unsubscribe = () => void;
/** Options for {@link LarkChannel.getChatMembers}. */
interface GetChatMembersOptions {
  pageSize?: number;
  maxPages?: number;
  idType?: IdType;
  /** Skip the roster cache and refetch. */
  force?: boolean;
}
declare class LarkChannel {
  readonly rawClient: Client;
  rawWsClient?: WSClient;
  botIdentity?: BotIdentity;
  /** Cloud-doc comment surface: fetch / reply / reactions with quirk fallbacks. */
  readonly comments: CommentSurface;
  /**
   * Meeting channel internals. Private so its wiring methods do not become de
   * facto public API of a pre-1.0 package — the supported surface is
   * {@link joinMeeting}, {@link followMyMeeting} and {@link getMeetingEventHealth}.
   */
  private readonly meetings;
  private readonly opts;
  private readonly logger;
  private readonly dispatcher;
  private readonly handlers;
  private connectPromise?;
  private connected;
  private readonly sender;
  private readonly safety;
  private readonly chatModeCache;
  private readonly chatMemberCache;
  private keepaliveHandle?;
  private proxyAgent?;
  /**
   * The channel's own dispatcher handlers, keyed by event type. Read at dispatch
   * time rather than captured, so `onRawEvent` can compose with them whether it
   * is called before or after `connect()`.
   */
  private builtinHandlers;
  private readonly rawHandlers;
  /**
   * Event types already wired into the dispatcher. `EventDispatcher.register`
   * logs an error when a key is re-registered, so each type gets exactly one
   * composed entry and the composition reads mutable state instead.
   */
  private readonly dispatchedTypes;
  constructor(opts: LarkChannelOptions);
  connect(): Promise<void>;
  private doConnect;
  private startKeepaliveIfEnabled;
  /**
   * Tear down the current WebSocket and re-establish it. Used by the
   * keepalive watchdog when the connection looks stuck. Throws if the fresh
   * handshake fails, so keepalive can surface it via `onUnrecoverable`.
   */
  private forceReconnect;
  /**
   * Shared by `connect()` and `forceReconnect()` so the two can't drift apart.
   * Value domain and the reason for the fallback: see
   * {@link LarkChannelOptions.connectTimeoutMs}.
   */
  private resolveConnectTimeoutMs;
  /**
   * Apply a per-request timeout and/or proxy to node-sdk's shared
   * `defaultHttpInstance` (a typed `AxiosInstance` — `defaults` is visible,
   * no cast needed). Only runs when the caller opted in, and only when no
   * custom `httpInstance` was supplied: a caller who brings their own HTTP
   * instance owns its configuration, and we don't mutate a process-wide
   * singleton behind their back.
   */
  private configureHttp;
  /**
   * Resolve the Node http(s) agent for the WebSocket transport: an explicit
   * `agent` option wins; otherwise, when `respectProxyEnv` is set, build one
   * from `HTTPS_PROXY` / `HTTP_PROXY`.
   */
  private resolveWsAgent;
  /** Lazily build (and cache) a proxy agent from the proxy env vars. Shared
   *  by the WebSocket transport and the REST HTTP instance. */
  private proxyAgentFromEnv;
  /**
   * Construct the underlying WSClient and wait for its `onReady` callback —
   * so `connect()` only resolves after the first WebSocket handshake
   * actually succeeds. Rejects on `onError` or if the handshake doesn't
   * complete within `timeoutMs`.
   *
   * Also wires `onReconnecting` / `onReconnected` callbacks to emit the
   * corresponding public events.
   */
  private connectWebSocket;
  disconnect(): Promise<void>;
  /**
   * Snapshot of the WebSocket lifecycle (state, last/next connect times,
   * current reconnect attempts). Returns `undefined` when the channel
   * hasn't initialized a WSClient yet (e.g., before `connect()` is called
   * or under the webhook transport).
   */
  getConnectionStatus(): WSConnectionStatus | undefined;
  /**
   * This bot's own identity ({@link BotIdentity}) — useful to inline into an
   * agent's system prompt ("you are @… / your open_id is …") so it can tell
   * itself apart from other bots and decide whom to reply to. Resolved during
   * {@link connect}; throws `LarkChannelError('not_connected')` if called
   * before then, rather than returning `undefined`, so callers don't silently
   * build a prompt with a missing identity.
   */
  getBotIdentity(): BotIdentity;
  on<K extends EventName>(name: K, handler: EventMap[K]): Unsubscribe;
  on(handlers: Partial<EventMap>): Unsubscribe;
  private attachSingle;
  send(to: string, input: SendInput, opts?: SendOptions): Promise<SendResult>;
  stream(to: string, input: StreamInput, opts?: SendOptions): Promise<SendResult>;
  /**
   * Reply to a received message: defaults `replyTo` to `msg.messageId` and,
   * when the trigger is inside a topic thread (`msg.threadId` present), keeps
   * the reply in that thread — fixing the common "replied to the wrong place /
   * fell out of the topic" mistake of computing the reply target by hand.
   * `opts` overrides either default. Semantically a {@link send}; streaming
   * replies still use `stream(to, input, { replyTo })`.
   */
  reply(msg: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'threadId'>, input: SendInput, opts?: SendOptions): Promise<SendResult>;
  /**
   * Resolve "@name" into real mentions against the target chat's roster before
   * sending: fill `openId` on name-only structured mentions, and — when
   * `resolveMentionsInText` is set — rewrite `@name` tokens in a text/markdown
   * body. Both no-ops when there is nothing to resolve, so the default send
   * path is untouched.
   */
  private resolveOutboundMentions;
  updateCard(messageId: string, card: object): Promise<void>;
  /**
   * Create a standalone CardKit 2.0 card entity (`cardkit.v1.card.create`) and
   * return its `card_id`. The card isn't attached to any message yet — send a
   * message that references it via `channel.send(to, { cardId })`, then drive
   * it with {@link updateCardById}. This is the managed-card lifecycle: one
   * entity, many in-place updates, decoupled from the message that displays it.
   */
  createCard(cardJson: object): Promise<{
    cardId: string;
  }>;
  /**
   * Full-content update of a card entity by `card_id` (`cardkit.v1.card.update`).
   * `sequence` must strictly increase across calls for the same card — Feishu
   * rejects stale/out-of-order sequences so a slow update can't overwrite a
   * newer one. Unlike {@link updateCard} (which targets a message_id), this
   * updates the shared entity, so every message referencing the card_id
   * re-renders.
   */
  updateCardById(cardId: string, cardJson: object, sequence: number): Promise<void>;
  /**
   * Edit an already-sent message's text/post content. Uses `im.v1.message.update`
   * which (per Feishu docs) only supports editing text and rich-text (post)
   * messages. For cards, use {@link updateCard} instead — a wrong attempt to
   * use this on a card would hit the same API and fail with a clearer
   * Feishu-side error.
   */
  editMessage(messageId: string, text: string): Promise<void>;
  recallMessage(messageId: string): Promise<void>;
  /**
   * Add an emoji reaction to a message. Returns the `reaction_id` Feishu
   * assigned — stash it if you want to {@link removeReaction} later,
   * since the raw `im.message.reaction.*_v1` events don't carry the id.
   * Only the bot's own reactions can be removed.
   */
  addReaction(messageId: string, emojiType: string): Promise<string>;
  /**
   * Remove a reaction by its `reaction_id` (the value returned from
   * {@link addReaction}). Only the bot's own reactions can be removed —
   * removing a user-added reaction will fail with a Feishu permission
   * error.
   */
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  /**
   * Convenience: remove the bot's reaction on `messageId` matching
   * `emojiType`, without needing the `reaction_id`. Lists the message's
   * reactions filtered by emoji, picks the one added by this bot
   * (operator_type === 'app'), and deletes it. Returns `true` if a
   * matching reaction was found and deleted, `false` otherwise (including
   * the case where the bot never added that emoji).
   */
  removeReactionByEmoji(messageId: string, emojiType: string): Promise<boolean>;
  /**
   * Download a resource (image / file / audio / video / sticker) carried by a
   * **received** message. Feishu serves message resources via
   * `im.v1.messageResource.get`, which needs both the owning `messageId` and
   * the resource's `fileKey` — the `im/v1/images|files/:key` endpoints only
   * work for media the app itself uploaded and return 400 for received media.
   *
   * `type` is `'image'` for image resources, `'file'` for everything else
   * (file / audio / video / sticker) — matching `ResourceDescriptor.type`.
   */
  downloadResource(messageId: string, fileKey: string, type: ResourceType): Promise<Buffer>;
  /**
   * Like {@link downloadResource}, but also returns the server's response
   * `content-type` (when present). Feishu's `im.v1.messageResource.get`
   * carries the resource's real MIME in the response headers — needed to pick
   * an accurate file extension. `contentType` is the media type with any
   * parameters (e.g. `; charset=...`) stripped, or `undefined` when the header
   * is absent (e.g. a defensive raw-`Buffer` response). Callers should fall
   * back to a per-kind default in that case.
   */
  downloadResourceWithMeta(messageId: string, fileKey: string, type: ResourceType): Promise<{
    buffer: Buffer;
    contentType?: string;
  }>;
  /**
   * Stream a message resource straight to `destPath` without ever holding the
   * whole payload in memory — the HTTP response is `pipe`d to the file, so a
   * 100 MB attachment costs only stream-buffer overhead, not 100 MB of JS
   * heap. Prefer this over {@link downloadResource} /
   * {@link downloadResourceWithMeta} whenever the bytes are headed for disk
   * (e.g. a size-limited attachment cache): those materialize a full `Buffer`
   * via `Buffer.concat`, which can OOM the process when several large
   * downloads run concurrently.
   *
   * Returns the server `content-type` (params stripped; `undefined` when
   * absent) for MIME/extension detection, and the number of bytes written.
   * The parent directory of `destPath` must already exist.
   */
  downloadResourceToFile(messageId: string, fileKey: string, type: ResourceType, destPath: string): Promise<{
    contentType?: string;
    bytesWritten: number;
  }>;
  /**
   * Create a group chat (`im.v1.chat.create`) and return its `chat_id`.
   * `inviteUserIds` seeds the membership; the ids are interpreted per
   * `userIdType` (default `'open_id'`). Requires the `im:chat` scope.
   */
  createChat(opts: CreateChatOptions): Promise<{
    chatId: string;
  }>;
  /**
   * List the chats this bot is a member of (`im.v1.chat.list`), following
   * pagination automatically. `pageSize` is clamped to Feishu's max of 100;
   * `maxPages` caps how many pages are fetched (default 10) so an account in
   * thousands of chats can't spin forever. Returns `{ id, name }` per chat.
   */
  listChats(opts?: {
    pageSize?: number;
    maxPages?: number;
  }): Promise<ChatSummary[]>;
  /**
   * Fetch this app's own metadata (`application.v6.application.get`) — the
   * `app_id` is the one the channel was constructed with, so callers don't
   * pass it. Primarily used to resolve the app owner/admin (`ownerId`) for
   * access control. Requires the application-info scope.
   */
  getAppInfo(opts?: {
    lang?: 'zh_cn' | 'en_us' | 'ja_jp';
    userIdType?: 'open_id' | 'user_id' | 'union_id';
  }): Promise<AppInfo>;
  getChatInfo(chatId: string): Promise<ChatInfo>;
  /**
   * Fetch the chat's mode via `im.v1.chat.get`. Returns one of:
   *   - 'p2p'   — direct (1:1) chat
   *   - 'group' — ordinary group
   *   - 'topic' — topic group
   *
   * Unknown / missing values fall back to 'group' for consistency with
   * {@link getChatInfo}. The underlying API call is not cached — chat
   * mode rarely changes within a chat's lifetime, so callers that read
   * this on every inbound message should keep their own cache keyed by
   * `chatId`.
   *
   * Throws on API failure (network, permission, invalid chatId) so the
   * caller can decide how to handle it; silently defaulting would hide
   * real problems.
   */
  getChatMode(chatId: string): Promise<'p2p' | 'group' | 'topic'>;
  /**
   * List a chat's members (`im.v1.chatMembers.get`), following pagination.
   * Returns **users only** — Feishu's chat-members API filters bots out, so
   * `isBot` is never `true` here. Use {@link getChatBots} for the bots.
   * `pageSize` is clamped to Feishu's max of 100; `maxPages` (default 10) caps
   * paging. Results are cached per chat and reused by `senderName` resolution
   * and "@name → open_id"; a second call hits the cache and `force` bypasses
   * it. A `resolveChatMembers` option, if provided, overrides the API.
   * Throws {@link LarkChannelError} on API failure.
   */
  getChatMembers(chatId: string, opts?: GetChatMembersOptions): Promise<ChatMember[]>;
  private fetchChatMembers;
  /**
   * List the **bots** in a chat (`GET .../members/bots`) — the companion to
   * {@link getChatMembers}, which returns users only (Feishu filters bots from
   * that list). Returns {@link ChatMember}s with `isBot: true`, and seeds them
   * into the roster so another bot can be `@`-ed by name **without** having
   * appeared in an inbound mention first. Cached per chat like
   * {@link getChatMembers} (`force` bypasses). Throws {@link LarkChannelError}
   * on API failure.
   *
   * There is no typed node-sdk method for this endpoint, so it goes through the
   * raw request; the response is `{ data: { items: [{ bot_id, bot_name }] } }`.
   */
  getChatBots(chatId: string, opts?: {
    force?: boolean;
  }): Promise<ChatMember[]>;
  private fetchChatBots;
  /** Warm the roster for `senderName` resolution; failures degrade silently. */
  private warmChatRoster;
  /**
   * Record identities seen in a message's mentions (incl. bots) into the
   * roster, so a bot that has "shown its face" can later be @'d by name.
   * Source is 'mention' so it never overwrites authoritative API user names.
   */
  private collectMentionsIntoRoster;
  /**
   * Fetch a message by id and return it as a {@link NormalizedMessage} — the
   * same shape live `message` events produce. Useful for resolving a
   * reply-quoted message: `im.v1.message.get` returns a flat item list
   * (parent + descendants for merge_forward), which this method feeds back
   * through {@link normalize} so merge_forward gets the same
   * `<forwarded_messages>` expansion as live events.
   *
   * Sunk from bridge's `quote.ts`, which previously synthesized a fake raw
   * event and called the internal `normalize()` directly. Returns
   * `undefined` when the message can't be fetched or has no parent item.
   * `stripBotMentions` is off here so the raw quoted content is preserved.
   */
  /**
   * Fetch a message's raw `data.items[]` (`im.v1.message.get`) without running
   * them through {@link normalize} — for callers that need fidelity the
   * normalizer drops: original `body.content` JSON, `mentions`, `sender.id`,
   * `create_time`. For merge_forward the list is the parent followed by its
   * descendants (each carrying `upper_message_id`).
   *
   * `cardContentType` maps to the `card_msg_content_type` query param.
   * Defaults to `'user_card_content'` so interactive messages return the
   * original CardKit 2.0 card JSON (`user_dsl`) rather than the v1-canonical
   * downgrade. Pass `null` to omit the param entirely.
   */
  fetchRawMessage(messageId: string, opts?: {
    cardContentType?: 'user_card_content' | string | null;
  }): Promise<ApiMessageItem[]>;
  fetchMessage(messageId: string): Promise<NormalizedMessage | undefined>;
  /**
   * Read a message's `data.items[]` (`im.v1.message.get`) with retry — used to
   * expand merge-forward sub-messages. Wraps the GET in the shared
   * exponential-backoff {@link retry}: transient upstream failures
   * (5xx → `unknown`, `rate_limited`) and — since this is an idempotent read —
   * timeouts are retried; non-transient errors (permission / not-found /
   * format) fail fast. On exhaustion it **throws** the classified
   * {@link LarkChannelError} instead of degrading to `[]`, so the converter can
   * tell "fetch failed" apart from "genuinely empty". The failure is warn-logged
   * here (once, after retries) before re-throwing.
   */
  private fetchMessageItemsWithRetry;
  updatePolicy(partial: Partial<PolicyConfig>): void;
  getPolicy(): Readonly<PolicyConfig>;
  private fetchBotIdentity;
  private registerDispatcherHandlers;
  /**
   * Subscribe to a Feishu event type the channel does not wrap.
   *
   * Multicast; the returned function removes only this handler. Without this the
   * alternatives are reaching into the dispatcher's private map, which breaks on
   * a version bump, or opening a second long-lived connection — and a second
   * connection for the same app makes Feishu split delivery between them, so the
   * channel's own IM traffic starts disappearing.
   *
   * **Raw handlers run outside the safety pipeline.** They run after signature
   * verification and decryption, but `PolicyGate` (`dmMode`, `dmAllowlist`,
   * `groupAllowlist`, `requireMention`), dedup, the per-chat processing lock, the
   * loop guard and the stale-message filter are all downstream of normalization
   * and do not apply here. Registering a raw handler for an event type the channel
   * already handles therefore opens a path around those checks — deliberately,
   * but worth knowing before using it on `im.message.receive_v1`.
   *
   * The payload is the decrypted platform event, unredacted and unaffected by
   * `includeRawEvent: false`: it carries `tenant_key`, full user ids and message
   * bodies.
   *
   * Handlers are awaited before the dispatcher replies to Feishu, so that replies
   * stay ordered after them. On `card.action.trigger` that matters: a slow raw
   * handler delays the callback response past Feishu's timeout even though its
   * return value is discarded. Keep raw handlers on that event type cheap, or hand
   * the work to a queue.
   */
  onRawEvent(eventType: string, handler: (payload: unknown) => void | Promise<void>): Unsubscribe;
  private ensureDispatchEntry;
  /**
   * Built-in first, raw handlers after, and the built-in's return value is the
   * one that goes back to Feishu — a card action's callback response must not be
   * rewritable by an observer that merely subscribed to the same event.
   */
  private dispatchToHandlers;
  /**
   * Put the bot in a meeting as a visible participant (app identity).
   * Requires {@link connect} — this path is driven by event pushes.
   */
  joinMeeting(meetingNo: string, opts?: JoinMeetingOptions): Promise<MeetingSession>;
  /**
   * Follow the meeting the given user access token's owner is currently in,
   * without joining it (user identity). Does **not** require {@link connect}:
   * this path is REST polling only.
   */
  followMyMeeting(opts: FollowMeetingOptions): Promise<MeetingSession>;
  /**
   * Diagnostics for the in-meeting event path, counted per link — `push` for event
   * pushes, `poll` for REST reads. See {@link MeetingEventHealth}.
   */
  getMeetingEventHealth(): MeetingEventHealth;
  /**
   * Meetings the bot is still a participant of with nothing listening — what
   * `disconnect()` leaves behind.
   *
   * `disconnect()` disposes sessions without leaving their meetings, so the bot stays in
   * them; a later `connect()` re-registers the event handlers but does not rebuild the
   * sessions, and their pushes are then dropped. Sessions signal this by ending with
   * `reason: 'disposed'`.
   *
   * Re-attach with `joinMeeting(meetingNo)` — which does not consume a new concurrency
   * slot for a meeting already held — or, once attached, `leave()` to give the slot back.
   * Ignoring an entry here means the bot sits in a meeting deaf, holding a slot, until
   * the meeting ends.
   */
  getRetainedMeetings(): MeetingMembership[];
  private emitError;
}
declare function createLarkChannel(opts: LarkChannelOptions): LarkChannel;
//#endregion
//#region src/meeting/normalize.d.ts
interface MeetingNormalizeContext {
  meetingId: string;
  mode: 'uat' | 'tat';
  /** Undefined while the bot's identity is still resolving — see `selfEcho`. */
  botOpenId?: string;
  includeRaw?: boolean;
}
interface NormalizedMeetingEvent {
  name: MeetingEventName;
  /** The platform's `activity_event_type`, kept for health counters. */
  activityType: string;
  event: unknown;
}
/** Convenience wrapper over a whole push, scoped to one meeting. */
declare function normalizeMeetingPush(payload: unknown, ctx: MeetingNormalizeContext): NormalizedMeetingEvent[];
/** Convenience wrapper over a whole poll response body, scoped to one meeting. */
declare function normalizeMeetingPoll(data: unknown, ctx: MeetingNormalizeContext): NormalizedMeetingEvent[];
//#endregion
//#region src/registration.d.ts
type RegisterAppOptions = Parameters<typeof registerApp>[0];
type RegisterAppResult = Awaited<ReturnType<typeof registerApp>>;
type QRCodeInfo = Parameters<RegisterAppOptions['onQRCodeReady']>[0];
//#endregion
export { type ApiMessageItem, type AppInfo, type BotAddedEvent, type BotIdentity, type BotLoopGuardConfig, type CardActionEvent, type CardActionResponse, type CardStreamController, type CardStreamProducer, type ChatInfo, type ChatMember, type ChatSummary, type ChatType, type CommentEvent, type CommentFileType, type CommentReply, type CommentReplyContentElement, CommentSurface, type CommentTarget, type CreateChatOptions, type EventMap, type EventName, type FetchedComment, type FollowMeetingOptions, type IdType, type JoinMeetingOptions, LarkChannel, LarkChannelError, type LarkChannelErrorCode, type LarkChannelOptions, type MarkdownStreamController, type MarkdownStreamProducer, type MediaSource, type MeetingActivityStats, type MeetingActor, type MeetingChannelConfig, type MeetingChatEvent, type MeetingDocumentContextEvent, type MeetingEndEvent, type MeetingEndReason, type MeetingEventHealth, type MeetingEventMap, type MeetingEventName, type MeetingInvitedEvent, type MeetingLinkHealth, type MeetingMembership, type MeetingNormalizeContext, type MeetingOptions, type MeetingParticipantEvent, type MeetingPollHealth, type MeetingPushHealth, type MeetingSession, type MeetingShareEvent, type MeetingSharedDoc, type MeetingTokenSource, type MeetingTranscriptEvent, type MentionInfo, type NormalizeOptions, type NormalizedMeetingEvent, type NormalizedMessage, type OutboundConfig, type PolicyConfig, type QRCodeInfo, type RawBotAddedEvent, type RawCardActionEvent, type RawCommentEvent, type RawMessageEvent, type RawReactionEvent, type ReactionEvent, type RegisterAppOptions, type RegisterAppResult, type RejectEvent, type RejectReason, type ResourceDescriptor, type ResourceType, type SafetyConfig, type SendInput, type SendOptions, type SendResult, type StreamInput, type WSConfigOverrides, type WSConnectionState, type WSConnectionStatus, type WebhookOptions, createLarkChannel, normalize, normalizeBotAdded, normalizeCardAction, normalizeComment, normalizeMeetingPoll, normalizeMeetingPush, normalizeReaction, registerApp };
//# sourceMappingURL=index.d.mts.map