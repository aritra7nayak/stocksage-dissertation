package com.stocksage.app

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

object Notifications {
    private fun openApp(context: Context): PendingIntent =
        PendingIntent.getActivity(context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun post(context: Context, title: String, body: String, id: Int = (System.currentTimeMillis() % 100000).toInt()) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (!nm.areNotificationsEnabled()) return
        val n = Notification.Builder(context, StockSageApp.CHANNEL_BRIEF)
            .setSmallIcon(R.drawable.ic_stat_stocksage)
            .setColor(0xFF5B8DEF.toInt())
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(openApp(context))
            .setAutoCancel(true)
            .build()
        nm.notify(id, n)
    }

    fun working(context: Context, label: String): Notification =
        Notification.Builder(context, StockSageApp.CHANNEL_WORK)
            .setSmallIcon(R.drawable.ic_stat_stocksage)
            .setColor(0xFF5B8DEF.toInt())
            .setContentTitle(label)
            .setContentText("Fetching prices and news, running the 15 rules…")
            .setProgress(0, 0, true)
            .setOngoing(true)
            .setContentIntent(openApp(context))
            .build()
}
