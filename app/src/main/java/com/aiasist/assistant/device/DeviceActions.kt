package com.aiasist.assistant.device

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Settings
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/**
 * Result of a device action. [message] is fed back to Claude so it can confirm or react.
 * [needsPermission] carries an Android permission string when the action was blocked for lack of it,
 * so the UI layer can prompt the user to grant it.
 */
data class ActionResult(
    val success: Boolean,
    val message: String,
    val needsPermission: String? = null,
)

/**
 * Executes the "device tools" that Claude can call. Everything here is Intent-based or uses a
 * system service, so the class works from any [Context] (it adds NEW_TASK where required).
 */
class DeviceActions(private val appContext: Context) {

    private val cameraManager: CameraManager? =
        appContext.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
    private val audioManager: AudioManager? =
        appContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    /** Dispatches a tool call by name. [input] is the parsed tool_use.input object. */
    fun execute(toolName: String, input: JSONObject): ActionResult = try {
        when (toolName) {
            "open_app" -> openApp(input.optString("app_name"))
            "phone_call" -> phoneCall(input.optString("target"))
            "send_sms" -> sendSms(input.optString("target"), input.optString("message"))
            "set_alarm" -> setAlarm(
                input.optInt("hour", -1),
                input.optInt("minute", 0),
                input.optString("label").ifBlank { null },
            )
            "set_timer" -> setTimer(
                input.optInt("seconds", 0),
                input.optString("label").ifBlank { null },
            )
            "create_calendar_event" -> createCalendarEvent(
                input.optString("title"),
                input.optString("start_iso").ifBlank { null },
                input.optString("end_iso").ifBlank { null },
                input.optString("location").ifBlank { null },
            )
            "open_url" -> openUrl(input.optString("url"))
            "web_search" -> webSearch(input.optString("query"))
            "navigate" -> navigate(input.optString("destination"))
            "set_media_volume" -> setMediaVolume(input.optInt("percent", -1))
            "toggle_flashlight" -> toggleFlashlight(input.optBoolean("on", true))
            "get_device_status" -> getDeviceStatus()
            "open_settings" -> openSettings(input.optString("panel").ifBlank { "settings" })
            "open_camera" -> openCamera(input.optBoolean("video", false))
            "play_music" -> playMusic(input.optString("query").ifBlank { null })
            "get_datetime" -> getDateTime()
            else -> ActionResult(false, "Неизвестный инструмент: $toolName")
        }
    } catch (e: Exception) {
        ActionResult(false, "Не удалось выполнить «$toolName»: ${e.message ?: "неизвестная ошибка"}")
    }

    // region apps / web --------------------------------------------------------------------------

    private fun openApp(name: String): ActionResult {
        if (name.isBlank()) return ActionResult(false, "Не указано имя приложения.")
        val pm = appContext.packageManager
        val launchIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val activities = pm.queryIntentActivities(launchIntent, 0)
        val target = name.trim().lowercase(Locale.getDefault())
        val match = activities.firstOrNull {
            it.loadLabel(pm).toString().lowercase(Locale.getDefault()).contains(target)
        }
        return if (match != null) {
            val intent = pm.getLaunchIntentForPackage(match.activityInfo.packageName)
            if (intent != null) {
                startActivity(intent)
                ActionResult(true, "Открываю приложение «${match.loadLabel(pm)}».")
            } else {
                ActionResult(false, "Не удалось запустить «$name».")
            }
        } else {
            ActionResult(false, "Приложение «$name» не найдено на устройстве.")
        }
    }

