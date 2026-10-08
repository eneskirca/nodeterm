package androidx.work;
import java.util.concurrent.TimeUnit;
public final class PeriodicWorkRequest {
  public static final class Builder {
    public Builder(Class<? extends ListenableWorker> workerClass, long repeatInterval, TimeUnit repeatIntervalTimeUnit) {}
    public Builder setConstraints(Constraints c) { return this; }
    public PeriodicWorkRequest build() { return null; }
  }
}
