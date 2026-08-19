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
import type { ContextMessage, ForkTurnSummary } from '@moonshot-ai/agent-core-v2';
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
import type {
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolInputDisplay,
  ToolProgressEvent,
  ToolResultEvent,
} from '@moonshot-ai/protocol';

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
  toolProgressToSessionUpdate,
  toolResultToSessionUpdate,
  turnEndReasonToStopReason,
  usageUpdateNotification,
  isAuthError,
  stringifyArgs,
} from './events-map';
import { AcpInteractionBridge } from './interaction-bridge';
import { log } from './log';
import {
  addTokenUsage,
  hasTokenUsage,
  isForkableTurnOrigin,
  LODY_KIMI_METHODS,
  type TokenUsage,
  tokenUsageDelta,
  toLodyRateLimits,
  toLodySessionUsage,
  toLodyTaskLifecycle,
  withLodyTurnId,
} from './lody-extension';
import { projectModelCatalog } from './model-catalog';
import { ACP_MODES, type AcpModeId, acpModeToToggles, DEFAULT_MODE_ID } from './modes';
import { projectHistoryToSessionUpdates } from './replay';
import { buildAcpSkillSlashCommands, detectSlashIntent } from './slash';

/** Leading text of the first text block, if any (used for slash detection). */
function leadingText(blocks: readonly ContentBlock[]): string | undefined {
  const first = blocks[0];
  if (first !== undefined && first.type === 'text') return first.text;
  return undefined;
}

/**
 * The engine's wire code for "another turn is active". A plain
 * `agent.prompt` while busy is QUEUED by the engine (the RPC returns
 * `undefined`, indistinguishable from a hook-blocked launch), so this code
 * only reaches us from `agent.activateSkill`, which rejects instead.
 */
const TURN_AGENT_BUSY_CODE = 'turn.agent_busy';

/**
 * Map a prompt-launch rejection (from `agent.prompt` / `agent.activateSkill`)
 * to the JSON-RPC error the client sees.
 *
 *  - Auth-coded failures surface as `auth_required` so the client drives its
 *    re-auth flow (same mapping as the `turn.ended` auth path).
 *  - `turn.agent_busy` maps to `invalidRequest` (-32600), matching the legacy
 *    adapter's busy-prompt semantics.
 *  - Everything else becomes a fixed-message `internalError` (-32603): the
 *    raw engine message and stack are logged server-side but NEVER cross the
 *    wire, so internal details cannot leak into the JSON-RPC channel.
 */
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
  log.error('acp: prompt launch failed', {
    sessionId,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
  });
  return RequestError.internalError(undefined, 'session prompt failed');
}

