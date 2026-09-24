import { describe, expect, it, vi } from 'vitest';
import { discoverModelContext } from '../src/settings/model-context.js';

const input = { baseUrl: 'https://gateway.example/v1', model: 'large-model', apiKey: 'private-key' };
const response = (data: unknown) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));

describe('Model context discovery', () => {
  it('reads only the exact model and respects a smaller provider limit', async () => {
    const fetcher = response({
      data: [
        { id: 'other-model', context_length: 8192 },
        { id: input.model, context_length: 1000000, top_provider: { context_length: 500000 } },
      ],
    });
    expect(await discoverModelContext(input, fetcher)).toEqual({ contextWindowTokens: 500000, source: 'provider' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://gateway.example/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer private-key' },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each(['context_window', 'context_window_tokens', 'max_model_len'])('accepts %s metadata', async (field) => {
    expect(await discoverModelContext(input, response({ data: [{ id: input.model, [field]: 65536 }] }))).toEqual({
      contextWindowTokens: 65536,
      source: 'provider',
    });
  });

  it.each([undefined, 0, -1, '1000000', 1.5, 9000000])(
    'does not guess capacity from invalid metadata %s',
    async (capacity) => {
      expect(
        await discoverModelContext(input, response({ data: [{ id: input.model, context_length: capacity }] })),
      ).toEqual({ contextWindowTokens: null, source: null });
    },
  );

  it('uses verified DeepSeek capacity only for the official endpoint and supported model IDs', async () => {
    const fetcher = response({ data: [{ id: 'deepseek-v4-flash' }] });
    expect(
      await discoverModelContext(
        { ...input, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
        fetcher,
      ),
    ).toEqual({ contextWindowTokens: 1048576, source: 'official' });
    for (const baseUrl of ['https://api.deepseek.com.evil.example', 'https://api.deepseek.com/proxy', input.baseUrl]) {
      expect(await discoverModelContext({ ...input, baseUrl, model: 'deepseek-v4-flash' }, fetcher)).toEqual({
        contextWindowTokens: null,
        source: null,
      });
    }
  });

  it('returns no capacity on failed or malformed discovery without exposing provider errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-key'));
    expect(await discoverModelContext(input, fetcher)).toEqual({ contextWindowTokens: null, source: null });
    expect(await discoverModelContext(input, response({ error: 'private-key' }))).toEqual({
      contextWindowTokens: null,
      source: null,
    });
  });
});
