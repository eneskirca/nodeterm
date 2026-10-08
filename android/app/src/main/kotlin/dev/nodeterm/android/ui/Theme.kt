package dev.nodeterm.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.nodeterm.protocol.model.SessionBucket

/** The desktop's dark palette (styles.css `:root`, Apple system colours). */
object NtColors {
    val accent = Color(0xFF0A84FF)
    val working = Color(0xFFD97757)
    val attention = Color(0xFFFF453A)
    val warning = Color(0xFFFF9F0A)
    val success = Color(0xFF32D74B)
    val muted = Color(0xFF8E8E93)
    val panel = Color(0xFF1C1C1E)
    val panel2 = Color(0xFF2C2C2E)
    val canvas = Color(0xFF000000)
    val text = Color(0xFFE6E6E6)
}

private val scheme = darkColorScheme(
    primary = NtColors.accent,
    onPrimary = Color.White,
    secondary = NtColors.working,
    background = NtColors.canvas,
    onBackground = NtColors.text,
    surface = NtColors.panel,
    onSurface = NtColors.text,
    surfaceVariant = NtColors.panel2,
    onSurfaceVariant = Color(0xFFB0B0B5),
    error = NtColors.attention
)

@Composable
fun NodetermTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, content = content)
}

/** Parse a stored `#rrggbb` node/project colour; anything else falls back. */
fun parseHex(hex: String?, fallback: Color = NtColors.muted): Color {
    val h = hex?.trim()?.removePrefix("#") ?: return fallback
    if (h.length != 6) return fallback
    val v = h.toLongOrNull(16) ?: return fallback
    return Color(0xFF000000 or v)
}

@Composable
fun ColorDot(color: Color, size: Int = 10) {
    Box(Modifier.size(size.dp).clip(CircleShape).background(color))
}

/** The RUNNING / NEEDS YOU / SLEEPING badges the canvas header shows. */
@Composable
fun StatusBadge(bucket: SessionBucket?) {
    val (label, color) = when (bucket) {
        SessionBucket.RUNNING -> "RUNNING" to NtColors.working
        SessionBucket.NEEDS_YOU -> "NEEDS YOU" to NtColors.attention
        SessionBucket.SLEEPING -> "SLEEPING" to NtColors.muted
        else -> return
    }
    Text(
        label,
        color = color,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(color.copy(alpha = 0.16f))
            .padding(horizontal = 6.dp, vertical = 2.dp)
    )
}

/** Short relative age ("now", "5m", "3h", "2d") for session rows and inbox cards. */
fun relativeAge(ts: Long, now: Long = System.currentTimeMillis()): String {
    if (ts <= 0) return ""
    val s = (now - ts) / 1000
    return when {
        s < 45 -> "now"
        s < 3600 -> "${s / 60}m"
        s < 86_400 -> "${s / 3600}h"
        else -> "${s / 86_400}d"
    }
}
