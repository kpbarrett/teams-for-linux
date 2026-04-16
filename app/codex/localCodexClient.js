class LocalCodexClient {
  constructor(config = {}) {
    this.enabled = config.enabled === true;
    this.endpoint = config.endpoint || "http://127.0.0.1:8765/ask";
    this.apiKey = config.apiKey || "";
    this.timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 15000;
    this.maxQuestionLength = Number(config.maxQuestionLength) > 0 ? Number(config.maxQuestionLength) : 4000;
    this.maxContextLength = Number(config.maxContextLength) > 0 ? Number(config.maxContextLength) : 20000;
  }

  validatePayload({ question, context }) {
    if (typeof question !== "string" || question.trim().length === 0) {
      throw new Error("Question must be a non-empty string");
    }

    if (question.length > this.maxQuestionLength) {
      throw new Error("Question exceeds maximum allowed length");
    }

    if (context !== undefined && typeof context !== "string") {
      throw new Error("Context must be a string");
    }

    if (typeof context === "string" && context.length > this.maxContextLength) {
      throw new Error("Context exceeds maximum allowed length");
    }
  }

  async ask({ question, context = "", requestId = null, conversationId = null }) {
    if (!this.enabled) {
      throw new Error("Local Codex client is disabled");
    }

    this.validatePayload({ question, context });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          question,
          context,
          requestId,
          conversationId,
        }),
      });

      if (!response.ok) {
        throw new Error(`Local Codex endpoint returned status ${response.status}`);
      }

      const payload = await response.json();
      if (!payload || typeof payload.answer !== "string") {
        throw new Error("Local Codex endpoint returned invalid payload");
      }

      return {
        answer: payload.answer,
        conversationId: payload.conversationId || conversationId || null,
        model: payload.model || null,
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Local Codex request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

module.exports = LocalCodexClient;
