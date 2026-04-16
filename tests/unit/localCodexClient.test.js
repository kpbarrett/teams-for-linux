'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const LocalCodexClient = require('../../app/codex/localCodexClient');

describe('LocalCodexClient', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws when disabled', async () => {
    const client = new LocalCodexClient({ enabled: false });

    await assert.rejects(
      client.ask({ question: 'Hello' }),
      /disabled/
    );
  });

  it('sends payload to local endpoint and returns answer', async () => {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.strictEqual(body.question, 'What changed?');
      assert.strictEqual(body.context, 'Previous message context');

      return {
        ok: true,
        json: async () => ({
          answer: 'Here is the summary.',
          conversationId: 'conv-1',
          model: 'local-codex',
        }),
      };
    };

    const client = new LocalCodexClient({ enabled: true, endpoint: 'http://127.0.0.1:8765/ask' });
    const result = await client.ask({
      question: 'What changed?',
      context: 'Previous message context',
      requestId: 'req-1',
      conversationId: 'conv-1',
    });

    assert.strictEqual(result.answer, 'Here is the summary.');
    assert.strictEqual(result.conversationId, 'conv-1');
    assert.strictEqual(result.model, 'local-codex');
  });

  it('rejects invalid response payload', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ invalid: true }),
    });

    const client = new LocalCodexClient({ enabled: true });

    await assert.rejects(
      client.ask({ question: 'Hello' }),
      /invalid payload/
    );
  });

  it('rejects non-empty question requirement', async () => {
    const client = new LocalCodexClient({ enabled: true });

    await assert.rejects(
      client.ask({ question: '   ' }),
      /non-empty/
    );
  });

  it('rejects context exceeding configured limit', async () => {
    const client = new LocalCodexClient({ enabled: true, maxContextLength: 4 });

    await assert.rejects(
      client.ask({ question: 'Hello', context: '12345' }),
      /maximum allowed length|exceeds/
    );
  });
});
