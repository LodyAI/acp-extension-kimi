import type { Klient } from '@moonshot-ai/klient';
import { describe, expect, it } from 'vitest';

import {
  hasTokenUsage,
  supportsSessionTitles,
  readLodyForkTurnIndex,
  tokenUsageDelta,
  toLodyRateLimits,
  toLodySessionUsage,
  toLodyTaskLifecycle,
} from '../src/lody-extension';

describe('Lody ACP extension projections', () => {
  it('returns already-included deltas from the last emitted activation snapshot', () => {
    const row = (inputOther: number) => ({
      inputOther,
      output: 10,
      inputCacheRead: 20,
      inputCacheCreation: 5,
    });
    const previous = { main: row(100) };
    const current = { main: row(150), child: row(30) };
    const update = toLodySessionUsage('s', current, 10000, previous);
    expect(update?.usage.inputTokens).toBe(180);
    expect(update?.delta?.usage.inputTokens).toBe(80);
    expect(update?.delta?.usage.costUSD).toBeUndefined();
    expect(update?.delta?.modelUsage['child']?.inputTokens).toBe(30);
    expect(toLodySessionUsage('s', current, 10000, current)?.delta?.usage.inputTokens).toBe(0);
    // If emission failed, the unchanged baseline includes both pending captures.
    expect(
      toLodySessionUsage('s', { main: row(180), child: row(30) }, 10000, previous)?.delta?.usage
        .inputTokens,
    ).toBe(110);
  });
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
        quota: {
          usages: {
            limit7d: { usedRatio: 0.25, resetAt: '2026-08-19T00:00:00Z' },
            limit5h: { usedRatio: 0.2, resetAt: '2026-08-12T05:00:00Z' },
          },
          extraUsage: {
            balanceCents: 1200,
            totalCents: 2500,
            monthlyChargeLimitEnabled: true,
            monthlyChargeLimitCents: 5000,
            monthlyUsedCents: 300,
            currency: 'CNY',
          },
        },
      }),
    ).toMatchObject({
      rateLimits: [
        {
          limitId: 'kimi',
          scope: { providerId: 'kimi' },
          wallet: { balanceCents: 1200, currency: 'CNY' },
          windows: [
            { usedPercent: 25, windowDurationSeconds: 604800 },
            { usedPercent: 20, windowDurationSeconds: 18000 },
          ],
        },
      ],
    });
  });

  it('preserves monthly quota labels without inventing a fixed month duration', () => {
    const result = toLodyRateLimits({
      kind: 'ok',
      quota: {
        usages: { monthTotal: { usedRatio: 0.4 }, monthCode: { usedRatio: 0.3 } },
        extraUsage: null,
      },
    });
    expect(result.rateLimits[0]?.windows).toEqual([
      {
        label: 'Monthly total',
        usedPercent: 40,
        windowDurationSeconds: null,
        resetsAtEpochSeconds: null,
      },
      {
        label: 'Monthly code',
        usedPercent: 30,
        windowDurationSeconds: null,
        resetsAtEpochSeconds: null,
      },
    ]);
  });

  it('omits quota windows that the provider did not return', () => {
    const result = toLodyRateLimits({ kind: 'ok', quota: { usages: {}, extraUsage: null } });
    expect(result.rateLimits[0]?.windows).toEqual([]);
  });

  it('aggregates main and subagent model usage into Lody token fields', () => {
    expect(
      toLodySessionUsage(
        'session-1',
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
      sessionId: 'session-1',
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
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'task:agent-1',
        status: 'completed',
        _meta: {
          lody: {
            task: {
              version: 1,
              taskId: 'agent-1',
              kind: 'subagent',
              actor: 'Kimi explore',
              summary: 'Done',
            },
          },
        },
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

describe('native title availability', () => {
  it.each([
    [{}, false],
    [{ 'managed:kimi-code': { type: 'kimi', apiKey: 'example' } }, false],
    [{ 'managed:kimi-code': { type: 'openai', oauth: 'managed' } }, false],
    [{ 'managed:kimi-code': { type: 'kimi', oauth: 'managed' } }, true],
  ])('advertises only a configured native OAuth title service', async (providers, expected) => {
    const klient = { global: { config: { get: async () => providers } } } as unknown as Klient;
    expect(await supportsSessionTitles(klient)).toBe(expected);
  });
});
