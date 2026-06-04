'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_RELATIVE_OUTPUT = path.join('chat-transcripts', 'teams.jsonl');
const MAX_RECORDS_PER_BATCH = 200;
const MAX_TEXT_LENGTH = 20000;

function normalizeString(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function resolveTranscriptPath(userDataPath, configuredPath = '') {
  const candidate = normalizeString(configuredPath, 4096);
  if (!candidate) {
    return path.join(userDataPath, DEFAULT_RELATIVE_OUTPUT);
  }
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.join(userDataPath, candidate);
}

function sanitizeRecord(record) {
  const conversation = record?.conversation && typeof record.conversation === 'object'
    ? record.conversation
    : {};
  const message = record?.message && typeof record.message === 'object'
    ? record.message
    : {};

  const text = normalizeString(message.text);
  if (!text) {
    return null;
  }

  const conversationKey = normalizeString(conversation.key || conversation.url || conversation.title, 4096);
  const messageId = normalizeString(message.id, 4096) || [
    conversationKey,
    normalizeString(message.author, 512),
    normalizeString(message.timestamp, 128),
    text
  ].join('::');

  return {
    type: 'chat-message',
    source: 'teams',
    conversation: {
      key: conversationKey,
      title: normalizeString(conversation.title, 512),
      url: normalizeString(conversation.url, 4096)
    },
    message: {
      id: messageId,
      author: normalizeString(message.author, 512),
      text,
      timestamp: normalizeString(message.timestamp, 128),
      is_self: Boolean(message.is_self)
    },
    captured_at: normalizeString(record?.captured_at, 128) || new Date().toISOString()
  };
}

class ChatTranscriptWriter {
  constructor({ outputPath }) {
    if (!outputPath) {
      throw new Error('ChatTranscriptWriter requires outputPath');
    }
    this.outputPath = outputPath;
  }

  async append(records) {
    const batch = Array.isArray(records) ? records.slice(0, MAX_RECORDS_PER_BATCH) : [];
    const sanitized = batch.map(sanitizeRecord).filter(Boolean);
    if (!sanitized.length) {
      return { written: 0, outputPath: this.outputPath };
    }

    await fs.mkdir(path.dirname(this.outputPath), { recursive: true });
    const lines = sanitized.map((record) => JSON.stringify(record)).join('\n') + '\n';
    await fs.appendFile(this.outputPath, lines, 'utf8');
    return { written: sanitized.length, outputPath: this.outputPath };
  }
}

module.exports = {
  ChatTranscriptWriter,
  resolveTranscriptPath,
  sanitizeRecord
};
