export type TenantBrand = 'feishu' | 'lark';

/**
 * SecretRef points at a secret stored outside this file — keeps secrets out
 * of `config.json` so backups / accidental git commits / log dumps don't
 * leak the bot's App Secret. Matches lark-cli's `SecretRef` shape so
 * `--source lark-channel` reads it through the same generic
 * `ResolveSecretInput` pipeline.
 *
 *   - `env`:  value is in process env at `id` (optionally allowlisted via provider)
 *   - `file`: value is at the path `id` (or `provider.path` if provider config)
 *   - `exec`: spawn `provider.command`, send JSON over stdin, read JSON from stdout
 */
export interface SecretRef {
  source: 'env' | 'file' | 'exec';
  provider?: string;
  id: string;
}

/** A secret field can be either a plain string (potentially a `${VAR}`
 * template) or a SecretRef. JSON deserializer accepts both forms. */
export type SecretInput = string | SecretRef;

export interface AppCredentials {
  id: string;
  secret: SecretInput;
  tenant: TenantBrand;
}

/**
 * `secrets.providers` declares how SecretRefs resolve to plaintext (env
 * allowlist, file path, exec command). Only the fields actually consumed by
 * bridge's resolver are typed here; lark-cli reads the same JSON via its
 * richer Go types.
 */
export interface ProviderConfig {
  source: 'env' | 'file' | 'exec';
  /** env: allowlist of env var names that ref.id is allowed to be in. */
  allowlist?: string[];
  /** file: optional base path; ref.id is joined onto it. */
  path?: string;
  /** exec: command to spawn + args. */
  command?: string;
  args?: string[];
  /** exec: explicit env to inject (key=value pairs). */
  env?: Record<string, string>;
  /** exec: env var names to pass through from parent env. */
  passEnv?: string[];
  /** exec: max ms to wait for the child. */
  noOutputTimeoutMs?: number;
  /** exec: max stdout bytes accepted before treating as runaway. */
  maxOutputBytes?: number;
}

export interface SecretsConfig {
  providers?: Record<string, ProviderConfig>;
  defaults?: { env?: string; file?: string; exec?: string };
}

/**
 * How replies are rendered in IM chats:
 *   - `card`: full interactive card (tool panels, ⏹ button, footer status)
 *   - `markdown`: lightweight streaming markdown card (typewriter, no buttons)
 *   - `text`: plain markdown post sent once at run completion (no streaming)
 *
 * Pre-0.1.27 only had `card` and `text`, where `text` meant what's now called
 * `markdown`. See `messageReplyMigrated` for the auto-coercion logic.
 */
export type MessageReplyMode = 'card' | 'markdown' | 'text';
export type CotMessagesMode = 'off' | 'brief' | 'detailed';

/**
 * Shared wake-up @mention backfill knobs. The same block applies to every
 * profile and agent kind; getters and the profile normalizer fill these
 * defaults when the key is absent.
 */
export interface BackfillPreferences {
  /** Kill switch. Default true. */
  enabled: boolean;
  /** Full scan + `backfill.would-enqueue` logs, no intake hand-off. Default false. */
  dryRun: boolean;
  /** Hard cap on the scan window, milliseconds. Default 6 h. */
  lookbackMs: number;
  /** Skip scans for gaps shorter than this, milliseconds. Default 60 s. */
  minGapMs: number;
  maxChats: number;
  maxRawPerChat: number;
  maxMentionsPerChat: number;
  /** Optional `oc_…` allowlist; empty means every group the bot is in. */
  chats: string[];
}

export type BackfillNormalizeWarning =
  | { event: 'backfill-invalid'; field: string; value: unknown }
  | { event: 'backfill-dropped-chat'; chatId: string }
  | { event: 'backfill-dropped-chat'; value: unknown };

export const DEFAULT_BACKFILL_PREFERENCES: BackfillPreferences = {
  enabled: true,
  dryRun: false,
  lookbackMs: 6 * 60 * 60 * 1000,
  minGapMs: 60 * 1000,
  maxChats: 50,
  maxRawPerChat: 200,
  maxMentionsPerChat: 20,
  chats: [],
};

/**
 * Access control settings. Empty lists are fail-closed in the v2 policy:
 * no DM senders, no group chats, and only the runtime owner can administer
 * the bot. Runtime owner/admin bypass is applied by the policy layer because
 * owner identity is refreshed from Lark rather than stored in config.json.
 */
