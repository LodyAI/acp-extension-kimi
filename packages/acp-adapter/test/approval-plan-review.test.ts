/**
 * Phase 13.2 tests for the plan_review approval branch:
 *
 *  - `approvalRequestToPermissionOptions(req)` expands to A/B/C +
 *    Revise + Reject and Exit (or `plan_approve` + the two rejects
 *    when `display.options` is missing).
 *  - `displayBlockToAcpContent(display)` surfaces the plan markdown
 *    (and optional `Plan saved to:` prefix) at the headline of the
 *    approval card.
 *  - `permissionResponseToApprovalResponse(req, response)` round-trips
 *    each optionId back to the SDK approval discriminator, attaching
 *    `selectedLabel` on the plan_opt_<i> / plan_revise /
 *    plan_reject_and_exit paths.
 *
 * Non-plan_review behaviour stays in `approval.test.ts` — this file
 * exercises ONLY the plan_review branch.
 */
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { ApprovalRequest, ToolInputDisplay } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import {
  PLAN_APPROVE_OPTION_ID,
  PLAN_REJECT_AND_EXIT_OPTION_ID,
  PLAN_REVISE_OPTION_ID,
  approvalRequestToPermissionOptions,
  buildPermissionToolCallUpdate,
  permissionResponseToApprovalResponse,
} from '../src/approval';
import { inferToolKind } from '../src/events-map';
import { displayBlockToAcpContent } from '../src/convert';

const planMd = '## Plan\n\n1. Land the bridge\n2. Cut a release';

function makePlanReviewRequest(
  opts: {
    options?: ReadonlyArray<{ label: string; description: string }>;
    plan?: string;
    path?: string;
  } = {},
): ApprovalRequest {
  const display: ToolInputDisplay = {
    kind: 'plan_review',
    plan: opts.plan ?? planMd,
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.options !== undefined ? { options: opts.options } : {}),
  };
  return {
    toolCallId: 'tc-plan',
    toolName: 'ExitPlanMode',
    action: 'Present the plan and exit plan mode',
    display,
  };
}

const threeOptions = [
  { label: 'Option A: Ship it', description: 'Land what we have.' },
  { label: 'Option B: Robustness', description: 'Add the guard rails first.' },
  { label: 'Option C: Pivot', description: 'Drop the surface entirely.' },
] as const;

function selectedResponse(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId } };
}

describe('approvalRequestToPermissionOptions — plan_review branch', () => {
  it('emits one allow_once per display.option plus Revise + Reject and Exit', () => {
    const req = makePlanReviewRequest({ options: threeOptions, path: '/tmp/plan.md' });
    const out = approvalRequestToPermissionOptions(req);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({
      optionId: 'plan_opt_0',
      name: 'Option A: Ship it',
      kind: 'allow_once',
    });
    expect(out[1]).toEqual({
      optionId: 'plan_opt_1',
      name: 'Option B: Robustness',
      kind: 'allow_once',
    });
    expect(out[2]).toEqual({
      optionId: 'plan_opt_2',
      name: 'Option C: Pivot',
      kind: 'allow_once',
    });
    expect(out[3]).toEqual({
      optionId: PLAN_REVISE_OPTION_ID,
      name: 'Revise',
      kind: 'reject_once',
    });
    expect(out[4]).toEqual({
      optionId: PLAN_REJECT_AND_EXIT_OPTION_ID,
      name: 'Reject and Exit',
      kind: 'reject_once',
    });
  });

  it('falls back to a single plan_approve when display.options is undefined', () => {
    const req = makePlanReviewRequest({ options: undefined });
    const out = approvalRequestToPermissionOptions(req);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      optionId: PLAN_APPROVE_OPTION_ID,
      name: 'Approve',
      kind: 'allow_once',
    });
    expect(out[1]?.optionId).toBe(PLAN_REVISE_OPTION_ID);
    expect(out[2]?.optionId).toBe(PLAN_REJECT_AND_EXIT_OPTION_ID);
  });

  it('falls back to plan_approve when display.options.length === 1 (below the 2-option threshold)', () => {
    const req = makePlanReviewRequest({
      options: [{ label: 'Only choice', description: 'sole option' }],
    });
    const out = approvalRequestToPermissionOptions(req);
    expect(out).toHaveLength(3);
    expect(out[0]?.optionId).toBe(PLAN_APPROVE_OPTION_ID);
  });

  it('preserves Phase 5 canonical behaviour when display.kind is not plan_review', () => {
    const req: ApprovalRequest = {
      toolCallId: 'tc-cmd',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'command', command: 'echo hi' },
    };
    const out = approvalRequestToPermissionOptions(req);
    expect(out).toHaveLength(3);
    expect(out.map((o) => o.optionId)).toEqual([
      'approve_once',
      'approve_always',
      'reject',
    ]);
  });
});

