import { describe, expect, it } from 'vitest';

import { Emitter } from '#/_base/event';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import { SessionStateService } from '#/session/state/sessionStateService';
import {
  SessionWorkspaceContextService,
  workspaceContextRequestAdditionalDirsKey,
} from '#/session/workspaceContext/workspaceContextService';
import type { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';

it('replaces request roots independently while following native workspace changes', () => {
  const changed = new Emitter<void>();
  let native = ['/native'];
  const info: ISessionWorkspaceInfo = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get additionalDirs() {
      return native;
    },
    onDidChange: changed.event,
  };
  const sessions = ['parent', 'child', 'sibling'].map((sessionId) => {
    const states = new SessionStateService();
    const ctx = new SessionWorkspaceContextService(states, makeSessionContext({
      sessionId,
      workspaceId: 'workspace',
      sessionDir: `/sessions/${sessionId}`,
      sessionScope: sessionId,
      cwd: '/workspace',
    }), info);
    return { states, ctx };
  });
  const parent = sessions[0]!;
  const child = sessions[1]!;
  const sibling = sessions[2]!;
  try {
    parent.states.set(workspaceContextRequestAdditionalDirsKey, ['/a']);
    child.states.set(workspaceContextRequestAdditionalDirsKey, ['/child']);
    expect(parent.ctx.additionalDirs).toEqual(['/native', '/a']);
    expect(child.ctx.additionalDirs).toEqual(['/native', '/child']);
    expect(sibling.ctx.additionalDirs).toEqual(['/native']);

    parent.states.set(workspaceContextRequestAdditionalDirsKey, ['/b', '/b']);
    expect(parent.ctx.isWithin('/a/file')).toBe(false);
    expect(parent.ctx.assertAllowed('/b/file', 'write')).toBe('/b/file');
    expect(parent.ctx.resolve('file')).toBe('/workspace/file');
    native = ['/native-next'];
    changed.fire();
    expect(parent.ctx.additionalDirs).toEqual(['/native-next', '/b']);
    expect(child.ctx.additionalDirs).toEqual(['/native-next', '/child']);
    expect(sibling.ctx.additionalDirs).toEqual(['/native-next']);

    parent.states.set(workspaceContextRequestAdditionalDirsKey, []);
    expect(parent.ctx.additionalDirs).toEqual(['/native-next']);
    expect(() => parent.ctx.assertAllowed('/b/file', 'execute')).toThrow('Path outside workspace');
    expect(parent.ctx.assertAllowed('/native-next/file', 'read')).toBe('/native-next/file');
    expect(child.ctx.additionalDirs).toEqual(['/native-next', '/child']);
    expect(info.additionalDirs).toEqual(['/native-next']);
  } finally {
    for (const { states, ctx } of sessions) {
      ctx.dispose();
      states.dispose();
    }
    changed.dispose();
  }
});

describe('session working directory', () => {
  it('uses the primary directory for relative paths and request roots', () => {
    const states = new SessionStateService();
    const changed = new Emitter<void>();
    const ctx = new SessionWorkspaceContextService(states, makeSessionContext({
      sessionId: 'session',
      workspaceId: 'workspace',
      sessionDir: '/session',
      sessionScope: 'session',
      cwd: '/workspace',
    }), {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      additionalDirs: [],
      onDidChange: changed.event,
    });
    try {
      states.set(workspaceContextRequestAdditionalDirsKey, ['../extra']);
      expect(ctx.additionalDirs).toEqual(['/extra']);
      expect(ctx.resolve('file')).toBe('/workspace/file');
      expect(ctx.isWithin('/workspace/file')).toBe(true);
    } finally {
      ctx.dispose();
      states.dispose();
      changed.dispose();
    }
  });
});
