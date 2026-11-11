package com.stocksage.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import java.net.CookieHandler
import java.net.CookieManager
import java.net.CookiePolicy

class StockSageApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Yahoo (crumb) and NSE (option chain) only answer clients that keep their cookies.
        CookieHandler.setDefault(CookieManager(null, CookiePolicy.ACCEPT_ALL))

        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_BRIEF, "Daily brief & alerts", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Morning brief, midday guard check, end-of-day snapshot and sell alerts"
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_WORK, "Background run in progress", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while StockSage refreshes prices and news"
                setShowBadge(false)
            },
        )
        Scheduler.scheduleNext(this)
    }

    companion object {
        const val CHANNEL_BRIEF = "brief"
        const val CHANNEL_WORK = "work"
    }
}
