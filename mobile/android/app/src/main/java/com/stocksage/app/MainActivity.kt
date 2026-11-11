package com.stocksage.app

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updateLayoutParams
import java.util.Locale

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var pendingFiles: ValueCallback<Array<Uri>>? = null
    private var lastInsets = "0,0,0,0"

    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        pendingFiles?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        pendingFiles = null
    }
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this)
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        val bridge = NativeBridge(this, { web }, object : NativeBridge.Host {
            override fun setSystemBars(dark: Boolean) {
                WindowInsetsControllerCompat(window, window.decorView).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
        })
        WebShell.configure(web, bridge)
        web.webViewClient = object : WebShell.Client(this) {
            override fun onPageFinished(view: WebView, url: String) = pushInsets()
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>,
                                           params: FileChooserParams): Boolean {
                pendingFiles?.onReceiveValue(null)
                pendingFiles = callback
                pickFile.launch(arrayOf(
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "application/vnd.ms-excel.sheet.macroEnabled.12",
                    "application/octet-stream",
                ))
                return true
            }

            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.println(if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.ERROR else Log.DEBUG,
                    NativeBridge.TAG, "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }

        // Bars draw over the page; the page pads itself from these CSS vars.
        // The keyboard instead shrinks the WebView so focused inputs stay visible.
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            web.updateLayoutParams<FrameLayout.LayoutParams> { bottomMargin = ime.bottom }
            val d = resources.displayMetrics.density
            val bottom = if (ime.bottom > 0) 0 else bars.bottom
            lastInsets = listOf(bars.top, bars.right, bottom, bars.left).joinToString(",") { String.format(Locale.US, "%.1f", it / d) }
            pushInsets()
            WindowInsetsCompat.CONSUMED
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.__ssNative&&window.__ssNative.onBack&&window.__ssNative.onBack())?'1':'0'") { r ->
                    when {
                        r == "\"1\"" -> Unit
                        web.canGoBack() -> web.goBack()
                        else -> moveTaskToBack(true)
                    }
                }
            }
        })

        if (savedInstanceState == null) web.loadUrl("${WebShell.ORIGIN}/") else web.restoreState(savedInstanceState)

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        Scheduler.scheduleNext(this)
    }

    private fun pushInsets() {
        web.evaluateJavascript("window.__ssNative&&window.__ssNative.insets&&window.__ssNative.insets($lastInsets)", null)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }
}
