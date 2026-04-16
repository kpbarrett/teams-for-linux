'use strict';

const LocalCodexClient = require('../../codex/localCodexClient');

const LOG_PREFIX = '[CODEX_CHAT]';
const DEFAULT_SCAN_INTERVAL_MS = 1000;
const REPLY_SEND_TIMEOUT_MS = 5000;
const PROGRAMMATIC_SEND_SUPPRESSION_MS = 1000;
const DEFAULT_REPLY_PREFIX = 'says:';

function emitDebugLog(level, message, data) {
	if (globalThis.electronAPI?.send) {
		try {
			globalThis.electronAPI.send('codex-chat-debug-log', {
				level,
				message,
				data,
				timestamp: Date.now(),
			});
		} catch (error) {
			console.debug(`${LOG_PREFIX} Failed to forward debug log: ${error.message}`);
		}
	}
}

function debug(message, data) {
	console.info(`${LOG_PREFIX} ${message}`, data ?? '');
	emitDebugLog('info', message, data);
}

function warn(message, data) {
	console.warn(`${LOG_PREFIX} ${message}`, data ?? '');
	emitDebugLog('warn', message, data);
}

function error(message, data) {
	console.error(`${LOG_PREFIX} ${message}`, data ?? '');
	emitDebugLog('error', message, data);
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
	return String(value ?? '')
		.replace(/\u200b/g, '')
		.replace(/\u00a0/g, ' ')
		.replace(/\r\n/g, '\n')
		.trim();
}

function normalizeComposerText(value) {
	return String(value ?? '')
		.replace(/\u200b/g, '')
		.replace(/\r\n/g, '\n')
		.replace(/\n+/g, '\n')
		.trim();
}

