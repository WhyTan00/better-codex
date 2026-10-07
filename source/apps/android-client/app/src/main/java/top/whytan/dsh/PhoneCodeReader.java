package top.whytan.dsh;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.provider.Telephony;
import androidx.core.content.ContextCompat;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/** Bounded read of the inbox, only for one live Mac request. Never changes read/seen state. */
public final class PhoneCodeReader {
    private PhoneCodeReader() {}
    public static boolean hasPermission(Context context){return ContextCompat.checkSelfPermission(context,Manifest.permission.READ_SMS)==PackageManager.PERMISSION_GRANTED;}
    public static JSONObject read(Context context,JSONObject request,long serverTime) throws Exception {
        JSONObject result=new JSONObject().put("id",request.getString("id"));
        if(!hasPermission(context))return result.put("status","permission_denied");
        long now=System.currentTimeMillis(),offset=now-serverTime,after=request.getLong("after")+offset;
        if(Math.abs(offset)>120000)return result.put("status","clock_skew");
        if(after<now-300000||after>now+5000||request.getString("service").length()<2)return result.put("status","query_unavailable");
        List<PhoneCodeMatcher.Message> messages=new ArrayList<>();
        try(Cursor cursor=context.getContentResolver().query(Telephony.Sms.Inbox.CONTENT_URI,
                new String[]{"_id","address","body","date"},"date >= ? AND date <= ?",
                new String[]{Long.toString(after),Long.toString(now+5000)},"date DESC")){
            if(cursor==null)return result.put("status","query_unavailable");
            while(cursor.moveToNext()){
                if(messages.size()>=200)return result.put("status","query_unavailable");
                messages.add(new PhoneCodeMatcher.Message(cursor.getString(0),cursor.getString(1),cursor.getString(2),cursor.getLong(3)));
            }
        }catch(SecurityException denied){return result.put("status","permission_denied");}
        catch(RuntimeException unavailable){return result.put("status","query_unavailable");}
        PhoneCodeMatcher.Result matched=PhoneCodeMatcher.match(messages,request.getString("service"),request.optString("sender"),after,now);
        result.put("status",matched.status);
        if("found".equals(matched.status)){
            result.put("code",matched.code).put("receivedAt",matched.message.receivedAt-offset);
            String sender=matched.message.sender==null?"":matched.message.sender;
            result.put("sender",sender.length()>48?sender.substring(0,48):sender);
            // Only a hash identifies the selected SMS; never return its body or inbox row id.
            byte[] digest=MessageDigest.getInstance("SHA-256").digest((matched.message.id+":"+matched.message.receivedAt+":"+sender).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex=new StringBuilder();for(byte b:digest)hex.append(String.format(java.util.Locale.ROOT,"%02x",b&255));result.put("messageKey",hex.toString());
        }
        return result;
    }
}
