import type {
  EnvironmentLease,
  IHostProcess,
  IHostProcessService,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import { makeSessionContext } from '../../agent-core-v2/src/session/sessionContext/sessionContext';
import { fakeEnvironment } from '../../agent-core-v2/test/environment/stubs';
import type { IAcpConnection, IAcpTerminalHandle } from '../src/acp-fs/acpConnection';
import { AcpEnvironmentOverlay } from '../src/acp-terminal/acpTerminalRunner';

function makeConnection(
  options: { terminalEnabled?: boolean; createTerminal?: () => IAcpTerminalHandle } = {},
): IAcpConnection {
  return {
    _serviceBrand: undefined,
    bound: true,
    fsReadTextFile: true,
    fsWriteTextFile: true,
    terminalEnabled: options.terminalEnabled ?? true,
    bind: () => {},
    get: () => ({ createTerminal: async () => options.createTerminal?.() }) as never,
    bindFsCapabilities: () => {},
    bindTerminalCapability: () => {},
    notifyTerminalCreated: () => {},
    onTerminalCreated: () => () => {},
  };
}

function makeTerminalHandle(): IAcpTerminalHandle {
  return {
    id: 'term-1',
    currentOutput: async () => ({ output: '', truncated: false }),
    waitForExit: async () => ({ exitCode: 0 }),
    kill: async () => ({}),
    release: async () => ({}),
  };
}

function lease(environmentId: string, process: IHostProcessService): EnvironmentLease {
  return {
    environment: Object.assign(fakeEnvironment(environmentId, 'one'), { process }),
    track: <T>(resource: T): T => resource,
    dispose: () => {},
  };
}

const session = makeSessionContext({
  sessionId: 's1',
  workspaceId: 'workspace',
  sessionDir: '/session',
  sessionScope: 'sessions/s1',
  cwd: '/repo',
});

const bashEnv = { NO_COLOR: '1', TERM: 'dumb' };

describe('AcpEnvironmentOverlay', () => {
  it('routes local Bash-shaped spawns through the ACP terminal', async () => {
    let created = 0;
    const connection = makeConnection({
      createTerminal: () => {
        created += 1;
        return makeTerminalHandle();
      },
    });
    const local = { _serviceBrand: undefined, spawn: async () => ({}) as IHostProcess };
    const overlay = new AcpEnvironmentOverlay(session, connection);
    overlay.attach();
    const decorated = overlay.decorate(lease('local', local));

    expect(decorated.environment.identity.environmentId).toBe('local');
    await decorated.environment.process!.spawn('/bin/bash', ['-c', 'echo hi'], {
      env: { ...bashEnv },
    });
    expect(created).toBe(1);
  });

  it('forwards non-Bash spawns through ACP without executing locally', async () => {
    let created = 0;
    const calls: string[] = [];
    const local = {
      _serviceBrand: undefined,
      spawn: async (command: string) => {
        calls.push(command);
        return {} as IHostProcess;
      },
    };
    const overlay = new AcpEnvironmentOverlay(
      session,
      makeConnection({
        createTerminal: () => {
          created += 1;
          return makeTerminalHandle();
        },
      }),
    );
    overlay.attach();
    const decorated = overlay.decorate(lease('local', local));

    await decorated.environment.process!.spawn('rg', ['--files']);
    expect(calls).toEqual([]);
    expect(created).toBe(1);
  });

  it('preserves the local environment status getter', () => {
    const original = lease('local', {
      _serviceBrand: undefined,
      spawn: async () => ({}) as IHostProcess,
    });
    const overlay = new AcpEnvironmentOverlay(session, makeConnection());
    overlay.attach();
    const decorated = overlay.decorate(original);
    expect(decorated.environment.status).toBe('ready');
    expect(Object.getPrototypeOf(decorated.environment)).toBe(
      Object.getPrototypeOf(original.environment),
    );
  });

  it('rejects execution without the terminal capability', async () => {
    const process = { _serviceBrand: undefined, spawn: async () => ({}) as IHostProcess };
    const overlay = new AcpEnvironmentOverlay(session, makeConnection({ terminalEnabled: false }));
    overlay.attach();
    const decorated = overlay.decorate(lease('local', process));
    await expect(decorated.environment.process!.spawn('rg', ['--files'])).rejects.toThrow(
      'ACP terminal capability is unavailable',
    );
  });

  it('keeps remote process and environment identity unchanged', async () => {
    const process = { _serviceBrand: undefined, spawn: async () => ({}) as IHostProcess };
    const original = lease('test-remote', process);
    const overlay = new AcpEnvironmentOverlay(session, makeConnection());
    overlay.attach();
    const decorated = overlay.decorate(original);
    expect(decorated).toBe(original);
    expect(decorated.environment.identity.environmentId).toBe('test-remote');
  });
});
