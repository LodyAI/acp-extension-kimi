/**
 * ACP session (v2) — drives a single main agent over one ACP `sessionId`,
 * through the `Klient` facade. `start.ts` creates the klient over the
 * in-memory transport; everything below goes through facade calls and typed
 * klient events, so swapping the transport (http / ipc) requires no change
 * here.
 *
 * `prompt` submits the user input via `agent.prompt(...)` and translates the
 * agent's scoped event stream — subscribed once per session in `init()`,
 * before the first prompt — into ACP `session/update` notifications via the
 * helpers in `./events-map`. The promise settles on the `turn.ended` event; a
 * submission that launches no turn (busy / hook-blocked / not runnable)
 * settles gracefully with `end_turn`, mirroring the engine's `PromptHandle`
 * behavior.
 *
 * KLIENT GAPS (all reported; each marked `KLIENT-GAP` inline):
 *  - no session MCP connection view / compaction service → the `/mcp` and
 *    `/compact` builtin slash commands answer with an explanatory notice
 *    instead of live data (see `./builtin-commands`).
 *  - no `Turn.result` promise → settlement relies solely on `turn.ended`.
 */

import { randomUUID } from 'node:crypto';

import type {
  AvailableCommand,
  ContentBlock,
  PromptResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  ToolCallLocation,
} from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import {
  type ContextMessage,
  type ForkTurnSummary,
  isUserVisibleTurnOrigin,
} from '@moonshot-ai/agent-core-v2';
import type {
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolUpdatedEvent,
} from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import type { ToolResultEvent } from '@moonshot-ai/agent-core-v2/events';
import { toCoreMessage } from '@moonshot-ai/agent-core-v2/human/message';
import { toLlmMessage } from '@moonshot-ai/agent-core-v2/llm-adapter/contract/message';
import type { ToolInputDisplay } from '@moonshot-ai/agent-core-v2/tool/toolInputDisplay';
import type {
  AgentEventPayloads,
  AgentHandle,
  AgentTaskInfo,
  ContentPart,
  IDisposable,
  Klient,
  PromptLaunchResult,
  SessionEventPayloads,
  SessionHandle,
  SkillSummary,
  UsageStatus,
} from '@moonshot-ai/klient';
import { LODY_EXTENSION_METHODS, type LodyActivityMeta } from 'acp-extension-core';

import type { AcpClient } from './acp-client';
import type { AcpTerminalCreatedEvent, IAcpConnection } from './acp-fs';
import {
  ACP_BUILTIN_SLASH_COMMAND_NAMES,
  ACP_BUILTIN_SLASH_COMMANDS,
  type AcpBuiltinSlashCommandName,
  runBuiltinSlashCommand,
} from './builtin-commands';
import { buildSessionConfigOptions } from './config-options';
import { acpBlocksToContentParts, compressPromptImageParts } from './convert';
import {
  acpToolCallId,
  assistantDeltaToSessionUpdate,
  availableCommandsUpdateNotification,
  configOptionUpdateNotification,
  currentModeUpdateNotification,
  planFromDisplayBlock,
  sessionInfoUpdateNotification,
  thinkingDeltaToSessionUpdate,
  toolCallDeltaToSessionUpdate,
  toolCallLazyCreateToSessionUpdate,
  toolCallLocations,
  toolCallStartedUpgradeToSessionUpdate,
  toolCallStartToSessionUpdate,
  toolUpdatedToSessionUpdate,
  toolResultToSessionUpdate,
  turnEndReasonToStopReason,
  usageUpdateNotification,
  isAuthError,
  stringifyArgs,
} from './events-map';
import { AcpInteractionBridge } from './interaction-bridge';
import {
  addTokenUsage,
  hasTokenUsage,
  type SubagentTaskInfo,
  type TokenUsage,
  tokenUsageDelta,
  toLodyRateLimits,
  toLodySessionUsage,
  toLodyTaskLifecycle,
  withLodyTurnId,
} from './lody-extension';
import { log } from './log';
import { projectModelCatalog } from './model-catalog';
import { ACP_MODES, type AcpModeId, DEFAULT_MODE_ID } from './modes';
import { projectHistoryToSessionUpdates } from './replay';
import { buildAcpSkillSlashCommands, detectSlashIntent } from './slash';
import { KimiSubagentEvents } from './subagent-events';

function leadingText(blocks: readonly ContentBlock[]): string | undefined {
  const first = blocks[0];
  if (first !== undefined && first.type === 'text') return first.text;
  return undefined;
}

const TURN_AGENT_BUSY_CODE = 'turn.agent_busy';
const SESSION_OCCUPIED_CODE = 'session.occupied';
const SESSION_STALE_CODE = 'session.stale';

export function mapPromptLaunchError(error: unknown, sessionId: string): RequestError {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string' && isAuthError({ code })) {
    log.warn('acp: prompt launch rejected with an auth error; mapping to auth_required', {
      sessionId,
      error: message,
    });
    return RequestError.authRequired(undefined, message);
  }
  if (code === TURN_AGENT_BUSY_CODE) {
    log.warn('acp: prompt rejected because another turn is active', { sessionId });
    return RequestError.invalidRequest({ code }, message);
  }
  if (code === SESSION_OCCUPIED_CODE) {
    log.warn('acp: prompt rejected because another client holds the session', { sessionId });
    return RequestError.invalidRequest({ code }, message);
  }
  if (code === SESSION_STALE_CODE) {
    log.warn('acp: prompt rejected because the session was updated elsewhere', { sessionId });
    return RequestError.invalidRequest(
      { code },
      'Session was updated by another client. Close and reopen the session, then retry.',
    );
  }
  log.error('acp: prompt launch failed', {
    sessionId,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
  });
  return RequestError.internalError(undefined, 'session prompt failed');
}

