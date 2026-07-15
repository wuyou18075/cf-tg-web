/**
 * Cloudflare Worker：多机流量中心（D1 历史 + 密码看板）
 *
 * 部署：
 *   1. wrangler d1 create traffic-db
 *   2. wrangler d1 execute traffic-db --file=./schema.sql
 *   3. wrangler secret put REPORT_TOKEN   # agent 上报用
 *   4. wrangler secret put DASH_PASSWORD  # 看板登录密码
 *   5. wrangler deploy
 *
 * wrangler.toml 示例见同目录注释 / README
 *
 * 路由：
 *   POST /api/report              — agent 上报（Bearer REPORT_TOKEN）
 *   GET  /api/machines            — 机器列表（需看板 Cookie）
 *   GET  /api/history?mid=&hours= — 历史点（需看板 Cookie）
 *   GET  /login  POST /login      — 看板登录
 *   POST /logout
 *   GET  /                        — 看板（需登录）
 */

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 天
const COOKIE_NAME = "dash_session";

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extra,
    },
  });

const html = (body, status = 200, extra = {}) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...extra,
    },
  });

function gb(n) {
  const v = Number(n) || 0;
  return (v / 1e9).toFixed(3) + "GB";
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function reportAuth(req, env) {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return !!(env.REPORT_TOKEN && m && m[1] === env.REPORT_TOKEN);
}

function parseCookies(req) {
  const raw = req.headers.get("cookie") || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeSessionToken(env) {
  const rnd = crypto.randomUUID() + crypto.randomUUID();
  const sig = await sha256Hex(`${rnd}:${env.DASH_PASSWORD || ""}:dash`);
  return `${rnd}.${sig}`;
}

async function verifySessionToken(token, env) {
  if (!token || !env.DASH_PASSWORD) return false;
  const i = token.lastIndexOf(".");
  if (i < 0) return false;
  const rnd = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = await sha256Hex(`${rnd}:${env.DASH_PASSWORD}:dash`);
  return sig === expect && rnd.length >= 32;
}

function sessionCookie(token, maxAge = SESSION_TTL) {
  const secure = "Secure; ";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=${maxAge}`;
}

async function requireDash(req, env) {
  // 未配置密码时：开放看板（仅适合内测）
  if (!env.DASH_PASSWORD) return true;
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME], env);
}

async function ensureSchema(env) {
  if (!env.DB) return;
  // 幂等建表（首次部署可改用 schema.sql）
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS machines (
        machine_id TEXT PRIMARY KEY,
        hostname TEXT,
        interface TEXT,
        last_ts INTEGER,
        today_rx INTEGER,
        today_tx INTEGER,
        month_rx INTEGER,
        month_tx INTEGER,
        updated_at INTEGER
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        today_rx INTEGER,
        today_tx INTEGER,
        month_rx INTEGER,
        month_tx INTEGER
      )
    `),
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_snap_mid_ts ON snapshots(machine_id, ts)`,
    ),
  ]);
}

async function upsertReport(env, rec) {
  const mid = rec.machine_id;
  const ts = Number(rec.ts) || Math.floor(Date.now() / 1000);
  const today = rec.today || {};
  const month = rec.month || {};
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO machines (
      machine_id, hostname, interface, last_ts,
      today_rx, today_tx, month_rx, month_tx, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine_id) DO UPDATE SET
      hostname=excluded.hostname,
      interface=excluded.interface,
      last_ts=excluded.last_ts,
      today_rx=excluded.today_rx,
      today_tx=excluded.today_tx,
      month_rx=excluded.month_rx,
      month_tx=excluded.month_tx,
      updated_at=excluded.updated_at`,
  )
    .bind(
      mid,
      rec.hostname || "",
      rec.interface || "",
      ts,
      Number(today.rx) || 0,
      Number(today.tx) || 0,
      Number(month.rx) || 0,
      Number(month.tx) || 0,
      now,
    )
    .run();

  // 节流写历史：同一机器 5 分钟内只记 1 条，避免每分钟刷爆
  const last = await env.DB.prepare(
    `SELECT ts FROM snapshots WHERE machine_id = ? ORDER BY ts DESC LIMIT 1`,
  )
    .bind(mid)
    .first();

  if (!last || ts - Number(last.ts) >= 300) {
    await env.DB.prepare(
      `INSERT INTO snapshots (machine_id, ts, today_rx, today_tx, month_rx, month_tx)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        mid,
        ts,
        Number(today.rx) || 0,
        Number(today.tx) || 0,
        Number(month.rx) || 0,
        Number(month.tx) || 0,
      )
      .run();
  }

  // 清理 90 天前快照
  await env.DB.prepare(
    `DELETE FROM snapshots WHERE ts < ?`,
  )
    .bind(now - 90 * 86400)
    .run();
}

async function listMachines(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM machines ORDER BY last_ts DESC`,
  ).all();
  return (results || []).map((r) => ({
    machine_id: r.machine_id,
    hostname: r.hostname,
    interface: r.interface,
    ts: r.last_ts,
    today: { rx: r.today_rx, tx: r.today_tx, total: (r.today_rx || 0) + (r.today_tx || 0) },
    month: { rx: r.month_rx, tx: r.month_tx, total: (r.month_rx || 0) + (r.month_tx || 0) },
    updated_at: r.updated_at,
  }));
}

async function history(env, mid, hours) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const { results } = await env.DB.prepare(
    `SELECT ts, today_rx, today_tx, month_rx, month_tx
     FROM snapshots
     WHERE machine_id = ? AND ts >= ?
     ORDER BY ts ASC`,
  )
    .bind(mid, since)
    .all();
  return results || [];
}

