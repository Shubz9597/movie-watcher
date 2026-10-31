package com.torwatch.mobile.downloads

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.torwatch.mobile.MainActivity

/**
 * Keeps downloads going with the app closed or the phone locked (Android
 * stops background work otherwise): a foreground service with one ongoing
 * notification ("Downloading S2 E5 · 45%", "Waiting for Wi-Fi"). Tapping it
 * opens Downloads. It ends itself when nothing is left to download.
 */
class DownloadService : Service() {

    companion object {
        private const val CHANNEL = "downloads"
        private const val NOTIFICATION_ID = 4017
        @Volatile private var running = false
        private var lastText = ""

        fun start(context: Context) {
            if (running) return
            try {
                ContextCompat.startForegroundService(context, Intent(context, DownloadService::class.java))
            } catch (_: Exception) {
                // Started from the background (not allowed): the queue
                // continues while the app is open and resumes on the next open.
            }
        }

        /** Nothing left: the service and its notification go. */
        fun idle(context: Context) {
            if (!running) return
            context.stopService(Intent(context, DownloadService::class.java))
        }

        fun refresh(context: Context) {
            if (!running) return
            val text = statusText()
            if (text == lastText) return
            lastText = text
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.notify(NOTIFICATION_ID, build(context, text))
        }

        private fun statusText(): String {
            val active = DownloadEngine.activeRecord()
            if (DownloadEngine.waitingForWifi) return "Waiting for Wi-Fi"
            if (active == null) return "Preparing downloads"
            val label = active.subtitleLabel.ifEmpty { active.title }
            if (active.assets.isEmpty()) return "$label · preparing on your server"
            val percent = if (active.totalBytes > 0) (active.receivedBytes * 100 / active.totalBytes) else 0
            return "$label · $percent%"
        }

        private fun build(context: Context, text: String): Notification {
            val open = Intent(context, MainActivity::class.java)
                .putExtra("torwatchRoute", "downloads")
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            val pending = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val active = DownloadEngine.activeRecord()
            val builder = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(active?.title ?: "TorWatch downloads")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pending)
            if (active != null && active.totalBytes > 0 && !DownloadEngine.waitingForWifi) {
                builder.setProgress(100, (active.receivedBytes * 100 / active.totalBytes).toInt(), false)
            }
            return builder.build()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        DownloadEngine.init(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW))
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastText = statusText()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, build(this, lastText), type)
        running = true
        if (!DownloadEngine.hasWork()) stopSelf()
        return START_STICKY
    }

    // Android 15 limits data-sync services to 6 hours a day: the queue
    // pauses here and continues the next time the app opens.
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }
}
