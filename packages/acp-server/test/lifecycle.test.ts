import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IOAuthToolkit,
  IAgentEnvironmentBindingService,
  IAgentLifecycleService,
  ensureMainAgent,
  ISessionManager,
  ISessionMcpHandle,
  IWorkspaceInstanceManager,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';
import { ISessionContext } from '@moonshot-ai/agent-core-v2/session/sessionContext/sessionContext';
import { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/interface/atomicDocumentStore';
import { ISessionWorkspaceContext } from '@moonshot-ai/agent-core-v2/session/workspaceContext/workspaceContext';

import type { SessionSummary } from '@moonshot-ai/klient';

import { filterSessionSummariesByCwd } from '../src/server';
import { createTestClient, type TestClient } from './_helpers/acpClient';
import { writeFakeModelConfig } from './_helpers/fakeModelConfig';
import { createScriptedProvider } from './_helpers/scriptedProvider';

const STDIO_MCP_FIXTURE = fileURLToPath(
  new URL('../../agent-core-v2/test/mcpCore/fixtures/mock-stdio-server.mjs', import.meta.url),
);

const OAUTH_PROVIDER_CONFIG = `[providers.test-oauth]
type = "kimi"
baseUrl = "http://localhost"

[providers.test-oauth.oauth]
storage = "file"
key = "test-key"
`;

function createFakeOAuthToolkit(): {
  readonly seed: readonly [typeof IOAuthToolkit, IOAuthToolkit];
  hasToken(): boolean;
} {
  let token: string | undefined = 'fake-token';
  const fake = {
    login: () => Promise.reject(new Error('fakeOAuthToolkit: login not implemented')),
    logout: (providerName?: string) => {
      token = undefined;
      return Promise.resolve({ providerName: providerName ?? 'test-oauth' });
    },
    getCachedAccessToken: () => Promise.resolve(token),
    tokenProvider: () => {
      throw new Error('fakeOAuthToolkit: tokenProvider not implemented');
    },
    getManagedUsage: () => Promise.reject(new Error('fakeOAuthToolkit: not implemented')),
    getManagedUserInfo: () => Promise.reject(new Error('fakeOAuthToolkit: not implemented')),
  } as unknown as IOAuthToolkit;
  return { seed: [IOAuthToolkit, fake], hasToken: () => token !== undefined };
}

describe('acp-server session lifecycle', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;
  const workspaceLeases: { dispose(): void }[] = [];

  afterEach(async () => {
    for (const lease of workspaceLeases.splice(0)) lease.dispose();
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      homeDir = undefined;
    }
  });

  async function boot(configToml?: string): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-lifecycle-'));
    if (configToml !== undefined) await writeFile(join(homeDir, 'config.toml'), configToml, 'utf-8');
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  async function sessionMcpEntries(
    c: TestClient,
    sessionId: string,
  ): Promise<readonly { readonly name: string; readonly status: string; readonly error?: string }[]> {
    const lease = await c.server.core.accessor
      .get(IWorkspaceInstanceManager)
      .acquire({ root: homeDir! });
    try {
      const handle = c.server.core.accessor.get(ISessionManager).get(sessionId);
      expect(handle).toBeDefined();
      const mcp = handle!.accessor.get(ISessionMcpHandle);
      await mcp.ready;
      return mcp.connectionManager.list();
    } finally {
      lease.dispose();
    }
  }

  it(
    'session/new creates a live session and session/list returns it',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      expect(created.sessionId).toMatch(/^session_/);

      const listed = (await c.send('session/list', {})) as {
        sessions: { sessionId: string }[];
      };
      expect(listed.sessions.some((s) => s.sessionId === created.sessionId)).toBe(true);
    },
    30_000,
  );

  it(
    'session/new bypasses an invalid configured environment default',
    async () => {
      const c = await boot('[environments]\ndefault = "missing"\n');
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      expect(created.sessionId).toMatch(/^session_/);
    },
    30_000,
  );

  it(
    'session/resume on an unknown sessionId fails with invalid_params',
    async () => {
      const c = await boot();
      await expect(
        c.send('session/resume', { sessionId: 'does-not-exist', cwd: homeDir, mcpServers: [] }),
      ).rejects.toThrow();
    },
    30_000,
  );

  it(
    'session/load replays (empty) history and returns configOptions',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.waitForSessionUpdate('available_commands_update', 10_000);
      const before = c.sessionUpdates().length;

      const loaded = (await c.send('session/load', {
        sessionId: created.sessionId,
        cwd: homeDir,
        mcpServers: [],
      })) as { configOptions?: unknown[] };
      expect(Array.isArray(loaded.configOptions)).toBe(true);
      const replayed = c
        .sessionUpdates()
        .slice(before)
        .map((m) => (m.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate)
        .filter((k) => k !== 'available_commands_update');
      expect(replayed).toEqual([]);
    },
    30_000,
  );

  it(
    'session/fork on an unknown sessionId fails with invalid_params',
    async () => {
      const c = await boot();
      await expect(
        c.send('session/fork', { sessionId: 'does-not-exist', cwd: homeDir, mcpServers: [] }),
      ).rejects.toThrow(/-32602/);
    },
    30_000,
  );

  it(
    'session/fork creates an independently promptable session carrying the source history',
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'acp-fork-'));
      await writeFakeModelConfig(homeDir);
      const scripted = createScriptedProvider();
      client = await createTestClient({ homeDir, extraSeeds: [scripted.seed] });
      const c = client;
      await c.send('initialize', { protocolVersion: 1, clientCapabilities: {} });

      scripted.mockNextText('first turn reply');
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.waitForSessionUpdate('available_commands_update', 10_000);
      const sourceTurn = (await c.send('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'hello from the source session' }],
      })) as { stopReason: string };
      expect(sourceTurn.stopReason).toBe('end_turn');

      const forked = (await c.send('session/fork', {
        sessionId: created.sessionId,
        cwd: homeDir,
        mcpServers: [],
      })) as { sessionId: string; configOptions?: unknown[]; modes?: unknown };
      expect(forked.sessionId).toMatch(/^session_/);
      expect(forked.sessionId).not.toBe(created.sessionId);
      const forkedHandle = c.server.core.accessor.get(ISessionManager).get(forked.sessionId)!;
      const forkedMain = await ensureMainAgent(forkedHandle);
      expect(forkedHandle.accessor.get(IAgentLifecycleService).handleOf(forkedMain.agentId)!
        .accessor.get(IAgentEnvironmentBindingService).current.environmentId).toBe('local');
      expect(Array.isArray(forked.configOptions)).toBe(true);
      expect(forked.modes).toBeDefined();

      const listed = (await c.send('session/list', {})) as {
        sessions: { sessionId: string }[];
      };
      const ids = listed.sessions.map((s) => s.sessionId);
      expect(ids).toContain(created.sessionId);
      expect(ids).toContain(forked.sessionId);

      scripted.mockNextText('fork reply');
      const forkTurn = (await c.send('session/prompt', {
        sessionId: forked.sessionId,
        prompt: [{ type: 'text', text: 'hello from the fork' }],
      })) as { stopReason: string };
      expect(forkTurn.stopReason).toBe('end_turn');

      const before = c.sessionUpdates().length;
      await c.send('session/load', {
        sessionId: forked.sessionId,
        cwd: homeDir,
        mcpServers: [],
      });
      const replayed = c
        .sessionUpdates()
        .slice(before)
        .map(
          (m) =>
            (m.params as { update?: { sessionUpdate?: string; content?: { text?: string } } })
              .update,
        );
      const userChunks = replayed
        .filter((u) => u?.sessionUpdate === 'user_message_chunk')
        .map((u) => u?.content?.text);
      const agentChunks = replayed
        .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
        .map((u) => u?.content?.text);
      expect(userChunks).toContain('hello from the source session');
      expect(userChunks).toContain('hello from the fork');
      expect(agentChunks).toContain('first turn reply');
      expect(agentChunks).toContain('fork reply');
      const sourceBefore = c.sessionUpdates().length;
      await c.send('session/load', {
        sessionId: created.sessionId, cwd: homeDir, mcpServers: [],
      });
      const sourceReplay = JSON.stringify(c.sessionUpdates().slice(sourceBefore));
      expect(sourceReplay).toContain('hello from the source session');
      expect(sourceReplay).toContain('first turn reply');
      expect(sourceReplay).not.toContain('hello from the fork');
      expect(sourceReplay).not.toContain('fork reply');

      await c.send('session/close', { sessionId: created.sessionId });
      const files = await readdir(homeDir!, { recursive: true });
      const wirePath = files.find((path) => path.endsWith('wire.jsonl'))!;
      const records = (await readFile(join(homeDir!, wirePath), 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { type?: string; environmentId?: string });
      const bindingIndex = records.findIndex((record) => record.type === 'environment.set_binding');
      expect(bindingIndex).toBeGreaterThanOrEqual(0);
      records[bindingIndex]!.environmentId = `acp:${created.sessionId}`;
      await writeFile(join(homeDir!, wirePath), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

      const legacyForked = (await c.send('session/fork', {
        sessionId: created.sessionId,
        cwd: homeDir,
        mcpServers: [],
      })) as { sessionId: string };
      const legacyHandle = c.server.core.accessor.get(ISessionManager).get(legacyForked.sessionId)!;
      const legacyMain = await ensureMainAgent(legacyHandle);
      expect(legacyHandle.accessor.get(IAgentLifecycleService).handleOf(legacyMain.agentId)!
        .accessor.get(IAgentEnvironmentBindingService).current.environmentId).toBe('local');
    },
    30_000,
  );

  it(
    'session/delete removes the session and a second delete reports invalid_params',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };

      const deleted = await c.send('session/delete', { sessionId: created.sessionId });
      expect(deleted).toEqual({});
      await expect(
        c.send('session/prompt', { sessionId: created.sessionId, prompt: [] }),
      ).rejects.toThrow(/-32602/);

      const listed = (await c.send('session/list', {})) as {
        sessions: { sessionId: string }[];
      };
      expect(listed.sessions.some((s) => s.sessionId === created.sessionId)).toBe(false);

      await expect(
        c.send('session/delete', { sessionId: created.sessionId }),
      ).rejects.toThrow(/-32602/);
    },
    30_000,
  );

  it(
    'session/delete on an unknown sessionId fails with invalid_params',
    async () => {
      const c = await boot();
      await expect(c.send('session/delete', { sessionId: 'does-not-exist' })).rejects.toThrow(
        /-32602/,
      );
    },
    30_000,
  );

  it(
    'session/new connects ACP mcpServers as ephemeral session servers',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', {
        cwd: homeDir,
        mcpServers: [
          {
            name: 'mock',
            command: process.execPath,
            args: [STDIO_MCP_FIXTURE],
            env: [{ name: 'KIMI_TEST_MCP_START_DELAY_MS', value: '0' }],
          },
        ],
      })) as { sessionId: string };
      expect(created.sessionId).toMatch(/^session_/);

      const entries = await sessionMcpEntries(c, created.sessionId);
      expect(entries.find((e) => e.name === 'mock')?.status).toBe('connected');
    },
    30_000,
  );

  it(
    'session/load forwards mcpServers to the re-materialized session',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.send('session/close', { sessionId: created.sessionId });

      await c.send('session/load', {
        sessionId: created.sessionId,
        cwd: homeDir,
        mcpServers: [
          { name: 'mock', command: process.execPath, args: [STDIO_MCP_FIXTURE], env: [] },
        ],
      });

      const entries = await sessionMcpEntries(c, created.sessionId);
      expect(entries.find((e) => e.name === 'mock')?.status).toBe('connected');
    },
    30_000,
  );

  it.each([
    { method: 'session/load', cold: false },
    { method: 'session/load', cold: true },
    { method: 'session/resume', cold: false },
    { method: 'session/resume', cold: true },
  ])('$method rejects invalid directory requests without mutations (cold=$cold)', async ({ method, cold }) => {
    const c = await boot();
    const cwd = join(homeDir!, 'primary');
    const otherCwd = join(homeDir!, 'other');
    const a = join(homeDir!, 'a');
    const b = join(homeDir!, 'b');
    await Promise.all([cwd, otherCwd, a, b].map((dir) => mkdir(dir)));
    const { sessionId } = await c.send('session/new', {
      cwd, mcpServers: [], additionalDirectories: [a],
    }) as { sessionId: string };
    await c.waitForSessionUpdate('available_commands_update', 10_000);
    const manager = c.server.core.accessor.get(ISessionManager);
    const handle = manager.get(sessionId)!;
    const context = handle.accessor.get(ISessionWorkspaceContext);
    const scope = handle.accessor.get(ISessionContext).metaScope;
    const store = c.server.core.accessor.get(IAtomicDocumentStore);
    if (cold) await c.send('session/close', { sessionId });
    const beforeMetadata = structuredClone(await store.get(scope, 'state.json'));
    const beforeSummary = await c.server.klient.global.sessions.get(sessionId);
    for (const invalid of [
      { cwd: otherCwd, additionalDirectories: [b] },
      { cwd: otherCwd, additionalDirectories: [] },
      { cwd: otherCwd, additionalDirectories: undefined },
      { cwd: 'relative', additionalDirectories: [b] },
      { cwd: '', additionalDirectories: [] },
      { cwd, additionalDirectories: [b, '../a'] },
      { cwd, additionalDirectories: [''] },
    ]) {
      await expect(c.send(method, { sessionId, mcpServers: [], ...invalid }))
        .rejects.toThrow(/-32602/);
      expect(manager.get(sessionId)).toBe(cold ? undefined : handle);
      expect(await store.get(scope, 'state.json')).toEqual(beforeMetadata);
      expect(await c.server.klient.global.sessions.get(sessionId)).toEqual(beforeSummary);
      if (!cold) {
        expect(context.workDir).toBe(cwd);
        expect(context.additionalDirs).toEqual([a]);
        expect(context.resolve('file.txt')).toBe(join(cwd, 'file.txt'));
        expect(context.isWithin(join(b, 'file.txt'))).toBe(false);
      }
    }
    await c.send(method, { sessionId, cwd, mcpServers: [], additionalDirectories: [a] });
    const restored = manager.get(sessionId)!.accessor.get(ISessionWorkspaceContext);
    expect(restored.workDir).toBe(cwd);
    expect(restored.additionalDirs).toEqual([a]);
  }, 30_000);

  it.each(['session/new', 'session/fork'])(
    '%s rejects relative directory inputs without creating a session', async (method) => {
      const c = await boot();
      const { sessionId } = await c.send('session/new', {
        cwd: homeDir, mcpServers: [],
      }) as { sessionId: string };
      await c.waitForSessionUpdate('available_commands_update', 10_000);
      const before = await c.server.klient.global.sessions.list({});
      for (const invalid of [
        { cwd: 'relative', additionalDirectories: [] },
        { cwd: '', additionalDirectories: [] },
        { cwd: homeDir, additionalDirectories: [homeDir, '../extra'] },
        { cwd: homeDir, additionalDirectories: [''] },
      ]) {
        await expect(c.send(method, { sessionId, mcpServers: [], ...invalid }))
          .rejects.toThrow(/-32602/);
        expect(await c.server.klient.global.sessions.list({})).toEqual(before);
      }
    }, 30_000,
  );

  it.each(['session/load', 'session/resume'])(
    '%s replaces request roots on hot and cold sessions without changing siblings',
    async (method) => {
      const c = await boot();
      const cwd = join(homeDir!, 'primary');
      const a = join(homeDir!, 'root-a');
      const b = join(homeDir!, 'root-b');
      await Promise.all([cwd, a, b].map((dir) => mkdir(dir)));
      const create = async (additionalDirectories?: string[]) =>
        (await c.send('session/new', { cwd, mcpServers: [], additionalDirectories })) as {
          sessionId: string;
        };
      const first = await create([a]);
      const sibling = await create([b]);
      const empty = await create();
      const context = (id: string) =>
        c.server.core.accessor.get(ISessionManager).get(id)!.accessor.get(ISessionWorkspaceContext);
      const assertRoots = (id: string, roots: string[]) => {
        expect(context(id).workDir).toBe(cwd);
        expect(context(id).resolve('relative.txt')).toBe(join(cwd, 'relative.txt'));
        expect(context(id).additionalDirs).toEqual(roots);
        expect(context(id).isWithin(join(a, 'file.txt'))).toBe(roots.includes(a));
        expect(context(id).isWithin(join(b, 'file.txt'))).toBe(roots.includes(b));
      };
      assertRoots(first.sessionId, [a]);
      assertRoots(sibling.sessionId, [b]);
      assertRoots(empty.sessionId, []);
      const lease = await c.server.core.accessor
        .get(IWorkspaceInstanceManager).acquire({ root: cwd });
      workspaceLeases.push(lease);
      const workspace = lease.instance;
      expect(workspace.program.dirs.additionalDirs).toEqual([]);

      for (const cold of [false, true]) {
        for (const roots of [[a], [b], [], [a], undefined]) {
          if (cold) await c.send('session/close', { sessionId: first.sessionId });
          await c.send(method, {
            sessionId: first.sessionId, cwd, mcpServers: [], additionalDirectories: roots,
          });
          assertRoots(first.sessionId, roots ?? []);
          assertRoots(sibling.sessionId, [b]);
          assertRoots(empty.sessionId, []);
          expect(workspace.program.dirs.additionalDirs).toEqual([]);
        }
      }
    },
    30_000,
  );

  it('preserves persisted native directories through all ACP lifecycle paths', async () => {
    const c = await boot();
    const cwd = join(homeDir!, 'primary');
    const native = join(homeDir!, 'native');
    const requested = join(homeDir!, 'requested');
    await Promise.all([cwd, native, requested].map((dir) => mkdir(dir)));
    const lease = await c.server.core.accessor
      .get(IWorkspaceInstanceManager).acquire({ root: cwd });
    workspaceLeases.push(lease);
    const workspace = lease.instance;
    const configPath = join(cwd, '.kimi-code', 'local.toml');
    const originalConfig = '[workspace]\nadditional_dir = ["../native"]\n';
    await mkdir(join(cwd, '.kimi-code'));
    await writeFile(configPath, originalConfig);
    await workspace.program.dirs.reload();
    const created = await c.send('session/new', {
      cwd, mcpServers: [], additionalDirectories: [requested],
    }) as { sessionId: string };
    const roots = (id: string) =>
      c.server.core.accessor.get(ISessionManager).get(id)!.accessor
        .get(ISessionWorkspaceContext).additionalDirs;
    expect(roots(created.sessionId)).toEqual([native, requested]);
    await c.send('session/load', {
      sessionId: created.sessionId, cwd, mcpServers: [], additionalDirectories: [],
    });
    expect(roots(created.sessionId)).toEqual([native]);
    await c.send('session/resume', {
      sessionId: created.sessionId, cwd, mcpServers: [], additionalDirectories: [requested],
    });
    const forked = await c.send('session/fork', {
      sessionId: created.sessionId, cwd, mcpServers: [],
    }) as { sessionId: string };
    expect(roots(forked.sessionId)).toEqual([native]);
    expect(roots(created.sessionId)).toEqual([native, requested]);
    await c.send('session/resume', { sessionId: created.sessionId, cwd, mcpServers: [] });
    expect(roots(created.sessionId)).toEqual([native]);
    expect(await readFile(configPath, 'utf8')).toBe(originalConfig);
  }, 30_000);

  it('session/fork applies only the target roots and cwd to each independent child', async () => {
    const c = await boot();
    const cwd = join(homeDir!, 'primary');
    const target = join(homeDir!, 'fork-primary');
    const a = join(homeDir!, 'root-a');
    const b = join(homeDir!, 'root-b');
    await Promise.all([cwd, target, a, b].map((dir) => mkdir(dir)));
    const source = (await c.send('session/new', {
      cwd, mcpServers: [], additionalDirectories: [a],
    })) as { sessionId: string };
    const context = (id: string) =>
      c.server.core.accessor.get(ISessionManager).get(id)!.accessor.get(ISessionWorkspaceContext);
    const children: string[] = [];
    for (const roots of [[b], [], undefined]) {
      const fork = (await c.send('session/fork', {
        sessionId: source.sessionId, cwd: target, mcpServers: [], additionalDirectories: roots,
      })) as { sessionId: string };
      expect(fork.sessionId).not.toBe(source.sessionId);
      expect(children).not.toContain(fork.sessionId);
      children.push(fork.sessionId);
      expect(context(fork.sessionId).workDir).toBe(target);
      expect(context(fork.sessionId).resolve('relative.txt')).toBe(join(target, 'relative.txt'));
      expect(context(fork.sessionId).additionalDirs).toEqual(roots ?? []);
      expect(context(source.sessionId).workDir).toBe(cwd);
      expect(context(source.sessionId).additionalDirs).toEqual([a]);
    }
    await c.send('session/resume', {
      sessionId: children[0], cwd: target, mcpServers: [], additionalDirectories: [a],
    });
    expect(context(children[0]!).additionalDirs).toEqual([a]);
    expect(context(children[1]!).additionalDirs).toEqual([]);
    expect(context(source.sessionId).additionalDirs).toEqual([a]);
    await c.send('session/resume', {
      sessionId: source.sessionId, cwd, mcpServers: [], additionalDirectories: [b],
    });
    expect(context(children[0]!).additionalDirs).toEqual([a]);
    expect(context(source.sessionId).additionalDirs).toEqual([b]);
  }, 30_000);

  it(
    'a title change pushes session_info_update',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.waitForSessionUpdate('available_commands_update', 10_000);

      await c.server.klient.session(created.sessionId).setTitle('Renamed Session');

      const notification = await c.waitForSessionUpdate('session_info_update', 10_000);
      const update = (notification.params as { update?: { title?: string | null } }).update;
      expect(update?.title).toBe('Renamed Session');
    },
    30_000,
  );

  it(
    'logout drops the token and the auth gate closes again',
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'acp-logout-'));
      await writeFile(join(homeDir, 'config.toml'), OAUTH_PROVIDER_CONFIG, 'utf8');
      const toolkit = createFakeOAuthToolkit();
      client = await createTestClient({
        homeDir,
        disableAuth: false,
        extraSeeds: [toolkit.seed],
      });
      const c = client;
      await c.send('initialize', { protocolVersion: 1, clientCapabilities: {} });

      await expect
        .poll(
          async () => (await c.server.klient.global.auth.summarize()).some((s) => s.loggedIn),
          { timeout: 10_000 },
        )
        .toBe(true);

      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      expect(created.sessionId).toMatch(/^session_/);

      await c.send('logout', {});
      expect(toolkit.hasToken()).toBe(false);

      await expect
        .poll(
          async () => (await c.server.klient.global.auth.summarize()).some((s) => s.loggedIn),
          { timeout: 10_000 },
        )
        .toBe(false);
      await expect(c.send('session/new', { cwd: homeDir, mcpServers: [] })).rejects.toThrow(
        /[Aa]uthentication required/,
      );
    },
    30_000,
  );

  it(
    'apiKey-only config passes the auth gate without any OAuth provider',
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'acp-apikey-gate-'));
      await writeFakeModelConfig(homeDir);
      client = await createTestClient({ homeDir, disableAuth: false });
      const c = client;
      await c.send('initialize', { protocolVersion: 1, clientCapabilities: {} });

      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      expect(created.sessionId).toMatch(/^session_/);
    },
    30_000,
  );

  it(
    'session/list filters by cwd when the client supplies one',
    async () => {
      const c = await boot();
      const otherDir = join(homeDir!, 'other-root');
      await mkdir(otherDir, { recursive: true });
      const first = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      const second = (await c.send('session/new', { cwd: otherDir, mcpServers: [] })) as {
        sessionId: string;
      };

      const filtered = (await c.send('session/list', { cwd: homeDir })) as {
        sessions: { sessionId: string; cwd: string }[];
      };
      const ids = filtered.sessions.map((s) => s.sessionId);
      expect(ids).toContain(first.sessionId);
      expect(ids).not.toContain(second.sessionId);

      const unfiltered = (await c.send('session/list', {})) as {
        sessions: { sessionId: string }[];
      };
      const allIds = unfiltered.sessions.map((s) => s.sessionId);
      expect(allIds).toContain(first.sessionId);
      expect(allIds).toContain(second.sessionId);
    },
    30_000,
  );
});

describe('filterSessionSummariesByCwd', () => {
  const summary = (id: string, cwd?: string): SessionSummary => ({
    id,
    workspaceId: `ws-${id}`,
    cwd,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  });

  it('returns every session when no cwd filter is supplied', () => {
    const items = [summary('a', '/x'), summary('b'), summary('c', '/y')];
    expect(filterSessionSummariesByCwd(items, undefined)).toBe(items);
  });

  it('keeps cwd-less legacy sessions under an explicit filter', () => {
    const items = [summary('a', '/x'), summary('b'), summary('c', '/y')];
    expect(filterSessionSummariesByCwd(items, '/x').map((s) => s.id)).toEqual(['a', 'b']);
    expect(filterSessionSummariesByCwd(items, '/y').map((s) => s.id)).toEqual(['b', 'c']);
  });
});
