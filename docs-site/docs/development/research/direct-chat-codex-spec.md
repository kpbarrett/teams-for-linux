# Direct In-Chat Codex Mentions Spec

**Status:** Implemented in branch `feature/direct-in-chat-codex`
**Date:** 2026-04-16
**Scope:** Direct Teams chat mention handling for the local Codex assistant
**Goal:** Allow a user to mention the bot by name in a Teams chat, have teams-for-linux detect that mention, send the message to the local Codex backend, and post the reply back into the same chat as the signed-in user.

---

## Summary

This feature lets the user reference a bot name in a Teams conversation, for example `@routie`, and have the app respond in-chat instead of relying on MQTT or an external control channel.

The reply should be posted by the app as the active user, with a short intro and a quoted answer body:

```text
Fido says:

> Here is the answer...
> Continued lines stay quoted.
```

The feature is intentionally limited to explicit mentions to avoid replying to every message in a thread.

---

## User Story

As a Teams for Linux user, I want to mention my local bot by name in a chat message and receive a reply in the same conversation, so I can use the assistant without switching to MQTT or another side channel.

---

## Goals

- Detect explicit bot mentions in Teams chat messages.
- Normalize mention matching so `@routie`, `@ask-routie`, and configured aliases can all target the same bot.
- Send the message text to the existing local Codex backend service listening on `codex.endpoint`.
- Insert a reply into the same chat as the signed-in user.
- Format the reply with a visible intro line and a blockquote body.
- Avoid reply loops, duplicate sends, and accidental responses to unrelated messages.

---

## Non-Goals

- Replacing the existing MQTT command path.
- Auto-replying to every incoming message.
- Supporting remote bot services or cloud-hosted agent identities.
- Parsing arbitrary Teams message types beyond plain text mention-based triggers in the initial version.
- Building a conversation history UI.

---

## Proposed UX

### Trigger

The bot responds only when the current user types a message containing one of the configured aliases:

- `botName`
- `ask-${botName}`
- any value in `codex.aliases`

Example:

```text
@routie summarize my open PR comments
```

### Response Format

The response is posted into the same chat as a normal user message and should use this structure:

```text
Fido says:

> First line of answer
> Second line of answer
```

Formatting rules:

- The intro line must use the configured display name.
- The answer must be rendered as a Markdown blockquote.
- Blank lines in the answer should be preserved as separate quoted blank lines.
- If the answer is long, it should still render as a single message, not as multiple fragments.

### Example

Input:

```text
@routie what changed in the last release?
```

Output:

```text
Routie says:

> The last release focused on Electron 41 migration, cross-distro test hardening, and docs cleanup.
```

---

## Functional Requirements

### Mention Detection

- The app must detect messages containing a bot mention in the compose flow before send.
- Mentions are matched case-insensitively.
- Leading `@` characters are ignored during normalization.
- Alias matching uses the same normalization rules as the existing local Codex client.

### Message Handling

- When a matching mention is detected, the message should be forwarded to the local Codex backend.
- The mention token should be removed before sending the question upstream.
- The original message should still be sent to Teams if the assistant is not handling the send path directly.
- If the assistant is handling the send path directly, it must preserve the user’s typed content except for stripping the trigger mention from the prompt sent to Codex.

### Response Posting

- The reply must be sent into the current Teams thread or chat.
- The reply must be posted as the current signed-in user, using the existing Teams compose/send mechanics.
- The reply body should be prefixed with a short intro line using the bot display name.
- The reply body should be formatted as blockquote text so it is visually distinct from normal chat text.

### Loop Prevention

- The assistant must not respond to messages it posts itself.
- The assistant must not react to its own reply intro line.
- A reply posted by the assistant must not trigger another Codex request.
- If a message is detected as an assistant-generated reply marker, it must be ignored for trigger purposes.

### Failure Handling

- If the local Codex backend is unavailable, the app should fail gracefully and avoid posting an empty message.
- If the bot mention is present but the response times out, the user should receive a visible error state or a clearly logged failure.
- If Teams DOM structure changes and the message cannot be inserted safely, the feature should no-op rather than corrupt the chat composer.

---

## Configuration

The existing `codex` config object should remain the source of truth.

### Existing keys

