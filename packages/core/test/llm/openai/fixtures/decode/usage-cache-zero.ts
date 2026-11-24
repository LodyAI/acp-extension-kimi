import type { OpenAIDecodeFixture } from '../types';

const usage = {
  prompt_tokens: 120,
  completion_tokens: 30,
  completion_tokens_details: { reasoning_tokens: 12 },
  prompt_tokens_details: { cached_tokens: 0 },
};

export default {
  name: 'usage-cache-zero',
  chunks: [{ choices: [], usage }],
  expected: [{
    type: 'usage',
    usage: {
      inputOther: 120,
      output: 30,
      reasoningOutput: 12,
      inputCacheRead: 0,
      inputCacheCreation: 0,
      raw: usage,
    },
  }],
  replay: {
    response: { choices: [], usage },
  },
} satisfies OpenAIDecodeFixture;
