package com.aiasist.assistant.ai

import org.json.JSONArray
import org.json.JSONObject

/**
 * Tool catalogue sent to Claude. Each tool maps 1:1 to a branch in
 * [com.aiasist.assistant.device.DeviceActions.execute]. `strict: true` keeps the arguments
 * schema-valid so parsing never surprises us.
 */
object Tools {

    fun definitions(): JSONArray {
        val tools = JSONArray()

        tools.put(
            tool(
                name = "open_app",
                description = "Открыть установленное на телефоне приложение по его названию.",
                props = mapOf(
                    "app_name" to strProp("Название приложения, например «Телеграм», «Камера», «Ютуб».")
                ),
                required = listOf("app_name"),
            )
        )

        tools.put(
            tool(
                name = "phone_call",
                description = "Позвонить по номеру телефона или имени контакта.",
                props = mapOf(
                    "target" to strProp("Имя контакта или номер телефона.")
                ),
                required = listOf("target"),
            )
        )

        tools.put(
            tool(
                name = "send_sms",
                description = "Подготовить SMS-сообщение контакту или на номер (пользователь подтвердит отправку).",
                props = mapOf(
                    "target" to strProp("Имя контакта или номер телефона."),
                    "message" to strProp("Текст сообщения."),
                ),
                required = listOf("target", "message"),
            )
        )

        tools.put(
            tool(
                name = "set_alarm",
                description = "Установить будильник на конкретное время суток.",
                props = mapOf(
                    "hour" to intProp("Час в формате 24ч (0–23)."),
                    "minute" to intProp("Минуты (0–59)."),
                    "label" to strProp("Необязательная подпись будильника."),
                ),
                required = listOf("hour", "minute"),
            )
        )

        tools.put(
            tool(
                name = "set_timer",
                description = "Запустить обратный таймер на заданное число секунд.",
                props = mapOf(
                    "seconds" to intProp("Длительность таймера в секундах."),
                    "label" to strProp("Необязательная подпись таймера."),
                ),
                required = listOf("seconds"),
            )
        )

        tools.put(
            tool(
                name = "create_calendar_event",
                description = "Создать событие в календаре.",
                props = mapOf(
                    "title" to strProp("Название события."),
                    "start_iso" to strProp("Начало в формате ISO, например 2026-10-06T15:00. Если не указано — сейчас."),
                    "end_iso" to strProp("Конец в формате ISO. Если не указано — через час после начала."),
                    "location" to strProp("Место проведения (необязательно)."),
                ),
                required = listOf("title"),
            )
        )

        tools.put(
            tool(
                name = "open_url",
                description = "Открыть веб-страницу по адресу в браузере.",
                props = mapOf("url" to strProp("Адрес сайта.")),
                required = listOf("url"),
            )
        )

        tools.put(
            tool(
                name = "web_search",
                description = "Выполнить поиск в интернете по запросу.",
                props = mapOf("query" to strProp("Поисковый запрос.")),
                required = listOf("query"),
            )
        )

        tools.put(
            tool(
                name = "navigate",
                description = "Построить маршрут/навигацию до места на картах.",
                props = mapOf("destination" to strProp("Пункт назначения: адрес или название места.")),
                required = listOf("destination"),
            )
        )

        tools.put(
            tool(
                name = "set_media_volume",
                description = "Установить громкость мультимедиа в процентах.",
                props = mapOf("percent" to intProp("Громкость 0–100.")),
                required = listOf("percent"),
            )
        )

        tools.put(
            tool(
                name = "toggle_flashlight",
                description = "Включить или выключить фонарик.",
                props = mapOf("on" to boolProp("true — включить, false — выключить.")),
                required = listOf("on"),
            )
        )

        tools.put(
            tool(
                name = "get_device_status",
                description = "Узнать текущее состояние телефона: время, дата, заряд батареи.",
                props = emptyMap(),
                required = emptyList(),
            )
        )

        tools.put(
            tool(
                name = "get_datetime",
                description = "Узнать текущие дату и время.",
                props = emptyMap(),
                required = emptyList(),
            )
        )

        tools.put(
            tool(
                name = "open_settings",
                description = "Открыть экран системных настроек.",
                props = mapOf(
                    "panel" to strProp("Раздел настроек: wifi, bluetooth, sound, display, battery, location, apps, airplane. По умолчанию общий экран настроек.")
                ),
                required = emptyList(),
            )
        )

        tools.put(
            tool(
                name = "open_camera",
                description = "Открыть камеру для фото или видео.",
                props = mapOf("video" to boolProp("true — видеокамера, false — фото.")),
                required = emptyList(),
            )
        )

        tools.put(
            tool(
                name = "play_music",
                description = "Включить воспроизведение музыки, при необходимости по запросу (исполнитель/трек).",
                props = mapOf("query" to strProp("Что включить: исполнитель, альбом или трек. Можно опустить.")),
                required = emptyList(),
            )
        )

        return tools
    }

    // --- schema builders -------------------------------------------------------------------------

    private fun tool(
        name: String,
        description: String,
        props: Map<String, JSONObject>,
        required: List<String>,
    ): JSONObject {
        val properties = JSONObject()
        props.forEach { (k, v) -> properties.put(k, v) }
        val schema = JSONObject()
            .put("type", "object")
            .put("properties", properties)
            .put("required", JSONArray(required))
        return JSONObject()
            .put("name", name)
            .put("description", description)
            .put("input_schema", schema)
    }

    private fun strProp(desc: String) = JSONObject().put("type", "string").put("description", desc)
    private fun intProp(desc: String) = JSONObject().put("type", "integer").put("description", desc)
    private fun boolProp(desc: String) = JSONObject().put("type", "boolean").put("description", desc)
}
