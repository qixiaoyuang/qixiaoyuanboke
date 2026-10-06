// 虚拟商品自动补发邮件：工作流每 5 分钟一轮，每轮内每分钟执行一次。
// 扫描 Supabase 里 status=shipped、ship.content 非空、尚未标记 emailed 的订单，
// 自动把发货内容（卡密等）发邮件给买家。幂等：成功写 ship.emailed=true，失败写 false 下轮重试。
// 手动发货走的 repository_dispatch（ship-virtual）也会写 emailed 标记，两边不会重复发送。
// 发件走 SMTP 直发（见 scripts/mailer.mjs），无需域名验证。
// 需要 Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SMTP_HOST, SMTP_USER, SMTP_PASS
// 可选: SMTP_PORT（默认465）, SMTP_FROM

import { sendMail } from "./mailer.mjs";

const SB_URL = process.env.SUPABASE_URL || "";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shortId = id => String(id || "").replace(/-/g, "").slice(0, 8).toUpperCase();

if (!SB_URL || !SB_KEY) { console.log("未配置 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，跳过。"); process.exit(0); }
if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.log("未配置 SMTP_HOST / SMTP_USER / SMTP_PASS，跳过。");
  process.exit(0);
}

const headers = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };

// 最近 30 天的已发货订单
const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
const ordr = await fetch(
  `${SB_URL}/rest/v1/orders?select=id,product_name,price,ship&status=eq.shipped&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=200`,
  { headers }
);
if (!ordr.ok) {
  const t = await ordr.text().catch(() => "");
  console.log("读取订单失败:", ordr.status, t.slice(0, 200));
  process.exit(1);
}
const orders = await ordr.json();

// 买家邮箱映射（auth 用户邮箱）
let buyerMap = {};
try {
  const br = await fetch(`${SB_URL}/rest/v1/rpc/admin_buyer_emails`, { method: "POST", headers, body: "{}" });
  if (br.ok) for (const x of await br.json()) buyerMap[x.order_id] = x.email;
} catch (e) { console.log("买家邮箱映射获取失败:", e.message); }

function buyerEmailOf(o) {
  const ship = o.ship || {};
  return ship.deliveryEmail || ship.buyerEmail || buyerMap[o.id] || "";
}

const targets = orders.filter(o => {
  const ship = o.ship || {};
  if (!ship.content) return false;        // 无发货内容：未发货或实物单
  if (ship.emailed === true) return false; // 已发送过
  return EMAIL_RE.test(buyerEmailOf(o));
});
console.log(`待补发邮件订单：${targets.length}`);

async function markEmailed(order, ok) {
  try {
    const get = await fetch(`${SB_URL}/rest/v1/orders?select=ship&id=eq.${order.id}`, { headers });
    const rows = await get.json();
    const ship = (rows[0] && rows[0].ship) || {};
    ship.emailed = ok;
    await fetch(`${SB_URL}/rest/v1/orders?id=eq.${order.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ ship })
    });
  } catch (e) { console.log("回写 emailed 失败:", order.id, e.message); }
}

let sent = 0;
for (const o of targets) {
  const ship = o.ship || {};
  const to = buyerEmailOf(o);
  const sid = shortId(o.id);
  const html = `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px">
<h2>🎉 你的商品已发货</h2>
<p>订单号：<b>${esc(sid)}</b></p>
<p>商品：${esc(o.product_name)}（${esc(o.price)} USD）</p>
<p>以下是你的虚拟商品交付内容，请妥善保管：</p>
<pre style="background:#f6f6f6;border:1px dashed #ccc;border-radius:8px;padding:14px;white-space:pre-wrap;word-break:break-all">${esc(ship.content)}</pre>
<p style="color:#888;font-size:12px">也可以随时在商城「我的订单」里查看该订单的发货信息。</p>
</div>`;
  const r = await sendMail({ to, subject: `${o.product_name} · 订单 ${sid}`, html });
  if (r.ok) {
    console.log("已发送:", sid, "→", to);
    sent++;
    await markEmailed(o, true);
  } else {
    console.log("发送失败（下轮重试）:", sid, r.error);
    await markEmailed(o, false);
  }
  await new Promise(r => setTimeout(r, 1000)); // 别触发发件频率限制
}
console.log(`完成：发送 ${sent}/${targets.length}`);
