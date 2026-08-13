package care.bramble.spending;

import android.content.ComponentName;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

public class BankNotificationListener extends NotificationListenerService {

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        NotificationHealthStore.recordListenerConnected(this);
    }

    @Override
    public void onListenerDisconnected() {
        super.onListenerDisconnected();
        NotificationHealthStore.recordListenerDisconnected(this);
        // Some OEMs (background-battery-optimisation killers) unbind
        // notification listeners without the user ever revoking access.
        // Asking the system to rebind here is the pattern Android's own docs
        // recommend, rather than waiting for the user to notice and re-open
        // notification-access settings themselves.
        requestRebind(new ComponentName(this, BankNotificationListener.class));
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        BankNotificationStore.recordNotification(this, sbn);
    }
}
