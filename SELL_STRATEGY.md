# 卖出策略 (Sell Strategy)

> **范围声明**:本文档描述**所有持仓后的决策**——包括止损位 / 止盈位的设定、何时离场、挂单价位选择。买入决策(挂买在哪)由 `BUY_STRATEGY.md` 负责,本文档**不**讨论买入。

> **配套阅读**:`BUY_STRATEGY.md` 描述了 BUY_LIMIT 是怎么挂出来的。本文档从用户点击 "Limit filled" 那一刻起接管。

---

## 核心理念

**持仓决策由"价格在三个区间中的哪一个"机械地决定。**

```
                  ↑↑↑  (压力位空间)
                  ↑↑↑
————— 入场价 —————
                  ↓
                  ↓  [止盈区]      位置健康
                  ↓
————— 软止损 —————
                  ↓
                  ↓  [解套区]      位置受伤但还没死,
                  ↓                AI 给反弹的机会
                  ↓
————— 硬止损 —————
                  ↓
                  ↓  [必须离场区]   thesis 已死,SELL_NOW
```

**双止损是核心安全设计**——单一止损要么太刚性(假破即出,频繁被洗)要么太宽松(没真正承认错误的底线,cascade 时炸账户)。双止损给"假破回弹"留余地,但有硬底线兜底。

---

## 触发器:"Limit filled" 启动首次卖出分析

**入场策略到 BUY_LIMIT 成交为止;持仓策略从用户点击 "Limit filled" 那一刻开始。**

工作流:
```
1. 用户在券商端 BUY_LIMIT 成交
2. 用户点插件 "Limit filled"
3. 插件立刻触发一次"首次卖出分析"——这是特殊的、非定时的一次扫描
4. AI 重新读 5 分钟图,产出:
     - virtualPosition.stopLossPrice  (软止损)
     - virtualPosition.hardStopPrice  (硬止损)
     - 当前 SELL_LIMIT 的位置(action = SELL_LIMIT,挂在上方最近压力)
     - anchorSource(SELL_LIMIT 的锚点)
5. 插件把这些值写入 virtualPosition,转入持仓状态
6. 之后按用户设的持仓扫描间隔,运行常规 exit mode 分析
```

**为什么这是特殊的一次分析?**——首次卖出分析是**唯一**会写入 `stopLossPrice` / `hardStopPrice` 的时刻。这两个值在持仓期间**不会变**(no trailing),它们是"入场时的承诺"。

---

## 双止损的定义(关键点位框架)

完全对称于买入策略,所有数字都从关键点位拿:

| 概念 | 定义 |
|------|------|
| **软止损 (stopLossPrice)** | 入场价**下方最近**的关键点位 |
| **硬止损 (hardStopPrice)** | 软止损**下方最近**的关键点位 |

**关键点位池**(同买入)= 静态点位(Market Context) + 动态点位(EMA20/50/100/200 + VWAP)

**举例**:
- 入场价 $30.00
- 当前价 $30.00(刚成交瞬间)
- 关键点位池里在 $30 下方的有:`VWAP @ $29.70`、`EMA20 @ $29.40`、`EMA50 @ $28.80`、`prior_low @ $27.50`、`EMA200 @ $25.00`
- **软止损 = $29.70 (VWAP)**(入场下方最近)
- **硬止损 = $29.40 (EMA20)**(软止损下方最近)

> 注:这两个止损一旦设定就**固定不变**(no trailing)。即使后续价格涨到 $33 然后回踩到 $30,软止损仍然是 $29.70。这是"承诺",不是动态线。

---

## 三个区间的状态机

每一轮 exit mode 分析:

```
读 currentPrice
读 virtualPosition.stopLossPrice  (软止损,固定)
读 virtualPosition.hardStopPrice  (硬止损,固定)

if 临近 16:00 ET (force_exit window):
    → SELL_NOW                          [强制收盘]

elif currentPrice ≤ hardStopPrice:
    → SELL_NOW                          [必须离场区]

elif currentPrice ≤ stopLossPrice:
    → SELL_LIMIT @ 解套区目标            [解套区]

else:  (currentPrice > stopLossPrice)
    → SELL_LIMIT @ 上方最近压力位        [止盈区]
```

