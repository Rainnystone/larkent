import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { ResumeHistoryEntry, ResumeHistoryInput } from '../agent/definition';
import type { AgentAdapter } from '../agent/types';
import type { AutoActionAuth } from '../automations/action-auth';
import type { BoardActionAuth } from '../automations/board-auth';
import type { AutomationScheduler } from '../automations/scheduler';
import type { AutomationItem, AutomationsStore } from '../automations/store';
import type { ActiveRuns } from '../bot/active-runs';
import type { BackfillLedger } from '../bot/backfill-ledger';
import type { ChatModeCache } from '../bot/chat-mode-cache';
import type { Continuations } from '../bot/continuation';
import type { NoticeActionAuth } from '../bot/interruption-notice';
import type { KnownChat } from '../bot/lark-info';
import type { PendingQueue } from '../bot/pending-queue';
import type { ProcessPool } from '../bot/process-pool';
import type { StopRequest } from '../bot/run-outcome';
import type { TurnJournal } from '../bot/turn-journal';
import type { CallbackAuth } from '../card/callback-auth';
import type { ProfileConfig } from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import type { MeetingManager } from '../meeting/manager';
import type { OwnerRefreshState } from '../policy/access';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import type { ResumeCandidates } from '../session/resume-candidates';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';

export interface Controls {
  profile: string;
  profileConfig: ProfileConfig;
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
  refreshOwner(channel?: LarkChannel): Promise<void>;
  /** `/reconnect` and `/account` only: disconnect, reload config, reconnect.
   * Link failures must not call this. */
  restart(opts?: { wait?: boolean; stopReason?: StopRequest }): Promise<void>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
  /** Groups the bot currently belongs to, used to render and bulk-manage access. */
  knownChats?: KnownChat[];
  /** In-meeting agent manager; present only while the channel is connected and
   * `meeting.enabled` is on. Late-bound by startChannel. */
  meeting?: MeetingManager;
}

export interface UserActionRuntime {
  channel: LarkChannel;
  sessions: SessionStore;
  resumeCandidates: ResumeCandidates;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  ledger?: BackfillLedger;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  processPool?: ProcessPool;
  pending?: PendingQueue;
  runExecutor?: RunExecutor;
  controls: Controls;
  resumeHistoryProvider?: (input: ResumeHistoryInput) => Promise<ResumeHistoryEntry[]>;
  automations?: AutomationsStore;
  autoAuth?: AutoActionAuth;
  automationsScheduler?: AutomationScheduler;
  now?: () => number;
  isLinkDown?: () => boolean;
  onAutomationConfirmed?: (item: AutomationItem) => void | Promise<void>;
  chatModeCache?: ChatModeCache;
  callbackAuth?: CallbackAuth;
  callbackPolicyFingerprint?: string;
  callbackPolicyFingerprintForScope?: (scope: string) => string | undefined;
  journal?: TurnJournal;
  noticeAuth?: NoticeActionAuth;
  boardAuth?: BoardActionAuth;
  continuations?: Continuations;
}

export interface UserActionContext extends UserActionRuntime {
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / cwd / active-run). All handlers should read/write
   * session / workspace / activeRuns through this — never through
   * `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  origin: 'slash' | 'card';
  sessionCatalogIdentity?: SessionCatalogIdentity;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
}
