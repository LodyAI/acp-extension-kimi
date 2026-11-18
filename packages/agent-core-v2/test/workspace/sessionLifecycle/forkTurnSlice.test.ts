import { describe, expect, it } from 'vitest';

import {
  listForkTurns,
  sliceMainRecordsAtTurn,
  sliceMainRecordsForRunningFork,
  sliceRecordsBeforePendingWork,
} from '#/workspace/sessionLifecycle/internal/forkTurnSlice';
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

function userTurnRecord(text: string, time: number): WireRecord {
  return {
    type: 'context.append_message',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      origin: { kind: 'user' },
    },
    time,
  };
}

describe('listForkTurns', () => {
  it('uses persistent IDs across background turns and does not give steers their own boundary', () => {
    const records: WireRecord[] = [
      { type: 'turn.prompt', turnId: 4, promptId: 'first', origin: { kind: 'user' }, input: [{ type: 'text', text: 'first' }] },
      userTurn('first', { id: 'first' }),
      { type: 'turn.ended', turnId: 4, reason: 'completed' },
      { type: 'turn.prompt', turnId: 5, origin: { kind: 'task' }, input: [{ type: 'text', text: 'wake' }] },
      { type: 'turn.ended', turnId: 5, reason: 'completed' },
      { type: 'turn.prompt', turnId: 6, promptId: 'second', origin: { kind: 'user' }, input: [{ type: 'text', text: 'second' }] },
      userTurn('second', { id: 'second' }),
      { type: 'turn.steer', turnId: 6, messageId: 'steer', origin: { kind: 'user' }, input: [{ type: 'text', text: 'steer' }] },
      userTurn('steer', { id: 'steer' }),
      { type: 'turn.ended', turnId: 6, reason: 'completed' },
    ];
    expect(listForkTurns(records)).toEqual([
      { turnIndex: 4, messageId: 'first', prompt: 'first' },
      { turnIndex: 6, messageId: 'second', prompt: 'second' },
    ]);
    const first = sliceMainRecordsAtTurn(records, 'example-session', 4);
    expect(first.records).toContainEqual(records[1]);
    expect(first.records).not.toContainEqual(records[6]);
    const second = sliceMainRecordsAtTurn(records, 'example-session', 6);
    expect(second.records).toContainEqual(records[8]);
  });

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

describe('sliceMainRecordsAtTurn', () => {
  it('derives a fork last prompt from readable client metadata while retaining the original message', () => {
    const record: WireRecord = { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<browser_ref>serialized</browser_ref>' }], origin: { kind: 'user', clientMetadata: [{ display_text: 'Save button · Rename it' }] } }, time: 2 };
    const slice = sliceMainRecordsAtTurn([{ type: 'metadata', protocol_version: '1.5', created_at: 1 }, record, { type: 'turn.ended', turnId: 0, reason: 'blocked', time: 3 }, userTurnRecord('next', 4)], 'example-source', 0);
    expect(slice.lastPrompt).toBe('Save button · Rename it');
    expect(slice.lastTurnReason).toBe('failed');
    expect(slice.records).toContainEqual(record);
  });

  it('keeps completed records before queued input and an active turn in a truncated fork slice', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      {
        type: 'cron.add',
        task: { id: 'aa11bb22', cron: '0 9 * * *', prompt: 'legacy', createdAt: 2 },
        time: 2,
      },
      { type: 'turn.prompt', turnId: 2, input: [{ type: 'text', text: 'hello' }], origin: { kind: 'user' }, time: 2.5 },
      userTurnRecord('hello', 3),
      { type: 'cron.cursor', id: 'aa11bb22', lastFiredAt: 4, time: 4 },
      { type: 'turn.cancel', turnId: 3, target: 'queued', time: 4.5 },
      { type: 'turn.prompt', turnId: 4, input: [{ type: 'text', text: 'retracted turn' }], origin: { kind: 'user' }, time: 4.55 },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'orphan prompt' }], origin: { kind: 'user' }, time: 4.56 },
      { type: 'turn.steer', input: [{ type: 'text', text: 'orphan steer' }], origin: { kind: 'user' }, time: 4.57 },
      { type: 'turn.prompt', turnId: 5, input: [{ type: 'text', text: 'second turn' }], origin: { kind: 'user' }, time: 4.6 },
      userTurnRecord('second turn', 5),
      { type: 'cron.add', task: { id: 'bb22cc33', cron: '0 10 * * *', prompt: 'late', createdAt: 6 }, time: 6 },
    ];

    const slice = sliceMainRecordsAtTurn(records, 'ses_source', 2);

    const types = slice.records.map((record) => record.type);
    expect(types).toContain('cron.add');
    expect(types).toContain('cron.cursor');
    expect(slice.records.filter((record) => record.type === 'cron.add')).toHaveLength(1);
    expect(types).toContain('metadata');
    expect(types).toContain('context.append_message');
    expect(slice.records.filter((record) => record.type === 'turn.prompt' || record.type === 'turn.steer')).toHaveLength(1);
    expect(() => sliceMainRecordsAtTurn(records, 'ses_source', 4)).toThrowError(/not found/);
    expect(sliceMainRecordsAtTurn(records, 'ses_source', 5).lastPrompt).toBe('second turn');

    const mixed: WireRecord[] = [
      userTurnRecord('legacy first', 1),
      { type: 'turn.prompt', turnId: 7, input: [{ type: 'text', text: 'persistent' }], origin: { kind: 'user' }, time: 2 },
      userTurnRecord('persistent', 3),
      { type: 'turn.ended', turnId: 7, reason: 'completed', time: 3.5 },
      userTurnRecord('legacy tail', 4),
    ];
    expect(sliceMainRecordsAtTurn(mixed, 'ses_source', 0).records).toEqual([mixed[0]]);
    expect(sliceMainRecordsAtTurn(mixed, 'ses_source', 7).records).toEqual(mixed.slice(0, 4));

    const queued = { type: 'agent.input.submitted', entry: { meta: { promptId: 'queued' } } };
    expect(sliceRecordsBeforePendingWork([...records, queued], undefined, ['queued'])).toEqual(records);
    expect(sliceRecordsBeforePendingWork([...records, { type: 'turn.prompt', turnId: 9 }], 9, [])).toEqual(records);

    const running = sliceMainRecordsForRunningFork([
      ...records,
      { type: 'turn.prompt', turnId: 9, input: [{ type: 'text', text: 'active turn' }], origin: { kind: 'user' }, time: 7 },
      userTurnRecord('active turn', 8),
      { type: 'context.append_loop_event', event: { type: 'llm.request' }, time: 9 },
    ], 'ses_source', 9, []);
    expect(running.lastPrompt).toBe('active turn');
    expect(running.lastTurnReason).toBe('cancelled');
    expect(running.cutoffTime).toBe(6);
    expect(running.records.slice(-3)).toMatchObject([
      { type: 'turn.prompt', turnId: 9 },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'active turn' }] } },
      { type: 'turn.ended', turnId: 9, reason: 'cancelled' },
    ]);
    expect(running.records.some((record) => record.type === 'context.append_loop_event')).toBe(false);
  });
});
