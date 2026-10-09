// 卡密商品自动发货：工作流每分钟一轮（cron-job.org 每分钟 dispatch；定时触发时每 5 分钟跑 4 轮）。
// 1. 查 Supabase 里待支付/待发货的虚拟+免费商品订单（3 天内）
// 2. 用本轮 order-sync 刚扫描到的链上付款（orders.json）按 金额+时间 匹配
// 3. 匹配成功 → 登记 tx → 调 distribute_ship_code 自动发码 → 订单变 shipped
// 4. 邮件由同工作流的「自动补发虚拟商品邮件」步骤发出（幂等，不重复）
// 无卡密（NO_CODES）则保持 pending，等卖家补码后下轮自动重试。
// 5. 缺货提醒：买家已付款（或免费领取）但卡密不足、订单卡住超过 15 分钟 → 发邮件提醒卖家补码
//    （见文件末尾 stockAlertIfNeeded；提醒状态记在 ship._stockAlertAt，每单每小时最多提醒一次）
// 需要 Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// 可选: NOTIFY_EMAIL（卖家邮箱，不填则不发缺货提醒）, SMTP_HOST/PORT/USER/PASS/FROM（发件）

const SB_URL = process.env.SUPABASE_URL || "";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SB_URL || !SB_KEY) { console.log("未配置 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，跳过。"); process.exit(0); }

import { readFileSync, existsSync } from "fs";
import { sendMail } from "./mailer.mjs";

const headers = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };
const normTx = (chain, tx) => chain === "solana" ? String(tx) : String(tx).toLowerCase();
// orders.json 的时间是北京时间 "YYYY-MM-DD HH:MM"，转毫秒
function bjTimeMs(s) {
  const m = String(s || "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]);
}

// 商品类型映射（只自动处理虚拟/免费商品）
let ptypeOf = {};
try {
  const products = JSON.parse(readFileSync("products.json", "utf8"));
  for (const p of products) ptypeOf[p.id] = p.ptype || "virtual";
} catch (e) { console.log("products.json 读取失败:", e.message); }

// 本轮扫描到的链上付款
let payments = [];
try {
  const orders = existsSync("orders.json") ? JSON.parse(readFileSync("orders.json", "utf8")) : [];
  payments = orders
    .filter(o => o.tx && o.chain && o.price != null && o.time)
    .map(o => ({ chain: o.chain, tx: normTx(o.chain, o.tx), amount: parseFloat(o.price), t: bjTimeMs(o.time) }))
    .filter(p => p.t > 0 && p.amount > 0);
} catch (e) { console.log("orders.json 读取失败:", e.message); }
console.log(`链上付款记录：${payments.length} 笔`);

// 3 天内的待支付/待发货订单
const since = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
const qr = await fetch(
  `${SB_URL}/rest/v1/orders?select=id,product_id,product_name,price,chain,tx,ship,status,created_at` +
  `&status=in.(unpaid,pending)&created_at=gte.${encodeURIComponent(since)}&order=created_at.asc&limit=200`,
  { headers }
);
if (!qr.ok) { console.log("读取订单失败:", qr.status, (await qr.text()).slice(0, 200)); process.exit(1); }
const sbOrders = await qr.json();
console.log(`待处理订单：${sbOrders.length} 个`);

const claimed = new Set(); // 本轮已认领的付款 tx（防一单多配）
let fulfilled = 0, noCodes = 0;

async function distribute(orderId) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/distribute_ship_code`, {
    method: "POST", headers, body: JSON.stringify({ p_order_id: orderId })
  });
  const t = await r.text();
  if (!r.ok) {
    if (/NO_CODES/i.test(t)) return { ok: false, noCodes: true };
    return { ok: false, error: t.slice(0, 120) };
  }
  return { ok: true };
}

for (const o of sbOrders) {
  const ptype = ptypeOf[o.product_id];
  if (ptype !== "virtual" && ptype !== "freebie") continue; // 只处理虚拟/免费商品
  const ship = o.ship || {};
  if (ship.content) continue; // 已有发货内容，跳过

  // 免费商品：无付款，直接尝试发码
  if (ptype === "freebie") {
    const d = await distribute(o.id);
    if (d.ok) { fulfilled++; console.log("免费领取自动发码:", o.id.slice(0, 8)); }
    else if (d.noCodes) { noCodes++; }
    else console.log("发码失败:", o.id.slice(0, 8), d.error);
    continue;
  }

  // 虚拟商品：已有 tx 但没发码（之前卡密不足）→ 直接重试发码
  if (o.tx) {
    const d = await distribute(o.id);
    if (d.ok) { fulfilled++; console.log("补发卡密:", o.id.slice(0, 8)); }
    else if (d.noCodes) { noCodes++; }
    else console.log("发码失败:", o.id.slice(0, 8), d.error);
    continue;
  }

  // 待支付订单：按 金额+时间 匹配链上付款
  const need = parseFloat(o.price);
  const createdMs = new Date(o.created_at).getTime() || 0;
  const match = payments.find(p =>
    !claimed.has(p.tx) &&
    p.chain === o.chain &&
    p.amount + 1e-9 >= need &&
    p.t >= createdMs - 5 * 60 * 1000 // 付款在下单前后（5 分钟容差）
  );
  if (!match) continue;

  claimed.add(match.tx);
  const txl = normTx(o.chain, match.tx);
  const pr = await fetch(`${SB_URL}/rest/v1/orders?id=eq.${o.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ tx: txl, status: "pending" })
  });
  if (!pr.ok) { console.log("登记 tx 失败:", o.id.slice(0, 8), (await pr.text()).slice(0, 100)); continue; }

  const d = await distribute(o.id);
  if (d.ok) { fulfilled++; console.log("自动发货:", o.id.slice(0, 8), "→", txl.slice(0, 12)); }
  else if (d.noCodes) { noCodes++; console.log("付款已登记，卡密不足待补充:", o.id.slice(0, 8)); }
  else console.log("发码失败:", o.id.slice(0, 8), d.error);
}

