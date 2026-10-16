package pl.gpspole;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;
import android.view.Display;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.util.Locale;

public class MainActivity extends Activity {
    private static final String START_URL = "https://appassets.androidplatform.net/assets/index.html";
    /** GPS module read interval: 33 ms = up to 30 fixes per second (the chip delivers what it can). */
    private static final long GPS_INTERVAL_MS = 33L;

    private WebView web;
    private Updater updater;
    private GeolocationPermissions.Callback pendingCallback;
    private String pendingOrigin;
    private LocationManager locationManager;
    private boolean gpsRunning = false;

    private final LocationListener gpsListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location l) {
            if (web == null) return;
            String js = String.format(Locale.US,
                    "window.nativeFix&&nativeFix(%.9f,%.9f,%.2f,%.3f,%.1f,%d)",
                    l.getLatitude(), l.getLongitude(),
                    l.hasAccuracy() ? l.getAccuracy() : 5.0f,
                    l.hasSpeed() ? l.getSpeed() : -1.0f,
                    l.hasBearing() ? l.getBearing() : -1.0f,
                    l.getTime());
            web.evaluateJavascript(js, null);
        }

        @Override
        public void onProviderDisabled(String provider) {
            status("Lokalizacja w telefonie jest wyłączona. Włącz ją w szybkich ustawieniach.");
        }

        @Override
        public void onProviderEnabled(String provider) {
            status("Szukam satelitów…");
        }

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) { }
    };

    private void status(String msg) {
        if (web == null) return;
        String safe = msg.replace("\\", "\\\\").replace("'", "\\'");
        web.evaluateJavascript("window.nativeGpsStatus&&nativeGpsStatus('" + safe + "')", null);
    }

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void askLocation() {
        requestPermissions(new String[]{
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION}, 1);
    }

    private void startGps() {
        if (gpsRunning || !hasLocation()) return;
        try {
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER,
                    GPS_INTERVAL_MS, 0f, gpsListener, Looper.getMainLooper());
            gpsRunning = true;
        } catch (SecurityException | IllegalArgumentException e) {
            gpsRunning = false;
        }
    }

    private void stopGps() {
        if (!gpsRunning) return;
        locationManager.removeUpdates(gpsListener);
        gpsRunning = false;
    }

    /** Ask the display for its highest refresh rate (90/120 Hz on phones that have it). */
    private void requestHighRefreshRate() {
        try {
            Display d = getWindowManager().getDefaultDisplay();
            Display.Mode cur = d.getMode();
            Display.Mode best = cur;
            for (Display.Mode m : d.getSupportedModes()) {
                if (m.getPhysicalWidth() == cur.getPhysicalWidth()
                        && m.getPhysicalHeight() == cur.getPhysicalHeight()
                        && m.getRefreshRate() > best.getRefreshRate()) {
                    best = m;
                }
            }
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.preferredDisplayModeId = best.getModeId();
            lp.preferredRefreshRate = best.getRefreshRate();
            getWindow().setAttributes(lp);
        } catch (Exception ignored) { }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
        requestHighRefreshRate();
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(0xFF0E130F);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(false);
        updater = new Updater(this, web);
        web.addJavascriptInterface(updater, "AppUpdate");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocation()) {
                    callback.invoke(origin, true, true);
                } else {
                    pendingCallback = callback;
                    pendingOrigin = origin;
                    askLocation();
                }
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(START_URL);

        if (!hasLocation()) askLocation();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        boolean ok = hasLocation();
        if (pendingCallback != null) {
            pendingCallback.invoke(pendingOrigin, ok, true);
            pendingCallback = null;
        }
        if (ok) startGps();
    }

    @Override
    protected void onResume() {
        super.onResume();
        requestHighRefreshRate();
        startGps();
    }

    @Override
    protected void onPause() {
        stopGps();
        super.onPause();
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        if (updater != null && Updater.INSTALL_STATUS.equals(intent.getAction())) updater.onInstallStatus(intent);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
