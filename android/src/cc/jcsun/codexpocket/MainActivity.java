package cc.jcsun.codexpocket;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private static final String HOST = "pocket.jcsun.cc";
    private static final String HOME_URL = "https://" + HOST + "/";

    private WebView webView;
    private ProgressBar loading;
    private View failure;
    private String retryUrl = HOME_URL;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.pocket_background));
        if (Build.VERSION.SDK_INT >= 35) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets padding = insets.getInsets(WindowInsets.Type.systemBars()
                    | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        webView = new WebView(this);
        webView.setBackgroundColor(getColor(R.color.pocket_background));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);
        webView.setWebViewClient(new PocketWebViewClient());
        root.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        loading = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        loading.setIndeterminate(true);
        loading.setContentDescription(getString(R.string.loading));
        root.addView(loading, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP));

        failure = buildFailureView();
        failure.setVisibility(View.GONE);
        root.addView(failure, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        webView.loadUrl(HOME_URL);
    }

    private View buildFailureView() {
        LinearLayout panel = new LinearLayout(this);
        panel.setBackgroundColor(getColor(R.color.pocket_background));
        panel.setGravity(Gravity.CENTER);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(24), dp(16), dp(24), dp(16));
        TextView message = new TextView(this);
        message.setText(R.string.offline_message);
        message.setTextSize(16);
        message.setGravity(Gravity.CENTER);
        message.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        panel.addView(message, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setMinHeight(dp(48));
        retry.setOnClickListener(view -> webView.loadUrl(retryUrl));
        LinearLayout.LayoutParams buttonLayout = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        buttonLayout.topMargin = dp(12);
        panel.addView(retry, buttonLayout);
        return panel;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    static boolean isPocketUrl(Uri url) {
        return "https".equalsIgnoreCase(url.getScheme())
            && HOST.equalsIgnoreCase(url.getHost())
            && url.getUserInfo() == null
            && (url.getPort() == -1 || url.getPort() == 443);
    }

    private void showFailure(Uri url) {
        if (isPocketUrl(url)) retryUrl = url.toString();
        loading.setVisibility(View.GONE);
        failure.setVisibility(View.VISIBLE);
    }

    private final class PocketWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (isPocketUrl(url)) return false;
            if (request.isForMainFrame() && request.hasGesture()
                && "https".equalsIgnoreCase(url.getScheme()) && url.getUserInfo() == null) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException ignored) {
                    // The installed browser determines external link availability.
                }
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap icon) {
            failure.setVisibility(View.GONE);
            loading.setVisibility(View.VISIBLE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            loading.setVisibility(View.GONE);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showFailure(request.getUrl());
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 500) showFailure(request.getUrl());
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onStop() {
        super.onStop();
        CookieManager.getInstance().flush();
    }
}
