# The WebView calls these by name.
-keepclassmembers class com.stocksage.app.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
# onnxruntime's JNI layer looks up its Java classes reflectively.
-keep class ai.onnxruntime.** { *; }
