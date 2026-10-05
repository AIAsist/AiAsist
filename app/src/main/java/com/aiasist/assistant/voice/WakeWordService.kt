package com.aiasist.assistant.voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.app.NotificationCompat
import com.aiasist.assistant.MainActivity
import com.aiasist.assistant.R
import com.aiasist.assistant.data.SettingsRepository
import java.util.Locale

/**
 * Foreground service that listens continuously for a wake word (e.g. "ассистент"). When it hears the
 * phrase it launches [MainActivity] and tells it to start capturing a command.
 *
 * Implementation notes:
 * - Uses the on-device recognizer where available (API 31+) with EXTRA_PREFER_OFFLINE so the hotword
 *   loop works without the network and with lower latency.
 * - The system [SpeechRecognizer] is not built for always-on use, so we re-arm it after every result,
 *   error and timeout. This is battery-hungry and device-dependent; for production a dedicated
 *   wake-word engine (e.g. Picovoice Porcupine) is more robust. See README.
 * - On a hit we release the microphone and pause briefly so the foreground capture can use it,
 *   then resume the loop.
 */
class WakeWordService : android.app.Service() {

    private lateinit var settings: SettingsRepository
    private val handler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var running = false
    private var paused = false

    override fun onBind(intent: Intent?): android.os.IBinder? = null

    override fun onCreate() {
        super.onCreate()
        settings = SettingsRepository(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Always promote to foreground first to satisfy the startForegroundService() contract,
        // including when we were started only to stop (from the notification action, in background).
        startForegroundNotification()

        if (intent?.action == ACTION_STOP) {
            stopListeningLoop()
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }

        if (!running) {
            running = true
            startRecognizer()
        }
        return START_STICKY
    }

    // region recognizer loop ---------------------------------------------------------------------

    private fun startRecognizer() {
        if (!running || paused) return
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            // Nothing we can do; keep the service alive so the user sees the state, but idle.
            return
        }
        recognizer?.destroy()
        recognizer = createRecognizer().apply {
            setRecognitionListener(listener)
            startListening(recognizerIntent())
        }
    }

    private fun createRecognizer(): SpeechRecognizer =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            SpeechRecognizer.isOnDeviceRecognitionAvailable(this)
        ) {
            SpeechRecognizer.createOnDeviceSpeechRecognizer(this)
        } else {
            SpeechRecognizer.createSpeechRecognizer(this)
        }

    private fun recognizerIntent(): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }

    /** Restart recognition after a short delay (recognizer can't be re-used synchronously). */
    private fun rearm(delayMs: Long = 400L) {
        if (!running || paused) return
        handler.postDelayed({ startRecognizer() }, delayMs)
    }

    private fun stopListeningLoop() {
        running = false
        handler.removeCallbacksAndMessages(null)
        recognizer?.destroy()
        recognizer = null
    }

    private fun onHeard(text: String) {
        val phrase = settings.wakeWord
        if (text.lowercase(Locale.getDefault()).contains(phrase)) {
            triggerAssistant()
        }
    }

    private fun triggerAssistant() {
        // Release the mic so the foreground capture can grab it, then resume the loop later.
        paused = true
        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = null

        val launch = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra(MainActivity.EXTRA_START_LISTENING, true)
        }
        startActivity(launch)

        // Resume hotword listening after the command window.
        handler.postDelayed({
            paused = false
            startRecognizer()
        }, RESUME_DELAY_MS)
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}

        override fun onError(error: Int) {
            // NO_MATCH / SPEECH_TIMEOUT are normal in a continuous loop — just re-arm.
            val backoff = when (error) {
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> 1000L
                SpeechRecognizer.ERROR_CLIENT -> 800L
                else -> 400L
            }
            rearm(backoff)
        }

        override fun onResults(results: Bundle?) {
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
            if (!text.isNullOrBlank()) onHeard(text)
            rearm()
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val text = partialResults
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull()
            if (!text.isNullOrBlank()) onHeard(text)
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    // endregion

    // region foreground notification -------------------------------------------------------------

    private fun startForegroundNotification() {
        createChannel()
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, WakeWordService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.wake_notif_title))
            .setContentText(getString(R.string.wake_notif_text, settings.wakeWord))
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .addAction(0, getString(R.string.stop), stopIntent)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.wake_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            )
            manager.createNotificationChannel(channel)
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    // endregion

    override fun onDestroy() {
        stopListeningLoop()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "wake_word"
        private const val NOTIF_ID = 42
        private const val RESUME_DELAY_MS = 12_000L
        const val ACTION_STOP = "com.aiasist.assistant.WAKE_STOP"

        fun start(context: Context) {
            val intent = Intent(context, WakeWordService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, WakeWordService::class.java).setAction(ACTION_STOP)
            // Use startForegroundService so a stop triggered from the background (notification
            // action) does not crash with IllegalStateException on Android O+.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
