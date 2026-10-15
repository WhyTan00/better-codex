package top.whytan.dsh;
import static org.junit.Assert.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import okhttp3.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=28,manifest=Config.NONE)
public class ApkUpdatePackageTest {
 private ApkUpdateManager.CheckResult check(String packageName) throws Exception {
  String body=new org.json.JSONObject().put("schemaVersion",1).put("minSdk",26)
   .put("packageName",packageName).put("versionCode",9999).put("versionName","fixture")
   .put("url","/android/releases/9999/client.apk").put("sha256",new String(new char[64]).replace('\0','a')).put("bytes",1024).toString();
  OkHttpClient http=new OkHttpClient.Builder().addInterceptor(chain->new Response.Builder()
   .request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
   .body(ResponseBody.create(body,MediaType.get("application/json"))).build()).build();
  try(ApkUpdateManager updater=new ApkUpdateManager(RuntimeEnvironment.getApplication())) {return updater.check(http);}
 }
 @Test public void acceptsOwnApplicationIdAndRejectsOtherPackages() throws Exception {
  assertNotNull(check(BuildConfig.APPLICATION_ID));
  assertNull(check("org.example.other"));
  assertNull(check(""));
 }
}
