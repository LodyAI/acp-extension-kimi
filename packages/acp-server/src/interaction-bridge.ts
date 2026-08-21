/**
 * ACP interaction bridge — forwards the engine's blocking human-in-the-loop
 * requests to ACP permission and elicitation primitives, and relays the client's decision back to the
 * `interaction` kernel.
 *
 * The engine's `AgentPermissionGate` and `AskUserQuestionTool` park requests on
 * the Session-scoped interaction service and block on their response. This
 * bridge is a pure edge observer driven entirely by the klient facade: it
 * subscribes to the session's `interactions.changed` event (which pushes the
 * full pending set on every change), and for every newly-pending `approval` /
 * `question` interaction it calls ACP form elicitation, maps the
 * response through the pure mappers in `./approval` / `./question`, and
 * settles the parked request via `session.interactions.respond(id, ...)`.
 */

import type {
  Interaction,
  QuestionAnswers,
  QuestionRequest,
  SessionApprovalRequest as ApprovalRequest,
  SessionApprovalResponse as ApprovalResponse,
} from '@moonshot-ai/agent-core-v2';
import type { IDisposable, SessionHandle } from '@moonshot-ai/klient';

import type { AcpClient } from './acp-client';

import {
  approvalRequestToPermissionOptions,
  attachSelectedLabel,
  buildPermissionToolCallUpdate,
  permissionResponseToApprovalResponse,
} from './approval';
import { acpToolCallId } from './events-map';
import { log } from './log';
import {
  elicitationResponseToQuestionAnswers,
  questionRequestToElicitationParams,
} from './question';

export class AcpInteractionBridge {
  /** Ids the bridge has already begun handling — guards against re-entry. */
  private readonly inFlight = new Set<string>();
  private readonly subscription: IDisposable;
  private disposed = false;

  constructor(
    private readonly conn: AcpClient,
    private readonly session: SessionHandle,
    private readonly sessionId: string,
    /**
     * Whether the client advertised `elicitation.form` at `initialize`. When
     * true, ask-user questions go through `elicitation/create`.
     */
    private readonly elicitationForm = false,
  ) {
    this.subscription = session.events.on('interactions.changed', (pending) => {
      this.onPendingChanged(pending);
    }); // The event stream only fires on change — sweep anything parked before the
    // subscription attached (matches the old direct `listPending()` sweep).
    void this.session.interactions.list().then(
      (pending) => {
        this.onPendingChanged(pending);
      },
      (error: unknown) => {
        log.warn('acp: initial interaction sweep failed', {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
    this.inFlight.clear();
  }

  private onPendingChanged(pending: readonly Interaction[]): void {
    if (this.disposed) return;
    for (const interaction of pending) {
      if (this.inFlight.has(interaction.id)) continue;
      if (interaction.kind !== 'approval' && interaction.kind !== 'question') continue;
      this.inFlight.add(interaction.id);
      void this.dispatch(interaction);
    }
  }

  private async dispatch(interaction: Interaction): Promise<void> {
    const respond = (response: unknown): Promise<void> =>
      this.session.interactions.respond(interaction.id, response);
    try {
      if (interaction.kind === 'approval') {
        const response = await this.handleApproval(interaction.payload as ApprovalRequest);
        await respond(response);
        return;
      }
      if (interaction.kind === 'question') {
        const result = await this.handleQuestion(interaction.payload as QuestionRequest);
        await respond(result);
      }
    } catch (error) {
      // `respond` itself never throws for a still-pending id, and the handlers
      // already swallow RPC failures into a safe response — so reaching here
      // means something unexpected broke. Log and settle with the safest
      // default so the gate/tool does not park forever.
      log.warn('acp: interaction bridge dispatch failed', {
        sessionId: this.sessionId,
        interactionId: interaction.id,
        kind: interaction.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      const fallback: unknown =
        interaction.kind === 'approval'
          ? ({ decision: 'rejected' } satisfies ApprovalResponse)
          : null;
      await respond(fallback).catch((respondError: unknown) => {
        log.warn('acp: interaction bridge fallback respond failed', {
          sessionId: this.sessionId,
          interactionId: interaction.id,
          error: respondError instanceof Error ? respondError.message : String(respondError),
        });
      });
    }
  }

  /**
   * Bridge an engine {@link ApprovalRequest} to the ACP client and back. Any
   * RPC failure resolves with `decision: 'rejected'` — rejecting on failure is
   * strictly safer than approving when the client cannot confirm intent.
   */
  private async handleApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
    const toolCall = buildPermissionToolCallUpdate(req);
    const options = approvalRequestToPermissionOptions(req);
    try {
      const response = await this.conn.requestPermission({
        sessionId: this.sessionId,
        options: [...options],
        toolCall,
      });
      return attachSelectedLabel(
        response,
        permissionResponseToApprovalResponse(req, response),
        options,
      );
    } catch (error) {
      log.warn('acp: requestPermission failed; rejecting', {
        sessionId: this.sessionId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return { decision: 'rejected' };
    }
  }

  /**
   * Bridge an engine {@link QuestionRequest} (the AskUserQuestion tool) to the
   * client through ACP form elicitation. A client without that standard
   * capability cannot service AskUserQuestion and the tool is dismissed.
   */
  private async handleQuestion(req: QuestionRequest): Promise<QuestionAnswers | null> {
    const questions = req.questions;
    if (questions.length === 0) {
      log.warn('acp: handleQuestion received empty questions array', {
        sessionId: this.sessionId,
      });
      return null;
    }
    const rawToolCallId = req.toolCallId ?? 'ask-user';
    const toolCallId =
      req.turnId !== undefined ? acpToolCallId(req.turnId, rawToolCallId) : rawToolCallId;
    if (!this.elicitationForm) return null;
    try {
      const response = await this.conn.createElicitation(
        questionRequestToElicitationParams(questions, this.sessionId, toolCallId),
      );
      return elicitationResponseToQuestionAnswers(questions, response);
    } catch (error) {
      log.warn('acp: elicitation/create failed; dismissing question', {
        sessionId: this.sessionId,
        toolCallId: req.toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
