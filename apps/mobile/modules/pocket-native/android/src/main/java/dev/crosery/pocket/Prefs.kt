package dev.crosery.pocket

import android.content.Context
import android.content.SharedPreferences

/** What the background service needs after the app process is gone (app-private storage). */
class Prefs(ctx: Context) {
  private val p: SharedPreferences = ctx.applicationContext.getSharedPreferences("pocket_native", Context.MODE_PRIVATE)

  var server: String?
    get() = p.getString("server", null)
    set(v) = p.edit().putString("server", v).apply()

  var token: String?
    get() = p.getString("token", null)
    set(v) = p.edit().putString("token", v).apply()

  var notify: Boolean
    get() = p.getBoolean("notify", false)
    set(v) = p.edit().putBoolean("notify", v).apply()

  var kinds: Set<String>
    get() = p.getStringSet("kinds", setOf("blocked", "done", "reminder")) ?: emptySet()
    set(v) = p.edit().putStringSet("kinds", v).apply()

  /** Newest notice seen, so a reconnect only replays what was missed. */
  var lastTs: Long
    get() = p.getLong("lastTs", 0L)
    set(v) = p.edit().putLong("lastTs", v).apply()

  var recentIds: List<String>
    get() = (p.getString("recentIds", "") ?: "").split(",").filter { it.isNotEmpty() }
    set(v) = p.edit().putString("recentIds", v.takeLast(60).joinToString(",")).apply()

  var assistantName: String
    get() = p.getString("assistantName", "小羊") ?: "小羊"
    set(v) = p.edit().putString("assistantName", v).apply()

  var voiceDenoise: Boolean
    get() = p.getBoolean("voiceDenoise", true)
    set(v) = p.edit().putBoolean("voiceDenoise", v).apply()

  var voiceFilter: Boolean
    get() = p.getBoolean("voiceFilter", true)
    set(v) = p.edit().putBoolean("voiceFilter", v).apply()

  var voiceThreshold: Float
    get() = p.getFloat("voiceThreshold", 0.38f)
    set(v) = p.edit().putFloat("voiceThreshold", v).apply()

  /** "auto" | "denoise" | "sv" | "tse" */
  var voiceTier: String
    get() = p.getString("voiceTier", "auto") ?: "auto"
    set(v) = p.edit().putString("voiceTier", v).apply()

  var voiceFirstSpeaker: Boolean
    get() = p.getBoolean("voiceFirstSpeaker", false)
    set(v) = p.edit().putBoolean("voiceFirstSpeaker", v).apply()

  var lastCallTseRtf: Float
    get() = p.getFloat("lastCallTseRtf", -1f)
    set(v) = p.edit().putFloat("lastCallTseRtf", v).apply()

  var benchRecommendedTier: String?
    get() = p.getString("benchRecommendedTier", null)
    set(v) = p.edit().putString("benchRecommendedTier", v).apply()

  var benchReason: String?
    get() = p.getString("benchReason", null)
    set(v) = p.edit().putString("benchReason", v).apply()

  var benchDpdfUs: Float
    get() = p.getFloat("benchDpdfUs", -1f)
    set(v) = p.edit().putFloat("benchDpdfUs", v).apply()

  var benchTseRtf: Float
    get() = p.getFloat("benchTseRtf", -1f)
    set(v) = p.edit().putFloat("benchTseRtf", v).apply()

  var benchAt: Long
    get() = p.getLong("benchAt", 0L)
    set(v) = p.edit().putLong("benchAt", v).apply()

  var voiceEmbedding: FloatArray?
    get() {
      val s = p.getString("voiceEmbedding", null) ?: return null
      if (s.isEmpty()) return null
      return try {
        s.split(",").map { it.toFloat() }.toFloatArray().takeIf { it.isNotEmpty() }
      } catch (_: Throwable) {
        null
      }
    }
    set(v) {
      if (v == null || v.isEmpty()) p.edit().remove("voiceEmbedding").apply()
      else p.edit().putString("voiceEmbedding", v.joinToString(",") { "%.7g".format(java.util.Locale.US, it) }).apply()
    }

  var voicePrototypes: List<FloatArray>?
    get() {
      val s = p.getString("voicePrototypes", null) ?: return null
      if (s.isEmpty()) return null
      return try {
        s.split(";").mapNotNull { row ->
          if (row.isEmpty()) null
          else row.split(",").map { it.toFloat() }.toFloatArray().takeIf { it.isNotEmpty() }
        }.takeIf { it.isNotEmpty() }
      } catch (_: Throwable) {
        null
      }
    }
    set(v) {
      if (v.isNullOrEmpty()) p.edit().remove("voicePrototypes").apply()
      else {
        val encoded = v.joinToString(";") { arr -> arr.joinToString(",") { "%.7g".format(java.util.Locale.US, it) } }
        p.edit().putString("voicePrototypes", encoded).apply()
      }
    }

  var voiceModelVersion: String?
    get() = p.getString("voiceModelVersion", null)
    set(v) {
      if (v.isNullOrEmpty()) p.edit().remove("voiceModelVersion").apply()
      else p.edit().putString("voiceModelVersion", v).apply()
    }
}

/** Events for the JS side, delivered while the app's module is alive. */
object PocketBus {
  @Volatile var listener: ((String, Map<String, Any?>) -> Unit)? = null

  fun emit(name: String, body: Map<String, Any?>) {
    try {
      listener?.invoke(name, body)
    } catch (_: Throwable) {
      // The JS runtime may be going away; the service keeps running regardless.
    }
  }
}

fun wsUrl(server: String, path: String): String {
  val base = server.trimEnd('/')
  return when {
    base.startsWith("https://", ignoreCase = true) -> "wss://" + base.substring(8)
    base.startsWith("http://", ignoreCase = true) -> "ws://" + base.substring(7)
    else -> base
  } + path
}