interface HostSlashCommandsSnapshot {
  readonly commands: ReadonlyArray<AvailableCommand>;
  readonly skillCommandMap?: ReadonlyMap<string, string>;
}

interface ResolvedCommands {
  readonly commands: AvailableCommand[];
  readonly skillCommandMap: ReadonlyMap<string, string>;
}

interface TurnDriver {
  resolve(response: PromptResponse): void;
  reject(error: unknown): void;
  turnId?: number;
  settled: boolean;
  cancelRequested?: boolean;
  early: Array<{ readonly turnId: number; readonly dispatch: () => void }>;
  /**
   * The stop reason this prompt will answer with, withheld while background
   * work it started is still running. A detached subagent outlives the turn
   * that spawned it and the engine reports its result by opening a FOLLOW-UP
   * turn on this agent, so settling at the first `turn.ended` would report the
   * conversation idle with the answer still to come. Held prompts settle from
   * {@link AcpSession.settleHeldPromptIfDrained} instead.
   */
  pendingStopReason?: PromptResponse['stopReason'];
}

/**
 * How long a held prompt keeps waiting for the wake turn of a terminated
 * subagent. The engine enqueues that turn asynchronously (it snapshots the
 * task's output first), so the wake reliably lands after `task.terminated`;
 * the bound only exists so an engine that never enqueues cannot strand the
 * client's `session/prompt` forever.
 */
const WAKE_TURN_GRACE_MS = 10_000;

/**
 * Whether the engine will report this finished task back to the agent as a
 * follow-up turn. Mirrors the task service's own notification conditions: an
 * attached task was already awaited inside its tool call, and a suppressed
 * one is reported by whoever suppressed it.
 */
function expectsWakeTurn(task: AgentTaskInfo): boolean {
  return task.detached !== false && task.terminalNotificationSuppressed !== true;
}

export class AcpSession {
  private readonly klient: Klient;
  private readonly session: SessionHandle;
  private readonly agent: AgentHandle;

  private currentModelId: string = '';
  private currentThinkingLevel: string = 'off';
  private currentModeId: AcpModeId = DEFAULT_MODE_ID;
  private planMode = false;
  /**
   * Cached session skill summaries — the backing data for slash-intent
   * detection and `availableCommands()`. Seeded in `init()` and refreshed on
   * the klient `skills.changed` event.
   */
  private skills: readonly SkillSummary[] = [];
  private driver: TurnDriver | undefined;
  /**
   * Turns currently running on this session's main agent. Includes turns the
   * ENGINE opened on its own (a terminated subagent's notification, a cron
   * fire): those are ordinary turns of this agent, so a held prompt must wait
   * for them the same way it waits for its own.
   */
  private readonly runningTurns = new Set<number>();
  /** Subagent (`kind: 'agent'`) tasks started here that have not terminated. */
  private readonly activeSubagentTasks = new Set<string>();
  /**
   * Engine turn id → the fork position published on that turn's updates. The
   * engine addresses forks by position among user-visible turns, so this id is
   * the fork turn index, minted once per turn and echoed back by the client in
   * `session/fork`.
   */
  private readonly forkTurnIdByTurn = new Map<number, string>();
  /**
   * Index the next user-visible turn will take, anchored at activation from
   * the engine's own record-level count. Undefined when that read failed —
   * publishing a guessed position would fork the wrong turn, so we publish
   * nothing instead.
   */
  /**
   * Set when the last subagent task terminated and the engine still owes its
   * wake turn. Blocks settlement across that gap so the result lands inside
   * the prompt that started the work; {@link WAKE_TURN_GRACE_MS} bounds it.
   */
  private wakeTurnGrace: ReturnType<typeof setTimeout> | undefined;
  /**
   * Abort markers of prompts still in their pre-turn image-compression phase
   * (no turn launched yet, so `agent.cancel` has nothing to cancel).
   * `cancel()` flips every marker; the prompt settles with
   * `stopReason: 'cancelled'` once compression finishes instead of launching
   * a turn the client already asked to stop.
   */
  private readonly pendingPromptAborts = new Set<{ aborted: boolean }>();
  private readonly subscriptions: IDisposable[] = [];
  private readonly toolCallStreamArgs = new Map<string, { args: string }>();
  private readonly toolStatuses = new Map<string, string>();
  private readonly toolLocations = new Map<string, ToolCallLocation[]>();
  private readonly bashCallsAwaitingTerminal = new Map<string, string>();
  private readonly terminalBackedCalls = new Map<string, string>();
  /** Cumulative engine counters captured when this ACP activation began. */
  private readonly lodyUsageBaselines = new Map<string, TokenUsage>();
  /** Cumulative usage attributable only to this ACP activation. */
  private readonly lodyUsageSinceActivation = new Map<string, TokenUsage>();
  private lodyUsageLastEmitted: Record<string, TokenUsage> = {};
  /** Core usage scope of this activation: its counters start from zero, so a
   * later activation must never report under the same accounting identity. */
  private readonly lodyUsageScopeId = randomUUID();
  private lodyUsageEmission: Promise<void> = Promise.resolve();
  /** Compaction tool-call correlation for the current background compaction. */
  private activeCompaction: { readonly id: string; readonly automatic: boolean } | undefined;
  /** Bridges engine approval / ask-user requests to the ACP client. */
  private readonly interactionBridge: AcpInteractionBridge;