function loginPage(err = "") {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 流量看板</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0b1220;color:#e8eefc}
.card{width:min(360px,92vw);background:#121a2b;border:1px solid #243049;border-radius:14px;padding:28px 24px;box-shadow:0 12px 40px #0006}
h1{font-size:18px;margin:0 0 6px}
p{margin:0 0 18px;color:#8aa0c6;font-size:13px}
label{display:block;font-size:12px;color:#9fb3d9;margin-bottom:6px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #33415f;background:#0b1220;color:#e8eefc;margin-bottom:14px}
button{width:100%;padding:10px 12px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
.err{color:#fca5a5;font-size:13px;margin-bottom:10px;min-height:1.2em}
</style>
<div class="card">
  <h1>流量看板</h1>
  <p>请输入管理密码</p>
  ${err ? `<div class="err">${esc(err)}</div>` : `<div class="err"></div>`}
  <form method="post" action="/login">
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">登录</button>
  </form>
</div>`;
}

function dashboardPage() {
  // 前端拉 /api/machines 与 /api/history，用 Chart.js 画曲线
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>流量看板</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;background:#0b1220;color:#e8eefc}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #1e2a42;background:#0e1628}
h1{font-size:18px;margin:0}
.muted{color:#8aa0c6;font-size:13px}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
select,button{background:#121a2b;color:#e8eefc;border:1px solid #33415f;border-radius:8px;padding:8px 10px}
button{cursor:pointer}
button.primary{background:#3b82f6;border-color:#3b82f6;font-weight:600}
main{padding:16px 20px 40px;max-width:1200px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}
.card{background:#121a2b;border:1px solid #243049;border-radius:12px;padding:14px}
.card .label{font-size:12px;color:#8aa0c6}
.card .val{font-size:20px;font-weight:700;margin-top:6px}
.panel{background:#121a2b;border:1px solid #243049;border-radius:12px;padding:14px;margin-bottom:16px}
.panel h2{font-size:14px;margin:0 0 12px;color:#9fb3d9;font-weight:600}
.chart-wrap{position:relative;height:280px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:10px 8px;border-bottom:1px solid #243049;text-align:left}
th{color:#9fb3d9;font-weight:600}
tr{cursor:pointer}
tr.active{background:#1a2740}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;background:#1e3a5f;color:#93c5fd}
.badge.off{background:#3f1d1d;color:#fca5a5}
</style>
<header>
  <div>
    <h1>流量看板</h1>
    <div class="muted">D1 历史 · 点击表格行切换曲线</div>
  </div>
  <div class="actions">
    <label class="muted">范围
      <select id="range">
        <option value="24">24 小时</option>
        <option value="72">3 天</option>
        <option value="168" selected>7 天</option>
        <option value="720">30 天</option>
      </select>
    </label>
    <button type="button" class="primary" id="btnRefresh">刷新</button>
    <form method="post" action="/logout" style="margin:0"><button type="submit">退出</button></form>
  </div>
</header>
<main>
  <div class="cards" id="summary"></div>
  <div class="panel">
    <h2>历史曲线 · 今日累计（字节→GB）</h2>
    <div class="chart-wrap"><canvas id="chart"></canvas></div>
  </div>
  <div class="panel">
    <h2>机器列表</h2>
    <div style="overflow:auto">
      <table>
        <thead>
          <tr>
            <th>机器</th><th>主机</th><th>网卡</th>
            <th>今日入/出</th><th>本月入/出</th><th>最后上报</th><th>状态</th>
          </tr>
        </thead>
        <tbody id="tbody"><tr><td colspan="7">加载中…</td></tr></tbody>
      </table>
    </div>
  </div>
</main>
<script>
const gb = (n) => ((Number(n)||0)/1e9).toFixed(3) + 'GB';
const fmtTime = (ts) => ts ? new Date(ts*1000).toLocaleString() : '-';
let machines = [];
let selected = null;
let chart;

async function api(path) {
  const r = await fetch(path, { credentials: 'same-origin' });
  if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function online(ts) {
  if (!ts) return false;
  return (Date.now()/1000 - ts) < 2*3600; // 2 小时内有上报视为在线
}

function renderSummary() {
  const sum = machines.reduce((a,m)=>({
    today_rx: a.today_rx + (m.today?.rx||0),
    today_tx: a.today_tx + (m.today?.tx||0),
    month_rx: a.month_rx + (m.month?.rx||0),
    month_tx: a.month_tx + (m.month?.tx||0),
  }), {today_rx:0,today_tx:0,month_rx:0,month_tx:0});
  const on = machines.filter(m => online(m.ts)).length;
  document.getElementById('summary').innerHTML = `
    <div class="card"><div class="label">机器数</div><div class="val">${machines.length}</div></div>
    <div class="card"><div class="label">在线（2h）</div><div class="val">${on}</div></div>
    <div class="card"><div class="label">今日合计</div><div class="val">${gb(sum.today_rx+sum.today_tx)}</div></div>
    <div class="card"><div class="label">本月合计</div><div class="val">${gb(sum.month_rx+sum.month_tx)}</div></div>`;
}

function renderTable() {
  const tb = document.getElementById('tbody');
  if (!machines.length) {
    tb.innerHTML = '<tr><td colspan="7">暂无数据，请确认 agent 已上报</td></tr>';
    return;
  }
  tb.innerHTML = machines.map(m => {
    const active = m.machine_id === selected ? 'active' : '';
    const st = online(m.ts)
      ? '<span class="badge">在线</span>'
      : '<span class="badge off">离线</span>';
    return `<tr class="${active}" data-mid="${m.machine_id}">
      <td>${m.machine_id||''}</td>
      <td>${m.hostname||''}</td>
      <td>${m.interface||''}</td>
      <td>${gb(m.today?.rx)} / ${gb(m.today?.tx)}</td>
      <td>${gb(m.month?.rx)} / ${gb(m.month?.tx)}</td>
      <td>${fmtTime(m.ts)}</td>
      <td>${st}</td>
    </tr>`;
  }).join('');
  tb.querySelectorAll('tr[data-mid]').forEach(tr => {
    tr.addEventListener('click', () => {
      selected = tr.dataset.mid;
      renderTable();
      loadHistory();
    });
  });
}

async function loadHistory() {
  if (!selected) return;
  const hours = document.getElementById('range').value;
  const data = await api(`/api/history?mid=${encodeURIComponent(selected)}&hours=${hours}`);
  const pts = data.points || [];
  const labels = pts.map(p => {
    const d = new Date(p.ts*1000);
    return d.toLocaleString(undefined, { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  });
  const rx = pts.map(p => (Number(p.today_rx)||0)/1e9);
  const tx = pts.map(p => (Number(p.today_tx)||0)/1e9);
  const total = pts.map((p,i) => rx[i]+tx[i]);
  const ctx = document.getElementById('chart');
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '今日入站 GB', data: rx, borderColor: '#60a5fa', tension: 0.25, pointRadius: 0, borderWidth: 2 },
        { label: '今日出站 GB', data: tx, borderColor: '#34d399', tension: 0.25, pointRadius: 0, borderWidth: 2 },
        { label: '今日合计 GB', data: total, borderColor: '#fbbf24', tension: 0.25, pointRadius: 0, borderWidth: 2 },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 8, color: '#8aa0c6' }, grid: { color: '#1e2a42' } },
        y: { ticks: { color: '#8aa0c6' }, grid: { color: '#1e2a42' }, title: { display: true, text: 'GB', color: '#8aa0c6' } }
      },
      plugins: {
        legend: { labels: { color: '#c7d2fe' } },
        title: { display: true, text: selected, color: '#e8eefc' }
      }
    }
  });
}

async function refresh() {
  const data = await api('/api/machines');
  machines = data.machines || [];
  if (!selected && machines[0]) selected = machines[0].machine_id;
  if (selected && !machines.find(m => m.machine_id === selected)) {
    selected = machines[0]?.machine_id || null;
  }
  renderSummary();
  renderTable();
  await loadHistory();
}

document.getElementById('btnRefresh').onclick = () => refresh().catch(alert);
document.getElementById('range').onchange = () => loadHistory().catch(alert);
refresh().catch(e => {
  document.getElementById('tbody').innerHTML = `<tr><td colspan="7">加载失败：${e.message}</td></tr>`;
});
</script>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // 初始化表（轻量幂等）
    if (env.DB) {
      try {
        await ensureSchema(env);
      } catch (e) {
        // 忽略重复初始化竞争
      }
    }

    // —— 上报（机器侧）——
    if (req.method === "POST" && url.pathname === "/api/report") {
      if (!reportAuth(req, env)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      if (!env.DB) {
        return json({ ok: false, error: "DB not bound" }, 500);
      }
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "invalid json" }, 400);
      }
      const mid = body.machine_id || req.headers.get("x-machine-id");
      if (!mid || !/^[A-Za-z0-9._:-]{1,64}$/.test(mid)) {
        return json({ ok: false, error: "machine_id invalid" }, 400);
      }
      const rec = { ...body, machine_id: mid };
      await upsertReport(env, rec);
      return json({ ok: true });
    }

    // —— 登录 ——
    if (url.pathname === "/login") {
      if (req.method === "GET") {
        if (await requireDash(req, env)) {
          return Response.redirect(new URL("/", url).toString(), 302);
        }
        return html(loginPage());
      }
      if (req.method === "POST") {
        const form = await req.formData();
        const password = String(form.get("password") || "");
        if (!env.DASH_PASSWORD) {
          // 未设密码：直接进
          return Response.redirect(new URL("/", url).toString(), 302);
        }
        if (password !== env.DASH_PASSWORD) {
          return html(loginPage("密码错误"), 401);
        }
        const token = await makeSessionToken(env);
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie": sessionCookie(token),
          },
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/login",
          "Set-Cookie": sessionCookie("", 0),
        },
      });
    }

    // —— 需登录的 API / 页面 ——
    if (!(await requireDash(req, env))) {
      if (url.pathname.startsWith("/api/")) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return Response.redirect(new URL("/login", url).toString(), 302);
    }

    if (req.method === "GET" && url.pathname === "/api/machines") {
      if (!env.DB) return json({ ok: true, machines: [] });
      const machines = await listMachines(env);
      return json({ ok: true, machines });
    }

    if (req.method === "GET" && url.pathname === "/api/history") {
      if (!env.DB) return json({ ok: true, points: [] });
      const mid = url.searchParams.get("mid") || "";
      const hours = Math.min(
        24 * 90,
        Math.max(1, Number(url.searchParams.get("hours") || 168)),
      );
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(mid)) {
        return json({ ok: false, error: "mid invalid" }, 400);
      }
      const points = await history(env, mid, hours);
      return json({ ok: true, machine_id: mid, hours, points });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return html(dashboardPage());
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