    private fun openUrl(url: String): ActionResult {
        if (url.isBlank()) return ActionResult(false, "Не указан адрес.")
        val normalized = if (url.startsWith("http://") || url.startsWith("https://")) url else "https://$url"
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(normalized)))
        return ActionResult(true, "Открываю $normalized")
    }

    private fun webSearch(query: String): ActionResult {
        if (query.isBlank()) return ActionResult(false, "Пустой поисковый запрос.")
        val intent = Intent(Intent.ACTION_WEB_SEARCH).putExtra("query", query)
        return try {
            startActivity(intent)
            ActionResult(true, "Ищу в интернете: «$query».")
        } catch (e: ActivityNotFoundException) {
            // Fall back to opening a search URL in the browser.
            openUrl("https://www.google.com/search?q=" + Uri.encode(query))
        }
    }

    private fun navigate(destination: String): ActionResult {
        if (destination.isBlank()) return ActionResult(false, "Не указан пункт назначения.")
        val gmm = Uri.parse("google.navigation:q=" + Uri.encode(destination))
        val intent = Intent(Intent.ACTION_VIEW, gmm).setPackage("com.google.android.apps.maps")
        return try {
            startActivity(intent)
            ActionResult(true, "Строю маршрут до «$destination».")
        } catch (e: ActivityNotFoundException) {
            val geo = Uri.parse("geo:0,0?q=" + Uri.encode(destination))
            startActivity(Intent(Intent.ACTION_VIEW, geo))
            ActionResult(true, "Открываю карту для «$destination».")
        }
    }

    // endregion

    // region calls / sms -------------------------------------------------------------------------

    private fun phoneCall(target: String): ActionResult {
        if (target.isBlank()) return ActionResult(false, "Не указан номер или имя контакта.")
        val number = resolveNumber(target)
            ?: return ActionResult(false, "Не нашёл номер для «$target». Продиктуйте номер цифрами.")
        return if (hasPermission(Manifest.permission.CALL_PHONE)) {
            startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:$number")))
            ActionResult(true, "Звоню $target.")
        } else {
            // Without CALL_PHONE we can still open the dialer with the number pre-filled.
            startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$number")))
            ActionResult(
                true,
                "Открыл набор номера $target. Чтобы звонить сразу, выдайте разрешение на звонки.",
                needsPermission = Manifest.permission.CALL_PHONE,
            )
        }
    }

    private fun sendSms(target: String, message: String): ActionResult {
        if (target.isBlank()) return ActionResult(false, "Не указан получатель SMS.")
        val number = resolveNumber(target)
            ?: return ActionResult(false, "Не нашёл номер для «$target».")
        // Open the SMS composer pre-filled. We intentionally do not auto-send without confirmation.
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:$number")).apply {
            putExtra("sms_body", message)
        }
        startActivity(intent)
        return ActionResult(true, "Подготовил SMS для $target. Осталось подтвердить отправку на экране.")
    }

    /** Resolves a contact name to a phone number, or passes through a dialable number. */
    private fun resolveNumber(target: String): String? {
        val digits = target.filter { it.isDigit() || it == '+' }
        if (digits.length >= 3 && digits.count { it.isDigit() } >= 3) return digits

        if (!hasPermission(Manifest.permission.READ_CONTACTS)) return null
        val uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
        val projection = arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER)
        val selection = "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?"
        val args = arrayOf("%$target%")
        appContext.contentResolver.query(uri, projection, selection, args, null)?.use { c ->
            if (c.moveToFirst()) return c.getString(0)
        }
        return null
    }

    // endregion

    // region alarms / timers / calendar ----------------------------------------------------------

    private fun setAlarm(hour: Int, minute: Int, label: String?): ActionResult {
        if (hour !in 0..23 || minute !in 0..59) {
            return ActionResult(false, "Некорректное время будильника.")
        }
        val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
            putExtra(AlarmClock.EXTRA_HOUR, hour)
            putExtra(AlarmClock.EXTRA_MINUTES, minute)
            if (label != null) putExtra(AlarmClock.EXTRA_MESSAGE, label)
            putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        }
        startActivity(intent)
        val time = String.format(Locale.getDefault(), "%02d:%02d", hour, minute)
        return ActionResult(true, "Будильник на $time установлен." + (label?.let { " ($it)" } ?: ""))
    }

    private fun setTimer(seconds: Int, label: String?): ActionResult {
        if (seconds <= 0) return ActionResult(false, "Некорректная длительность таймера.")
        val intent = Intent(AlarmClock.ACTION_SET_TIMER).apply {
            putExtra(AlarmClock.EXTRA_LENGTH, seconds)
            if (label != null) putExtra(AlarmClock.EXTRA_MESSAGE, label)
            putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        }
        startActivity(intent)
        val mins = seconds / 60
        val secs = seconds % 60
        val human = buildString {
            if (mins > 0) append("$mins мин ")
            if (secs > 0) append("$secs сек")
        }.trim()
        return ActionResult(true, "Таймер на $human запущен.")
    }

    private fun createCalendarEvent(
        title: String,
        startIso: String?,
        endIso: String?,
        location: String?,
    ): ActionResult {
        if (title.isBlank()) return ActionResult(false, "Не указано название события.")
        val startMs = startIso?.let { parseIso(it) } ?: System.currentTimeMillis()
        val endMs = endIso?.let { parseIso(it) } ?: (startMs + 60 * 60 * 1000)
        val intent = Intent(Intent.ACTION_INSERT).apply {
            data = CalendarContract.Events.CONTENT_URI
            putExtra(CalendarContract.Events.TITLE, title)
            putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMs)
            putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endMs)
            if (location != null) putExtra(CalendarContract.Events.EVENT_LOCATION, location)
        }
        startActivity(intent)
        return ActionResult(true, "Открываю создание события «$title» в календаре.")
    }

    // endregion

    // region device control ----------------------------------------------------------------------

    private fun setMediaVolume(percent: Int): ActionResult {
        val am = audioManager ?: return ActionResult(false, "Нет доступа к звуку.")
        if (percent !in 0..100) return ActionResult(false, "Громкость задаётся в процентах 0–100.")
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val target = Math.round(max * percent / 100f)
        am.setStreamVolume(AudioManager.STREAM_MUSIC, target, AudioManager.FLAG_SHOW_UI)
        return ActionResult(true, "Громкость медиа установлена на $percent%.")
    }

    private fun toggleFlashlight(on: Boolean): ActionResult {
        val cm = cameraManager ?: return ActionResult(false, "Фонарик недоступен на этом устройстве.")
        val camId = cm.cameraIdList.firstOrNull { id ->
            cm.getCameraCharacteristics(id)
                .get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        } ?: return ActionResult(false, "На устройстве нет вспышки.")
        cm.setTorchMode(camId, on)
        return ActionResult(true, if (on) "Фонарик включён." else "Фонарик выключен.")
    }

    private fun getDeviceStatus(): ActionResult {
        val bm = appContext.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val level = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
        val charging = bm?.isCharging ?: false
        val now = SimpleDateFormat("HH:mm, EEEE d MMMM", Locale("ru")).format(Calendar.getInstance().time)
        val battery = if (level >= 0) "$level%${if (charging) " (заряжается)" else ""}" else "неизвестно"
        return ActionResult(true, "Время: $now. Батарея: $battery.")
    }

    private fun getDateTime(): ActionResult {
        val now = SimpleDateFormat("HH:mm, EEEE, d MMMM yyyy", Locale("ru")).format(Calendar.getInstance().time)
        return ActionResult(true, "Сейчас $now.")
    }

    private fun openSettings(panel: String): ActionResult {
        val action = when (panel.lowercase(Locale.getDefault())) {
            "wifi", "wi-fi", "вайфай", "вай-фай" -> Settings.ACTION_WIFI_SETTINGS
            "bluetooth", "блютуз" -> Settings.ACTION_BLUETOOTH_SETTINGS
            "sound", "звук" -> Settings.ACTION_SOUND_SETTINGS
            "display", "экран", "яркость" -> Settings.ACTION_DISPLAY_SETTINGS
            "battery", "батарея" -> Settings.ACTION_BATTERY_SAVER_SETTINGS
            "location", "геолокация", "gps" -> Settings.ACTION_LOCATION_SOURCE_SETTINGS
            "apps", "приложения" -> Settings.ACTION_APPLICATION_SETTINGS
            "airplane", "самолёт", "авиарежим" -> Settings.ACTION_AIRPLANE_MODE_SETTINGS
            else -> Settings.ACTION_SETTINGS
        }
        startActivity(Intent(action))
        return ActionResult(true, "Открываю настройки ($panel).")
    }

    private fun openCamera(video: Boolean): ActionResult {
        val action = if (video) MediaStore.INTENT_ACTION_VIDEO_CAMERA
        else MediaStore.ACTION_IMAGE_CAPTURE
        startActivity(Intent(action))
        return ActionResult(true, if (video) "Открываю видеокамеру." else "Открываю камеру.")
    }

    private fun playMusic(query: String?): ActionResult {
        val intent = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH).apply {
            putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
            if (query != null) putExtra(android.app.SearchManager.QUERY, query)
        }
        return try {
            startActivity(intent)
            ActionResult(true, "Включаю музыку" + (query?.let { ": $it" } ?: "") + ".")
        } catch (e: ActivityNotFoundException) {
            ActionResult(false, "Не нашёл приложение для воспроизведения музыки.")
        }
    }

    // endregion

    // region helpers -----------------------------------------------------------------------------

    private fun startActivity(intent: Intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        appContext.startActivity(intent)
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(appContext, permission) == PackageManager.PERMISSION_GRANTED

    private fun parseIso(iso: String): Long? {
        val patterns = listOf("yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd")
        for (p in patterns) {
            try {
                return SimpleDateFormat(p, Locale.getDefault()).parse(iso)?.time
            } catch (_: Exception) {
            }
        }
        return null
    }

    // endregion

    companion object {
        /** Returns the Android runtime permissions a tool may need, for proactive prompting. */
        fun permissionsForTools(): List<String> = listOf(
            Manifest.permission.CALL_PHONE,
            Manifest.permission.SEND_SMS,
            Manifest.permission.READ_CONTACTS,
        )
    }
}
