package com.aiasist.assistant.ai

import com.aiasist.assistant.data.SettingsRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Thin client over the Anthropic Messages API (`POST /v1/messages`) with a tool-use loop.
 *
 * The loop runs on the same model within a turn, so the full assistant `content` array — including
 * thinking blocks — is appended back verbatim ("preserved thinking"). Tools are executed by the
 * caller-provided [toolExecutor]; forced tool choice is avoided (it returns 400 on the 5.x models),
 * so we rely on `tool_choice: auto` plus the system prompt.
 */
class ClaudeClient(private val settings: SettingsRepository) {

    /** Executes one tool call and returns a (success, humanMessage) pair for the tool_result. */
    fun interface ToolExecutor {
        fun execute(toolName: String, input: JSONObject): Pair<Boolean, String>
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .callTimeout(120, TimeUnit.SECONDS)
        .build()

    /** Conversation history (user / assistant turns) kept across voice requests. */
    private val messages = JSONArray()

    fun resetConversation() {
        // JSONArray has no clear() across all API levels; rebuild by removing from the end.
        while (messages.length() > 0) messages.remove(messages.length() - 1)
    }

    /**
     * Sends [userText], running the tool loop until Claude produces a final answer.
     * Returns the text to speak. Throws [ClaudeException] on API/transport errors.
     */
    suspend fun send(userText: String, toolExecutor: ToolExecutor): String = withContext(Dispatchers.IO) {
        val apiKey = settings.apiKey
        if (apiKey.isBlank()) throw ClaudeException("Не задан ключ API.")

        messages.put(JSONObject().put("role", "user").put("content", userText))

        repeat(MAX_TOOL_ITERATIONS) {
            val response = callApi(apiKey)

            val stopReason = response.optString("stop_reason")
            if (stopReason == "refusal") {
                val content = response.optJSONArray("content")
                messages.put(JSONObject().put("role", "assistant").put("content", content ?: JSONArray()))
                return@withContext "Извините, я не могу выполнить этот запрос."
            }

            val content = response.optJSONArray("content") ?: JSONArray()
            // Preserve the assistant turn verbatim (keeps thinking blocks valid for the next request).
            messages.put(JSONObject().put("role", "assistant").put("content", content))

            val toolUses = ArrayList<JSONObject>()
            val textParts = StringBuilder()
            for (i in 0 until content.length()) {
                val block = content.getJSONObject(i)
                when (block.optString("type")) {
                    "text" -> textParts.append(block.optString("text"))
                    "tool_use" -> toolUses.add(block)
                }
            }

            if (stopReason != "tool_use" || toolUses.isEmpty()) {
                return@withContext textParts.toString().trim()
                    .ifBlank { "Готово." }
            }

            // Execute every tool call and return all results in one user message.
            val toolResults = JSONArray()
            for (tu in toolUses) {
                val name = tu.optString("name")
                val input = tu.optJSONObject("input") ?: JSONObject()
                val (ok, message) = toolExecutor.execute(name, input)
                val result = JSONObject()
                    .put("type", "tool_result")
                    .put("tool_use_id", tu.optString("id"))
                    .put("content", message)
                if (!ok) result.put("is_error", true)
                toolResults.put(result)
            }
            messages.put(JSONObject().put("role", "user").put("content", toolResults))
            // next iteration: Claude reads results and either calls more tools or answers.
        }
        // Tool loop exhausted without a final text answer.
        "Слишком много шагов подряд, останавливаюсь."
    }

    private fun callApi(apiKey: String): JSONObject {
        val body = JSONObject().apply {
            put("model", settings.model)
            put("max_tokens", 2048)
            put("system", SYSTEM_PROMPT)
            put("messages", messages)
            put("tools", Tools.definitions())
            // Lower effort trims latency/cost on the 5.x models. Haiku rejects output_config.effort.
            if (!settings.model.contains("haiku")) {
                put("output_config", JSONObject().put("effort", "low"))
            }
        }

        val request = Request.Builder()
            .url(ENDPOINT)
            .addHeader("x-api-key", apiKey)
            .addHeader("anthropic-version", ANTHROPIC_VERSION)
            .addHeader("content-type", "application/json")
            .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        val raw = try {
            http.newCall(request).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    throw ClaudeException(parseApiError(text, resp.code))
                }
                text
            }
        } catch (e: IOException) {
            throw ClaudeException("Нет связи с сервером Claude: ${e.message ?: "сеть недоступна"}")
        }

        return JSONObject(raw)
    }

    private fun parseApiError(body: String, code: Int): String = try {
        val err = JSONObject(body).optJSONObject("error")
        val msg = err?.optString("message").orEmpty()
        when (code) {
            401 -> "Неверный ключ API (401). Проверьте ключ в настройках."
            429 -> "Превышен лимит запросов (429). Попробуйте позже."
            else -> if (msg.isNotBlank()) "Ошибка API ($code): $msg" else "Ошибка API ($code)."
        }
    } catch (e: Exception) {
        "Ошибка API ($code)."
    }

    class ClaudeException(message: String) : Exception(message)

    companion object {
        private const val ENDPOINT = "https://api.anthropic.com/v1/messages"
        private const val ANTHROPIC_VERSION = "2023-06-01"
        private const val MAX_TOOL_ITERATIONS = 6
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        private val SYSTEM_PROMPT = """
            Ты — голосовой помощник на телефоне пользователя, по имени «Ассистент».
            Общайся на русском языке, если пользователь не перешёл на другой язык.

            Правила:
            • Отвечай коротко и по делу — ответ будет озвучен вслух, поэтому без длинных списков,
              разметки, ссылок и смайликов. Одно-два предложения в большинстве случаев.
            • Для действий с телефоном используй доступные инструменты (звонки, SMS, будильник,
              таймер, календарь, навигация, фонарик, громкость, открытие приложений и сайтов, поиск,
              состояние устройства). Не придумывай, что действие выполнено, если не вызвал инструмент.
            • Если для действия не хватает данных (например, номер или время), коротко переспроси.
            • После успешного действия дай краткое подтверждение голосом.
            • Если инструмент вернул ошибку или просьбу выдать разрешение — спокойно объясни это
              пользователю простыми словами.
            • На обычные вопросы (факты, счёт, перевод, советы) отвечай сам, без инструментов.
        """.trimIndent()
    }
}