**SELL_NOW 的两个触发器只有这两个,没有别的**:破硬止损,或临近收盘。其他任何情况都是 SELL_LIMIT。

---

## 区间一:止盈区(currentPrice > stopLossPrice)

### 含义
位置健康。当前价在入场价附近、之上、或虽然低于入场价但还没破软止损。**默认期待是上行**——你买在支撑、价格按预期反弹了或基本守住了。

### 默认动作
`SELL_LIMIT @ 上方最近压力位`

完全对称于买入的"就近原则":
- 收集所有**当前价上方**的关键点位(静态 + 动态)
- 挑距离当前价**最近**的那一个
- SELL_LIMIT 挂在那

### Target 选择的具体规则

| 上方最近压力距离当前价 | 处理 |
|---|---|
| 几个 tick 以内(几乎贴脸) | 挂略高于该压力几个 tick,避免立即成交 |
| 正常距离 | 挂在该压力位正价 |
| 没有任何上方关键点位(新高场景) | 看图给保守估计,anchorSource = "conservative_estimate" |

### 反弹力度 / 趋势强弱怎么影响?

**不参与"目标位选择"**。永远挑最近,每轮重评:
- 价格突破近压力 → 下一轮"最近"自动变成更远那个 → SELL_LIMIT 自动 trail 上去
- 价格在近压力下方徘徊 → SELL_LIMIT 留在原位置,大概率成交

这就是"trail up by levels"机制。**不需要让 AI 主观判断"近还是远"**——多轮迭代自动处理。

---

## 区间二:解套区(hardStopPrice < currentPrice ≤ stopLossPrice)

### 含义
位置受伤但**还没死**。你买在支撑,但支撑被破了。这正是你实操观察"破第一个支撑后下个支撑常反弹"的场景——价格下探到下方某处后,常常反弹回来,给你一个**回到入场价附近以小亏 / 平本出场**的机会。

### 默认动作
`SELL_LIMIT @ 入场价附近最近的、高于现价的关键点位`

**关键差别**(对比止盈区):
- 止盈区:target = 当前价上方**最近**压力(为了赚)
- 解套区:target = **入场价附近**最近、且高于现价的压力(为了平本 / 小亏)

### Target 选择的具体规则

设入场价 = `entry`,当前价 = `current`,且 `current < entry`(解套区一定满足)。

收集"高于 current 且不超过 entry 上方一点点"范围内的关键点位 → 挑最近的。

| 情况 | 处理 |
|---|---|
| `current` 和 `entry` 之间有关键点位 → 挑最接近 entry 的那个(尽量回血) |
| `current` 和 `entry` 之间没有关键点位 → 挂在 `entry` 正上方一点点(目标平本) |
| 当前价上方完全没有关键点位 → AI 看图给保守估计,reasoning 说明 |

### 为什么不是 SELL_NOW?

你的实操观察是核心论据:**破软止损 ≠ thesis 已死,常常是假破**。给反弹一个机会:
- 反弹强 → 价格回到入场价附近 → SELL_LIMIT 填上 → 平本或小赚出场 ✓
- 反弹弱 → SELL_LIMIT 留在那里,价格继续在解套区震荡 → 等下次反弹机会
- 反弹失败 → 价格继续下跌破硬止损 → SELL_NOW(自动)

### 解套区不做加仓 / 不摊薄成本

这是经典 Martingale 陷阱,v1 明确不做。如果价格继续下跌,**唯一的兜底**是硬止损 → SELL_NOW。

(未来如果实测一段时间觉得需要,再单独评估加仓功能,涉及大量架构改动:多笔挂单管理、平均成本、多次部分填单、分批卖出。)

---

## 区间三:必须离场区(currentPrice ≤ hardStopPrice)

### 含义
**thesis 已死。** 双止损都被破说明 cascade 已经在发生,继续等是 loss aversion 而不是策略。