/** Per-turn settlement state for one in-flight `session/prompt`. */
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
  /**
   * Learned once the launch call (`agent.prompt` / `agent.activateSkill`)
   * resolves. Events carry a `turnId`, but until this is set no turn-scoped
   * event can be attributed to this prompt — and the turn may START (with a
   * fast model even END) before the launch round-trip delivers the id. Such
   * events are buffered in {@link early} instead of being dropped.
   */
  turnId?: number;
  settled: boolean;
  /**
   * Set when `cancel()` arrives while {@link turnId} is still unknown: the
   * launch handler re-issues a precisely-addressed cancel once the id lands,
   * and a no-launch outcome settles `cancelled` instead of `end_turn`.
   */
  cancelRequested?: boolean;
  /**
   * Turn-scoped events that arrived while `turnId` was still unknown. Once
   * the launch resolves, the entries matching the driver's turn are replayed
   * in arrival order; the rest (a still-draining prior turn) are dropped —
   * the same verdict the live path would have given.
   */
  early: Array<{ readonly turnId: number; readonly dispatch: () => void }>;
  /**
   * Settlement withheld while background work this prompt started is still
   * running. A detached subagent outlives the turn that spawned it and the
   * engine reports its result by opening a FOLLOW-UP turn on this agent, so
   * settling at the first `turn.ended` would report the conversation idle
   * with the answer still to come. Held prompts settle from
   * {@link AcpSession.settleHeldPromptIfDrained} instead.
   */
  pendingSettle?: () => void;
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
  /** The klient facade this session was created from. */
  private readonly klient: Klient;
  private readonly session: SessionHandle;
  private readonly agent: AgentHandle;

  /** Currently-selected model id (bare, no suffix). Empty when unbound. */
  private currentModelId: string = '';
  /** The engine's current thinking level verbatim (`'off'`, `'on'`, or an effort). */
  private currentThinkingLevel: string = 'off';
  /** Current ACP mode. */
  private currentModeId: AcpModeId = DEFAULT_MODE_ID;
  /**
   * Cached session skill summaries — the backing data for slash-intent
   * detection and `availableCommands()`. Seeded in `init()` and refreshed on
   * the klient `skills.changed` event.
   */
  private skills: readonly SkillSummary[] = [];
  /** The in-flight prompt's driver, if any. */
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
   * Engine turn id → the fork turn index that turn can be forked at. The
   * engine addresses forks by position among user-visible turns, so this is
   * the id published to the client (`_meta.lody.turnId`) and the value it
   * sends back in `session/fork`.
   */
  private readonly forkTurnIndexByTurn = new Map<number, number>();
  /**
   * Index the next user-visible turn will take, anchored at activation from
   * the engine's own record-level count. Undefined when that read failed —
   * publishing a guessed position would fork the wrong turn, so we publish
   * nothing instead.
   */
  private nextForkTurnIndex: number | undefined;
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
  /** Session-level agent-event subscriptions, torn down by `dispose()`. */
  private readonly subscriptions: IDisposable[] = [];
  /**
   * Streaming-args accumulators for in-flight tool calls, keyed by the ACP
   * wire toolCallId. An entry's existence doubles as "the wire `tool_call`
   * CREATE was sent" — either lazy-created from the first `tool.call.delta`
   * (the engine streams args deltas BEFORE `tool.call.started`) or created by
   * `tool.call.started` itself. Seeded/reseeded with the full stringified
   * args at started so any post-started delta emits cumulative REPLACE
   * content that includes the initial args. Cleaned at `tool.result`.
   */
  private readonly toolCallStreamArgs = new Map<string, { args: string }>();
  /**
   * Locations derived at `tool.call.started`, keyed by the ACP wire
   * toolCallId, re-attached to the terminal `tool_call_update`
   * (`tool.result` carries no args/display of its own).
   */
  private readonly toolLocations = new Map<string, ToolCallLocation[]>();
  /**
   * In-flight Bash tool calls awaiting terminal correlation, keyed by the ACP
   * wire toolCallId; the value is the model's `args.command`. Filled at
   * `tool.call.started`, consumed by {@link onTerminalCreated} (or dropped at
   * `tool.result`).
   */
  private readonly bashCallsAwaitingTerminal = new Map<string, string>();
  /**
   * Tool calls whose execution runs in a client terminal: ACP wire toolCallId
   * → terminalId. Their terminal `tool_call_update` carries a
   * `{type: 'terminal'}` content entry instead of the textual output (the
   * client already renders the bytes in the terminal pane — showing them in
   * the card too would duplicate them). The model still receives the full
   * captured output; only the client-facing card content is de-duplicated.
   */
  private readonly terminalBackedCalls = new Map<string, string>();
  /** Cumulative engine counters captured when this ACP activation began. */
  private readonly lodyUsageBaselines = new Map<string, TokenUsage>();
  /** Cumulative usage attributable only to this ACP activation. */
  private readonly lodyUsageSinceActivation = new Map<string, TokenUsage>();
  /** Bridges engine approval / ask-user requests to the ACP client. */
  private readonly interactionBridge: AcpInteractionBridge;

  constructor(
    private readonly conn: AcpClient,
    klient: Klient,
    readonly sessionId: string,
    private readonly acpConnection: IAcpConnection,
    /**
     * Whether the client advertised `elicitation.form` at `initialize` —
     * forwarded to the interaction bridge's ask-user routing.
     */
    elicitationForm: boolean,
    /**
     * Resolve the session's media-originals dir for prompt-image compression
     * (`sessionMediaOriginalsDir(sessionDir)` when the live session scope is
     * reachable). Undefined / returning undefined → `persistOriginalImage`'s
     * shared temp-dir fallback applies.
     */
    private readonly resolveOriginalsDir?: (sessionId: string) => string | undefined,
    private readonly hostCommands: ReadonlyArray<AvailableCommand> | HostSlashCommandsSnapshot = [],
  ) {
    this.klient = klient;
    this.session = klient.session(sessionId);
    // `main` is auto-materialized by the transport's scope resolution on the
    // first call — no explicit agent bootstrap is needed here.
    this.agent = this.session.agent('main');
    this.interactionBridge = new AcpInteractionBridge(
      conn,
      this.session,
      sessionId,
      elicitationForm,
    );
  }

  /**
   * Subscribe the agent event stream and seed the config state. Must be
   * awaited before the first `prompt` so no early turn events are missed.
   */
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
      events.on('tool.progress', (event) => {
        this.onToolProgress(event);
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
        // Settlement stays turn-scoped (only this prompt's own turn resolves
        // it), but the drain check runs for every turn — an engine-opened
        // turn ending is what releases a held prompt.
        this.dispatchTurnEvent(event.turnId, () => {
          this.onTurnEnded(event);
        });
        this.settleHeldPromptIfDrained();
      }),
      events.on('task.started', (event) => {
        if (event.info.kind === 'agent') {
          this.activeSubagentTasks.add(event.info.taskId);
        }
        void this.emitTaskLifecycle('started', event.info);
      }),
      events.on('task.terminated', (event) => {
        if (event.info.kind === 'agent') {
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
      events.on('compaction.started', (event) => {
        this.onCompactionStarted(event);
      }),
      events.on('compaction.completed', (event) => {
        this.onCompactionCompleted(event);
      }),
      events.on('compaction.cancelled', () => {
        this.emitLocalChunk('Compaction cancelled.');
      }),
      events.on('compaction.blocked', () => {
        this.emitLocalChunk(
          'Compaction is blocked by the current turn; retry when the turn is idle.',
        );
      }),
    );
    // Session-scope stream: title changes surface as `session_info_update`.
    this.subscriptions.push(
      this.session.events.on('metadata.changed', (event) => {
        this.onMetadataChanged(event);
      }),
    );
    // Skill catalog changes refresh the cache and re-push the available
    // commands so the client's slash menu tracks the live catalog.
    this.subscriptions.push(
      this.session.events.on('skills.changed', () => {
        void this.refreshSkills().then(() => this.emitAvailableCommandsUpdate());
      }),
    );
    // Terminal correlation: the ACP-backed process runner (same process,
    // App-scope holder) announces every terminal it creates so this session
    // can attach it to the matching in-flight Bash tool call.
    const unsubscribeTerminal = this.acpConnection.onTerminalCreated((event) => {
      this.onTerminalCreated(event);
    });
    this.subscriptions.push({ dispose: unsubscribeTerminal });
    try {
      this.currentModelId = await this.agent.getModel();
      this.currentThinkingLevel = await this.agent.getThinking();
    } catch (error) {
      // Keep the unbound defaults — configOptions stays honest.
      log.warn('acp: could not seed model/thinking state', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Awaited: the post-`session/new` `available_commands_update` must already
    // carry the skills (see `activateSession`).
    await this.refreshSkills();
    await this.anchorForkTurnIndex();
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

  /** Refresh the skill cache from the session catalog (best-effort). */
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

  /**
   * Tear down per-session resources. Settles an in-flight prompt as
   * cancelled, stops forwarding approval / ask-user requests to the client,
   * and detaches the event subscriptions. Idempotent.
   */
  dispose(): void {
    this.clearWakeTurnGrace();
    this.cancel();
    const driver = this.driver;
    if (driver !== undefined) {
      // Never leave the JSON-RPC `session/prompt` hanging after teardown.
      this.settleDriver(driver, () => {
        driver.resolve({ stopReason: 'cancelled' });
      });
    }
    this.interactionBridge.dispose();
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
  }

  /**
   * Replay the main agent's persisted context history as an ordered batch of
   * `session/update` notifications. Used by `session/load` so the client
   * re-renders prior turns before the response settles. Awaits every push for
   * ordering — replay is a one-shot batch, not a live stream.
   */
  async replayHistory(): Promise<void> {
    let messages: readonly ContextMessage[];
    try {
      // `history` items cross the wire as JSON-cloned `ContextMessage`s (the
      // facade types them via the engine RPC signature).
      messages = (await this.agent.getContext()).history;
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
        // A single transient push failure must not truncate the whole replay;
        // log and continue so the rest of the history still lands.
        log.warn('acp: replayHistory failed to push a session/update; continuing', {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Resolve the current command catalog. Builtins always win, followed by
   * engine skills and then host-provided commands; duplicate names are dropped.
   * Host aliases only participate in skill activation when that alias is also
   * present in the advertised command list.
   */
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

  /** Return the same merged command palette that is advertised to the client. */
  availableCommands(): AvailableCommand[] {
    return this.resolveCommands().commands;
  }

  /** Push the current `available_commands_update` to the client. */
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
    // Slash-intent detection: builtin commands execute locally without an LLM
    // turn; skills activate through the engine (rendered skill prompt driven
    // as a normal turn); unknown slash commands are answered locally with an
    // "unknown command" notice (never sent to the model); non-slash input
    // goes to the model as-is.
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
      // Cancelled while compressing (see `cancel()`): settle without
      // launching a turn.
      return { stopReason: 'cancelled' };
    }
    return this.driveTurn(content);
  }

  /**
   * Convert the ACP blocks to engine content parts and run the input-stage
   * image compression (see `compressPromptImageParts`). Compression happens
   * before any turn exists, so honor a `session/cancel` that arrives during
   * it: `cancel()` flips the marker and this returns `undefined` rather than
   * launching a turn the client already asked to stop. Returns the compressed
   * parts otherwise.
   */
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

  /**
   * Answer an unknown slash command locally (no LLM turn): push the notice as
   * one `agent_message_chunk`, then settle the prompt with `end_turn`. The
   * wording mirrors the legacy adapter's `runUnknownSlashCommand`.
   */
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

  /**
   * Activate a skill through the engine (`IAgentSkillService.activate` behind
   * the klient facade): the engine renders the skill prompt (content + args)
   * and drives it as a normal turn, so the turn events stream and settle
   * exactly like a plain prompt. Empty args go over as `undefined`, matching
   * the other consumers.
   */
  private driveSkillActivation(skillName: string, args: string): Promise<PromptResponse> {
    this.assertNoActiveTurn();
    return this.driveLaunch(
      this.agent.activateSkill({ name: skillName, args: args.length > 0 ? args : undefined }),
    );
  }

  /**
   * Execute an ACP builtin slash command locally: render its text from live
   * klient/engine state (no LLM turn), push it as one `agent_message_chunk`,
   * then settle the prompt with `end_turn`. The chunk push is awaited so it
   * lands before the prompt response.
   */
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

  /**
   * The skill command lookup, projected from the cached skill summaries
   * (command name → skill name, including the `skill:`-prefixed entries).
   */
  private skillCommandMap(): ReadonlyMap<string, string> {
    return buildAcpSkillSlashCommands(this.skills).commandMap;
  }

  /**
   * Reject a second model-bound prompt while a turn is in flight. The engine
   * QUEUES a plain `agent.prompt` submitted during an active turn (the launch
   * resolves `undefined`, indistinguishable from a hook-blocked launch), and
   * tracking that queued turn would overwrite the only in-flight driver — the
   * first prompt would never settle and both turns' events would go
   * unattributed. The legacy adapter rejected this case (`turn.agent_busy` →
   * -32600); reject locally instead, synchronously with driver assignment so
   * two concurrent prompts cannot race past the check.
   */
  private assertNoActiveTurn(): void {
    if (this.driver !== undefined && !this.driver.settled) {
      throw RequestError.invalidRequest(
        { code: TURN_AGENT_BUSY_CODE },
        'another turn is already in progress',
      );
    }
  }

  /**
   * Submit the prompt and drive the turn to completion: `agent.prompt()`
   * returns the launched turn id, which the session-level event handlers use
   * to attribute events to this driver. Settles on `turn.ended`; a no-launch
   * result (hook-blocked / not runnable) settles with `end_turn`.
   */
  private driveTurn(input: readonly ContentPart[]): Promise<PromptResponse> {
    this.assertNoActiveTurn();
    return this.driveLaunch(this.agent.prompt({ input }));
  }

  /**
   * Shared turn settlement for every launch path (`agent.prompt`,
   * `agent.activateSkill`): the returned turn id attributes subsequent events
   * to this driver; `undefined` means no turn launched (hook-blocked / not
   * runnable — the busy case never gets this far, see
   * {@link assertNoActiveTurn}), so the prompt settles gracefully with
   * `end_turn`.
   */
  private driveLaunch(launch: Promise<PromptLaunchResult>): Promise<PromptResponse> {
    return new Promise<PromptResponse>((resolve, reject) => {
      const driver: TurnDriver = { resolve, reject, settled: false, early: [] };
      this.driver = driver;
      launch.then(
        (launched) => {
          if (driver.settled) return;
          if (launched === undefined) {
            // No turn will emit `turn.ended`, so settle gracefully. The engine
            // publishes a `prompt.completed` with reason 'blocked' for the
            // hook-blocked case; the wire carries no blocking message to
            // surface, matching the old `PromptHandle`-based behavior.
            this.settleDriver(driver, () => {
              resolve({ stopReason: driver.cancelRequested === true ? 'cancelled' : 'end_turn' });
            });
            return;
          }
          driver.turnId = launched.turn_id;
          if (driver.cancelRequested === true) {
            // A cancel arrived before the id was known (see `cancel()`): the
            // unaddressed cancel may have predated the turn's activation, so
            // re-issue it now precisely addressed. Idempotent.
            void this.agent.cancel({ turnId: launched.turn_id }).catch((error) => {
              log.warn('acp: deferred cancel failed', {
                sessionId: this.sessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
          // Replay the events the turn emitted before its id arrived (a fast
          // turn can outrun the launch round-trip — `activateSkill` returns
          // only after the prompt-metadata update).
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

  /**
   * Route a turn-scoped event: buffer it while the in-flight prompt's turn id
   * is still unknown (see {@link TurnDriver.early}), otherwise dispatch live.
   */
  private dispatchTurnEvent(turnId: number, dispatch: () => void): void {
    const driver = this.driver;
    if (driver !== undefined && !driver.settled && driver.turnId === undefined) {
      driver.early.push({ turnId, dispatch });
      return;
    }
    dispatch();
  }

  /**
   * Settle the driver exactly once and detach it from the session so later
   * events of its turn are ignored.
   */
  private settleDriver(driver: TurnDriver, action: () => void): void {
    if (driver.settled) return;
    driver.settled = true;
    if (this.driver === driver) this.driver = undefined;
    action();
  }

  /** The active driver, but only for events of ITS turn. */
  private driverFor(turnId: number): TurnDriver | undefined {
    const driver = this.driver;
    if (driver === undefined || driver.turnId === undefined || driver.turnId !== turnId) {
      return undefined;
    }
    return driver;
  }

  /**
   * Read the engine's current fork turn count so published positions line up
   * with the records `fork({ turnIndex })` slices. A rendered history cannot
   * supply this: compaction drops messages from context while the records
   * defining those positions stay.
   */
  private async anchorForkTurnIndex(): Promise<void> {
    try {
      this.nextForkTurnIndex = (await this.session.forkTurns()).length;
    } catch (error) {
      this.nextForkTurnIndex = undefined;
      log.warn('acp: fork turn positions unavailable; fork-at-turn will be inert', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Claim this turn's fork position. Only turns the engine counts as
   * user-visible take an index — a wake turn or a cron fire is not a fork
   * boundary, and consuming an index for one would shift every later turn.
   */
  private assignForkTurnIndex(event: AgentEventPayloads['turn.started']): void {
    if (this.nextForkTurnIndex === undefined) return;
    if (!isForkableTurnOrigin(event.origin)) return;
    this.forkTurnIndexByTurn.set(event.turnId, this.nextForkTurnIndex);
    this.nextForkTurnIndex += 1;
  }

  /** Emit a turn's update, carrying its fork position when it has one. */
  private emitForTurn(turnId: number, notification: SessionNotification | null): void {
    if (notification === null) return;
    const forkTurnIndex = this.forkTurnIndexByTurn.get(turnId);
    this.emit(
      forkTurnIndex === undefined ? notification : withLodyTurnId(notification, forkTurnIndex),
    );
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
    // Branch on whether a streaming delta already lazy-created the wire
    // `tool_call` for this id:
    //  - YES → a second CREATE is illegal; emit the "upgrade"
    //    `tool_call_update` so title/kind/rawInput/locations (and any
    //    `display`-derived diff) land on the existing card and `status`
    //    flips to `'in_progress'`.
    //  - NO  → no prior deltas (provider doesn't stream args); emit the
    //    `tool_call` CREATE.
    // Either way the accumulator is (re)seeded with the full stringified
    // args: `tool_call_update` content is REPLACE-semantics, so a post-start
    // delta must emit the cumulative args string, not just its fragment.
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
        planFromDisplayBlock(this.sessionId, event.turnId, event.display as ToolInputDisplay),
      );
    }
  }

  private onToolCallDelta(event: AgentEventPayloads['tool.call.delta']): void {
    // The klient payload mirrors `ToolCallDeltaEvent` field-for-field.
    const mapped = event as unknown as ToolCallDeltaEvent;
    const key = acpToolCallId(event.turnId, event.toolCallId);
    const acc = this.toolCallStreamArgs.get(key);
    if (acc === undefined) {
      // The engine emits args-stream deltas BEFORE `tool.call.started`
      // (deltas come from the provider's streaming phase; started is
      // dispatched when the call runs). Lazy-create the wire `tool_call`
      // from this first delta so subsequent updates have a legitimate parent
      // — clients otherwise surface "Tool call not found" until the start
      // eventually lands.
      this.toolCallStreamArgs.set(key, { args: event.argumentsPart ?? '' });
      this.emitForTurn(event.turnId, toolCallLazyCreateToSessionUpdate(this.sessionId, mapped));
      return;
    }
    // Subsequent delta — the helper accumulates the fragment and emits an
    // update with the cumulative args text (REPLACE-content semantics).
    this.emitForTurn(event.turnId, toolCallDeltaToSessionUpdate(this.sessionId, mapped, acc));
  }

  private onToolProgress(event: AgentEventPayloads['tool.progress']): void {
    // The klient payload mirrors `ToolProgressEvent` field-for-field; the
    // helper forwards only `status` updates with text (as a title refresh)
    // and returns null for everything else, which `emit` drops.
    this.emitForTurn(
      event.turnId,
      toolProgressToSessionUpdate(this.sessionId, event as unknown as ToolProgressEvent),
    );
  }

  private onToolResult(event: AgentEventPayloads['tool.result']): void {
    const key = acpToolCallId(event.turnId, event.toolCallId);
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

  /**
   * Correlate a freshly-created client terminal with the in-flight Bash tool
   * call whose command it runs, then attach a `{type: 'terminal'}` content
   * entry to that call's card. Match key: the runner reports the full shell
   * invocation (`cd <cwd> && <command>`), which ends with the model's
   * `args.command`. Terminals with no matching call (e.g. a subagent's —
   * this session only follows the main agent's events) stay unattached.
   */
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

  /**
   * Report an auto-triggered compaction start. A manual `/compact` is already
   * acknowledged by the builtin command's reply chunk, so echoing its
   * `compaction.started` event too would double-report; an auto-triggered
   * compaction has no other client-visible signal.
   */
  private onCompactionStarted(event: AgentEventPayloads['compaction.started']): void {
    if (event.trigger !== 'auto') return;
    this.emitLocalChunk(
      event.instruction === undefined
        ? 'Compacting conversation context…'
        : `Compacting conversation context with instruction: ${event.instruction}`,
    );
  }

  /** Report the compaction result (token/message summary). */
  private onCompactionCompleted(event: AgentEventPayloads['compaction.completed']): void {
    this.emitLocalChunk(formatCompactionCompleted(event.result));
  }

  /** Push one local `agent_message_chunk` (best-effort, never throws). */
  private emitLocalChunk(text: string): void {
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    });
  }

  private onTurnEnded(event: AgentEventPayloads['turn.ended']): void {
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
      const stopReason = turnEndReasonToStopReason(event.reason, error);
      driver.pendingSettle = () => {
        driver.resolve({ stopReason });
      };
      this.settleHeldPromptIfDrained();
    }
    void Promise.all([
      this.emitUsageUpdate(),
      this.emitDetailedUsageUpdate(),
      this.emitManagedUsage(),
    ]);
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
    const settle = driver.pendingSettle;
    if (settle === undefined) return;
    if (this.runningTurns.size > 0) return;
    if (this.activeSubagentTasks.size > 0) return;
    if (this.wakeTurnGrace !== undefined) return;
    driver.pendingSettle = undefined;
    this.settleDriver(driver, settle);
  }

  /** Hold settlement across the gap between `task.terminated` and its wake turn. */
  private startWakeTurnGrace(): void {
    if (this.driver?.pendingSettle === undefined) return;
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
  async listSubagents(activeOnly = false): Promise<readonly AgentTaskInfo[]> {
    return (await this.agent.getTasks({ activeOnly })).filter((task) => task.kind === 'agent');
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
    let output: string | undefined;
    if (event === 'terminated') {
      try {
        output = await this.agent.getTaskOutput({ taskId: task.taskId, tail: 2_000 });
      } catch {
        // The task registry is still authoritative when output has already rotated away.
      }
    }
    const params = toLodyTaskLifecycle(this.sessionId, event, task, output);
    if (params === null) return;
    await this.emitExtension(LODY_KIMI_METHODS.taskLifecycle, params);
  }

  private async emitDetailedUsageUpdate(): Promise<void> {
    try {
      await this.captureDetailedUsage(true);
      const contextWindow = (await this.klient.global.kosong.listModels()).find(
        (item) => item.model === this.currentModelId,
      )?.max_context_size;
      const update = toLodySessionUsage(
        Object.fromEntries(this.lodyUsageSinceActivation),
        contextWindow,
      );
      if (update !== null) {
        await this.emitExtension(LODY_KIMI_METHODS.usageUpdate, { ...update });
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
      await this.emitExtension(LODY_KIMI_METHODS.rateLimits, toLodyRateLimits(usage));
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

  /**
   * Push a one-shot `usage_update` after a turn settles: `used` = the agent's
   * current context token count, `size` = the bound model's max context size
   * from the catalog. Skipped while no catalog model matches the bound id —
   * there is nothing honest to report. `cost` stays omitted (the engine has
   * no cost data).
   */
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
    if (!event.changed.includes('title')) return;
    void this.emitSessionInfoUpdate();
  }

  /** Push a `session_info_update` with the current title (best-effort). */
  private async emitSessionInfoUpdate(): Promise<void> {
    try {
      const meta = await this.session.get();
      this.emit(sessionInfoUpdateNotification(this.sessionId, meta.title ?? null));
    } catch (error) {
      log.warn('acp: failed to push session_info_update', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Push a `session/update` notification (best-effort, never throws). */
  private emit(notification: SessionNotification | null): void {
    if (notification === null) return;
    void this.conn.sessionUpdate(notification).catch((error) => {
      log.warn('acp: failed to push session/update', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Cancel the in-flight turn, if any, and abort every prompt still in its
   * pre-turn compression phase (those settle as cancelled without launching —
   * see {@link preparePromptContent}). Idempotent.
   */
  cancel(): void {
    for (const pending of this.pendingPromptAborts) {
      pending.aborted = true;
    }
    const driver = this.driver;
    if (driver === undefined || driver.settled) return;
    if (driver.pendingSettle !== undefined) {
      // The prompt is only being held open for background work; its own turn
      // is already over. Cancel whatever the engine opened in the meantime (a
      // wake turn reporting a finished subagent, a cron fire) and stop
      // waiting. Detached subagents keep running on purpose — they outlive
      // the turn by design and have their own cancellation surface.
      if (this.runningTurns.size > 0) {
        void this.agent.cancel().catch((error) => {
          log.warn('acp: cancel (held prompt) failed', {
            sessionId: this.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      this.clearWakeTurnGrace();
      driver.pendingSettle = undefined;
      this.settleDriver(driver, () => {
        driver.resolve({ stopReason: 'cancelled' });
      });
      return;
    }
    const turnId = driver.turnId;
    if (turnId === undefined) {
      // The launch round-trip has not returned the turn id yet. The engine's
      // cancel payload makes turnId optional — an empty call cancels whatever
      // turn is active (the same contract kap-server's cancel route relies
      // on) — and concurrent prompts are rejected, so the active turn can only
      // be this driver's. Flag the driver too: when the id lands, the launch
      // handler re-issues a precisely-addressed cancel, and a no-launch
      // outcome settles `cancelled` instead of `end_turn`.
      driver.cancelRequested = true;
      void this.agent.cancel().catch((error) => {
        log.warn('acp: cancel (unaddressed) failed', {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    void this.agent.cancel({ turnId }).catch((error) => {
      log.warn('acp: cancel failed', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Build the current `configOptions` snapshot (model + thinking + mode).
   * The thinking toggle only appears when the bound model's catalog row is
   * thinking-capable (see `buildSessionConfigOptions`).
   */
  async configOptions(): Promise<SessionConfigOption[]> {
    const models = projectModelCatalog(await this.klient.global.kosong.listModels());
    return buildSessionConfigOptions(
      models,
      this.currentModelId,
      this.currentThinkingLevel,
      this.currentModeId,
    );
  }

  /**
   * The first-class `modes` ({@link SessionModeState}) snapshot for the
   * `session/new` / `session/load` / `session/resume` responses — the same
   * taxonomy the `mode` config-option arm projects.
   */
  modeState(): SessionModeState {
    return { currentModeId: this.currentModeId, availableModes: [...ACP_MODES] };
  }

  /**
   * Switch the active model.
   *
   * Legacy clients may merge the thinking flag into the model id as
   * `"<id>,thinking"` (mirrors the Python ref's `_ModelIDConv.from_acp_model_id`
   * and the legacy adapter): the merged form splits into `setModel(<bare id>)`
   * plus `setThinking(<the NEW model's default effort>)`. The asymmetry is
   * load-bearing — a bare id does NOT turn thinking off (model and thinking
   * stay orthogonal; disabling thinking requires the `thinking` config option
   * with value `'off'`). Both entry points (`session/set_model` and the
   * `model` arm of `session/set_config_option`) funnel here.
   */
  async setModel(id: string): Promise<void> {
    const suffix = ',thinking';
    const hasSuffix = id.endsWith(suffix);
    const baseId = hasSuffix ? id.slice(0, -suffix.length) : id;
    await this.agent.setModel(baseId);
    // Update BEFORE resolving the on-effort so a merged `,thinking` switch
    // picks the NEW model's default level, not the old one's.
    this.currentModelId = baseId;
    if (hasSuffix) {
      const models = projectModelCatalog(await this.klient.global.kosong.listModels());
      const level = models.find((model) => model.id === baseId)?.defaultThinkingEffort ?? 'on';
      await this.agent.setThinking(level);
      this.currentThinkingLevel = level;
    }
    await this.emitConfigOptionUpdate();
  }

  /**
   * Switch the thinking level. The value is validated against the current
   * model's declared capability: with `supportEfforts` the allowed set is
   * `'off'` plus every declared effort (an `always_thinking` model drops
   * `'off'`); without them it stays the boolean `'off'` / `'on'` pair. Legacy
   * boolean clients sending `'on'` to an effort-granular model map to the
   * model's default effort (`AcpModelEntry.defaultThinkingEffort`). Returns
   * `false` for a value the model cannot take — the caller maps that to ACP
   * `invalid_params`.
   */
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

  /** Switch the ACP mode (plan mode + permission mode). */
  async setMode(id: AcpModeId): Promise<void> {
    const { plan, permission } = acpModeToToggles(id);
    if (plan) {
      await this.agent.enterPlan();
    } else {
      // KLIENT-GAP(plan): `exitPlan` (`planService.exit()`) is not on the
      // klient surface; `cancelPlan` (`planModeCancel`) has the identical
      // state effect (see `agent/plan/planOps.ts`) — only the persisted op
      // name differs.
      await this.agent.cancelPlan();
    }
    await this.agent.setPermission(permission);
    this.currentModeId = id;
    // Both notifications fire: `current_mode_update` serves clients reading
    // the first-class `modes` state, `config_option_update` serves clients
    // reading the `mode` config-option arm. (Engine-side mode changes are not
    // observable — klient exposes no permission/plan change event.)
    this.emit(currentModeUpdateNotification(this.sessionId, id));
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

/**
 * Render the client-facing summary of a finished compaction (mirrors the
 * legacy adapter's wording).
 */
function formatCompactionCompleted(result: {
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}): string {
  return [
    'Compaction completed.',
    `- Messages compacted: ${result.compactedCount.toLocaleString('en-US')}`,
    `- Tokens before: ${result.tokensBefore.toLocaleString('en-US')}`,
    `- Tokens after: ${result.tokensAfter.toLocaleString('en-US')}`,
  ].join('\n');
}
