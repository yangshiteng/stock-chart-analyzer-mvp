# 卖出策略 (Sell Strategy)

> **范围声明**:本文档描述**所有持仓后的决策**——包括止损位 / 止盈位的设定、何时离场、挂单价位选择。买入决策(挂买在哪)由 `BUY_STRATEGY.md` 负责,本文档**不**讨论买入。

> **配套阅读**:`BUY_STRATEGY.md` 描述了 BUY_LIMIT 是怎么挂出来的。本文档从用户点击 "Limit filled" 那一刻起接管。

---

## 核心理念

**持仓决策分两层:**

1. **区间归属是机械的**: `currentPrice` 落在四个区间中的哪一个,完全由它与 `entryPrice` / `softStop` / `hardStop` 三条线的相对位置机械判定,无主观空间。
2. **区间内的具体目标选择有的机械、有的主观**:
   - **必须离场区**: 完全机械(直接 SELL_NOW,无判断空间)
   - **健康区 / 观察区 / 警戒区**: 允许 AI 主观综合判断(带证据约束),详见 pillar 3

```
                  ↑↑↑  (压力位空间)
                  ↑↑↑
                  ↓  [健康区]      浮盈中,
                  ↓                AI 主观综合判断(带证据约束)
                  ↓                在"trend=normal(R1) / strong(R2)" 间选;
                  ↓                不确定 → 默认 R1
————— 入场价 —————
                  ↓
                  ↓  [观察区]      浮亏但止损都没破,
                  ↓                AI 主观综合判断(带证据约束)
                  ↓                在"押反弹 / 准备解套" 间选;
                  ↓                不确定 → 默认走解套
————— 软止损 —————
                  ↓
                  ↓  [警戒区]      软止损被破,进入解套流程
                  ↓                AI 主观综合判断(带证据约束)
                  ↓                在"保守(softStop) / 激进(entry+0.05)" 间选;
                  ↓                不确定 → 默认保守
                  ↓
————— 硬止损 —————
                  ↓
                  ↓  [必须离场区]   thesis 已死,SELL_NOW
```

**三个关键设计**:

1. **双止损**:单一止损要么太刚性(假破即出,频繁被洗)要么太宽松(没真正承认错误的底线,cascade 时炸账户)。双止损给"假破回弹"留余地,但有硬底线兜底。
2. **观察区独立于警戒区**:浮亏但还没破软止损的状态,**和**软止损已破的状态,出场目标的逻辑应该不一样——前者还可以期待恢复浮盈,后者只求平本走人。把两者合并成一个"非止盈区"会丢掉这个差别。
3. **健康区 / 观察区 / 警戒区都允许 AI 主观综合判断**:只有必须离场区是纯机械规则(破硬止损 → SELL_NOW,无判断空间)。这三个持仓区都是信号丰富的状态——机械规则会丢失 K 线/EMA/VWAP/量能/Market Context 多个有用维度。所以都允许 AI 做主观综合判断,**都带三条相同的结构约束**:
   - 不确定 = 默认保守(健康区默认 R1 / 观察区默认走解套 / 警戒区默认 softStop)
   - 激进选项必须列 ≥2 条数字证据
   - validator 拒绝模糊词
   
   三个区的判断都是「保守(默认) / 激进(需证据)」的镜像设计:
   - **健康区**: 在「trend=normal(R1) / trend=strong(R2,挂更远压力吃更大利润)」二选一
   - **观察区**: 在「走解套(默认,≤entry+0.05) / 走止盈(R1)」二选一
   - **警戒区**: 在「保守 target(softStop) / 激进 target(entry+0.05)」二选一
   
   全部用同一套 7 维度证据 checklist + 三条约束。这是有意识的局部试验,实测效果差会回退到机械规则(健康区回退到"3 阳 + strictly 抬高 → R2"的 K 线硬条件;其他区回退方案见各自章节)。

---

## 关键点位池(同买入策略)

每一轮分析时,AI 把以下来源的点位合并成一个池子,**所有点位平等**(没有强 / 中 / 弱分级):

- **静态点位**(来自 Market Context Scan,当日不变): `pivot` / `gap` / `prior_high` / `prior_low`
- **动态点位**(每轮从 5 分钟图直接读**当前值**): `EMA20` / `EMA50` / `EMA100` / `EMA200` / `VWAP`
- **盘中静态点位**(每轮从当日 5 分钟图读): `今日高 (HOD)` / `今日低 (LOD)` / `开盘 15 分钟区间高低 (ORH/ORL)` / `盘中明显的反复测试位 (intraday_pivot)`
- **持仓期专有:固定止损数字**(仅在持仓后的 exit 分析里出现): `fixed_soft_stop`(= `virtualPosition.stopLossPrice`)、`fixed_hard_stop`(= `virtualPosition.hardStopPrice`)

> **设计**:盘中静态点位在 v17 没有显式纳入,实测下来会漏掉"今日 HOD 形成的反复触压"这种很有用的近端关键位。本次更新把它们和原来的静态 / 动态点位放在同一个池子里,角色由当前价决定(role-is-dynamic)。

### 关键澄清:固定止损 vs 动态锚的当前值是**两个独立候选**

#### 一句话先讲清

**首次卖出分析定下的止损是个固定数字**(比如 $27.00),**永久不变**。但定义它的那条动态线(比如 EMA50)在市场中**会继续漂移**。所以「止损数字」和「定义它的均线的当前值」会逐渐分离,变成**价位不同的两个候选**——AI 后续每轮要把它们当两个独立候选处理。

#### 时间轴示意

```
[入场时刻]                          [2 小时后]
EMA50 这条线 = $27.00                 EMA50 这条线 = $26.75   ← 已漂走
softStop 锚在这                       softStop 数字 = $27.00  ← 不变(承诺)
两者重合,都在 $27.00                  ↓
                                      两者分离,在候选池里成为两个不同的点位
```

#### 后续轮里两个候选并存

| 候选 | 价格 | anchorSource | 性质 |
|------|------|--------------|------|
| 固定 softStop(数字) | `$27.00`(永久不变) | `fixed_soft_stop` | 入场时的承诺线,用于判区间、触发 SELL_NOW、作 SELL_LIMIT 候选 |
| 当前 EMA50(动态线) | `$26.75`(每轮重读) | `EMA50` | 当前的均线值,跟价格漂动 |

AI 不能把 `$27.00` 标成 `EMA50`——那条 EMA50 现在已经在 `$26.75` 了,不在 `$27.00`。两者是独立候选,anchorSource 必须区分。

#### 为什么这个区分有实际后果(警戒区例子)

设 entry = $27.50,current = $26.80,**警戒区保守模式**。

候选范围 `(current, softStop]`,即 `($26.80, $27.00]`,谁能进?
- 当前 EMA50 = `$26.75`:在 current **下方**,不在范围内 → 排除
- `fixed_soft_stop = $27.00`:在 current 上方,等于 softStop → ✅ 进候选,也是唯一候选
- SELL_LIMIT 挂在 `$27.00`,反弹兑现就是平本/小亏出场,**回到入场时识别出的真支撑位**

**反例**:如果不把 `$27.00` 当独立候选,候选池就空了,只能落到 `entry+$0.05 = $27.55` 兜底——这个价位没有任何技术支撑作为反弹理由,只是「贴近平本」,**成交概率比 $27.00 低得多**,丢失了「回到入场时结构支撑」这个最自然的解套目标。

> **一句话总结**: 动态锚的「名字」会跟着市场漂走,但「它当时定义的那个价位数字」作为入场承诺保留下来,作为独立候选继续参与每轮 SELL_LIMIT 选择。

#### 适用范围

`fixed_soft_stop` / `fixed_hard_stop` 只在**首次卖出分析之后**的 exit 轮次存在。具体:
- entry 分析、Market Context Scan 阶段:没有(无 `virtualPosition`)
- first_exit 模式:也没有——AI 正在第一次写入 `stopLossPrice` / `hardStopPrice`,这时 `virtualPosition.stopLossPrice` 还没值
- 后续每轮 exit 分析:**可用**——`virtualPosition.stopLossPrice` 已固定,AI 可以引用

---

## `anchorSource` 字段定义

每个 SELL_LIMIT / SELL_NOW / BUY_LIMIT 输出 JSON 里都有一个**必填字段** `anchorSource`,意思是「这个决定的价格是参照哪个关键点位定的」。它是审计 + 连续性追踪的关键。

### 用途(为什么必填)

1. **审计**: 看 reasoning 的人能立刻知道「这个 $28.20 是 prior_high 给的,不是 AI 拍脑袋」。配合 reasoning 强制格式,可以验证 AI 是否真的看了对的关键点位。
2. **连续性判断**: 三分连续性规则(锚不变+值不变 / 锚不变+值变 / 锚失效)全部基于 `anchorSource` 做匹配:
   - 两轮 `anchorSource = "EMA20"` 不变 + 价格变了 → 「锚不变值变」→ realign
   - `anchorSource` 从 `prior_high` 切到 `EMA200` → 「锚切换」→ 提示用户替换挂单
3. **统计学习**: 长期聚合「哪种 anchorSource 的 SELL_LIMIT 成交率高、平均利润大」——trade journal 阶段的潜在分析维度。

### 完整 enum 值

| 类别 | 取值 | 备注 |
|------|------|------|
| 静态点位(Market Context Scan) | `pivot` / `gap` / `prior_high` / `prior_low` | 当日不变 |
| 动态点位(每轮读当前值) | `EMA20` / `EMA50` / `EMA100` / `EMA200` / `VWAP` | 漂移后用新值,anchorSource 名字不变 |
| 盘中静态点位(v19 新增) | `intraday_high` / `intraday_low` / `opening_range_high` / `opening_range_low` / `intraday_pivot` | 入场后逐渐形成 |
| 固定止损(v19 新增,持仓期专有) | `fixed_soft_stop` / `fixed_hard_stop` | 只能在**首次卖出分析之后**的 exit 轮次出现(first_exit 是 AI 第一次写入 stopLossPrice / hardStopPrice,那时还没有 `virtualPosition.stopLossPrice` 可参照);entry 模式 schema 不允许 |
| 无可用关键点位(保守兜底) | `conservative_estimate` | AI 看图保守估,非池中点位;用于:健康区/观察区走止盈无 R1、观察区走解套无候选 fallback 到 entry+$0.05 |
| 警戒区激进 target(v19 新增) | `aggressive_recovery` | **专用**于警戒区 AI 主观判定激进时挂 `entry+$0.05`;与 `conservative_estimate` 严格区分(详见下方"选择规则") |
| SELL_NOW 专用(非 SELL_LIMIT) | `stop_broken` / `force_exit` | 前者破硬止损,后者临近收盘 |

### 选择规则(给 AI 的明确指令)

