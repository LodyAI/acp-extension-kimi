import type { AgentTaskInfo, ManagedUsageResult, UsageStatus } from '@moonshot-ai/klient';

export const LODY_KIMI_EXTENSION = {
  protocolVersion: 1,
  features: {
    managedUsage: true,
    tokenUsage: true,
    subagentLifecycle: true,
    subagentManagement: true,
  },
} as const;

export const LODY_KIMI_METHODS = {
  usageUpdate: '_acp_ext:session_usage_update',
  rateLimits: '_acp_ext:session_rate_limits',
  taskLifecycle: '_kimi/taskLifecycle',
  subagentsList: '_kimi/subagents/list',
  subagentsCancel: '_kimi/subagents/cancel',
  subagentsOutput: '_kimi/subagents/output',
} as const;

export type TokenUsage = NonNullable<UsageStatus['total']>;

export interface LodySessionUsageUpdate {
  readonly usage: LodyModelUsage;
  readonly modelUsage?: Readonly<Record<string, LodyModelUsage>>;
}

interface LodyModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly contextWindow?: number;
}

export function addTokenUsage(left: TokenUsage | undefined, right: TokenUsage): TokenUsage {
  if (left === undefined) return { ...right };
  return {
    inputOther: left.inputOther + right.inputOther,
    output: left.output + right.output,
    inputCacheRead: left.inputCacheRead + right.inputCacheRead,
    inputCacheCreation: left.inputCacheCreation + right.inputCacheCreation,
  };
}

export function tokenUsageDelta(current: TokenUsage, previous: TokenUsage | undefined): TokenUsage {
  return {
    inputOther: counterDelta(current.inputOther, previous?.inputOther),
    output: counterDelta(current.output, previous?.output),
    inputCacheRead: counterDelta(current.inputCacheRead, previous?.inputCacheRead),
    inputCacheCreation: counterDelta(current.inputCacheCreation, previous?.inputCacheCreation),
  };
}

export function hasTokenUsage(usage: TokenUsage): boolean {
  return (
    usage.inputOther > 0 ||
    usage.output > 0 ||
    usage.inputCacheRead > 0 ||
    usage.inputCacheCreation > 0
  );
}

export function toLodyModelUsage(usage: TokenUsage, contextWindow?: number): LodyModelUsage {
  return {
    inputTokens: usage.inputOther,
    outputTokens: usage.output,
    cacheReadInputTokens: usage.inputCacheRead,
    cacheCreationInputTokens: usage.inputCacheCreation,
    contextWindow,
  };
}

export function toLodySessionUsage(
  byModel: Readonly<Record<string, TokenUsage>>,
  contextWindow?: number,
): LodySessionUsageUpdate | null {
  let total: TokenUsage | undefined;
  const modelUsage: Record<string, LodyModelUsage> = {};
  for (const [model, usage] of Object.entries(byModel)) {
    total = addTokenUsage(total, usage);
    modelUsage[model] = toLodyModelUsage(usage, contextWindow);
  }
  if (total === undefined) return null;
  return {
    usage: toLodyModelUsage(total, contextWindow),
    modelUsage,
  };
}

export function toLodyRateLimits(result: ManagedUsageResult): Record<string, unknown> {
  if (result.kind === 'error') {
    return {
      schemaVersion: 2,
      planName: 'Kimi Code',
      limitId: 'kimi',
      fiveHour: null,
      sevenDay: null,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      apiUnavailable: true,
    };
  }

  const rows = [...(result.summary === null ? [] : [result.summary]), ...result.limits];
  const windows = rows.map((row) => ({
    usedPercent: row.limit <= 0 ? 0 : Math.min(100, Math.max(0, (row.used / row.limit) * 100)),
    windowDurationMins: durationMinutes(row.window),
    resetsAt: resetEpochSeconds(row.resetAt),
  }));
  const fiveHour = windows.find((window) => window.windowDurationMins === 300);
  const weekly = windows.find((window) => window.windowDurationMins === 7 * 24 * 60);

  return {
    schemaVersion: 2,
    planName: 'Kimi Code',
    limitId: 'kimi',
    windows,
    fiveHour: fiveHour?.usedPercent ?? null,
    sevenDay: weekly?.usedPercent ?? null,
    fiveHourResetAt: fiveHour?.resetsAt ?? null,
    sevenDayResetAt: weekly?.resetsAt ?? null,
    extraUsage: result.extraUsage,
  };
}

export function toLodyTaskLifecycle(
  sessionId: string,
  event: 'started' | 'terminated',
  task: AgentTaskInfo,
  output?: string,
): Record<string, unknown> | null {
  if (task.kind !== 'agent') return null;
  const terminal = event === 'terminated';
  return {
    sessionId,
    acpSessionId: sessionId,
    message: {
      type: 'system',
      subtype: terminal ? 'task_notification' : 'task_started',
      task_id: task.taskId,
      description: task.description,
      subagent_type:
        task.subagentType === undefined ? 'Kimi subagent' : `Kimi ${task.subagentType}`,
      task_type: 'subagent',
      status: terminal ? taskStatus(task.status) : undefined,
      summary: terminal ? bounded(output ?? task.stopReason, 2_000) : undefined,
      error: terminal && task.status !== 'completed' ? task.stopReason : undefined,
    },
  };
}

function taskStatus(status: AgentTaskInfo['status']): string {
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

function durationMinutes(
  window:
    | { readonly duration: number; readonly unit: 'minute' | 'hour' | 'day' | 'week' }
    | undefined,
): number | null {
  if (window === undefined) return null;
  switch (window.unit) {
    case 'minute':
      return window.duration;
    case 'hour':
      return window.duration * 60;
    case 'day':
      return window.duration * 24 * 60;
    case 'week':
      return window.duration * 7 * 24 * 60;
  }
}

function resetEpochSeconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? Math.floor(epochMs / 1_000) : null;
}
