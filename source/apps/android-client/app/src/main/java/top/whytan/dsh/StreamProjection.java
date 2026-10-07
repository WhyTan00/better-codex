package top.whytan.dsh;

import org.json.*;

/** Read-only agent text derived from the ordered gateway feed; never execution state. */
final class StreamProjection {
    static JSONObject apply(JSONObject previous, String scope, String thread, String epoch, long seq, JSONObject event) throws JSONException {
        JSONObject state=previous;
        if(state==null||!epoch.equals(state.optString("epoch")))state=new JSONObject().put("scope",scope).put("threadId",thread).put("epoch",epoch).put("turns",new JSONArray());
        if(seq<=state.optLong("seq"))return state;
        JSONArray turns=state.getJSONArray("turns");String type=event.optString("type");
        if("snapshot".equals(type)){
            state.remove("gap");JSONObject snapshot=event.optJSONObject("snapshot");JSONArray incoming=snapshot==null?null:snapshot.optJSONArray("turns");
            if(incoming!=null)for(int i=0;i<incoming.length();i++)mergeTurn(turns,incoming.getJSONObject(i));
        }else if("turn".equals(type)&&event.optJSONObject("turn")!=null)mergeTurn(turns,event.getJSONObject("turn"));
        else if("item".equals(type)||"delta".equals(type)){
            String turnId=event.optString("turnId");if(!NativeDiagnostics.isUuid(turnId))return state;
            JSONObject turn=find(turns,turnId);if(turn==null){turn=new JSONObject().put("id",turnId).put("status","inProgress").put("items",new JSONArray());turns.put(turn);}
            JSONArray items=turn.getJSONArray("items");
            if("item".equals(type)){JSONObject item=event.optJSONObject("item");if(item!=null)mergeItem(items,item);}
            else {String id=event.optString("itemId");JSONObject item=find(items,id);
                // A delta without its seed is never presented as a complete message.
                if(item!=null&&item.optBoolean("seeded")&&"inProgress".equals(turn.optString("status")))
                    item.put("text",item.optString("text")+event.optString("delta"));
                else state.put("gap",true);
            }
        }
        while(turns.length()>6)turns.remove(0);
        state.put("seq",seq).put("updatedAt",System.currentTimeMillis());return state;
    }
    static String latestHash(JSONObject value) {
        JSONArray turns=value.optJSONArray("turns");if(turns==null)return null;
        for(int t=turns.length()-1;t>=0;t--){JSONArray items=turns.optJSONObject(t).optJSONArray("items");if(items==null||items.length()==0)continue;
            JSONObject item=items.optJSONObject(items.length()-1);String text=item.optString("id")+"\n"+item.optString("text");int a=(int)2166136261L,b=(int)2246822507L;
            for(int i=0;i<text.length();i++){a=(a^text.charAt(i))*16777619;b=(b^text.charAt(i))*(int)3266489909L;}
            return String.format(java.util.Locale.ROOT,"%08x%08x",a,b);
        }return null;
    }
    private static JSONObject find(JSONArray values,String id){for(int i=0;i<values.length();i++){JSONObject v=values.optJSONObject(i);if(v!=null&&id.equals(v.optString("id")))return v;}return null;}
    private static void mergeTurn(JSONArray turns,JSONObject input)throws JSONException{
        String id=input.optString("id");if(!NativeDiagnostics.isUuid(id))return;
        JSONObject turn=find(turns,id);if(turn==null){turn=new JSONObject().put("id",id).put("items",new JSONArray());turns.put(turn);}
        for(String key:new String[]{"status","startedAt","completedAt"})if(input.has(key))turn.put(key,input.get(key));
        JSONArray items=input.optJSONArray("items");if(items!=null)for(int i=0;i<items.length();i++)mergeItem(turn.getJSONArray("items"),items.getJSONObject(i));
    }
    private static void mergeItem(JSONArray items,JSONObject input)throws JSONException{
        if(!"agentMessage".equals(input.optString("type"))||input.optString("id").isEmpty())return;
        JSONObject item=find(items,input.getString("id"));if(item==null){item=new JSONObject().put("id",input.getString("id")).put("type","agentMessage");items.put(item);}
        item.put("text",input.optString("text")).put("phase",input.optString("phase","commentary")).put("seeded",true);
        while(items.length()>128)items.remove(0);
    }
}