- **优先用真实关键点位**: 任何能匹配到候选池(静态 / 动态 / 盘中静态 / 固定止损)的点位,都必须标对应 enum 值,不能标 `conservative_estimate`。
- **不能贴标签**: $28.20 来自 prior_high 就标 `prior_high`,不能因为同时离 `EMA200` 也不远就标 `EMA200`。一个价格一个真锚源。
- **固定止损 vs 动态当前值要分清**: `$27.00` 是 `virtualPosition.stopLossPrice`(入场时承诺) → 标 `fixed_soft_stop`,即使当时锚源是 EMA50,**也不能**标 `EMA50`(因为 EMA50 现在已经漂到别的位置了)。注意:`fixed_soft_stop` / `fixed_hard_stop` 只在**首次卖出分析之后**的 exit 轮次可用,first_exit 模式下 AI 还在写入这两个止损值,不能引用尚未写入的值。
- **SELL_NOW 的 anchorSource**: 只能是 `stop_broken` 或 `force_exit`,二选一。所有 SELL_LIMIT 才能用前几类(`pivot` / `EMA20` / `fixed_soft_stop` 等)。
- **`conservative_estimate` vs `aggressive_recovery` 严格区分**(都对应 entry+$0.05 价格,但语义不同):
  - `conservative_estimate`: **被动的兜底**——候选池为空,AI 不得不挂在 entry+$0.05。用于观察区走解套无候选 / 健康区或观察区走止盈无 R1。
  - `aggressive_recovery`: **主动的选择**——警戒区里 AI 看到清晰强反弹证据,**主动**判定挂在 entry+$0.05 而非默认的保守 target。
  - **警戒区激进时严禁用 `conservative_estimate`**——必须用 `aggressive_recovery`,因为这不是"无可用关键位"的兜底,是"我看到强证据主动选择更激进 target"的决策。
  - validator 加约束:`aggressive_recovery` 只能在警戒区出现(其他区检测到 → 拒绝;警戒区检测到但 reasoning 没有 ≥2 数字证据 → 强制改回 fixed_soft_stop)。

### 与 reasoning 字段的协同

`reasoning` 字段的强制格式(见「输出 schema」节)里要求显式写出 `target=<price>@<anchor>`,这里的 `<anchor>` 就是 `anchorSource` 字段的同一个值。两者必须一致,validator 应做交叉检查。

---

## 触发器:"Limit filled" 启动首次卖出分析

**入场策略到 BUY_LIMIT 成交为止;持仓策略从用户点击 "Limit filled" 那一刻开始。**

工作流:
```
1. 用户在券商端 BUY_LIMIT 成交
2. 用户点插件 "Limit filled"(或在 setup 时声明"我已持仓")
3. 插件立刻触发一次"首次卖出分析"——非定时的特殊扫描
4. AI 重新读 5 分钟图,产出:
     - virtualPosition.stopLossPrice  (软止损)
     - virtualPosition.hardStopPrice  (硬止损)
     - 首个 SELL_LIMIT 的位置(按当前所在区间挂)
     - anchorSource(SELL_LIMIT 的锚点)
5. 插件写入 virtualPosition,转入持仓状态
6. 之后按用户设的持仓扫描间隔,运行常规 exit mode 分析
```

**为什么是特殊一次?**——首次卖出分析是**唯一**会写入 `stopLossPrice` / `hardStopPrice` 的时刻。这两个值在持仓期间**不会变**(no trailing),它们是"入场时的承诺"。

---

## 双止损的定义

**核心原则:止损锚定在 `entryPrice` 上,不是 `currentPrice` 上。** 论点是围绕入场价构建的,所以止损的结构性意义必须从入场价出发。新建挂单成交时,`entryPrice ≈ currentPrice`,两者几乎一致;但**手动声明的已有持仓**可以差异显著(用户两天前就买了,今天才启动插件),所以必须用 `entryPrice`。

| 概念 | 定义 |
|------|------|
| **软止损 (stopLossPrice)** | `entryPrice` **下方最近**的关键点位 |
| **硬止损 (hardStopPrice)** | 软止损**下方最近**的关键点位 |

**举例**:
- entryPrice = $30.00
- 当前价 $30.00(刚成交瞬间)
- 关键点位池里在 $30 下方的有:`VWAP @ $29.70`、`EMA20 @ $29.40`、`EMA50 @ $28.80`、`prior_low @ $27.50`、`EMA200 @ $25.00`
- **软止损 = $29.70 (VWAP)**(入场下方最近)
- **硬止损 = $29.40 (EMA20)**(软止损下方最近)

> **不变性**:这两个止损一旦设定就**固定不变**(no trailing)。即使后续价格涨到 $33 然后回踩到 $30,软止损仍然是 $29.70。这是"承诺",不是动态线。

> **首次卖出分析时**,软硬止损之间不会有第三个关键点位——by definition,既然软止损是入场下方最近、硬止损是软止损下方最近,首次分析的那个瞬间中间不可能存在其他静态 / 动态关键点位。
>
> **但后续轮里,候选池会持续增长**,来自三种来源:
> 1. **入场后新形成的盘中关键点位**(例如新打出的 LOD 落在软硬止损之间)
> 2. **动态点位漂移后的新值**(入场时 EMA50 = $29.70,2 小时后漂到 $29.50,落在了 $29.70 和 $29.40 之间)
> 3. (相对地)**固定的软 / 硬止损数字本身**也保留为独立候选,详见上一节「关键澄清」
>
> 所以后续轮里"软硬止损之间有没有别的关键点位"这个问题,答案随时间会从"没有"变成"有"。AI 每轮重读一次池子即可。

---

## 四个区间的状态机

每一轮 exit mode 分析:

```
读 currentPrice
读 entryPrice / virtualPosition.stopLossPrice (softStop) / virtualPosition.hardStopPrice (hardStop)

if 临近 16:00 ET (force_exit window):
    → SELL_NOW                          [强制收盘]

elif currentPrice ≤ hardStop:
    → SELL_NOW                          [必须离场区]

elif currentPrice ≤ softStop:
    → [警戒区 / 解套流程]
    → AI 在"保守(softStop) / 激进(entry+0.05)"之间主观判断
    → SELL_LIMIT @ 对应目标

elif currentPrice ≤ entryPrice:
    → [观察区]
    → AI 在"走止盈(R1) / 走解套(≤entry+0.05)"之间主观判断
    → SELL_LIMIT @ 对应目标

else:  (currentPrice > entryPrice)
    → [健康区]
    → AI 根据 K 线形态判断走势强弱
    → SELL_LIMIT @ 入场价上方 R1 (普通) 或 R2 (强劲)
```

**SELL_NOW 触发器只有两个,没有别的**:破硬止损,或临近收盘。其他任何情况都是 SELL_LIMIT。

> **关于"临近收盘"分支的实现层次**: 这一分支**不是 AI 自己读时间判断**的。`background.js` 用 `isNearUsMarketClose()` 检查收盘前 10 分钟窗口,决定调用 LLM 时传 `mode=force_exit`,prompt 在这个 mode 下把 schema 的 action 强制锁死为 `SELL_NOW`。AI 接到 `mode=force_exit` 就只能输出 SELL_NOW,无判断空间。
>
> 上面伪代码的 `if 临近收盘 → SELL_NOW` 是描述**整个系统**在那个时间窗的行为,而不是 AI 在 prompt 推理时检查的条件。

---

## 区间一:健康区 (currentPrice > entryPrice)

### 含义
已经浮盈。位置健康,默认期待是继续上行。

### 候选池(以入场价为锚)

完全围绕 `entryPrice` 构建,**不**以 `currentPrice` 为锚:

1. **来源**:`entryPrice` **上方**的所有关键点位(静态 + 动态当前值 + 盘中静态)。`fixed_soft_stop` / `fixed_hard_stop` 在入场下方,不进本区候选池。
2. **过滤(机械约束)**:剔除已经被价格突破的——即剔除 ≤ `currentPrice` 的点位。这一步用 `currentPrice` 不是因为它是锚,而是 SELL_LIMIT 必须高于当前价才不会立即成交。
3. **排序**:剩下的按距离 `entryPrice` 从近到远排序,记为 `R1, R2, R3, ...`

### AI 判断:trend=normal(R1) vs trend=strong(R2)(主观综合判断,带证据约束)

健康区是浮盈状态,**承受得起**让 SELL_LIMIT 挂远一点等更大利润——大不了没成交、下一轮重评。AI 用**和观察区/警戒区相同的 7 维度证据 checklist + 三条约束**判断走势强弱:

| 走势 | 含义 | Target |
|---|---|---|
| **trend=normal**(默认) | 上行证据不清晰一致 | `R1`——current 上方第一个未被突破的关键点位(吃近端利润,成交率高) |
| **trend=strong**(需 ≥2 条数字证据) | 多维证据一致指向强上行 | `R2`——第二个未被突破的关键点位(让利润奔向更远压力) |

**方向**:强上行证据 → trend=strong(R2);证据不清晰/矛盾/偏弱 → 默认 trend=normal(R1)。

**7 维度证据**(同观察区/警戒区,健康区解读):
1. K 线形态:连续阳线、收盘 strictly 抬高(**「3 阳 + strictly 抬高」现在是这一维的强证据示例,但不再是唯一的机械触发条件**)
2. EMA:多头排列、current 远在 EMA 之上、斜率向上
3. VWAP:站稳 VWAP 上方
4. 量能:上行放量
5. 距 R1 远近:R1 越近,押 R2 的边际价值越大
6. R1 vs R2 间距:间距大 = 押 R2 的 ROI 显著
7. Market Context:大盘 regime 向上、同行业强

**三条约束**(同观察区/警戒区):
- 约束 1(硬规则):不确定 = 默认 trend=normal(R1)
- 约束 2:trend=strong 必须列 ≥2 条带数字的 observable evidence
- 约束 3:短期/中期冲突 → 默认 normal

**为什么只允许 R1 / R2,不允许 R3+**:强劲也有边界,避免贪心。R3+ 距离太远,成交概率剧降,长期 EV 不见得正。

**为什么改成 AI 主观(而非原来的机械 3 阳条件)**:机械单条件("3 阳 + strictly 抬高")只看了 K 线一维,丢失量能/EMA/R1-R2 间距/大盘等信号——比如"3 阳但缩量、且 R1-R2 间距极小"其实不值得押 R2。改成 7 维度主观判断能综合这些。实测效果差可回退到机械 3 阳条件。

### 边界

| 情况 | 处理 |
|---|---|
| `R1` 距当前价几个 tick 以内(几乎贴脸) | 无论强劲/普通,挂略高于 `R1` 几个 tick,避免立即成交 |
| 强劲走势但 `R2` 不存在(只有 `R1` 一个未被突破阻力) | 退回挂 `R1`,reasoning 标注 "no R2 available" |
| 完全没有上方未被突破阻力(突破新高、全部候选都已突破) | 看图给保守估计,`anchorSource = "conservative_estimate"` |

### Trail up by levels(自动机制)

不需要 AI 主观判断"挂得太近还是太远"。多轮迭代自动处理:
- 价格突破 `R1` → 下一轮 `R1` 被过滤掉 → 原 `R2` 升格为新 `R1`、原 `R3` 升格为新 `R2` → SELL_LIMIT 自动 trail 上去
- 价格突破 `R2`(只在强劲走势挂在 `R2` 时发生)→ 下一轮 `R1` / `R2` 都被过滤掉 → 原 `R3` 升格为新 `R1`、原 `R4` 升格为新 `R2` → AI 又在新的 `R1` / `R2` 间选
- 价格回踩 `R1` 下方但仍在入场以上 → SELL_LIMIT 保持原位,大概率成交
- 走势从强劲变普通(K 线不再连续阳线收盘抬高)→ 下一轮自动从 `R2` 回到 `R1`