### 动作
`SELL_NOW`,无条件,不留情面。

```json
{
  "action": "SELL_NOW",
  "orderPrice": null,
  "anchorSource": "stop_broken",
  "reasoning": "Hard stop $X broken; cascade risk too high to wait"
}
```

### 为什么是硬规则?

这是承认错误的线。任何"再等一下下个支撑"都是 loss aversion 在合理化。**过了硬止损,价格往往不是再去测下一个支撑,而是直接 panic cascade**。

历史上每个 blowup 故事里都有"我以为下一个支撑会守住"。硬止损是兜底。

---

## 强制离场(临近 16:00 ET,不变)

`isNearUsMarketClose()` 返回 true(收盘前 10 分钟) → `SELL_NOW`,日内交易不留隔夜。

优先级最高,在任何其他判断之前。

---

## 输出 schema

### 首次卖出分析(Limit filled 触发,特殊一次)

```json
{
  "action": "SELL_LIMIT",
  "orderPrice": "<SELL_LIMIT 价格,按区间规则>",
  "anchorSource": "<SELL_LIMIT 的锚点>",
  "stopLossPrice": "<软止损,固定写入 virtualPosition>",
  "hardStopPrice": "<硬止损,固定写入 virtualPosition>",
  "reasoning": "<≤120 字>",
  "currentPrice": "...",
  "symbol": "..."
}
```

**关键新增字段**:`hardStopPrice`(以前没有的)。这是 schema 的扩展。

### 后续每轮 exit 分析(常规 schedule)

```json
{
  "action": "SELL_NOW | SELL_LIMIT",
  "orderPrice": "<SELL_LIMIT 时的价格 / SELL_NOW 时为 null>",
  "anchorSource": "<SELL_LIMIT 锚点 / 'stop_broken' / 'force_exit'>",
  "reasoning": "<≤120 字,标注当前在哪个区间>",
  "currentPrice": "...",
  "symbol": "..."
}
```

**注意**:后续轮**不**重新输出 `stopLossPrice` / `hardStopPrice`——这两个值在首次分析时定下来后**永久固定**在 `virtualPosition` 上,后续轮直接读。

---

## 完整工作流

```
持仓阶段开始:
[阶段 1: Limit filled 瞬间]
    用户点 "Limit filled"
    ↓
    pendingLimitOrder → 转成 virtualPosition (entryPrice = 限价单价)
    ↓
    触发首次卖出分析(特殊一次,非定时):
        AI 读 5 分钟图
        输出 stopLossPrice (软止损) + hardStopPrice (硬止损) + SELL_LIMIT(止盈区初始挂单)
    ↓
    写入 virtualPosition:
        virtualPosition.stopLossPrice  ← AI 给的软止损
        virtualPosition.hardStopPrice  ← AI 给的硬止损 (新字段)
    ↓
    state.lastResult.analysis  ← AI 给的 SELL_LIMIT
    ↓
    用户在券商端按 SELL_LIMIT 价位挂卖单

[阶段 2: 定时 exit 分析]
    按用户设定的"持仓扫描间隔"循环:
        AI 读 5 分钟图
        读 currentPrice
        读 virtualPosition.stopLossPrice / hardStopPrice (不变)
        
        if 临近收盘:
            output SELL_NOW
        elif currentPrice ≤ hardStop:
            output SELL_NOW (硬止损破)
        elif currentPrice ≤ softStop:
            output SELL_LIMIT @ 入场附近 (解套区)
        else:
            output SELL_LIMIT @ 上方最近压力 (止盈区)
        
        如果 action / orderPrice 和上轮不一样:
            UI 显示"信号变化" warning
            用户在券商端替换 SELL 挂单

[阶段 3: 出场]
    场景 A: SELL_LIMIT 在券商成交 → 用户点 "Limit filled"(卖单的) → 平仓,写入 tradeHistory,SESSION_PAUSED
    场景 B: AI 输出 SELL_NOW → 用户在券商端市价卖 → 点 "Mark sold at this price" → 平仓
    场景 C: 临近 16:00 ET → 用户主动按 SELL_NOW 提示市价卖 → 平仓
```

