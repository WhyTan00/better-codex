package top.whytan.dsh;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.List;

public class PhoneCodeMatcherTest {
    private static final long NOW=1800000000000L;
    private PhoneCodeMatcher.Message sms(String id,String sender,String text,long age){return new PhoneCodeMatcher.Message(id,sender,text,NOW-age);}
    private PhoneCodeMatcher.Result match(PhoneCodeMatcher.Message... messages){return PhoneCodeMatcher.match(List.of(messages),"Example","",NOW-180000,NOW);}
    @Test public void readsChineseAndEnglishCodesWithoutReturningUnrelatedNumbers(){
        assertEquals("123456",match(sms("1","106123","【Example】验证码：123456，5分钟内有效，请勿泄露。",1000)).code);
        assertEquals("987654",match(sms("2","EXAMPLE","987654 is your Example verification code.",1000)).code);
        assertEquals("A1B2C3",match(sms("3","EXAMPLE","Your Example verification code is: A1B2C3",1000)).code);
        assertEquals("123456",match(sms("4","106123","【Example】验证码：１２３４５６",1000)).code);
        assertEquals("no_match",match(sms("5","106123","【Example】订单 123456 已发货。",1000)).status);
    }
    @Test public void filtersServiceSenderAndTimeBeforeSelectingAnything(){
        assertEquals("no_match",match(sms("1","OTHER","【Other】验证码：123456",1000)).status);
        assertEquals("no_match",match(sms("2","EXAMPLE","Example code: 123456",300000)).status);
        assertEquals("no_match",match(sms("3","EXAMPLE","Example code: 123456",-10000)).status);
        assertEquals("no_match",PhoneCodeMatcher.match(List.of(sms("4","106111","Example code: 123456",1000)),"Example","106222",NOW-180000,NOW).status);
        assertEquals("no_match",PhoneCodeMatcher.match(List.of(sms("5","SENDER","Email code: 123456",1000)),"AI","",NOW-180000,NOW).status);
    }
    @Test public void multipleDifferentCodesAreAmbiguousButDuplicateDeliveryOfSameCodeIsNot(){
        assertEquals("ambiguous",match(sms("1","EXAMPLE","Example code: 123456",1000),sms("2","EXAMPLE","Example code: 654321",2000)).status);
        assertEquals("ambiguous",match(sms("1","EXAMPLE","Example 验证码: 123456，另一个验证码: 654321",1000)).status);
        PhoneCodeMatcher.Result same=match(sms("1","EXAMPLE","Example code: 123456",1000),sms("2","EXAMPLE","Example code: 123456",2000));assertEquals("found",same.status);assertEquals("1",same.message.id);
    }
    @Test public void phoneNumbersAndWordsAreNeverMistakenForCodes(){
        assertEquals("no_match",match(sms("1","EXAMPLE","Example verification code sent to 13812345678",1000)).status);
        assertEquals("no_match",match(sms("3","EXAMPLE","Example verification code sent by 106900",1000)).status);
        assertEquals("no_match",match(sms("2","EXAMPLE","Example verification code is pending",1000)).status);
    }
}
