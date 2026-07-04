# 霓虹竞技场 · NEON ARENA

3D 第一人称多人在线混战射击游戏。一个 URL，多个客户端直接进入同一房间开打 —— 无需注册、无需下载。

- **服务端**：Node.js（express + ws），单房间权威服务器，所有伤害/拾取/购买均在服务端判定
- **客户端**：Three.js 第一人称，全部模型/贴图/音效程序化生成，零外部资源
- **持久化**：排行榜与玩家档案（金币/外观，按昵称）保存在 `data/profiles.json`

## 玩法

- 随机地点出生，初始只有**拳头**；死亡后换地点重生（重生有 2.5s 保护）
- 场内 16 个拾取点自动刷新三类物品（走近自动拾取）：
  - **武器**：小刀 / 长刀 / 铁锤 / 手枪 / 机枪 / 狙击枪 / 手雷 —— 无限子弹，弹匣打空自动换弹作为冷却；狙击枪右键开镜
  - **装备**：医疗包(+50血) / 防弹衣(+50甲) / 疾风靴(永久+10%移速，最多3层)
  - **状态道具**：⚡疾速 / 🔥狂暴 / 💥暴击 / 👻隐身 / 🧟暴走丧尸(只能近战·伤害翻倍·吸血) / 🦘弹跳 / 🛡️护盾
- **随机 BOSS**：不定期降临，击杀得 200 金币 + 满血 + 随机增益，助攻也有金币
- **神秘商人**（西北角摊位，按 E）：金币购买头部/面部/背部/武器光效等外观装饰，全场可见、按昵称永久保存
- **击杀奖励**：+100 分 +25 金币 +15 血；连杀有全场播报
- **聊天**：回车发送；**排行榜**：按 Tab（实时榜 + 历史榜，击杀数优先）
- **观战模式**：菜单进入或阵亡后选择，自由飞行视角（WASD+空格/C），按 F 跟随玩家（←/→ 切换），回车随时加入战斗

### 按键一览

| 按键 | 功能 |
| --- | --- |
| WASD / 空格 | 移动 / 跳跃 |
| 鼠标左键 | 攻击 / 射击（机枪可按住连发） |
| 鼠标右键 | 狙击枪开镜 |
| 1 / 2 / 3 | 近战 / 枪械 / 手雷 |
| R | 手动换弹 |
| E | 打开神秘商店（靠近商人时） |
| 回车 / Tab | 聊天 / 排行榜 |

## 本地运行

```bash
npm install
npm start        # 默认 http://localhost:3000
```

浏览器打开 `http://localhost:3000`，多开几个标签页即可体验联机。

## Docker 部署

```bash
# 方式一：docker compose（推荐，含数据卷与自动重启）
docker compose up -d --build

# 方式二：手动构建
docker build -t neon-arena-fps .
docker run -d --name neon-arena \
  -p 3000:3000 \
  -v /opt/neon-arena/data:/app/data \
  --restart unless-stopped \
  neon-arena-fps
```

部署完成后，把 `http://服务器IP:3000` 发给朋友即可同场竞技。`/health` 返回在线人数等状态，可接入监控。

### 反向代理（可选，启用 HTTPS/域名）

WebSocket 与页面同端口同路径，Nginx 需开启 Upgrade 透传：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

页面走 HTTPS 时客户端会自动使用 `wss://`，无需额外配置。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 监听端口 |
| `DATA_DIR` | `./data` | 排行榜/档案存储目录 |

游戏数值（武器伤害、BUFF 时长、BOSS 属性、商店价格、地图布局等）集中在 [server/config.js](server/config.js)，服务端加入时会把配置下发给客户端，改一处两端同步生效。

## 目录结构

```
server/          权威游戏服务器
  index.js       HTTP + WebSocket 入口、循环调度
  world.js       战斗判定 / BOSS AI / 手雷物理 / 拾取 / 商店
  config.js      地图与全部数值配置（两端共用）
  leaderboard.js 历史榜与玩家档案持久化
public/          Three.js 客户端（index.html + js/ + css/ + lib/）
data/            运行期生成：profiles.json
```
