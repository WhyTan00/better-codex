package top.whytan.dsh;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import okhttp3.*;

/** Private immutable copies. Source files and conversation state remain on the Mac. */
public final class DeliverableCache {
    private static final long MAX_FILE=256L*1024*1024, MAX_CACHE=4L*1024*1024*1024, CHUNK=8L*1024*1024;
    private static DeliverableCache instance;
    public static synchronized DeliverableCache get(Context context) {
        if(instance==null) instance=new DeliverableCache(context.getApplicationContext());
        return instance;
    }
    private final File root;
    private final Db db;
    private final LinkedHashMap<String,JSONObject> grants=new LinkedHashMap<>();
    DeliverableCache(Context context) { root=new File(context.getFilesDir(),"deliverables");root.mkdirs();db=new Db(context); }
    static String digest(String text) {
        try { return hex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))); }
        catch(Exception e) { throw new IllegalStateException(e); }
    }
    private static String hex(byte[] bytes) { StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString(); }
    private File file(String scope,String id,String extension) throws IOException {
        if(!DshConfig.isScope(scope)||!id.matches("[a-f0-9]{64}"))throw new IOException("invalid deliverable identity");
        File dir=new File(root,scope);if(!dir.isDirectory()&&!dir.mkdirs())throw new IOException("storage unavailable");
        return new File(dir,id+extension);
    }
    synchronized boolean prepared(String scope,String thread,String turn,String desired) {
        try(Cursor c=db.getReadableDatabase().rawQuery("SELECT desired FROM prepared WHERE scope=? AND thread_id=? AND turn_id=?",new String[]{scope,thread,turn})) {
            return c.moveToFirst()&&desired.equals(c.getString(0));
        }
    }
    synchronized void markPrepared(String scope,String thread,String turn,String desired) {
        ContentValues v=new ContentValues();v.put("scope",scope);v.put("thread_id",thread);v.put("turn_id",turn);v.put("desired",desired);
        db.getWritableDatabase().insertWithOnConflict("prepared",null,v,SQLiteDatabase.CONFLICT_REPLACE);
    }
    private JSONObject entry(String scope,String id) throws Exception {
        try(Cursor c=db.getReadableDatabase().rawQuery("SELECT payload FROM copies WHERE scope=? AND id=?",new String[]{scope,id})) {
            return c.moveToFirst()?new JSONObject(c.getString(0)):null;
        }
    }
    synchronized boolean available(String scope,JSONObject descriptor) throws Exception {
        JSONObject old=entry(scope,descriptor.getString("id"));
        File local=file(scope,descriptor.getString("id"),".bin");
        return old!=null&&old.getString("version").equals(descriptor.getString("version"))&&local.isFile()&&local.length()==descriptor.getLong("size");
    }
    /** Each range appends only bytes of the declared immutable version; a process death leaves a resumable .part. */
    boolean download(String scope,JSONObject descriptor,OkHttpClient http,String cookie) throws Exception {
        String id=descriptor.getString("id"),version=descriptor.getString("version"),hash=descriptor.getString("sha256");
        long size=descriptor.getLong("size");
        String address=descriptor.getString("url");
        Uri uri=Uri.parse(address.startsWith("/w/")?DshConfig.ORIGIN+address:address);
        if(!scope.equals(descriptor.optString("scope"))||!DshConfig.isDshUri(uri)||!uri.getPath().startsWith("/w/"+scope+"/api/local-file/")
                ||size<0||size>MAX_FILE||!hash.matches("[a-f0-9]{64}")||!version.equals("sha256:"+hash))throw new IOException("invalid deliverable descriptor");
        if(available(scope,descriptor))return true;
        File partial=file(scope,id,".part"),target=file(scope,id,".bin");
        synchronized(this){reserve(Math.max(0,size-partial.length()),scope,id);}
        try(RandomAccessFile out=new RandomAccessFile(partial,"rw")) {
            if(out.length()>size)out.setLength(0);
            while(out.length()<size) {
                if(Thread.currentThread().isInterrupted())throw new InterruptedIOException();
                long start=out.length(),end=Math.min(size-1,start+CHUNK-1);out.seek(start);
                Request.Builder builder=new Request.Builder().url(uri.toString()).header("Origin",DshConfig.ORIGIN).header("Accept-Encoding","identity")
                        .header("Range","bytes="+start+"-"+end).header("If-Range","\""+version+"\"");
                if(cookie!=null&&!cookie.isEmpty())builder.header("Cookie",cookie);
                try(Response response=http.newCall(builder.build()).execute()) {
                    if(response.code()!=206||response.body()==null||!("\""+version+"\"").equals(response.header("ETag"))
                            ||!("bytes "+start+"-"+end+"/"+size).equals(response.header("Content-Range")))throw new IOException("deliverable range unavailable");
                    long remaining=end-start+1;byte[] buffer=new byte[64*1024];InputStream input=response.body().byteStream();
                    while(remaining>0){int count=input.read(buffer,0,(int)Math.min(buffer.length,remaining));if(count<0)throw new EOFException();out.write(buffer,0,count);remaining-=count;}
                    if(input.read()!=-1)throw new IOException("deliverable range overflow");out.getFD().sync();
                } catch(Exception error) { out.setLength(start);throw error; }
            }
            out.getFD().sync();
        }
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(InputStream input=new FileInputStream(partial)){byte[] buffer=new byte[64*1024];int count;while((count=input.read(buffer))!=-1)digest.update(buffer,0,count);}
        if(!hash.equals(hex(digest.digest()))){try(RandomAccessFile reset=new RandomAccessFile(partial,"rw")){reset.setLength(0);}throw new IOException("deliverable digest mismatch");}
        synchronized(this) {
            if(!partial.renameTo(target))throw new IOException("deliverable commit failed");
            JSONObject safe=new JSONObject(descriptor.toString());safe.remove("url");
            ContentValues v=new ContentValues();v.put("scope",scope);v.put("id",id);v.put("path",safe.getString("path"));v.put("payload",safe.toString());v.put("accessed",System.currentTimeMillis());
            db.getWritableDatabase().insertWithOnConflict("copies",null,v,SQLiteDatabase.CONFLICT_REPLACE);
        }
        return true;
    }
    private void reserve(long bytes,String activeScope,String activeId) throws Exception {
        long used=0;List<File> candidates=new ArrayList<>();
        for(String scope:new String[]{"ai","zyy"}){File[] files=new File(root,scope).listFiles();if(files==null)continue;for(File f:files){used+=f.length();if(!f.getName().equals(activeId+".part")&&!f.getName().equals(activeId+".bin"))candidates.add(f);}}
        candidates.sort(Comparator.comparingLong(File::lastModified));
        for(File f:candidates){if(used+bytes<=MAX_CACHE)break;if(System.currentTimeMillis()-f.lastModified()<24L*3600*1000)continue;long length=f.length();if(f.delete()){used-=length;db.getWritableDatabase().delete("prepared","scope=?",new String[]{f.getParentFile().getName()});}}
        if(used+bytes>MAX_CACHE)throw new IOException("deliverable cache full");
    }
    /** Only a main-frame validated bridge can mint this short-lived local URL. */
    public synchronized JSONObject resolve(String scope,String path) throws Exception {
        JSONObject found=null;
        try(Cursor c=db.getReadableDatabase().rawQuery("SELECT payload FROM copies WHERE scope=? AND path=? ORDER BY accessed DESC",new String[]{scope,path})){
            while(c.moveToNext()){JSONObject candidate=new JSONObject(c.getString(0));if(available(scope,candidate)){found=candidate;break;}}
        }
        if(found==null)return new JSONObject().put("available",false);
        String key=UUID.randomUUID().toString();JSONObject grant=new JSONObject(found.toString()).put("expires",System.currentTimeMillis()+3600_000L);
        grants.put(key,grant);while(grants.size()>512)grants.remove(grants.keySet().iterator().next());
        File local=file(scope,found.getString("id"),".bin");local.setLastModified(System.currentTimeMillis());
        found.put("available",true).put("url",DshConfig.ORIGIN+"/__dsh_deliverables/"+scope+"/"+key+"/"+Uri.encode(found.getString("name")));
        return found;
    }
    public synchronized WebResourceResponse intercept(Uri uri,String scope,String range,boolean authorized) {
        if(!DshConfig.isDshUri(uri)||uri.getPath()==null||!uri.getPath().startsWith("/__dsh_deliverables/"))return null;
        try {
            List<String> parts=uri.getPathSegments();JSONObject grant=parts.size()==4?grants.get(parts.get(2)):null;
            if(!authorized||grant==null||!scope.equals(parts.get(1))||!scope.equals(grant.getString("scope"))||grant.getLong("expires")<System.currentTimeMillis())return error(403,"Forbidden");
            File local=file(scope,grant.getString("id"),".bin");long size=local.length(),start=0,end=size-1;int status=200;
            if(!local.isFile()||size!=grant.getLong("size"))return error(404,"Not Found");
            if(range!=null&&!range.isEmpty()){
                java.util.regex.Matcher m=java.util.regex.Pattern.compile("bytes=(\\d*)-(\\d*)").matcher(range);
                if(!m.matches()||m.group(1).isEmpty()&&m.group(2).isEmpty())return error(416,"Range Not Satisfiable");
                if(m.group(1).isEmpty()){long suffix=Long.parseLong(m.group(2));if(suffix<=0)return error(416,"Range Not Satisfiable");start=Math.max(0,size-suffix);}
                else {start=Long.parseLong(m.group(1));if(!m.group(2).isEmpty())end=Math.min(end,Long.parseLong(m.group(2)));}
                if(start>=size||end<start)return error(416,"Range Not Satisfiable");status=206;
            }
            final long length=Math.max(0,end-start+1);FileInputStream input=new FileInputStream(local);input.getChannel().position(start);
            InputStream bounded=new FilterInputStream(input){long remaining=length;@Override public int read()throws IOException{if(remaining==0)return -1;int b=super.read();if(b>=0)remaining--;return b;}
                @Override public int read(byte[] b,int off,int len)throws IOException{if(remaining==0)return -1;int n=in.read(b,off,(int)Math.min(len,remaining));if(n>0)remaining-=n;return n;}};
            Map<String,String> headers=new HashMap<>();headers.put("Content-Length",Long.toString(length));headers.put("Cache-Control","no-store");headers.put("Accept-Ranges","bytes");headers.put("ETag","\""+grant.getString("version")+"\"");
            headers.put("X-Content-Type-Options","nosniff");headers.put("Content-Security-Policy","sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:");
            if(status==206)headers.put("Content-Range","bytes "+start+"-"+end+"/"+size);
            return new WebResourceResponse(grant.optString("mime","application/octet-stream"),null,status,status==206?"Partial Content":"OK",headers,bounded);
        } catch(Exception error){return error(404,"Not Found");}
    }
    public File exportCopy(Context context,Uri uri,String scope,boolean authorized) throws Exception {
        WebResourceResponse response=intercept(uri,scope,null,authorized);
        if(response==null||response.getStatusCode()!=200)throw new IOException("local copy unavailable");
        String name=Objects.toString(uri.getLastPathSegment(),"file").replaceAll("[\\x00-\\x1f\\x7f\\\\/]+","_");
        if(name.length()>160)name=name.substring(0,160);if(name.isEmpty()||name.equals(".")||name.equals(".."))name="file";
        File dir=new File(context.getCacheDir(),"downloads/"+UUID.randomUUID());if(!dir.mkdirs())throw new IOException("export directory unavailable");File output=new File(dir,name);
        try(InputStream input=response.getData();FileOutputStream out=new FileOutputStream(output)){
            byte[] buffer=new byte[64*1024];long copied=0;int count;while((count=input.read(buffer))!=-1){copied+=count;if(copied>MAX_FILE)throw new IOException("export too large");out.write(buffer,0,count);}out.getFD().sync();return output;
        }catch(Exception unavailable){output.delete();dir.delete();throw unavailable;}
    }
    private static WebResourceResponse error(int code,String reason){return new WebResourceResponse("text/plain","UTF-8",code,reason,Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream(new byte[0]));}
    private static final class Db extends SQLiteOpenHelper {
        Db(Context context){super(context,"deliverables.db",null,1);}
        @Override public void onCreate(SQLiteDatabase db){db.execSQL("CREATE TABLE copies(scope TEXT,id TEXT,path TEXT,payload TEXT,accessed INTEGER,PRIMARY KEY(scope,id))");db.execSQL("CREATE INDEX copies_path ON copies(scope,path,accessed)");db.execSQL("CREATE TABLE prepared(scope TEXT,thread_id TEXT,turn_id TEXT,desired TEXT,PRIMARY KEY(scope,thread_id,turn_id))");}
        @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion){}
    }
}
