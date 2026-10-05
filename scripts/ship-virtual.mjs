// 虚拟商品发货邮件：由后台「发货」触发 repository_dispatch。
// 邮件是附加服务：发送失败不抛错（发货内容已记入订单，买家可在订单页查看）。
// 发件走 SMTP 直发（见 scripts/mailer.mjs），无需域名验证。
// 需要 Secrets: SMTP_HOST, SMTP_USER, SMTP_PASS；可选 SMTP_PORT（默认465）, SMTP_FROM。
// 可选 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY：回写 ship.emailed 标记
// （自动补发脚本也会读这个标记，避免重复发送）。

import { sendMail } from "./mailer.mjs";

const payload = JSON.parse(process.env.PAYLOAD || "{}");
const { buyer_email, product_name, price, content, order_id } = payload;

async function markEmailed(ok) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !order_id) return;
  try {
    const get = await fetch(`${url}/rest/v1/orders?select=ship&id=eq.${order_id}`, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    const rows = await get.json();
    const ship = (rows[0] && rows[0].ship) || {};
    ship.emailed = ok;
    await fetch(`${url}/rest/v1/orders?id=eq.${order_id}`, {
      method: "PATCH",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ ship })
    });
    console.log("已回写 emailed =", ok);
  } catch (e) {
    console.log("回写 emailed 失败:", e.message);
  }
}

if (!buyer_email || !content) {
  console.log("缺少 buyer_email 或 content，跳过。");
  process.exit(0);
}
if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.log("未配置 SMTP_HOST / SMTP_USER / SMTP_PASS，跳过邮件发送。");
  await markEmailed(false);
  process.exit(0);
}

const shortId = order_id ? String(order_id).replace(/-/g, "").slice(0, 8).toUpperCase() : "";
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const html = `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px">
<h2>🎉 你的商品已发货</h2>
<p>订单号：<b>${esc(shortId)}</b></p>
<p>商品：${esc(product_name)}（${esc(price)} USD）</p>
<p>以下是你的虚拟商品交付内容，请妥善保管：</p>
<pre style="background:#f6f6f6;border:1px dashed #ccc;border-radius:8px;padding:14px;white-space:pre-wrap;word-break:break-all">${esc(content)}</pre>
<p style="color:#888;font-size:12px">也可以随时在商城「我的订单」里查看该订单的发货信息。</p>
</div>`;

const r = await sendMail({ to: buyer_email, subject: `${product_name} · 订单 ${shortId}`, html });
if (r.ok) {
  console.log("邮件已发送");
  await markEmailed(true);
} else {
  console.log("邮件发送失败（发货已记录，买家可在订单页查看；自动补发下轮会重试）:", r.error);
  await markEmailed(false);
}