export interface AppAccess {
  /** open_id allowlist for DM senders. Group senders are gated by chat. */
  allowedUsers?: string[];
  /** chat_id allowlist for groups the bot responds in. Does not apply to p2p. */
  allowedChats?: string[];
  /** open_id list with admin privileges. Gates sensitive commands
   * (/account, /config, /exit, /reconnect, /doctor, /cd, /ws, /doc,
   * /invite, /remove). */
  admins?: string[];
  /** Per-chat @-mention override (chat_id → bool); overrides the global
   * requireMentionInGroup for the listed chats. */
  chatRequireMention?: Record<string, boolean>;
}

export interface AppPreferences {
  /** Reply rendering mode for IM (group/p2p) messages. Default 'card'. */
  messageReply?: MessageReplyMode;
  /**
   * Internal marker: pre-0.1.27 the value `'text'` meant "lightweight
   * streaming markdown card" (what's now called `'markdown'`). On upgrade
   * we'd silently switch those users to true plain-text behavior unless we
   * coerce; this flag is set the first time the user submits `/config`
   * after the rename, indicating their `messageReply` value is in the
   * new semantic.
   */
  messageReplyMigrated?: boolean;
  /**
   * Whether to render tool-call blocks (Bash / Read / Edit / ...) in the
   * output. Default false in this fork: only the final answer is posted
   * unless the operator turns it on in `/config`.
   */
  showToolCalls?: boolean;
  /**
   * Model the underlying agent runs with, forwarded as `--model`. The catalog
   * of valid values is agent-kind specific — see `agent/models.ts`. `undefined`
   * or the `'default'` sentinel means "don't pass `--model`" so the agent
   * CLI / account default applies. Default: unset.
   */
  model?: string;
  /**
   * Whether to send a separate Lark COT process message before the final
   * answer. `brief` mirrors the lightweight tool/progress visibility from
   * the legacy tool display; `detailed` also includes tool args/output.
   * Legacy boolean/string `on` is accepted by the resolver for upgrades.
   */
  cotMessages?: CotMessagesMode | 'on' | 'simple';
  /**
   * Cap on concurrent claude runs across all chats / topics. Excess runs
   * queue FIFO. Default 10. Mostly relevant for topic groups where each
   * topic can spawn its own run; capping protects RAM / token spend.
   */
  maxConcurrentRuns?: number;
  /**
   * Global default idle-timeout for claude runs, in minutes. When set,
   * if claude emits no stream event for this long the bridge kills the
   * run as presumed-hung. Undefined / 0 = no timeout (the default — runs
   * can hang indefinitely). Per-scope `/timeout` overrides this.
   */
  runIdleTimeoutMinutes?: number;
  /**
   * Whether the bot only responds to messages that @-mention it in groups
   * (regular and topic groups). p2p is always unrestricted. Default true:
   * groups are quiet unless the user @bot. Set false to let any group
   * message reach Claude (the 0.1.21-and-earlier behavior).
   *
   * @全员 is never responded to regardless (SDK `respondToMentionAll: false`).
   * Cloud-doc comments still require @-mention unconditionally.
   */
  requireMentionInGroup?: boolean;
  /** Access control — user/chat allowlists + admin gating. See AppAccess. */
  access?: AppAccess;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when killing the claude
   * subprocess. Bumped from a hardcoded 500ms because claude often has its
   * own subprocesses (e.g. lark-cli mid-OAuth) that need a moment to clean
   * up — too short a window and the SIGKILL cascade kills the descendants
   * before they can finish what the user is waiting on. Default 5000ms.
   * Range 100-30000; out-of-range values fall back to default.
   */
  agentStopGraceMs?: number;
  /**
   * Wake-up @mention backfill. Absent means {@link DEFAULT_BACKFILL_PREFERENCES}.
   * Partial objects are merged onto those defaults; the profile normalizer
   * omits a block that equals the defaults so untouched profiles stay clean.
   */
  backfill?: Partial<BackfillPreferences>;
}

/**
 * Top-level config shape on disk.
 *
 * `accounts` is a namespace for credential-flavored fields (currently just
 * the bot app, room for OAuth / alternate apps later). `preferences`
 * holds user-tunable behavior knobs. Other future sections (mcp, etc.)
 * belong at this top level alongside them.
 */
export interface AppConfig {
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences?: AppPreferences;
}

export function isComplete(cfg: Partial<AppConfig>): cfg is AppConfig {
  const app = cfg.accounts?.app;
  return Boolean(app?.id && hasSecret(app?.secret) && app?.tenant);
}

