// 通用发件模块：通过 SMTP 直发（465 端口隐式 TLS），在 GitHub Actions 里运行，无外部依赖。
// 环境变量：
//   SMTP_HOST  如 smtp.qq.com
//   SMTP_PORT  默认 465
//   SMTP_USER  登录邮箱，如 lslq6@foxmail.com（QQ 邮箱用完整地址）
//   SMTP_PASS  SMTP 授权码（QQ 邮箱是「授权码」，不是登录密码）
//   SMTP_FROM  发件人显示，如：祁萧远小店 <lslq6@foxmail.com>（可选，默认用 SMTP_USER）

import tls from "tls";

const CRLF = "\r\n";
const b64 = s => Buffer.from(String(s), "utf8").toString("base64");

function parseFrom(raw, user) {
  const m = String(raw || "").match(/^(.*)<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].trim(), addr = m[2].trim();
    const encName = name ? `=?UTF-8?B?${b64(name)}?=` : "";
    return { header: encName ? `${encName} <${addr}>` : addr, addr };
  }
  return { header: user, addr: user };
}

export async function sendMail({ to, subject, html }) {
  const host = process.env.SMTP_HOST || "";
  const port = parseInt(process.env.SMTP_PORT || "465", 10);
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  if (!host || !user || !pass) return { ok: false, error: "未配置 SMTP_HOST / SMTP_USER / SMTP_PASS" };

  const from = parseFrom(process.env.SMTP_FROM || "", user);
  const headers =
    `From: ${from.header}${CRLF}` +
    `To: ${to}${CRLF}` +
    `Subject: =?UTF-8?B?${b64(subject)}?=${CRLF}` +
    `Date: ${new Date().toUTCString()}${CRLF}` +
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2, 8)}@${host}>${CRLF}` +
    `MIME-Version: 1.0${CRLF}` +
    `Content-Type: text/html; charset=utf-8${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}`;
  const bodyB64 = b64(html).replace(/.{76}(?=.)/g, "$&\r\n");
  const payload = headers + CRLF + bodyB64 + `${CRLF}.${CRLF}`;

  return await new Promise(resolve => {
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) {}
      resolve({ ok, error });
    };
    const sock = tls.connect({ host, port, servername: host });
    sock.setEncoding("utf8");
    sock.setTimeout(25000, () => done(false, "SMTP 连接超时"));
    sock.on("error", e => done(false, "SMTP 连接失败: " + e.message));

    let buf = "";
    const pending = [];
    const pumpLine = line => {
      const job = pending.shift();
      if (!job) return;
      if (line[3] === "-") { pending.unshift(job); return; } // 多行响应，等最后一行
      const code = parseInt(line.slice(0, 3), 10);
      if (job.expect.includes(code)) job.res(line);
      else job.rej(new Error(`${job.label} 失败: ${line}`));
    };
    sock.on("data", d => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf(CRLF)) >= 0) {
        pumpLine(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    });
    const cmd = (c, expect, label) => new Promise((res, rej) => {
      pending.push({ expect, res, rej, label: label || c.split(" ")[0] });
      sock.write(c + CRLF);
    });

    (async () => {
      try {
        await new Promise((res, rej) => pending.push({ expect: [220], res, rej, label: "GREET" }));
        await cmd(`EHLO ${host}`, [250]);
        await cmd("AUTH LOGIN", [334]);
        await cmd(b64(user), [334], "USER");
        await cmd(b64(pass), [235], "PASS");
        await cmd(`MAIL FROM:<${from.addr}>`, [250]);
        await cmd(`RCPT TO:<${to}>`, [250, 251]);
        await new Promise((res, rej) => { // DATA 内容 + 结束点直接写，不走 cmd 的换行拼接
          pending.push({ expect: [354], res, rej, label: "DATA" });
          sock.write("DATA" + CRLF);
        });
        await new Promise((res, rej) => {
          pending.push({ expect: [250], res, rej, label: "SEND" });
          sock.write(payload);
        });
        try { await cmd("QUIT", [221]); } catch (e) {}
        done(true);
      } catch (e) { done(false, e.message); }
    })();
  });
}
