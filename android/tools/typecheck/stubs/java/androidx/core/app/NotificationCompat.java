package androidx.core.app;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
public class NotificationCompat {
  public static final int VISIBILITY_PUBLIC = Notification.VISIBILITY_PUBLIC;
  public static final int VISIBILITY_PRIVATE = Notification.VISIBILITY_PRIVATE;
  public static final int VISIBILITY_SECRET = Notification.VISIBILITY_SECRET;
  public abstract static class Style {}
  public static class BigTextStyle extends Style { public BigTextStyle bigText(CharSequence cs) { return this; } }
  public static class Action {
    public static final class Builder {
      public Builder(int icon, CharSequence title, PendingIntent intent) {}
      public Builder setAuthenticationRequired(boolean authenticationRequired) { return this; }
      public Action build() { return null; }
    }
  }
  public static class Builder {
    public Builder(Context context, String channelId) {}
    public Builder setSmallIcon(int icon) { return this; }
    public Builder setContentTitle(CharSequence title) { return this; }
    public Builder setContentText(CharSequence text) { return this; }
    public Builder setStyle(Style style) { return this; }
    public Builder setSubText(CharSequence text) { return this; }
    public Builder setWhen(long when) { return this; }
    public Builder setAutoCancel(boolean autoCancel) { return this; }
    public Builder setContentIntent(PendingIntent intent) { return this; }
    public Builder setVisibility(int visibility) { return this; }
    public Builder setPublicVersion(Notification n) { return this; }
    public Builder addAction(Action action) { return this; }
    public Builder setOnlyAlertOnce(boolean onlyAlertOnce) { return this; }
    public Builder setSilent(boolean silent) { return this; }
    public Builder setTimeoutAfter(long durationMs) { return this; }
    public Builder setProgress(int max, int progress, boolean indeterminate) { return this; }
    public Notification build() { return null; }
  }
}
