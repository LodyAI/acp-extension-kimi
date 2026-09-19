import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentTaskInfo, ManagedUsageResult, UsageStatus } from '@moonshot-ai/klient';
import type {
  LodyExtensionCapabilities,
  LodySubagentTask,
  LodyTaskMeta,
  ModelUsage,
  RateLimitsSnapshot,
} from 'acp-extension-core';

export const LODY_EXTENSION_CAPABILITIES = {
  usage: { version: 1 },
  rateLimits: { version: 1, query: true },
  forkAtTurn: { version: 1 },
  tasks: { version: 1, background: true },
  subagents: { version: 1, lifecycle: true, list: true, cancel: true, output: true },
  compaction: { version: 1 },
} as const satisfies LodyExtensionCapabilities;

/**
 * Lody's fork-at-turn contract: the agent declares this capability, stamps
 * every turn-scoped `session/update` with `_meta.lody.turnId`, and accepts
 * that same id back in `session/fork`'s `_meta.lody.forkAtTurn`. The engine
 * addresses turns positionally, so the id we mint IS the fork turn index.
 */
/** Read the fork position out of a `session/fork` request's `_meta`. */
export function readLodyForkTurnIndex(meta: unknown): number | undefined {
  const lody = asRecord(asRecord(meta)?.['lody']);
  const forkAtTurn = asRecord(lody?.['forkAtTurn']);
  if (forkAtTurn?.['version'] !== 1) return undefined;
  const turnId = forkAtTurn['turnId'];
  if (typeof turnId !== 'string') return undefined;
  const turnIndex = Number(turnId);
  return Number.isSafeInteger(turnIndex) && turnIndex >= 0 ? turnIndex : undefined;
}

/**
 * Attach `_meta.lody.turnId` without disturbing any other `_meta` entry. Both
 * absences pass through untouched, so callers stamp unconditionally instead of
 * repeating the guards: no notification to send, or a turn with no fork
 * position (see {@link isUserVisibleTurnOrigin}).
 */