function hasSecret(s: SecretInput | undefined): boolean {
  if (!s) return false;
  if (typeof s === 'string') return s.length > 0;
  return Boolean(s.source && s.id);
}

/** True iff this credential's secret is stored externally (env/file/exec). */
export function isSecretRef(s: SecretInput): s is SecretRef {
  return typeof s === 'object' && s !== null;
}

/** Account/keystore key for the bot's App Secret. lark-cli also uses a
 * similar `appsecret:` convention so audit/grep is consistent. */
export function secretKeyForApp(appId: string): string {
  return `app-${appId}`;
}

/**
 * Resolve the message-reply preference with default fallback + legacy coerce.
 *
 * Pre-0.1.27 users with `messageReply: 'text'` actually wanted the streaming
 * markdown card (the new `'markdown'`). Until they re-submit `/config`
 * (which sets `messageReplyMigrated: true`), we map their `text` →
 * `markdown` so the behavior stays the same after upgrade.
 *
 * Default for fresh configs (no `messageReply` set) is `'markdown'`.
 */
export function getMessageReplyMode(cfg: AppConfig): MessageReplyMode {
  const raw = cfg.preferences?.messageReply;
  if (raw === 'text' && cfg.preferences?.messageReplyMigrated !== true) {
    return 'markdown';
  }
  if (raw === 'card' || raw === 'markdown' || raw === 'text') return raw;
  return 'markdown';
}

/** Resolve the show-tool-calls preference. Unset means hide (this fork). */
export function getShowToolCalls(cfg: AppConfig): boolean {
  return cfg.preferences?.showToolCalls === true;
}

export function getCotMessages(cfg: AppConfig): CotMessagesMode {
  const raw = cfg.preferences?.cotMessages;
  if (raw === 'brief' || raw === 'simple') return 'brief';
  if (raw === 'detailed' || raw === 'on') return 'detailed';
  return 'off';
}

/** Resolve the max-concurrent-runs preference with default + sanity clamp. */
export function getMaxConcurrentRuns(cfg: AppConfig): number {
  const raw = cfg.preferences?.maxConcurrentRuns;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 10;
  // Reasonable upper bound — at 50+ concurrent claudes the bot box is
  // probably already RAM-starved. Clamp to keep typos from killing the box.
  return Math.min(Math.floor(raw), 50);
}

/**
 * Resolve the require-mention-in-group preference. Default `true` — the
 * `!== false` check makes "undefined" (older configs that don't have the
 * field) inherit the new safer default automatically.
 */
export function getRequireMentionInGroup(cfg: AppConfig): boolean {
  if (cfg.preferences?.requireMentionInGroup !== undefined) {
    return cfg.preferences.requireMentionInGroup !== false;
  }
  const profileAccess = (cfg as AppConfig & {
    access?: { requireMentionInGroup?: boolean };
  }).access;
  if (profileAccess?.requireMentionInGroup !== undefined) {
    return profileAccess.requireMentionInGroup;
  }
  return true;
}

/**
 * Resolve the global default idle-timeout in ms. Returns `undefined` when
 * disabled (the default). Clamps to [1, 120] minutes when set so a typo
 * can't lock the bot into a 1-second kill loop or wait forever to a number
 * the user didn't really mean.
 */
/**
 * Grace period before SIGKILL fallback when stopping a claude subprocess.
 * Returns ms. Defaults to 5000 (5 seconds). Clamps to [100, 30000] so a
 * typo can't either make stop() effectively SIGKILL-immediate or hang for
 * minutes.
 */
export function getAgentStopGraceMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.agentStopGraceMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5000;
  return Math.min(30_000, Math.max(100, Math.floor(raw)));
}

export function getRunIdleTimeoutMs(cfg: AppConfig): number | undefined {
  const raw = cfg.preferences?.runIdleTimeoutMinutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  const clamped = Math.min(Math.max(Math.floor(raw), 1), 120);
  return clamped * 60_000;
}

