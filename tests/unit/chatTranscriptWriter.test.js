'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
	ChatTranscriptWriter,
	resolveTranscriptPath,
	sanitizeRecord,
} = require('../../app/chatTranscript/writer');

describe('ChatTranscriptWriter', () => {
	it('resolves default output under userData chat-transcripts', () => {
		assert.strictEqual(
			resolveTranscriptPath('/tmp/teams-user-data', ''),
			path.join('/tmp/teams-user-data', 'chat-transcripts', 'teams.jsonl')
		);
	});

	it('preserves absolute configured output paths', () => {
		assert.strictEqual(
			resolveTranscriptPath('/tmp/teams-user-data', '/tmp/custom/teams.jsonl'),
			'/tmp/custom/teams.jsonl'
		);
	});

	it('sanitizes records into the Megathread Tamer JSONL contract', () => {
		const record = sanitizeRecord({
			conversation: {
				key: 'https://teams.cloud.microsoft/l/chat/19:abc',
				title: 'ULTX Builds & Test',
				url: 'https://teams.cloud.microsoft/l/chat/19:abc',
			},
			message: {
				id: 'msg-1',
				author: 'Kevin Barrett',
				text: 'The watcher needs this message.',
				timestamp: '2026-06-04T08:00:00Z',
				is_self: true,
			},
			captured_at: '2026-06-04T08:00:01Z',
		});

		assert.deepStrictEqual(record, {
			type: 'chat-message',
			source: 'teams',
			conversation: {
				key: 'https://teams.cloud.microsoft/l/chat/19:abc',
				title: 'ULTX Builds & Test',
				url: 'https://teams.cloud.microsoft/l/chat/19:abc',
			},
			message: {
				id: 'msg-1',
				author: 'Kevin Barrett',
				text: 'The watcher needs this message.',
				timestamp: '2026-06-04T08:00:00Z',
				is_self: true,
			},
			captured_at: '2026-06-04T08:00:01Z',
		});
	});

	it('appends sanitized JSONL records and skips empty messages', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-transcript-writer-'));
		const outputPath = path.join(tmpDir, 'nested', 'teams.jsonl');
		const writer = new ChatTranscriptWriter({ outputPath });

		const result = await writer.append([
			{
				conversation: { title: 'General', url: 'https://teams.cloud.microsoft/' },
				message: { id: 'msg-1', author: 'Alice', text: 'A real message.' },
				captured_at: '2026-06-04T08:00:01Z',
			},
			{
				conversation: { title: 'General' },
				message: { id: 'msg-empty', author: 'Bob', text: '   ' },
			},
		]);

		assert.strictEqual(result.written, 1);
		const lines = (await fs.readFile(outputPath, 'utf8')).trim().split('\n');
		assert.strictEqual(lines.length, 1);
		const parsed = JSON.parse(lines[0]);
		assert.strictEqual(parsed.type, 'chat-message');
		assert.strictEqual(parsed.source, 'teams');
		assert.strictEqual(parsed.message.text, 'A real message.');
	});
});
