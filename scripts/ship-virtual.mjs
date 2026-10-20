// 虚拟商品发货邮件：由后台「发货」触发 repository_dispatch。
// 邮件是附加服务：发送失败不抛错（发货内容已记入订单，买家可在订单页查看）。
// 发件走 SMTP 直发（见 scripts/mailer.mjs），无需域名验证。
// 需要 Secrets: SMTP_HOST, SMTP_USER, SMTP_PASS；可选 SMTP_PORT（默认465）, SMTP_FROM。
// 可选 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY：回写 ship.emailed 标记
// （自动补发脚本也会读这个标记，避免重复发送）。

import { sendMail } from "./mailer.mjs";
import { randomBytes } from "node:crypto";

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

/* 邮件开锁口令（30 天有效）：读订单 ship，没有效的就生成并写回 */
async function getOrCreateUnlock() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !order_id) return null;
  try {
    const hdrs = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
    const get = await fetch(`${url}/rest/v1/orders?select=ship&id=eq.${order_id}`, { headers: hdrs });
    const rows = await get.json();
    const ship = (rows[0] && rows[0].ship) || {};
    if (ship.unlock && ship.unlock.tok && new Date(ship.unlock.exp).getTime() > Date.now()) return ship.unlock.tok;
    const tok = randomBytes(16).toString("hex");
    ship.unlock = { tok, exp: new Date(Date.now() + 30 * 86400 * 1000).toISOString() };
    await fetch(`${url}/rest/v1/orders?id=eq.${order_id}`, { method: "PATCH", headers: hdrs, body: JSON.stringify({ ship }) });
    return tok;
  } catch (e) { console.log("开锁口令生成失败:", e.message); return null; }
}

/* 与商城页一致的 2FA 密钥识别 */
function isTotpSecretSV(t) { return /^[A-Z2-7]{16,64}$/.test(t) && /[A-Z]/.test(t); }
function findTotpSecretSV(c) {
  if (!c) return "";
  const s = String(c), flat = s.replace(/\n/g, " ");
  const m = flat.match(/(?:2fa|totp|secret|密钥|秘钥|谷歌验证|动态口令)[^\nA-Za-z2-7]{0,6}([A-Za-z2-7][A-Za-z2-7 ]{14,}[A-Za-z2-7])/i);
  if (m) { const v = m[1].replace(/ /g, "").toUpperCase(); if (isTotpSecretSV(v)) return v; }
  for (const part of s.split(/----|\n/)) {
    const t = part.replace(/[\s:：|]/g, "").toUpperCase();
    if (isTotpSecretSV(t)) return t;
  }
  return "";
}

const shortId = order_id ? String(order_id).replace(/-/g, "").slice(0, 8).toUpperCase() : "";
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unlockTok = await getOrCreateUnlock();
const secret2fa = findTotpSecretSV(content);
const unlockBlock = unlockTok ? `
<p style="margin:14px 0"><a href="https://qixiaoyuan.eu.cc/shop.html#unlock=${order_id}&amp;tok=${unlockTok}" style="display:inline-block;background:#111;color:#fff;font-weight:700;padding:10px 22px;border-radius:10px;text-decoration:none">🔑 查看当前 2FA 验证码</a></p>
<p style="color:#888;font-size:12px">点了直接进订单看实时验证码（每 30 秒换一次），链接 30 天内有效，不用再输密码。</p>` : "";

const html = `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px">
<h2>🎉 你的商品已发货</h2>
<p>订单号：<b>${esc(shortId)}</b></p>
<p>商品：${esc(product_name)}（¥${esc(price)}）</p>
<p>以下是你的虚拟商品交付内容，请妥善保管：</p>
<pre style="background:#f6f6f6;border:1px dashed #ccc;border-radius:8px;padding:14px;white-space:pre-wrap;word-break:break-all">${esc(content)}</pre>
${secret2fa ? `<div style="background:#fff8e1;border:1px solid #f0c36d;border-radius:8px;padding:10px 14px;margin:10px 0">🔐 <b>2FA 密钥</b>（导入验证器 App 用）：<b>${esc(secret2fa)}</b></div>` : ""}${unlockBlock}
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
