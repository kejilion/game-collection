# 大乱斗 · Arena Brawl

一个 2D 卡通风格的 **实时多人在线大乱斗** 网页游戏。多个浏览器打开同一个网址即可同场竞技 —— 一张大地图常驻待命，选职业、起名字、立刻开打。

服务器是**权威式**架构（所有逻辑在服务端模拟），客户端用 HTML5 Canvas 程序化绘制卡通画面，带客户端预测 + 插值，手感顺滑。无需任何构建步骤，开箱即跑，可一键打包成 Docker 镜像部署到 Linux 服务器。

![tech](https://img.shields.io/badge/node-%3E%3D18-3c873a) ![ws](https://img.shields.io/badge/realtime-WebSocket-5b8cff) ![canvas](https://img.shields.io/badge/render-Canvas2D-a368ff)

---

## ✨ 功能一览

| 模块 | 说明 |
|---|---|
| **常驻大地图** | 服务器启动即创建 3200×2200 世界实例，30Hz 模拟 / 20Hz 广播，无人也持续运行 |
| **三大职业** | ⚔ 战士（范围近战）、🔮 法师（远程火球）、🗡 刺客（高暴击瞬步） |
| **双技能 + 解锁** | 每职业 1 个出生签名技 + 1 个 **Lv.3 解锁**的第二技能：战士「铁壁战吼」(减伤/回血)、法师「霜雪新星」(范围减速)、刺客「影遁」(瞬遁隐身)；技能栏锁定槽会显示解锁等级 |
| **随机刷新** | 角色、道具、BOSS、神秘商人均在随机位置生成 |
| **状态道具** | 加血 / 加速 / 加攻速 / 隐身10秒 / 多一条命 / 加防御 / 加攻击 / 经验药水 / 全图显示 / 金币宝箱 |
| **BOSS** | 自带冲撞、地震波、环形弹幕；击杀给大量经验与金币 |
| **神秘商人** | 随机游走，靠近后按 `B` 花金币购买道具 |
| **头顶信息** | 所有角色（玩家 / BOSS / NPC）头顶显示血条、名字、职业、等级 |
| **战斗操作** | 方向键移动，`A` 普攻，`1~5` 技能区（`1` 出生技、`2` 升至 3 级解锁，`3~5` 预留扩展） |
| **排行榜** | 实时排行榜 + 历史排行榜（落盘持久化） |
| **聊天** | 多人聊天，头顶冒泡 5 秒消失，左下角聊天记录 |
| **游戏设置** | 重新选择角色、退出游戏 |

---

## 🚀 本地运行

```bash
npm install
npm start
# 浏览器打开 http://localhost:3000
```

> 多人测试：在同一台机器开多个浏览器标签，或让同一局域网 / 公网的其他人访问 `http://<你的IP>:3000`。

环境变量：`PORT`（默认 `3000`）。

---

## 🧪 测试

权威服务端模拟（`server/world.js`）带一套**零依赖**单元测试（Node 内置 `node:test`）：

```bash
npm test
```

覆盖：战斗结算 / 出生保护 / 攻击冷却 / 升级回血 / 道具效果 / 死亡掉落与复活 / 商店校验 / AoI 视野裁剪与隐身反作弊 / 排行榜排序。

---

## 🎮 操作说明

| 按键 | 作用 |
|---|---|
| `↑ ↓ ← →` / `WASD` | 移动 |
| `A` | 普通攻击（可长按连续攻击，自动瞄准最近敌人） |
| `1` ~ `5` | 技能区（`1` 出生签名技、`2` 升到 3 级解锁，`3~5` 预留） |
| `Enter` | 打开 / 发送聊天 |
| `B` | 靠近商人时打开商店 |
| `Esc` | 游戏设置（继续 / 重选角色 / 退出） |

---

## 🐳 Docker 部署

### 1. 本地构建并运行

```bash
docker compose up -d --build
# http://localhost:3000
```

### 2. 推送镜像到 Docker Hub

```bash
docker build -t <你的用户名>/arena-brawl:latest .
docker login
docker push <你的用户名>/arena-brawl:latest
```

### 3. 在 Linux 服务器上拉取并运行

```bash
# 方式 A：直接 docker run
docker run -d --name arena-brawl \
  -p 3000:3000 \
  -v /opt/arena/data:/app/data \
  --restart unless-stopped \
  <你的用户名>/arena-brawl:latest

# 方式 B：用 compose（拉取已发布镜像，不本地构建）
IMAGE=<你的用户名>/arena-brawl:latest docker compose up -d
```

服务器放行 `3000` 端口后，访问 `http://<服务器IP>:3000` 即可全球同场开打。
建议在前面挂一层 Nginx 反代并启用 HTTPS（WebSocket 会自动走 `wss://`）。

<details>
<summary>Nginx 反向代理示例（支持 WebSocket）</summary>

```nginx
server {
    listen 80;
    server_name your.domain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
</details>

---

## 🗂 项目结构

```
.
├── server/
│   ├── index.js        # HTTP + WebSocket 入口、游戏循环、消息路由
│   ├── world.js        # 权威世界模拟：实体、战斗、升级、刷新、AI
│   ├── config.js       # 世界 / 职业 / 道具 / 商店 / 数值平衡
│   └── leaderboard.js  # 历史排行榜持久化
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── net.js      # WebSocket 客户端
│       ├── input.js    # 键盘输入
│       ├── render.js   # Canvas 卡通渲染、特效、小地图
│       ├── hud.js      # DOM 界面（面板 / 技能栏 / 排行 / 聊天 / 商店）
│       └── main.js     # 编排、快照插值、客户端预测
├── test/
│   └── world.test.js   # 权威模拟单元测试（node --test，零依赖）
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## 🔧 扩展点

- **新增技能**：在 `server/config.js` 的对应职业 `skills` 数组里加一项（用 `reqLevel` 设定解锁等级），并在 `world.js` 的 `doSkill()` 中实现效果；客户端技能栏会按等级自动点亮槽位（未达等级显示 `Lv.N`）。
- **新增道具**：在 `config.js` 的 `ITEM_TYPES` / `ITEM_WEIGHTS` 添加，在 `world.js` 的 `applyItem()` 实现效果。
- **调数值**：所有平衡参数集中在 `config.js` 的 `BALANCE`。

---

## 📡 网络协议（简表）

客户端 → 服务器：`join` / `input` / `attack` / `skill` / `chat` / `buy` / `leave` / `ping` / `view`（视口尺寸，用于 AoI 裁剪）
服务器 → 客户端：`defs` / `welcome` / `state`（按视野裁剪，含 `fx` 特效）/ `overview`（全图小地图光点，低频）/ `leaderboard` / `chat` / `sys` / `shopResult` / `pong`

> **AoI（视野裁剪）**：每个广播帧只构建一次全量快照，再按各客户端视口切片下发，带宽随视口而非总人数增长。隐身玩家的精确坐标在服务端即被剔除（自己与持有「洞察之眼」者除外），改前端也无法透视。小地图另由低频 `overview` 通道覆盖全图。