console.log(`完成：自动发货 ${fulfilled} 单${noCodes ? `，${noCodes} 单卡密不足待补充` : ""}`);

// ===== 卡密缺货提醒邮件 =====
// 买家已付款（或免费领取）但卡密库为空、订单卡住超过 15 分钟 → 发邮件提醒卖家去后台补码。
// 去重：提醒时间记在订单 ship._stockAlertAt 里，每单每小时最多提醒一次；
// 补码发货成功后订单不再符合"卡住"条件，自动停止提醒。无需改工作流文件。
const NOTIFY_TO = (process.env.NOTIFY_EMAIL || "").trim();
async function stockAlertIfNeeded() {
  if (!NOTIFY_TO) { console.log("未配置 NOTIFY_EMAIL，跳过缺货提醒。"); return; }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log("未配置 SMTP，跳过缺货提醒。"); return;
  }
  const WAIT_MIN = 15;      // 等待超过多少分钟算"未及时补充"
  const REPEAT_HOURS = 1;   // 同一订单最多每小时提醒一次
  const now = Date.now();
  const stuck = [];
  for (const o of sbOrders) {
    const ptype = ptypeOf[o.product_id];
    if (ptype !== "virtual" && ptype !== "freebie") continue;
    const ship = o.ship || {};
    if (ship.content) continue;                  // 已发货
    if (ptype === "virtual" && !o.tx) continue;   // 未付款，无需发码
    const createdMs = new Date(o.created_at).getTime() || 0;
    if ((now - createdMs) / 60000 < WAIT_MIN) continue;
    const lastAlert = ship._stockAlertAt ? new Date(ship._stockAlertAt).getTime() : 0;
    if (lastAlert && now - lastAlert < REPEAT_HOURS * 3600 * 1000) continue;
    stuck.push({ o, waitMin: Math.round((now - createdMs) / 60000) });
  }
  if (!stuck.length) { console.log("缺货提醒：无卡住订单。"); return; }

  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const shortId = id => String(id || "").replace(/-/g, "").slice(0, 8).toUpperCase();
  const rows = stuck.map(({ o, waitMin }) =>
    "<tr><td style=\"padding:6px 10px;border:1px solid #ddd\">" + esc(shortId(o.id)) + "</td>" +
    "<td style=\"padding:6px 10px;border:1px solid #ddd\">" + esc(o.product_name || "") + "</td>" +
    "<td style=\"padding:6px 10px;border:1px solid #ddd\">" + esc(o.price) + " USD</td>" +
    "<td style=\"padding:6px 10px;border:1px solid #ddd\">等待约 " + waitMin + " 分钟</td></tr>"
  ).join("");
  const html =
    "<div style=\"font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px\">" +
    "<h2>⚠️ 卡密缺货：" + stuck.length + " 个订单等待发货</h2>" +
    "<p>以下订单买家已付款（或已领取）但卡密库为空，等待已超过 " + WAIT_MIN + " 分钟：</p>" +
    "<table style=\"border-collapse:collapse;font-size:14px\"><tr>" +
    "<th style=\"padding:6px 10px;border:1px solid #ddd;background:#f6f6f6\">订单号</th>" +
    "<th style=\"padding:6px 10px;border:1px solid #ddd;background:#f6f6f6\">商品</th>" +
    "<th style=\"padding:6px 10px;border:1px solid #ddd;background:#f6f6f6\">金额</th>" +
    "<th style=\"padding:6px 10px;border:1px solid #ddd;background:#f6f6f6\">等待</th></tr>" + rows + "</table>" +
    "<p>请去 <b>后台 → 商品管理 → 卡密库</b> 补充卡密，补码后下一分钟工作流会自动把积压订单发出，无需手动操作。</p>" +
    "<p style=\"color:#888;font-size:12px\">同一订单每小时最多提醒一次；发货成功后自动停止提醒。</p></div>";
  const r = await sendMail({ to: NOTIFY_TO, subject: "【卡密缺货】" + stuck.length + " 个订单等待发货超过" + WAIT_MIN + "分钟", html });
  console.log(r.ok ? ("缺货提醒邮件已发送（" + stuck.length + " 单）→ " + NOTIFY_TO) : ("缺货提醒邮件发送失败：" + r.error));
  if (!r.ok) return;
  for (const { o } of stuck) { // 写回提醒时间（重读 ship 防覆盖已有字段）
    try {
      const gr = await fetch(`${SB_URL}/rest/v1/orders?select=ship&id=eq.${o.id}`, { headers });
      const grows = await gr.json();
      const ship = (grows[0] && grows[0].ship) || {};
      ship._stockAlertAt = new Date().toISOString();
      await fetch(`${SB_URL}/rest/v1/orders?id=eq.${o.id}`, {
        method: "PATCH", headers, body: JSON.stringify({ ship })
      });
    } catch (e) { console.log("回写提醒时间失败:", o.id, e.message); }
  }
}
await stockAlertIfNeeded();