  constructor(
    private readonly conn: AcpClient,
    klient: Klient,
    readonly sessionId: string,
    private readonly acpConnection: IAcpConnection,
    elicitationForm: boolean,
    private readonly resolveOriginalsDir?: (sessionId: string) => string | undefined,
    private readonly hostCommands: ReadonlyArray<AvailableCommand> | HostSlashCommandsSnapshot = [],
    private readonly supportsPlan = false,
    subagentEvents = false,
  ) {
    this.klient = klient;
    this.session = klient.session(sessionId);
    this.subagentEvents = subagentEvents
      ? new KimiSubagentEvents(this.session, sessionId, conn, (error) =>
          log.warn('acp: subagent event delivery failed', { error: String(error) }),
        )
      : undefined;
    // `main` is auto-materialized by the transport's scope resolution on the
    // first call — no explicit agent bootstrap is needed here.
    this.agent = this.session.agent('main');
    this.interactionBridge = new AcpInteractionBridge(
      conn,
      this.session,
      sessionId,
      elicitationForm,
      this.subagentEvents === undefined
        ? undefined
        : (agentId, tool) => this.subagentEvents!.permission(agentId, tool),
    );
  }

  /**
   * Subscribe the agent event stream and seed the config state. Must be
   * awaited before the first `prompt` so no early turn events are missed.
   */
  private readonly subagentEvents: KimiSubagentEvents | undefined;

  canChangeSystemPrompt(): boolean {
    return !this.driver && this.runningTurns.size === 0 && this.activeSubagentTasks.size === 0;
  }

