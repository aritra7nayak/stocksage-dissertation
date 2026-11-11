package com.stocksage.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** An exact alarm fired: start the run (exact alarms may start foreground services) and arm the next one. */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val type = intent.getStringExtra("type") ?: return
        JobService.start(context, type)
        Scheduler.scheduleNext(context)
    }
}

/** Alarms don't survive reboots, app updates or clock changes — re-arm. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Scheduler.scheduleNext(context)
    }
}
