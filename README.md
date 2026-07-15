# 流量汇报（Telegram + Cloudflare）

## 仅 Telegram（默认每天 20:00:00）

```bash
ttoken='BOT_TOKEN' tid='CHAT_ID' \
  bash <(curl -fsSL 'https://raw.githubusercontent.com/wuyou18075/tg/refs/heads/main/sum.sh')
```

## 自定义 TG 时间

```bash
ttoken='...' tid='...' ttime='23:00:00' \
  bash <(curl -fsSL 'https://raw.githubusercontent.com/wuyou18075/tg/refs/heads/main/sum.sh')
```

## Telegram + Cloudflare（CF 每小时上报）

```bash
ttoken='...' tid='...' ttime='20:00:00' \
cftime='0 * * * *' \
cfurl='https://traffic-dashboard.<your-subdomain>.workers.dev/api/report' \
cftoken='your-report-token' \
mid='hk-1' \
  bash <(curl -fsSL 'https://raw.githubusercontent.com/wuyou18075/tg/refs/heads/main/sum.sh')
```

### 参数说明

| 变量 | 含义 | 默认 |
|------|------|------|
| `ttoken` | Telegram Bot Token | 交互输入 |
| `tid` | Telegram Chat ID | 交互输入 |
| `ttime` | **TG** 汇报时间，`HH:MM:SS` | `20:00:00` |
| `cftime` | **CF** 汇报 cron（5 段） | 空=不启用 CF |
| `cfurl` | CF Worker 上报 URL | — |
| `cftoken` | 上报 Bearer Token（= `REPORT_TOKEN`） | — |
| `mid` | 机器 ID，如 `hk-1` | — |

### cftime 示例

- `0 * * * *` — 每小时
- `0 */6 * * *` — 每 6 小时
- `*/15 * * * *` — 每 15 分钟

---

## Cloudflare Worker 看板（D1 历史曲线 + 密码登录）

文件：

- `cf-worker-example.js` — Worker 主程序
- `schema.sql` — D1 表结构
- `wrangler.toml` — 部署配置模板

### 1. 创建 D1 并初始化

```bash
npm i -g wrangler
wrangler login
wrangler d1 create traffic-db
# 把返回的 database_id 填进 wrangler.toml
wrangler d1 execute traffic-db --remote --file=./schema.sql
```

### 2. 配置密钥

```bash
wrangler secret put REPORT_TOKEN    # agent 的 cftoken
wrangler secret put DASH_PASSWORD   # 看板登录密码
```

### 3. 部署

```bash
wrangler deploy
```

打开 `https://traffic-dashboard.<subdomain>.workers.dev/`，用 `DASH_PASSWORD` 登录。

### 功能

- **密码登录**：HttpOnly Cookie 会话（7 天）；未设置 `DASH_PASSWORD` 时看板开放（仅建议内测）
- **D1 存储**：`machines` 最新状态 + `snapshots` 历史（≥5 分钟间隔写入，保留 90 天）
- **曲线**：Chart.js 展示今日入站/出站/合计（GB），可选 24h / 3d / 7d / 30d
- **在线状态**：2 小时内有上报标为在线

### API

| 方法 | 路径 | 鉴权 |
|------|------|------|
| POST | `/api/report` | `Authorization: Bearer REPORT_TOKEN` |
| GET | `/api/machines` | 看板 Cookie |
| GET | `/api/history?mid=hk-1&hours=168` | 看板 Cookie |
| GET/POST | `/login` `/logout` | 密码表单 |

### 上报 JSON（agent 已兼容）

```json
{
  "machine_id": "hk-1",
  "hostname": "vps",
  "interface": "eth0",
  "ts": 1720000000,
  "today": { "rx": 1, "tx": 2, "total": 3 },
  "month": { "rx": 4, "tx": 5, "total": 9 }
}
```

---

## 运维（机器侧）

```bash
systemctl status traffic-telegram-report.timer
systemctl status traffic-telegram-report-cf.timer
systemctl start traffic-telegram-report.service
systemctl start traffic-telegram-report-cf.service
journalctl -u traffic-telegram-report.service -u traffic-telegram-report-cf.service
bash sum.sh --uninstall
```
