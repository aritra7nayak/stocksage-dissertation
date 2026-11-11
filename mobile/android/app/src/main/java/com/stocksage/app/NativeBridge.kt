package com.stocksage.app

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.HapticFeedbackConstants
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * window.StockSageNative — everything the TypeScript backend and the mobile
 * shell need from Android. Mirrored by mobile/web/src/native/bridge.ts.
 *
 * Sync methods return a JSON envelope {ok, ...}. Async methods take an id,
 * run on a worker pool, stash the result and call
 * window.__ssNative.resolve(id); JS then fetches it with take(id), so large
 * payloads never travel through evaluateJavascript source text.
 */
class NativeBridge(
    private val context: Context,
    private val web: () -> WebView?,
    private val host: Host,
) {
    interface Host {
        fun onJobFinished(outcome: JSONObject) = Unit
        fun setSystemBars(dark: Boolean) = Unit
    }

    private val db = Db.get(context)
    private val results = ConcurrentHashMap<String, String>()
    private val main = Handler(Looper.getMainLooper())

    private fun ok(o: JSONObject = JSONObject()): String = o.put("ok", true).toString()
    private fun err(e: Throwable): String {
        Log.w(TAG, "bridge call failed", e)
        return JSONObject().put("ok", false).put("error", e.message ?: e.javaClass.simpleName).toString()
    }

    private inline fun guard(block: () -> String): String = try { block() } catch (e: Throwable) { err(e) }

    private fun async(id: String, work: () -> JSONObject) {
        POOL.execute {
            results[id] = try { work().toString() } catch (e: Throwable) { err(e) }
            main.post { web()?.evaluateJavascript("window.__ssNative&&window.__ssNative.resolve('$id')", null) }
        }
    }

    // ── storage ──────────────────────────────────────────────────────────
    @JavascriptInterface
    fun sqlQuery(sql: String, params: String): String = guard {
        ok(JSONObject().put("rows", db.query(sql, JSONArray(params))))
    }

    @JavascriptInterface
    fun sqlRun(sql: String, params: String): String = guard {
        val (changes, lastId) = db.run(sql, JSONArray(params))
        ok(JSONObject().put("changes", changes).put("lastId", lastId))
    }

    @JavascriptInterface
    fun sqlBatch(statements: String): String = guard {
        db.batch(JSONArray(statements))
        ok()
    }

    // ── network + model ─────────────────────────────────────────────────
    @JavascriptInterface
    fun httpRequest(id: String, request: String) = async(id) { Http.request(JSONObject(request)) }

    @JavascriptInterface
    fun finbertAssets(): String = guard { FinBert.assets(context).toString() }

    @JavascriptInterface
    fun finbertRun(id: String, payload: String) = async(id) { FinBert.run(context, JSONObject(payload)) }

    @JavascriptInterface
    fun take(id: String): String = results.remove(id) ?: err(IllegalStateException("No result for $id"))

    // ── files ───────────────────────────────────────────────────────────
    @JavascriptInterface
    fun saveFile(id: String, name: String, mime: String, base64: String) = async(id) {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        val shown: String
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/StockSage")
            }
            val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("Downloads folder unavailable")
            context.contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
            shown = "Downloads/StockSage/$name"
        } else {
            val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)!!
            File(dir, name).writeBytes(bytes)
            shown = "${dir.absolutePath}/$name"
        }
        JSONObject().put("ok", true).put("path", shown)
    }

    // ── device ──────────────────────────────────────────────────────────
    @JavascriptInterface
    fun notify(title: String, body: String) = Notifications.post(context, title, body)

    @JavascriptInterface
    fun haptic(kind: String) {
        main.post {
            val c = when (kind) {
                "success" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.CONTEXT_CLICK
                "warning" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
                else -> HapticFeedbackConstants.CONTEXT_CLICK
            }
            web()?.performHapticFeedback(c)
        }
    }

    @JavascriptInterface
    fun openExternal(url: String) {
        if (!url.startsWith("https://") && !url.startsWith("http://")) return
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    @JavascriptInterface
    fun setSystemBars(dark: Boolean) = main.post { host.setSystemBars(dark) }.let { }

    @JavascriptInterface
    fun scheduleInfo(): String = guard { Scheduler.info(context).toString() }

    @JavascriptInterface
    fun setSchedule(config: String): String = guard {
        val enabled = JSONObject(config).getJSONObject("enabled")
        Scheduler.setEnabled(context, enabled.keys().asSequence().associateWith { enabled.getBoolean(it) })
        Scheduler.info(context).toString()
    }

    @JavascriptInterface
    fun runJobNow(type: String) = JobService.start(context, type)

    @JavascriptInterface
    fun openSettings(which: String) {
        val pkg = context.packageName
        val intent = when (which) {
            "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
            "exact_alarm" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$pkg")) else null
            "battery" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$pkg"))
            else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
        } ?: return
        runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            .onFailure {
                context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
    }

    @JavascriptInterface
    fun jobFinished(outcome: String) {
        val o = runCatching { JSONObject(outcome) }.getOrElse { JSONObject().put("ok", false).put("title", "StockSage run failed") }
        main.post { host.onJobFinished(o) }
    }

    @JavascriptInterface
    fun appInfo(): String = ok(JSONObject()
        .put("version", BuildConfig.VERSION_NAME)
        .put("build", BuildConfig.VERSION_CODE)
        .put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
        .put("android", Build.VERSION.RELEASE))

    @JavascriptInterface
    fun log(level: String, message: String) {
        when (level) {
            "error" -> Log.e(TAG, message)
            "warn" -> Log.w(TAG, message)
            else -> Log.i(TAG, message)
        }
    }

    companion object {
        const val TAG = "StockSage"
        /** Shared by all WebViews: market downloads run 6–8 wide. */
        private val POOL = Executors.newFixedThreadPool(10)
    }
}
