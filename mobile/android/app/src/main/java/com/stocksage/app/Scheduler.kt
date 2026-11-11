package com.stocksage.app

import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.time.DayOfWeek
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * The phone's APScheduler: Mon–Fri 08:30 / 12:30 / 16:00 IST. Only the NEXT
 * run is ever armed (one exact alarm); each firing arms the one after it.
 * IST is used regardless of the phone's own time zone.
 */
object Scheduler {
    data class Job(val type: String, val label: String, val hour: Int, val minute: Int)

    val JOBS = listOf(
        Job("MORNING", "Morning brief", 8, 30),
        Job("MIDDAY", "Midday guard refresh", 12, 30),
        Job("EOD", "End-of-day snapshot", 16, 0),
    )
    private val IST: ZoneId = ZoneId.of("Asia/Kolkata")
    private const val PREFS = "schedule"

    fun isEnabled(context: Context, type: String): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(type, true)

    fun setEnabled(context: Context, enabled: Map<String, Boolean>) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
            enabled.forEach { (k, v) -> putBoolean(k, v) }
        }.apply()
        scheduleNext(context)
    }

    /** Next enabled weekday run strictly after `from`. */
    fun next(context: Context, from: ZonedDateTime = ZonedDateTime.now(IST)): Pair<Job, ZonedDateTime>? {
        val active = JOBS.filter { isEnabled(context, it.type) }
        if (active.isEmpty()) return null
        var day = from.toLocalDate()
        repeat(8) {
            if (day.dayOfWeek != DayOfWeek.SATURDAY && day.dayOfWeek != DayOfWeek.SUNDAY) {
                active.map { it to day.atTime(it.hour, it.minute).atZone(IST) }
                    .filter { it.second.isAfter(from) }
                    .minByOrNull { it.second }
                    ?.let { return it }
            }
            day = day.plusDays(1)
        }
        return null
    }

    private fun pending(context: Context, type: String?): PendingIntent {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = "com.stocksage.app.RUN"
            if (type != null) putExtra("type", type)
        }
        return PendingIntent.getBroadcast(context, 1, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun canExact(context: Context): Boolean {
        val am = context.getSystemService(AlarmManager::class.java)
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
    }

    fun scheduleNext(context: Context) {
        val am = context.getSystemService(AlarmManager::class.java)
        val nxt = next(context)
        if (nxt == null) {
            am.cancel(pending(context, null))
            return
        }
        val (job, at) = nxt
        val pi = pending(context, job.type)
        val ms = at.toInstant().toEpochMilli()
        if (canExact(context)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, ms, pi)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, ms, pi)
    }

    fun info(context: Context): JSONObject {
        val jobs = JSONArray()
        JOBS.forEach {
            jobs.put(JSONObject().put("type", it.type).put("label", it.label)
                .put("time", "%02d:%02d".format(it.hour, it.minute)).put("enabled", isEnabled(context, it.type)))
        }
        val nxt = next(context)
        val nm = context.getSystemService(NotificationManager::class.java)
        val pm = context.getSystemService(PowerManager::class.java)
        return JSONObject()
            .put("ok", true)
            .put("jobs", jobs)
            .put("next", nxt?.let { JSONObject().put("type", it.first.type).put("at_ms", it.second.toInstant().toEpochMilli()) } ?: JSONObject.NULL)
            .put("exact_alarm_allowed", canExact(context))
            .put("notifications_allowed", nm.areNotificationsEnabled())
            .put("battery_unrestricted", pm.isIgnoringBatteryOptimizations(context.packageName))
    }
}
