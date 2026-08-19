import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { ForkTurnSummary } from '@moonshot-ai/agent-core-v2';
import type { AgentTaskInfo, Klient } from '@moonshot-ai/klient';
import { describe, expect, it } from 'vitest';

import type { AcpClient } from '../src/acp-client';
import type { IAcpConnection } from '../src/acp-fs';
import { AcpSession } from '../src/session';

const SESSION_ID = 'session_background';

type Listener = (event: unknown) => void;

/**
 * Fake the klient surface `AcpSession` drives: the main agent's event stream
 * (the only thing these tests steer) plus the read-only calls `init()` and
 * turn settlement make. Reads answer with empty/neutral data — the session
 * treats every one of them as best-effort.
 */
function makeFakeKlient(forkTurns: readonly ForkTurnSummary[] = []): {
  readonly klient: Klient;
  emit(event: string, payload: unknown): void;
  readonly prompts: number[];
  readonly forks: Array<Record<string, unknown> | undefined>;
  readonly cancels: number;
} {
  const listeners = new Map<string, Listener[]>();
  const on = (event: string, listener: Listener) => {
    const bucket = listeners.get(event) ?? [];
    bucket.push(listener);
    listeners.set(event, bucket);
    return {
      dispose: () => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((entry) => entry !== listener),
        );
      },
    };
  };
  const prompts: number[] = [];
  let cancels = 0;
  let nextTurnId = 1;
  const agent = {
    events: { on, onError: () => ({ dispose: () => {} }) },
    prompt: () => {
      const turnId = nextTurnId++;
      prompts.push(turnId);
      return Promise.resolve({ turn_id: turnId });
    },
    cancel: () => {
      cancels += 1;
      return Promise.resolve();
    },
    getModel: () => Promise.resolve('kimi-for-coding'),
    getThinking: () => Promise.resolve('off'),
    getUsage: () => Promise.resolve({}),
    getTasks: () => Promise.resolve([]),
  };
  const forks: Array<Record<string, unknown> | undefined> = [];
  const session = {
    agent: () => agent,
    agents: () => Promise.resolve({}),
    events: { on, onError: () => ({ dispose: () => {} }) },
    skills: { list: () => Promise.resolve([]) },
    interactions: { list: () => Promise.resolve([]), respond: () => Promise.resolve() },
    forkTurns: () => Promise.resolve(forkTurns),
    fork: (input?: Record<string, unknown>) => {
      forks.push(input);
      return Promise.resolve({ id: 'session_forked' });
    },
  };
  const klient = {
    session: () => session,
    global: {
      auth: { managedUsage: () => Promise.resolve({ kind: 'error' }) },
      kosong: { listModels: () => Promise.resolve([]) },
    },
  };
  return {
    klient: klient as unknown as Klient,
    emit: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    prompts,
    forks,
    get cancels() {
      return cancels;
    },
  };
}

function makeFakeConn(): { readonly conn: AcpClient; readonly updates: SessionNotification[] } {
  const updates: SessionNotification[] = [];
  const conn = {
    sessionUpdate: (params: SessionNotification) => {
      updates.push(params);
      return Promise.resolve();
    },
    extensionNotification: () => Promise.resolve(),
    requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    createElicitation: () => Promise.resolve({}),
  };
  return { conn: conn as unknown as AcpClient, updates };
}

const acpConnection = {
  onTerminalCreated: () => () => {},
} as unknown as IAcpConnection;

function subagentTask(overrides: Partial<AgentTaskInfo> = {}): AgentTaskInfo {
  return {
    kind: 'agent',
    taskId: 'task-1',
    description: 'research the repo',
    status: 'running',
    detached: true,
    startedAt: 0,
    endedAt: null,
    ...overrides,
  } as AgentTaskInfo;
}