> **关键性质**:`R1` / `R2` 的编号**每轮重新生成**,永远基于"过滤掉已被突破的之后"的最新候选池。所以"R3+ 禁止"是一个**永远只看当下序号**的规则——价格如果突破了原 R2,下一轮的"R3"已经不是原来那个 R3 了,AI 仍然合法地在新 R1 / R2 间挑选。这就是为什么不需要给"突破 R2 后允许 R3"专门写 exception——trail-up 机制自动等价处理。

---

## 区间二:观察区 (softStop < currentPrice ≤ entryPrice)

### 含义
浮亏中,但**两个止损都没破**。这是位置最微妙的状态:可能是即将反弹回到浮盈、也可能是即将继续下探破软止损。

### AI 判断: 走止盈 vs 走解套(主观综合判断,带证据约束)

观察区是**三个允许 AI 做主观综合判断的持仓区之一**(另外两个是健康区和警戒区;只有必须离场区是机械规则)。这里允许 AI 充分使用 reasoning 能力,综合多项观察证据,在「走止盈」和「走解套」之间二选一。

> **设计权衡**: 我们之前删过几个 AI 主观特性(`userContext` 笔记、自评 confidence、AI 生成的 lesson、signal review),都因为 AI 倾向于用 reasoning 流畅度替代证据强度而失败。观察区(和警戒区)是这种试验**最有价值**的地方,因为这里语义最丰富(浮亏程度 / 距 softStop 远近 / 量能 / EMA 排列 / VWAP / 市场大势全都相关),纯机械规则会丢失大量信号。但为了避免重蹈覆辙,主观判断必须配以下面三条结构约束。

#### 流程定义

| 流程 | 含义 | SELL_LIMIT 目标 |
|------|------|----------------|
| **走止盈**(押反弹回到浮盈) | 反弹证据清晰一致 | `R1` = 入场价上方第一个未被突破的关键点位(详见"走止盈 target 规则") |
| **走解套**(认怂、求平本)  | 默认;反弹证据不清晰 / 互相打架 / 偏空 | 见下方"走解套 target 规则" |

#### 证据 checklist(AI 综合考虑的 7 个维度,与警戒区对称)

判断走止盈 vs 走解套时,AI 应综合下列**可观察证据**(不一定全部具备,但要明确每一项的方向):

| # | 维度 | 在观察区的解读 |
|---|------|---------------|
| 1 | **K 线形态** | 最近 3-5 根 5 分钟 K 线的最低 / 最高点走势、阳阴线分布、收盘价相对开盘价 |
| 2 | **均线关系** | current 相对 EMA20/50 的位置、EMA 排列(多头/空头/纠缠)、EMA 斜率 |
| 3 | **VWAP** | current 相对 VWAP 的位置、最近是否有 reclaim(站回上方)/ reject(被压回下方) |
| 4 | **量能** | 当前 K 线相对前几根的量能扩张 / 萎缩;下跌是放量还是缩量 |
| 5 | **距下方止损(softStop)** | 越接近 softStop,越倾向走解套(下方安全垫薄) |
| 6 | **距上方目标(entry)** | 越接近 entry,越接近脱离浮亏,越敢押反弹 |
| 7 | **市场大势 (Market Context)** | 大盘 regime / 同行业方向 / 整体风险偏好 |

> **冲突时的决策原则**: 当短期形态(维度 1-4)和大盘/中期信号(维度 5-7)冲突时——比如「3-bar lows 抬高」但「大盘 regime 是下跌中」——**以更悲观的一方为准,走默认(走解套)**。理由:观察区已经是浮亏状态,押反弹应该要求多方面一致信号,任何一项偏空都把"清晰一致"的门槛拉到不满足。

#### 三条结构约束(防止主观判断退化)

**约束 1: 默认走解套是硬规则**
> 如果上述证据**不构成清晰一致的反弹信号**(指标互相打架、全部中性、或明显偏空),**必须**走解套。「不确定 = 走解套」不可妥协。这条不是建议,是硬规则——目的是防止 AI 用 reasoning 流畅度把模糊信号包装成"看起来像反弹"。

**约束 2: 走止盈必须列出至少 2 条 observable evidence**
> 走止盈时 reasoning 必须列出**至少 2 条具体证据**,每条都带**数字或位置参照**。不允许 "looks bullish" / "momentum building" / "feels strong" / "should rebound" 这类形容词。
>
> 合规例子: `"flow=push-rebound (evidence: (1) 3-bar lows 27.15→27.18→27.20 rising; (2) current=27.20 above EMA20=27.10 with VWAP reclaim from below)"`
>
> 违规例子: `"flow=push-rebound (looks bullish, momentum building)"`

**约束 3: validator 拒绝模糊证据**
> validator 检查走止盈 reasoning:必须包含**至少 2 个独立的数值参照**;不允许出现模糊词。不达标则强制改写为走解套。
>
> **「独立的数值参照」精确定义**:
> - 一个完整的「锚=数字」对算 1 个,如 `EMA20=27.10`、`VWAP=27.15`、`3-bar lows 27.15→27.18→27.20`(序列算 1 个)、`volume 1.8×`(倍数算 1 个)、`only 0.20 above hardStop`(距离算 1 个)
> - 重复同一个数值不算,如 `current=27.20` 后面又写 `now at 27.20` 只算 1 个
> - reasoning 必备的 `current=X, softStop=Y, hardStop=Z, entry=W → zone=...` 区间判断链**不计入**这 2 个,那是格式必备
>
> **「模糊词」黑名单**:`looks like / feels / seems / should / probably / likely / momentum / bullish / bearish / strong / weak`
> - 如果这些词后面紧跟着 `(具体数字证据)`,**允许**——比如 `momentum confirmed (volume 1.8× of down bars)` 合规
> - 如果裸用、或后面只是另一个模糊词,**拒绝**——比如 `bullish momentum` 不合规

#### 走解套时的 reasoning 可以简短
> 默认动作不需要重论证。reasoning 只需简短说明判断结果(例如 `"flow=recovery (default: evidence not conclusive for push-rebound)"` 或 `"flow=recovery (current 27.05 near softStop 27.00, weak position)"`)。

#### 监测指标(这个试验成败的判断依据)

等运行一段时间后(预计 30-50 笔观察区平仓样本),从 tradeHistory 里看:

| 指标 | 走止盈应该 | 走解套应该 |
|------|-----------|-----------|
| 成交率 | 中等(反弹真的发生才成交) | 高(目标贴近,容易触及) |
| 平均最终 P&L | 应当 > 走解套(反弹兑现 → 平本以上) | 接近 0 或小亏 |
| 反例信号 | 如果走止盈胜率 < 走解套,或平均 P&L 不显著高于走解套,**回退到机械 K 线规则** |

### 走解套时的 target 选择规则(观察区版本)

设 `entry = entryPrice`, `current = currentPrice`,观察区一定满足 `softStop < current ≤ entry`。注意此时 `softStop` 在 `current` **下方**,不在 `current` 和 `entry` 之间。

候选范围: `(current, entry + $0.05]`(current 上方、上限 entry+$0.05)。

**默认 target = `entry + $0.05`**,anchorSource = `conservative_estimate`。

理由:由双止损定义,`softStop` 是 `entry` 下方**最近**的关键点位,这意味着首次分析时 `(softStop, entry]` 内**没有任何静态/动态关键点位**,而 `current` 又在 `(softStop, entry]` 内,所以 `(current, entry]` 在首次分析时**必然为空**。`(entry, entry+$0.05]` 只是 5 美分窄缝,几乎不会刚好有真实关键位。结论:**走解套的候选范围在首次分析时本来就是空的**,默认必然落在 entry+$0.05 兜底。

**只在以下情况下偏离默认**:候选范围 `(current, entry+$0.05]` 里出现了**入场后才形成的**候选,挑最接近 `current` 的那个:

| 候选来源 | 例子 |
|---|---|
| 入场后形成的盘中静态点位 | 新打出的 intraday_pivot 落在 `(current, entry]` 内 |
| 动态点位漂移进来 | EMA20 从原位置漂入 `(current, entry]`(罕见,通常 EMA 跟随价格下行) |

> **关于 $0.05**: 固定美元、不按百分比。意图是给"刚好平本"留一点点缓冲(避免精确等于 entry 的限价单因为 tick 跳动错过成交)。不是给 AI 自由设置的空间。

### 走止盈时的 target 选择规则(观察区版本)

观察区 走止盈 = 押反弹**回到浮盈**(回到入场价上方)。所以 target 必须**高于入场价**,不能是 current 上方但 entry 下方的中间点位(那只是部分反弹,不算"回到浮盈")。

**Target = `R1` = 入场价上方第一个未被突破的关键点位**(同健康区候选池构建方式)。

**与健康区的区别**:观察区**不**允许 R2 / 不引入"强劲走势"判断——前提逻辑已经被破坏了(我们在浮亏中,谈不上"强劲"),押反弹到 R1 已经是一个相对积极的赌注,不再额外加码。

没有 `$0.05` 上限——前提是 AI 已经判断这是反弹回到浮盈的赌注。

**R1 不存在的边界情况**: 如果 entry 上方完全没有未被突破的关键点位(突破新高场景,详见边界 4),观察区走止盈**强制回退到走解套**——理由是「走止盈」的核心是押反弹**回到 R1 这个有意义的阻力位**,如果连 R1 都不存在,押反弹就是无锚的赌博。此时:
- AI 决定不再写"flow=push-rebound",改写"flow=recovery (fallback: no R1 available, no anchor for push-rebound)"
- 按走解套规则挂 SELL_LIMIT(默认 entry+$0.05 兜底)

---

## 区间三:警戒区 (hardStop < currentPrice ≤ softStop) ——解套流程

### 含义
软止损被破。**这正是用户实操观察"破第一个支撑后下个支撑常反弹"的场景**——价格下探到下方某处后,常常反弹回来,给你一个**平本 / 小亏出场**的机会。

警戒区**强制进入解套流程**(不押反弹回到浮盈,只求平本 / 小亏离场),但**允许 AI 在「保守 target」和「激进 target」之间主观判断**——和观察区设计原则对称。

### AI 判断: 保守 vs 激进 target(主观综合判断,带证据约束)

警戒区是**三个允许 AI 主观判断的持仓区之一**(另外两个是健康区、观察区)。机械单 target 会丢失信号——比如量能突然放大 + EMA 反弹,本可以挂高一档争取近平本,机械规则却挂在 softStop 提早落袋。

#### 双 target 定义

| 模式 | target 价格 | anchorSource | 适用场景 | 反弹兑现的 P&L |
|------|------------|--------------|---------|----------------|
| **保守(默认)** | `fixed_soft_stop`(或更近的盘中 / 漂移点位,见下方"target 候选筛选") | `fixed_soft_stop` / 对应候选锚名 | 默认;反弹证据不清晰 / 偏弱 / 距 hardStop 近 | 小亏(例如 entry $27.50 - softStop $27.00 = -$0.50/股) |
| **激进**     | `entry + $0.05` | `aggressive_recovery`(v19 新增,警戒区专用) | 反弹证据清晰一致 + 距 hardStop 安全垫够厚 | 几乎平本(-$0 ~ -$0.05/股) |

