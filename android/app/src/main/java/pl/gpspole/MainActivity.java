package pl.gpspole;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
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

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.Granularity;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.util.Locale;

public class MainActivity extends Activity {
    private static final String START_URL = "https://appassets.androidplatform.net/assets/index.html";
    /** Location request interval: 200 ms = 5 fixes per second. */
    private static final long INTERVAL_MS = 200L;

    private WebView web;
    private Updater updater;
    private GeolocationPermissions.Callback pendingCallback;
    private String pendingOrigin;
    private LocationManager locationManager;
    private FusedLocationProviderClient fused;
    private boolean gpsRunning = false, fusedRunning = false, gnssRunning = false;
    private volatile long lastFusedAt = 0, lastFixTime = 0, lastSatsAt = 0;

    /** Sends one fix to the page. Fused (GPS + phone sensors) is preferred; the raw GPS chip fills in when fused goes quiet. */
    private void sendFix(Location l, boolean fromFused) {
        if (web == null || l == null) return;
        long now = SystemClock.elapsedRealtime();
        if (fromFused) lastFusedAt = now;
        else if (now - lastFusedAt < 1500) return;
        if (l.getTime() <= lastFixTime) return;          // drop duplicates and out-of-order fixes
        lastFixTime = l.getTime();
        String js = String.format(Locale.US,
                "window.nativeFix&&nativeFix(%.9f,%.9f,%.2f,%.3f,%.1f,%d)",
                l.getLatitude(), l.getLongitude(),
                l.hasAccuracy() ? l.getAccuracy() : 5.0f,
                l.hasSpeed() ? l.getSpeed() : -1.0f,
                l.hasBearing() ? l.getBearing() : -1.0f,
                l.getTime());
        web.evaluateJavascript(js, null);
    }

    private final LocationCallback fusedCallback = new LocationCallback() {
        @Override
        public void onLocationResult(LocationResult result) {
            for (Location l : result.getLocations()) sendFix(l, true);
        }
    };

    private final LocationListener gpsListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location l) { sendFix(l, false); }

        @Override
        public void onProviderDisabled(String provider) {
            status("Lokalizacja w telefonie jest wyłączona. Włącz ją w szybkich ustawieniach.");
        }

        @Override
        public void onProviderEnabled(String provider) { status("Szukam satelitów…"); }

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) { }
    };

    private final GnssStatus.Callback gnssCallback = new GnssStatus.Callback() {
        @Override
        public void onSatelliteStatusChanged(GnssStatus st) {
            long now = SystemClock.elapsedRealtime();
            if (now - lastSatsAt < 1000 || web == null) return;
            lastSatsAt = now;
            int used = 0, n = st.getSatelliteCount();
            for (int i = 0; i < n; i++) if (st.usedInFix(i)) used++;
            web.evaluateJavascript("window.nativeSats&&nativeSats(" + used + "," + n + ")", null);
        }
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
        if (!hasLocation()) return;
        if (!fusedRunning) {
            try {
                if (fused == null) fused = LocationServices.getFusedLocationProviderClient(this);
                LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVAL_MS)
                        .setMinUpdateIntervalMillis(100)
                        .setMaxUpdateDelayMillis(0)
                        .setMinUpdateDistanceMeters(0f)
                        .setWaitForAccurateLocation(false)
                        .setGranularity(Granularity.GRANULARITY_FINE)
                        .build();
                fused.requestLocationUpdates(req, fusedCallback, Looper.getMainLooper())
                        .addOnFailureListener(e -> fusedRunning = false);
                fusedRunning = true;
            } catch (Throwable e) {          // no Google Play services on this phone
                fusedRunning = false;
            }
        }
        if (!gpsRunning) {
            try {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER,
                        INTERVAL_MS, 0f, gpsListener, Looper.getMainLooper());
                gpsRunning = true;
            } catch (SecurityException | IllegalArgumentException e) {
                gpsRunning = false;
            }
        }
        if (!gnssRunning) {
            try {
                gnssRunning = locationManager.registerGnssStatusCallback(gnssCallback, new Handler(Looper.getMainLooper()));
            } catch (SecurityException e) {
                gnssRunning = false;
            }
        }
    }

    private void stopGps() {
        if (fusedRunning && fused != null) fused.removeLocationUpdates(fusedCallback);
        fusedRunning = false;
        if (gpsRunning) locationManager.removeUpdates(gpsListener);
        gpsRunning = false;
        if (gnssRunning) locationManager.unregisterGnssStatusCallback(gnssCallback);
        gnssRunning = false;
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
