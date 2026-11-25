import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import { mcpServerConfigSchema } from '../mcp.js';
import type { ServiceContract } from '../types.js';
import { sessionMetaSchema } from './metadata.js';

export const createSessionOptionsSchema = z.object({
  sessionId: z.string().optional(),
  workDir: z.string(),
  additionalDirs: z.array(z.string()).optional(),
  requestAdditionalDirs: z.array(z.string()).optional(),
  environmentId: z.string().optional(),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
});

export const resumeSessionOptionsSchema = z.object({
  additionalDirs: z.array(z.string()).optional(),
  requestAdditionalDirs: z.array(z.string()).optional(),
  /**
   * Ephemeral per-session MCP servers, applied when resume re-materializes a
   * cold session (ignored when the session is already live).
   */
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
});

export const forkSessionOptionsSchema = z.object({
  sourceSessionId: z.string(),
  workDir: z.string().optional(),
  requestAdditionalDirs: z.array(z.string()).optional(),
  newSessionId: z.string().optional(),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  turnIndex: z.number().optional(),
});

export const createChildSessionOptionsSchema = forkSessionOptionsSchema.omit({ turnIndex: true });

export const handleWireSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
});

/** One fork-addressable turn (`ForkTurnSummary` in the engine). */
export const forkTurnSummarySchema = z.object({
  turnIndex: z.number(),
  messageId: z.string().optional(),
  prompt: z.string().optional(),
});

export const sessionManagerContract = {
  create: { input: z.tuple([createSessionOptionsSchema]), output: handleWireSchema },
  resume: {
    input: z.tuple([z.string(), resumeSessionOptionsSchema.optional()]),
    output: maybe(handleWireSchema),
  },
  close: { input: z.tuple([z.string()]), output: noResult },
  archive: { input: z.tuple([z.string()]), output: noResult },
  restore: {
    input: z.tuple([z.string(), resumeSessionOptionsSchema.optional()]),
    output: maybe(handleWireSchema),
  },
  delete: { input: z.tuple([z.string()]), output: noResult },
  listForkTurns: {
    input: z.tuple([z.string()]),
    output: z.array(forkTurnSummarySchema),
  },
  fork: { input: z.tuple([forkSessionOptionsSchema]), output: sessionMetaSchema },
  createChild: { input: z.tuple([createChildSessionOptionsSchema]), output: sessionMetaSchema },
} satisfies ServiceContract;
