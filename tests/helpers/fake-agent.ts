import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../src/agent/types.js';

export interface FakeAgentRun extends AgentRun {
  readonly opts: AgentRunOptions;
  readonly stopped: boolean;
  readonly waitForExitCalls: number;
}

class FakeRun implements FakeAgentRun {
  readonly runId: string;
  readonly opts: AgentRunOptions;
  readonly events: AsyncIterable<AgentEvent>;
  readonly waitForExitResult: boolean;
  readonly stderrSnapshot?: string;
  #stopped = false;
  #waitForExitCalls = 0;
  #hold: Promise<void> | undefined;
  #stoppedAt: Promise<void>;
  #markStopped: () => void = () => {};

  constructor(
    opts: AgentRunOptions,
    events: readonly AgentEvent[],
    waitForExitResult: boolean,
    hold?: Promise<void>,
    stderr?: string,
  ) {
    this.runId = opts.runId;
    this.opts = opts;
    this.waitForExitResult = waitForExitResult;
    this.stderrSnapshot = stderr;
    this.#hold = hold;
    this.#stoppedAt = new Promise<void>((resolve) => {
      this.#markStopped = resolve;
    });
    this.events = this.iterate(events);
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get waitForExitCalls(): number {
    return this.#waitForExitCalls;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#markStopped();
  }

  async waitForExit(): Promise<boolean> {
    this.#waitForExitCalls++;
    if (this.#hold) await Promise.race([this.#hold, this.#stoppedAt]);
    return this.#stopped || this.waitForExitResult;
  }

  private async *iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
    for (const event of events) {
      if (this.#stopped) return;
      yield event;
    }
    if (this.#hold && !this.#stopped) await Promise.race([this.#hold, this.#stoppedAt]);
  }
}

export type FakeAgentEvents =
  | readonly AgentEvent[]
  | readonly (readonly AgentEvent[])[];

export class FakeAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly runs: FakeAgentRun[] = [];
  readonly runOptions: AgentRunOptions[] = [];
  botIdentity: AgentBotIdentity | undefined;
  #available: boolean;
  #eventRuns: AgentEvent[][];
  #waitForExitResults: boolean[];
  #hold: Promise<void> | undefined;
  #stderr: string | undefined;

  constructor(options: {
    id?: string;
    displayName?: string;
    available?: boolean;
    events?: FakeAgentEvents;
    waitForExit?: boolean | readonly boolean[];
    /** Keep the event stream open until this settles so pending can accumulate. */
    hold?: Promise<void>;
    stderr?: string;
  } = {}) {
    this.id = options.id ?? 'fake-agent';
    this.displayName = options.displayName ?? 'Fake Agent';
    this.#available = options.available ?? true;
    this.#eventRuns = normalizeEventRuns(options.events ?? []);
    this.#waitForExitResults = normalizeWaitForExitResults(options.waitForExit);
    this.#hold = options.hold;
    this.#stderr = options.stderr;
  }

  async isAvailable(): Promise<boolean> {
    return this.#available;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  run(opts: AgentRunOptions): AgentRun {
    this.runOptions.push(opts);
    const events = this.#eventRuns.shift() ?? [];
    const waitForExitResult = this.#waitForExitResults.shift() ?? true;
    const run = new FakeRun(opts, events, waitForExitResult, this.#hold, this.#stderr);
    this.runs.push(run);
    return run;
  }

  enqueue(...events: AgentEvent[]): void {
    if (this.#eventRuns.length === 0) this.#eventRuns.push([]);
    this.#eventRuns[0]?.push(...events);
  }

  setEvents(events: FakeAgentEvents): void {
    this.#eventRuns = normalizeEventRuns(events);
  }

  setAvailable(available: boolean): void {
    this.#available = available;
  }

  setWaitForExit(result: boolean | readonly boolean[]): void {
    this.#waitForExitResults = normalizeWaitForExitResults(result);
  }
}

export function createFakeAgent(events: readonly AgentEvent[] = []): FakeAgentAdapter {
  return new FakeAgentAdapter({ events });
}

function normalizeEventRuns(events: FakeAgentEvents): AgentEvent[][] {
  if (events.length === 0) return [];
  return Array.isArray(events[0])
    ? (events as readonly (readonly AgentEvent[])[]).map((runEvents) => [...runEvents])
    : [[...(events as readonly AgentEvent[])]];
}

function normalizeWaitForExitResults(result: boolean | readonly boolean[] | undefined): boolean[] {
  if (result === undefined) return [];
  if (typeof result === 'boolean') return [result];
  return [...result];
}
