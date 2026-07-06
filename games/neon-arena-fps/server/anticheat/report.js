// 玩家举报投票 —— 通用可移植模块（不含任何游戏逻辑，只做"去重计票 + 滚动窗口 + 阈值判定"）
// 设计要点（防滥用）：
//   1) 去重：同一"举报者标识"对同一目标只算 1 票（reporterKey 由接入方决定，建议用 IP，
//      这样一个人开多个小号/多开同 IP 连接也只算 1 票，无法自己刷票封别人）。
//   2) 滚动窗口：只统计最近 windowMs 内的举报，过期自动失效，避免跨局慢慢累积凑数。
//   3) 阈值：不同举报者数达到 threshold 即触发（接入方据此执行封禁/踢出）。
// 固有局限：纯玩家投票无法防"多名真实独立玩家串通"——这是所有 UGC 举报系统的通病，
//   商业游戏靠"举报 + 录像回放人工复核 + 行为验证"多层兜底。本模块定位是"快速处置明显作弊/
//   辱骂"，误封有 windowMs/封禁时长上限自动兜底，不作为唯一裁决。
'use strict';

const now = () => Date.now();

class ReportVote {
  constructor(opts = {}) {
    this.threshold = opts.threshold || 3;        // 触发所需的不同举报者数
    this.windowMs = opts.windowMs || 5 * 60000;  // 举报有效窗口（默认 5 分钟）
    this.records = new Map();                     // targetKey -> Map<reporterKey, ts>
  }

  // 记一票，返回 { count, threshold, triggered }
  report(targetKey, reporterKey) {
    const t = now();
    let m = this.records.get(targetKey);
    if (!m) { m = new Map(); this.records.set(targetKey, m); }
    m.set(reporterKey, t);                        // 去重：同一举报者只刷新时间戳，不叠加
    for (const [rk, ts] of m) if (t - ts > this.windowMs) m.delete(rk);  // 清窗口外旧票
    const count = m.size;
    return { count, threshold: this.threshold, triggered: count >= this.threshold };
  }

  // 当前有效票数（不改状态）
  count(targetKey) {
    const m = this.records.get(targetKey);
    if (!m) return 0;
    const t = now();
    let c = 0;
    for (const ts of m.values()) if (t - ts <= this.windowMs) c++;
    return c;
  }

  // 目标已处置/离场：清空其票仓
  clear(targetKey) { this.records.delete(targetKey); }

  // 周期性 GC：清理过期票与空票仓，防内存长期累积
  sweep() {
    const t = now();
    for (const [tk, m] of this.records) {
      for (const [rk, ts] of m) if (t - ts > this.windowMs) m.delete(rk);
      if (m.size === 0) this.records.delete(tk);
    }
  }
}

module.exports = { ReportVote };
