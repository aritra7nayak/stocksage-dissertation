package com.stocksage.app

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileInputStream
import java.nio.LongBuffer
import java.nio.channels.FileChannel

/**
 * ProsusAI/finbert on the phone: 8-bit weights + fp16 embeddings ONNX
 * (mobile/scripts/export_finbert.py), run by onnxruntime on the CPU.
 * Tokenization happens in TypeScript; this takes token ids, returns logits.
 * The model is memory-mapped straight from the (uncompressed) APK asset and
 * released after a few idle minutes to give the RAM back.
 */
object FinBert {
    private const val MODEL = "finbert/model.onnx"
    private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
    private var session: OrtSession? = null
    private val idle = Handler(Looper.getMainLooper())
    private val release = Runnable { synchronized(this) { session?.close(); session = null } }

    fun assets(context: Context): JSONObject {
        val am = context.assets
        val vocab = am.open("finbert/vocab.txt").bufferedReader().use { it.readText() }
        val labels = am.open("finbert/labels.json").bufferedReader().use { JSONArray(it.readText()) }
        return JSONObject().put("ok", true).put("vocab", vocab).put("labels", labels)
    }

    @Synchronized
    private fun session(context: Context): OrtSession {
        session?.let { return it }
        val fd = context.assets.openFd(MODEL)
        val buffer = FileInputStream(fd.fileDescriptor).channel.use { ch ->
            ch.map(FileChannel.MapMode.READ_ONLY, fd.startOffset, fd.declaredLength)
        }
        val opts = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(Runtime.getRuntime().availableProcessors().coerceIn(2, 4))
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        }
        return env.createSession(buffer, opts).also { session = it }
    }

    fun run(context: Context, payload: JSONObject): JSONObject {
        val ids = payload.getJSONArray("input_ids")
        val mask = payload.getJSONArray("attention_mask")
        val batch = ids.length()
        val seq = ids.getJSONArray(0).length()
        val idBuf = LongBuffer.allocate(batch * seq)
        val maskBuf = LongBuffer.allocate(batch * seq)
        for (b in 0 until batch) {
            val ri = ids.getJSONArray(b)
            val rm = mask.getJSONArray(b)
            for (t in 0 until seq) {
                idBuf.put(ri.getLong(t))
                maskBuf.put(rm.getLong(t))
            }
        }
        idBuf.rewind(); maskBuf.rewind()
        val shape = longArrayOf(batch.toLong(), seq.toLong())
        val logits = JSONArray()
        synchronized(this) {
            idle.removeCallbacks(release)
            val s = session(context)
            OnnxTensor.createTensor(env, idBuf, shape).use { tIds ->
                OnnxTensor.createTensor(env, maskBuf, shape).use { tMask ->
                    OnnxTensor.createTensor(env, LongBuffer.allocate(batch * seq), shape).use { tType ->
                        val inputs = mutableMapOf<String, OnnxTensor>("input_ids" to tIds, "attention_mask" to tMask)
                        if ("token_type_ids" in s.inputNames) inputs["token_type_ids"] = tType
                        s.run(inputs).use { out ->
                            @Suppress("UNCHECKED_CAST")
                            val rows = out[0].value as Array<FloatArray>
                            rows.forEach { r -> logits.put(JSONArray(r.map { it.toDouble() })) }
                        }
                    }
                }
            }
            idle.postDelayed(release, 3 * 60_000L)
        }
        return JSONObject().put("ok", true).put("logits", logits)
    }
}
