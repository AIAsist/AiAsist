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
 * Backend for OpenAI-compatible chat APIs — here, OpenRouter
 * (`POST https://openrouter.ai/api/v1/chat/completions`).
 *
 * Differences from [ClaudeClient]: Bearer auth, `messages` with a leading `system` entry, and the
 * OpenAI tool-calling shape (`tools[].function`, assistant `tool_calls`, and `role:"tool"` results
 * whose `arguments` arrive as a JSON string). The device tools are the same catalogue, converted
 * to the function schema on the fly.
 */
class OpenAiClient(private val settings: SettingsRepository) : AssistantBackend {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .callTimeout(120, TimeUnit.SECONDS)
        .build()

    private val messages = JSONArray()

    override fun resetConversation() {
        while (messages.length() > 0) messages.remove(messages.length() - 1)
    }

    override suspend fun send(userText: String, toolExecutor: ToolExecutor): String =
        withContext(Dispatchers.IO) {
            val apiKey = settings.openRouterKey
            if (apiKey.isBlank()) throw BackendException("Не задан ключ OpenRouter.")

            if (messages.length() == 0) {
                messages.put(JSONObject().put("role", "system").put("content", SYSTEM_PROMPT))
            }
            messages.put(JSONObject().put("role", "user").put("content", userText))

            repeat(MAX_TOOL_ITERATIONS) {
                val response = callApi(apiKey)
                val choice = response.optJSONArray("choices")?.optJSONObject(0)
                    ?: throw BackendException("Пустой ответ от OpenRouter.")
                val message = choice.optJSONObject("message") ?: JSONObject()

                // Append the assistant turn verbatim (keeps tool_calls intact for the next request).
                messages.put(message)

                val toolCalls = message.optJSONArray("tool_calls")
                if (toolCalls == null || toolCalls.length() == 0) {
                    return@withContext message.optString("content").trim().ifBlank { "Готово." }
                }

                for (i in 0 until toolCalls.length()) {
                    val call = toolCalls.getJSONObject(i)
                    val fn = call.optJSONObject("function") ?: JSONObject()
                    val name = fn.optString("name")
                    val args = parseArgs(fn.optString("arguments"))
                    val (_, resultMessage) = toolExecutor.execute(name, args)
                    messages.put(
                        JSONObject()
                            .put("role", "tool")
                            .put("tool_call_id", call.optString("id"))
                            .put("content", resultMessage),
                    )
                }
                // loop again so the model can read tool results and answer.
            }
            "Слишком много шагов подряд, останавливаюсь."
        }

    private fun callApi(apiKey: String): JSONObject {
        val body = JSONObject()
            .put("model", settings.openRouterModel)
            .put("messages", messages)
            .put("tools", openAiTools())
            .put("tool_choice", "auto")

        val request = Request.Builder()
            .url(ENDPOINT)
            .addHeader("Authorization", "Bearer $apiKey")
            .addHeader("Content-Type", "application/json")
            // Optional attribution headers recommended by OpenRouter.
            .addHeader("HTTP-Referer", "https://github.com/AIAsist/AiAsist")
            .addHeader("X-Title", "AiAsist")
            .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        val raw = try {
            http.newCall(request).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw BackendException(parseApiError(text, resp.code))
                text
            }
        } catch (e: IOException) {
            throw BackendException("Нет связи с OpenRouter: ${e.message ?: "сеть недоступна"}")
        }
        return JSONObject(raw)
    }

    private fun parseArgs(arguments: String): JSONObject = try {
        if (arguments.isBlank()) JSONObject() else JSONObject(arguments)
    } catch (e: Exception) {
        JSONObject()
    }

    /** Converts the Anthropic-style tool catalogue into OpenAI `function` tools. */
    private fun openAiTools(): JSONArray {
        val src = Tools.definitions()
        val out = JSONArray()
        for (i in 0 until src.length()) {
            val t = src.getJSONObject(i)
            val function = JSONObject()
                .put("name", t.optString("name"))
                .put("description", t.optString("description"))
                .put("parameters", t.optJSONObject("input_schema") ?: JSONObject())
            out.put(JSONObject().put("type", "function").put("function", function))
        }
        return out
    }

    private fun parseApiError(body: String, code: Int): String = try {
        val err = JSONObject(body).optJSONObject("error")
        val msg = err?.optString("message").orEmpty()
        when (code) {
            401 -> "Неверный ключ OpenRouter (401). Проверьте ключ в настройках."
            402 -> "Недостаточно средств на OpenRouter (402)."
            404 -> "Модель не найдена (404). Проверьте имя модели в настройках."
            429 -> "Превышен лимит запросов (429). Попробуйте позже."
            else -> if (msg.isNotBlank()) "Ошибка OpenRouter ($code): $msg" else "Ошибка OpenRouter ($code)."
        }
    } catch (e: Exception) {
        "Ошибка OpenRouter ($code)."
    }

    companion object {
        private const val ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
        private const val MAX_TOOL_ITERATIONS = 6
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        private val SYSTEM_PROMPT = """
            Ты — голосовой помощник на телефоне пользователя по имени «Ассистент».
            Общайся на русском языке, если пользователь не перешёл на другой язык.
            Отвечай коротко — ответ озвучивается вслух: без разметки, списков, ссылок и смайликов,
            обычно одно-два предложения.
            Для действий с телефоном вызывай доступные инструменты (звонки, SMS, будильник, таймер,
            календарь, навигация, фонарик, громкость, открытие приложений и сайтов, поиск, состояние
            устройства). Не утверждай, что действие выполнено, если не вызвал инструмент.
            Если данных не хватает (номер, время) — коротко переспроси. После действия дай краткое
            голосовое подтверждение. На обычные вопросы отвечай сам, без инструментов.
        """.trimIndent()
    }
}