  async init(): Promise<void> {
    const events = this.agent.events;
    this.subscriptions.push(
      // Content events are forwarded for EVERY turn of this agent, not only
      // the one the in-flight prompt launched: the engine opens turns of its
      // own (a terminated subagent's notification, a cron fire) and dropping
      // those would silently swallow the agent's reply. The prompt driver is
      // about settling `session/prompt`, not about who may speak.
      events.on('assistant.delta', (event) => {
        this.onAssistantDelta(event);
      }),
      events.on('thinking.delta', (event) => {
        this.onThinkingDelta(event);
      }),
      events.on('tool.call.started', (event) => {
        this.onToolCallStarted(event);
      }),
      events.on('tool.call.delta', (event) => {
        this.onToolCallDelta(event);
      }),
      events.on('tool.updated', (event) => {
        this.dispatchTurnEvent(event.turnId, () => {
          this.onToolUpdated(event);
        });
      }),
      events.on('tool.result', (event) => {
        this.onToolResult(event);
      }),
      events.on('turn.started', (event) => {
        this.runningTurns.add(event.turnId);
        this.assignForkTurnIndex(event);
        // The awaited wake turn arrived: `runningTurns` now holds settlement.
        this.clearWakeTurnGrace();
      }),
      events.on('turn.ended', (event) => {
        this.runningTurns.delete(event.turnId);
        this.forkTurnIdByTurn.delete(event.turnId);
        // Settlement stays turn-scoped (only this prompt's own turn resolves
        // it), but the drain check runs for every turn — an engine-opened
        // turn ending is what releases a held prompt.
        this.dispatchTurnEvent(event.turnId, () => {
          this.onTurnEnded(event);
        });
        this.settleHeldPromptIfDrained();
      }),
      events.on('agent.status.updated', (event) => {
        if (event['usage'] !== undefined) void this.emitDetailedUsageUpdate();
        let changed = false;
        if (typeof event['planMode'] === 'boolean' && event['planMode'] !== this.planMode) {
          this.planMode = event['planMode'];
          changed = true;
        }
        if (
          event['permissionMode'] === 'manual' ||
          event['permissionMode'] === 'auto' ||
          event['permissionMode'] === 'yolo'
        ) {
          this.currentModeId =
            event['permissionMode'] === 'manual' ? 'default' : event['permissionMode'];
          changed = true;
        }
        if (changed) void this.emitConfigOptionUpdate();
      }),
      events.on('task.started', (event) => {
        if (event.info.kind === 'agent') {
          this.activeSubagentTasks.add(event.info.taskId);
        }
        void this.emitTaskLifecycle('started', event.info);
      }),
      events.on('task.terminated', (event) => {
        if (event.info.kind === 'agent') {
          void this.emitDetailedUsageUpdate();
          this.activeSubagentTasks.delete(event.info.taskId);
          if (this.activeSubagentTasks.size === 0 && expectsWakeTurn(event.info)) {
            this.startWakeTurnGrace();
          }
          this.settleHeldPromptIfDrained();
        }
        void this.emitTaskLifecycle('terminated', event.info);
      }),
      // Compaction runs as a background LLM task outside any turn, so these
      // are not turn-scoped; the subscription is already agent-grained (this
      // session's main agent), which keeps other sessions' events out.
      // A blocked turn waits for the same compaction to finish.
      events.on('compaction.started', (event) => {
        this.onCompactionStarted(event);
      }),
      events.on('compaction.completed', (event) => {
        this.onCompactionCompleted(event);
      }),
      events.on('compaction.cancelled', () => {
        this.onCompactionCancelled();
      }),
    );
    this.subscriptions.push(
      this.session.events.on('metadata.changed', (event) => {
        this.onMetadataChanged(event);
      }),
    );
    this.subscriptions.push(
      this.session.events.on('skills.changed', () => {
        void this.refreshSkills().then(() => this.emitAvailableCommandsUpdate());
      }),
    );
    const unsubscribeTerminal = this.acpConnection.onTerminalCreated((event) => {
      this.onTerminalCreated(event);
    });
    this.subscriptions.push({ dispose: unsubscribeTerminal });
    try {
      this.currentModelId = await this.agent.getModel();
      this.currentThinkingLevel = await this.agent.getThinking();
    } catch (error) {
      log.warn('acp: could not seed model/thinking state', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const permission = await this.agent.getPermission();
    this.currentModeId = permission === 'manual' ? 'default' : permission;
    this.planMode = (await this.agent.getPlan()) !== null;
    // Awaited: the post-`session/new` `available_commands_update` must already
    // carry the skills (see `activateSession`).
    await this.refreshSkills();
    try {
      await this.captureDetailedUsage(false);
    } catch (error) {
      log.warn('acp: failed to establish Lody token usage baseline', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    void this.emitManagedUsage();
  }

  private async refreshSkills(): Promise<void> {
    try {
      this.skills = await this.session.skills.list();
    } catch (error) {
      log.warn('acp: could not list session skills', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  dispose(): void {
    this.subagentEvents?.dispose();
    this.clearWakeTurnGrace();
    this.cancel();
    const driver = this.driver;
    if (driver !== undefined) {
      this.settleDriver(driver, () => {
        driver.resolve({ stopReason: 'cancelled' });
      });
    }
    this.interactionBridge.dispose();
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
  }

  async replayHistory(): Promise<void> {
    let messages: readonly ContextMessage[];
    try {
      messages = (await this.agent.getContext()).history.map((message) => ({
        ...toCoreMessage(toLlmMessage(message)),
        id: message.id,
        providerMessageId: message.providerMessageId,
        name: message.name,
        origin: message.origin,
        isError: message.isError,
        partial: message.partial,
        toolCallDisplays: message.toolCallDisplays,
        note: message.note,
        usage: message.usage,
        llmTiming: message.llmTiming,
        durationMs: message.durationMs,
      }));
    } catch (error) {
      log.warn('acp: replayHistory could not read context memory', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    // Replayed turns carry their fork positions too: a client that reloads a
    // session must still be able to branch at an older turn.
    let forkTurns: readonly ForkTurnSummary[] = [];
    try {
      forkTurns = await this.session.forkTurns();
    } catch (error) {
      log.warn('acp: replayHistory could not read fork turn positions', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const updates = projectHistoryToSessionUpdates(this.sessionId, messages, forkTurns);
    for (const update of updates) {
      try {
        await this.conn.sessionUpdate(update);
      } catch (error) {
        log.warn('acp: replayHistory failed to push a session/update; continuing', {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private resolveCommands(): ResolvedCommands {
    const skillSnapshot = buildAcpSkillSlashCommands(this.skills);
    const hostSnapshot = Array.isArray(this.hostCommands)
      ? { commands: this.hostCommands, skillCommandMap: new Map<string, string>() }
      : (this.hostCommands as HostSlashCommandsSnapshot);
    const commands: AvailableCommand[] = [];
    const names = new Set<string>();
    for (const command of [
      ...ACP_BUILTIN_SLASH_COMMANDS,
      ...skillSnapshot.commands,
      ...hostSnapshot.commands,
    ]) {
      if (names.has(command.name)) continue;
      names.add(command.name);
      commands.push(command);
    }
    const commandMap = new Map(skillSnapshot.commandMap);
    for (const [alias, skillName] of hostSnapshot.skillCommandMap ?? []) {
      if (ACP_BUILTIN_SLASH_COMMAND_NAMES.has(alias)) continue;
      if (!names.has(alias) || commandMap.has(alias)) continue;
      commandMap.set(alias, skillName);
    }
    return { commands, skillCommandMap: commandMap };
  }

  availableCommands(): AvailableCommand[] {
    return this.resolveCommands().commands;
  }

  async emitAvailableCommandsUpdate(): Promise<void> {
    try {
      const { commands } = this.resolveCommands();
      await this.conn.sessionUpdate(availableCommandsUpdateNotification(this.sessionId, commands));
    } catch (error) {
      log.warn('acp: failed to push available_commands_update', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async prompt(blocks: readonly ContentBlock[]): Promise<PromptResponse> {
    const text = leadingText(blocks);
    if (text !== undefined) {
      const commands = this.resolveCommands();
      const intent = detectSlashIntent(text, commands.skillCommandMap);
      if (intent.kind === 'builtin') {
        return this.driveBuiltinCommand(intent.name, intent.args, commands.commands);
      }
      if (intent.kind === 'skill') {
        return this.driveSkillActivation(intent.skillName, intent.args);
      }
      if (intent.kind === 'unknown') {
        return this.driveUnknownCommand(intent.name);
      }
    }

    const content = await this.preparePromptContent(blocks);
    if (content === undefined) {
      return { stopReason: 'cancelled' };
    }
    return this.driveTurn(content);
  }

  private async preparePromptContent(
    blocks: readonly ContentBlock[],
  ): Promise<readonly ContentPart[] | undefined> {
    const pending = { aborted: false };
    this.pendingPromptAborts.add(pending);
    let content: readonly ContentPart[];
    try {
      content = await compressPromptImageParts(acpBlocksToContentParts(blocks), {
        originalsDir: this.resolveOriginalsDir?.(this.sessionId),
      });
    } finally {
      this.pendingPromptAborts.delete(pending);
    }
    return pending.aborted ? undefined : content;
  }

  private async driveUnknownCommand(name: string): Promise<PromptResponse> {
    await this.conn.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Unknown ACP command: /${name}. Use /help to see available commands.`,
        },
      },
    });
    return { stopReason: 'end_turn' };
  }

  private driveSkillActivation(skillName: string, args: string): Promise<PromptResponse> {
    this.assertNoActiveTurn();
    return this.driveLaunch(
      this.agent.activateSkill({ name: skillName, args: args.length > 0 ? args : undefined }),
    );
  }

  private async driveBuiltinCommand(
    name: AcpBuiltinSlashCommandName,
    args: string,
    availableCommands: readonly AvailableCommand[],
  ): Promise<PromptResponse> {
    let text: string;
    try {
      text = await runBuiltinSlashCommand(
        name,
        {
          klient: this.klient,
          session: this.session,
          agent: this.agent,
          sessionId: this.sessionId,
          modelId: this.currentModelId,
          thinkingEnabled: this.currentThinkingLevel !== 'off',
          modeId: this.currentModeId,
          availableCommands,
        },
        args,
      );
    } catch (error) {
      log.warn('acp: builtin slash command failed', {
        sessionId: this.sessionId,
        command: name,
        error: error instanceof Error ? error.message : String(error),
      });
      text = `/${name} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    await this.conn.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    });
    return { stopReason: 'end_turn' };
  }

  private skillCommandMap(): ReadonlyMap<string, string> {
    return buildAcpSkillSlashCommands(this.skills).commandMap;
  }

  private assertNoActiveTurn(): void {
    if (this.driver !== undefined && !this.driver.settled) {
      throw RequestError.invalidRequest(
        { code: TURN_AGENT_BUSY_CODE },
        'another turn is already in progress',
      );
    }
  }

  private driveTurn(input: readonly ContentPart[]): Promise<PromptResponse> {
    this.assertNoActiveTurn();
    return this.driveLaunch(this.agent.prompt({ input }));
  }

  private driveLaunch(launch: Promise<PromptLaunchResult>): Promise<PromptResponse> {
    return new Promise<PromptResponse>((resolve, reject) => {
      const driver: TurnDriver = { resolve, reject, settled: false, early: [] };
      this.driver = driver;
      launch.then(
        (launched) => {
          if (launched !== undefined) {
            void this.session.generateTitle().catch((error) => {
              log.warn('acp: title generation failed', {
                sessionId: this.sessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
          if (driver.settled) return;
          if (launched === undefined) {
            this.settleDriver(driver, () => {
              resolve({ stopReason: driver.cancelRequested === true ? 'cancelled' : 'end_turn' });
            });
            return;
          }
          driver.turnId = launched.turn_id;
          if (driver.cancelRequested === true) {
            void this.agent.cancel({ turnId: launched.turn_id }).catch((error) => {
              log.warn('acp: deferred cancel failed', {
                sessionId: this.sessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
          for (const early of driver.early.splice(0)) {
            if (early.turnId === driver.turnId) early.dispatch();
          }
        },
        (error) => {
          this.settleDriver(driver, () => {
            reject(mapPromptLaunchError(error, this.sessionId));
          });
        },
      );
    });
  }

  private dispatchTurnEvent(turnId: number, dispatch: () => void): void {
    const driver = this.driver;
    if (driver !== undefined && !driver.settled && driver.turnId === undefined) {
      driver.early.push({ turnId, dispatch });
      return;
    }
    dispatch();
  }

  private settleDriver(driver: TurnDriver, action: () => void): void {
    if (driver.settled) return;
    driver.settled = true;
    if (this.driver === driver) this.driver = undefined;
    action();
  }

  private driverFor(turnId: number): TurnDriver | undefined {
    const driver = this.driver;
    if (driver === undefined || driver.turnId === undefined || driver.turnId !== turnId) {
      return undefined;
    }
    return driver;
  }

  private assignForkTurnIndex(event: AgentEventPayloads['turn.started']): void {
    if (!isUserVisibleTurnOrigin(event.origin)) return;
    this.forkTurnIdByTurn.set(event.turnId, String(event.turnId));
  }

  /** Emit a turn's update, carrying its fork position when it has one. */
  private emitForTurn(turnId: number, notification: SessionNotification | null): void {
    this.emit(withLodyTurnId(notification, this.forkTurnIdByTurn.get(turnId)));
  }

  private onAssistantDelta(event: AgentEventPayloads['assistant.delta']): void {
    this.emitForTurn(event.turnId, assistantDeltaToSessionUpdate(this.sessionId, event));
  }

  private onThinkingDelta(event: AgentEventPayloads['thinking.delta']): void {
    this.emitForTurn(event.turnId, thinkingDeltaToSessionUpdate(this.sessionId, event));
  }

  private onToolCallStarted(event: AgentEventPayloads['tool.call.started']): void {
    // The klient payload mirrors `ToolCallStartedEvent` (`args` / `display`
    // arrive as `unknown` — cast at this seam).
    const mapped = event as unknown as ToolCallStartedEvent;
    const key = acpToolCallId(event.turnId, event.toolCallId);
    const locations = toolCallLocations(mapped.name, mapped.args, mapped.display);
    if (locations !== undefined) {
      this.toolLocations.set(key, locations);
    }
    if (mapped.name === 'Bash') {
      const command = (mapped.args as { command?: unknown } | undefined)?.command;
      if (typeof command === 'string') {
        this.bashCallsAwaitingTerminal.set(key, command);
      }
    }
    const streamArgs = { args: stringifyArgs(mapped.args) };
    const lazyCreated = this.toolCallStreamArgs.has(key);
    this.toolCallStreamArgs.set(key, streamArgs);
    this.emitForTurn(
      event.turnId,
      lazyCreated
        ? toolCallStartedUpgradeToSessionUpdate(this.sessionId, mapped)
        : toolCallStartToSessionUpdate(this.sessionId, mapped),
    );
    if (event.display !== undefined) {
      this.emitForTurn(
        event.turnId,
        planFromDisplayBlock(
          this.sessionId,
          event.turnId,
          event.display as ToolInputDisplay,
          event.toolCallId,
          this.supportsPlan,
        ),
      );
    }
  }

  private onToolCallDelta(event: AgentEventPayloads['tool.call.delta']): void {
    // The klient payload mirrors `ToolCallDeltaEvent` field-for-field.
    const mapped = event as unknown as ToolCallDeltaEvent;
    const key = acpToolCallId(event.turnId, event.toolCallId);
    const acc = this.toolCallStreamArgs.get(key);
    if (acc === undefined) {
      this.toolCallStreamArgs.set(key, { args: event.argumentsPart ?? '' });
      this.emitForTurn(event.turnId, toolCallLazyCreateToSessionUpdate(this.sessionId, mapped));
      return;
    }
    // Subsequent delta — the helper accumulates the fragment and emits an
    // update with the cumulative args text (REPLACE-content semantics).
    this.emitForTurn(event.turnId, toolCallDeltaToSessionUpdate(this.sessionId, mapped, acc));
  }

  private onToolUpdated(event: AgentEventPayloads['tool.updated']): void {
    const key = acpToolCallId(event.turnId, event.toolCallId);
    const status = event.fields['status'];
    if (typeof status !== 'string' || status.length === 0 || this.toolStatuses.get(key) === status)
      return;
    this.toolStatuses.set(key, status);
    // The klient payload mirrors `ToolUpdatedEvent` field-for-field; the
    // helper forwards only `status` updates with text (as a title refresh)
    // and returns null for everything else, which `emit` drops.
    this.emitForTurn(
      event.turnId,
      toolUpdatedToSessionUpdate(this.sessionId, event as unknown as ToolUpdatedEvent),
    );
  }

  private onToolResult(event: AgentEventPayloads['tool.result']): void {
    const key = acpToolCallId(event.turnId, event.toolCallId);
    this.toolStatuses.delete(key);
    const locations = this.toolLocations.get(key);
    this.toolLocations.delete(key);
    this.bashCallsAwaitingTerminal.delete(key);
    this.toolCallStreamArgs.delete(key);
    const terminalId = this.terminalBackedCalls.get(key);
    this.terminalBackedCalls.delete(key);
    if (terminalId !== undefined) {
      // Terminal-backed call: the client already renders the output bytes in
      // the terminal pane, so the card gets the terminal embed instead of a
      // textual copy. The full output still reached the model (and the
      // persisted wire record) untouched.
      this.emitForTurn(event.turnId, {
        sessionId: this.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: key,
          status: event.isError === true ? 'failed' : 'completed',
          content: [{ type: 'terminal', terminalId }],
          locations,
        },
      });
      return;
    }
    this.emitForTurn(
      event.turnId,
      toolResultToSessionUpdate(this.sessionId, event as unknown as ToolResultEvent, locations),
    );
  }

  private onTerminalCreated(event: AcpTerminalCreatedEvent): void {
    if (event.sessionId !== this.sessionId) return;
    for (const [key, command] of this.bashCallsAwaitingTerminal) {
      if (command.length === 0 || !event.shellCommand.endsWith(command)) continue;
      this.bashCallsAwaitingTerminal.delete(key);
      this.terminalBackedCalls.set(key, event.terminalId);
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: key,
          content: [{ type: 'terminal', terminalId: event.terminalId }],
        },
      });
      return;
    }
  }

  /** Represent compaction through the standard ACP tool-call lifecycle. */
  private onCompactionStarted(event: AgentEventPayloads['compaction.started']): void {
    // The runtime can re-announce a compaction that is already in flight.
    // History merges tool calls by id, so minting a fresh one per announcement
    // renders a single compaction as n stacked "Compacting context" rows — and
    // only the last id is still correlated when the terminal event lands,
    // leaving every earlier row spinning forever.
    if (this.activeCompaction !== undefined) return;
    const id = `context-compaction:${randomUUID()}`;
    const automatic = event.trigger === 'auto';
    this.activeCompaction = { id, automatic };
    const activity: LodyActivityMeta = {
      version: 1,
      kind: 'context_compaction',
      automatic,
    };
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: 'Compacting context',
        kind: 'think',
        status: 'in_progress',
        _meta: { lody: { activity } },
      },
    });
  }

  /** Report the compaction token result on the same tool call. */
  private onCompactionCompleted(event: AgentEventPayloads['compaction.completed']): void {
    const active = this.activeCompaction;
    // Terminal events without a matching start cannot be correlated safely.
    if (active === undefined) return;
    this.activeCompaction = undefined;
    const activity: LodyActivityMeta = {
      version: 1,
      kind: 'context_compaction',
      automatic: active.automatic,
      usedTokensBefore: event.result.tokensBefore,
      usedTokensAfter: event.result.tokensAfter,
    };
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: active.id,
        title: 'Context compacted',
        status: 'completed',
        _meta: { lody: { activity } },
      },
    });
  }

  private onCompactionCancelled(): void {
    const active = this.activeCompaction;
    if (active === undefined) return;
    this.activeCompaction = undefined;
    const title = 'Compaction cancelled';
    const activity: LodyActivityMeta = {
      version: 1,
      kind: 'context_compaction',
      automatic: active.automatic,
      failureReason: title,
    };
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: active.id,
        title,
        status: 'failed',
        _meta: { lody: { activity } },
      },
    });
  }

  private onTurnEnded(event: AgentEventPayloads['turn.ended']): void {
    void Promise.all([
      this.emitUsageUpdate(),
      this.emitDetailedUsageUpdate(),
      this.emitManagedUsage(),
    ]);
    const driver = this.driverFor(event.turnId);
    if (driver === undefined) return;
    const error = event.error as { readonly code: string; readonly message?: string } | undefined;
    if (event.reason === 'failed' && isAuthError(error)) {
      // Auth failures must surface as a JSON-RPC `auth_required` error right
      // away so the client triggers its re-auth flow — waiting on background
      // work would only delay a turn that produced nothing.
      this.settleDriver(driver, () => {
        driver.reject(RequestError.authRequired(undefined, error?.message));
      });
    } else {
      driver.pendingStopReason = turnEndReasonToStopReason(event.reason, error);
      this.settleHeldPromptIfDrained();
    }
  }

  /**
   * Settle a prompt whose turn ended, once the background work it started has
   * drained: no turn running on this agent (including one the ENGINE opened
   * to report a finished subagent or a cron fire), no subagent task still
   * alive, and no wake turn owed. Until then the client's `session/prompt`
   * stays in flight, which is what keeps the conversation reported as running
   * while a detached subagent works — matching agents that run a subagent
   * inside its spawning tool call.
   */
  private settleHeldPromptIfDrained(): void {
    const driver = this.driver;
    if (driver === undefined || driver.settled) return;
    const stopReason = driver.pendingStopReason;
    if (stopReason === undefined) return;
    if (this.runningTurns.size > 0) return;
    if (this.activeSubagentTasks.size > 0) return;
    if (this.wakeTurnGrace !== undefined) return;
    driver.pendingStopReason = undefined;
    this.settleDriver(driver, () => {
      driver.resolve({ stopReason });
    });
  }

  /**
   * Hold settlement across the gap between `task.terminated` and its wake
   * turn. Armed whatever the spawning turn is doing: when the task finishes
   * first, this is what keeps the turn's own end from settling before the
   * report arrives.
   */
  private startWakeTurnGrace(): void {
    this.clearWakeTurnGrace();
    const timer = setTimeout(() => {
      this.wakeTurnGrace = undefined;
      this.settleHeldPromptIfDrained();
    }, WAKE_TURN_GRACE_MS);
    // The grace period must never be the reason the process stays alive.
    timer.unref?.();
    this.wakeTurnGrace = timer;
  }

  private clearWakeTurnGrace(): void {
    if (this.wakeTurnGrace === undefined) return;
    clearTimeout(this.wakeTurnGrace);
    this.wakeTurnGrace = undefined;
  }

  /** Provider-neutral task snapshot used by Lody's subagent management UI. */
  async listSubagents(activeOnly = false): Promise<readonly SubagentTaskInfo[]> {
    return (await this.agent.getTasks({ activeOnly })).filter(
      (task): task is SubagentTaskInfo => task.kind === 'agent',
    );
  }

  async cancelSubagent(taskId: string, reason?: string): Promise<void> {
    await this.agent.stopTask({ taskId, reason });
  }

  subagentOutput(taskId: string, tail?: number): Promise<string> {
    return this.agent.getTaskOutput({ taskId, tail: Math.min(tail ?? 2_000, 2_000) });
  }

  private async emitTaskLifecycle(
    event: 'started' | 'terminated',
    task: AgentTaskInfo,
  ): Promise<void> {
    if (task.kind !== 'agent') return;
    if (this.subagentEvents !== undefined) {
      this.subagentEvents.task(event, task);
      await this.subagentEvents.drain();
      return;
    }
    let output: string | undefined;
    if (event === 'terminated') {
      try {
        output = await this.agent.getTaskOutput({ taskId: task.taskId, tail: 2_000 });
      } catch {
        // The task registry is still authoritative when output has already rotated away.
      }
    }
    const params = toLodyTaskLifecycle(this.sessionId, event, task, output);
    await this.conn.sessionUpdate(params);
  }

  private emitDetailedUsageUpdate(): Promise<void> {
    this.lodyUsageEmission = this.lodyUsageEmission.then(() => this.pushDetailedUsageUpdate());
    return this.lodyUsageEmission;
  }

  private async pushDetailedUsageUpdate(): Promise<void> {
    try {
      await this.captureDetailedUsage(true);
      const contextWindow = (await this.klient.global.kosong.listModels()).find(
        (item) => item.model === this.currentModelId,
      )?.max_context_size;
      const snapshot = Object.fromEntries(this.lodyUsageSinceActivation);
      const update = toLodySessionUsage(
        this.sessionId,
        snapshot,
        contextWindow,
        this.lodyUsageLastEmitted,
      );
      if (update !== null) {
        await this.conn.extensionNotification(LODY_EXTENSION_METHODS.sessionUsageUpdate, {
          ...update,
          _meta: { lody: { usageScopeId: this.lodyUsageScopeId } },
        });
        this.lodyUsageLastEmitted = snapshot;
      }
    } catch (error) {
      log.warn('acp: failed to push Lody token usage', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async captureDetailedUsage(includeDelta: boolean): Promise<void> {
    const meta = await this.session.agents();
    const agentIds = new Set(['main', ...Object.keys(meta)]);
    for (const agentId of agentIds) {
      const handle = this.session.agent(agentId);
      try {
        const status = await handle.getUsage();
        const byModel = await this.usageByModel(handle, status);
        for (const [model, usage] of Object.entries(byModel)) {
          const baselineKey = `${agentId}\0${model}`;
          const previous = this.lodyUsageBaselines.get(baselineKey);
          this.lodyUsageBaselines.set(baselineKey, { ...usage });
          if (!includeDelta) continue;
          const delta = tokenUsageDelta(usage, previous);
          if (!hasTokenUsage(delta)) continue;
          this.lodyUsageSinceActivation.set(
            model,
            addTokenUsage(this.lodyUsageSinceActivation.get(model), delta),
          );
        }
      } catch (error) {
        log.warn('acp: failed to read agent token usage', {
          sessionId: this.sessionId,
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async usageByModel(
    handle: AgentHandle,
    status: UsageStatus,
  ): Promise<Readonly<Record<string, TokenUsage>>> {
    if (status.byModel !== undefined) return status.byModel;
    if (status.total === undefined) return {};
    const model = await handle.getModel();
    return { [model || 'unknown']: status.total };
  }

  private async emitManagedUsage(): Promise<void> {
    try {
      const usage = await this.klient.global.auth.managedUsage();
      await this.emitExtension(
        LODY_EXTENSION_METHODS.rateLimitsUpdate,
        toLodyRateLimits(usage) as unknown as Record<string, unknown>,
      );
    } catch (error) {
      log.warn('acp: failed to push Lody managed usage', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async emitExtension(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.conn.extensionNotification(method, params);
    } catch (error) {
      log.warn('acp: failed to push extension notification', {
        sessionId: this.sessionId,
        method,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async emitUsageUpdate(): Promise<void> {
    try {
      const size = (await this.klient.global.kosong.listModels()).find(
        (item) => item.model === this.currentModelId,
      )?.max_context_size;
      if (size === undefined) return;
      const context = await this.agent.getContext();
      this.emit(usageUpdateNotification(this.sessionId, context.tokenCount, size));
    } catch (error) {
      log.warn('acp: failed to push usage_update', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private onMetadataChanged(event: SessionEventPayloads['metadata.changed']): void {
    if (!event.changed.includes('title') && !event.changed.includes('titleKind')) return;
    void this.emitSessionInfoUpdate();
  }

  private async emitSessionInfoUpdate(): Promise<void> {
    try {
      const meta = await this.session.get();
      this.emit(sessionInfoUpdateNotification(this.sessionId, meta.title ?? null, meta.titleKind));
    } catch (error) {
      log.warn('acp: failed to push session_info_update', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emit(notification: SessionNotification | null): void {
    if (notification === null) return;
    void this.conn.sessionUpdate(notification).catch((error) => {
      log.warn('acp: failed to push session/update', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  cancel(): void {
    for (const pending of this.pendingPromptAborts) {
      pending.aborted = true;
    }
    const driver = this.driver;
    if (driver === undefined || driver.settled) return;
    if (driver.pendingStopReason !== undefined) {
      // The prompt is only being held open for background work; its own turn
      // is already over. Cancel whatever the engine opened in the meantime (a
      // wake turn reporting a finished subagent, a cron fire) and stop
      // waiting. Detached subagents keep running on purpose — they outlive
      // the turn by design and have their own cancellation surface.
      if (this.runningTurns.size > 0) this.cancelAgentTurn('held prompt');
      this.clearWakeTurnGrace();
      driver.pendingStopReason = undefined;
      this.settleDriver(driver, () => {
        driver.resolve({ stopReason: 'cancelled' });
      });
      return;
    }
    const turnId = driver.turnId;
    if (turnId === undefined) {
      driver.cancelRequested = true;
      this.cancelAgentTurn('unaddressed');
      return;
    }
    this.cancelAgentTurn('addressed', turnId);
  }

  /**
   * Ask the engine to stop a turn, fire-and-forget. An omitted `turnId`
   * cancels whatever turn is active — the engine's contract for a cancel that
   * cannot name its target yet.
   */
  private cancelAgentTurn(context: string, turnId?: number): void {
    void this.agent.cancel(turnId === undefined ? undefined : { turnId }).catch((error) => {
      log.warn('acp: cancel failed', {
        sessionId: this.sessionId,
        context,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async configOptions(): Promise<SessionConfigOption[]> {
    const models = projectModelCatalog(await this.klient.global.kosong.listModels());
    const permission = await this.agent.getPermission();
    this.currentModeId = permission === 'manual' ? 'default' : permission;
    this.planMode = (await this.agent.getPlan()) !== null;
    return buildSessionConfigOptions(
      models,
      this.currentModelId,
      this.currentThinkingLevel,
      this.currentModeId,
      this.planMode,
    );
  }

  /**
   * The first-class `modes` ({@link SessionModeState}) snapshot for the
   * `session/new` / `session/load` / `session/resume` responses — the same
   * permission choices the `permission_mode` config option projects.
   */
  modeState(): SessionModeState {
    return {
      currentModeId: this.currentModeId,
      availableModes: ACP_MODES.filter((mode) => mode.id !== 'plan'),
    };
  }

  async setModel(id: string): Promise<void> {
    const suffix = ',thinking';
    const hasSuffix = id.endsWith(suffix);
    const baseId = hasSuffix ? id.slice(0, -suffix.length) : id;
    await this.agent.setModel(baseId);
    this.currentModelId = baseId;
    if (hasSuffix) {
      const models = projectModelCatalog(await this.klient.global.kosong.listModels());
      const level = models.find((model) => model.id === baseId)?.defaultThinkingEffort ?? 'on';
      await this.agent.setThinking(level);
      this.currentThinkingLevel = level;
    }
    await this.emitConfigOptionUpdate();
  }

  async setThinking(value: string): Promise<boolean> {
    const models = projectModelCatalog(await this.klient.global.kosong.listModels());
    const entry = models.find((model) => model.id === this.currentModelId);
    const efforts = entry?.supportEfforts;
    const alwaysThinking = entry?.alwaysThinking === true;
    const allowed =
      efforts !== undefined
        ? alwaysThinking
          ? efforts
          : ['off', ...efforts]
        : alwaysThinking
          ? ['on']
          : ['off', 'on'];
    let level: string;
    if (allowed.includes(value)) {
      level = value;
    } else if (value === 'on' && efforts !== undefined) {
      level = entry?.defaultThinkingEffort ?? 'on';
    } else {
      return false;
    }
    await this.agent.setThinking(level);
    this.currentThinkingLevel = level;
    await this.emitConfigOptionUpdate();
    return true;
  }

  /** Legacy mode requests remain readable; new clients use independent config options. */
  async setMode(id: AcpModeId): Promise<void> {
    if (id === 'plan') {
      await this.setPlanMode(true);
      return;
    }
    await this.agent.setPermission(id === 'default' ? 'manual' : id);
    this.currentModeId = id;
    this.emit(currentModeUpdateNotification(this.sessionId, id));
    await this.emitConfigOptionUpdate();
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    const active = (await this.agent.getPlan()) !== null;
    if (active !== enabled) {
      if (enabled) await this.agent.enterPlan();
      else await this.agent.cancelPlan();
    }
    this.planMode = enabled;
    await this.emitConfigOptionUpdate();
  }

  /** Push a fresh `config_option_update` to the client. */
  private async emitConfigOptionUpdate(): Promise<void> {
    try {
      await this.conn.sessionUpdate(
        configOptionUpdateNotification(this.sessionId, await this.configOptions()),
      );
    } catch (error) {
      log.warn('acp: failed to push config_option_update', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
