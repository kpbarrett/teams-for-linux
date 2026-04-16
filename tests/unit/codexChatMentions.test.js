'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
	formatQuotedReply,
	titleCase,
	escapeRegExp,
	normalizeText,
	extractBotMentionTrigger,
} = require('../../app/browser/tools/codexChatMentions');

function createClient() {
	return {
		botAliases: new Set(['routie', 'ask-routie', 'helper']),
		extractMentions(message) {
			return [...String(message).matchAll(/@([a-zA-Z0-9_-]+)/g)]
				.map((match) => match[1].toLowerCase());
		},
	};
}

describe('Codex chat reply formatting', () => {
	it('formats quoted replies with an intro line', () => {
		const result = formatQuotedReply('Routie', 'Line one\nLine two');

		assert.strictEqual(result, 'Routie says:\n\n> Line one\n> Line two');
	});

	it('returns an empty string for empty answers', () => {
		assert.strictEqual(formatQuotedReply('Routie', '   '), '');
	});
});

describe('Codex chat helper functions', () => {
	it('title-cases bot names', () => {
		assert.strictEqual(titleCase('ask-routie'), 'Ask Routie');
		assert.strictEqual(titleCase('routie'), 'Routie');
	});

	it('escapes regular expression characters', () => {
		assert.strictEqual(escapeRegExp('ask-routie?'), 'ask-routie\\?');
	});

	it('normalizes zero-width and non-breaking spaces', () => {
		assert.strictEqual(normalizeText('  hello\u200b\u00a0world  '), 'hello world');
	});

	it('extracts matching bot mentions from message text', () => {
		const trigger = extractBotMentionTrigger('@ask-routie summarize my notes', createClient());

		assert.deepStrictEqual(trigger, {
			addressedAs: 'ask-routie',
			normalizedQuestion: 'summarize my notes',
		});
	});

	it('ignores messages without a matching alias', () => {
		assert.strictEqual(extractBotMentionTrigger('@other summarize my notes', createClient()), null);
	});
});
