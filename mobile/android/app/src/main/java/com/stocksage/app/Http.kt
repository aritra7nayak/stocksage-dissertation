package com.stocksage.app

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.Charset

/**
 * Plain HTTP for the TypeScript backend: no browser CORS, cookies kept by the
 * process-wide CookieManager (see StockSageApp), redirects followed by hand so
 * cookies set on every hop are honoured. gzip is decoded transparently.
 */
object Http {
    fun request(spec: JSONObject): JSONObject {
        var url = spec.getString("url")
        val method = spec.optString("method", "GET")
        val headers = spec.optJSONObject("headers")
        val body: String? = if (spec.has("body") && !spec.isNull("body")) spec.getString("body") else null
        val timeout = spec.optInt("timeoutMs", 20000)

        repeat(6) {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                instanceFollowRedirects = false
                connectTimeout = timeout
                readTimeout = timeout
                headers?.keys()?.forEach { k -> setRequestProperty(k, headers.getString(k)) }
            }
            try {
                if (body != null) {
                    conn.doOutput = true
                    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = conn.responseCode
                val location = conn.getHeaderField("Location")
                if (status in 300..399 && location != null) {
                    url = URL(URL(url), location).toString()
                    return@repeat
                }
                val stream = if (status >= 400) conn.errorStream else conn.inputStream
                val bytes = stream?.use { input ->
                    val out = ByteArrayOutputStream()
                    input.copyTo(out)
                    out.toByteArray()
                } ?: ByteArray(0)
                val charset = Regex("charset=([^;]+)", RegexOption.IGNORE_CASE)
                    .find(conn.contentType ?: "")?.groupValues?.get(1)?.trim()?.trim('"')
                    ?.let { runCatching { Charset.forName(it) }.getOrNull() } ?: Charsets.UTF_8
                val outHeaders = JSONObject()
                conn.headerFields.forEach { (k, v) -> if (k != null) outHeaders.put(k.lowercase(), v.joinToString(", ")) }
                return JSONObject()
                    .put("ok", true)
                    .put("status", status)
                    .put("headers", outHeaders)
                    .put("body", String(bytes, charset))
            } finally {
                conn.disconnect()
            }
        }
        throw IllegalStateException("Too many redirects for $url")
    }
}
