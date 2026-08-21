/** ACP `elicitation/create` ↔ agent-core-v2 ask-user mappers. */

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  EnumOption,
} from '@agentclientprotocol/sdk';
import type { QuestionAnswers, QuestionItem } from '@moonshot-ai/agent-core-v2';

/** Property key for question `i` in the elicitation form schema. */
function questionPropertyKey(questionIndex: number): string {
  return `q${questionIndex}`;
}

/** Titled enum options shared by the single- (`oneOf`) and multi- (`anyOf`) select arms. */
function titledEnumOptions(question: QuestionItem): EnumOption[] {
  return question.options.map((opt) => ({
    const: opt.label,
    title: opt.label,
    description: opt.description,
  }));
}

/**
 * Map a tool-side question set into an `elicitation/create` form-mode request.
 *
 * The form schema carries every question natively: single-select questions
 * become `type: 'string'` + `oneOf`, `multiSelect` questions become
 * `type: 'array'` + `items.anyOf` (with `minItems: 1`, since every question
 * is required). The form-level `message` joins the question texts; each
 * field is titled by the question's `header` (falling back to the full
 * question text) and described by its `body`.
 *
 * The synthetic "Other" free-text option (`otherLabel`) has no elicitation
 * equivalent without an extra text field, so it stays unsupported for now.
 */
export function questionRequestToElicitationParams(
  questions: readonly QuestionItem[],
  sessionId: string,
  toolCallId?: string,
): Extract<CreateElicitationRequest, { mode: 'form' }> {
  const properties: Record<string, ElicitationPropertySchema> = {};
  const required: string[] = [];
  questions.forEach((q, i) => {
    const key = questionPropertyKey(i);
    required.push(key);
    const title = q.header ?? q.question;
    properties[key] =
      q.multiSelect === true
        ? {
            type: 'array',
            title,
            description: q.body,
            minItems: 1,
            items: { anyOf: titledEnumOptions(q) },
          }
        : {
            type: 'string',
            title,
            description: q.body,
            oneOf: titledEnumOptions(q),
          };
  });
  return {
    sessionId,
    toolCallId,
    mode: 'form',
    message: questions.map((q) => q.question).join('\n'),
    requestedSchema: { type: 'object', properties, required },
  };
}

/**
 * Reverse-map an `elicitation/create` response into a tool-side
 * {@link QuestionAnswers} payload. `decline` / `cancel` (and an `accept`
 * without content) resolve to `null` — the tool's canonical "user dismissed"
 * branch. Multi-select values join with `', '` in DECLARED option order,
 * matching the TUI's `QuestionDialog` encoding. Values outside the declared
 * options are dropped defensively; an accept that answers nothing resolves
 * to `null` as well.
 */
export function elicitationResponseToQuestionAnswers(
  questions: readonly QuestionItem[],
  response: CreateElicitationResponse,
): QuestionAnswers | null {
  if (response.action !== 'accept') return null;
  const content = (response as { content?: Record<string, unknown> | null }).content;
  if (content === null || content === undefined) return null;
  const answers: QuestionAnswers = {};
  questions.forEach((q, i) => {
    const value = content[questionPropertyKey(i)];
    if (q.multiSelect === true) {
      if (!Array.isArray(value)) return;
      const picked = q.options
        .map((opt) => opt.label)
        .filter((label) => value.includes(label));
      if (picked.length > 0) answers[q.question] = picked.join(', ');
      return;
    }
    if (typeof value === 'string' && q.options.some((opt) => opt.label === value)) {
      answers[q.question] = value;
    }
  });
  return Object.keys(answers).length > 0 ? answers : null;
}
