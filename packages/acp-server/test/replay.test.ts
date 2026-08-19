import { describe, expect, it } from 'vitest';

import { projectHistoryToSessionUpdates } from '../src/replay';

import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { ContextMessage } from '@moonshot-ai/agent-core-v2';

const SESSION_ID = 'session_test';

function kinds(updates: readonly SessionNotification[]): string[] {
  return updates.map((u) => u.update.sessionUpdate);
}

describe('projectHistoryToSessionUpdates', () => {
  it('returns an empty array for an empty history', () => {
    expect(projectHistoryToSessionUpdates(SESSION_ID, [])).toEqual([]);
  });

  it('projects a user text message to a user_message_chunk', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    expect(kinds(updates)).toEqual(['user_message_chunk']);
    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hi' },
    });
  });

  it('projects an assistant text + tool call and correlates the tool result', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'read a.ts' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'reading' }],
        toolCalls: [{ type: 'function', id: 'c1', name: 'Read', arguments: '{"path":"a.ts"}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'file body' }],
        toolCalls: [],
        toolCallId: 'c1',
      },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    expect(kinds(updates)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
    ]);
    const create = updates[2]?.update;
    expect(create).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: '1:c1',
      status: 'in_progress',
    });
    const done = updates[3]?.update;
    expect(done).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: '1:c1',
      status: 'completed',
    });
  });

  it('marks an errored tool result as failed', () => {
    const messages: ContextMessage[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'c1', name: 'Bash', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'boom' }],
        toolCalls: [],
        toolCallId: 'c1',
        isError: true,
      },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    expect(updates.at(-1)?.update).toMatchObject({ status: 'failed' });
  });

  it('projects a think part to an agent_thought_chunk', () => {
    const messages: ContextMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'think', think: 'hmm' }],
        toolCalls: [],
      },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    expect(kinds(updates)).toEqual(['agent_thought_chunk']);
  });

  it('skips a tool message whose call was never issued in this slice', () => {
    const messages: ContextMessage[] = [
      {
        role: 'tool',
        content: [{ type: 'text', text: 'orphan' }],
        toolCalls: [],
        toolCallId: 'unknown',
      },
    ];
    expect(projectHistoryToSessionUpdates(SESSION_ID, messages)).toEqual([]);
  });

  it('increments the synthetic turnId per assistant message', () => {
    const messages: ContextMessage[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'a', name: 'Read', arguments: '{}' }],
      },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'b', name: 'Read', arguments: '{}' }],
      },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    const ids = updates
      .filter((u) => u.update.sessionUpdate === 'tool_call')
      .map((u) => (u.update as { toolCallId: string }).toolCallId);
    expect(ids).toEqual(['1:a', '2:b']);
  });
});

describe('fork positions in a replayed history', () => {
  const lodyTurnId = (update: SessionNotification['update']): string | undefined =>
    (update as { _meta?: { lody?: { turnId?: string } } })._meta?.lody?.turnId;

  it('carries the engine position for each replayed turn', () => {
    const messages: ContextMessage[] = [
      { role: 'user', id: 'msg_1', content: [{ type: 'text', text: 'first' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'one' }], toolCalls: [] },
      { role: 'user', id: 'msg_2', content: [{ type: 'text', text: 'second' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }], toolCalls: [] },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages, [
      { turnIndex: 0, messageId: 'msg_1' },
      { turnIndex: 1, messageId: 'msg_2' },
    ]);
    expect(updates.map((entry) => lodyTurnId(entry.update))).toEqual(['0', '0', '1', '1']);
  });

  it('keeps positions aligned when compaction dropped a turn from the middle', () => {
    // The records still hold three turns; the replayed context lost the second.
    const messages: ContextMessage[] = [
      { role: 'user', id: 'msg_1', content: [{ type: 'text', text: 'first' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'one' }], toolCalls: [] },
      { role: 'user', id: 'msg_3', content: [{ type: 'text', text: 'third' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'three' }], toolCalls: [] },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages, [
      { turnIndex: 0, messageId: 'msg_1' },
      { turnIndex: 1, messageId: 'msg_2' },
      { turnIndex: 2, messageId: 'msg_3' },
    ]);
    expect(updates.map((entry) => lodyTurnId(entry.update))).toEqual(['0', '0', '2', '2']);
  });

  it('does not let a repeated prompt resolve to the wrong turn', () => {
    // Same text, different turns: identity decides, never the rendered prose.
    const messages: ContextMessage[] = [
      { role: 'user', id: 'msg_2', content: [{ type: 'text', text: 'continue' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], toolCalls: [] },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages, [
      { turnIndex: 0, messageId: 'msg_1', prompt: 'continue' },
      { turnIndex: 1, messageId: 'msg_2', prompt: 'continue' },
    ]);
    expect(updates.map((entry) => lodyTurnId(entry.update))).toEqual(['1', '1']);
  });

  it('leaves a turn unstamped rather than guessing when it matches nothing', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'no durable id' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], toolCalls: [] },
      { role: 'user', id: 'msg_gone', content: [{ type: 'text', text: 'dropped' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], toolCalls: [] },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages, [
      { turnIndex: 0, messageId: 'msg_other' },
    ]);
    expect(updates.map((entry) => lodyTurnId(entry.update))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
