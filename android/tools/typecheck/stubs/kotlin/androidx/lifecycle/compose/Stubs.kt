package androidx.lifecycle.compose
import androidx.compose.runtime.Composable
// lifecycle-runtime-compose's start/stop effect, reduced to the shape the app calls (the real
// onStopOrDispose block has a LifecycleOwner receiver; a plain lambda compiles against both).
class LifecycleStopOrDisposeEffectResult
open class LifecycleStartStopEffectScope {
    fun onStopOrDispose(onStopOrDisposeEffect: () -> Unit): LifecycleStopOrDisposeEffectResult = LifecycleStopOrDisposeEffectResult()
}
@Composable fun LifecycleStartEffect(key1: Any?, effects: LifecycleStartStopEffectScope.() -> LifecycleStopOrDisposeEffectResult) {}
