package com.stocksage.app

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.webkit.WebView
import org.json.JSONObject

/**
 * Runs a scheduled job (MORNING / MIDDAY / EOD) with the app closed: a
 * foreground service hosts an off-screen WebView that loads the same bundle
 * with ?job=TYPE, so the exact TypeScript engine the UI uses does the work.
 * The result comes back through jobFinished() and becomes a notification.
 */
class JobService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private var web: WebView? = null
    private var wake: PowerManager.WakeLock? = null
    private var currentType: String? = null
    private val timeout = Runnable { finish(JSONObject().put("ok", false).put("title", "StockSage run timed out")
        .put("body", "Prices or news took too long to load. Open the app to retry.")) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val type = intent?.getStringExtra("type") ?: return START_NOT_STICKY
        val label = Scheduler.JOBS.firstOrNull { it.type == type }?.label ?: "StockSage"
        val notification = Notifications.working(this, "$label…")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ONGOING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(ONGOING_ID, notification)
        }
        if (currentType != null) return START_NOT_STICKY   // one run at a time
        currentType = type

        wake = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "StockSage:job").apply { acquire(MAX_RUN_MS) }
        main.postDelayed(timeout, MAX_RUN_MS)

        val view = WebView(this)
        web = view
        val bridge = NativeBridge(this, { web }, object : NativeBridge.Host {
            override fun onJobFinished(outcome: JSONObject) = finish(outcome)
        })
        WebShell.configure(view, bridge)
        view.webViewClient = WebShell.Client(this)
        view.onResume()
        view.resumeTimers()
        view.loadUrl("${WebShell.ORIGIN}/?job=$type")
        Log.i(NativeBridge.TAG, "Background $type run started")
        return START_NOT_STICKY
    }

    private fun finish(outcome: JSONObject) {
        if (currentType == null) return
        Log.i(NativeBridge.TAG, "Background $currentType run finished: $outcome")
        main.removeCallbacks(timeout)
        Notifications.post(this, outcome.optString("title", "StockSage"), outcome.optString("body", ""), RESULT_ID)
        currentType = null
        web?.apply { stopLoading(); destroy() }
        web = null
        wake?.let { if (it.isHeld) it.release() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        main.removeCallbacks(timeout)
        web?.destroy()
        wake?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    companion object {
        private const val ONGOING_ID = 42
        private const val RESULT_ID = 43
        private const val MAX_RUN_MS = 10 * 60_000L

        fun start(context: Context, type: String) {
            val i = Intent(context, JobService::class.java).putExtra("type", type)
            context.startForegroundService(i)
        }
    }
}
