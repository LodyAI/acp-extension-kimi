import { AsyncLocalStorage } from 'node:async_hooks';

interface AcpActivation {
  active: boolean;
  readonly subscriptions: Array<{ dispose(): void }>;
  readonly holds: Array<{ dispose(): void }>;
  readonly close: Array<() => Promise<void>>;
}

const activations = new AsyncLocalStorage<AcpActivation>();

export function currentAcpActivation(): AcpActivation | undefined {
  const activation = activations.getStore();
  return activation?.active ? activation : undefined;
}

export async function runAcpActivation<T>(operation: () => Promise<T>): Promise<T> {
  const activation: AcpActivation = { active: true, subscriptions: [], holds: [], close: [] };
  return activations.run(activation, async () => {
    try {
      const result = await operation();
      activation.active = false;
      for (const subscription of activation.subscriptions.toReversed()) subscription.dispose();
      for (const hold of activation.holds.toReversed()) hold.dispose();
      return result;
    } catch (error) {
      activation.active = false;
      for (const subscription of activation.subscriptions.toReversed()) subscription.dispose();
      await Promise.all(activation.close.map((close) => close()));
      for (const hold of activation.holds.toReversed()) hold.dispose();
      throw error;
    }
  });
}
