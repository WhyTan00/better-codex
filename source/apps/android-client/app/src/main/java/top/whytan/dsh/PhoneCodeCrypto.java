package top.whytan.dsh;

import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public final class PhoneCodeCrypto {
    private PhoneCodeCrypto() {}
    static byte[] fromHex(String value){if(value==null||!value.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Invalid pairing key");byte[] b=new byte[32];for(int i=0;i<32;i++)b[i]=(byte)Integer.parseInt(value.substring(i*2,i*2+2),16);return b;}
    public static JSONObject seal(String key,JSONObject result) throws Exception {
        byte[] iv=new byte[12];new SecureRandom().nextBytes(iv);
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(fromHex(key),"AES"),new GCMParameterSpec(128,iv));
        cipher.updateAAD(("dsh-phone-code-v1:"+result.getString("id")).getBytes(StandardCharsets.UTF_8));
        byte[] encrypted=cipher.doFinal(result.toString().getBytes(StandardCharsets.UTF_8));
        return new JSONObject().put("id",result.getString("id")).put("status",result.getString("status"))
                .put("iv",Base64.encodeToString(iv,Base64.NO_WRAP)).put("ciphertext",Base64.encodeToString(encrypted,Base64.NO_WRAP));
    }
}