export function normalizeBackfillPreferences(
  raw: unknown,
  warn: (warning: BackfillNormalizeWarning) => void = () => {},
): BackfillPreferences {
  if (raw === undefined) {
    return copyBackfill(DEFAULT_BACKFILL_PREFERENCES);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warn({ event: 'backfill-invalid', field: 'backfill', value: raw });
    return copyBackfill(DEFAULT_BACKFILL_PREFERENCES);
  }
  const input = raw as Record<string, unknown>;
  return {
    enabled: boolOr(input.enabled, DEFAULT_BACKFILL_PREFERENCES.enabled, 'enabled', warn),
    dryRun: boolOr(input.dryRun, DEFAULT_BACKFILL_PREFERENCES.dryRun, 'dryRun', warn),
    lookbackMs: positiveIntOr(
      input.lookbackMs,
      DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
      'lookbackMs',
      warn,
    ),
    minGapMs: positiveIntOr(
      input.minGapMs,
      DEFAULT_BACKFILL_PREFERENCES.minGapMs,
      'minGapMs',
      warn,
    ),
    maxChats: positiveIntOr(
      input.maxChats,
      DEFAULT_BACKFILL_PREFERENCES.maxChats,
      'maxChats',
      warn,
    ),
    maxRawPerChat: positiveIntOr(
      input.maxRawPerChat,
      DEFAULT_BACKFILL_PREFERENCES.maxRawPerChat,
      'maxRawPerChat',
      warn,
    ),
    maxMentionsPerChat: positiveIntOr(
      input.maxMentionsPerChat,
      DEFAULT_BACKFILL_PREFERENCES.maxMentionsPerChat,
      'maxMentionsPerChat',
      warn,
    ),
    chats: normalizeBackfillChats(input.chats, warn),
  };
}

/** Resolve the effective backfill block. Unset / garbage inherit the defaults. */
export function getBackfillPreferences(cfg: AppConfig): BackfillPreferences {
  return normalizeBackfillPreferences(cfg.preferences?.backfill);
}

/** Ledger prune horizon: entries older than `2 × lookbackMs` can never re-enter a window. */
export function getBackfillPruneHorizonMs(cfg: AppConfig): number {
  return getBackfillPreferences(cfg).lookbackMs * 2;
}

export function isDefaultBackfillPreferences(value: BackfillPreferences): boolean {
  return (
    value.enabled === DEFAULT_BACKFILL_PREFERENCES.enabled &&
    value.dryRun === DEFAULT_BACKFILL_PREFERENCES.dryRun &&
    value.lookbackMs === DEFAULT_BACKFILL_PREFERENCES.lookbackMs &&
    value.minGapMs === DEFAULT_BACKFILL_PREFERENCES.minGapMs &&
    value.maxChats === DEFAULT_BACKFILL_PREFERENCES.maxChats &&
    value.maxRawPerChat === DEFAULT_BACKFILL_PREFERENCES.maxRawPerChat &&
    value.maxMentionsPerChat === DEFAULT_BACKFILL_PREFERENCES.maxMentionsPerChat &&
    value.chats.length === 0
  );
}

export function formatBackfillPreferences(prefs: BackfillPreferences): string {
  const chats = prefs.chats.length === 0 ? 'all' : prefs.chats.join(',');
  return [
    `enabled=${prefs.enabled}`,
    `dryRun=${prefs.dryRun}`,
    `lookbackMs=${prefs.lookbackMs}`,
    `minGapMs=${prefs.minGapMs}`,
    `maxChats=${prefs.maxChats}`,
    `maxRawPerChat=${prefs.maxRawPerChat}`,
    `maxMentionsPerChat=${prefs.maxMentionsPerChat}`,
    `chats=${chats}`,
  ].join(' ');
}

function copyBackfill(value: BackfillPreferences): BackfillPreferences {
  return { ...value, chats: [...value.chats] };
}

function boolOr(
  value: unknown,
  fallback: boolean,
  field: string,
  warn: (warning: BackfillNormalizeWarning) => void,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    warn({ event: 'backfill-invalid', field, value });
    return fallback;
  }
  return value;
}

function positiveIntOr(
  value: unknown,
  fallback: number,
  field: string,
  warn: (warning: BackfillNormalizeWarning) => void,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    warn({ event: 'backfill-invalid', field, value });
    return fallback;
  }
  return Math.floor(value);
}

function normalizeBackfillChats(
  value: unknown,
  warn: (warning: BackfillNormalizeWarning) => void,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warn({ event: 'backfill-invalid', field: 'chats', value });
    return [];
  }
  const chats: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.startsWith('oc_')) {
      chats.push(item);
      continue;
    }
    if (typeof item === 'string') {
      warn({ event: 'backfill-dropped-chat', chatId: item });
    } else {
      warn({ event: 'backfill-dropped-chat', value: item });
    }
  }
  return chats;
}