export function withLodyTurnId<T extends SessionNotification | null>(
  notification: T,
  turnId: string | undefined,
): T {
  if (notification === null || turnId === undefined) return notification;
  const update = notification.update as typeof notification.update & {
    _meta?: Record<string, unknown> | null;
  };
  const meta = update._meta ?? {};
  const lody = asRecord(meta['lody']) ?? {};
  return {
    ...notification,
    update: { ...update, _meta: { ...meta, lody: { ...lody, turnId } } },
  } as T;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type TokenUsage = NonNullable<UsageStatus['total']>;
export type SubagentTaskInfo = Extract<AgentTaskInfo, { kind: 'agent' }>;

export function addTokenUsage(left: TokenUsage | undefined, right: TokenUsage): TokenUsage {
  if (left === undefined) return { ...right };
  return {
    inputOther: left.inputOther + right.inputOther,
    output: left.output + right.output,
    reasoningOutput:
      left.reasoningOutput === undefined && right.reasoningOutput === undefined
        ? undefined
        : (left.reasoningOutput ?? 0) + (right.reasoningOutput ?? 0),
    inputCacheRead: left.inputCacheRead + right.inputCacheRead,
    inputCacheCreation: left.inputCacheCreation + right.inputCacheCreation,
  };
}

export function tokenUsageDelta(current: TokenUsage, previous: TokenUsage | undefined): TokenUsage {
  return {
    inputOther: counterDelta(current.inputOther, previous?.inputOther),
    output: counterDelta(current.output, previous?.output),
    reasoningOutput:
      current.reasoningOutput === undefined
        ? undefined
        : counterDelta(current.reasoningOutput, previous?.reasoningOutput),
    inputCacheRead: counterDelta(current.inputCacheRead, previous?.inputCacheRead),
    inputCacheCreation: counterDelta(current.inputCacheCreation, previous?.inputCacheCreation),
  };
}

export function hasTokenUsage(usage: TokenUsage): boolean {
  return (
    usage.inputOther > 0 ||
    usage.output > 0 ||
    (usage.reasoningOutput ?? 0) > 0 ||
    usage.inputCacheRead > 0 ||
    usage.inputCacheCreation > 0
  );
}

export function toLodyModelUsage(usage: TokenUsage, contextWindow?: number): ModelUsage {
  return {
    inputTokens: usage.inputOther,
    outputTokens: usage.output - (usage.reasoningOutput ?? 0),
    reasoningOutputTokens: usage.reasoningOutput,
    cacheReadInputTokens: usage.inputCacheRead,
    cacheCreationInputTokens: usage.inputCacheCreation,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

export function toLodySessionUsage(
  sessionId: string,
  byModel: Readonly<Record<string, TokenUsage>>,
  contextWindow?: number,
  previousByModel?: Readonly<Record<string, TokenUsage>>,
) {
  let total: TokenUsage | undefined;
  const modelUsage: Record<string, ModelUsage> = {};
  for (const [model, usage] of Object.entries(byModel)) {
    total = addTokenUsage(total, usage);
    modelUsage[model] = toLodyModelUsage(usage, contextWindow);
  }
  if (total === undefined) return null;
  // Compare activation totals, not just the latest capture: a failed emission
  // must leave its contribution in the next delta. The caller advances the
  // baseline only after emitting. Delta is already included in modelUsage.
  const deltaModels: Record<string, ModelUsage> = {};
  let deltaTotal: TokenUsage | undefined;
  if (previousByModel !== undefined) {
    for (const [model, current] of Object.entries(byModel)) {
      const difference = tokenUsageDelta(current, previousByModel[model]);
      deltaModels[model] = toLodyModelUsage(difference);
      deltaTotal = addTokenUsage(deltaTotal, difference);
    }
  }
  return {
    sessionId,
    usage: toLodyModelUsage(total, contextWindow),
    modelUsage,
    delta:
      deltaTotal === undefined
        ? undefined
        : {
            usage: toLodyModelUsage(deltaTotal),
            modelUsage: deltaModels,
          },
  };
}

export function toLodyRateLimits(
  result: ManagedUsageResult,
  now = Date.now(),
): RateLimitsSnapshot {
  if (result.kind === 'error') {
    return {
      rateLimits: [],
      fetchedAtEpochSeconds: Math.floor(now / 1_000),
    };
  }

  const entries = [
    { quota: result.quota.usages.limit7d, duration: 604800, label: undefined },
    { quota: result.quota.usages.limit5h, duration: 18000, label: undefined },
    { quota: result.quota.usages.monthTotal, duration: null, label: 'Monthly total' },
    { quota: result.quota.usages.monthCode, duration: null, label: 'Monthly code' },
  ];
  const windows = entries.flatMap(({ quota, duration, label }) =>
    quota === undefined ? [] : [{
      label,
      usedPercent: Math.min(100, Math.max(0, quota.usedRatio * 100)),
      windowDurationSeconds: duration,
      resetsAtEpochSeconds: resetEpochSeconds(quota.resetAt),
    }],
  );

  return {
    rateLimits: [
      {
        limitId: 'kimi',
        scope: { providerId: 'kimi' },
        planName: 'Kimi Code',
        windows,
        wallet: result.quota.extraUsage,
      },
    ],
    fetchedAtEpochSeconds: Math.floor(now / 1_000),
  };
}

export function toLodyTaskLifecycle(
  sessionId: string,
  event: 'started' | 'terminated',
  task: SubagentTaskInfo,
  output?: string,
): SessionNotification {
  const terminal = event === 'terminated';
  const status = terminal ? taskStatus(task.status) : 'in_progress';
  const description = bounded(task.description, 2_000);
  const summary = terminal ? bounded(output ?? task.stopReason, 2_000) : undefined;
  const taskMeta: LodyTaskMeta = {
    version: 1,
    taskId: task.taskId,
    kind: 'subagent',
    status,
    ...(description === undefined ? {} : { description }),
    actor: task.subagentType === undefined ? 'Kimi subagent' : `Kimi ${task.subagentType}`,
    ...(task.model === undefined ? {} : { modelId: task.model }),
    startedAtEpochSeconds: Math.floor(task.startedAt / 1_000),
    ...(task.endedAt === null
      ? {}
      : { endedAtEpochSeconds: Math.floor(task.endedAt / 1_000) }),
    ...(summary === undefined ? {} : { summary }),
    ...(terminal && task.status !== 'completed' && task.stopReason
      ? { error: task.stopReason }
      : {}),
  };
  return {
    sessionId,
    update: {
      sessionUpdate: terminal ? 'tool_call_update' : 'tool_call',
      toolCallId: `task:${task.taskId}`,
      title: task.description,
      kind: 'think',
      status,
      _meta: { lody: { task: taskMeta } },
    },
  };
}

export function toLodySubagentTask(task: SubagentTaskInfo): LodySubagentTask {
  return {
    taskId: task.taskId,
    description: task.description,
    status: task.status,
    ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
    ...(task.subagentType === undefined ? {} : { subagentType: task.subagentType }),
    ...(task.model === undefined ? {} : { modelId: task.model }),
    ...(task.thinkingEffort === undefined ? {} : { thinkingEffort: task.thinkingEffort }),
    startedAtEpochSeconds: Math.floor(task.startedAt / 1_000),
    endedAtEpochSeconds: task.endedAt === null ? null : Math.floor(task.endedAt / 1_000),
    ...(task.stopReason === undefined ? {} : { stopReason: task.stopReason }),
  };
}

function taskStatus(status: AgentTaskInfo['status']): LodyTaskMeta['status'] {
  return status === 'completed' ? 'completed' : 'failed';
}

function counterDelta(current: number, previous: number | undefined): number {
  if (previous === undefined) return current;
  return current >= previous ? current - previous : current;
}

function bounded(value: string | undefined, max: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function resetEpochSeconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? Math.floor(epochMs / 1_000) : null;
}
