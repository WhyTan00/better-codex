package top.whytan.dsh;
import java.nio.file.*;
import java.io.*;
/** Synthetic Native-shaped DTOs only. No private transcript or account. */
final class PublicNativeFixtures {
 static String file(String name) throws IOException {
  InputStream input=PublicNativeFixtures.class.getResourceAsStream("/public-native/"+name+".json");
  if(input==null)throw new IOException("Missing public fixture");
  Path file=Files.createTempFile("better-codex-fixture-", ".json");
  try(input){Files.copy(input,file,StandardCopyOption.REPLACE_EXISTING);}
  file.toFile().deleteOnExit();return file.toString();
 }
}