---

## 三分连续性规则(每轮重评,适用于 SELL_LIMIT)

和买入策略同样的逻辑:

| 情况 | 处理 | reasoning 标注 |
|------|------|---------------|
| 锚点不变 + 数值不变 | 重复同样的 SELL_LIMIT,用户保持挂单不动 | "anchor unchanged, repeating" |
| 锚点不变 + 数值移动 | 给新的 orderPrice(锚点的新位置),用户跟着替换挂单 | "anchor shifted, realigning to EMA20 = NEW_PRICE" |
| 锚点失效 | 切换到不同的关键点位 | "EMA20 broken upward, switching to next resistance" |

**跨区间切换也通过这个机制实现**——例如止盈区 → 解套区:
- 价格跌破软止损
- 下一轮发现进入解套区
- target 从"上方最近压力"切换到"入场价附近最近压力"
- 这等价于"锚点失效"(因为目标的逻辑变了)
- reasoning 说明:"price dropped below planned stop = $X, switching to recovery mode, SELL_LIMIT at $Y to exit near break-even"

---

## 边界情况

### 边界 1:首次卖出分析时无法找到软止损(入场价下方没有关键点位)

罕见,通常说明用户买在了"无人区"。

**处理**:
- AI 看图给保守估计的软止损(例如入场下方 1% 或 1 个 ATR)
- 同样给保守估计的硬止损(再下方一点)
- reasoning 说明 "no key level below entry, conservative estimate used"
- `stopLossPrice` / `hardStopPrice` 的 anchorSource 字段标 "conservative_estimate"

### 边界 2:软止损 = 硬止损(关键点位密度太低)

例:入场 $30,下方只有一个关键点位 $28(EMA200),再下面就什么都没了。

**处理**:
- 软止损 = $28
- 硬止损 = AI 看图给保守估计的更深位置(例如 $27 或 $26)
- reasoning 标注:"hardStop = conservative estimate below 28 due to sparse levels"

### 边界 3:首次卖出分析时,当前价已经显著低于入场价(挂单成交瞬间已经倒挂)

罕见——通常 BUY_LIMIT 成交时 currentPrice ≈ orderPrice。但如果用户挂单后没看,价格直接 gap 下来跌穿,可能成交后立刻倒挂。

**处理**:首次分析照样跑,根据成交瞬间的 currentPrice 判断区间:
- 如果 current 已经在解套区 → 第一个 SELL_LIMIT 就挂在入场附近(直接进入解套模式)
- 如果 current 已经破硬止损 → 第一次分析就 SELL_NOW(立刻平仓)

### 边界 4:止盈区中,当前价上方没有任何关键点位(突破新高)

- 看 BUY_STRATEGY.md 边界情况一样的处理:看图给保守估计
- reasoning 注明 "new high, no overhead structure, conservative target estimate"

### 边界 5:解套区中,入场价和现价之间没有关键点位

- SELL_LIMIT 挂在入场价**正上方一点点**(几个 tick 上)
- reasoning:"break-even target, no intermediate level between $current and $entry"

### 边界 6:用户长时间挂着,价格在解套区震荡,最后被 force_exit 强卖

接受这个风险——这是 cascade 行情中无法避免的成本,但比"破软止损就立刻卖"的累计成本更低。

---

## 不做的事(规避 scope creep)

| 不做 | 原因 |
|------|------|
| 不做加仓 / 摊薄成本 | Martingale 陷阱;架构上单仓假设;v1 不引入 |
| 软止损 / 硬止损不 trail | 是"入场承诺",不动态调整 |
| 不让趋势 / 反弹力度参与 target 选择 | 每轮重评 + trail by levels 自动处理 |
| 不分关键点位强 / 中 / 弱 | 同买入策略,全部平等 |
| 不要求"破支撑确认"成交量 | 价格触及就触及,不等 confirmation(信号会迟) |
| 不引入用户参数(`quickProfitDelta` 等已经全删) | 主观选择不参与 AI 决策 |
| 解套区不"等回弹再判断"(让 AI 看主观图判断) | 机械规则:破软止损就进解套区,target 改变 |

