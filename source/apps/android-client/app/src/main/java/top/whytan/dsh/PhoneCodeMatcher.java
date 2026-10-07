package top.whytan.dsh;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Pure local matching. Message bodies never leave this class's caller. */
public final class PhoneCodeMatcher {
    private static final String WORD = "(?:验证码|校验码|动态码|短信码|verification\\s*code|security\\s*code|one[-\\s]*time\\s*(?:password|code)|passcode|\\bOTP\\b|\\bcode\\b)";
    private static final Pattern KEYWORD = Pattern.compile(WORD, Pattern.CASE_INSENSITIVE);
    private static final Pattern AFTER = Pattern.compile(WORD + "(?:\\s+(?:is|for\\s+[^\\r\\n:：]{1,24}?\\s+is))?[\\s:：是为\\[\\]【】()（）-]{0,12}([A-Z0-9]{4,10})(?![A-Z0-9])", Pattern.CASE_INSENSITIVE);
    private static final Pattern BEFORE = Pattern.compile("(?<![A-Z0-9])([A-Z0-9]{4,10})[\\s,，:：.。()（）【】\\[\\]-]{0,8}(?:(?:is\\s+(?:your|the)\\s+|是您的|是你的|为您的|为|是)[^\\r\\n]{0,40}?)?" + WORD, Pattern.CASE_INSENSITIVE);
    private PhoneCodeMatcher() {}
    public static final class Message {
        public final String id, sender, body;
        public final long receivedAt;
        public Message(String id,String sender,String body,long receivedAt){this.id=id;this.sender=sender;this.body=body;this.receivedAt=receivedAt;}
    }
    public static final class Result {
        public final String status, code;
        public final Message message;
        Result(String status,String code,Message message){this.status=status;this.code=code;this.message=message;}
    }
    static String normalized(String value){return Normalizer.normalize(value == null ? "" : value,Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);}
    private static boolean serviceMatches(String body,String service){
        String wanted=normalized(service).trim();
        if(wanted.length()<2)return false;
        if(wanted.matches("[a-z0-9 ._-]+"))return Pattern.compile("(?<![a-z0-9])"+Pattern.quote(wanted)+"(?![a-z0-9])").matcher(normalized(body)).find();
        return normalized(body).contains(wanted);
    }
    private static String senderKey(String value){return normalized(value).replaceAll("[\\s()（）-]","");}
    private static void collect(Pattern pattern,String body,Set<String> values){Matcher m=pattern.matcher(body);while(m.find()){String code=m.group(1);if(code.matches(".*[0-9].*"))values.add(code);}}
    static Set<String> codes(String body){
        Set<String> result=new LinkedHashSet<>();if(body==null||body.length()>8192)return result;
        String text=Normalizer.normalize(body,Normalizer.Form.NFKC);if(!KEYWORD.matcher(text).find())return result;
        collect(AFTER,text,result);collect(BEFORE,text,result);
        return result;
    }
    public static Result match(List<Message> messages,String service,String sender,long after,long now){
        List<Result> matches=new ArrayList<>();boolean ambiguous=false;
        for(Message message:messages){
            if(message.receivedAt<after||message.receivedAt>now+5000||!serviceMatches(message.body,service))continue;
            if(sender!=null&&!sender.isEmpty()&&!senderKey(sender).equals(senderKey(message.sender)))continue;
            Set<String> found=codes(message.body);if(found.size()>1){ambiguous=true;continue;}
            if(found.size()==1)matches.add(new Result("found",found.iterator().next(),message));
        }
        if(ambiguous)return new Result("ambiguous",null,null);
        if(matches.isEmpty())return new Result("no_match",null,null);
        Result newest=matches.get(0);
        for(Result result:matches){
            if(!newest.code.equals(result.code)||!senderKey(newest.message.sender).equals(senderKey(result.message.sender)))return new Result("ambiguous",null,null);
            if(result.message.receivedAt>newest.message.receivedAt)newest=result;
        }
        return newest;
    }
}
