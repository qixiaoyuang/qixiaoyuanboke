// 一次性 SMTP 测试：给自己（SMTP_USER）发一封测试邮件。
// 验证通过后可删除此文件和 .github/workflows/test-smtp.yml。
import { sendMail } from "./mailer.mjs";

const to = process.env.SMTP_USER || "";
if (!to) { console.log("未配置 SMTP_USER，跳过。"); process.exit(0); }
const r = await sendMail({
  to,
  subject: "小店邮件测试",
  html: "<p>这是一封自动发货系统的测试邮件。如果你收到它，说明 Zoho SMTP 配置成功，虚拟商品发货邮件可以正常发出。</p>"
});
console.log(r.ok ? "TEST_MAIL_OK" : "TEST_MAIL_FAIL: " + r.error);
process.exit(r.ok ? 0 : 1);
