package top.whytan.dsh;
import static org.junit.Assert.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.io.*;
import java.lang.reflect.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=34)
public class ApkDownloadTimingTest {
 @Test public void partialTransferAndIntegrityFailureKeepDifferentPhasesAndByteCounts()throws Exception{
  Class<?> p=Class.forName("top.whytan.dsh.ApkUpdateManager$DownloadProgress");Constructor<?> ctor=p.getDeclaredConstructor();ctor.setAccessible(true);
  Method copy=ApkUpdateManager.class.getDeclaredMethod("copyVerified",InputStream.class,File.class,ApkUpdateManager.CheckResult.class,p);copy.setAccessible(true);
  Field phase=p.getDeclaredField("phase"),bytes=p.getDeclaredField("bytes");phase.setAccessible(true);bytes.setAccessible(true);
  File file=File.createTempFile("apk-timing-",".part");
  ApkUpdateManager.CheckResult update=new ApkUpdateManager.CheckResult(true,999,"fixture","/android/fixture.apk","00",10);
  try{
   Object partial=ctor.newInstance();InputStream input=new InputStream(){int n;public int read()throws IOException{if(n++<3)return 1;throw new java.net.SocketTimeoutException("private-url");}};
   try{copy.invoke(null,input,file,update,partial);fail();}catch(InvocationTargetException e){assertTrue(e.getCause() instanceof java.net.SocketTimeoutException);}
   assertEquals("response_body",phase.get(partial));assertEquals(3L,bytes.getLong(partial));
   Object invalid=ctor.newInstance();try{copy.invoke(null,new ByteArrayInputStream(new byte[10]),file,update,invalid);fail();}catch(InvocationTargetException e){assertTrue(e.getCause() instanceof IOException);}
   assertEquals("integrity_verify",phase.get(invalid));assertEquals(10L,bytes.getLong(invalid));assertFalse(file.exists());
  }finally{file.delete();}
 }
}
