# 买入策略 (Buy Strategy)

> **范围声明**:本文档仅描述**入场决策**——回答"要不要挂单、挂在哪里"。止盈、止损、出场逻辑属于**卖出策略**(`SELL_STRATEGY.md`,待写),不在本文档讨论。

---

## 核心理念

**关键点位是入场触发器。** 在当前价**下方**找到最合适的关键点位,预先挂 `BUY_LIMIT`,让市场把价格送下来填单。

**所有 buy 决策都围绕一条规则:从所有"低于现价的关键点位"里,挑距离现价最近的那一个,挂单在那。**

没有 WAIT、没有确认信号、没有"等企稳"——限价单挂在远处不会成交也不亏钱,挂错了顶多就是没成交而已。

---

## 前置条件:静态点位的产生

**Market Context Scan(每个交易日开始时一次)**

用户启动会话时,AI 扫描两张高时间框架截图:
- **日线 (Daily)** — 显示约 3-6 个月走势
- **1 小时图 (1H)** — 显示约 5-20 个交易日走势

从两张图上提取**关键点位的形态来源** (≤ 10 个):

| type | 含义 |
|------|------|
| `pivot` | 形态转折点(被反弹/反转过的明显高低点) |
| `gap` | 跳空缺口的边界 |
| `prior_high` | 有意义的历史高点 |
| `prior_low` | 有意义的历史低点 |

**所有点位地位平等,不分强中弱。** 它们的"角色"(支撑 vs 压力)由后续 5 分钟分析时的现价位置决定——价格在点位下方时,该点位充当支撑;价格在点位上方时充当压力。价格穿越点位时角色自动反转。

这些静态点位存在 `state.marketContext.summary.keyLevels[]`,在当天有效。

---

## 第一步:关键点位分类

每一轮 5 分钟监控开始时,AI 拿到当前价 + 完整的关键点位池。

### 关键点位池(两个来源)

| 来源 | 内容 |
|------|------|
| **静态(Market Context)** | 上面 Scan 阶段提取的 `pivot` / `gap` / `prior_high` / `prior_low` |
| **动态(5 分钟图实时)** | 当前的 `EMA20` / `EMA50` / `EMA100` / `EMA200` / `VWAP` 数值 |

> 动态点位**每轮都重新读图**——EMA 和 VWAP 会随蜡烛更新而移动,这是预期行为。

### 分类规则

逐一比较每个关键点位 vs 当前价:

| 点位价格 vs 当前价 | 角色 |
|---|---|
| 严格 **< 当前价** | 当前的**支撑候选** |
| 严格 **> 当前价** | 当前的**压力候选** |
| 与当前价持平(罕见) | 既不算支撑也不算压力,本轮忽略 |

**入场只关心"支撑候选"这一组。** 压力候选这一轮先不管(那是卖出策略的事)。

---

## 第二步:就近原则找买点

**规则:从所有支撑候选里,挑距离现价最近的那一个。**

```
buyLimit = max(每个支撑候选的价格)
         = 离当前价最近的、低于当前价的关键点位
```

输出:
```json
{
  "action": "BUY_LIMIT",
  "orderPrice": "<选定支撑的价格>",
  "anchorSource": "<该支撑的来源,例如 EMA20 / pivot / prior_low / VWAP>",
  "reasoning": "<≤120 字,说明选了哪个锚点 + 简短趋势观察>"
}
```

### 关于"挂在支撑位"的微调

AI 可以根据图形微调具体落点:
- **挂在支撑位正价位**(例如 EMA20 = $27.50 → 挂 $27.50)
- **挂略高于支撑位几个 tick**(例如 EMA20 = $27.50 → 挂 $27.52,赌价格不一定真跌到 EMA20 就反弹)
- **挂略低于支撑位几个 tick**(罕见,通常不推荐——支撑可能假破回升,挂太深反而填不上)

AI 看图判断。**reasoning 里要写清楚为什么挂在那个具体价位。**

### 同一价位多个锚点时的优先级

如果两个关键点位非常接近(差距 ≤ 一两个 tick):
1. **静态点位优先** (Market Context 的 pivot / prior_high / prior_low / gap)——因为它们是高时间框架结构,通常更稳
2. **多次出现的层级优先** 例如 EMA50 和 prior_low 同一价位 → 选 prior_low,但在 reasoning 里提及两个锚点重合"confluence"

---

## 永远输出一个 BUY_LIMIT

**入场模式没有 WAIT。** 这是关键设计原则。

