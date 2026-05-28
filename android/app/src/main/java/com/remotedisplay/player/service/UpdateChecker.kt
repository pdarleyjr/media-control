package com.remotedisplay.player.service

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.FileProvider
import com.remotedisplay.player.data.ServerConfig
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

class UpdateChecker(private val context: Context) {

    private val TAG = "UpdateChecker"
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()
    private val handler = Handler(Looper.getMainLooper())
    private val config = ServerConfig(context)
    private var checkTimer: Runnable? = null

    // Check every 30 minutes
    private val CHECK_INTERVAL = 30 * 60 * 1000L

    fun startPeriodicCheck() {
        stopPeriodicCheck()
        checkTimer = object : Runnable {
            override fun run() {
                checkForUpdate()
                handler.postDelayed(this, CHECK_INTERVAL)
            }
        }
        // First check after 60 seconds (let the app settle)
        handler.postDelayed(checkTimer!!, 60000)
        Log.i(TAG, "Periodic update check started (every ${CHECK_INTERVAL / 60000}m)")
    }

    fun stopPeriodicCheck() {
        checkTimer?.let { handler.removeCallbacks(it) }
        checkTimer = null
    }

    fun checkForUpdate() {
        if (config.serverUrl.isEmpty()) return

        Thread {
            try {
                val currentVersion = getAppVersion()
                val url = "${config.serverUrl}/api/update/check?version=$currentVersion"
                Log.i(TAG, "Checking for updates: $url")

                val request = Request.Builder().url(url).build()
                val response = client.newCall(request).execute()

                if (!response.isSuccessful) {
                    Log.w(TAG, "Update check failed: ${response.code}")
                    return@Thread
                }

                val json = JSONObject(response.body?.string() ?: "{}")
                val updateAvailable = json.optBoolean("update_available", false)
                val latestVersion = json.optString("latest_version", currentVersion)
                val downloadUrl = json.optString("download_url", "")

                Log.i(TAG, "Current: $currentVersion, Latest: $latestVersion, Update: $updateAvailable")

                // 2026-05-28: hardened against the infinite-update-loop bug.
                // A previously deployed server returned update_available=true
                // with latest_version="1.0.0" — the device would re-install
                // the same APK every 30 minutes forever. Trust client-side
                // version comparison rather than the server's boolean.
                if (updateAvailable && downloadUrl.isNotEmpty() && isNewerVersion(latestVersion, currentVersion) && hasWifi()) {
                    Log.i(TAG, "Update available and current device is on Wi-Fi! Downloading...")
                    downloadAndInstall("${config.serverUrl}$downloadUrl", latestVersion)
                } else if (updateAvailable && !isNewerVersion(latestVersion, currentVersion)) {
                    Log.w(TAG, "Server claims update but version is not newer ($latestVersion <= $currentVersion). Skipping to avoid loop.")
                } else if (updateAvailable && !hasWifi()) {
                    Log.i(TAG, "Update available but device is not on Wi-Fi — deferring.")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Update check error: ${e.message}")
            }
        }.start()
    }

    private fun downloadAndInstall(url: String, version: String) {
        try {
            // Download to a temp file
            val request = Request.Builder().url(url).build()
            val response = client.newCall(request).execute()

            if (!response.isSuccessful) {
                Log.e(TAG, "Download failed: ${response.code}")
                return
            }

            val apkFile = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
                "ScreenTinker-$version.apk")

            response.body?.byteStream()?.use { input ->
                apkFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }

            Log.i(TAG, "APK downloaded: ${apkFile.absolutePath} (${apkFile.length()} bytes)")

            // Install the APK
            handler.post {
                installApk(apkFile)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Download/install error: ${e.message}")
        }
    }

    private fun installApk(apkFile: File) {
        // Try silent session install first (no Play Protect dialog)
        try {
            tryPackageInstaller(apkFile)
            return
        } catch (e: Exception) {
            Log.w(TAG, "Session install failed: ${e.message}, falling back to intent")
        }

        // Fallback: intent-based install (shows dialog)
        try {
            val intent = Intent(Intent.ACTION_VIEW)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                val uri = FileProvider.getUriForFile(
                    context,
                    "${context.packageName}.fileprovider",
                    apkFile
                )
                intent.setDataAndType(uri, "application/vnd.android.package-archive")
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } else {
                intent.setDataAndType(Uri.fromFile(apkFile), "application/vnd.android.package-archive")
            }

            context.startActivity(intent)
            Log.i(TAG, "Install intent launched")
        } catch (e: Exception) {
            Log.e(TAG, "Install failed: ${e.message}")
        }
    }

    private fun tryPackageInstaller(apkFile: File) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                val installer = context.packageManager.packageInstaller
                val params = android.content.pm.PackageInstaller.SessionParams(
                    android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL
                )
                val sessionId = installer.createSession(params)
                val session = installer.openSession(sessionId)

                apkFile.inputStream().use { input ->
                    session.openWrite("ScreenTinker", 0, apkFile.length()).use { output ->
                        input.copyTo(output)
                        session.fsync(output)
                    }
                }

                // 2026-05-28: FLAG_IMMUTABLE on API 31+ so a co-installed
                // app can't fill in the PendingIntent and redirect the
                // install-complete callback. Older SDKs require FLAG_MUTABLE
                // for PackageInstaller status results.
                val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                    android.app.PendingIntent.FLAG_IMMUTABLE
                else
                    android.app.PendingIntent.FLAG_MUTABLE
                val pendingIntent = android.app.PendingIntent.getBroadcast(
                    context, sessionId,
                    Intent("com.remotedisplay.player.INSTALL_COMPLETE"),
                    flags
                )
                session.commit(pendingIntent.intentSender)
                Log.i(TAG, "Package installer session committed")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Package installer failed: ${e.message}")
        }
    }

    private fun getAppVersion(): String {
        return try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "1.0.0"
        } catch (e: Exception) {
            "1.0.0"
        }
    }

    // Strict semantic-style comparison. Returns true iff `latest` is strictly
    // greater than `current`. Malformed versions (non-numeric segments, missing
    // dots) return false — fail safe: never auto-update when comparison is
    // ambiguous. Trailing pre-release/build tags are ignored.
    private fun isNewerVersion(latest: String, current: String): Boolean {
        return try {
            val cleanLatest = latest.split('-', '+').first().split('.').map { it.toInt() }
            val cleanCurrent = current.split('-', '+').first().split('.').map { it.toInt() }
            val len = maxOf(cleanLatest.size, cleanCurrent.size)
            for (i in 0 until len) {
                val l = cleanLatest.getOrElse(i) { 0 }
                val c = cleanCurrent.getOrElse(i) { 0 }
                if (l > c) return true
                if (l < c) return false
            }
            false
        } catch (e: Exception) {
            Log.w(TAG, "Version comparison failed: $latest vs $current — refusing update")
            false
        }
    }

    // Check whether the device is on Wi-Fi before triggering a ~50MB APK
    // download. Saves cellular data on rare carrier-connected Fire TVs and
    // keeps the device responsive during the download.
    private fun hasWifi(): Boolean {
        return try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val network = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(network) ?: return false
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        } catch (e: Exception) {
            // If we can't determine, default to allowing — better to update
            // than to be stuck on an old version with bugs.
            true
        }
    }
}