---

## 实操例子

### 例 1:典型成功路径(止盈出场)

**入场**: BUY_LIMIT @ EMA20 = $27.50 成交

**首次卖出分析(Limit filled 触发)**:
- 当前价 $27.50,关键点位:
  - 上方: `prior_high @ $28.20`(最近压力)、`EMA200 @ $30.50`
  - 下方: `EMA50 @ $27.00`(软止损候选)、`prior_low @ $26.30`(硬止损候选)、`EMA100 @ $25.20`
- 输出:
  ```json
  {
    "action": "SELL_LIMIT",
    "orderPrice": "28.20",
    "anchorSource": "prior_high",
    "stopLossPrice": "27.00",
    "hardStopPrice": "26.30",
    "reasoning": "Take-profit zone; SELL_LIMIT at prior_high = 28.20; soft stop EMA50 = 27.00, hard stop prior_low = 26.30"
  }
  ```

**之后**: 价格反弹到 $28.20,SELL_LIMIT 成交。用户点 "Limit filled" → 平仓,写入 tradeHistory,小赚 $0.70。✓

### 例 2:解套成功路径

**入场**: BUY_LIMIT @ EMA20 = $27.50 成交,软止损 $27.00,硬止损 $26.30

**几轮之后**: 价格跌到 $26.80(在解套区)

**该轮分析**:
- $26.80 < $27.00(软止损)→ 进入解套区
- $26.80 > $26.30(硬止损)→ 不触发 SELL_NOW
- 解套区 target = 入场价附近最近的关键点位 = `EMA20 = $27.50`(假设此刻 EMA20 已经下移到 $27.50 附近)
- 输出 `SELL_LIMIT @ $27.50`,anchorSource = "EMA20"
- reasoning: "Recovery zone (current 26.80 < softStop 27.00); SELL_LIMIT at EMA20 = 27.50 (break-even target)"

**之后**: 价格反弹到 $27.50,SELL_LIMIT 成交。用户点 "Limit filled" → 平仓,**平本出场**。✓

### 例 3:必须离场路径(硬止损被破)

**入场**: 同上,软止损 $27.00,硬止损 $26.30

**几轮之后**: 价格跌到 $26.10

**该轮分析**:
- $26.10 < $26.30(硬止损)→ 触发 SELL_NOW
- 输出:
  ```json
  {
    "action": "SELL_NOW",
    "orderPrice": null,
    "anchorSource": "stop_broken",
    "reasoning": "Hard stop 26.30 broken at 26.10; cascade risk, exit immediately"
  }
  ```

**之后**: 用户在券商市价卖 @ $26.05,点 "Mark sold" → 平仓,亏损 $1.45/股。**但这是有上限的亏损,不会变成 $5、$10 的灾难。** ✓

### 例 4:trail up by levels(止盈区中价格上涨)

**入场**: $27.50,SELL_LIMIT 初始挂在 `prior_high = $28.20`

**几轮之后**: 价格突破 $28.20 涨到 $28.40

**该轮分析**:
- $28.40 > $27.00(软止损)→ 在止盈区
- 上方最近压力:之前的 `prior_high` 已经被突破,现在最近的是 `EMA200 @ $30.50` 或 `gap @ $29.00`
- 假设最近的是 `gap @ $29.00`
- 输出 `SELL_LIMIT @ $29.00`,anchorSource = "gap"
- reasoning: "prior_high 28.20 broken upward; trailing to gap = 29.00 (next nearest resistance)"

UI 显示信号变化 warning,用户去券商把卖单从 $28.20 替换为 $29.00。

---

## 与买入策略的边界(再次明确)

