package com.aiasist.assistant.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.core.content.ContextCompat
import com.aiasist.assistant.data.SettingsRepository
import com.aiasist.assistant.voice.WakeWordService

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val settings = remember { SettingsRepository(context) }

    var provider by remember { mutableStateOf(settings.provider) }
    var apiKey by remember { mutableStateOf(settings.apiKey) }
    var model by remember { mutableStateOf(settings.model) }
    var orKey by remember { mutableStateOf(settings.openRouterKey) }
    var orModel by remember { mutableStateOf(settings.openRouterModel) }
    var keyVisible by remember { mutableStateOf(false) }
    var showSaved by remember { mutableStateOf(false) }

    val isOpenRouter = provider == SettingsRepository.PROVIDER_OPENROUTER

    var wakeEnabled by remember { mutableStateOf(settings.wakeWordEnabled) }
    var wakeWord by remember { mutableStateOf(settings.wakeWord) }

    fun enableWake() {
        settings.wakeWordEnabled = true
        wakeEnabled = true
        WakeWordService.start(context)
        // Needed so the service can pop the assistant to the foreground from the background.
        if (!Settings.canDrawOverlays(context)) {
            context.startActivity(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${context.packageName}"),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }

    fun disableWake() {
        settings.wakeWordEnabled = false
        wakeEnabled = false
        WakeWordService.stop(context)
    }

    val micPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) enableWake() else wakeEnabled = false }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Настройки") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Назад")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 20.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Spacer(Modifier.height(8.dp))
            Text("Провайдер ИИ", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            ProviderRow(
                label = "Anthropic (напрямую)",
                hint = "Родной Claude API, нужен баланс в Anthropic",
                selected = !isOpenRouter,
                onClick = { provider = SettingsRepository.PROVIDER_ANTHROPIC },
            )
            ProviderRow(
                label = "OpenRouter",
                hint = "Много моделей, есть бесплатные (:free)",
                selected = isOpenRouter,
                onClick = { provider = SettingsRepository.PROVIDER_OPENROUTER },
            )

            Spacer(Modifier.height(16.dp))

            if (isOpenRouter) {
                Text("Ключ OpenRouter", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = orKey,
                    onValueChange = { orKey = it },
                    label = { Text("sk-or-…") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    visualTransformation = if (keyVisible) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    trailingIcon = {
                        IconButton(onClick = { keyVisible = !keyVisible }) {
                            Icon(
                                if (keyVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                                contentDescription = if (keyVisible) "Скрыть" else "Показать",
                            )
                        }
                    },
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "Ключ с openrouter.ai/keys. Хранится зашифрованно на устройстве.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(24.dp))
                Text("Модель OpenRouter", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = orModel,
                    onValueChange = { orModel = it },
                    label = { Text("например google/gemini-2.0-flash-exp:free") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "Бесплатные модели (нажмите, чтобы выбрать):",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                SettingsRepository.FREE_OPENROUTER_MODELS.forEach { option ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .selectable(selected = orModel == option, onClick = { orModel = option })
                            .padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = orModel == option, onClick = { orModel = option })
                        Text(
                            option,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(start = 8.dp),
                        )
                    }
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    "Список всех бесплатных моделей: openrouter.ai/models?max_price=0. " +
                        "У части бесплатных моделей голосовые команды (инструменты) работают хуже.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Text("Ключ Anthropic API", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it },
                    label = { Text("sk-ant-…") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    visualTransformation = if (keyVisible) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    trailingIcon = {
                        IconButton(onClick = { keyVisible = !keyVisible }) {
                            Icon(
                                if (keyVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                                contentDescription = if (keyVisible) "Скрыть" else "Показать",
                            )
                        }
                    },
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "Ключ хранится в зашифрованном виде на устройстве и используется только для запросов к Claude API.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(24.dp))
                Text("Модель", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                SettingsRepository.AVAILABLE_MODELS.forEach { option ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .selectable(selected = model == option, onClick = { model = option })
                            .padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = model == option, onClick = { model = option })
                        Column(Modifier.padding(start = 8.dp)) {
                            Text(option, style = MaterialTheme.typography.bodyLarge)
                            Text(
                                modelHint(option),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(24.dp))
            HorizontalDivider()
            Spacer(Modifier.height(16.dp))
            Text("Голосовая активация", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f).padding(end = 12.dp)) {
                    Text(
                        "Активация голосом («$wakeWord»)",
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    Text(
                        "Слушать в фоне и запускаться по слову-активатору.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = wakeEnabled,
                    onCheckedChange = { checked ->
                        if (checked) {
                            val granted = ContextCompat.checkSelfPermission(
                                context, Manifest.permission.RECORD_AUDIO,
                            ) == PackageManager.PERMISSION_GRANTED
                            if (granted) enableWake()
                            else micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                        } else {
                            disableWake()
                        }
                    },
                )
            }
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = wakeWord,
                onValueChange = { wakeWord = it },
                label = { Text("Слово-активатор") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "Непрерывное распознавание заметно расходует батарею и зависит от устройства.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(24.dp))
            Button(
                onClick = {
                    settings.provider = provider
                    settings.apiKey = apiKey
                    settings.model = model
                    settings.openRouterKey = orKey
                    settings.openRouterModel = orModel
                    settings.wakeWord = wakeWord
                    // Detection reads the word live; re-start only refreshes the notification text.
                    if (settings.wakeWordEnabled) WakeWordService.start(context)
                    showSaved = true
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Сохранить")
            }
            Spacer(Modifier.height(32.dp))
        }
    }

    if (showSaved) {
        Dialog(onDismissRequest = { showSaved = false; onBack() }) {
            Surface(
                shape = MaterialTheme.shapes.large,
                color = MaterialTheme.colorScheme.surface,
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text("Сохранено", style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { showSaved = false; onBack() }) { Text("ОК") }
                }
            }
        }
    }
}

@Composable
private fun ProviderRow(
    label: String,
    hint: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, onClick = onClick)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Column(Modifier.padding(start = 8.dp)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            Text(
                hint,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun modelHint(model: String): String = when {
    model.contains("opus") -> "Самая умная, но медленнее и дороже"
    model.contains("sonnet") -> "Баланс скорости и качества"
    model.contains("haiku") -> "Самая быстрая и дешёвая"
    else -> ""
}
