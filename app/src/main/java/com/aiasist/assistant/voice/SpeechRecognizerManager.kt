package com.aiasist.assistant.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.util.Locale

/**
 * Wraps the on-device [SpeechRecognizer] into a simple start/stop API with callbacks.
 * Speech-to-text runs through the system recognizer (Google app / OEM), so no audio leaves
 * the phone except via that service.
 */
class SpeechRecognizerManager(private val context: Context) {

    interface Callbacks {
        fun onReadyForSpeech() {}
        fun onPartialResult(text: String) {}
        fun onFinalResult(text: String)
        fun onError(message: String)
        fun onEndOfSpeech() {}
    }

    private var recognizer: SpeechRecognizer? = null
    private var callbacks: Callbacks? = null

    fun isAvailable(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    fun start(callbacks: Callbacks) {
        this.callbacks = callbacks
        if (!isAvailable()) {
            callbacks.onError("Распознавание речи недоступно на этом устройстве.")
            return
        }
        destroy() // ensure a clean recognizer per session
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(listener)
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }
        recognizer?.startListening(intent)
    }

    fun stop() {
        recognizer?.stopListening()
    }

    fun cancel() {
        recognizer?.cancel()
    }

    fun destroy() {
        recognizer?.destroy()
        recognizer = null
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            callbacks?.onReadyForSpeech()
        }

        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}

        override fun onEndOfSpeech() {
            callbacks?.onEndOfSpeech()
        }

        override fun onError(error: Int) {
            callbacks?.onError(errorText(error))
        }

        override fun onResults(results: Bundle?) {
            val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            val text = list?.firstOrNull().orEmpty()
            if (text.isBlank()) {
                callbacks?.onError("Не удалось распознать речь.")
            } else {
                callbacks?.onFinalResult(text)
            }
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val list = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            list?.firstOrNull()?.let { if (it.isNotBlank()) callbacks?.onPartialResult(it) }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun errorText(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "Ошибка записи звука."
        SpeechRecognizer.ERROR_CLIENT -> "Ошибка клиента распознавания."
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Нет разрешения на микрофон."
        SpeechRecognizer.ERROR_NETWORK -> "Ошибка сети при распознавании."
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Таймаут сети при распознавании."
        SpeechRecognizer.ERROR_NO_MATCH -> "Не расслышал. Повторите, пожалуйста."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Распознаватель занят, попробуйте ещё раз."
        SpeechRecognizer.ERROR_SERVER -> "Ошибка сервера распознавания."
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Я не услышал речь."
        else -> "Ошибка распознавания речи."
    }
}