function titleCase(value) {
	return String(value ?? '')
		.trim()
		.replace(/[_-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.split(' ')
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join(' ');
}

function formatQuotedReply(botLabel, answer, replyPrefix = DEFAULT_REPLY_PREFIX) {
	const normalizedAnswer = normalizeText(answer);
	if (!normalizedAnswer) {
		return '';
	}

	const quotedLines = normalizedAnswer
		.split('\n')
		.map((line) => `> ${line}`);

	return `${botLabel} ${replyPrefix}\n\n${quotedLines.join('\n')}`;
}

function resolveEditableElement(target) {
	if (!target || typeof target !== 'object') {
		return null;
	}

	if (target.matches?.('textarea, input, [contenteditable="true"]')) {
		return target;
	}

	return target.closest?.('textarea, input, [contenteditable="true"]') || null;
}

function extractBotMentionTrigger(message, client) {
	const normalizedMessage = normalizeText(message);
	if (!normalizedMessage || !client) {
		return null;
	}

	const mentions = client.extractMentions(normalizedMessage);
	if (mentions.length === 0) {
		return null;
	}

	const addressedAs = mentions.find((mention) => client.botAliases.has(mention));
	if (!addressedAs) {
		return null;
	}

	const mentionPattern = new RegExp(`@${escapeRegExp(addressedAs)}\\b`, 'ig');
	const normalizedQuestion = normalizeComposerText(
		normalizedMessage.replace(mentionPattern, '').replace(/\u00a0/g, ' ').trim()
	);

	if (!normalizedQuestion) {
		return null;
	}

	return {
		addressedAs,
		normalizedQuestion,
	};
}

class CodexChatMentions {
	#client = null;
	#initialized = false;
	#listenerBound = false;
	#domObserver = null;
	#scanTimer = null;
	#pendingReplies = new Map();
	#suppressionUntil = 0;
	#lastComposer = null;
	#lastChatHref = '';
	#lastTriggerSignature = '';
	#lastTriggerAt = 0;
	#replyPrefix = DEFAULT_REPLY_PREFIX;

	init(config) {
		if (this.#initialized) {
			return;
		}

		const codexConfig = config?.codex;
		if (!codexConfig?.enabled) {
			return;
		}

		if (codexConfig.chat?.enabled === false) {
			console.info(`${LOG_PREFIX} Direct chat mentions disabled in config`);
			return;
		}

		this.#client = new LocalCodexClient(codexConfig);
		this.#replyPrefix = codexConfig.chat?.replyPrefix || DEFAULT_REPLY_PREFIX;
		this.#initialized = true;
		this.#lastChatHref = globalThis.location?.href || '';
		debug('Initialized config', {
			botName: this.#client.botName,
			aliases: Array.from(this.#client.botAliases),
			replyPrefix: this.#replyPrefix,
		});

		const start = () => {
			debug('Starting listeners and observers', {
				href: globalThis.location?.href || '',
				readyState: document.readyState,
			});
			this.#installListeners();
			this.#startDomObserver();
			this.#scheduleScan();
			debug(`Initialized for bot "${this.#client.botName}"`);
		};

		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', start, { once: true });
		} else {
			start();
		}
	}

	#installListeners() {
		if (this.#listenerBound) {
			return;
		}

		document.addEventListener('keydown', (event) => this.#handleKeydown(event), true);
		document.addEventListener('click', (event) => this.#handleClick(event), true);
		document.addEventListener('focusin', (event) => this.#handleFocusIn(event), true);
		window.addEventListener('beforeunload', () => this.#cleanup());

		this.#listenerBound = true;
	}

	#startDomObserver() {
		if (!globalThis.MutationObserver || this.#domObserver) {
			debug('MutationObserver unavailable or already installed');
			return;
		}

		this.#domObserver = new MutationObserver(() => this.#scheduleScan());
		this.#domObserver.observe(document.documentElement, {
			childList: true,
			subtree: true,
		});
		debug('MutationObserver installed');
	}

	#cleanup() {
		if (this.#scanTimer) {
			clearTimeout(this.#scanTimer);
			this.#scanTimer = null;
		}

		if (this.#domObserver) {
			this.#domObserver.disconnect();
			this.#domObserver = null;
		}
	}

	#scheduleScan() {
		if (this.#scanTimer) {
			clearTimeout(this.#scanTimer);
		}

		this.#scanTimer = setTimeout(() => {
			this.#scanTimer = null;
			this.#refreshLastComposer();
		}, DEFAULT_SCAN_INTERVAL_MS);
	}

	#refreshLastComposer() {
		const composer = this.#findLikelyComposer();
		if (composer) {
			this.#lastComposer = composer;
		}
	}

	#handleFocusIn(event) {
		const composer = resolveEditableElement(event.target);
		if (!this.#isLikelyComposer(composer)) {
			return;
		}

		this.#lastComposer = composer;
		this.#lastChatHref = globalThis.location?.href || this.#lastChatHref;
		debug('Composer focused', this.#describeElement(composer));
	}

	#handleKeydown(event) {
		if (this.#isSuppressed()) {
			return;
		}

		if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey) {
			return;
		}

		const composer = resolveEditableElement(event.target);
		if (!this.#isLikelyComposer(composer)) {
			return;
		}

		this.#lastComposer = composer;
		debug('Enter pressed in composer', {
			...this.#describeElement(composer),
			textLength: this.#getComposerText(composer).length,
		});
		this.#handlePotentialTrigger(composer, event);
	}

	#handleClick(event) {
		if (this.#isSuppressed()) {
			return;
		}

		const button = event.target?.closest?.('button');
		if (!button || !this.#isSendButton(button)) {
			return;
		}

		const composer = this.#lastComposer || this.#findLikelyComposer();
		if (!this.#isLikelyComposer(composer)) {
			return;
		}

		debug('Send button clicked', {
			...this.#describeElement(button),
			composer: this.#describeElement(composer),
		});
		this.#handlePotentialTrigger(composer, event);
	}

	#handlePotentialTrigger(composer, event) {
		const rawText = this.#getComposerText(composer);
		const trigger = extractBotMentionTrigger(rawText, this.#client);
		if (!trigger) {
			debug('No bot mention found in composer text', {
				href: globalThis.location?.href || '',
				composer: this.#describeElement(composer),
				textPreview: normalizeComposerText(rawText).slice(0, 120),
			});
			return;
		}

		const chatHref = globalThis.location?.href || '';
		const signature = `${chatHref}::${trigger.addressedAs}::${trigger.normalizedQuestion}`;
		const now = Date.now();

		if (this.#lastTriggerSignature === signature && now - this.#lastTriggerAt < 1000) {
			return;
		}

		this.#lastTriggerSignature = signature;
		this.#lastTriggerAt = now;
		this.#lastChatHref = chatHref;
		debug('Bot mention detected', {
			addressedAs: trigger.addressedAs,
			questionPreview: trigger.normalizedQuestion.slice(0, 200),
			chatHref,
		});

		const replyTask = this.#sendReplyAfterCodex(trigger, {
			chatHref,
			originalComposerText: rawText,
		});

		this.#pendingReplies.set(signature, replyTask);
		replyTask.finally(() => {
			this.#pendingReplies.delete(signature);
		});
	}

	async #sendReplyAfterCodex(trigger, { chatHref, originalComposerText }) {
		try {
			const result = await this.#client.ask({
				question: trigger.normalizedQuestion,
				context: '',
			});

			if (result.ignored || !result.answer) {
				debug('Codex request ignored or returned no answer', {
					ignored: result.ignored,
					reason: result.reason,
				});
				return;
			}

			if ((globalThis.location?.href || '') !== chatHref) {
				warn('Chat changed before reply was ready, skipping send', { chatHref });
				return;
			}

			const replyBody = formatQuotedReply(
				titleCase(this.#client.botName) || this.#client.botName,
				result.answer,
				this.#replyPrefix
			);

			if (!replyBody) {
				debug('Codex answer was empty after formatting, skipping reply');
				return;
			}

			const ready = await this.#waitForComposerReadiness(originalComposerText, chatHref);
			if (!ready) {
				warn('Composer was not ready for reply send', {
					chatHref,
					originalComposerText: normalizeComposerText(originalComposerText).slice(0, 200),
				});
				return;
			}

			debug('Codex response ready for send', {
				answerPreview: result.answer.slice(0, 200),
				replyPreview: replyBody.slice(0, 200),
			});
			await this.#postReply(replyBody);
		} catch (err) {
			error('Failed to process mention', { message: err.message, stack: err.stack });
		}
	}

	async #waitForComposerReadiness(originalComposerText, chatHref) {
		const deadline = Date.now() + REPLY_SEND_TIMEOUT_MS;
		const originalNormalized = normalizeComposerText(originalComposerText);

		while (Date.now() < deadline) {
			if ((globalThis.location?.href || '') !== chatHref) {
				return false;
			}

			const composer = this.#findLikelyComposer();
			if (composer) {
				const currentText = normalizeComposerText(this.#getComposerText(composer));
				if (!currentText || currentText === originalNormalized) {
					return true;
				}

				if (currentText !== originalNormalized) {
					return false;
				}
			}

			await new Promise((resolve) => setTimeout(resolve, 150));
		}

		return false;
	}

	async #postReply(replyBody) {
		const composer = this.#findLikelyComposer() || this.#lastComposer;
		if (!this.#isLikelyComposer(composer)) {
			warn('No composer available for reply');
			return;
		}

		if ((globalThis.location?.href || '') !== this.#lastChatHref) {
			warn('Chat changed before reply send, skipping', { chatHref: this.#lastChatHref });
			return;
		}

		this.#setSuppression(true);

		try {
			debug('Writing reply into composer', {
				composer: this.#describeElement(composer),
				replyLength: replyBody.length,
			});
			this.#setComposerText(composer, replyBody);
			await new Promise((resolve) => setTimeout(resolve, 75));

			const sendButton = this.#findSendButton(composer);
			if (sendButton && !sendButton.disabled) {
				debug('Clicking send button', this.#describeElement(sendButton));
				sendButton.click();
			} else {
				debug('Falling back to Enter key send');
				this.#dispatchEnter(composer);
			}

			await new Promise((resolve) => setTimeout(resolve, 100));
			const remainingText = normalizeComposerText(this.#getComposerText(composer));
			if (remainingText === normalizeComposerText(replyBody)) {
				debug('Reply text still present after send attempt, dispatching Enter fallback');
				this.#dispatchEnter(composer);
			}
		} finally {
			setTimeout(() => this.#setSuppression(false), PROGRAMMATIC_SEND_SUPPRESSION_MS);
		}
	}

	#dispatchEnter(composer) {
		const options = {
			bubbles: true,
			cancelable: true,
			key: 'Enter',
			code: 'Enter',
			keyCode: 13,
			which: 13,
		};

		composer.dispatchEvent(new KeyboardEvent('keydown', options));
		composer.dispatchEvent(new KeyboardEvent('keyup', options));
	}

	#setSuppression(enabled) {
		this.#suppressionUntil = enabled ? Date.now() + PROGRAMMATIC_SEND_SUPPRESSION_MS : 0;
	}

	#isSuppressed() {
		return Date.now() < this.#suppressionUntil;
	}

	#getComposerText(composer) {
		if (!composer) {
			return '';
		}

		if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
			return composer.value || '';
		}

		if (composer.isContentEditable) {
			return composer.innerText || composer.textContent || '';
		}

		return composer.textContent || '';
	}

	#setComposerText(composer, value) {
		const text = String(value ?? '');

		composer.focus?.();

		if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
			const proto = Object.getPrototypeOf(composer);
			const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
				|| Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
				|| Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

			if (setter) {
				setter.call(composer, text);
			} else {
				composer.value = text;
			}

			composer.dispatchEvent(new Event('input', { bubbles: true }));
			composer.dispatchEvent(new Event('change', { bubbles: true }));
			return;
		}

		if (composer.isContentEditable) {
			composer.textContent = text;
			composer.dispatchEvent(new InputEvent('input', {
				bubbles: true,
				cancelable: true,
				inputType: 'insertText',
				data: text,
			}));
			return;
		}

		composer.textContent = text;
		composer.dispatchEvent(new Event('input', { bubbles: true }));
	}

	#findSendButton(composer) {
		const scope = composer?.closest?.('form, [role="dialog"], [data-tid]') || document;
		const candidates = scope.querySelectorAll?.('button') || [];

		for (const button of candidates) {
			if (this.#isSendButton(button)) {
				return button;
			}
		}

		return null;
	}

	#isSendButton(element) {
		if (!element || element.tagName !== 'BUTTON') {
			return false;
		}

		const label = [
			element.getAttribute('aria-label'),
			element.getAttribute('title'),
			element.textContent,
			element.dataset?.tid,
		]
			.filter(Boolean)
			.join(' ')
			.toLowerCase();

		return label.includes('send');
	}

	#findLikelyComposer() {
		const candidates = document.querySelectorAll('textarea, input[role="textbox"], [contenteditable="true"]');
		debug('Scanning for composer candidates', { count: candidates.length });
		for (const candidate of candidates) {
			if (this.#isLikelyComposer(candidate)) {
				debug('Composer candidate selected', this.#describeElement(candidate));
				return candidate;
			}
		}

		debug('No composer candidate matched');
		return null;
	}

	#isLikelyComposer(element) {
		if (!element || !resolveEditableElement(element)) {
			return false;
		}

		if (element.disabled || element.readOnly) {
			return false;
		}

		if (!this.#isVisible(element)) {
			return false;
		}

		const label = [
			element.getAttribute?.('aria-label'),
			element.getAttribute?.('placeholder'),
			element.getAttribute?.('title'),
			element.getAttribute?.('data-placeholder'),
		]
			.filter(Boolean)
			.join(' ')
			.toLowerCase();

		if (label.includes('message') || label.includes('compose') || label.includes('chat') || label.includes('type')) {
			return true;
		}

		if (this.#findSendButton(element)) {
			return true;
		}

		if (element.isContentEditable) {
			const rect = element.getBoundingClientRect?.();
			return !!rect && rect.width > 40 && rect.height > 20;
		}

		return false;
	}

	#isVisible(element) {
		const style = globalThis.getComputedStyle?.(element);
		if (!style) {
			return true;
		}

		return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
	}

	#describeElement(element) {
		if (!element) {
			return null;
		}

		return {
			tagName: element.tagName || null,
			role: element.getAttribute?.('role') || null,
			ariaLabel: element.getAttribute?.('aria-label') || null,
			placeholder: element.getAttribute?.('placeholder') || null,
			title: element.getAttribute?.('title') || null,
			dataTid: element.dataset?.tid || null,
			isContentEditable: !!element.isContentEditable,
		};
	}
}

const codexChatMentions = new CodexChatMentions();

module.exports = codexChatMentions;
module.exports.formatQuotedReply = formatQuotedReply;
module.exports.normalizeText = normalizeText;
module.exports.normalizeComposerText = normalizeComposerText;
module.exports.titleCase = titleCase;
module.exports.escapeRegExp = escapeRegExp;
module.exports.extractBotMentionTrigger = extractBotMentionTrigger;
