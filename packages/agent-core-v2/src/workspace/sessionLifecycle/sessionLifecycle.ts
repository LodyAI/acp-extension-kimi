import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { type Event, type IWaitUntil } from '#/_base/event';
import type { BindAgentInput } from '#/agent/profile/profile';
import type { McpServerConfig } from '#/mcpCore/config-schema';


export type SessionCreateSource = 'startup' | 'resume' | 'fork';

export type SessionCloseReason = 'exit' | 'archive';

export interface CreateSessionOptions {
  readonly sessionId?: string;
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
  readonly mainAgentBinding?: BindAgentInput;
  /**
   * Ephemeral per-session MCP servers: connected only for this session,
   * visible only to this session (an entry shadows a workspace server of the
   * same name), never persisted to any MCP config file, and released when
   * the session closes. Not carried over by fork or resume.
   */
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

/**
 * One fork-addressable turn. `turnIndex` is what `fork({ turnIndex })` takes;
 * `messageId` is the durable id of the prompt that opened it, which is how a
 * caller lines these up against a rendered history whose head has been
 * compacted away. `prompt` is the same prompt metadata a fork records, kept
 * for diagnostics only — never match on it, it is sanitized and truncated.
 */
export interface ForkTurnSummary {
  readonly turnIndex: number;
  readonly messageId?: string;
  readonly prompt?: string;
}

/**
 * Whether a prompt origin opens a turn `fork({ turnIndex })` counts. The fork
 * index space is defined by this predicate, so anything that publishes or
 * resolves a fork position classifies origins through it rather than restating
 * the rule.
 */
export function isUserVisibleTurnOrigin(origin: unknown): boolean {
  const fields =
    typeof origin === 'object' && origin !== null && !Array.isArray(origin)
      ? (origin as Record<string, unknown>)
      : undefined;
  switch (fields?.['kind']) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return fields?.['trigger'] === 'user-slash';
    case 'shell_command':
      return fields?.['phase'] === 'input';
    default:
      return false;
  }
}

export interface ForkSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
  /**
   * Zero-based index of the user-visible turn to retain through. When omitted,
   * the complete session is copied (the existing fork behavior).
   */
  readonly turnIndex?: number;
}

export interface ResumeSessionOptions {
  readonly additionalDirs?: readonly string[];
  /**
   * Ephemeral per-session MCP servers — the same semantics as
   * `CreateSessionOptions.mcpServers`: a session-owned overlay connected for
   * this session only, never persisted, released when the session closes.
   * Ignored when the session is already live (resume passes through).
   */
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface CreateChildSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SessionCreatedEvent {
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
  readonly source: SessionCreateSource;
}

export interface SessionClosedEvent {
  readonly sessionId: string;
}

export interface SessionWillCloseEvent {
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
  readonly reason: SessionCloseReason;
}

export interface SessionArchivedEvent {
  readonly sessionId: string;
}

export interface SessionForkedEvent {
  readonly sourceSessionId: string;
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
}

/**
 * Participation surface of `onWillCreateSession` — the business-lifecycle
 * moment "a session is being created", fired synchronously before the new
 * session's services activate (the `will` half of `onDidCreateSession`;
 * resume and fork are creations too). Workspace-scope participants step
 * into the creation through the session domain's own vocabulary — read the
 * session's seeded facts (`readSeed`), contribute or replace a session seed
 * (`contributeSeed`; a seed already projected by the workspace seed
 * adapters is replaced), and attach teardown work to the session's lifetime
 * (`onSessionDispose` — runs with the session's teardown on every path:
 * close, archive, delete, a failed create, workspace teardown). The event
 * carries only facts the lifecycle itself owns; anything a participant
 * needs beyond them travels as a session-domain seed.
 */
export interface SessionWillCreateEvent {
  readonly sessionId: string;
  readSeed<T>(id: ServiceIdentifier<T>): T;
  contributeSeed<T>(id: ServiceIdentifier<T>, value: T): void;
  onSessionDispose(dispose: () => void): void;
}

export interface ISessionLifecycleService {
  readonly _serviceBrand: undefined;

  readonly onWillCreateSession: Event<SessionWillCreateEvent>;
  readonly onDidCreateSession: Event<SessionCreatedEvent & IWaitUntil>;
  readonly onWillCloseSession: Event<SessionWillCloseEvent & IWaitUntil>;
  readonly onDidCloseSession: Event<SessionClosedEvent>;
  readonly onDidArchiveSession: Event<SessionArchivedEvent>;
  readonly onDidForkSession: Event<SessionForkedEvent>;
  create(opts: CreateSessionOptions): Promise<ISessionScopeHandle>;
  get(sessionId: string): ISessionScopeHandle | undefined;
  list(): readonly ISessionScopeHandle[];
  resume(sessionId: string, opts?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined>;
  close(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  restore(sessionId: string, opts?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined>;
  delete(sessionId: string): Promise<void>;
  /**
   * The turns `fork({ turnIndex })` can address, in record order. A rendered
   * history is not a reliable index source — compaction drops messages from
   * context while the records that define these indices stay — so a client
   * that offers "fork from here" resolves its position against this list.
   */
  listForkTurns(sourceSessionId: string): Promise<ForkTurnSummary[]>;
  fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle>;
  createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle>;
}

export const ISessionLifecycleService: ServiceIdentifier<ISessionLifecycleService> =
  createDecorator<ISessionLifecycleService>('sessionLifecycleService');
