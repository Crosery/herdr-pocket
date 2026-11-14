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
