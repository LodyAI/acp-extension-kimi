import type {
  ApprovalRequest,
  ApprovalResponse,
} from '@moonshot-ai/agent-core-v2/agent/interaction/approval';
import type {
  Interaction,
  InteractionKind,
} from '@moonshot-ai/agent-core-v2/human/interaction/interaction';
import type {
  QuestionRequest,
  QuestionResult,
} from '@moonshot-ai/agent-core-v2/agent/interaction/question';
import type {
  AgentMeta,
  SessionMeta,
  SessionMetaPatch,
} from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type { ForkTurnSummary } from '@moonshot-ai/agent-core-v2/workspace/sessionLifecycle/sessionLifecycle';
import type { PromptPredictionCancelReason } from '@moonshot-ai/agent-core-v2/features/promptPrediction/promptPrediction';
import type { SkillSummary } from '@moonshot-ai/agent-core-v2/features/skill/catalog/types';

import type { ScopeRef } from '../channel.js';
import type { McpServerConfig } from '../../contract/mcp.js';
import type { ScopedCaller } from './global.js';

export type { ScopedCaller } from './global.js';

interface HandleWire {
  readonly id: string;
}

export interface SessionRestoreOptions {
  readonly additionalDirs?: readonly string[];
  /** Replace this session's ephemeral roots; [] clears them, omission preserves live roots. */
  readonly requestAdditionalDirs?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface SessionApprovalsFacade {
  list(): Promise<readonly ApprovalRequest[]>;
  decide(id: string, response: ApprovalResponse): Promise<void>;
}

export interface SessionQuestionsFacade {
  list(): Promise<readonly QuestionRequest[]>;
  answer(id: string, result: QuestionResult): Promise<void>;
  dismiss(id: string): Promise<void>;
}

export interface SessionInteractionsFacade {
  list(kind?: InteractionKind): Promise<readonly Interaction[]>;
  respond(id: string, response: unknown): Promise<void>;
}

export interface SessionSkillsFacade {
  list(): Promise<readonly SkillSummary[]>;
}

export type SessionStatus = 'running' | 'idle' | 'awaiting_approval' | 'awaiting_question';

export interface SessionFacade {
  get(): Promise<SessionMeta>;
  setTitle(title: string): Promise<void>;
  generateTitle(opts?: {
    force?: boolean;
    source?: 'user_prompts' | 'first_turn' | 'digest';
  }): Promise<string | undefined>;
  update(patch: SessionMetaPatch): Promise<void>;
  setArchived(archived: boolean): Promise<void>;
  status(): Promise<SessionStatus>;
  close(): Promise<void>;
  archive(): Promise<void>;
  restore(opts?: SessionRestoreOptions): Promise<boolean>;
  delete(): Promise<void>;
  /**
   * The turns `fork({ turnIndex })` can address, oldest first. Positions come
   * from the durable records, so they stay valid after a compaction has
   * dropped the corresponding messages from the rendered context.
   */
  forkTurns(): Promise<readonly ForkTurnSummary[]>;
  fork(input?: {
    workDir?: string;
    requestAdditionalDirs?: readonly string[];
    title?: string;
    metadata?: Record<string, unknown>;
    /** Retain the session through this turn only (see {@link forkTurns}). */
    turnIndex?: number;
  }): Promise<SessionMeta>;
  createChild(input?: {
    workDir?: string;
    requestAdditionalDirs?: readonly string[];
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionMeta>;
  predictNextPrompt(input: {
    predictionId: string;
    expectedTurnId: number;
  }): Promise<string | null>;
  cancelPromptPrediction(
    predictionId: string,
    reason?: PromptPredictionCancelReason,
  ): Promise<boolean>;
  readonly approvals: SessionApprovalsFacade;
  readonly questions: SessionQuestionsFacade;
  readonly interactions: SessionInteractionsFacade;
  readonly skills: SessionSkillsFacade;
  agents(): Promise<Readonly<Record<string, AgentMeta>>>;
}

export function createSessionFacade(call: ScopedCaller, sessionId: string): SessionFacade {
  const scope: ScopeRef = { sessionId };
  const read = (): Promise<SessionMeta> =>
    call(scope, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
  const spawn = async (
    method: 'fork' | 'createChild',
    input: {
      workDir?: string;
      requestAdditionalDirs?: readonly string[];
      title?: string;
      metadata?: Record<string, unknown>;
      turnIndex?: number;
    } = {},
  ): Promise<SessionMeta> => {
    return call({}, 'sessionManager', method, [
      {
        sourceSessionId: sessionId,
        workDir: input.workDir,
        requestAdditionalDirs: input.requestAdditionalDirs,
        title: input.title,
        metadata: input.metadata,
        turnIndex: input.turnIndex,
      },
    ]) as Promise<SessionMeta>;
  };

  return {
    get: read,
    setTitle: (title) => call(scope, 'sessionMetadata', 'setTitle', [title]) as Promise<void>,
    generateTitle: (opts) =>
      call(scope, 'sessionTitleService', 'generateTitle', [opts]) as Promise<
        string | undefined
      >,
    update: (patch) => call(scope, 'sessionMetadata', 'update', [patch]) as Promise<void>,
    setArchived: (archived) =>
      call(scope, 'sessionMetadata', 'setArchived', [archived]) as Promise<void>,
    status: async () => {
      const activity = (await call(scope, 'sessionActivityView', 'state', [])) as {
        readonly busy: boolean;
        readonly pendingInteraction: 'none' | 'approval' | 'question';
      };
      if (activity.pendingInteraction === 'approval') return 'awaiting_approval';
      if (activity.pendingInteraction === 'question') return 'awaiting_question';
      return activity.busy ? 'running' : 'idle';
    },
    close: () => call({}, 'sessionManager', 'close', [sessionId]) as Promise<void>,
    archive: () => call({}, 'sessionManager', 'archive', [sessionId]) as Promise<void>,
    restore: async (opts) => {
      const handle = (await call({}, 'sessionManager', 'restore', [sessionId, opts])) as HandleWire | null;
      return handle !== null && handle !== undefined;
    },
    delete: () => call({}, 'sessionManager', 'delete', [sessionId]) as Promise<void>,
    forkTurns: () =>
      call({}, 'sessionManager', 'listForkTurns', [sessionId]) as Promise<
        readonly ForkTurnSummary[]
      >,
    fork: (input) => spawn('fork', input),
    createChild: (input) => spawn('createChild', input),
    predictNextPrompt: (input) =>
      call(scope, 'sessionPromptPredictionService', 'predict', [input]) as Promise<string | null>,
    cancelPromptPrediction: (predictionId, reason) =>
      call(scope, 'sessionPromptPredictionService', 'cancel', [predictionId, reason]) as Promise<boolean>,

    approvals: {
      list: () =>
        call(scope, 'sessionApprovalService', 'listPending', []) as Promise<
          readonly ApprovalRequest[]
        >,
      decide: (id, response) =>
        call(scope, 'sessionApprovalService', 'decide', [id, response]) as Promise<void>,
    },

    questions: {
      list: () =>
        call(scope, 'sessionQuestionService', 'listPending', []) as Promise<
          readonly QuestionRequest[]
        >,
      answer: (id, result) =>
        call(scope, 'sessionQuestionService', 'answer', [id, result]) as Promise<void>,
      dismiss: (id) => call(scope, 'sessionQuestionService', 'dismiss', [id]) as Promise<void>,
    },

    interactions: {
      list: (kind) =>
        call(scope, 'sessionInteractionService', 'listPending', [kind]) as Promise<
          readonly Interaction[]
        >,
      respond: (id, response) =>
        call(scope, 'sessionInteractionService', 'respond', [id, response]) as Promise<void>,
    },

    skills: {
      list: () =>
        call(scope, 'sessionSkillCatalog', 'list', []) as Promise<readonly SkillSummary[]>,
    },

    agents: async () => {
      const meta = await read();
      return meta.agents ?? {};
    },
  };
}
