'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { _test } = require('../../app/browser/tools/chatTranscript');

function fakeElement({
	text,
	attributes = {},
	id = '',
	className = '',
	matches = false,
	timeDatetime = '',
} = {}) {
	return {
		innerText: text,
		textContent: text,
		id,
		className,
		getAttribute(name) {
			return attributes[name] ?? '';
		},
		matches() {
			return matches;
		},
		querySelector(selector) {
			if (selector.includes('datetime') && timeDatetime) {
				return {
					getAttribute(name) {
						return name === 'datetime' ? timeDatetime : '';
					},
				};
			}
			return null;
		},
	};
}

function withLocationAndDocument({ href, title }, callback) {
	const previousLocation = global.location;
	const previousDocument = global.document;
	global.location = { href };
	global.document = { title };
	try {
		return callback();
	} finally {
		global.location = previousLocation;
		global.document = previousDocument;
	}
}

describe('chatTranscript browser extractor', () => {
	it('normalizes Teams message text', () => {
		assert.strictEqual(_test.normalizeText('  hello\u200b\u00a0world\n'), 'hello world');
	});

	it('extracts a Megathread Tamer-compatible record from a message element', () => {
		const element = fakeElement({
			text: 'Alice\nToday 8:00 AM\nThe Node API route needs a fix.',
			attributes: {
				'data-tid': 'chat-pane-message',
				'aria-label': 'Alice said The Node API route needs a fix.',
			},
			timeDatetime: '2026-06-04T08:00:00Z',
		});

		const record = withLocationAndDocument({
			href: 'https://teams.cloud.microsoft/l/chat/19:abc',
			title: 'ULTX Builds & Test | Microsoft Teams',
		}, () => _test.extractMessageFromElement(element, undefined, '2026-06-04T08:00:01Z'));

		assert.strictEqual(record.type, 'chat-message');
		assert.strictEqual(record.source, 'teams');
		assert.strictEqual(record.conversation.title, 'ULTX Builds & Test');
		assert.strictEqual(record.conversation.url, 'https://teams.cloud.microsoft/l/chat/19:abc');
		assert.strictEqual(record.message.author, 'Alice');
		assert.strictEqual(record.message.text, 'The Node API route needs a fix.');
		assert.strictEqual(record.message.timestamp, '2026-06-04T08:00:00Z');
		assert.strictEqual(record.captured_at, '2026-06-04T08:00:01Z');
	});

	it('deduplicates records by extracted message id during a scan', () => {
		const element = fakeElement({
			text: 'Alice\nThe same message.',
			attributes: { 'data-tid': 'chat-pane-message' },
		});
		const root = {
			querySelectorAll() {
				return [element, element];
			},
		};

		const records = withLocationAndDocument({
			href: 'https://teams.cloud.microsoft/l/chat/19:abc',
			title: 'General | Microsoft Teams',
		}, () => _test.extractTranscriptRecords(root, new Date('2026-06-04T08:00:01Z')));

		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].message.text, 'The same message.');
	});
});
