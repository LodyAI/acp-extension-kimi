import { Readable, Writable } from 'node:stream';

import {
  RequestError,
  ndJsonStream,
  type AgentConnection,
  type Stream,
} from '@agentclientprotocol/sdk';
import {
  bootstrap,
  drainLogCloses,
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  drainSessionMetadataWrites,
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentProfileService,
  ISessionAgentProfileCatalog,
  IAgentLoopService,
  IAgentEnvironmentOverlay,
  IAppendLogStore,
  ensureMainAgent,
  ISessionContext,
  ISessionManager,
  ISessionIndexMirror,
  logSeed,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  type Scope,
  type ScopeSeed,
  sessionMediaOriginalsDir,
  setSessionArchived,
} from '@moonshot-ai/agent-core-v2';
import type { Klient } from '@moonshot-ai/klient';
import { createKlient } from '@moonshot-ai/klient/memory';

import { acpClientFromContext } from './acp-client';
import { IAcpConnection } from './acp-fs';
import { AcpEnvironmentOverlay } from './acp-terminal';
import { currentAcpActivation } from './activation';
import { AcpServer, type AcpServerOptions, createAcpAgentApp } from './server';

export interface RunAcpServerOptions extends Omit<AcpServerOptions, 'setStoredArchive'> {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly extraSeeds?: ScopeSeed;
}

export interface RunningAcpServer {
  readonly core: Scope;
  readonly klient: Klient;
  readonly conn: AgentConnection;
  close(): Promise<void>;
}

function redirectConsoleToStderr(): void {
  const sink = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  };
  globalThis.console.log = sink;
  globalThis.console.info = sink;
  globalThis.console.warn = sink;
  globalThis.console.debug = sink;
}

