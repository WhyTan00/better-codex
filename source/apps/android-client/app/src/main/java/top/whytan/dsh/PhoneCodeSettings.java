package top.whytan.dsh;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Pairing material is encrypted with a non-exportable Android Keystore key. */
public final class PhoneCodeSettings {
    private static final String NAME="phone-code-v1",ALIAS="dsh-phone-code-pairing-v1";
    private PhoneCodeSettings() {}
    private static SharedPreferences prefs(Context c){return c.getSharedPreferences(NAME,Context.MODE_PRIVATE);}
    private static SecretKey key() throws Exception {
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(store.containsAlias(ALIAS))return (SecretKey)store.getKey(ALIAS,null);
        KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    public static synchronized void save(Context context,JSONObject value) throws Exception {
        if(!"ai".equals(value.optString("scope"))||!value.optString("token").matches("[a-f0-9]{64}")||!value.optString("encryptionKey").matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Invalid pairing response");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());
        String blob=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
        if(!prefs(context).edit().putString("pairing",blob).putBoolean("enabled",false).putString("state","paired").commit())throw new java.io.IOException("Pairing could not be saved");
    }
    public static synchronized JSONObject load(Context context) throws Exception {
        String blob=prefs(context).getString("pairing","");if(blob.isEmpty())return null;String[] parts=blob.split(":",2);if(parts.length!=2)throw new IllegalStateException("Pairing unavailable");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));
        return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8));
    }
    public static synchronized String installationSecret(Context context) throws Exception {
        String blob=prefs(context).getString("installation","");
        if(!blob.isEmpty()){
            String[] parts=blob.split(":",2);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
        }
        byte[] bytes=new byte[32];new java.security.SecureRandom().nextBytes(bytes);StringBuilder secret=new StringBuilder();
        for(byte value:bytes)secret.append(String.format(java.util.Locale.ROOT,"%02x",value&255));
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());
        blob=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(secret.toString().getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
        if(!prefs(context).edit().putString("installation",blob).commit())throw new java.io.IOException("Binding proof could not be saved");
        return secret.toString();
    }
    public static boolean paired(Context c){return prefs(c).contains("pairing");}
    public static boolean enabled(Context c){return prefs(c).getBoolean("enabled",false)&&"ai".equals(SyncForegroundService.deviceOwner(c));}
    public static void setEnabled(Context c,boolean enabled){prefs(c).edit().putBoolean("enabled",enabled).apply();}
    public static void forgetBinding(Context c){prefs(c).edit().remove("pairing").putBoolean("enabled",false).remove("state").apply();}
    public static void clear(Context c){prefs(c).edit().clear().apply();}
    public static void state(Context c,String state){SharedPreferences p=prefs(c);if(!state.equals(p.getString("state","")))p.edit().putString("state",state).apply();}
    public static String status(Context c){
        if(!paired(c))return "开启后自动绑定当前登录的 Mac";
        if(!PhoneCodeReader.hasPermission(c))return "短信权限未授予；请检查系统应用权限";
        if(!enabled(c))return "已绑定，自动返回未开启";
        String state=prefs(c).getString("state","");
        switch(state){
            case "connected": return "已连接，等待 Mac 请求";
            case "reading": return "正在查找本次请求的验证码";
            case "found": return "已向 Mac 返回匹配验证码";
            case "ambiguous": return "有多个候选，请在 Mac 缩小时间或发送方范围";
            case "no_match": return "本次没有匹配短信，部分系统可能限制验证码读取";
            case "permission_denied": return "短信读取被系统拒绝";
            case "auth_required": return "登录已过期，请回到 App 登录";
            case "pairing_required": return "绑定已失效，请重新开启此功能";
            case "clock_skew": return "手机与 Mac 时间相差较大，请核对自动时间";
            case "query_unavailable": return "当前系统无法查询短信";
            case "stopped": return "后台同步已停止，验证码请求暂不可达";
            default: return "连接恢复中；请保持后台同步开启";
        }
    }
}
