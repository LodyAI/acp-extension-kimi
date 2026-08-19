import { describe, expect, it } from 'vitest';

import {
  hasTokenUsage,
  readLodyForkTurnIndex,
  tokenUsageDelta,
  toLodyRateLimits,
  toLodySessionUsage,
  toLodyTaskLifecycle,
} from '../src/lody-extension';

describe('Lody ACP extension projections', () => {
  it('subtracts activation baselines and tolerates a reset counter', () => {
    const previous = {
      inputOther: 10,
      output: 5,
      inputCacheRead: 7,
      inputCacheCreation: 2,
    };
    expect(
      tokenUsageDelta(
        { inputOther: 13, output: 2, inputCacheRead: 7, inputCacheCreation: 4 },
        previous,
      ),
    ).toEqual({
      inputOther: 3,
      output: 2,
      inputCacheRead: 0,
      inputCacheCreation: 2,
    });
    expect(hasTokenUsage(tokenUsageDelta(previous, previous))).toBe(false);
  });

  it('projects dynamic quota windows and wallet cents without credentials', () => {
    expect(
      toLodyRateLimits({
        kind: 'ok',
        summary: {
          used: 25,
          limit: 100,
          resetAt: '2026-08-19T00:00:00Z',
          window: { duration: 1, unit: 'week' },
        },
        limits: [
          {
            used: 10,
            limit: 50,
            resetAt: '2026-08-12T05:00:00Z',
            window: { duration: 5, unit: 'hour' },
          },
        ],
        extraUsage: {
          balanceCents: 1200,
          totalCents: 2500,
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimitCents: 5000,
          monthlyUsedCents: 300,
          currency: 'CNY',
        },
      }),
    ).toMatchObject({
      schemaVersion: 2,
      limitId: 'kimi',
      fiveHour: 20,
      sevenDay: 25,
      extraUsage: { balanceCents: 1200, currency: 'CNY' },
      windows: [
        { usedPercent: 25, windowDurationMins: 10080 },
        { usedPercent: 20, windowDurationMins: 300 },
      ],
    });
  });

  it('aggregates main and subagent model usage into Lody token fields', () => {
    expect(
      toLodySessionUsage(
        {
          'kimi-for-coding': {
            inputOther: 100,
            output: 20,
            inputCacheRead: 50,
            inputCacheCreation: 5,
          },
          'kimi-for-coding-highspeed': {
            inputOther: 40,
            output: 10,
            inputCacheRead: 4,
            inputCacheCreation: 1,
          },
        },
        262_144,
      ),
    ).toMatchObject({
      usage: {
        inputTokens: 140,
        outputTokens: 30,
        cacheReadInputTokens: 54,
        cacheCreationInputTokens: 6,
        contextWindow: 262144,
      },
    });
  });

  it('projects only agent tasks into bounded lifecycle messages', () => {
    const task = {
      kind: 'agent' as const,
      taskId: 'agent-1',
      description: 'Inspect the repository',
      status: 'completed' as const,
      startedAt: 1,
      endedAt: 2,
      agentId: 'child-1',
      subagentType: 'explore',
    };
    expect(toLodyTaskLifecycle('session-1', 'terminated', task, 'Done')).toMatchObject({
      sessionId: 'session-1',
      message: {
        subtype: 'task_notification',
        task_id: 'agent-1',
        subagent_type: 'Kimi explore',
        status: 'completed',
        summary: 'Done',
      },
    });
  });
});

describe('fork-at-turn request parsing', () => {
  it('reads the published position back out of a fork request', () => {
    expect(readLodyForkTurnIndex({ lody: { forkAtTurn: { version: 1, turnId: '3' } } })).toBe(3);
    expect(readLodyForkTurnIndex({ lody: { forkAtTurn: { version: 1, turnId: '0' } } })).toBe(0);
  });

  it('ignores anything it did not mint, so the fork keeps the whole session', () => {
    // A guessed position would branch the wrong turn; only an exact, current
    // contract counts.
    expect(readLodyForkTurnIndex(undefined)).toBeUndefined();
    expect(readLodyForkTurnIndex({ lody: {} })).toBeUndefined();
    expect(
      readLodyForkTurnIndex({ lody: { forkAtTurn: { version: 2, turnId: '3' } } }),
    ).toBeUndefined();
    expect(
      readLodyForkTurnIndex({ lody: { forkAtTurn: { version: 1, turnId: 'turn_abc' } } }),
    ).toBeUndefined();
    expect(
      readLodyForkTurnIndex({ lody: { forkAtTurn: { version: 1, turnId: '-1' } } }),
    ).toBeUndefined();
    expect(
      readLodyForkTurnIndex({ lody: { forkAtTurn: { version: 1, turnId: 3 } } }),
    ).toBeUndefined();
  });
});
