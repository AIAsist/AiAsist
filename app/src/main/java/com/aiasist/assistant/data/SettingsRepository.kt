package com.aiasist.assistant.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Stores the Anthropic API key and chosen model. The key is sensitive, so it lives in
 * [EncryptedSharedPreferences] (AES-256), backed by a hardware-backed master key where available.
 */
class SettingsRepository(context: Context) {

    private val prefs: SharedPreferences = run {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var apiKey: String
        get() = prefs.getString(KEY_API, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_API, value.trim()).apply()

    var model: String
        get() = prefs.getString(KEY_MODEL, DEFAULT_MODEL).orEmpty().ifBlank { DEFAULT_MODEL }
        set(value) = prefs.edit().putString(KEY_MODEL, value).apply()

    /** Whether the always-listening wake-word service should run. */
    var wakeWordEnabled: Boolean
        get() = prefs.getBoolean(KEY_WAKE_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_WAKE_ENABLED, value).apply()

    /** The phrase that activates the assistant hands-free (lower-cased, trimmed). */
    var wakeWord: String
        get() = prefs.getString(KEY_WAKE_WORD, DEFAULT_WAKE_WORD).orEmpty().ifBlank { DEFAULT_WAKE_WORD }
        set(value) = prefs.edit().putString(KEY_WAKE_WORD, value.trim().lowercase()).apply()

    fun hasApiKey(): Boolean = apiKey.isNotBlank()

    companion object {
        private const val PREFS_NAME = "aiasist_secure_prefs"
        private const val KEY_API = "anthropic_api_key"
        private const val KEY_MODEL = "model"
        private const val KEY_WAKE_ENABLED = "wake_enabled"
        private const val KEY_WAKE_WORD = "wake_word"

        /** Default hotword phrase. */
        const val DEFAULT_WAKE_WORD = "ассистент"

        /** Per the project default; the user can switch to a faster/cheaper model in Settings. */
        const val DEFAULT_MODEL = "claude-opus-5-5"

        /** Models offered in the settings picker. Fast/cheap options help voice latency. */
        val AVAILABLE_MODELS = listOf(
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-haiku-4-5",
        )
    }
}
