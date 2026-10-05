package com.aiasist.assistant.ai

import org.json.JSONObject

/** Executes one tool call and returns a (success, humanMessage) pair for the tool result. */
fun interface ToolExecutor {
    fun execute(toolName: String, input: JSONObject): Pair<Boolean, String>
}

/**
 * A chat backend that runs a tool-use loop and returns the final text to speak.
 * Implemented by [ClaudeClient] (Anthropic Messages API) and [OpenAiClient] (OpenAI-compatible,
 * e.g. OpenRouter).
 */
interface AssistantBackend {
    suspend fun send(userText: String, toolExecutor: ToolExecutor): String
    fun resetConversation()
}

/** Thrown for API/transport errors; its message is surfaced to the user. */
class BackendException(message: String) : Exception(message)