#### 证据 checklist(AI 综合考虑的 7 个维度,与观察区对称)

判断保守 vs 激进时,AI 应综合下列**可观察证据**(维度 1-4 + 7 与观察区相同;维度 5-6 是「距下方止损 / 距上方目标」的警戒区版本,语义方向与观察区有差异):

| # | 维度 | 在警戒区的解读 |
|---|------|---------------|
| 1 | **K 线形态** | 最近 3-5 根 K 线的反弹幅度 / 阳线 vs 阴线分布 / 收盘价相对开盘价 |
| 2 | **均线关系** | current 相对 EMA20/50 的位置、有没有刚刚 reclaim 某条 EMA |
| 3 | **VWAP** | current 相对 VWAP 的位置、是否在尝试 reclaim |
| 4 | **量能** | 反弹根的成交量 vs 之前下跌根;放量反弹是强信号 |
| 5 | **距下方止损(hardStop)** | 越接近 hardStop,越倾向保守(下方危险线近,失败成本不可承受) |
| 6 | **距上方目标(softStop)** | **反向于观察区**——警戒区里 `current` **越接近 softStop**(快要 reclaim)→ 反弹动能越强 → 越倾向激进 |
| 7 | **市场大势 (Market Context)** | 大盘 regime / 同行业方向 |

> **冲突时的决策原则**: 当短期形态(维度 1-4)和大盘/中期信号(维度 5-7)冲突时——比如「reclaim EMA20 + 放量」但「大盘 regime 偏弱」——**以更悲观的一方为准,走默认(保守)**。理由:警戒区已经破软止损,激进押注必须要求多方面一致强信号,任何一项偏空都不达"清晰一致强反弹"门槛。

#### 三条结构约束(防止主观判断退化,与观察区相同)

**约束 1: 默认保守是硬规则**
> 如果证据**不构成清晰一致的强反弹信号**(指标互相打架、全部中性、或明显偏弱),**必须**用保守 target。「不确定 = 保守」不可妥协。

**约束 2: 激进必须列 ≥2 条 observable evidence**
> 激进 target 时 reasoning 必须列出**至少 2 条具体证据**,每条带**数字或位置参照**。不允许 "looks bullish" / "momentum strong" / "feels like recovery" 这类形容词。
>
> 合规例子: `"target=aggressive=27.55=entry+0.05 (evidence: (1) volume on bounce bar 1.8× of avg down bars; (2) reclaimed EMA20=26.92 with current=26.95, only 0.05 from softStop)"`
>
> 违规例子: `"target=aggressive (looks like strong recovery)"`

**约束 3: validator 拒绝模糊证据**
> validator 检查激进 reasoning:同观察区走止盈的判定规则(见观察区 § 约束 3 的「独立数值参照」+「模糊词黑名单」精确定义)。不达标 → validator 强制改回保守 target。

### Target 候选筛选(保守模式下的具体规则)

设 `entry = entryPrice`, `current = currentPrice`,警戒区满足 `hardStop < current ≤ softStop`。

**保守模式**: SELL_LIMIT @ `current` **上方** + ≤ `softStop` 之间**最近**的关键点位。

通常这个候选**就是 `fixed_soft_stop`**——因为 softStop by definition 在 `current` 上方,且 softStop 自己就是 entry 下方最近的关键点位。

例外情况(更近的候选)只有两种:
- **盘中静态点位**漂移进来(例如入场后形成的新 intraday_pivot 落在 `current` 和 `softStop` 之间)
- **动态点位**漂移进来(罕见——EMA 通常跟价格下行,往上漂的情况少)

如果有更近的候选 → 用更近的(因为更接近 current → 反弹兑现的概率更高)。

**激进模式**: SELL_LIMIT @ `entry + $0.05`,anchorSource = `aggressive_recovery`(**专用 enum,严禁用 `conservative_estimate`**——后者表示无可用关键位的被动兜底,前者表示 AI 主动判定升级 target,语义不能混)。

### 不做的事

- **不押反弹回到浮盈**: 即使激进模式,target 也只到 `entry + $0.05`(几乎平本),不挂高到 `entry` 上方的 R1。"既已破软止损,押反弹回到浮盈"在 EV 上不划算——失败成本高(可能破 hardStop 亏 $1.20+),成功收益也只是从平本到小赚,不对称。
- **不做加仓 / 摊薄成本**: 经典 Martingale 陷阱,v1 明确不做。

### 为什么警戒区不是 SELL_NOW?

实操核心观察:**破软止损 ≠ thesis 已死,常常是"假破"**。给反弹一个机会:
- 反弹强 → SELL_LIMIT(保守或激进)成交 → 小亏或近平本出场 ✓
- 反弹弱 → SELL_LIMIT 留在那里,等下次反弹机会
- 反弹失败 → 价格继续跌破硬止损 → SELL_NOW(自动)

### 监测指标(这个试验成败的判断依据)

等运行一段时间后(预计 30-50 笔警戒区平仓样本),从 tradeHistory 里看:

| 指标 | 激进 target 应该 | 保守 target 应该 |
|------|----------------|-----------------|
| 成交率 | 较低(反弹要走得更远) | 较高(目标贴近) |
| 平均最终 P&L | 应当显著优于保守(从 -$0.50 提升到 -$0.05) | 稳定小亏 |
| 反例信号 | 如果激进胜率 < 保守 + 没有显著 P&L 改善,**回退到机械单 target(永远保守)** |

---

## 区间四:必须离场区 (currentPrice ≤ hardStopPrice)

### 含义
**thesis 已死。** 双止损都被破说明 cascade 已经在发生,继续等是 loss aversion 而不是策略。

### 动作
`SELL_NOW`,无条件,不留情面。

```json
{
  "action": "SELL_NOW",
  "orderPrice": null,
  "anchorSource": "stop_broken",
  "reasoning": "Hard stop $X broken at $Y; next deep support EMA200 = $Z (info only, exiting now)"
}
```

### reasoning 里报告"下一深支撑"(纯信息,不改动作)

reasoning 应该提一句**下一深支撑**在哪,让用户在决定**市价 vs 略低 marketable limit**时心里有数。**这不改变 SELL_NOW 的决定**,只是给手动执行多一个参考。

**「下一深支撑」的精确定义**: `hardStopPrice` **下方最近的关键点位**(从候选池里筛 < hardStop 的,取最近的)。如果找不到(罕见),reasoning 标注 "no deeper level visible"。

### 为什么是硬规则?

承认错误的线。任何"再等一下下个支撑"都是 loss aversion 在合理化。**过了硬止损,价格往往不是再去测下一个支撑,而是直接 panic cascade**。

历史上每个 blowup 故事里都有"我以为下一个支撑会守住"。硬止损是兜底。

---

## 强制离场(临近 16:00 ET,不变)

`isNearUsMarketClose()` 返回 true(收盘前 10 分钟) → `SELL_NOW`,日内交易不留隔夜。

优先级最高,在任何其他判断之前。

---

## 输出 schema

### 首次卖出分析(Limit filled / 已持仓声明 触发)

```json
{
  "action": "SELL_LIMIT | SELL_NOW",
  "orderPrice": "<SELL_LIMIT 价格 / SELL_NOW 时为 null>",
  "anchorSource": "<锚点 / 'stop_broken' / 'conservative_estimate'>",
  "stopLossPrice": "<软止损,固定写入 virtualPosition>",
  "hardStopPrice": "<硬止损,固定写入 virtualPosition>",
  "reasoning": "<≤120 字>",
  "currentPrice": "...",
  "symbol": "..."
}
```

**SELL_NOW 在首次分析的特殊情况**:用户挂单成交后到点 "Limit filled" 之间发生 gap-down,首次分析时 `currentPrice` 已经在硬止损以下——这种情况首次分析直接返回 SELL_NOW(不能挂 SELL_LIMIT,因为没有"上方关键点位"是有意义的),`anchorSource = "stop_broken"`。

### 后续每轮 exit 分析(常规 schedule)

```json
{
  "action": "SELL_NOW | SELL_LIMIT",
  "orderPrice": "<SELL_LIMIT 时的价格 / SELL_NOW 时为 null>",
  "anchorSource": "<SELL_LIMIT 锚点 / 'stop_broken' / 'force_exit'>",
  "reasoning": "<≤120 字,必须包含区间判断链 + AI 子判断依据(见下)>",
  "currentPrice": "...",
  "symbol": "..."
}
```

**reasoning 强制格式**(便于测试和审计 AI 是否真的看了对的数):

1. **区间判断链**: 必须显式写出 `current=X, softStop=Y, hardStop=Z, entry=W → zone=<区间名>`
2. **(健康区) AI 子判断**: `trend=normal | strong (依据: 3-bar pattern: X→Y→Z)` + `R1=<price>@<anchor>` 或 `R2=<price>@<anchor>`
3. **(观察区) AI 子判断**: `flow=push-rebound | recovery (依据: 3-bar pattern X→Y→Z / default)` + `target=<price>@<anchor>`
4. **(警戒区) AI 子判断**: `target=conservative | aggressive (依据: ...)` + `target=<price>@<anchor>`
5. **(必须离场)**: `next deep support=<price>@<anchor>`

**完整示例**:
```
"current=27.20, softStop=27.00, hardStop=26.30, entry=27.50 → zone=observation; flow=push-rebound (3-bar lows 27.10→27.15→27.20 strictly higher); target=R1=28.20@prior_high"
```

**注意**:
- 后续轮**不**重新输出 `stopLossPrice` / `hardStopPrice`——这两个值在首次分析时定下来后**永久固定**在 `virtualPosition` 上,后续轮直接读
- reasoning 上限 120 字,如果超长可缩写但**区间判断链不能省**(那是审计的核心)

---

## 完整工作流

