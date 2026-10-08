package androidx.work;
public final class OneTimeWorkRequest {
  public static final class Builder {
    public Builder(Class<? extends ListenableWorker> workerClass) {}
    public Builder setExpedited(OutOfQuotaPolicy policy) { return this; }
    public Builder setInputData(Data inputData) { return this; }
    public OneTimeWorkRequest build() { return null; }
  }
}
