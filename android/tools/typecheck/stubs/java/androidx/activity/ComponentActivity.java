package androidx.activity;
import android.content.Intent;
import androidx.activity.result.ActivityResultCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContract;
public class ComponentActivity extends android.app.Activity {
  public final <I, O> ActivityResultLauncher<I> registerForActivityResult(ActivityResultContract<I, O> contract, ActivityResultCallback<O> callback) { return null; }
  @Override protected void onNewIntent(Intent intent) {}
}
