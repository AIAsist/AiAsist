package com.aiasist.assistant.ui

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.aiasist.assistant.ai.AssistantBackend
import com.aiasist.assistant.ai.BackendException
import com.aiasist.assistant.ai.ClaudeClient
import com.aiasist.assistant.ai.OpenAiClient
import com.aiasist.assistant.data.SettingsRepository
import com.aiasist.assistant.device.DeviceActions
import com.aiasist.assistant.voice.SpeechRecognizerManager
import com.aiasist.assistant.voice.TextToSpeechManager
import kotlinx.coroutines.launch

enum class AssistantStatus { IDLE, LISTENING, THINKING, SPEAKING }

data class ChatMessage(val id: Long, val fromUser: Boolean, val text: String)

/**
 * Coordinates the full voice loop: microphone -> speech-to-text -> Claude (+ device tools) ->
 * text-to-speech. Exposes Compose-observable state for the UI.
 */
class AssistantViewModel(app: Application) : AndroidViewModel(app) {

    private val settings = SettingsRepository(app)
    private val deviceActions = DeviceActions(app.applicationContext)
    private val recognizer = SpeechRecognizerManager(app.applicationContext)
    private val tts = TextToSpeechManager(app.applicationContext)

    // Backends are created lazily and swapped when the provider changes in Settings.
    private val claude = ClaudeClient(settings)
    private val openRouter = OpenAiClient(settings)
    private var activeProvider = settings.provider

    private fun backend(): AssistantBackend =
        if (settings.provider == SettingsRepository.PROVIDER_OPENROUTER) openRouter else claude

    val messages = mutableStateListOf<ChatMessage>()

    var status by mutableStateOf(AssistantStatus.IDLE)
        private set

    var partialText by mutableStateOf("")
        private set

    private var nextId = 0L

    val speechAvailable: Boolean get() = recognizer.isAvailable()

    fun hasApiKey(): Boolean = settings.hasApiKey()

    /** Called by the mic button. Toggles listening / stops speaking / starts a new capture. */
    fun onMicToggle() {
        when (status) {
            AssistantStatus.LISTENING -> recognizer.stop()
            AssistantStatus.SPEAKING -> {
                tts.stop()
                status = AssistantStatus.IDLE
            }
            AssistantStatus.THINKING -> { /* ignore taps while a request is in flight */ }
            AssistantStatus.IDLE -> startListening()
        }
    }

    fun startListening() {
        if (status != AssistantStatus.IDLE) return
        partialText = ""
        status = AssistantStatus.LISTENING
        recognizer.start(object : SpeechRecognizerManager.Callbacks {
            override fun onPartialResult(text: String) {
                partialText = text
            }

            override fun onFinalResult(text: String) {
                partialText = ""
                handleUserText(text)
            }

            override fun onEndOfSpeech() {
                if (status == AssistantStatus.LISTENING) status = AssistantStatus.THINKING
            }

            override fun onError(message: String) {
                partialText = ""
                status = AssistantStatus.IDLE
                addAssistant(message)
                speak(message)
            }
        })
    }

    /** Lets the user type a request instead of speaking it. */
    fun submitTyped(text: String) {
        if (text.isBlank() || status == AssistantStatus.THINKING) return
        handleUserText(text.trim())
    }

    private fun handleUserText(text: String) {
        addUser(text)
        // If the provider changed in Settings, start the new backend's conversation fresh.
        if (settings.provider != activeProvider) {
            activeProvider = settings.provider
            claude.resetConversation()
            openRouter.resetConversation()
        }
        if (!settings.hasApiKey()) {
            val msg = if (settings.provider == SettingsRepository.PROVIDER_OPENROUTER)
                "Не задан ключ OpenRouter. Откройте настройки и вставьте ключ."
            else "Не задан ключ API. Откройте настройки и вставьте ключ Anthropic."
            addAssistant(msg)
            speak(msg)
            return
        }
        status = AssistantStatus.THINKING
        viewModelScope.launch {
            val reply = try {
                backend().send(text) { name, input ->
                    val result = deviceActions.execute(name, input)
                    result.success to result.message
                }
            } catch (e: BackendException) {
                e.message ?: "Произошла ошибка."
            } catch (e: Exception) {
                "Произошла ошибка: ${e.message ?: "неизвестно"}"
            }
            addAssistant(reply)
            speak(reply)
        }
    }

    private fun speak(text: String) {
        status = AssistantStatus.SPEAKING
        tts.speak(text) {
            status = AssistantStatus.IDLE
        }
    }

    fun newConversation() {
        claude.resetConversation()
        openRouter.resetConversation()
        messages.clear()
        partialText = ""
        status = AssistantStatus.IDLE
        tts.stop()
    }

    private fun addUser(text: String) {
        messages.add(ChatMessage(nextId++, fromUser = true, text = text))
    }

    private fun addAssistant(text: String) {
        messages.add(ChatMessage(nextId++, fromUser = false, text = text))
    }

    override fun onCleared() {
        recognizer.destroy()
        tts.shutdown()
        super.onCleared()
    }
}