```
持仓阶段开始:
[阶段 1: Limit filled 瞬间 / 或已持仓声明]
    用户点 "Limit filled" 或在 setup 时声明已持仓
    ↓
    pendingLimitOrder → 转成 virtualPosition (entryPrice = 限价单价 / 用户输入价)
    ↓
    触发首次卖出分析(特殊一次,非定时):
        AI 读 5 分钟图
        输出 stopLossPrice (软止损) + hardStopPrice (硬止损) + 首个 SELL_LIMIT
    ↓
    写入 virtualPosition:
        virtualPosition.stopLossPrice  ← AI 给的软止损
        virtualPosition.hardStopPrice  ← AI 给的硬止损
    ↓
    state.lastResult.analysis  ← AI 给的首个 SELL_LIMIT(或 SELL_NOW)
    ↓
    用户在券商端按 SELL_LIMIT 价位挂卖单

[阶段 2: 定时 exit 分析]
    按用户设定的"持仓扫描间隔"循环:
        AI 读 5 分钟图
        读 currentPrice / entryPrice / softStop / hardStop
        机械判断所在区间 → 决定流程
        
        if 临近收盘:           → SELL_NOW
        elif current ≤ hardStop: → SELL_NOW (硬止损破)
        elif current ≤ softStop: → AI 主观判断在"保守(softStop)/激进(entry+$0.05)"间选 → SELL_LIMIT
        elif current ≤ entry:   → AI 主观判断在"走止盈(R1)/走解套(≤entry+$0.05)"间选 → SELL_LIMIT
        else:                   → AI 看 K 线判断走势强弱 → SELL_LIMIT @ R1(普通)/R2(强劲)
        
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

和买入策略同样的逻辑,但**比较元组是 `(zone, anchorSource, orderPrice)`**——zone 必须参与连续性判断,否则会出现下面这种 false negative:

> **跨区误判反例(不加 zone 时)**: 假设 v19 没有引入 `aggressive_recovery` enum:上一轮观察区走解套兜底输出 `(conservative_estimate, $27.55)`;下一轮价格跌入警戒区 AI 选激进 target 输出 `(conservative_estimate, $27.55)`——`(anchorSource, orderPrice)` 完全相同,会被判定为"重复信号、用户不用动",但其实跨区切换是关键时刻。
>
> **v19 用两道保护避免这个 bug**:
> 1. **新增 `aggressive_recovery` enum 专用警戒区激进**——警戒区激进时 anchorSource = `aggressive_recovery` 而非 `conservative_estimate`,与观察区走解套兜底天然区分
> 2. **比较元组加 zone**——即使两个区共享同一个 anchor(例如 `prior_high` 在健康区 R1 和观察区走止盈 R1 都可能用),`(healthy, prior_high, ...)` ≠ `(observation, prior_high, ...)`,跨区仍正确判为切换
>
> 双保险:enum 区分 + zone 区分,任一就够,两个一起更稳。

判定矩阵(zone 必须一致才能比 anchor/price):

| 情况 | 处理 | reasoning 标注 |
|------|------|---------------|
| zone 不变 + 锚点不变 + 数值不变 | 重复同样的 SELL_LIMIT,用户保持挂单不动 | "anchor unchanged, repeating" |
| zone 不变 + 锚点不变 + 数值移动 | 给新的 orderPrice(锚点的新位置),用户跟着替换挂单 | "anchor shifted, realigning to EMA20 = NEW_PRICE" |
| zone 不变 + 锚点失效 | 切换到不同的关键点位 | "EMA20 broken upward, switching to next resistance" |
| zone 变了(跨区切换) | 视为"锚切换"——target 完全换一套规则 | "crossed from observation to caution; target rule changed, new SELL_LIMIT at ..." |

**跨区间切换示例**——例如健康区 → 观察区:
- 价格回落,从 entry 上方掉到 entry 下方
- 下一轮发现进入观察区
- AI 主观判断走止盈 / 走解套
- 如果走解套,target 从健康区的 `R1` / `R2` 切换到"默认 entry+$0.05 兜底"(除非有入场后形成的盘中点位/漂移动态点位入侵 `(current, entry+$0.05]` 范围)
- reasoning 说明跨区切换 + 流程切换的依据

**AI 走势判断变化(健康区内 R1 ↔ R2 切换)**: 这也算第 4 种情况,语义类似"锚切换":

| 情况 | 处理 | reasoning 标注 |
|------|------|---------------|
| 健康区 K 线由普通转强劲 | R1 切换到 R2,anchorSource 通常会变 | "trend strengthened (3 green + rising closes); switching from R1=X to R2=Y" |
| 健康区 K 线由强劲转普通 | R2 切回 R1 | "trend no longer meeting strong criteria; reverting from R2=Y to R1=X" |
| 观察区 走止盈 ↔ 走解套 切换 | target 完全换一套规则 | "flow changed from push-rebound to recovery (3-bar lower highs); SELL_LIMIT now bounded by entry+0.05" |
| 警戒区 保守 ↔ 激进 切换 | target 从 softStop 切到 entry+0.05 或反过来 | "warning-zone target upgraded to aggressive (evidence: volume bounce + EMA20 reclaim); switching from softStop=27.00 to entry+0.05=27.55" |

---

## 边界情况

### 边界 1:首次卖出分析时无法找到软止损(入场价下方没有关键点位)

罕见,通常说明用户买在了"无人区"。

**处理**:
- AI 看图给保守估计的软止损(例如入场下方 1% 或 1 个 ATR)
- 同样给保守估计的硬止损(再下方一点)
- reasoning 说明 "no key level below entry, conservative estimate used"
- `stopLossPrice` / `hardStopPrice` 的 anchorSource 标 "conservative_estimate"

### 边界 2:入场价下方只有一个关键点位(软硬止损无法分别从关键点位池里选出)

按双止损定义,软止损是入场下方最近的关键点位,硬止损是软止损下方下一个关键点位。当入场下方关键点位只剩一个时,硬止损在池里找不到第二个,需要兜底。

例:入场 $30,下方只有一个关键点位 $28(EMA200),再下面就什么都没了。

**处理**:
- 软止损 = $28(池里那唯一一个)
- 硬止损 = AI 看图给保守估计的更深位置(例如 $27 或 $26)
- reasoning 标注:"hardStop = conservative estimate below 28 due to sparse levels"

### 边界 3:首次卖出分析的默认方向(按 currentPrice 所在区,不做主观判断)

**适用场景**: 所有首次卖出分析——包括 fresh-fill 后立刻分析、gap-down 成交、手动声明已持仓、老仓激活等。

**处理**:首次分析照样跑,根据成交瞬间的 `currentPrice` 判断区间,**所有情况都不做主观判断**(理由见下),只走默认方向:

> **绝对规则(所有区通用)**: 任何 SELL_LIMIT 的 orderPrice 必须**严格高于 currentPrice**(挂在 current 下方的卖单会立刻以劣于市价成交)。选点位时先过滤掉 ≤ current 的。

| current 所在区 | 首个 SELL_LIMIT | 理由 |
|---|---|---|
| 健康区(current > entry) | **走止盈,挂 current 上方最近的未突破关键位**(走势强弱判据强制按"普通"处理) | 延续 buy thesis。**注意:浮盈时(current > entry)entry 和 current 之间的关键位已被突破,不能选——必须选 current 上方的**(否则 orderPrice ≤ current 被 validator 拒) |
| 观察区(softStop < current ≤ entry) | **走止盈,挂 R1 = entry 上方最近未突破关键位**(此时 R1 天然在 current 上方,因 current ≤ entry) | 刚买入时的微小漂移恰恰是你期待的"反弹前的最后一震",强制走解套等于刚买入就用「认怂」逻辑出场,会被 fresh-fill 噪声卖飞 |
| 警戒区(hardStop < current ≤ softStop) | **保守 target = softStop 价格**(softStop 在 current 上方,因 current ≤ softStop)。**anchorSource = 软止损所对应的底层关键位名(如 'EMA50' / 'prior_low'),不能用 'fixed_soft_stop'**——首次分析正在创建这个止损,还不能引用它 | thesis 已被市场否定(price 直接破软止损),挂 softStop 求平本是正确响应 |
| 必须离场区(current ≤ hardStop) | **SELL_NOW** | thesis 已死,首次分析直接 SELL_NOW |

> **健康区 / 观察区首次分析的子边界:R1 距 current 几个 tick 以内** —— 同每轮 exit 分析的健康区规则,挂略高于 R1 几个 tick,避免 SELL_LIMIT 立即被噪声成交。
>
> **健康区 / 观察区首次分析的另一子边界:R1 不存在** —— 突破新高场景或所有上方阻力都被突破,看图给保守估计,anchorSource = `conservative_estimate`(详见边界 4)。

> **为什么首次分析不做主观判断?**
>
> AI 在首次分析时看到的图表历史是入场**前**的形态,不是入场后的持仓期形态。用入场前的证据判断"反弹趋势 / 趋势强劲" / "保守 vs 激进"在语义上不对——AI 不知道你"是在哪里入场的反弹",所以也无法说"反弹已经开始"。持仓期的主观判断需要"入场后的市场行为"作为依据,这个数据要等首次分析之后的**第二轮**才有。
>
> **为什么默认方向因区而异?**
>
> 默认方向取决于「buy thesis 是否还成立」:
> - **健康区**(`current > entry`):浮盈中,thesis 兑现中 → 默认**延续 thesis = 走止盈**,挂 R1。
> - **观察区**(`softStop < current ≤ entry`):浮亏但 softStop 没破,thesis 还有效(支撑反弹的论据没被打破) → 默认**延续 thesis = 走止盈**,挂 R1 等真正的反弹兑现。这避免了"fresh-fill 后被微小噪声震飞"的反例。
> - **警戒区**(`hardStop < current ≤ softStop`):current 已破软止损,buy thesis 被市场否定(支撑没守住)→ 默认**收缩到保守 = 挂 softStop**,把损失控制在小亏。
> - **必须离场区**(`current ≤ hardStop`):current 已破硬止损,thesis 已死 → SELL_NOW。
>
> 第二轮及以后,AI 才开始用持仓期数据做完整的主观综合判断,可以从默认方向切换到反方向(例如观察区从走止盈切到走解套,或警戒区从保守切到激进)。**首次特殊处理只影响首个 SELL_LIMIT 价格,不锁死后续行为。**

### 边界 4:健康区 / 观察区(走止盈),入场价上方没有未被突破的关键点位(突破新高场景)

R1 / R2 候选池为空。两种 root cause(处理方式相同):
- **真正的新高入场**:entry 上方原本就没有静态/动态候选(罕见,入场点本身就在高位附近)
- **顺势突破**:entry 上方原有候选,但全部已被 current 突破(健康区涨势中常见)

**处理**:
- 看 BUY_STRATEGY.md 边界情况一样的处理:看图给保守估计
- reasoning 注明 "new high, no overhead structure, conservative target estimate"

### 边界 5:警戒区,候选池意外为空(defensive bug 场景,理论上不应发生)

**理论上不可能发生的状态**: 警戒区保守模式的候选 = `(current, softStop]` 内的关键点位。按定义,警戒区满足 `current ≤ softStop`,所以 `fixed_soft_stop` 这个数字本身就**永远**落在 `(current, softStop]` 范围内(等号端点),候选池**最少有一个候选**(fixed_soft_stop)。

**什么时候会"意外为空"?** 只可能是 state 数据损坏:
- `virtualPosition.stopLossPrice` 因 bug 变成 null
- 区间分类用了错的 softStop / hardStop 值,导致实际不在警戒区却被分类成警戒区
- 其他 state migration / 并发问题

**defensive 处理**(避免崩溃):
- 检测到候选池为空 → reasoning 显式标注 "defensive: warning-zone candidate pool empty, state may be corrupted"
- 兜底挂 `entry + $0.05`,anchorSource = `conservative_estimate`
- 后台日志记录,便于事后排查 state 问题

### 边界 6:用户长时间挂着,价格在观察区 / 警戒区震荡,最后被 force_exit 强卖

接受这个风险——这是 cascade 行情中无法避免的成本,但比"破软止损就立刻卖"的累计成本更低。

### 边界 7:频繁跨区切换导致 SELL_LIMIT 短时间内多次替换

**场景**: 价格在观察区 / 警戒区边界(`softStop` 附近)震荡(假设入场后形成了 intraday_pivot 在 $27.35):
- 轮 1: current = $27.10(观察区,AI 主观判走解套——证据不清晰)→ 候选 `(current, entry+$0.05]` 内有 intraday_pivot=$27.35 → SELL_LIMIT @ $27.35
- 轮 2: current = $26.98(警戒区,AI 主观判保守——距 softStop 仅 $0.02 但量能弱)→ SELL_LIMIT 切到 `fixed_soft_stop = $27.00`,UI 信号变化 warning
- 轮 3: current = $27.05(回到观察区,AI 仍判走解套)→ intraday_pivot=$27.35 又是候选,SELL_LIMIT 切回 $27.35,又一次 warning
- 轮 4: current = $26.95(又回警戒区,AI 这次量能突然放大判激进)→ SELL_LIMIT 切到 `entry+$0.05 = $27.55`,再一次 warning

**这是预期行为,不是 bug**:
- 每轮独立判断 + trail by levels 是核心设计
- "信号变化 warning 频繁触发"在边界震荡时不可避免
- 用户应理解这是市场波动的正常反映,不是策略不稳定

### 边界 8:健康区 R1/R2 / 观察区流程 / 警戒区 target 在临界证据反复切换

**场景 A(健康区 trend=normal↔strong → R1↔R2)**: AI 主观判断的强弱证据在边界附近反复:
- 轮 N: 3 阳 + 收盘 strictly 抬高 + 放量 → 证据够强 → trend=strong → R2
- 轮 N+1: 出现一根缩量阴线,多维证据不再一致 → 退回 trend=normal → R1
- 轮 N+2: 又连续放量上行 → trend=strong → 回 R2

**场景 B(观察区 走止盈↔走解套)**: 主观判断的证据组合在边界附近反复:
- 轮 N: K 线/EMA/VWAP/量能 4 项指向反弹 → AI 走止盈
- 轮 N+1: 量能减弱、VWAP 被压回 → 证据不一致 → AI 默认走解套
- 轮 N+2: 量能再次扩张 + 站上 EMA20 → AI 又走止盈

**场景 C(警戒区 保守↔激进)**: 同观察区机制:
- 轮 N: 量能放大 + 反弹接近 reclaim softStop → AI 激进 → SELL_LIMIT @ entry+0.05
- 轮 N+1: 反弹未守住,量能转弱 → AI 保守 → SELL_LIMIT 切回 softStop
- 轮 N+2: 又反弹强势 → AI 再激进 → SELL_LIMIT 又上去

**三种场景都是预期行为**:
- 不加防抖(如"连续 N 轮判定相同才切换")
- 防抖会增加状态机复杂度,且每轮独立判断是核心
- 信号变化 warning 在临界场景轮换是正常的,reasoning 会清楚说明依据
- 长期来看流程 / 区间切换的成本主要是用户在券商替换挂单的精力,不是策略 EV 损失

---

## 不做的事(规避 scope creep)

| 不做 | 原因 |
|------|------|
| 不做加仓 / 摊薄成本 | Martingale 陷阱;架构上单仓假设;v1 不引入 |
| 软止损 / 硬止损不 trail | 是"入场承诺",不动态调整 |
| **不**允许 R3+(健康区强劲走势也只到 R2) | R3+ 距离入场太远,成交概率剧降,长期 EV 不见得正 |
| 不分关键点位强 / 中 / 弱 | 同买入策略,全部平等 |
| 不要求"破支撑确认"成交量 | 价格触及就触及,不等 confirmation(信号会迟) |
| 不引入用户参数(`quickProfitDelta` 等已经全删) | 主观选择不参与 AI 决策 |
| 观察区 + 警戒区允许 AI 主观综合判断,但约束 reasoning 必须列 ≥2 条数字证据;不确定时默认保守 | 单纯机械规则丢失大量信号(量能/EMA/VWAP/Market Context);完全自由主观会重蹈 confidence 字段覆辙——所以是「带约束的试验」,效果差就回退机械规则 |
| 警戒区**不**押反弹回到浮盈,即使激进 target 也只到 entry+$0.05 | 既已破软止损,押反弹到 entry 上方在 EV 上不划算——失败成本高(可能破 hardStop),成功收益不对称 |

---

## 实操例子

### 例 1:典型成功路径(健康区止盈)

**入场**: BUY_LIMIT @ EMA20 = $27.50 成交

**首次卖出分析(Limit filled 触发)**:
- entryPrice = $27.50,currentPrice = $27.50,关键点位:
  - 上方: `prior_high @ $28.20`(最近)、`EMA200 @ $30.50`
  - 下方: `EMA50 @ $27.00`(软止损候选)、`prior_low @ $26.30`(硬止损候选)、`EMA100 @ $25.20`
- 输出:
  ```json
  {
    "action": "SELL_LIMIT",
    "orderPrice": "28.20",
    "anchorSource": "prior_high",
    "stopLossPrice": "27.00",
    "hardStopPrice": "26.30",
    "reasoning": "current=27.50, entry=27.50 → zone=healthy; first-exit forces trend=normal (no post-entry bars yet); target=R1=28.20@prior_high; softStop=27.00@EMA50, hardStop=26.30@prior_low"
  }
  ```

**之后**: 价格反弹到 $28.20,SELL_LIMIT 成交。✓

### 例 2:观察区 → 走止盈(押反弹回到浮盈)

**入场**: BUY_LIMIT @ $27.50 成交,softStop $27.00,hardStop $26.30

**几轮之后**: 价格跌到 $27.20,在 softStop 上方 → **观察区**

**该轮分析(AI 主观综合判断)**:
- 证据 checklist 扫描:
  - K 线: 过去 3 根 5 分钟 K 线最低点 $27.15 → $27.18 → $27.20(rising)
  - EMA: current $27.20 站上 EMA20 = $27.10(reclaim)
  - VWAP: current 刚从 VWAP = $27.15 下方站回上方
  - 量能: 反弹根 K 线量能比之前下跌根扩张约 30%
  - 距 softStop: $27.20 - $27.00 = $0.20,缓冲较厚
- AI 综合判定 → **走止盈**(多条证据一致指向反弹)
- R1 = 入场上方第一个未被突破:`prior_high @ $28.20`
- 输出:
  ```json
  {
    "action": "SELL_LIMIT",
    "orderPrice": "28.20",
    "anchorSource": "prior_high",
    "reasoning": "current=27.20, softStop=27.00, hardStop=26.30, entry=27.50 → zone=observation; flow=push-rebound (evidence: (1) 3-bar lows 27.15→27.18→27.20 rising; (2) reclaimed EMA20=27.10 and VWAP=27.15 with ~30% volume expansion); target=R1=28.20@prior_high"
  }
  ```

### 例 3:观察区 → 走解套(认怂、求平本)

**入场**: BUY_LIMIT @ $27.50,softStop $27.00,hardStop $26.30

**几轮之后**: 价格跌到 $27.15(观察区),过去 3 根 K 线最高点 $27.40 → $27.30 → $27.20(逐步降低)

**该轮分析(AI 主观综合判断)**:
- 证据 checklist 扫描:
  - K 线: 过去 3 根 K 线最高点 $27.40 → $27.30 → $27.20(逐步降低,阴线为主)
  - EMA: current $27.15 < EMA20 = $27.30(被压制)
  - VWAP: current 在 VWAP = $27.25 下方,已 reject 两次
  - 量能: 下跌根放量,反弹根缩量
  - 距 softStop: $27.15 - $27.00 = $0.15(很近)
- AI 综合判定 → **走解套**(证据偏空 + 距 softStop 近,反弹押注 EV 差)
- 走解套 target 候选筛选(`(current, entry+$0.05]` = `($27.15, $27.55]`):
  - **默认**: 兜底 `entry+$0.05 = $27.55`
  - **例外检查**: 入场后是否有新候选漂入此范围?
    - 假设 `EMA20` 在入场后从原位置漂到了 `$27.30`(动态点位漂入 `($27.15, $27.55]` 范围)
    - `prior_high @ $28.20` 超出范围,排除
  - **本例触发例外**: 选 EMA20 = $27.30 (最接近 current)
- 输出:
  ```json
  {
    "action": "SELL_LIMIT",
    "orderPrice": "27.30",
    "anchorSource": "EMA20",
    "reasoning": "current=27.15, softStop=27.00, hardStop=26.30, entry=27.50 → zone=observation; flow=recovery (current below EMA20=27.30 and VWAP=27.25 with bearish 3-bar highs and only 0.15 above softStop); target=27.30@EMA20 (exception: dynamic level drifted into (current, entry+0.05] range; default would be entry+0.05=27.55)"
  }
  ```

### 例 4a:警戒区 保守 target(默认场景,反弹证据弱)

**入场**: BUY_LIMIT @ $27.50,softStop $27.00(锚源当时 EMA50),hardStop $26.30

**几轮之后**: 价格跌到 $26.50(警戒区,**距 hardStop 仅 $0.20**,深度受压)

**该轮分析(AI 主观综合判断)**:
- $26.50 < $27.00(softStop)→ 警戒区
- $26.50 > $26.30(hardStop)→ 不触发 SELL_NOW
- 证据 checklist 扫描:
  - K 线形态: 过去 3 根 K 线最高点 $26.70 → $26.60 → $26.55(逐步降低,以阴线为主)
  - 量能: 反弹根缩量,下跌根放量
  - 均线关系: current $26.50 远低于 EMA20 = $26.40(EMA20 已被下行价格拖到 current 下方,不构成阻力)
  - VWAP: current 在 VWAP = $26.45 下方,无 reclaim 迹象
  - 距 hardStop: 仅 $0.20,安全垫薄
  - 距 softStop: $0.50,反弹回到 softStop 需要大幅度推升
- AI 综合判定 → **保守 target**(证据偏空 + 距 hardStop 近)
- 保守模式候选筛选:`($26.50, $27.00]` 范围内:
  - EMA20 = $26.40:在 current 下方,排除
  - VWAP = $26.45:在 current 下方,排除
  - **fixed_soft_stop = $27.00:在范围内,唯一候选**
- 输出:
  ```json
  {
    "action": "SELL_LIMIT",
    "orderPrice": "27.00",
    "anchorSource": "fixed_soft_stop",
    "reasoning": "current=26.50, softStop=27.00, hardStop=26.30, entry=27.50 → zone=caution; target=conservative=27.00@fixed_soft_stop (evidence weak: 3-bar lower highs, EMA20=26.40 and VWAP=26.45 both below current, only 0.20 above hardStop)"
  }
  ```

**之后**: 价格反弹到 $27.00,SELL_LIMIT 成交。**亏 $0.50/股**(避开了距 hardStop 太近 + cascade 风险)。✓

### 例 4b:警戒区 激进 target(反弹证据强,争取近平本)

**入场**: 同上,softStop $27.00,hardStop $26.30

**几轮之后**: 价格跌到 $26.95(**已经非常接近 softStop**,反弹动能强),`fixed_soft_stop` 仍是 $27.00

**该轮分析(AI 主观综合判断)**:
- $26.95 < $27.00(softStop)→ 警戒区(刚好在边界下方)
- $26.95 > $26.30(hardStop)→ 不触发 SELL_NOW
- 证据 checklist 扫描:
  - 反弹力度: 过去 3 根 K 线 2 阳 1 阴,最低点 $26.55 → $26.78 → $26.95(strictly 抬高)
  - 量能: 反弹根成交量是之前下跌根的 1.8 倍(放量)
  - EMA: current $26.95 刚 reclaim EMA20 = $26.92
  - VWAP: current 站上 VWAP = $26.90
  - 距 hardStop: $0.65,安全垫厚
  - 距 softStop: 仅 $0.05,接近 reclaim
- AI 综合判定 → **激进 target**(多条证据指向强反弹 + 距 hardStop 安全垫厚 + 接近 reclaim softStop)
- 激进模式 target = `entry + $0.05 = $27.55`
- 输出:
  ```json
  {
    "action": "SELL_LIMIT",
    "orderPrice": "27.55",
    "anchorSource": "aggressive_recovery",
    "reasoning": "current=26.95, softStop=27.00, hardStop=26.30, entry=27.50 → zone=caution; target=aggressive=27.55@aggressive_recovery (evidence: (1) 3-bar lows 26.55→26.78→26.95 rising; (2) reclaimed EMA20=26.92 and VWAP=26.90 with 1.8× volume; only 0.05 below softStop, 0.65 above hardStop)"
  }
  ```

**之后两种可能**:
- 反弹强势继续,价格冲到 $27.55 → SELL_LIMIT 成交 → **近平本出场,亏 $0/-$0.05/股** ✓
- 反弹失败,价格回落破 hardStop → SELL_NOW 亏 $1.20+/股(尾部风险,无法避免)

### 例 5:必须离场(硬止损被破)

**入场**: 同上,softStop $27.00,hardStop $26.30

**几轮之后**: 价格跌到 $26.10

**该轮分析**:
- $26.10 < $26.30(硬止损)→ 触发 SELL_NOW
- 下一更深支撑(reasoning 报告): `EMA100 @ $25.20`
- 输出:
  ```json
  {
    "action": "SELL_NOW",
    "orderPrice": null,
    "anchorSource": "stop_broken",
    "reasoning": "current=26.10, softStop=27.00, hardStop=26.30, entry=27.50 → zone=hard-exit; hard stop broken; next deep support=25.20@EMA100 (info only); exit immediately"
  }
  ```

**之后**: 用户在券商市价卖 @ $26.05 → 亏损 $1.45/股。**有上限的亏损,不会变成 $5、$10 的灾难。** ✓

### 例 6:trail up by levels(健康区涨升,普通走势)

**入场**: $27.50,SELL_LIMIT 初始挂在 `prior_high = $28.20`

**几轮之后**: 价格突破 $28.20 涨到 $28.40 → 仍在健康区,K 线非"3 阳 + strictly 抬高"形态(走势普通)

**该轮分析**:
- $28.40 > entry,健康区,走势普通 → 选 R1
- 入场上方未被突破候选(过滤掉 ≤ $28.40 的):`gap @ $29.00`(新 R1)、`EMA200 @ $30.50`(新 R2)
- 输出 `SELL_LIMIT @ $29.00`,anchorSource = "gap"
- reasoning: `current=28.40, softStop=27.00, hardStop=26.30, entry=27.50 → zone=healthy; trend=normal (3-bar pattern not strictly rising); prior R1=prior_high=28.20 broken; new R1=29.00@gap (R2=30.50@EMA200 not chosen)`

UI 显示信号变化 warning,用户在券商替换卖单。

### 例 7:健康区强劲走势 → R2

**入场**: $27.50,几轮之后价格涨到 $28.30(健康区)

**该轮分析**:
- 过去 3 根 5 分钟 K 线:全是阳线,收盘价 `$28.10 → $28.20 → $28.30`(strictly 抬高)→ **强劲走势**
- 入场上方未被突破候选(过滤掉 ≤ $28.30):`prior_high @ $28.50`(R1)、`gap @ $29.00`(R2)、`EMA200 @ $30.50`
- 强劲走势 → 选 R2 = `gap @ $29.00`
- 输出:
  ```json
  {
    "action": "SELL_LIMIT",
    "orderPrice": "29.00",
    "anchorSource": "gap",
    "reasoning": "current=28.30, softStop=27.00, hardStop=26.30, entry=27.50 → zone=healthy; trend=strong (3 green bars, closes 28.10→28.20→28.30 strictly higher); target=R2=29.00@gap (skip R1=28.50@prior_high)"
  }
  ```

**之后两种可能**:
- (a) 价格回踩 K 线形态变弱 → 下一轮回到普通 → R1 = $28.50 → SELL_LIMIT 替换
- (b) 价格继续 strictly 抬高 → 强劲持续 → R2 不变 → SELL_LIMIT 维持
- (c) 价格突破 R1 ($28.50) → R1/R2 重编号(新 R1=$29.00, 新 R2=$30.50)→ AI 又在新 R1/R2 间选

### 例 8:强制收盘(force_exit)

**当前状态**: 健康区,SELL_LIMIT 挂在 $29.00,currentPrice = $28.60

**到 15:50 ET**: `isNearUsMarketClose()` → true,background.js 切到 `mode=force_exit`

**该轮分析(AI 看到 mode=force_exit)**:
- schema 锁死 action = SELL_NOW
- 输出:
  ```json
  {
    "action": "SELL_NOW",
    "orderPrice": null,
    "anchorSource": "force_exit",
    "reasoning": "mode=force_exit (≤10 min to 16:00 ET); zone judgment skipped; day-trade discipline, no overnight"
  }
  ```

**之后**: 用户在券商市价卖,即使刚才还浮盈 $1.10/股。日内交易铁律,不留隔夜。

---

## 与买入策略的边界(再次明确)

| 决策 | 属于 | 触发时机 |
|------|------|---------|
| BUY_LIMIT 价格 / anchorSource | **买入策略** | 每轮入场分析 |
| **stopLossPrice (软止损)** | **卖出策略** | **首次卖出分析(Limit filled / 已持仓声明 触发)** |
| **hardStopPrice (硬止损)** | **卖出策略** | **首次卖出分析** |
| SELL_LIMIT 价格 / anchorSource | **卖出策略** | 每轮 exit 分析(含首次) |
| 观察区"走止盈 / 走解套"判断 | **卖出策略** | 每轮 exit 分析(非首次) |
| 警戒区"保守 / 激进 target"判断 | **卖出策略** | 每轮 exit 分析(非首次) |
| 健康区"普通 / 强劲走势"判断 | **卖出策略** | 每轮 exit 分析(非首次) |
| SELL_NOW 触发 | **卖出策略** | 每轮 exit 分析 |
| 加仓 / 摊薄成本 | **不做(v1)** | — |

**Buy / sell 在 Limit filled 那一刻完全切换**——买入策略不预判止损止盈;卖出策略也不参与挑选买点。两个文档的逻辑互不重叠。

---

## v18 已落实的部分

以下在 STATE_VERSION 18 已经实现,**本次更新不重写**:
- `virtualPosition.hardStopPrice` 字段
- 首次卖出分析的 2-step `markBought` 流程
- `confirmMarketContextAndStart` 在 `initialPositionMode === "holding"` 时也跑首次分析
- 四个 mode-aware schema (`entry` / `first_exit` / `exit` / `force_exit`)
- 止损锚定在 `entryPrice` 上(非 `currentPrice`)
- UI: position summary 显示 softStop / hardStop / entryAnchor / zone label
- "recovery" SELL_LIMIT intent + i18n keys (`减亏限价卖单` / `Reduce-Loss Limit`)
- migration v18 给老 `virtualPosition` 补 `hardStopPrice: null`

## 本次更新需要落实的代码改动(等审核确认后统一执行)

### 1. 关键点位池加入"盘中静态点位" + "固定止损"
- `chartFocusAreas` (prompt-config.js) 显式列出 `今日 HOD/LOD`、`开盘 15 分钟区间高低 ORH/ORL`、`intraday_pivot`
- `exitModeRules` 显式说明候选池**还包含**固定的 `softStop` / `hardStop` 数字(从 `virtualPosition` 直接读),作为独立候选(和漂移后的动态锚当前值并存)
- AI 在每轮分析时把所有来源的点位一起当作平等候选
- **anchorSource enum 扩展**(schema 变更):
  - 新增 `intraday_high` / `intraday_low` / `opening_range_high` / `opening_range_low` / `intraday_pivot`(盘中静态)
  - 新增 `fixed_soft_stop` / `fixed_hard_stop`(持仓期专有,只能在**首次卖出分析之后**的 exit 轮次出现)
  - 新增 `aggressive_recovery`(警戒区激进 target 专用)
- validator 加约束:
  - `fixed_soft_stop` / `fixed_hard_stop` 只允许在**首次卖出分析之后**的 exit 模式出现;entry 模式 + first_exit 模式都拒绝
  - `aggressive_recovery` 只允许在警戒区(`hardStop < current ≤ softStop`)的 exit 分析中出现;其他区检测到 → 拒绝;警戒区检测到但 reasoning 不含 ≥2 数字证据 → 强制改回 `fixed_soft_stop`

### 2. 四区间状态机替换三区间
- `exitModeRules` (prompt-config.js) 重写为 4 区分支
- 区间归属判断的语言改成显式参考 `entryPrice` 和 `softStop` / `hardStop`

### 3. 观察区 AI 主观判断(带证据约束)
- `exitModeRules` 新增观察区段落:讲清楚证据 checklist(7 维度) + 默认走解套 + 走止盈的 reasoning 必须列 ≥2 条数字证据 + 短期/中期冲突时默认保守
- reasoning 必须标注:当前区间 + (观察区) 走哪个流程及依据(具体 observable evidence,不允许模糊形容词)
- validator 检查走止盈 reasoning:
  - 必须包含至少 2 个**独立的数值参照**(完整定义见 SELL_STRATEGY.md「reasoning 强制格式 / 约束 3」节)——区间判断链 `current=X, softStop=Y, ...` 不计入
  - 模糊词黑名单:`looks like / feels / seems / should / probably / likely / momentum / bullish / bearish / strong / weak`(裸用拒绝;紧跟数字证据允许)
- **validator 强制改写(不达标时)涉及 4 步重写,工作量比 prompt 改动大**:
  1. `action` 不变(仍 SELL_LIMIT)
  2. `orderPrice` **重新计算**走解套的默认 target(`entry+$0.05` 或例外候选)
  3. `anchorSource` **重新选**(默认改 `conservative_estimate`,例外改对应锚名)
  4. `reasoning` **重写**(标注 "validator forced fallback to recovery flow: original push-rebound reasoning failed [reason]")
- 走解套不需要额外 reasoning 约束(默认动作)
- **R1 不存在时**: 即使 AI 输出 push-rebound,validator 也强制 fallback 到走解套(无 R1 = 无锚,押反弹无意义)

### 3.5 健康区 R1 / R2 + AI 走势判断逻辑(本次更新核心策略变更)
- `exitModeRules` 新增健康区段落:讲清楚候选池构建 (`entryPrice` 上方 + 过滤已突破) + R1/R2 编号
- 显式列出强劲走势触发判据(3 根连续阳线 + 收盘 strictly 抬高)
- 强劲 → R2,其他情况 → R1;明确不允许 R3+
- R1 距 current 几个 tick 以内时挂略高 R1
- 强劲但 R2 不存在时退回 R1,reasoning 标注 "no R2 available"
- reasoning 必须标注:R1/R2 选择依据(强劲/普通) + 当前 R1/R2 的具体价格和 anchorSource

### 4. 解套目标的 $0.05 上限
- 观察区(走解套时)和警戒区(激进模式 + 保守模式 fallback)**都**适用
- prompt 里写死 `0.05` 数字,不暴露为可配置参数
- validator 加 sanity check:解套场景 SELL_LIMIT ≤ entryPrice + 0.05(留 1 个 tick 容差)

### 4.5 警戒区 AI 主观判断(本次更新追加的对称设计)
- `exitModeRules` 新增警戒区段落:讲清楚证据 checklist(7 维度,与观察区对称) + 默认保守 + 激进的 reasoning 必须列 ≥2 条数字证据 + 短期/中期冲突时默认保守
- 双 target 定义:保守 = softStop(或更近的盘中/漂移点位),anchorSource = `fixed_soft_stop` / 对应锚名;激进 = entry+$0.05,anchorSource = **`aggressive_recovery`**(v19 新增专用 enum,严禁用 `conservative_estimate`)
- 区别于观察区:警戒区两个 target 都是"解套",最高不超过 entry+$0.05;观察区走止盈可以挂到 R1(entry 之上)
- 距 hardStop:警戒区维度 5,越远越敢激进(越近越保守)
- 距 softStop:警戒区维度 6,语义与观察区反向——current 越接近 softStop 越倾向激进
- validator 同观察区:激进 target reasoning 必须含 ≥2 个独立数值参照,模糊词黑名单同观察区
- **validator 强制改回保守(不达标时)同观察区,涉及 4 步重写**:
  1. `action` 不变
  2. `orderPrice` 重新算为 fixed_soft_stop(或更近的候选)
  3. `anchorSource` 改为 `fixed_soft_stop`(或对应锚名)
  4. `reasoning` 重写,标注 "validator forced fallback to conservative target: [reason]"
- 走保守不需要额外 reasoning 约束(默认动作)

### 5. 必须离场的"下一深支撑"提示
- `exitModeRules` 必须离场段落要求 reasoning 提及下一更深关键点位
- 不改 action,纯信息

### 6. 区间命名 + UI 标签更新
- i18n key 完整映射表:

  | v18 旧 key | v19 新 key | 说明 |
  |-----------|-----------|------|
  | `zoneTakeProfit` | `zoneHealthy` | 健康区(语义换名,原义就是浮盈状态) |
  | (新增) | `zoneObservation` | 观察区(浮亏但止损都没破) |
  | `zoneRecovery` | `zoneCaution` | 警戒区(原 v18 "解套区",更名以突出已破软止损的警示性) |
  | `zoneHardExit` | `zoneHardExit` | 保留 |
  | `zoneStopsNotSet` | `zoneStopsNotSet` | 保留 |

- `computeZoneLabel` (sidepanel.js) 对应改成 4 分支判断
- recommendation 卡片在观察区显式展示 AI 判断的流程(走止盈 / 走解套);警戒区显式展示 AI 判断的 target 模式(保守 / 激进);健康区显式展示走势(普通 / 强劲)以及当前 R1 / R2 价格
- "recovery" SELL_LIMIT intent 现在覆盖观察区(走解套)+ 警戒区(保守 + 激进)三种场景,标签复用(`减亏限价卖单` / `Reduce-Loss Limit`)
- 新增 UI label(en + zh):
  - `flowPushRebound` / `flowRecovery` — 观察区流程
  - `targetConservative` / `targetAggressive` — 警戒区 target 模式
  - `trendNormal` / `trendStrong` — 健康区走势判断
  - `levelR1Label` / `levelR2Label` — 健康区当前 R1 / R2 价格显示

### 7. reasoning 强制格式 + validator 交叉检查
- `exitModeRules` 显式要求 reasoning 必须包含区间判断链 (current/softStop/hardStop/entry → zone)
- 健康区追加 trend + R1/R2 选择依据
- 观察区追加 flow + 3-bar pattern 依据
- 警戒区追加 target + entry+$0.05 cap
- 必须离场追加 next deep support
- 上限保持 120 字,但区间判断链不可省略
- **validator 必须做的 sanity check 列表**:
  - reasoning 必须包含 `zone=` 字串(防止 AI 偷懒省略)
  - reasoning 里写的 `target=<price>@<anchor>` 中的 `<price>` **必须等于** `orderPrice` 字段(交叉检查 1)
  - reasoning 里写的 `target=<price>@<anchor>` 中的 `<anchor>` **必须等于** `anchorSource` 字段(交叉检查 2)
  - SELL_NOW 时 reasoning 不应有 `target=` 字串,改为 `next deep support=` 或 `mode=force_exit`

### 8. STATE_VERSION + migration(v18 → v19)
- **STATE_VERSION 升到 19**(从 18)。即使 state shape 没改,语义版本变化(zone 名重命名、anchorSource enum 扩展、recovery intent 扩展覆盖三种场景)需要新版本号触发 migration 钩子。
- **migration v18 → v19 实际工作**: **no-op**(纯版本号变更,不需数据迁移)
  - **zone 名称是 render-time 计算的**(`sidepanel.js::computeZoneLabel` 每次根据 currentPrice + entryPrice + stops 重算),**从不存储**在 state 里。所以 `zoneTakeProfit → zoneHealthy` 重命名只影响 i18n 字典 + sidepanel UI 调用点,无需迁移 state。
  - **anchorSource enum 扩展是 additive**,老 state 里的旧 enum 值(`EMA20`, `prior_high`, `conservative_estimate` 等)在新 enum 集合里仍合法,无需 rewrite。
  - **recovery intent 扩展不影响存储格式**,逻辑改动只在 `getSellLimitIntentFromPrices`。
  - **virtualPosition.hardStopPrice 等结构字段在 v18 已就位**,v19 不动 state shape。
- **测试**: `storage.test.js` 加 v19 migration 用例,验证 v18 state 字段在 v19 下完全保留(`virtualPosition.entryPrice / stopLossPrice / hardStopPrice / entryAnchorSource` + `lastResult.analysis.anchorSource` + `tradeHistory[].entryAnchorSource`)。

### 9. 测试
- `llm.test.js`: 观察区主观判断测试
  - 走止盈 reasoning 含 ≥2 个数字 → 通过
  - 走止盈 reasoning 缺数字 → validator 强制改写为走解套
  - 走止盈 reasoning 含模糊词(looks/feels/seems 等)无数字支撑 → validator 强制改写为走解套
  - 任何走解套都通过(默认动作不重论证)
- `llm.test.js`: 警戒区主观判断测试(与观察区对称)
  - 激进 target reasoning 含 ≥2 个数字 → 通过,SELL_LIMIT @ entry+0.05
  - 激进 reasoning 缺数字 → validator 强制改回保守 target(softStop)
  - 激进 reasoning 含模糊词无数字支撑 → validator 强制改回保守 target
  - 任何保守 target 都通过
  - 首次卖出分析在警戒区 → 强制保守(不允许激进,即使 reasoning 有数字)
- `llm.test.js`: 健康区 R1 / R2 判据测试(strictly 抬高 + 3 阳 → R2;持平 → R1;只有 R1 → 退回 R1)
- `llm.test.js`: 警戒区 $0.05 cap 测试
- `llm.test.js`: 观察区 + 警戒区目标价边界(`current` 和 `entry` 之间无关键点位 → entry+0.05)
- `llm.test.js`: 必须离场 reasoning 包含下一深支撑(hardStop 下方最近)
- `llm.test.js`: 首次卖出分析观察区强制**走止盈挂 R1**(不做主观判断;避免 fresh-fill 卖飞)
- `llm.test.js`: 首次卖出分析观察区 R1 不存在 → 强制 fallback 走解套(挂 entry+$0.05)
- `llm.test.js`: 首次卖出分析警戒区强制保守 target(不做主观判断)
- `llm.test.js`: reasoning 强制格式(包含 "zone=" + 子判断依据 + target=<price>@<anchor> 与字段一致的交叉检查)
- `llm.test.js`: 三分连续性 zone-aware 测试——`(healthy, prior_high, $28.20)` ≠ `(observation, prior_high, $28.20)`,跨区共享 anchor 不应判为"重复"
- `llm.test.js`: `aggressive_recovery` enum 约束测试
  - 警戒区 AI 输出 `aggressive_recovery` + reasoning ≥2 数字证据 → 通过
  - 警戒区 AI 输出 `aggressive_recovery` + reasoning 不满足证据约束 → validator 强制改为 `fixed_soft_stop`
  - 非警戒区(健康/观察/必须离场) AI 输出 `aggressive_recovery` → 验证拒绝
  - 警戒区激进 AI 错误地输出 `conservative_estimate`(应该用 `aggressive_recovery`)→ validator 拒绝或强制改写
- `storage.test.js`: v18 → v19 migration——`zoneTakeProfit` 映射为 `zoneHealthy`、其他三个 zone 名保持不变

---

## 未来工作(明确不在 v1)

| 功能 | 为什么不在 v1 |
|------|------|
| 加仓 / 摊薄成本 | 经典 Martingale 陷阱;架构上单仓假设;先实测纯卖出策略一段时间评估效果 |
| 软止损 trailing(随价上涨上移) | 实测下来如果觉得"承诺不变"过于保守,可以再加 |
| **健康区主观判断回退到机械 3 阳条件** | 健康区 trend=normal/strong 改成 AI 主观是本轮新增的试验。如果运行 30-50 笔健康区平仓后,trend=strong(R2)胜率 < trend=normal(R1) + P&L 没显著优势,则回退到机械硬条件(过去 3 根连续阳线 + 收盘 strictly 抬高 → R2,否则 R1)。回退方案就是本轮之前的实现,路径已知 |
| **观察区主观判断回退到机械 K 线规则** | 主观判断是本版的试验性设计。如果运行 30-50 笔观察区平仓后,走止盈胜率 < 走解套,或两者 P&L 不显著区分,则回退到 v18 的机械规则(strictly higher lows → 走止盈,strictly lower highs / 持平 → 走解套)。回退方案已经在历史 git 里,不需要重新设计 |
| **警戒区主观判断回退到机械单 target(永远保守)** | 同上,警戒区也是本版试验。如果运行 30-50 笔警戒区平仓后,激进 target 胜率 < 保守 + 没有显著 P&L 改善,则回退到「永远 SELL_LIMIT @ softStop」的机械规则。已实测 v19 之前的版本就是单 target,fallback 路径已知 |
| 多区间 SELL_LIMIT 同时挂(分批止盈) | 单仓假设;先确认基础策略后再说 |
| `$0.05` 改成可配置 / 按 % | 一旦暴露参数就是用户参数路径,违反"主观选择不参与 AI 决策"原则;实测一段时间确认 $0.05 普遍适用即可 |

这些都是"实测后才决定要不要做"的功能。**v1 先把简单清晰的双止损 + 四区间 + 观察区 K 线判据跑起来,采集数据。**
