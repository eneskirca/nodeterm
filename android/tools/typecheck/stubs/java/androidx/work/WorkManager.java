package androidx.work;
import android.content.Context;
public abstract class WorkManager {
  public static WorkManager getInstance(Context context) { return null; }
  public abstract Object cancelUniqueWork(String uniqueWorkName);
  public abstract Object enqueueUniquePeriodicWork(String uniqueWorkName, ExistingPeriodicWorkPolicy policy, PeriodicWorkRequest request);
  public final Object enqueueUniqueWork(String uniqueWorkName, ExistingWorkPolicy existingWorkPolicy, OneTimeWorkRequest work) { return null; }
}
