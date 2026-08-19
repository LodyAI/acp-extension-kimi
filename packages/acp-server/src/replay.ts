/**
 * `session/load` history replay — projects the main agent's persisted context
 * history (`IAgentContextMemoryService.get()`) into an ordered batch of ACP
 * `session/update` notifications so a loaded session re-renders its prior
 * turns on the client.
 *
 * Pure projection: {@link projectHistoryToSessionUpdates} maps a
 * `ContextMessage[]` to a `SessionNotification[]` with no IO, so the mapping
 * is unit-testable without a live connection. The caller (`AcpSession`)
 * awaits each push in order — replay is a one-shot batch whose completion
 * ordering is what tells `loadSession` the response is safe to return.
 *
 * Turn / tool-call correlation: agent-core-v2 persists tool calls on the
 * assistant message that issued them and tool results as separate `tool`-role
 * messages. ACP needs a single `toolCallId` to correlate the create with its
 * terminal update. Since the persisted history carries no real turn ids, the
 * replay mints a synthetic monotonically-increasing `turnId` per assistant
 * message and records `toolCallId → turnId` so the trailing `tool` messages
 * can look up the id that issued them.
 */

import type { SessionNotification } from '@agentclientprotocol/sdk';
import type {
  ContentPart,
  ContextMessage,
  ForkTurnSummary,
  ToolCall,
} from '@moonshot-ai/agent-core-v2';

import {
  assistantDeltaToSessionUpdate,
  thinkingDeltaToSessionUpdate,
  toolCallStartToSessionUpdate,
} from './events-map';
import { withLodyTurnId } from './lody-extension';

/**
 * Project a persisted context history into an ordered batch of ACP
 * `session/update` notifications. Pure — no IO, never throws on a single
 * malformed message (it is skipped).
 */
export function projectHistoryToSessionUpdates(
  sessionId: string,
  messages: readonly ContextMessage[],
  forkTurns: readonly ForkTurnSummary[] = [],
): SessionNotification[] {
  const out: SessionNotification[] = [];
  let turnId = 0;
  const toolCallTurnIds = new Map<string, number>();
  const forkPositions = forkTurnIdByMessageId(forkTurns);
  let forkTurnId: string | undefined;

  const push = (notification: SessionNotification | null): void => {
    const stamped = withLodyTurnId(notification, forkTurnId);
    if (stamped !== null) out.push(stamped);
  };

  for (const message of messages) {
    switch (message.role) {
      case 'user':
        forkTurnId = message.id === undefined ? undefined : forkPositions.get(message.id);
        for (const part of message.content) {
          if (part.type === 'text' && part.text) {
            push(userMessageChunk(sessionId, part.text));
          }
        }
        break;
      case 'assistant': {
        turnId += 1;
        for (const part of message.content) {
          push(assistantContentPartToUpdate(part, sessionId, turnId));
        }
        for (const toolCall of message.toolCalls ?? []) {
          toolCallTurnIds.set(toolCall.id, turnId);
          push(syntheticToolCall(sessionId, turnId, toolCall));
        }
        break;
      }
      case 'tool': {
        push(toolMessageToUpdate(message, sessionId, toolCallTurnIds));
        break;
      }
      default:
        // system / unknown roles — ACP has no analogue; skip.
        break;
    }
  }
  return out;
}

/**
 * Index the engine's fork turn list by the durable id of the prompt that
 * opened each turn, which is how a replayed message resolves to the position
 * `fork({ turnIndex })` takes. The two sequences share an order but not a
 * length — compaction drops messages from context while the records defining
 * fork positions stay — and matching on identity rather than on rendered
 * prompt text keeps a repeated or truncated prompt from resolving to the wrong
 * turn. A message with no matching id carries no position and is simply not
 * forkable, which is the safe direction.
 */
function forkTurnIdByMessageId(turns: readonly ForkTurnSummary[]): ReadonlyMap<string, string> {
  const byId = new Map<string, string>();
  for (const turn of turns) {
    if (turn.messageId === undefined) continue;
    byId.set(turn.messageId, String(turn.turnIndex));
  }
  return byId;
}

function userMessageChunk(sessionId: string, text: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
    },
  };
}

function assistantContentPartToUpdate(
  part: ContentPart,
  sessionId: string,
  turnId: number,
): SessionNotification | null {
  if (part.type === 'text' && part.text) {
    return assistantDeltaToSessionUpdate(sessionId, {
      type: 'assistant.delta',
      turnId,
      delta: part.text,
    });
  }
  if (part.type === 'think' && part.think) {
    return thinkingDeltaToSessionUpdate(sessionId, {
      type: 'thinking.delta',
      turnId,
      delta: part.think,
    });
  }
  // image_url / audio_url / video_url belong to the user-input side and ACP
  // has no dedicated assistant-media chunk; skip them.
  return null;
}

function syntheticToolCall(
  sessionId: string,
  turnId: number,
  toolCall: ToolCall,
): SessionNotification {
  return toolCallStartToSessionUpdate(sessionId, {
    type: 'tool.call.started',
    turnId,
    toolCallId: toolCall.id,
    name: toolCall.name,
    args: parseToolCallArguments(toolCall.arguments),
  });
}

function toolMessageToUpdate(
  message: ContextMessage,
  sessionId: string,
  toolCallTurnIds: ReadonlyMap<string, number>,
): SessionNotification | null {
  const rawToolCallId = message.toolCallId;
  if (!rawToolCallId) {
    // Tool result with no correlation id — skip rather than crash; the
    // on-disk session is the source of truth and we cannot synthesize a
    // missing id.
    return null;
  }
  const turnId = toolCallTurnIds.get(rawToolCallId);
  if (turnId === undefined) {
    // The matching assistant message was not in this history slice (e.g. the
    // session was compacted). Skip — emitting an update for a tool_call the
    // client never saw would orphan the card.
    return null;
  }
  const isError = message.isError === true;
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: `${turnId}:${rawToolCallId}`,
      status: isError ? 'failed' : 'completed',
      content: toolMessageContentToAcpToolCallContent(message.content),
    },
  };
}

/**
 * Parse a tool call's `arguments` field (a JSON string or `null`) into the
 * structured object expected by {@link toolCallStartToSessionUpdate}. Falls
 * back to the raw string when the payload is not valid JSON.
 */
function parseToolCallArguments(rawArguments: string | null): unknown {
  if (rawArguments === null || rawArguments === '') return {};
  try {
    return JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
}

/**
 * Project a `tool`-role message's content parts into the ACP
 * `tool_call_update.content` shape. Text parts surface directly; anything else
 * (image refs, etc.) becomes a `[type]` placeholder so the result card is not
 * empty.
 */
function toolMessageContentToAcpToolCallContent(
  parts: readonly ContentPart[],
): Array<{ type: 'content'; content: { type: 'text'; text: string } }> {
  const result: Array<{ type: 'content'; content: { type: 'text'; text: string } }> = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) {
        result.push({ type: 'content', content: { type: 'text', text: part.text } });
      }
      continue;
    }
    result.push({ type: 'content', content: { type: 'text', text: `[${part.type}]` } });
  }
  return result;
}
