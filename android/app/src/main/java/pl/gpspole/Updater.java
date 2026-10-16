package pl.gpspole;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Checks GitHub releases of Viamio/obora for a newer "gps-pole-N" build and installs it. */
public class Updater {
    private static final String RELEASES = "https://api.github.com/repos/Viamio/obora/releases?per_page=30";
    private static final String TAG_PREFIX = "gps-pole-";

    private final Activity activity;
    private final WebView web;
    private volatile String apkUrl;
    private volatile int latest;
    private volatile boolean busy;

    Updater(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    private void js(final String code) {
        activity.runOnUiThread(() -> web.evaluateJavascript(code, null));
    }

    private static String q(String s) {
        return JSONObject.quote(s == null ? "" : s);
    }

    @JavascriptInterface
    public int version() {
        return BuildConfig.VERSION_CODE;
    }

    @JavascriptInterface
    public String versionName() {
        return BuildConfig.VERSION_NAME;
    }

    /** quiet=true: called at startup, only reports when an update exists. */
    @JavascriptInterface
    public void check(final boolean quiet) {
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(RELEASES).openConnection();
                c.setRequestProperty("Accept", "application/vnd.github+json");
                c.setRequestProperty("User-Agent", "GpsPole");
                c.setConnectTimeout(10000);
                c.setReadTimeout(15000);
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                InputStream in = c.getInputStream();
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                in.close();
                JSONArray arr = new JSONArray(bo.toString("UTF-8"));
                int best = 0;
                String url = null;
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject r = arr.getJSONObject(i);
                    String tag = r.optString("tag_name");
                    if (!tag.startsWith(TAG_PREFIX) || r.optBoolean("draft")) continue;
                    int num;
                    try { num = Integer.parseInt(tag.substring(TAG_PREFIX.length())); } catch (Exception e) { continue; }
                    JSONArray assets = r.optJSONArray("assets");
                    if (assets == null) continue;
                    for (int a = 0; a < assets.length(); a++) {
                        JSONObject as = assets.getJSONObject(a);
                        if (as.optString("name").endsWith(".apk") && num > best) {
                            best = num;
                            url = as.optString("browser_download_url");
                        }
                    }
                }
                latest = best;
                apkUrl = url;
                boolean available = best > BuildConfig.VERSION_CODE && url != null;
                if (available || !quiet) {
                    js("window.onUpdateInfo&&onUpdateInfo(" + available + "," + BuildConfig.VERSION_CODE + "," + best + "," + quiet + ")");
                }
            } catch (Exception e) {
                if (!quiet) js("window.onUpdateError&&onUpdateError(" + q("Nie udało się sprawdzić aktualizacji. Sprawdź internet i spróbuj ponownie.") + ")");
            }
        }).start();
    }

    @JavascriptInterface
    public void install() {
        if (busy) return;
        if (apkUrl == null) {
            js("window.onUpdateError&&onUpdateError(" + q("Najpierw sprawdź, czy jest nowa wersja.") + ")");
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            js("window.onUpdateError&&onUpdateError(" + q("Zezwól aplikacji GPS Pole na instalowanie aplikacji, wróć i naciśnij „Zainstaluj” jeszcze raz.") + ")");
            activity.runOnUiThread(() -> activity.startActivity(new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()))));
            return;
        }
        busy = true;
        new Thread(() -> {
            try {
                File dir = new File(activity.getCacheDir(), "updates");
                if (!dir.exists()) dir.mkdirs();
                File out = new File(dir, "GPS-Pole.apk");
                HttpURLConnection c = (HttpURLConnection) new URL(apkUrl).openConnection();
                c.setInstanceFollowRedirects(true);
                c.setRequestProperty("User-Agent", "GpsPole");
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                int code = c.getResponseCode();
                if (code / 100 == 3) {
                    String loc = c.getHeaderField("Location");
                    c.disconnect();
                    c = (HttpURLConnection) new URL(loc).openConnection();
                    c.setRequestProperty("User-Agent", "GpsPole");
                    code = c.getResponseCode();
                }
                if (code != 200) throw new Exception("HTTP " + code);
                long total = c.getContentLengthLong();
                InputStream in = c.getInputStream();
                FileOutputStream fo = new FileOutputStream(out);
                byte[] buf = new byte[16384];
                long done = 0;
                int n, lastPct = -1;
                while ((n = in.read(buf)) > 0) {
                    fo.write(buf, 0, n);
                    done += n;
                    if (total > 0) {
                        int pct = (int) (done * 100 / total);
                        if (pct != lastPct) { lastPct = pct; js("window.onUpdateProgress&&onUpdateProgress(" + pct + ")"); }
                    }
                }
                fo.close();
                in.close();
                Uri uri = FileProvider.getUriForFile(activity, "pl.gpspole.files", out);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                js("window.saveNow&&saveNow();window.onUpdateProgress&&onUpdateProgress(100)");
                activity.runOnUiThread(() -> activity.startActivity(i));
            } catch (Exception e) {
                js("window.onUpdateError&&onUpdateError(" + q("Pobieranie nie powiodło się. Spróbuj ponownie.") + ")");
            } finally {
                busy = false;
            }
        }).start();
    }
}
