import { readFileSync, writeFileSync, existsSync } from "fs";

// 自动同步链上 USDT 收款为订单（由 GitHub Actions 定时运行）
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const NETS = {
  bsc:    { label: "BSC", kind: "evm", rpc: "https://bsc.publicnode.com", token: "0x55d398326f99059fF775485246999027B3197955", dec: 18, blockTime: 3, chunk: 20000, seller: "0x5a93d426357cfc7b83d27cec9d4776b05fc73149" },
  arb:    { label: "Arbitrum", kind: "evm", rpc: "https://arb1.arbitrum.io/rpc", token: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", dec: 6, blockTime: 0.25, chunk: 200000, seller: "0x5a93d426357cfc7b83d27cec9d4776b05fc73149" },
  eth:    { label: "Ethereum", kind: "evm", rpc: "https://ethereum-rpc.publicnode.com", token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", dec: 6, blockTime: 12, chunk: 2000, seller: "0x5a93d426357cfc7b83d27cec9d4776b05fc73149" },
  plasma: { label: "Plasma", kind: "evm", rpc: "https://rpc.plasma.to", token: "0xB8CE59FC3717Ada4C02eadf9682A9e934F625ebb", dec: 6, blockTime: 2, chunk: 5000, seller: "0x5a93d426357cfc7b83d27cec9d4776b05fc73149" },
  aptos:  { label: "Aptos", kind: "aptos", rpc: "https://fullnode.mainnet.aptoslabs.com/v1", token: "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b", dec: 6, seller: "0x2727508a879fa5df26da24be64481c49020d8b99ce1219b153e7c14bd7c489b2" },
  sol:    { label: "Solana", kind: "solana", rpc: "https://api.mainnet-beta.solana.com", token: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", dec: 6, seller: "4ubaQ8zwDZcxSeAJPQbuqAVhcspkyPumRQnRDePnshos" },
  tron:   { label: "Tron", kind: "evm", rpc: "https://api.trongrid.io/jsonrpc", token: "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c", dec: 6, blockTime: 3, chunk: 2000, seller: "TB3CqRHMjTY1fNt1GzmJeUg4Y4owTfjm4j", topicAddr: "0x0000000000000000000000000bb9a6a111889e72315516b0a5074c314ee3b87f" }
};
// ===== 收款配置：payment.json 可覆盖收款地址/启停/新增网络 =====
function tronToHex(b58) {
  const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let bytes = [0];
  for (let i = 0; i < b58.length; i++) {
    const v = ALPH.indexOf(b58[i]); if (v < 0) return null;
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { const x = bytes[j] * 58 + carry; bytes[j] = x & 255; carry = x >> 8; }
    while (carry > 0) { bytes.push(carry & 255); carry >>= 8; }
  }
  bytes = bytes.reverse();
  if (bytes.length !== 25 || bytes[0] !== 0x41) return null;
  return "0x" + bytes.slice(1, 21).map(b => ("0" + b.toString(16)).slice(-2)).join("");
}
try {
  const cfg = JSON.parse(readFileSync("payment.json", "utf8"));
  if (cfg && cfg.chains) {
    for (const id of Object.keys(cfg.chains)) {
      const c = cfg.chains[id] || {};
      if (NETS[id]) {
        if (c.seller) NETS[id].seller = c.seller;
        NETS[id].enabled = (c.enabled !== false);
        if (id === "tron") {
          const th = tronToHex(NETS[id].seller);
          if (th) NETS[id].topicAddr = "0x000000000000000000000000" + th.slice(2).toLowerCase();
        }
      } else if (c.label && c.seller && c.rpc && c.token && c.enabled !== false) {
        if ((c.kind || "evm") !== "evm") continue; // 非 EVM 新链暂不支持自动扫描
        const n = { label: c.label, kind: "evm", rpc: c.rpc, token: c.token, dec: c.dec || 6, blockTime: 3, chunk: 2000, seller: c.seller };
        if (n.seller.indexOf("0x") === 0) n.topicAddr = toTopic(n.seller);
        NETS[id] = n;
      }
    }
  }
} catch (e) { console.log("payment.json 未加载，使用默认收款地址:", e.message); }
const INIT_DAYS = 3; // 首次运行向前扫描的天数（EVM 链）

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}
function toTopic(addr) { return "0x000000000000000000000000" + String(addr).slice(2).toLowerCase(); }
function fmtUnits(v, dec) {
  let s = v.toString();
  if (s.length <= dec) s = "0".repeat(dec - s.length + 1) + s;
  const int = s.slice(0, s.length - dec), frac = s.slice(s.length - dec).replace(/0+$/, "").slice(0, 6);
  return frac ? int + "." + frac : int;
}
function fmtT(ts) { // 北京时间
  const d = new Date(ts + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}
function aptosNorm(a) {
  a = String(a || "").toLowerCase();
  if (a.slice(0, 2) !== "0x") a = "0x" + a;
  let h = a.slice(2);
  while (h.length < 64) h = "0" + h;
  return "0x" + h;
}
// Aptos: 解析一笔交易里转给卖家的 USDT 金额（primary_fungible_store 直接转账）
function aptosUsdtToSeller(t, net) {
  try {
    const pl = t.payload || {}, args = pl.arguments || [];
    if (pl.function === "0x1::primary_fungible_store::transfer" && args.length >= 3 &&
        aptosNorm(args[0]) === aptosNorm(net.token) && aptosNorm(args[1]) === aptosNorm(net.seller)) {
      return BigInt(args[2]);
    }
  } catch (e) {}
  return 0n;
}
// Solana: 解析一笔交易里卖家 USDT 账户的净增量
function solUsdtToSeller(tx, net) {
  try {
    const pre = {}, post = {};
    for (const b of (tx.meta.preTokenBalances || []))
      if (b.mint === net.token && String(b.owner) === net.seller) pre[b.accountIndex] = BigInt(b.uiTokenAmount.amount);
    for (const b of (tx.meta.postTokenBalances || []))
      if (b.mint === net.token && String(b.owner) === net.seller) post[b.accountIndex] = BigInt(b.uiTokenAmount.amount);
    let total = 0n;
    for (const k of Object.keys(post)) {
      const d = post[k] - (pre[k] || 0n);
      if (d > 0n) total += d;
    }
    return total;
  } catch (e) { return 0n; }
}

const products = JSON.parse(readFileSync("products.json", "utf8"));
const orders = existsSync("orders.json") ? JSON.parse(readFileSync("orders.json", "utf8")) : [];
const cursor = existsSync(".order-sync.json") ? JSON.parse(readFileSync(".order-sync.json", "utf8")) : {};
const known = new Set(orders.map(o => (o.chain + "|" + String(o.tx || o.id)).toLowerCase()));
let added = 0;
const newOnes = []; // 本次新增的已付款订单（用于邮件提醒）

function addOrder(key, net, txRaw, valueRaw, timeMs, fromAddr) {
  const tx = (net.kind === "solana") ? String(txRaw) : String(txRaw).toLowerCase();
  const id = (key + "|" + tx).toLowerCase();
  if (known.has(id) || valueRaw <= 0n) return;
  const amount = fmtUnits(valueRaw, net.dec);
  const matches = products.filter(p => parseFloat(p.price) === parseFloat(amount));
  const p = matches.length === 1 ? matches[0] : null;
  const one = {
    id: tx, tx: tx,
    productId: p ? p.id : null,
    productName: p ? p.name : "未知商品（" + amount + " USDT，待确认）",
    price: p ? p.price : amount,
    chain: key, chainLabel: net.label,
    from: fromAddr || "", time: fmtT(timeMs),
    status: "pending", auto: true
  };
  orders.unshift(one);
  newOnes.push(one);
  known.add(id);
  added++;
  console.log("new order:", tx, amount, net.label, p ? p.name : "待确认");
}

async function scanEvm(key, net) {
  const topic = net.topicAddr || toTopic(net.seller);
  const latest = parseInt(await rpc(net.rpc, "eth_blockNumber", []), 16);
  let from = cursor[key] ? cursor[key] + 1 : latest - Math.ceil(INIT_DAYS * 86400 / net.blockTime);
  if (from < 0) from = 0;
  if (from > latest) { cursor[key] = latest; return; }
  const found = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function getLogs(a, b) {
    const logs = await rpc(net.rpc, "eth_getLogs", [{ fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16), address: net.token, topics: [TRANSFER, null, topic] }]);
    if (!Array.isArray(logs)) throw new Error("unexpected result shape");
    return logs;
  }
  // 从最新向最旧扫描，遇到归档限制即停止（公共节点只允许查最近一段）
  for (let b = latest; b > from; ) {
    const a = Math.max(from, b - net.chunk);
    let logs;
    try {
      logs = await getLogs(a, b);
    } catch (e) {
      if (/archive/i.test(e.message)) break;
      if (/exceeds max results|too many results|query.*too large|range too large/i.test(e.message) && (b - a) > 200) {
        net.chunk = Math.max(200, Math.floor((b - a) / 2));
        console.log("shrink chunk", key, "to", net.chunk);
        continue;
      }
      await sleep(3000); // 可能是限流，等一下重试一次
      try { logs = await getLogs(a, b); }
      catch (e2) {
        console.log("chunk failed", key, a, b, e2.message);
        b = a - 1;
        continue;
      }
    }
    for (const l of logs) {
      if (BigInt(l.data) <= 0n) continue;
      found.push({ tx: l.transactionHash, value: BigInt(l.data), block: l.blockNumber, fromAddr: "0x" + l.topics[1].slice(26) });
    }
    b = a - 1;
    await sleep(400); // 避免触发公共节点限流
  }
  const tmap = {};
  for (const blk of [...new Set(found.map(f => f.block))]) {
    try { const b = await rpc(net.rpc, "eth_getBlockByNumber", [blk, false]); tmap[blk] = parseInt(b.timestamp, 16) * 1000; }
    catch (e) { tmap[blk] = Date.now(); }
  }
  found.sort((x, y) => tmap[x.block] - tmap[y.block]);
  for (const f of found) addOrder(key, net, f.tx, f.value, tmap[f.block], f.fromAddr);
  cursor[key] = latest;
}

async function scanSolana(key, net) {
  const sigs = await rpc(net.rpc, "getSignaturesForAddress", [net.seller, { limit: 1000 }]);
  const list = sigs || [];
  const lastSeen = cursor[key] || null;
  const fresh = [];
  for (const s of list) {
    if (lastSeen && s.signature === lastSeen) break;
    if (!s.err) fresh.push(s);
  }
  for (const s of fresh.reverse()) {
    let tx = null;
    try { tx = await rpc(net.rpc, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]); }
    catch (e) { console.log("sol tx failed", key, s.signature.slice(0, 12), e.message); continue; }
    if (!tx || !tx.meta || tx.meta.err !== null) continue;
    const delta = solUsdtToSeller(tx, net);
    if (delta <= 0n) continue;
    let sender = "";
    try { sender = tx.transaction.message.accountKeys[0].pubkey || ""; } catch (e) {}
    addOrder(key, net, s.signature, delta, (tx.blockTime || Date.now() / 1000) * 1000, sender);
  }
  if (list.length) cursor[key] = list[0].signature;
}

async function scanAptos(key, net) {
  const r = await fetch(net.rpc + "/accounts/" + net.seller + "/transactions?limit=100");
  const txns = await r.json();
  const list = Array.isArray(txns) ? txns : [];
  const lastVer = cursor[key] ? BigInt(cursor[key]) : null;
  const fresh = [];
  for (const t of list) {
    if (lastVer !== null && BigInt(t.version) <= lastVer) break;
    if (t.success && aptosUsdtToSeller(t, net) > 0n) fresh.push(t);
  }
  for (const t of fresh.reverse()) {
    const ts = parseInt(t.timestamp || "0", 10);
    addOrder(key, net, t.hash, aptosUsdtToSeller(t, net), ts > 0 ? Math.floor(ts / 1000) : Date.now(), t.sender || "");
  }
  if (list.length) cursor[key] = String(list[0].version);
}

for (const [key, net] of Object.entries(NETS)) {
  if (net.enabled === false) { console.log("skip disabled", key); continue; }
  if (!net.rpc || !net.token) { console.log("skip noauto", key); continue; }
  try {
    if (net.kind === "solana") await scanSolana(key, net);
    else if (net.kind === "aptos") await scanAptos(key, net);
    else await scanEvm(key, net);
  } catch (e) {
    console.log("scan failed", key, e.message);
  }
}
writeFileSync("orders.json", JSON.stringify(orders));
writeFileSync(".order-sync.json", JSON.stringify(cursor));
console.log("done, added " + added + " orders");

// ===== 付款提醒邮件（Resend 免费版）：扫到新付款就通知店主发货 =====
// 需要在 GitHub 仓库 Secrets 里设置 RESEND_API_KEY 和 NOTIFY_EMAIL；
// 没设置就不发邮件，不影响同步流程。
async function notifyNewOrders(list){
  const apiKey = process.env.RESEND_API_KEY || "";
  const to = process.env.NOTIFY_EMAIL || "";
  if(!apiKey || !to || !list.length) return;
  const lines = list.map(o =>
    "• " + o.time + "｜" + o.chainLabel + "｜" + o.price + " USD｜" + o.productName + "｜交易 " + String(o.tx).slice(0, 20) + "…"
  ).join("\n");
  try{
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "哆啦A梦小店 <onboarding@resend.dev>",
        to: [to],
        subject: "【待发货】收到 " + list.length + " 笔新的 USDT 付款",
        text: "你的小店收到新的付款，请及时发货：\n\n" + lines +
          "\n\n管理后台：https://qixiaoyuang.github.io/qixiaoyuanboke/admin/"
      })
    });
    const j = await r.json().catch(() => ({}));
    console.log(r.ok ? ("提醒邮件已发送 " + (j.id || "")) : ("邮件发送失败: " + JSON.stringify(j).slice(0, 200)));
  }catch(e){ console.log("邮件发送异常:", e.message); }
}
await notifyNewOrders(newOnes);
