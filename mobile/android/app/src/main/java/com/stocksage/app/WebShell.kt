package com.stocksage.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.FileNotFoundException

/**
 * The bundled web app (assets/web, built by mobile/web) served from
 * https://appassets.androidplatform.net — a secure origin, so WebCrypto and
 * localStorage work. Unknown paths fall back to index.html for the SPA router.
 */
object WebShell {
    const val ORIGIN = "https://appassets.androidplatform.net"
    const val HOST = "appassets.androidplatform.net"

    private val MIME = mapOf(
        "html" to "text/html", "js" to "text/javascript", "css" to "text/css", "json" to "application/json",
        "svg" to "image/svg+xml", "png" to "image/png", "ico" to "image/x-icon", "woff2" to "font/woff2",
        "woff" to "font/woff", "txt" to "text/plain",
    )

    fun serve(context: Context, url: Uri): WebResourceResponse? {
        if (url.host != HOST) return null
        val path = url.path?.trimStart('/').orEmpty()
        val asset = if (path.isEmpty() || !path.substringAfterLast('/').contains('.')) "index.html" else path
        return try {
            val stream = context.assets.open("web/$asset")
            val ext = asset.substringAfterLast('.', "")
            WebResourceResponse(MIME[ext] ?: "application/octet-stream", "utf-8", stream).apply {
                responseHeaders = mapOf("Cache-Control" to if (asset == "index.html") "no-cache" else "max-age=31536000")
            }
        } catch (e: FileNotFoundException) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun configure(view: WebView, bridge: NativeBridge) {
        view.setBackgroundColor(Color.parseColor("#090C16"))
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            textZoom = 100
            setGeolocationEnabled(false)
        }
        view.isVerticalScrollBarEnabled = false
        view.overScrollMode = WebView.OVER_SCROLL_NEVER
        view.addJavascriptInterface(bridge, "StockSageNative")
    }

    open class Client(private val context: Context) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            serve(context, request.url)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (request.url.host == HOST) return false
            NativeBridge(context, { view }, object : NativeBridge.Host {}).openExternal(request.url.toString())
            return true
        }
    }
}
