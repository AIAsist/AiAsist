package com.aiasist.assistant

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.aiasist.assistant.data.SettingsRepository
import com.aiasist.assistant.ui.AssistantScreen
import com.aiasist.assistant.ui.AssistantViewModel
import com.aiasist.assistant.ui.SettingsScreen
import com.aiasist.assistant.ui.theme.AiAsistTheme
import com.aiasist.assistant.voice.WakeWordService

class MainActivity : ComponentActivity() {

    private val viewModel: AssistantViewModel by viewModels()

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { /* results handled gracefully at call sites; nothing to do here */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        requestStartupPermissions()

        setContent {
            AiAsistTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    val navController = rememberNavController()
                    NavHost(navController = navController, startDestination = "assistant") {
                        composable("assistant") {
                            AssistantScreen(
                                viewModel = viewModel,
                                onOpenSettings = { navController.navigate("settings") },
                            )
                        }
                        composable("settings") {
                            SettingsScreen(onBack = { navController.popBackStack() })
                        }
                    }
                }
            }
        }

        ensureWakeServiceIfEnabled()
        handleLaunchIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunchIntent(intent)
    }

    /** Auto-start capturing a command when opened by the wake word or an ASSIST gesture. */
    private fun handleLaunchIntent(intent: Intent?) {
        val fromWake = intent?.getBooleanExtra(EXTRA_START_LISTENING, false) == true
        val fromAssist = intent?.action == Intent.ACTION_ASSIST ||
            intent?.action == "android.intent.action.VOICE_COMMAND"
        if (fromWake || fromAssist) {
            // Small delay so the wake service releases the mic before we grab it.
            window.decorView.postDelayed({
                if (hasPermission(Manifest.permission.RECORD_AUDIO)) {
                    viewModel.startListening()
                }
            }, 700)
        }
    }

    /** Keep the hotword service running if the user enabled it (survives app restarts). */
    private fun ensureWakeServiceIfEnabled() {
        val settings = SettingsRepository(this)
        if (settings.wakeWordEnabled && hasPermission(Manifest.permission.RECORD_AUDIO)) {
            WakeWordService.start(this)
        }
    }

    private fun hasPermission(permission: String): Boolean =
        checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** Ask up front for the permissions the assistant commonly needs, so tool calls just work. */
    private fun requestStartupPermissions() {
        val perms = mutableListOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.SEND_SMS,
            Manifest.permission.READ_CONTACTS,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val toRequest = perms.filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (toRequest.isNotEmpty()) {
            permissionLauncher.launch(toRequest.toTypedArray())
        }
    }

    companion object {
        const val EXTRA_START_LISTENING = "start_listening"
    }
}
