<div align="center">

# Kimi代码模型用量统计（社区版）

**Kimi Code 每个模型的 token 消耗、缓存命中率、生成速度与花费估算 —— 100% 本地统计**

> **社区版声明（Community Edition）**
> 本项目是一个**非官方社区项目**，由开发者独立开发与维护，**与月之暗面（Moonshot AI）没有任何关联**。
> 项目名为「Kimi 模型用量统计 · 社区版」，logo 为开发者自绘设计，不代表官方产品。
> 如官方对命名或图形有异议，欢迎联系作者调整。

![GitHub](https://img.shields.io/badge/license-MIT-blue)
![Chrome](https://img.shields.io/badge/Chrome-Extension%20MV3-green)
![privacy](https://img.shields.io/badge/privacy-100%25%20local-orange)

</div>

---

## 这是什么？

`kimi-usage-stats` 是一个 Chrome 浏览器扩展（Manifest V3），专门统计 [Kimi Code](https://kimi.com) 中**每个模型的 token 消耗量**。

- **总消耗 / 输出 / 缓存命中 / 命中率** —— 一眼看清每个模型用得多不多、性价比高不高
- **生成速度（tokens/s）** —— 平均与最近速度，判断模型快慢
- **估算花费（¥）** —— 按内置官方价目表折算大概花了多少钱
- **365 天每日消耗热力图** —— 点击任意日期下钻查看当日明细
- **会话级下钻** —— 按项目/会话统计，含被打断轮次的浪费消耗

数据**全部来自本地 `~/.kimi-code`**，扩展不发起任何网络请求，统计结果永不上传。

## 截图

| 🌌 霓虹 HUD（暗色） | 🌕 月之亮面 |
| --- | --- |
| ![dashboard-dark](screenshots/dashboard-dark.png) | ![dashboard-light](screenshots/dashboard-light.png) |

### 上下文指示器（kimi web 输入框上方）

![上下文指示器](screenshots/context-indicator.png)

**上行 · 上下文占用**：实时显示当前会话上下文窗口的占用与组成——

![上下文占用分解](screenshots/context-usage.png)

| 字段 | 含义 |
| --- | --- |
| `上下文已用 62%` | 当前会话上下文 ÷ 模型上下文上限（悬停可见具体 token 数，如 `~160.2K / 256.0K`） |
| `系统提示词 ~14.5K` | 系统提示词占用的 token |
| `工具 ~26.1K` | 工具定义与工具结果占用的 token |
| `对话消息 ~121.2K` | 对话消息（含历史）占用的 token |

**下行 · 会话性能统计**——

![会话性能统计](screenshots/context-stats.png)

| 字段 | 含义 |
| --- | --- |
| `6 轮 · 91 步` | 会话轮数（turn.prompt 次数）· LLM 调用步数 |
| `LLM 23m55s · 工具 45m50s` | LLM 累计耗时 · 工具执行累计耗时 |
| `首 token 平均 11s · 38 tok/s` | 首 token 平均延迟（TTFT）· 平均生成速度（输出 ÷ LLM 时长） |
| `缓存命中 97%` | 缓存读 ÷（缓存读 + 普通输入），越高越省 |
| `输入 10.1M tok · 输出 54.9K tok` | 会话累计输入（含缓存读）/ 输出 token |

指示器每 3 秒自动刷新，数据来自本地 `~/.kimi-code` 会话记录；未授权目录时显示「上下文：未授权」。

## 功能特性

- **按模型汇总**：未命中输入 / 缓存命中 / 缓存写、命中率（**发光圆环**）、输出、合计 tokens（**霓虹渐变条**）、请求数、平均与最近 tokens/s（**迷你柱状图**）、最近使用时间
- **按会话下钻**：项目（工作区）、会话、起止时间、时长、模型分布、估算花费、**中断轮次消耗**（被打断轮次浪费的 token 与金额）
- **365 天消耗热力图**：GitHub 风格日历，点击日期 → 当日详情面板 + 表格与汇总卡切换为该天数据
- **上下文指示器（kimi web 输入框上方）**：实时显示上下文占用百分比与组成分解（系统提示词 / 工具 / 对话消息的 token 数）；下方统计条展示 轮数·步数、LLM 与工具耗时、首 token 平均延迟、生成速度（tok/s）、缓存命中率、输入/输出 token —— 一眼看清当前会话的上下文压力和性能
- **时间筛选**：今日 / 昨天 / 近 7 天 / 全部（按本地 0 点切日）
- **三态主题**：🌕 月之亮面 / 🌌 霓虹 HUD（深海军蓝玻璃 + 全息网格 + 青色光晕，琥珀金高亮花费）/ 🖥 跟随系统（实时切换，三端共享）
- **增量扫描**：文件未变化（mtime + size）即跳过，只解析新增内容；IndexedDB 缓存，重复扫描只追加
- **价目表**：内置 Kimi / DeepSeek 官方参考价，可逐模型修改单价（输入 / 缓存命中 / 输出三档），保存后立即生效

## 安装（开发模式）

1. 打开 Chrome（或夸克等 Chromium 内核浏览器），访问 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击左上角「加载已解压的扩展程序」
4. 选择本项目目录（本仓库根目录）
5. 工具栏出现月牙图标即安装成功

> 提示：扩展推荐的入口页是 dashboard，首次使用点工具栏图标 → 「打开模型用量统计」→ 「选择 .kimi-code 目录」授权即可。

## 使用入口

| 入口 | 说明 |
| --- | --- |
| **工具栏图标** | 随时打开 popup（显示授权/扫描状态）→ 进入完整统计页 |
| **kimi web 侧边栏** | 在「套餐用量」下方注入「模型用量统计」入口，点击打开抽屉概览；输入框上方自动显示上下文指示器（占用%/分解/轮次步数/性能） |
| **仪表盘（完整页）** | 所有列、时间筛选、热力图、会话下钻、价目表设置 |

## 数据来源与口径（纯本地）

- **模型清单**：`~/.kimi-code/config.toml` 的 `[models."<key>"]` 段
- **用量记录**：`~/.kimi-code/sessions/**/agents/<agent>/wire.jsonl`
  - `step.end` 的 `usage`：`inputOther`（未命中）/ `inputCacheRead`（缓存命中）/ `inputCacheCreation`（缓存写）/ `output`
  - 命中率 = 缓存读 ÷（缓存读 + 普通输入）
  - `__secondary__` 等别名按最近一条 `llm.request` 的真实模型归因
- **会话/中断**：`turn.cancel`、`turn.ended(reason=cancelled)`、`interruptionReminder.recorded` 判定被打断轮次
- **花费估算**：`花费 = 输入/1M × 输入价 + 缓存读/1M × 缓存价 + 输出/1M × 输出价`（缓存写归入输入口径；未定价显示 —）
  - 内置价目表为**公开参考价**（Kimi K2.7 Code / K3 / K2.6 / K2.5、DeepSeek V4 等），可在「价目表」内修改为你的实际费率
  - 注意：这是**估算**，不是官方账单

## 隐私承诺

- 仅申请 `storage` 权限（无主机权限、无 `tabs`）
- 全库无 `fetch` / `WebSocket`，**零网络请求**
- 数据只在你的浏览器 IndexedDB 与本地 `~/.kimi-code` 之间流转
- ⚠️ 注意：`wire.jsonl` 包含完整对话内容与文件路径，请勿将 `~/.kimi-code` 目录共享给他人

## 开发

零 npm 依赖，Node 18+ 即可：

```bash
node --test                # 运行全部单元测试（aggregate / charts / parser / icons / pricing / scanlock / scanner-offset）
node --check <file>        # 语法检查
node tools/gen-icons.mjs   # 重新生成 icons（SSAA 抗锯齿 PNG）
node tools/smoke-parse.mjs # 用真实 wire.jsonl + config.toml 冒烟解析
```

## 问题反馈与联系

- 🐛 **Bug 报告 / 功能建议**:请在 [GitHub Issues](https://github.com/isme_jzy/kimi-usage-stats/issues) 提交(附复现步骤与截图有助于快速定位)
- 📮 **邮件联系**:<a href="mailto:3058099144@qq.com">3058099144@qq.com</a> —— 涉及**隐私/安全**问题(如数据泄露风险)建议优先走邮件,我会尽快处理
- 📖 **使用问题**:先看本 README 的「已知限制」与「数据来源与口径」,多数疑问有解答

## 已知限制

- **kimi web 前端 DOM 大改可能致侧边栏注入失效**：此时工具栏 popup 与仪表盘不受影响
- **扩展重载后旧页面入口需刷新**：点击入口会提示「扩展已更新，请刷新页面后重试」（Chrome 扩展固有机制）
- **浏览器重启后需重新授权目录**：IndexedDB 缓存不丢失
- `config.toml` 解析为轻量实现，只认 `[models."<key>"]` 段（不影响用量统计）
- 花费为估算值，价格随官方调整可能过期

## 许可证

[MIT](LICENSE) © 2026 kimi-usage-stats contributors

---

**社区版 · 非官方项目 · 与月之暗面（Moonshot AI）无关联** · Made with ☕ and 🌙
