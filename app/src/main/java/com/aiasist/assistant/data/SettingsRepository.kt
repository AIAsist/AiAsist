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

    /** Which backend to use: [PROVIDER_ANTHROPIC] (direct) or [PROVIDER_OPENROUTER]. */
    var provider: String
        get() = prefs.getString(KEY_PROVIDER, PROVIDER_ANTHROPIC).orEmpty().ifBlank { PROVIDER_ANTHROPIC }
        set(value) = prefs.edit().putString(KEY_PROVIDER, value).apply()

    /** OpenRouter API key (used when [provider] is [PROVIDER_OPENROUTER]). */
    var openRouterKey: String
        get() = prefs.getString(KEY_OR_KEY, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_OR_KEY, value.trim()).apply()

    /** OpenRouter model id, e.g. a free model. Editable because OpenRouter's catalogue changes. */
    var openRouterModel: String
        get() = prefs.getString(KEY_OR_MODEL, DEFAULT_OPENROUTER_MODEL).orEmpty().ifBlank { DEFAULT_OPENROUTER_MODEL }
        set(value) = prefs.edit().putString(KEY_OR_MODEL, value.trim()).apply()

    /** Whether the always-listening wake-word service should run. */
    var wakeWordEnabled: Boolean
        get() = prefs.getBoolean(KEY_WAKE_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_WAKE_ENABLED, value).apply()

    /** The phrase that activates the assistant hands-free (lower-cased, trimmed). */
    var wakeWord: String
        get() = prefs.getString(KEY_WAKE_WORD, DEFAULT_WAKE_WORD).orEmpty().ifBlank { DEFAULT_WAKE_WORD }
        set(value) = prefs.edit().putString(KEY_WAKE_WORD, value.trim().lowercase()).apply()

    /** True when the currently selected provider has a key configured. */
    fun hasApiKey(): Boolean =
        if (provider == PROVIDER_OPENROUTER) openRouterKey.isNotBlank() else apiKey.isNotBlank()

    companion object {
        private const val PREFS_NAME = "aiasist_secure_prefs"
        private const val KEY_API = "anthropic_api_key"
        private const val KEY_MODEL = "model"
        private const val KEY_PROVIDER = "provider"
        private const val KEY_OR_KEY = "openrouter_api_key"
        private const val KEY_OR_MODEL = "openrouter_model"
        private const val KEY_WAKE_ENABLED = "wake_enabled"
        private const val KEY_WAKE_WORD = "wake_word"

        const val PROVIDER_ANTHROPIC = "anthropic"
        const val PROVIDER_OPENROUTER = "openrouter"

        /** Default hotword phrase. */
        const val DEFAULT_WAKE_WORD = "ассистент"

        /** Per the project default; the user can switch to a faster/cheaper model in Settings. */
        const val DEFAULT_MODEL = "claude-opus-5-5"

        /** A free, tool-capable OpenRouter model. Editable — OpenRouter's free list changes. */
        const val DEFAULT_OPENROUTER_MODEL = "google/gemini-2.0-flash-exp:free"

        /** Models offered in the Anthropic picker. Fast/cheap options help voice latency. */
        val AVAILABLE_MODELS = listOf(
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-haiku-4-5",
        )

        /** A few free OpenRouter models suggested in Settings (user can type any id). */
        val FREE_OPENROUTER_MODELS = listOf(
            "google/gemini-2.0-flash-exp:free",
            "meta-llama/llama-3.3-70b-instruct:free",
            "deepseek/deepseek-chat-v3-0324:free",
        )
    }
}
