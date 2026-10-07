package top.whytan.dsh;

import static org.junit.Assert.*;
import android.content.Context;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public final class UiReleaseStartupIntegrityTest {
    private File release(Context context, String version, String contents) throws Exception {
        File root = new File(context.getFilesDir(), "ui-releases");
        String shell = "/dsh-native-assets/" + version + "/shell.html";
        File directory = new File(root, version), file = new File(directory, "files" + shell);
        assertTrue(file.getParentFile().mkdirs());
        byte[] body = contents.getBytes(StandardCharsets.UTF_8);Files.write(file.toPath(), body);
        StringBuilder hash = new StringBuilder();for(byte b : MessageDigest.getInstance("SHA-256").digest(body))hash.append(String.format("%02x",b & 255));
        JSONObject entry = new JSONObject().put("path",shell).put("url","/android/ui/"+version+"/files"+shell).put("bytes",body.length).put("sha256",hash.toString()).put("mime","text/html");
        JSONObject manifest = new JSONObject().put("schemaVersion",1).put("version",version).put("shell",shell).put("minAppVersionCode",1).put("files",new JSONArray().put(entry));
        Files.write(new File(directory,"ui-release.json").toPath(),manifest.toString().getBytes(StandardCharsets.UTF_8));return file;
    }
    @Test public void corruptActiveFallsBackOnlyToFullyVerifiedLastGood() throws Exception {
        Context context = RuntimeEnvironment.getApplication();String old="aaaaaaaaaaaaaaaa",current="bbbbbbbbbbbbbbbb";
        release(context,old,"<html>trusted</html>");File corrupt=release(context,current,"<html>current</html>");
        Files.write(corrupt.toPath(),"<html>changed</html>".getBytes(StandardCharsets.UTF_8));
        File root=new File(context.getFilesDir(),"ui-releases");
        for(String[] marker:new String[][]{{"active.json",current},{"lastgood.json",old}})Files.write(new File(root,marker[0]).toPath(),new JSONObject().put("version",marker[1]).toString().getBytes(StandardCharsets.UTF_8));
        context.getSharedPreferences("ui-install",Context.MODE_PRIVATE).edit().putInt("appVersion",BuildConfig.VERSION_CODE).commit();
        UiReleaseStore store = new UiReleaseStore(context,"ai");
        assertEquals(old,store.activeVersion());assertEquals(old,new JSONObject(new String(Files.readAllBytes(new File(root,"active.json").toPath()),StandardCharsets.UTF_8)).getString("version"));store.close();
    }
    @Test public void invalidLastGoodIsNeverExposedAsTrustedRelease() throws Exception {
        Context context = RuntimeEnvironment.getApplication();String old="cccccccccccccccc";File shell=release(context,old,"<html>trusted</html>");Files.write(shell.toPath(),"corrupt".getBytes(StandardCharsets.UTF_8));
        File root=new File(context.getFilesDir(),"ui-releases");Files.write(new File(root,"lastgood.json").toPath(),new JSONObject().put("version",old).toString().getBytes(StandardCharsets.UTF_8));
        UiReleaseStore store = new UiReleaseStore(context,"ai");assertNotEquals(old,store.activeVersion());store.close();
    }
    @Test public void committedColdStartReadsOnlyShellAndRejectsCorruptAssetOnFirstUse() throws Exception {
        Context context=RuntimeEnvironment.getApplication();String version="dddddddddddddddd";
        File shell=release(context,version,"<html>trusted</html>");
        File root=new File(context.getFilesDir(),"ui-releases");File directory=new File(root,version);
        File asset=new File(directory,"files/official-patched-v1016/assets/unused.js");assertTrue(asset.getParentFile().mkdirs());
        byte[] body=new byte[4*1024*1024];java.util.Arrays.fill(body,(byte)'a');Files.write(asset.toPath(),body);
        StringBuilder hash=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(body))hash.append(String.format("%02x",b&255));
        File manifestFile=new File(directory,"ui-release.json");JSONObject manifest=new JSONObject(new String(Files.readAllBytes(manifestFile.toPath()),StandardCharsets.UTF_8));
        manifest.getJSONArray("files").put(new JSONObject().put("path","/official-patched-v1016/assets/unused.js").put("url","/android/ui/"+version+"/files/official-patched-v1016/assets/unused.js").put("bytes",body.length).put("sha256",hash.toString()).put("mime","text/javascript"));
        Files.write(manifestFile.toPath(),manifest.toString().getBytes(StandardCharsets.UTF_8));Files.write(new File(root,"active.json").toPath(),new JSONObject().put("version",version).toString().getBytes(StandardCharsets.UTF_8));
        context.getSharedPreferences("ui-install",Context.MODE_PRIVATE).edit().putInt("appVersion",BuildConfig.VERSION_CODE).commit();
        UiReleaseStore migration=new UiReleaseStore(context,"ai");assertEquals(version,migration.activeVersion());migration.close();
        assertTrue(new JSONObject(new String(Files.readAllBytes(new File(root,"active.json").toPath()),StandardCharsets.UTF_8)).has("manifestSha256"));
        UiReleaseStore store=new UiReleaseStore(context,"ai");assertEquals(version,store.activeVersion());
        java.lang.reflect.Field bytes=UiReleaseStore.class.getDeclaredField("startupVerifiedBytes");bytes.setAccessible(true);assertEquals(shell.length(),bytes.getLong(store));
        long modified=asset.lastModified();body[0]='b';Files.write(asset.toPath(),body);assertTrue(asset.setLastModified(modified));
        assertNull("even same size/time corruption is checked before JS is exposed",store.localResource("/official-patched-v1016/assets/unused.js"));
        try(UiReleaseStore.LocalResource resource=store.localResource(manifest.getString("shell"))){assertNotNull(resource);}store.close();
    }    @Test public void livePageResourcesSurviveTwoNewReleasesUntilItsLeaseEnds() throws Exception {
        Context context=RuntimeEnvironment.getApplication();String a="eeeeeeeeeeeeeeee",b="ffffffffffffffff",c="abababababababab";
        File original=release(context,a,"<html>A lazy preview</html>");File root=new File(context.getFilesDir(),"ui-releases");
        Files.write(new File(root,"active.json").toPath(),new JSONObject().put("version",a).toString().getBytes(StandardCharsets.UTF_8));
        UiReleaseStore store=new UiReleaseStore(context,"ai");UiReleaseStore.Release page=store.activeRelease();assertEquals(a,page.version);store.retainPage(page);
        release(context,b,"<html>B</html>");release(context,c,"<html>C</html>");
        java.lang.reflect.Method prune=UiReleaseStore.class.getDeclaredMethod("pruneOldReleases",String.class,String.class);prune.setAccessible(true);prune.invoke(store,c,b);
        assertTrue("A remains locally available offline while mounted",original.isFile());assertEquals("<html>A lazy preview</html>",new String(Files.readAllBytes(original.toPath()),StandardCharsets.UTF_8));
        try(UiReleaseStore.LocalResource resource=store.localResource(page.shellPath,page)){assertNotNull(resource);}
        store.releasePage(page);prune.invoke(store,c,b);assertFalse(original.exists());store.close();
    }

}