- 即使最近的支撑距离现价**很远**(例如 -10%),仍然挂在那里——限价单挂着不成交不亏钱
- 即使关键点位**很弱**——用户在券商端是守门人,他看到 reasoning 自己决定要不要真去挂

### 边界情况:当前价下方没有任何关键点位

罕见,通常意味着价格刚刚突破所有历史结构(全新高)。

**处理:**
- AI 看 5 分钟图给一个保守估计的回踩位(例如最近一根大阳线的开盘价、或者跌幅一个 ATR 的位置)
- `anchorSource: "conservative_estimate"`
- reasoning 明确说明"暂无明确历史关键点位,使用 X 作为参考回踩位"

---

## 输出 schema

入场模式的 AI 输出**只包含这 6 个字段**:

```json
{
  "action": "BUY_LIMIT",
  "orderPrice": "27.50",
  "anchorSource": "EMA20",
  "reasoning": "BUY_LIMIT at EMA20 = 27.50; price above all EMAs (strong uptrend)",
  "symbol": "TSLA",
  "currentPrice": "27.85"
}
```

**注意:不再有 `stopLossPrice` 和 `targetPrice` 字段**——这两个属于卖出策略的范畴,由"挂单成交后的首次卖出分析"产生(见下文工作流)。

---

## 完整工作流:从 BUY_LIMIT 到持仓

```
1. 用户启动会话 → Market Context Scan(提取静态关键点位)
2. AI 每隔 N 分钟扫一次 5 分钟图(N = 用户设定的入场间隔):
     - 收集静态 + 动态关键点位
     - 按"分类规则"分出支撑候选
     - 按"就近原则"挑选 → 输出 BUY_LIMIT @ X
3. 用户去券商手动挂限价单 @ X
4. 用户点插件里的 "Mark limit placed" → 插件记录 pendingLimitOrder
5. 在 BUY_LIMIT 成交之前:
     - AI 继续每隔 N 分钟扫描
     - 三分连续性规则(锚点不变值不变 / 锚点不变值移动 / 锚点失效)
     - 如果锚点的值移动了(EMA20 从 27.50 → 27.55),AI 输出新的 BUY_LIMIT @ 27.55
     - 用户在券商端跟着调整挂单价
     - 如果锚点失效(价格放量跌破 EMA20 并站稳下方),AI 切换到新锚点
6. 一旦券商挂单成交,用户点 "Limit filled":
     - 插件立刻把 pendingLimitOrder 转成 virtualPosition
     - **立刻触发一次 AI 扫描,进入 sell mode 首轮分析**
     - 该首轮 sell mode 分析当前图形,产出 stopLossPrice 和 targetPrice
     - 这两个值写入 virtualPosition
     - 后续按卖出策略走(细节见 SELL_STRATEGY.md)
```

**核心:买入策略到第 6 步前为止。第 6 步起进入卖出策略。**

---

## 三分连续性规则(buy mode 下,有 pendingLimitOrder 时)

每轮分析时,如果 `pendingLimitOrder` 已存在,AI 比较"当前情况"vs"挂单时的情况",有三种结果:

| 情况 | 处理 | reasoning 标注 |
|------|------|----------------|
| **锚点不变 + 数值不变** | 重复同样的 BUY_LIMIT,用户保持挂单不动 | "anchor unchanged, repeating" |
| **锚点不变 + 数值移动** | 给新的 orderPrice(锚点同步移动后的新位置),用户在券商端替换挂单 | "anchor shifted, realigning to EMA20 = NEW_PRICE" |
| **锚点失效** | 切换到不同的关键点位(可能是另一个 EMA、或某个静态 pivot)| "EMA20 broken, switching anchor to EMA50" |

**关键点:这是 chart-driven 的调整,不是 currentPrice-driven 的 chase。** EMA 是平滑的(基于多根 K 线),它的移动反映的是图形结构变化,不是价格的瞬时抖动。

---

## 不做的事(规避 scope creep)

为了保持入场策略简洁,以下事情**不**纳入买入决策:

| 不做 | 原因 |
|------|------|
| 不要求"突破放量确认" | 预测派,不是确认派 |
| 不要求"VWAP reclaim" | 关键点位触发不需要 VWAP 配合 |
| 不基于趋势挑选近 vs 远的支撑 | 永远挑最近的,趋势不参与挑选 |
| 不分关键点位强 / 中 / 弱 | 全部平等 |
| 不硬编码百分比距离阈值 | AI 看图自判可达性,无 magic number |
| 不输出 stopLossPrice / targetPrice | **属于卖出策略,Limit filled 后由 sell mode 首轮分析产生** |
| 不参考用户的任何主观偏好参数 | 全部已删除 |

