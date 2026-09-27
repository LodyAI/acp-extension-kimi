import type { SessionNotification, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type {
  ToolCallStartedEvent,
  ToolCallDeltaEvent,
  ToolProgressEvent,
} from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import type { ToolResultEvent } from '@moonshot-ai/agent-core-v2/events';
import type { AgentTaskInfo, IDisposable, SessionHandle } from '@moonshot-ai/klient';
import { LodySubagentEmitter, LODY_SUBAGENT_EVENT_METHOD } from 'acp-extension-core';

import type { AcpClient } from './acp-client';
import {
  acpToolCallId,
  toolCallStartToSessionUpdate,
  toolCallStartedUpgradeToSessionUpdate,
  toolCallLazyCreateToSessionUpdate,
  toolCallDeltaToSessionUpdate,
  toolProgressToSessionUpdate,
  toolResultToSessionUpdate,
} from './events-map';

export class KimiSubagentEvents {
  private readonly runs: LodySubagentEmitter;
  private readonly subscriptions = new Map<string, IDisposable[]>();
  private tail = Promise.resolve();
  private readonly agents = new Map<string, string>();
  private readonly mirrors = new Map<string, Set<string>>();

  constructor(
    private readonly session: SessionHandle,
    private readonly sessionId: string,
    private readonly conn: AcpClient,
    private readonly onError: (error: unknown) => void,
  ) {
    this.runs = new LodySubagentEmitter(sessionId, (event) =>
      conn.extensionNotification(LODY_SUBAGENT_EVENT_METHOD, { ...event }),
    );
  }

  private enqueue(send: () => Promise<void>): void {
    this.tail = this.tail.then(send).catch(this.onError);
  }

  drain(): Promise<void> {
    return this.tail;
  }

  async permission(agentId: string, tool: ToolCallUpdate) {
    await this.tail;
    const nativeId = this.agents.get(agentId);
    if (nativeId === undefined || !this.runs.live(nativeId)) return undefined;
    const run = this.runs.get(nativeId)!;
    const mirrors = this.mirrors.get(nativeId) ?? new Set<string>();
    mirrors.add(tool.toolCallId);
    this.mirrors.set(nativeId, mirrors);
    const meta = { subagentRunId: run.runId, subagentToolCallId: tool.toolCallId };
    const toolCallId = `subagent:${encodeURIComponent(run.runId)}:${encodeURIComponent(tool.toolCallId)}`;
    await this.conn.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        title: tool.title ?? 'Subagent tool',
        toolCallId,
        content: tool.content ?? [],
        locations: tool.locations ?? [],
        kind: tool.kind ?? 'other',
        status: tool.status ?? 'pending',
        rawInput: tool.rawInput,
        _meta: { ...tool._meta, lody: meta },
      },
    });
    return { toolCallId, meta };
  }

  task(event: 'started' | 'terminated', task: AgentTaskInfo, parentId?: string): void {
    if (task.kind !== 'agent') return;
    if (event === 'terminated') {
      for (const subscription of this.subscriptions.get(task.taskId) ?? []) subscription.dispose();
      this.subscriptions.delete(task.taskId);
      this.enqueue(() =>
        this.runs.snapshot(task.taskId, {
          state:
            task.status === 'completed'
              ? 'completed'
              : task.status === 'killed'
                ? 'cancelled'
                : 'failed',
          endedAtEpochSeconds: task.endedAt === null ? undefined : task.endedAt / 1000,
          summary: task.stopReason,
        }),
      );
      return;
    }
    if (this.subscriptions.has(task.taskId)) return;
    this.enqueue(() =>
      this.runs.start(task.taskId, {
        state: 'running',
        name: task.subagentType,
        description: task.description,
        parentRunId: parentId === undefined ? null : this.runs.get(parentId)?.runId,
        parentToolCallId: task.parentToolCallId,
        modelId: task.model,
        startedAtEpochSeconds: task.startedAt / 1000,
        // Task registration can follow child activation; this subscription has no replay guarantee.
        outputIncomplete: true,
        support: {
          stream: task.agentId === undefined ? [] : ['text', 'thought', 'tool'],
          progress: false,
          outputRead: 'none',
          cancel: false,
        },
      }),
    );
    if (task.agentId === undefined) return;
    this.agents.set(task.agentId, task.taskId);
    const events = this.session.agent(task.agentId).events;
    const args = new Map<string, { args: string }>();
    const output = (turnId: number, notification: SessionNotification | null): void => {
      if (notification !== null)
        this.enqueue(async () => {
          await this.runs.output(task.taskId, notification.update, {
            nativeTurnId: String(turnId),
          });
          const update = notification.update;
          const run = this.runs.get(task.taskId);
          if (
            run &&
            (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
            this.mirrors.get(task.taskId)?.has(update.toolCallId)
          ) {
            await this.conn.sessionUpdate({
              sessionId: this.sessionId,
              update: {
                ...update,
                toolCallId: `subagent:${encodeURIComponent(run.runId)}:${encodeURIComponent(update.toolCallId)}`,
                _meta: {
                  ...update._meta,
                  lody: { subagentRunId: run.runId, subagentToolCallId: update.toolCallId },
                },
              },
            });
          }
        });
    };
    this.subscriptions.set(task.taskId, [
      events.on('assistant.delta', (event) =>
        output(event.turnId, {
          sessionId: this.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: event.delta },
          },
        }),
      ),
      events.on('thinking.delta', (event) =>
        output(event.turnId, {
          sessionId: this.sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: event.delta },
          },
        }),
      ),
      events.on('tool.call.delta', (event) => {
        const id = acpToolCallId(event.turnId, event.toolCallId);
        const previous = args.get(id);
        if (previous === undefined) args.set(id, { args: event.argumentsPart ?? '' });
        output(
          event.turnId,
          previous === undefined
            ? toolCallLazyCreateToSessionUpdate(this.sessionId, event as ToolCallDeltaEvent)
            : toolCallDeltaToSessionUpdate(this.sessionId, event as ToolCallDeltaEvent, previous),
        );
      }),
      events.on('tool.call.started', (event) => {
        const id = acpToolCallId(event.turnId, event.toolCallId);
        output(
          event.turnId,
          args.has(id)
            ? toolCallStartedUpgradeToSessionUpdate(this.sessionId, event as ToolCallStartedEvent)
            : toolCallStartToSessionUpdate(this.sessionId, event as ToolCallStartedEvent),
        );
        args.set(id, { args: JSON.stringify(event.args) ?? '' });
      }),
      events.on('tool.progress', (event) =>
        output(
          event.turnId,
          toolProgressToSessionUpdate(this.sessionId, event as ToolProgressEvent),
        ),
      ),
      events.on('tool.result', (event) => {
        args.delete(acpToolCallId(event.turnId, event.toolCallId));
        output(event.turnId, toolResultToSessionUpdate(this.sessionId, event as ToolResultEvent));
      }),
      events.on('task.started', (event) => this.task('started', event.info, task.taskId)),
      events.on('task.terminated', (event) => this.task('terminated', event.info, task.taskId)),
    ]);
  }

  dispose(): void {
    for (const subscriptions of this.subscriptions.values())
      for (const subscription of subscriptions) subscription.dispose();
    this.subscriptions.clear();
    this.enqueue(() => this.runs.disconnect());
  }
}
