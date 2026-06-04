'use strict';

const LOG_PREFIX = '[CHAT_TRANSCRIPT]';
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_MESSAGES_PER_SCAN = 80;
const MAX_TEXT_LENGTH = 4000;

function normalizeText(value) {
	return String(value ?? '')
		.replace(/\u200b/g, '')
		.replace(/\u00a0/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function hashString(value) {
	let hash = 5381;
	const text = String(value ?? '');
	for (let index = 0; index < text.length; index++) {
		hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
	}
	return (hash >>> 0).toString(36);
}

function extractConversation() {
	const href = globalThis.location?.href || '';
	const title = normalizeText((globalThis.document?.title || '').replace(/\s*\|\s*Microsoft Teams\s*$/i, ''));
	return {
		key: href,
		title: title || href || 'Teams conversation',
		url: href,
	};
}

function extractTimestamp(element) {
	const time = element.querySelector?.('time[datetime], [datetime]');
	const datetime = time?.getAttribute?.('datetime');
	if (datetime) {
		return datetime;
	}

	const labelled = element.getAttribute?.('aria-label') || '';
	const timestampMatch = labelled.match(/\b(?:today|yesterday|\w+day|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}:\d{2})[^\n,]*/i);
	return timestampMatch ? normalizeText(timestampMatch[0]) : '';
}

function inferAuthor(lines, element) {
	const aria = normalizeText(element.getAttribute?.('aria-label'));
	const ariaAuthor = aria.match(/^(.*?)(?: said| sent|,)/i)?.[1];
	if (ariaAuthor && ariaAuthor.length <= 120) {
		return ariaAuthor;
	}

	for (const line of lines.slice(0, 4)) {
		if (line.length > 0 && line.length <= 120 && !/\b(today|yesterday|\d{1,2}:\d{2}|edited|reactions?)\b/i.test(line)) {
			return line;
		}
	}

	return '';
}

function inferBody(lines, author) {
	const filtered = lines.filter((line) => {
		if (!line || line === author) {
			return false;
		}
		return !/^(?:today|yesterday)(?:\s+\d{1,2}:\d{2}\s*(?:am|pm)?)?$|^\d{1,2}:\d{2}\s*(?:am|pm)?$|^(edited|reply|react|more options|has context menu)$/i.test(line);
	});
	return normalizeText(filtered.join('\n')).slice(0, MAX_TEXT_LENGTH);
}

function isLikelyMessageElement(element) {
	const text = normalizeText(element.innerText || element.textContent || '');
	if (text.length < 2) {
		return false;
	}
	if (element.matches?.('textarea, input, [contenteditable="true"]')) {
		return false;
	}
	const marker = [
		element.getAttribute?.('data-tid'),
		element.getAttribute?.('data-testid'),
		element.getAttribute?.('id'),
		element.getAttribute?.('role'),
		element.className,
		element.getAttribute?.('aria-label'),
	].join(' ').toLowerCase();
	return /message|chat|listitem|item-wrap|conversation/.test(marker);
}

function candidateElements(root = globalThis.document) {
	const selectors = [
		'[data-tid*="message" i]',
		'[data-testid*="message" i]',
		'[id*="message" i]',
		'[role="listitem"]',
		'[class*="message" i]',
		'[class*="conversation" i]',
	].join(',');

	return Array.from(root.querySelectorAll?.(selectors) || [])
		.filter(isLikelyMessageElement);
}

function extractMessageFromElement(element, conversation = extractConversation(), capturedAt = new Date().toISOString()) {
	const rawText = String(element.innerText || element.textContent || '').trim();
	const lines = rawText
		.split(/\r?\n/)
		.map(normalizeText)
		.filter(Boolean);
	const author = inferAuthor(lines, element);
	const text = inferBody(lines, author);
	if (!text) {
		return null;
	}

	const timestamp = extractTimestamp(element);
	const idSource = [
		conversation.key,
		element.getAttribute?.('data-tid') || '',
		element.getAttribute?.('data-testid') || '',
		element.id || '',
		author,
		timestamp,
		text,
	].join('::');

	return {
		type: 'chat-message',
		source: 'teams',
		conversation,
		message: {
			id: hashString(idSource),
			author,
			text,
			timestamp,
			is_self: /\b(you|me)\b/i.test(author) || /self|own-message/i.test(String(element.className || '')),
		},
		captured_at: capturedAt,
	};
}

function extractTranscriptRecords(root = globalThis.document, now = new Date()) {
	const conversation = extractConversation();
	const capturedAt = now.toISOString();
	const seen = new Set();
	const records = [];

	for (const element of candidateElements(root)) {
		const record = extractMessageFromElement(element, conversation, capturedAt);
		if (!record || seen.has(record.message.id)) {
			continue;
		}
		seen.add(record.message.id);
		records.push(record);
	}

	return records;
}

class ChatTranscript {
	#initialized = false;
	#observer = null;
	#timer = null;
	#seenMessageIds = new Set();
	#ipcRenderer = null;
	#pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
	#maxMessagesPerScan = DEFAULT_MAX_MESSAGES_PER_SCAN;

	init(config, ipcRenderer) {
		if (this.#initialized) {
			return;
		}

		const transcriptConfig = config?.chatTranscript;
		if (!transcriptConfig?.enabled) {
			return;
		}
		if (!ipcRenderer?.invoke) {
			console.warn(`${LOG_PREFIX} IPC unavailable; transcript capture disabled`);
			return;
		}

		this.#ipcRenderer = ipcRenderer;
		this.#pollIntervalMs = Math.max(500, Number(transcriptConfig.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
		this.#maxMessagesPerScan = Math.max(1, Number(transcriptConfig.maxMessagesPerScan) || DEFAULT_MAX_MESSAGES_PER_SCAN);
		this.#initialized = true;

		const start = () => {
			this.#installObserver();
			this.#scheduleScan(250);
			console.info(`${LOG_PREFIX} Transcript capture enabled`);
		};

		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', start, { once: true });
		} else {
			start();
		}
	}

	#installObserver() {
		if (!globalThis.MutationObserver || this.#observer) {
			return;
		}
		this.#observer = new MutationObserver(() => this.#scheduleScan(500));
		this.#observer.observe(document.documentElement, { childList: true, subtree: true });
	}

	#scheduleScan(delayMs = this.#pollIntervalMs) {
		if (this.#timer) {
			return;
		}
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.#scan().catch((error) => {
				console.warn(`${LOG_PREFIX} Scan failed: ${error.message}`);
			}).finally(() => {
				if (this.#initialized) {
					this.#scheduleScan(this.#pollIntervalMs);
				}
			});
		}, delayMs);
	}

	async #scan() {
		const records = extractTranscriptRecords()
			.filter((record) => {
				if (this.#seenMessageIds.has(record.message.id)) {
					return false;
				}
				this.#seenMessageIds.add(record.message.id);
				return true;
			})
			.slice(0, this.#maxMessagesPerScan);

		if (!records.length) {
			return;
		}

		await this.#ipcRenderer.invoke('chat-transcript:append', records);
	}
}

const chatTranscript = new ChatTranscript();

module.exports = chatTranscript;
module.exports._test = {
	normalizeText,
	hashString,
	extractMessageFromElement,
	extractTranscriptRecords,
};