---

## 实操例子

### 例 1:强势上涨中的简单回踩

**现状:**
- 当前价 $30.00
- 静态点位:`prior_low @ $27.50`、`prior_high @ $32.00`、`gap @ $28.80`
- 动态点位:`EMA20 = $29.40`、`EMA50 = $28.50`、`EMA100 = $26.80`、`EMA200 = $24.00`、`VWAP = $29.70`

**步骤 1:支撑候选**(低于 $30.00):
- VWAP $29.70 ✓
- EMA20 $29.40 ✓
- gap $28.80 ✓
- EMA50 $28.50 ✓
- prior_low $27.50 ✓
- EMA100 $26.80 ✓
- EMA200 $24.00 ✓

**步骤 2:挑最近 = VWAP @ $29.70**

**输出:**
```json
{
  "action": "BUY_LIMIT",
  "orderPrice": "29.70",
  "anchorSource": "VWAP",
  "reasoning": "BUY_LIMIT at VWAP = 29.70; nearest support below current 30.00",
  "currentPrice": "30.00"
}
```

### 例 2:下跌中接近 prior_low

**现状:**
- 当前价 $26.20(全天跌势中)
- 静态点位:`prior_low @ $25.80`
- 动态点位:`EMA20 = $27.50`、`EMA50 = $28.30`(都在上方)、`EMA200 = $24.00`、`VWAP = $27.10`(都在上方)

**步骤 1:支撑候选**(低于 $26.20):
- prior_low $25.80 ✓
- EMA200 $24.00 ✓

**步骤 2:挑最近 = prior_low @ $25.80**

**输出:**
```json
{
  "action": "BUY_LIMIT",
  "orderPrice": "25.80",
  "anchorSource": "prior_low",
  "reasoning": "BUY_LIMIT at prior_low = 25.80; price below all EMAs (downtrend), only prior_low and EMA200 below current",
  "currentPrice": "26.20"
}
```

### 例 3:新高场景(下方真空)

**现状:**
- 当前价 $40.00(创历史新高)
- 所有静态点位都在 $35 及以下
- EMA 群:`EMA20 = $38.80`、`EMA50 = $37.20`、`EMA100 = $35.50`、`EMA200 = $33.00`
- VWAP = $39.30

**步骤 1:支撑候选:**
- VWAP $39.30 ✓
- EMA20 $38.80 ✓
- ... 都低于 $40

**步骤 2:挑最近 = VWAP @ $39.30**

(场景看着像"新高真空",但其实 EMA/VWAP 永远存在,只要价格在上方就是动态支撑——所以这个场景几乎永远有解,不需要 conservative_estimate)

---

## 与卖出策略的边界

| 决策 | 属于 | 何时产生 |
|------|------|---------|
| 要不要挂买入限价 | **买入策略** | 每轮入场分析 |
| 挂在哪个价位 | **买入策略** | 每轮入场分析 |
| 选用哪个锚点 | **买入策略** | 每轮入场分析 |
| **`stopLossPrice` 的初始值** | **卖出策略** | **挂单成交后的首次 sell mode 分析** |
| **`targetPrice` 的初始值** | **卖出策略** | **挂单成交后的首次 sell mode 分析** |
| 后续 stop / target 调整 | **卖出策略** | 每轮 exit mode 分析 |
| 何时 SELL_NOW | **卖出策略** | 每轮 exit mode 分析 |
| SELL_LIMIT 挂在哪里 | **卖出策略** | 每轮 exit mode 分析 |

**Buy / sell 在挂单成交那一刻彻底切换。** 买入策略不预判止损止盈;卖出策略也不参与挑选买点。

---

## 待落实的代码改动(概要——具体到 sell strategy 文档定稿后再统一执行)

按 B 方案需要做的事:

1. **`lib/llm.js`**:`buildAnalysisJsonSchema` 在入场模式下移除 `stopLossPrice` / `targetPrice` 必填,改为可选或不存在
2. **`validateAnalysisResult`**:入场模式不再校验 stop/target,只校验 orderPrice < currentPrice + anchorSource 必填
3. **`lib/prompt-config.js`**:入场 prompt 完全不提 stop/target
4. **`background.js`**:`markBought`(Limit filled handler)立刻触发一次 sell mode 分析,等待结果后写入 virtualPosition.stopLossPrice / targetPrice
5. **State migration**:STATE_VERSION 17 → 18,迁移钩子清理旧 schema 的预测 stop/target 字段

这些改动会和卖出策略一起执行,等 `SELL_STRATEGY.md` 定稿后统一进行。
