# AI 行业晨报

每天早上 8:30（北京时间）自动推送到微信的 AI 行业晨报：多信源聚合、筛出 AI 行业大事件与分类要闻，通过 Server酱 推到手机。**全部在 GitHub Actions 云端运行，本地电脑关机也能照常推送。**

## 架构

```
cron-job.org（每天 UTC 00:30 = 北京时间 08:30，POST repository_dispatch）
        ↓
GitHub Actions（ubuntu-latest + Node 22）
        ↓
ai-morning-report.js（零依赖）
   ├─ 新浪科技滚动接口（lid=2515）
   ├─ 量子位 / 雷峰网 / 爱范儿 / 钛媒体 / 极客公园 / IT之家 RSS
   ├─ AI 关键词筛选 + 事件打分 + 标题去重
   └─ 大事件 Top5 + 分类要闻（模型 / 算力 / 应用 / 政策 / 资本 / 研究）
        ↓
Server酱 → 微信推送（手机离线时，微信服务端会保留，开机后照常收到）
        ↓
生成报告 commit 回仓库（ai-morning-report-YYYY-MM-DD.md）
```

## 文件说明

| 文件 | 说明 |
|------|------|
| `ai-morning-report.js` | **主脚本**：AI 新闻聚合 + 大事件识别 + 推送 |
| `.github/workflows/morning-report.yml` | 工作流：跑 AI 晨报并把报告 commit 回仓库 |
| `ai-morning-report-*.md` | 每日生成的晨报存档 |
| `ai-data.json` | 最近一次采集与选稿结果（运行产物，不入库） |
| `morning-report.js` | 旧的金融市场晨报（保留，随时可切回） |
| `morning-report-*.md` | 旧版每日存档 |

## 本地运行

```bash
node ai-morning-report.js           # 完整流程（抓取 + 生成 + 推送）
node ai-morning-report.js --dry     # 只生成不推送，本地预览
node ai-morning-report.js --fetch   # 同 --dry，并保存 ai-data.json
node ai-morning-report.js --report  # 读取 ai-data.json 重新生成并推送
DEBUG=1 node ai-morning-report.js --dry   # 打印每条被过滤的原因
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `SENDKEY` | Server酱 SendKey（必填，存在 GitHub Secrets；未配置直接报错退出） |

## 内容规则

- **AI 相关**：标题命中强 AI 词（大模型 / 算力 / GPU / OpenAI / 具身 / 智驾 / 推理 / HBM 等）；垂直 AI 媒体允许正文命中。
- **大事件**：标题含发布 / 融资 / 收购 / 开源 / 量产 / 监管等动作词，且不是会议发言或早报合集。
- **过滤**：标题党、股价涨跌、消费硬件导购、量子计算、早报盘点类合集。
- **去重**：标题归一化后按前 12 字 + 二元组相似度合并。
- **分类**：政策与监管 / 资本与并购 / 算力与芯片 / 模型与产品 / 应用与落地 / 研究前沿，每类最多 4 条。
- **时区**：统一按 `Asia/Shanghai` 显示，runner 是 UTC 也不会串日期。

## 切回金融晨报

把 `.github/workflows/morning-report.yml` 的 run 改回 `node morning-report.js`（或恢复上一版工作流）即可。

## 关键资源

- 仓库：https://github.com/Z4DFL/financial-morning-report
- 推送服务：Server酱（SendKey 存于 GitHub Secrets）
- 定时触发：cron-job.org（每天 UTC 00:30）
