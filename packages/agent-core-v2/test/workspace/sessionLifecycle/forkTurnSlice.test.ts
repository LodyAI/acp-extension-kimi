import { describe, expect, it } from 'vitest';

import { listForkTurns } from '#/workspace/sessionLifecycle/internal/forkTurnSlice';
import type { WireRecord } from '#/wire/record';

function userTurn(
  text: string,
  options: { origin?: Record<string, unknown>; id?: string } = {},
): WireRecord {
  return {
    type: 'context.append_message',
    message: {
      role: 'user',
      id: options.id,
      content: [{ type: 'text', text }],
      origin: options.origin,
    },
  };
}

function assistantMessage(text: string): WireRecord {
  return {
    type: 'context.append_message',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

describe('listForkTurns', () => {
  it('numbers the turns fork() addresses and carries each prompt id', () => {
    const turns = listForkTurns([
      { type: 'metadata', protocol_version: '1', created_at: 0 },
      userTurn('first', { id: 'msg_1' }),
      assistantMessage('one'),
      userTurn('second', { id: 'msg_2' }),
      assistantMessage('two'),
    ]);

    expect(turns).toEqual([
      { turnIndex: 0, messageId: 'msg_1', prompt: 'first' },
      { turnIndex: 1, messageId: 'msg_2', prompt: 'second' },
    ]);
  });

  it('skips the origins fork() does not count as turns', () => {
    const turns = listForkTurns([
      userTurn('asked'),
      userTurn('cron body', { origin: { kind: 'cron_job', jobId: 'job_1' } }),
      userTurn('task report', { origin: { kind: 'task', taskId: 'task_1' } }),
      userTurn('summary', { origin: { kind: 'compaction_summary' } }),
      userTurn('/skill run', {
        origin: { kind: 'skill_activation', skillName: 'run', trigger: 'model' },
      }),
      userTurn('asked again'),
    ]);

    expect(turns.map((turn) => turn.prompt)).toEqual(['asked', 'asked again']);
    expect(turns.map((turn) => turn.turnIndex)).toEqual([0, 1]);
  });

  it('counts a user-triggered slash activation, which fork() also retains', () => {
    const turns = listForkTurns([
      userTurn('asked'),
      userTurn('', {
        origin: { kind: 'skill_activation', skillName: 'review', trigger: 'user-slash' },
      }),
    ]);

    expect(turns.map((turn) => turn.turnIndex)).toEqual([0, 1]);
    expect(turns[1]?.prompt).toBe('/review');
  });
});
