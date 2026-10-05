package com.aiasist.assistant.voice

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/**
 * Wraps Android [TextToSpeech] with a ready-state and spoken-completion callback.
 */
class TextToSpeechManager(
    context: Context,
    private val onReady: (Boolean) -> Unit = {},
) {

    private var tts: TextToSpeech? = null
    private var ready = false
    private var onDone: (() -> Unit)? = null

    init {
        tts = TextToSpeech(context.applicationContext) { status ->
            ready = status == TextToSpeech.SUCCESS
            if (ready) {
                val locale = Locale("ru")
                val res = tts?.setLanguage(locale)
                if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                    tts?.setLanguage(Locale.getDefault())
                }
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) {
                        onDone?.invoke()
                    }

                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) {
                        onDone?.invoke()
                    }
                })
            }
            onReady(ready)
        }
    }

    /** Speaks [text], flushing anything currently playing. [onComplete] fires when done. */
    fun speak(text: String, onComplete: (() -> Unit)? = null) {
        if (!ready || text.isBlank()) {
            onComplete?.invoke()
            return
        }
        onDone = onComplete
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, UTTERANCE_ID)
    }

    fun stop() {
        tts?.stop()
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        tts = null
    }

    companion object {
        private const val UTTERANCE_ID = "aiasist_tts"
    }
}