| 决策 | 属于 | 触发时机 |
|------|------|---------|
| BUY_LIMIT 价格 / anchorSource | **买入策略** | 每轮入场分析 |
| **stopLossPrice (软止损)** | **卖出策略** | **首次卖出分析(Limit filled 触发)** |
| **hardStopPrice (硬止损)** | **卖出策略** | **首次卖出分析** |
| SELL_LIMIT 价格 / anchorSource | **卖出策略** | 每轮 exit 分析(含首次) |
| SELL_NOW 触发 | **卖出策略** | 每轮 exit 分析 |
| 加仓 / 摊薄成本 | **不做(v1)** | — |

**Buy / sell 在 Limit filled 那一刻完全切换**——买入策略不预判止损止盈;卖出策略也不参与挑选买点。两个文档的逻辑互不重叠。

---

## 待落实的代码改动(等买入策略一起统一执行)

按双止损模型 + 首次卖出分析模型,需要做的改动:

### 1. State shape 扩展
- `virtualPosition` 新增字段 `hardStopPrice`(以前没有)
- migration v17 → v18 增加 hook:对已有持仓,如果缺 hardStopPrice,设为某个保守估计(或要求用户重新确认)

### 2. Schema 扩展
- `buildAnalysisJsonSchema` 在**首次卖出分析**模式下要求 `stopLossPrice` 和 `hardStopPrice` 都必填
- 后续 exit 模式不要求(直接读 virtualPosition)
- 可以通过给 mode 参数加一个新值 `first_exit` 区分

### 3. validateAnalysisResult 扩展
- 首次卖出分析:校验 `hardStopPrice < stopLossPrice < currentPrice`
- 校验 `stopLossPrice` 和 `hardStopPrice` 都是有效的关键点位价格(可选——AI 应该负责,但加 sanity check 也好)

### 4. Prompt 重写
- `entryModeRules`:移除 stop/target(已经在 BUY_STRATEGY.md 设计中)
- `exitModeRules`:重写,加入三区间逻辑
- 新增 `firstExitModeRules`:首次分析专用,产出 stop + hardStop + 第一个 SELL_LIMIT

### 5. background.js 改动
- `markBought` handler:不再直接转 virtualPosition,而是触发一次首次卖出分析,等结果回来再写入完整的 virtualPosition
- 首次卖出分析的失败处理:如果首次分析失败(网络 / API 错误),不能让用户停在"已成交但没 stop"的危险状态——需要重试机制或回退
- 常规 `runMonitoringRound` 在 exit 模式下从 virtualPosition 读 stop / hardStop

### 6. UI 显示
- Recommendation 卡片:在 exit mode 下显示当前所在区间("止盈区 / 解套区 / 必须离场区")
- Position summary 显示两个止损(soft + hard)
- 当跨区间切换时,reasoning 里的提示要醒目

### 7. i18n 新增 key
- 区间标签:`zoneTakeProfit` / `zoneRecovery` / `zoneHardExit`
- 软 / 硬止损标签:`softStopLabel` / `hardStopLabel`
- 等等

### 8. 测试
- llm.test.js:三区间状态机的测试用例
- llm.test.js:首次卖出分析 schema 验证
- llm.test.js:验证 stopLossPrice < currentPrice 且 hardStopPrice < stopLossPrice
- storage.test.js:v18 migration 测试

---

## 未来工作(明确不在 v1)

| 功能 | 为什么不在 v1 |
|------|------|
| 加仓 / 摊薄成本 | 经典 Martingale 陷阱;架构上单仓假设;先实测纯卖出策略一段时间评估效果 |
| 软止损 trailing(随价上涨上移) | 实测下来如果觉得"承诺不变"过于保守,可以再加 |
| 反弹力度分级(强弱影响 target) | 实测下来如果觉得"trail by levels"过于激进或保守,可以再加 |
| 解套区的智能延迟止损(基于动量/成交量) | 同上 |
| 多区间 SELL_LIMIT 同时挂(分批止盈) | 单仓假设;先确认基础策略后再说 |

这些都是"实测后才决定要不要做"的功能。**v1 先把简单清晰的双止损 + 三区间跑起来,采集数据。**
