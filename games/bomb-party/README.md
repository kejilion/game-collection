# 💣 炸弹派对 Bomb Party

Q 版卡通多人在线炸弹人（泡泡堂 / 经典炸弹人玩法）。**一个房间，一个网址**——所有浏览器打开同一 URL 即进入同一战场，服务端权威模拟，无需注册。

![玩法](https://img.shields.io/badge/%E7%8E%A9%E6%B3%95-%E7%BB%8F%E5%85%B8%E7%82%B8%E5%BC%B9%E4%BA%BA-ff6b9d) ![部署](https://img.shields.io/badge/%E9%83%A8%E7%BD%B2-Docker-2496ed) ![依赖](https://img.shields.io/badge/%E4%BE%9D%E8%B5%96-express%20%2B%20ws-6fd44e)

## 玩法特色

- 🎮 **经典炸弹人对战**：放炸弹、炸砖块、十字火焰、连锁引爆，最后活着的人获胜
- 👾 **场景怪物**：史莱姆（乱走）、幽灵（追人）、小恶魔（高速），碰到即淘汰，炸死得分
- 🎁 **砖块藏道具**：💣 炸弹数+1 · 🔥 火力+1 · ⚡ 移速+1 · 🛡️ 护盾（挡一次伤害）
- ☠️ **突然死亡**：倒计时结束后墙壁从边缘螺旋坍塌，逼迫决战
- 👻 单人也能玩（清空怪物即获胜），最多 8 人同场，中途加入自动观战/下回合参战
- 🏆 排行榜持久化（胜场/最高分），重启容器不丢失
- 🔊 全程序化 Q 版画面与 WebAudio 合成音效，零图片/音频资源
- 📱 支持手机触屏（虚拟摇杆 + 炸弹按钮）

## 操作

| 操作 | 按键 |
| ---- | ---- |
| 移动 | 方向键 / WASD（手机：左侧摇杆） |
| 放炸弹 | 空格 / J（手机：右下按钮） |

## Docker 部署（推荐）

```bash
docker compose up -d --build
# 或
sh scripts/deploy.sh
```

打开 `http://服务器IP:3000`，把网址发给朋友即可联机。

- 端口：修改 `docker-compose.yml` 中的 `ports`（如 `"3001:3000"`）
- 数据：排行榜存于 `/opt/bomb-party/data`（宿主机），按需修改挂载路径
- 健康检查：`GET /health`

## 本地开发

```bash
npm install
npm start        # http://localhost:3000
npm test         # 世界模拟单元测试（node --test）
```

## 架构

```
bomb-party/
├── server/
│   ├── index.js       # express 静态资源 + /health + ws 广播循环
│   ├── world.js       # 权威模拟：地图/移动/炸弹/爆炸/怪物AI/突然死亡/回合
│   ├── config.js      # 数值配置（地图、速度、火力、怪物、计分…）
│   └── leaderboard.js # 排行榜 JSON 持久化（/app/data）
├── public/            # 纯静态客户端（Canvas 渲染 + 快照插值）
│   ├── js/{main,render,net,input,audio}.js
│   └── css/style.css
├── test/world.test.js # node --test 单元测试
├── scripts/deploy.sh
├── Dockerfile         # node:20-alpine + healthcheck + data 卷
└── docker-compose.yml
```

- **协议**：WebSocket JSON。客户端只发输入（方向 / 放炸弹），服务端 30Hz 推进模拟并广播快照，客户端做 ~80ms 插值回放，杜绝作弊。
- **单房间**：所有连接进入同一世界；回合制轮转，结算后自动开新局。