describe('displayBlockToAcpContent — plan_review (re-exercise via approval fixture)', () => {
  it('renders Plan saved to: prefix + plan body when path is set', () => {
    const req = makePlanReviewRequest({ options: threeOptions, path: '/tmp/plan.md' });
    const out = displayBlockToAcpContent(req.display);
    expect(out).toEqual({
      type: 'content',
      content: {
        type: 'text',
        text: `Plan saved to: /tmp/plan.md\n\n${planMd}`,
      },
    });
  });

  it('renders the plan body alone when path is absent', () => {
    const req = makePlanReviewRequest({ options: threeOptions });
    const out = displayBlockToAcpContent(req.display);
    expect(out).toEqual({
      type: 'content',
      content: { type: 'text', text: planMd },
    });
  });
});

describe('permissionResponseToApprovalResponse — plan_review branch', () => {
  const req = makePlanReviewRequest({ options: threeOptions, path: '/tmp/plan.md' });

  it('maps plan_opt_<i> → { decision: approved, selectedLabel: options[i].label }', () => {
    const result = permissionResponseToApprovalResponse(req, selectedResponse('plan_opt_1'));
    expect(result).toEqual({
      decision: 'approved',
      selectedLabel: 'Option B: Robustness',
    });
  });

  it('maps plan_opt_0 to the first label (boundary)', () => {
    const result = permissionResponseToApprovalResponse(req, selectedResponse('plan_opt_0'));
    expect(result).toEqual({
      decision: 'approved',
      selectedLabel: 'Option A: Ship it',
    });
  });

  it('maps plan_revise → { decision: rejected, selectedLabel: "Revise" }', () => {
    const result = permissionResponseToApprovalResponse(
      req,
      selectedResponse(PLAN_REVISE_OPTION_ID),
    );
    expect(result).toEqual({ decision: 'rejected', selectedLabel: 'Revise' });
  });

  it('maps plan_reject_and_exit → { decision: rejected, selectedLabel: "Reject and Exit" }', () => {
    const result = permissionResponseToApprovalResponse(
      req,
      selectedResponse(PLAN_REJECT_AND_EXIT_OPTION_ID),
    );
    expect(result).toEqual({
      decision: 'rejected',
      selectedLabel: 'Reject and Exit',
    });
  });

  it('maps plan_approve → { decision: approved } with no selectedLabel', () => {
    const noOptionsReq = makePlanReviewRequest({ options: undefined });
    const result = permissionResponseToApprovalResponse(
      noOptionsReq,
      selectedResponse(PLAN_APPROVE_OPTION_ID),
    );
    expect(result).toEqual({ decision: 'approved' });
    expect(result.selectedLabel).toBeUndefined();
  });

  it('defensively maps plan_opt_99 (out of bounds) → { decision: rejected }', () => {
    const result = permissionResponseToApprovalResponse(req, selectedResponse('plan_opt_99'));
    expect(result).toEqual({ decision: 'rejected' });
  });

  it('defensively maps an unknown plan_* optionId → { decision: rejected }', () => {
    const result = permissionResponseToApprovalResponse(
      req,
      selectedResponse('plan_unknown'),
    );
    expect(result).toEqual({ decision: 'rejected' });
  });

  it('maps cancelled → { decision: cancelled } even in plan_review context', () => {
    const result = permissionResponseToApprovalResponse(req, {
      outcome: { outcome: 'cancelled' },
    });
    expect(result).toEqual({ decision: 'cancelled' });
  });
});

describe('plan_review tool kind', () => {
  /**
   * ACP clients key their plan surface on `kind: 'switch_mode'`, never on the
   * tool name or the rendered title — those differ per agent. `ExitPlanMode`
   * previously fell through to `'other'`, so a plan review reached the client
   * as an ordinary tool call and was folded into the generic activity list
   * instead of showing the plan and its decision.
   */
  it('maps ExitPlanMode to switch_mode', () => {
    expect(inferToolKind('ExitPlanMode')).toBe('switch_mode');
  });

  it('leaves unrelated tools alone', () => {
    expect(inferToolKind('Read')).toBe('read');
    expect(inferToolKind('EnterPlanMode')).toBe('other');
    expect(inferToolKind('SomeMcpTool')).toBe('other');
  });

  it('stamps the kind on the approval card too', () => {
    // The approval can be the only update the client sees for this tool call.
    const update = buildPermissionToolCallUpdate(7, makePlanReviewRequest());
    expect(update.kind).toBe('switch_mode');
    expect(update.title).toBe('ExitPlanMode');
  });
});
