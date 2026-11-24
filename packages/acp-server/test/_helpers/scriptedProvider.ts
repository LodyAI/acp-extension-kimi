import {
  IProtocolAdapterRegistry,
  type IProtocolAdapterRegistry as IProtocolAdapterRegistryType,
  type Model,
  ProtocolAdapterRegistry,
} from '@moonshot-ai/agent-core-v2';
import type { Message, StreamedMessagePart } from '@moonshot-ai/core/llm/message';
import type { FinishReason } from '@moonshot-ai/core/llm/response';
import type { TokenUsage } from '@moonshot-ai/core/llm/usage';

import {
  createMockProvider,
  withMockProvider,
  type MockProviderResponse,
} from '../../../agent-core-v2/test/harness/scripted-generate.js';

export interface ScriptedProvider {
  readonly seed: readonly [typeof IProtocolAdapterRegistry, IProtocolAdapterRegistryType];
  mockNextText(text: string): void;
  mockNextResponse(...parts: StreamedMessagePart[]): void;
  mockNextProviderResponse(response: {
    readonly beforeResponse?: () => Promise<void>;
    readonly usage?: TokenUsage;
    readonly parts?: readonly StreamedMessagePart[];
    readonly finishReason?: FinishReason | null;
    readonly rawFinishReason?: string | null;
  }): void;
  systemPrompts(): readonly string[];
  callCount(): number;
  callHistory(): ReadonlyArray<readonly Message[]>;
}

export function createScriptedProvider(): ScriptedProvider {
  const systemPrompts: string[] = [];
  const queue: (MockProviderResponse & { beforeResponse?: () => Promise<void> })[] = [];
  const calls: Array<readonly Message[]> = [];
  const provider = createMockProvider(async (request, signal) => {
    signal.throwIfAborted();
    const response = queue.shift();
    if (response === undefined) {
      throw new Error(
        `scriptedProvider: unexpected generate() call #${String(calls.length + 1)} — ` +
          'queue exhausted. Push another response via mockNextResponse().',
      );
    }
    calls.push(structuredClone(request.content.messages));
    systemPrompts.push(request.profile?.systemPrompt ?? '');
    await response.beforeResponse?.();
    return {
      ...response,
      id: response.id ?? `scripted-${String(calls.length)}`,
      usage: response.usage ?? {
        inputOther: 0,
        output: response.parts?.length ?? 0,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    };
  });
  const real = new ProtocolAdapterRegistry();
  const registry: IProtocolAdapterRegistryType = {
    _serviceBrand: undefined,
    supportedProtocols: () => real.supportedProtocols(),
    resolveAdapterIdentity: real.resolveAdapterIdentity.bind(real),
    resolveProviderBaseId: real.resolveProviderBaseId.bind(real),
    resolveCapability: real.resolveCapability.bind(real),
    request: (model: Model) => withMockProvider(real.request(model), provider),
  };

  return {
    seed: [IProtocolAdapterRegistry, registry],
    mockNextText: (text) => {
      queue.push({ parts: [{ type: 'text', text }] });
    },
    mockNextResponse: (...parts) => {
      queue.push({ parts: structuredClone(parts) });
    },
    mockNextProviderResponse: (response) => {
      queue.push({ ...response, parts: structuredClone(response.parts ?? []) });
    },
    systemPrompts: () => systemPrompts,
    callCount: () => calls.length,
    callHistory: () => calls,
  };
}