```json
{
  "codex": {
    "enabled": true,
    "endpoint": "http://127.0.0.1:8765/ask",
    "apiKey": "",
    "botName": "routie",
    "aliases": ["ask-routie"],
    "timeoutMs": 15000,
    "maxQuestionLength": 4000,
    "maxContextLength": 20000
  }
}
```

### Optional future keys

If implementation needs a dedicated reply format toggle, it should be nested under `codex` and default to the behavior described here.

Recommended candidates:

- `codex.replyPrefix`
- `codex.replyFormat`
- `codex.replyAsUser`

These should only be added if the implementation needs them. The initial version should not introduce configuration churn unless required.

---

## Technical Design

### Current Reality

The current code only supports the MQTT-driven path:

- `app/codex/localCodexClient.js` validates mentions and calls the local HTTP endpoint.
- `app/index.js` initializes the local client when `config.codex.enabled` is true.
- `app/mqtt/index.js` delivers `ask-codex` commands.

That means the new feature needs a renderer-aware Teams integration path, not another backend transport.

### Proposed Architecture

1. Observe the Teams chat compose area and message list in the renderer.
2. Detect a send attempt that contains a configured bot mention.
3. Extract the message body and strip the mention token.
4. Call the existing local Codex client.
5. Format the returned answer into a reply payload.
6. Insert the formatted reply into the active Teams conversation and send it as the user.

### Integration Point

The feature should likely live beside the existing browser tooling in `app/browser/tools/`, with a dedicated helper for:

- finding the active compose surface,
- parsing mentions,
- inserting the reply,
- marking bot-originated messages so they are ignored on re-scan.

The main-process `LocalCodexClient` should stay focused on request/response behavior and not become coupled to DOM automation.

---

## Reply Formatting Rules

The final message body should be composed as:

```text
<Display Name> says:

> line 1
> line 2
> line 3
```

Rules:

- Use the configured bot display name as the intro label.
- Quote every non-empty line of the answer.
- Preserve paragraph breaks by inserting quoted blank lines.
- Escape or normalize markup that Teams would otherwise interpret incorrectly.
- Do not include the original mention token in the reply body.

If the answer is empty or whitespace-only, the assistant should not send a reply.

---

## Security and Privacy Considerations

- The feature only activates on explicit mentions, which reduces accidental data exposure.
- The assistant should not forward unrelated chat traffic to the local endpoint.
- The local endpoint remains `127.0.0.1` by default, so network exposure stays local unless the user changes it.
- Message text may contain sensitive content, so logs must avoid dumping full chat bodies unless debug logging is explicitly enabled.
- Reply insertion should be constrained to the active Teams window/session to avoid cross-chat leakage.

---

## Risks

### DOM Drift

Teams UI changes frequently. Any solution that targets the renderer DOM can break when Microsoft changes class names, contenteditable structure, or React component behavior.

### Reply Loops

If the assistant’s own response text is reprocessed as a new mention-bearing message, it can recurse. The implementation needs a robust origin marker or suppression rule.

### Message Duplication

Teams may re-render or virtualize message rows. Mention detection must be based on send intent, not only on the DOM message stream, or duplicates may appear.

### User Expectations

“Respond as me” can mean different things:

- post plain text into the chat composer and send it,
- simulate keyboard entry,
- or use a hidden automation channel.

This spec assumes the first workable approach: write the reply into the Teams composer and send it through the normal user flow so the message appears from the signed-in account.

---

## Acceptance Criteria

- Typing `@routie` in a Teams chat triggers the local Codex flow.
- The mention is recognized using the existing alias normalization rules.
- The bot reply is posted into the same conversation.
- The reply is visibly prefixed with `Routie says:`.
- The body is formatted as a blockquote.
- Messages without a matching bot mention are ignored.
- The assistant does not respond to its own generated replies.
- Failures do not crash the app or corrupt the compose surface.

---

## Open Questions

- Should the assistant intercept only sent messages, or also support reacting to messages after they arrive?
- Should a reply be posted in the same thread only, or also support channel/channel-reply flows?
- Should the intro label be configurable per user, or fixed to `<botName> says:`?
- Should the assistant support multiple aliases in one message and choose the first matching one?
- Should replies be truncated or chunked when the Codex answer is very long?
