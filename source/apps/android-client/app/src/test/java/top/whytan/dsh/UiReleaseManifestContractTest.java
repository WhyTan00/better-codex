package top.whytan.dsh;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Run the installable APK's actual parser, including the stale resource URL regression. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public final class UiReleaseManifestContractTest {
    private static Object parse(JSONObject value) throws Exception {
        Method method = UiReleaseStore.class.getDeclaredMethod("parseManifest", JSONObject.class);
        method.setAccessible(true);
        return method.invoke(null, value);
    }

    private static JSONObject manifest(String resourceVersion) throws Exception {
        String version = "1111111111111111";
        String shell = "/dsh-native-assets/" + version + "/shell.html";
        String asset = "/official-patched-v1016/assets/fixture.js";
        JSONArray files = new JSONArray();
        for (String path : new String[]{shell, asset}) {
            files.put(new JSONObject().put("path", path)
                    .put("url", "/android/ui/" + (path.equals(shell) ? version : resourceVersion) + "/files" + path)
                    .put("sha256", "a".repeat(64)).put("bytes", 1)
                    .put("mime", path.equals(shell) ? "text/html" : "text/javascript"));
        }
        return new JSONObject().put("schemaVersion", 1).put("version", version)
                .put("minAppVersionCode", 17).put("shell", shell).put("files", files);
    }

    @Test public void oldVersionDependencyUrlIsRejectedBeforeDownload() throws Exception {
        assertNotNull(parse(manifest("1111111111111111")));
        try {
            parse(manifest("2222222222222222"));
            fail("A dependency from another release URL must be rejected");
        } catch (InvocationTargetException expected) {
            assertEquals("file contract", expected.getCause().getMessage());
        }
    }

    @Test public void finalPackagedManifestShellAndFilesPassTheApkVerifier() throws Exception {
        String root = System.getenv("DSH_ANDROID_UI_PACKAGE");
        Assume.assumeTrue("Release acceptance supplies the exact final UI package", root != null);
        JSONObject json = new JSONObject(new String(Files.readAllBytes(new File(root, "ui-release.json").toPath()), StandardCharsets.UTF_8));
        Object manifest = parse(json);
        Method verifyShell = UiReleaseStore.class.getDeclaredMethod("verifyShell", manifest.getClass(), File.class);
        verifyShell.setAccessible(true);
        File files = new File(root, "files");
        verifyShell.invoke(null, manifest, files);
        Method verifyFile = UiReleaseStore.class.getDeclaredMethod("verifyFile", File.class, long.class, String.class);
        verifyFile.setAccessible(true);
        JSONArray entries = json.getJSONArray("files");
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i);
            assertTrue("APK verifier rejected " + entry.getString("path"), (Boolean) verifyFile.invoke(null,
                    new File(files, entry.getString("path").substring(1)), entry.getLong("bytes"), entry.getString("sha256")));
        }
    }
}