export async function runAcpServerWithStream(
  stream: Stream,
  opts: RunAcpServerOptions = {},
): Promise<RunningAcpServer> {
  const homeDir = resolveKimiHome(opts.homeDir);
  const configPath = resolveConfigPath({ homeDir, configPath: opts.configPath });
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  const { app: core } = bootstrap(
    {
      homeDir,
      configPath,
      clientIdentity: {
        productName: opts.agentInfo?.name ?? 'kimi-code-acp',
        version: opts.agentInfo?.version ?? '0.0.0',
        platform: 'kimi_code_cli',
      },
    },
    [...logSeed(logging), ...(opts.extraSeeds ?? [])],
  );

  const lifecycle = core.accessor.get(ISessionManager);
  const onWillCreateSession = lifecycle.onWillCreateSession;
  if (onWillCreateSession === undefined)
    throw new Error('Session creation lifecycle is unavailable');
  const activationSubscription = onWillCreateSession((event) => {
    const activation = currentAcpActivation();
    if (activation === undefined) return;
    activation.close.push(() => lifecycle.close(event.sessionId));
    activation.subscriptions.push(
      event.onDidCreateScope((handle) => {
        const overlay = handle.accessor.get(IAgentEnvironmentOverlay);
        if (!(overlay instanceof AcpEnvironmentOverlay))
          throw new Error('ACP environment overlay is unavailable');
        overlay.attach();
        activation.subscriptions.push(
          handle.accessor
            .get(IAgentLifecycleService)
            .onDidCreateScope(({ context, handle: agent }) => {
              if (!activation.active || context.agentId !== 'main') return;
              const hold = agent.accessor.get(IAgentLoopService).tryAcquireQuiescence();
              if (hold === undefined)
                throw new Error('ACP activation could not pause restored work');
              activation.holds.push(hold);
            }),
        );
      }),
    );
  });

  const klient = createKlient({ scope: core });
  const acpConnection = core.accessor.get(IAcpConnection);

  let resolveServer!: (server: AcpServer) => void;

  const serverReady = new Promise<AcpServer>((resolve) => {
    resolveServer = resolve;
  });
  void serverReady.catch(() => {});
  const app = createAcpAgentApp(() => serverReady);
  const conn = app.connect(stream);
  const client = acpClientFromContext(conn.client);
  acpConnection.bind(client);
  const server = new AcpServer(client, klient, acpConnection, {
    setStoredArchive: async (sessionId, archived) => {
      const result = await setSessionArchived(core.accessor, sessionId, archived);
      if (result === 'not_found') throw RequestError.resourceNotFound(sessionId);
      await core.accessor.get(ISessionIndexMirror).drain();
    },
    agentInfo: opts.agentInfo,
    disableAuth: opts.disableAuth,
    terminalAuthEnv: opts.terminalAuthEnv,
    terminalAuthLegacyCommand: opts.terminalAuthLegacyCommand,
    slashCommands: opts.slashCommands,
    bindSessionEnvironment: async (sessionId, systemPrompt) => {
      const handle = getLiveSessionById(core.accessor, sessionId);
      if (handle === undefined) throw new Error(`session ${sessionId} is not live`);
      const overlay = handle.accessor.get(IAgentEnvironmentOverlay);
      if (!(overlay instanceof AcpEnvironmentOverlay))
        throw new Error('ACP environment overlay is unavailable');
      overlay.attach();
      const agentContext = await ensureMainAgent(handle);
      const agent = handle.accessor.get(IAgentLifecycleService).handleOf(agentContext.agentId)!;
      const profile = agent.accessor.get(IAgentProfileService);
      const loop = agent.accessor.get(IAgentLoopService);
      const catalog = handle.accessor.get(ISessionAgentProfileCatalog);
      await catalog.ready;
      const name = loop.data().profileName;
      const base = name === undefined ? catalog.getDefault() : catalog.get(name);
      if (base === undefined) throw new Error('The active agent profile is unavailable');
      const renderSystemPrompt: typeof base.renderSystemPrompt = (context) => {
        const rendered = base.renderSystemPrompt(context);
        return {
          ...rendered,
          text:
            systemPrompt === undefined
              ? rendered.text
              : systemPrompt.mode === 'override'
                ? systemPrompt.text
                : `${rendered.text}\n\n${systemPrompt.text}`,
        };
      };
      const changed = await profile.applyProfile({
        ...base,
        renderSystemPrompt,
        systemPrompt: (context) => renderSystemPrompt(context).text,
      });
      loop.update({
        systemPrompt: changed.systemPrompt,
        environmentDisclosure: changed.environmentDisclosure,
        agentsMdPaths: changed.agentsMdPaths,
      });
    },
    // Prompt-image compression persists originals into the session's own
    // media-originals dir (same resolution as kap-server's prompt route):
    // live session scope → `ISessionContext.sessionDir`. A session that is
    // not live in this process yields undefined → temp-dir fallback.
    resolveOriginalsDir: (sessionId) => {
      const handle = getLiveSessionById(core.accessor, sessionId);
      return handle === undefined
        ? undefined
        : sessionMediaOriginalsDir(handle.accessor.get(ISessionContext).sessionDir);
    },
  });
  resolveServer(server);

  let closePromise: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      activationSubscription.dispose();
      await klient.close();
      const appendLogStore = core.accessor.get(IAppendLogStore);
      try {
        await appendLogStore.flush();
      } catch {}
      await drainSessionMetadataWrites();
      await core.accessor.get(ISessionIndexMirror).drain();
      core.dispose();
      await appendLogStore.drainRetirements();
      await drainSessionIndexMirror();
      await drainQueryStoreDisposals();
      await drainSessionMetadataWrites();
      await drainLogCloses();
    })();
    return closePromise;
  };

  void conn.closed.then(() => {
    void close();
  });

  return { core, klient, conn, close };
}

export async function runAcpServer(opts: RunAcpServerOptions = {}): Promise<void> {
  redirectConsoleToStderr();
  const input = (opts.input ?? process.stdin) as Readable;
  const output = (opts.output ?? process.stdout) as Writable;
  const stream = ndJsonStream(Writable.toWeb(output), Readable.toWeb(input));
  const server = await runAcpServerWithStream(stream, opts);
  await server.conn.closed;
  await server.close();
}
