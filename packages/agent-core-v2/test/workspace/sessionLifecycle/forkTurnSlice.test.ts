import { describe, expect, it } from 'vitest';

import { listForkTurns } from '#/workspace/sessionLifecycle/internal/forkTurnSlice';
import type { WireRecord } from '#/wire/record';

function userTurn(text: string, origin?: Record<string, unknown>): WireRecord {
  return {
    type: 'context.append_message',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      ...(origin === undefined ? {} : { origin }),
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
  it('numbers the turns fork() addresses, in record order', () => {
    const turns = listForkTurns([
      { type: 'metadata', protocol_version: '1', created_at: 0 },
      userTurn('first'),
      assistantMessage('one'),
      userTurn('second'),
      assistantMessage('two'),
    ]);

    expect(turns).toEqual([
      { turnIndex: 0, prompt: 'first', time: undefined },
      { turnIndex: 1, prompt: 'second', time: undefined },
    ]);
  });

  it('skips the origins fork() does not count as turns', () => {
    const turns = listForkTurns([
      userTurn('asked'),
      userTurn('cron body', { kind: 'cron_job', jobId: 'job_1' }),
      userTurn('task report', { kind: 'task', taskId: 'task_1' }),
      userTurn('summary', { kind: 'compaction_summary' }),
      userTurn('/skill run', { kind: 'skill_activation', skillName: 'run', trigger: 'model' }),
      userTurn('asked again'),
    ]);

    expect(turns.map((turn) => turn.prompt)).toEqual(['asked', 'asked again']);
    expect(turns.map((turn) => turn.turnIndex)).toEqual([0, 1]);
  });

  it('counts a user-triggered slash activation, which fork() also retains', () => {
    const turns = listForkTurns([
      userTurn('asked'),
      userTurn('', { kind: 'skill_activation', skillName: 'review', trigger: 'user-slash' }),
    ]);

    expect(turns.map((turn) => turn.turnIndex)).toEqual([0, 1]);
    expect(turns[1]?.prompt).toBe('/review');
  });
});
