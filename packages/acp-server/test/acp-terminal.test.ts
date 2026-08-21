import { describe, expect, it, vi } from 'vitest';

import type {
  IHostEnvironment,
  Runtime,
  RuntimeProviderHost,
} from '@moonshot-ai/agent-core-v2';

import type { IAcpConnection, IAcpTerminalHandle } from '../src/acp-fs/acpConnection';
import { AcpHostFileSystem } from '../src/acp-fs/acpFsService';
import { AcpRuntimeProviderFactory } from '../src/acp-terminal/acpTerminalRunner';

function makeConnection(): IAcpConnection {
  return {
    _serviceBrand: undefined,
    bound: true,
    fsReadTextFile: true,
    fsWriteTextFile: true,
    terminalEnabled: true,
    bind: () => {},
    get: () => ({}) as never,
    bindFsCapabilities: () => {},
    bindTerminalCapability: () => {},
    notifyTerminalCreated: () => {},
    onTerminalCreated: () => () => {},
  };
}

function makeEnvironment(overrides: Partial<IHostEnvironment> = {}): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '24.0.0',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/Users/test',
    ready: Promise.resolve(),
    ...overrides,
  } as IHostEnvironment;
}

async function bindRuntime(
  environment: IHostEnvironment,
  connection: IAcpConnection = makeConnection(),
): Promise<Runtime> {
  const runtimes: Runtime[] = [];
  const host = {
    registerRuntime: (runtime: Runtime) => {
      runtimes.push(runtime);
      return { remove: async () => {} };
    },
  } as unknown as RuntimeProviderHost;
  const factory = new AcpRuntimeProviderFactory(connection, environment);
  await factory.attach({ id: 'w1' } as never, host);
  factory.bindSession('w1', 's1', '/repo');
  const runtime = runtimes[0];
  if (runtime === undefined) throw new Error('runtime was not registered');
  return runtime;
}

describe('AcpSessionRuntime', () => {
  it('mirrors the probed host environment and exposes fs + process capabilities', async () => {
    const runtime = await bindRuntime(makeEnvironment());

    expect([...runtime.capabilities].sort()).toEqual(['fs', 'process']);
    expect(runtime.environment).toMatchObject({
      osKind: 'macOS',
      osArch: 'arm64',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir: '/Users/test',
    });
    expect(runtime.fs).toBeInstanceOf(AcpHostFileSystem);
    expect(runtime.path.isAbsolute('/repo')).toBe(true);
  });

  it('adapts path semantics and shell to a win32 host environment', async () => {
    const runtime = await bindRuntime(
      makeEnvironment({
        osKind: 'Windows',
        osArch: 'x64',
        shellName: 'bash',
        shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
        pathClass: 'win32',
        homeDir: 'C:\\Users\\test',
      }),
    );

    expect(runtime.environment).toMatchObject({
      osKind: 'Windows',
      shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      pathClass: 'win32',
      homeDir: 'C:\\Users\\test',
    });
    expect(runtime.path.separator).toBe('\\');
    expect(runtime.path.isAbsolute('C:\\repo')).toBe(true);
    expect(runtime.path.isAbsolute('repo')).toBe(false);
    expect(runtime.path.resolve('C:\\repo', 'src')).toBe('C:\\repo\\src');
  });

  it('forwards non-Bash processes without attaching them to a Bash tool card', async () => {
    const handle: IAcpTerminalHandle = {
      id: 'term-rg',
      currentOutput: vi.fn(async () => ({ output: '', truncated: false })),
      waitForExit: vi.fn(
        () =>
          new Promise<{ readonly exitCode?: number | null; readonly signal?: string | null }>(
            () => {},
          ),
      ),
      kill: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const createTerminal = vi.fn(async () => handle);
    const notifyTerminalCreated = vi.fn();
    const connection: IAcpConnection = {
      ...makeConnection(),
      get: () => ({ createTerminal }) as never,
      notifyTerminalCreated,
    };
    const runtime = await bindRuntime(
      makeEnvironment({
        osKind: 'Windows',
        shellPath: 'C:\\Users\\test\\scoop\\apps\\git\\current\\bin\\bash.exe',
        pathClass: 'win32',
      }),
      connection,
    );
    const rgPath = 'C:\\Users\\test\\AppData\\Local\\kimi\\rg.exe';

    const process = await runtime.process!.spawn(rgPath, ['-c', 'printf should-not-attach'], {
      cwd: 'C:\\repo',
      env: { NO_COLOR: '1', TERM: 'dumb' },
    });

    expect(createTerminal).toHaveBeenCalledWith({
      sessionId: 's1',
      command: rgPath,
      args: ['-c', 'printf should-not-attach'],
      env: [
        { name: 'NO_COLOR', value: '1' },
        { name: 'TERM', value: 'dumb' },
      ],
      cwd: 'C:\\repo',
      outputByteLimit: 4 * 1024 * 1024,
    });
    expect(notifyTerminalCreated).not.toHaveBeenCalled();
    await process.dispose();
  });
});