/** Let queued microtasks (and the settlement they carry) run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function startSession(forkTurns: readonly ForkTurnSummary[] = []) {
  const fake = makeFakeKlient(forkTurns);
  const { conn, updates } = makeFakeConn();
  const session = new AcpSession(conn, fake.klient, SESSION_ID, acpConnection, false);
  await session.init();
  return { fake, session, updates };
}

const assistantText = (updates: readonly SessionNotification[]): string[] =>
  updates
    .map((entry) => entry.update)
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => {
      const content = (update as { content: { type: string; text?: string } }).content;
      return content.text ?? '';
    });

describe('background subagent work and the client prompt', () => {
  it('keeps the prompt in flight until a detached subagent and its wake turn finish', async () => {
    const { fake, session, updates } = await startSession();

    const pending = session.prompt([{ type: 'text', text: 'spawn a subagent' }]);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();

    fake.emit('turn.started', { turnId: 1 });
    fake.emit('task.started', { info: subagentTask() });
    fake.emit('assistant.delta', { turnId: 1, delta: 'starting a subagent' });
    fake.emit('turn.ended', { turnId: 1, reason: 'completed' });
    await flush();

    // The spawning turn is over but the subagent is not: the conversation is
    // still working, so `session/prompt` must not answer yet.
    expect(settled).toBe(false);

    fake.emit('task.terminated', {
      info: subagentTask({ status: 'completed', endedAt: 1 }),
    });
    await flush();
    // The engine still owes the wake turn that reports the result.
    expect(settled).toBe(false);

    fake.emit('turn.started', { turnId: 2 });
    fake.emit('assistant.delta', { turnId: 2, delta: 'the subagent found it' });
    await flush();
    expect(settled).toBe(false);

    fake.emit('turn.ended', { turnId: 2, reason: 'completed' });
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn' });

    // Both turns reached the client, including the engine-initiated one that
    // no client prompt launched.
    expect(assistantText(updates)).toEqual(['starting a subagent', 'the subagent found it']);
  });

  it('streams an engine-initiated turn that arrives with no prompt in flight', async () => {
    const { fake, session, updates } = await startSession();

    await expect(
      (async () => {
        const pending = session.prompt([{ type: 'text', text: 'hi' }]);
        await flush();
        fake.emit('turn.started', { turnId: 1 });
        fake.emit('turn.ended', { turnId: 1, reason: 'completed' });
        return pending;
      })(),
    ).resolves.toEqual({ stopReason: 'end_turn' });

    // A cron fire (or any other engine-opened turn) once the session is idle.
    fake.emit('turn.started', { turnId: 2 });
    fake.emit('assistant.delta', { turnId: 2, delta: 'cron job ran' });
    fake.emit('turn.ended', { turnId: 2, reason: 'completed' });
    await flush();

    expect(assistantText(updates)).toContain('cron job ran');
  });

  it('settles a held prompt on cancel and cancels the engine turn it was following', async () => {
    const { fake, session } = await startSession();

    const pending = session.prompt([{ type: 'text', text: 'spawn a subagent' }]);
    await flush();
    fake.emit('turn.started', { turnId: 1 });
    fake.emit('task.started', { info: subagentTask() });
    fake.emit('turn.ended', { turnId: 1, reason: 'completed' });
    fake.emit('turn.started', { turnId: 2 });
    await flush();

    session.cancel();

    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' });
    expect(fake.cancels).toBe(1);
  });

  it('names the tool on the wire even when the card title is a description', async () => {
    const { fake, session, updates } = await startSession();

    void session.prompt([{ type: 'text', text: 'schedule something' }]);
    await flush();
    fake.emit('turn.started', { turnId: 1 });
    fake.emit('tool.call.started', {
      turnId: 1,
      toolCallId: 'call-1',
      name: 'CronCreate',
      description: 'Scheduling cron */5 * * * *',
      args: { cron: '*/5 * * * *', prompt: 'check CI', recurring: true },
    });
    await flush();

    const toolCall = updates
      .map((entry) => entry.update)
      .find((update) => update.sessionUpdate === 'tool_call');
    expect(toolCall).toMatchObject({
      title: 'Scheduling cron */5 * * * *',
      rawInput: { cron: '*/5 * * * *' },
      _meta: { toolName: 'CronCreate' },
    });
  });

  it('does not hold the prompt for an attached subagent awaited inside its tool call', async () => {
    const { fake, session } = await startSession();

    const pending = session.prompt([{ type: 'text', text: 'run a subagent inline' }]);
    await flush();
    fake.emit('turn.started', { turnId: 1 });
    fake.emit('task.started', { info: subagentTask({ detached: false }) });
    fake.emit('task.terminated', {
      info: subagentTask({ detached: false, status: 'completed', endedAt: 1 }),
    });
    fake.emit('turn.ended', { turnId: 1, reason: 'completed' });

    await expect(pending).resolves.toEqual({ stopReason: 'end_turn' });
  });
});

describe('fork positions on the wire', () => {
  const lodyTurnId = (update: SessionNotification['update']): string | undefined =>
    (update as { _meta?: { lody?: { turnId?: string } } })._meta?.lody?.turnId;

  it('publishes the engine fork position on a user turn and forks back at it', async () => {
    // Two turns already recorded: the next user turn is fork index 2.
    const { fake, session, updates } = await startSession([
      { turnIndex: 0, prompt: 'first' },
      { turnIndex: 1, prompt: 'second' },
    ]);

    void session.prompt([{ type: 'text', text: 'third' }]);
    await flush();
    fake.emit('turn.started', { turnId: 7, origin: { kind: 'user' } });
    fake.emit('assistant.delta', { turnId: 7, delta: 'answering' });
    await flush();

    const stamped = updates
      .map((entry) => entry.update)
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map(lodyTurnId);
    expect(stamped).toEqual(['2']);
  });

  it('does not spend a fork position on an engine-opened turn', async () => {
    const { fake, session, updates } = await startSession([{ turnIndex: 0, prompt: 'first' }]);

    void session.prompt([{ type: 'text', text: 'second' }]);
    await flush();
    // A cron fire and a subagent wake sit between two user turns; neither is a
    // fork boundary, so neither may consume an index.
    fake.emit('turn.started', { turnId: 1, origin: { kind: 'cron_job' } });
    fake.emit('assistant.delta', { turnId: 1, delta: 'cron' });
    fake.emit('turn.ended', { turnId: 1, reason: 'completed' });
    fake.emit('turn.started', { turnId: 2, origin: { kind: 'task' } });
    fake.emit('assistant.delta', { turnId: 2, delta: 'wake' });
    fake.emit('turn.ended', { turnId: 2, reason: 'completed' });
    fake.emit('turn.started', { turnId: 3, origin: { kind: 'user' } });
    fake.emit('assistant.delta', { turnId: 3, delta: 'user turn' });
    await flush();

    const byText = new Map(
      updates
        .map((entry) => entry.update)
        .filter((update) => update.sessionUpdate === 'agent_message_chunk')
        .map((update) => [
          (update as { content: { text?: string } }).content.text,
          lodyTurnId(update),
        ]),
    );
    expect(byText.get('cron')).toBeUndefined();
    expect(byText.get('wake')).toBeUndefined();
    expect(byText.get('user turn')).toBe('1');
  });
});
