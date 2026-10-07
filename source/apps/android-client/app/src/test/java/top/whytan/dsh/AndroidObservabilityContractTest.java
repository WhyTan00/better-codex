package top.whytan.dsh;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.net.Uri;
import android.webkit.WebViewClient;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Focused contract checks for native page ownership and bounded WebView failures. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public final class AndroidObservabilityContractTest {
    @Test
    public void pageCallbacksAreBoundToTheLatestStartedUrl() {
        assertTrue(MainActivity.isCurrentPageCallbackUrl(
                "https://workbench.example.test/local/current?workspace=ai",
                "https://workbench.example.test/local/current?workspace=ai"));
        assertTrue(!MainActivity.isCurrentPageCallbackUrl(
                "https://workbench.example.test/local/old?workspace=ai",
                "https://workbench.example.test/local/current?workspace=ai"));
        assertTrue(!MainActivity.isCurrentPageCallbackUrl(null, "https://workbench.example.test/"));
        assertTrue(!MainActivity.isCurrentPageCallbackUrl("https://workbench.example.test/", null));
    }

    @Test
    public void threadIdentityIsAcceptedOnlyForScopedConversationPaths() {
        String thread = "01234567-89ab-cdef-0123-456789abcdef";
        assertEquals(thread, MainActivity.threadIdFromUri(Uri.parse(
                "https://workbench.example.test/local/" + thread + "?workspace=ai")));
        assertNull(MainActivity.threadIdFromUri(Uri.parse(
                "https://workbench.example.test/local/not-a-thread?workspace=ai")));
        assertNull(MainActivity.threadIdFromUri(Uri.parse(
                "https://login.example.test/local/" + thread)));
        assertNull(MainActivity.threadIdFromUri(null));
    }

    @Test
    public void webViewNegativeErrorsMapToBoundedClassesWithoutRawText() {
        assertEquals("dns", MainActivity.failureClassForWebError(WebViewClient.ERROR_HOST_LOOKUP, null));
        assertEquals("tls", MainActivity.failureClassForWebError(WebViewClient.ERROR_FAILED_SSL_HANDSHAKE, null));
        assertEquals("timeout", MainActivity.failureClassForWebError(WebViewClient.ERROR_TIMEOUT, null));
        assertEquals("connection", MainActivity.failureClassForWebError(WebViewClient.ERROR_CONNECT, null));
        assertEquals("aborted", MainActivity.failureClassForWebError(WebViewClient.ERROR_UNKNOWN, "net::ERR_ABORTED"));
        assertEquals("unknown", MainActivity.failureClassForWebError(WebViewClient.ERROR_UNKNOWN, "private raw error"));
        assertEquals("unknown", MainActivity.failureClassForWebError(0, null));
    }
}
