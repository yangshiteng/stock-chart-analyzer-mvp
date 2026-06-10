# 买入策略 (Buy Strategy)

> **范围声明**:本文档仅描述**入场决策**——回答"要不要挂单、挂在哪里"。止盈、止损、出场逻辑属于**卖出策略**(`SELL_STRATEGY.md`,待写),不在本文档讨论。

---

## 核心理念

**关键点位是入场触发器。** 在当前价**下方**找到最合适的关键点位,预先挂 `BUY_LIMIT`,让市场把价格送下来填单。没有 WAIT、没有确认信号、没有"等企稳"——限价单挂在远处不会成交也不亏钱,挂错了顶多就是没成交而已。

**两个关键设计**:

1. **S1 / S2 二选一 + AI 主观综合判断(带证据约束)**: 收集所有"低于现价的关键点位",按距离 current 从近到远排序成 `S1, S2, S3, ...`。AI 在 `S1` (保守) / `S2` (激进) 之间二选一,**S3+ 完全禁止**。默认保守(挂 S1),AI 看到证据支持深回踩才升级到激进(挂 S2)。**带三条结构约束**:
   - 不确定 = 默认保守(挂 S1)
   - 激进选项必须列 ≥2 条数字证据
   - validator 拒绝模糊词
   
   这是 sell strategy 浮亏区(观察区/警戒区)主观判断设计的镜像。买入也允许主观因为入场前 K 线/EMA/VWAP/量能/大盘信号确实丰富,机械"永远 S1"会丢失"明显该等深回踩"的信号。但要避免重蹈 confidence 字段覆辙,主观必须配证据约束。
2. **永远输出 BUY_LIMIT**:即使最近支撑距离 -10%,也照样挂;即使关键点位看起来"弱",也照样挂——用户在券商端是 gatekeeper,他读 reasoning 自己决定要不要真去挂单。插件这边的责任是"给出图形上最合理的候选",不是替用户做风险决策。

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

### 关键点位池(三个来源)

| 来源 | 内容 |
|------|------|
| **静态(Market Context)** | 上面 Scan 阶段提取的 `pivot` / `gap` / `prior_high` / `prior_low`(当日不变) |
| **动态(5 分钟图实时)** | 当前的 `EMA20` / `EMA50` / `EMA100` / `EMA200` / `VWAP` 数值(每轮重读) |
| **盘中静态(5 分钟图当日)** | `今日高 (HOD)` / `今日低 (LOD)` / `开盘 15 分钟区间高低 (ORH/ORL)` / `盘中明显的反复测试位 (intraday_pivot)`——逐渐形成 |

> 动态点位**每轮都重新读图**——EMA 和 VWAP 会随蜡烛更新而移动,这是预期行为。盘中静态点位**当日累积**——HOD/LOD 会随价格更新,intraday_pivot 在反复测试中形成。

> **持仓期专有的 `fixed_soft_stop` / `fixed_hard_stop` 不在买入候选池里**——那两个 enum 只在 sell strategy 持仓期(`virtualPosition` 存在时)出现,买入阶段(`virtualPosition === null`)不可用。

### anchorSource 字段定义

完整定义见 `SELL_STRATEGY.md` 的「`anchorSource` 字段定义」节(两个策略共享同一个字段,定义集中维护)。

**买入策略可用的 anchorSource enum 子集**:
- 静态: `pivot` / `gap` / `prior_high` / `prior_low`
- 动态: `EMA20` / `EMA50` / `EMA100` / `EMA200` / `VWAP`
- 盘中静态: `intraday_high` / `intraday_low` / `opening_range_high` / `opening_range_low` / `intraday_pivot`
- 兜底: `conservative_estimate`(无可用支撑时使用,见下方"边界情况")

**买入策略禁用的 anchorSource enum**:
- `fixed_soft_stop` / `fixed_hard_stop`(持仓期专有)
- `aggressive_recovery`(警戒区激进 target 专用,sell-side)
- `stop_broken` / `force_exit`(SELL_NOW 专用)

validator 应在 entry mode 拒绝这些 enum 值出现在 BUY_LIMIT 输出里。

### 分类规则

逐一比较每个关键点位 vs 当前价:

| 点位价格 vs 当前价 | 角色 |
|---|---|
| 严格 **< 当前价** | 当前的**支撑候选** |
| 严格 **> 当前价** | 当前的**压力候选** |
| 与当前价持平(罕见) | 既不算支撑也不算压力,本轮忽略 |

**入场只关心"支撑候选"这一组。** 压力候选这一轮先不管(那是卖出策略的事)。

---

## 第二步:S1 / S2 编号 + AI 主观判断保守 vs 激进

### S1 / S2 候选编号

收集第一步分出的所有支撑候选(低于 current 的关键点位),按距离 current **从近到远**排序,记为 `S1, S2, S3, ...`:
- `S1` = 距 current **最近**的支撑(默认保守目标)
- `S2` = 第二近的支撑(激进目标)
- `S3+` = 更远的支撑,**禁止**挂单(同 sell strategy 健康区设计原则:S3+ 距离过远,成交概率剧降,长期 EV 不见得正)

候选去重: 如果多个锚点价位几乎相同(差距 ≤ 1-2 个 tick),按 confluence 优先级规则合并为 1 个 S 项(详见"同一价位多个锚点时的优先级"节)。

### AI 判断:保守 vs 激进(主观综合判断,带证据约束)

买入是 4 个区间外**第三个**(continued from sell strategy 观察区/警戒区)允许 AI 主观综合判断的环节。机械"永远 S1"会丢失关键信号——比如大盘明显偏弱 + 5 分钟图反弹乏力时,深回踩到 S2 的概率显著高于反弹守 S1,这时挂 S1 的预期成交价反而比 S2 差。

#### 保守 vs 激进定义

| 模式 | target | 适用场景 | 兑现结果 |
|------|--------|---------|---------|
| **保守(默认)** | `S1`(最近支撑) | 默认;深回踩证据不清晰 / 偏多 / S1 vs S2 间距小 | 成交概率较高,成本中等 |
| **激进** | `S2`(次近支撑) | 深回踩证据清晰一致 + S1 vs S2 间距明显 | 成交概率较低,成本明显更好 |

#### 证据 checklist(AI 综合考虑的 7 个维度,与 sell 浮亏区对称)

判断保守 vs 激进时,AI 应综合下列**可观察证据**:

| # | 维度 | 在买入策略的解读 |
|---|------|----------------|
| 1 | **K 线形态** | 最近 3-5 根 5 分钟 K 线方向(连续阴/阳、最高/最低点 strictly 走向、收盘价相对开盘价) |
| 2 | **均线关系** | current 相对 EMA20/50 的位置、EMA 排列(多头/空头/纠缠)、EMA 斜率 |
| 3 | **VWAP** | current 相对 VWAP 的位置、最近是否有 reclaim / reject |
| 4 | **量能** | 当前 K 线量能扩张 / 萎缩;下跌根 vs 反弹根的量比 |
| 5 | **距 S1 的远近** | S1 越远 = 等小回调要等更久,押激进 S2 边际成本不大;S1 越近(贴脸) = 押激进的 ROI 更明显 |
| 6 | **S1 vs S2 间距** | 间距小 = 押激进 ROI 小,不值得;间距明显(例如 ≥ S1 距 current 的 1.5 倍) = 押激进收益显著 |
| 7 | **市场大势 (Market Context)** | 大盘 regime / 同行业方向 / 整体风险偏好 |

> **方向**: 与 sell 浮亏区**反向**——sell 浮亏区是"反弹证据强 → 升级到激进";买入是"**下跌证据强** → 升级到激进 S2"。理由对称:sell 浮亏区已浮亏,强反弹说明值得押更大反弹;买入还没买,深下跌信号说明值得等更深的 S2。

> **冲突时的决策原则**: 当短期形态(维度 1-4)和大盘/中期信号(维度 5-7)冲突时——比如「5 分钟反弹强」但「大盘 regime 下跌中」——**以更悲观的一方为准,走默认(保守 S1)**。理由:买入是零成本挂单,激进的好处只有在多方面证据一致时才显著大于"挂 S1 但市场反弹守住"的机会成本。

#### 三条结构约束(防止主观判断退化,与 sell 浮亏区相同)

**约束 1: 默认保守是硬规则**
> 如果证据**不构成清晰一致的深回踩信号**(指标互相打架、全部中性、或明显偏多),**必须**挂 S1。「不确定 = 保守」不可妥协。

**约束 2: 激进必须列 ≥2 条 observable evidence**
> 激进 target 时 reasoning 必须列出**至少 2 条具体证据**,每条带**数字或位置参照**。不允许 "looks weak" / "downtrend strong" / "expect deeper pullback" 这类形容词。
>
> 合规例子: `"mode=aggressive=S2 (evidence: (1) 5-min 3-bar lower highs 30.40→30.30→30.20 with red bars; (2) current=30.20 below all EMAs, S1=29.70 vs S2=28.80 spread=0.90 ≈ S1-distance 0.50 × 1.8)"`
>
> 违规例子: `"mode=aggressive (looks weak, expect deeper pullback)"`

**约束 3: validator 拒绝模糊证据**
> validator 检查激进 reasoning:必须包含**至少 2 个独立的数值参照**;不允许模糊词黑名单(同 sell strategy:`looks like / feels / seems / should / probably / likely / momentum / bullish / bearish / strong / weak`,裸用拒绝;紧跟具体数字证据允许)。不达标 → validator 强制改回 S1 (保守)。

#### 保守时的 reasoning 可以简短
> 默认动作不需要重论证。reasoning 只需简短说明判断结果(例如 `"mode=conservative (default: evidence not conclusive for deep pullback)"`)。

#### 监测指标(这个试验成败的判断依据)

等运行一段时间后(预计 30-50 笔成交样本),从 tradeHistory 里看:

| 指标 | 激进(挂 S2)应该 | 保守(挂 S1)应该 |
|------|----------------|------------------|
| 成交率 | 较低(等更深回踩) | 较高(小回踩就到) |
| 平均买入成本 | 应当显著优于保守(实际进价更低) | 标准成本 |
| 持仓后 P&L | 应显著优于保守(成本好则 P&L 上限高) | 标准 |
| 反例信号 | 如果激进成交率 < 保守 + P&L 没显著优势,**回退到机械永远 S1**(已有 v18 fallback) |

### 输出

```json
{
  "action": "BUY_LIMIT",
  "orderPrice": "<S1 或 S2 价格(可能加 placement 微调)>",
  "anchorSource": "<选定 R 的锚点来源>",
  "reasoning": "<≤120 字,见下方'reasoning 强制格式'节>"
}
```

### 关于"挂在支撑位"的微调(placement,与 S1/S2 选择**正交**)

AI 在选定锚点后(S1 或 S2,通过上面 AI 主观判断),可以根据**机械判据**微调具体落点 1-3 个 tick。这是机械判断,不进 AI 主观空间——所以最终 BUY_LIMIT 价格 = `S选择(主观) ± placement微调(机械)`,两层独立:

| 判据(K 线形态硬条件) | 微调 | 理由 |
|---|---|---|
| **强势上涨**:过去 5 根 5 分钟 K 线连续阳线 + 收盘 strictly 抬高 | 挂略高于支撑 1-3 个 tick | 强势中价格可能不真跌到支撑就反弹,挂略高提高成交概率(以略差成本换填单率) |
| **默认 / 无明显趋势** | 挂在支撑正价位 | 标准做法,等待回踩 |
| **明显下跌中**:过去 5 根 K 线连续阴线 + 收盘 strictly 降低 | 仍挂正价位(**不**挂深) | 假破支撑后续可能继续下探,挂深反而被套;但挂高就完全失去价值,所以正价位是平衡 |

> **「不挂深」是硬规则**: 即使下跌看起来要破支撑,也不挂低于支撑——理由是支撑被破后续可能继续下探到下一个关键位,挂在两者之间的"半空中"既不是真支撑也不是真低点,EV 差。如果 AI 看到强烈破支撑信号,正确做法是**等下一轮**:下一轮分类时,如果支撑被穿透,该锚点会自动从"支撑候选"变成"压力候选",AI 自然会切到更深的下一个支撑作为锚。

**reasoning 必须写清楚选了什么微调及依据**(包括"挂正价位"也要标"default placement, no strong/weak trend signal")。

### 同一价位多个锚点时(confluence)的优先级

如果两个或多个关键点位非常接近(差距 ≤ 一两个 tick):

**单一规则:静态优先于动态、盘中静态优先于动态**(即 anchorSource 取更"结构化"的那个)。

| 同位置候选 | anchorSource 选 | reasoning 标注 |
|---|---|---|
| EMA50 + prior_low(动态 + 静态) | `prior_low` | "confluence with EMA50" |
| VWAP + intraday_pivot(动态 + 盘中静态) | `intraday_pivot` | "confluence with VWAP" |
| pivot + prior_high(两个静态) | 选语义更具体的那个(看 reasoning) | "double static confluence: pivot + prior_high" |
| EMA20 + EMA50(两个动态) | 选距离 current 更近的;若相等选 EMA20(较小周期更敏感) | "EMA confluence" |

**理由**:静态点位是高时间框架结构,通常更稳;盘中静态点位是当日真实测试形成,有"市场已经验证过"的含义;动态点位会漂移,作为单独锚不如有静态背书的来得稳。

---

## 永远输出一个 BUY_LIMIT

**入场模式没有 WAIT。** 这是关键设计原则。

- 即使最近的支撑距离现价**很远**(例如 -10%),仍然挂在那里——限价单挂着不成交不亏钱
- 即使关键点位**很弱**——用户在券商端是守门人,他看到 reasoning 自己决定要不要真去挂

### 边界 1:当前价下方没有任何关键点位

罕见——通常意味着价格刚刚突破所有历史结构(全新高)且 EMA 群也都在 current 上方(EMA 在 current 上方 = 价格已经回到 EMA 群之下,但所有 EMA 又都在 current 上方,需要 current ≤ 所有 EMA 的极端情况)。

**处理:**
- AI 看 5 分钟图给一个保守估计的回踩位(例如最近一根大阳线的开盘价、或者跌幅一个 ATR 的位置)
- `anchorSource: "conservative_estimate"`
- reasoning 明确说明"暂无明确历史关键点位,使用 X 作为参考回踩位"

### 边界 2:远距离场景(orderPrice 比 current 低 > 5%)

例:current = $30,下方所有候选都在 $27 或更低。最近候选 = $27,距离 -10%。

**处理:**
- 仍然挂在 $27(永远输出 BUY_LIMIT 原则不变)
- reasoning 必须包含 `note: anchor far below current (~-X%), unlikely to fill but only meaningful support visible` 警告
- validator warning(不拒绝);后台日志记录,便于事后看远距离挂单的成交统计

### 边界 3:所有支撑候选都密集在很近(差距 ≤ 一两个 tick)

例:current = $30.00,VWAP = $29.70,EMA20 = $29.69(差 1 tick)。

**处理**: confluence 优先级规则启动(详见"同一价位多个锚点时的优先级"节)。anchorSource 选静态/盘中静态优先,reasoning 标 "confluence with [其他锚]"。

### 边界 4:当前价精准穿越某关键位(等于,既不算上方也不算下方)

罕见(美股最小 tick $0.01,精准持平概率极小)。按"分类规则"表第 3 行,**本轮忽略**该点位(既不算支撑也不算压力),其他候选正常分类。

### 边界 5:候选池只有 1 个候选(S1 存在,S2 不存在)

**场景**: 价格刚反弹一段,下方只剩 1 个有意义的支撑(其他候选都还在更深位置,但 EMA 群和静态点位都不在那段空间)。

**处理**:
- AI **不能**选激进 mode(无 S2 可挂)
- 强制 mode=conservative,挂 S1
- 即使 AI 错误输出 `mode=aggressive`,validator 会强制改写回 conservative(详见"validator 检查项")
- reasoning 标注 "only S1 available, conservative forced"

### 边界 6:S1 vs S2 间距过小(差距 ≤ 几个 tick)

例: current = $30.00, S1 = $29.70, S2 = $29.65(差距仅 $0.05)。

**处理**:
- 按 confluence 规则,S1 和 S2 应该合并为 1 个 S 项(按"同一价位多个锚点时的优先级")
- 合并后只剩 1 个候选,等同边界 5 → 强制 conservative
- 这种情况 AI 应该在 reasoning 里标注 "S1/S2 confluence within tick range, treated as single R; aggressive mode unavailable"

### 边界 7:S1 距 current 几个 tick 以内(几乎贴脸)

**场景**: current = $30.00, S1 = $29.99(差 $0.01),S2 = $28.50(差 $1.50)。

**处理**(由 AI 在主观判断时考虑):
- S1 离 current 极近,挂 S1 几乎是"立刻成交价",可能被噪声触发即填,失去等回踩的意义
- 这种场景**反而是激进 mode 的强信号** —— 既然 S1 几乎等于 current,等回踩到 S1 跟"市价"差别不大;不如等回踩到 S2(更明显的回撤)
- AI 应在 reasoning 里把这点列为激进的核心证据之一:`"evidence: S1=29.99 within tick of current=30.00 (no real wait); S2=28.50 offers genuine pullback target"`
- placement 微调原本会处理"S1 几个 tick 内贴脸"的情况(挂略高),但在 S1 vs S2 间距悬殊时,直接选 S2 更合理——这是 AI 主观判断价值所在

---

## 输出 schema

入场模式的 AI 输出**只包含这 6 个字段**:

```json
{
  "action": "BUY_LIMIT",
  "orderPrice": "27.50",
  "anchorSource": "EMA20",
  "reasoning": "current=27.85; support candidates below: [VWAP=27.70, EMA20=27.50, gap=26.80, EMA50=26.40]; chose nearest=27.50@EMA20; placement=default (no strong/weak trend); continuity=anchor unchanged from last round",
  "symbol": "TSLA",
  "currentPrice": "27.85"
}
```

**注意:不再有 `stopLossPrice` 和 `targetPrice` 字段**——这两个属于卖出策略的范畴,由"挂单成交后的首次卖出分析"产生(见下文工作流)。

### reasoning 强制格式(便于测试和审计)

reasoning ≤ 120 字,必须包含以下信息段(顺序可调):

1. **current 价格**: `current=X`(必须)
2. **S1 / S2 候选**: `candidates: [S1=A@anchor1, S2=B@anchor2]`(必须列出 S1;如有 S2 也列出,validator 用于 mode=aggressive 检查)
3. **mode 选择 + 依据**:
   - 保守: `mode=conservative (default)` 或 `mode=conservative (依据简短一句)`
   - 激进: `mode=aggressive (evidence: (1) ...; (2) ...)`(必须 ≥2 数字证据)
4. **挑选结果 + 锚名**: `chose=Y@<anchor>`(必须;`<anchor>` 必须等于 `anchorSource` 字段,validator 做交叉检查)
5. **placement 微调**: `placement=default | tick-higher (strong) | (其他依据)`
6. **三分连续性 + mode 切换(若有 pendingLimitOrder)**: `continuity=anchor unchanged | anchor realigned (X→Y) | anchor switched (X→Z) | mode changed (conservative→aggressive 依据) | first round`
7. **远距离提醒(若 orderPrice 比 current 低 > 5%)**: `note: anchor far below current (~-X%)`
8. **短期-中期冲突或 confluence**(可选):简短一句

**完整示例(保守模式,默认)**:
```
current=27.85; candidates: [S1=27.70@VWAP, S2=27.50@EMA20]; mode=conservative (default); chose=27.70@VWAP; placement=tick-higher=27.72 (strong: 5 green bars); continuity=anchor unchanged
```

**完整示例(激进模式,带证据)**:
```
current=30.20; candidates: [S1=29.70@EMA20, S2=28.80@prior_low]; mode=aggressive (evidence: (1) 3-bar lower highs 30.40→30.30→30.20 red bars; (2) S1-S2 spread=0.90 > S1-dist 0.50 × 1.5); chose=28.80@prior_low; placement=default; first round
```

### validator 必须做的 sanity check

| 检查项 | 不达标时的处理 |
|--------|---------------|
| `action === "BUY_LIMIT"` | 拒绝(buy mode 不允许其他 action) |
| `orderPrice` 是有效正数 + `orderPrice < currentPrice` 严格小于 | 拒绝 |
| `anchorSource` 是有效 enum,且在 buy 允许子集里(不能是 `fixed_*` / `aggressive_recovery` / `stop_broken` / `force_exit`) | 拒绝 |
| reasoning 里 `chose=<price>@<anchor>` 的 `<price>` 必须等于 `orderPrice`(允许 placement 微调差异 1-3 个 tick) | 拒绝 |
| reasoning 里 `chose=<price>@<anchor>` 的 `<anchor>` 必须等于 `anchorSource` 字段 | 拒绝(交叉检查) |
| reasoning 必须包含 `current=` + `candidates:` + `mode=` 三个字串 | 拒绝(防止 AI 偷懒省略) |
| **不**应有 `stopLossPrice` / `hardStopPrice` / `targetPrice` 字段出现 | 拒绝(那是 sell strategy 的事) |
| 远距离场景(orderPrice < currentPrice × 0.95) reasoning 应包含 `note: anchor far below current` 提示 | warning(不拒绝,但日志记录) |

**mode 相关的额外检查(本次更新核心)**:

| 检查项 | 不达标时的处理 |
|--------|---------------|
| `mode=conservative` 时,`orderPrice` 应该对应 S1 价格(±placement 微调) | 拒绝 |
| `mode=aggressive` 时,`orderPrice` 应该对应 S2 价格(±placement 微调) | 拒绝 |
| `mode=aggressive` 但 S2 在候选池里不存在(只有 S1) | 强制改写为 `mode=conservative`,orderPrice 改为 S1,reasoning 标注 "validator forced fallback: aggressive but no S2 available" |
| `mode=aggressive` reasoning 包含 ≥2 个独立数值参照(同 sell strategy 模糊词黑名单 + 强制改写规则) | 不达标 → 强制改写为 `mode=conservative` + S1 + reasoning 标注 "validator forced fallback: insufficient evidence for aggressive mode" |
| 保守 reasoning 无证据约束 | 通过(默认动作不需重论证) |

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
     - **立刻触发一次 AI 扫描,进入 sell mode 首轮分析(first_exit)**
     - 该首轮 sell mode 分析当前图形,产出 stopLossPrice (软止损) + hardStopPrice (硬止损) + 首个 SELL_LIMIT
     - 这三个值写入 virtualPosition / lastResult
     - 后续按卖出策略走(细节见 SELL_STRATEGY.md)
     - **首轮分析可能直接返回 SELL_NOW**:如果 BUY_LIMIT 成交到 "Limit filled" 之间发生 gap-down,first_exit 看到 current 已经在硬止损以下,直接输出 SELL_NOW + anchorSource=`stop_broken`(详见 SELL_STRATEGY.md 边界 3)
```

**取消挂单路径(替代第 6 步)**:

```
6b. 用户在券商端取消挂单(原因:看到更好的设置 / 价格走势改变 / 不想等了):
     - 用户点插件 "Cancel pending limit"
     - markLimitCancelled handler 清除 pendingLimitOrder
     - 回到"扫描入场"状态(第 2 步循环)
     - tradeHistory **不**记录此次取消(没有真实持仓,不算交易)
```

**核心:买入策略到第 6 步前为止。第 6 步起进入卖出策略;第 6b 步是平行退出路径,回到入场扫描循环。**

---

## 三分连续性规则(buy mode 下,有 pendingLimitOrder 时)

每轮分析时,如果 `pendingLimitOrder` 已存在,AI 比较"当前情况"vs"挂单时的情况"。比较元组是 `(anchorSource, orderPrice)`(buy mode 没有 zone 概念——只有一个状态 "scanning for entry",所以不需要 sell strategy 的 zone-aware 扩展):

| 情况 | 处理 | reasoning 标注 |
|------|------|----------------|
| **锚点不变 + 数值不变** | 重复同样的 BUY_LIMIT,用户保持挂单不动 | "continuity=anchor unchanged" |
| **锚点不变 + 数值移动** | 给新的 orderPrice(锚点同步移动后的新位置),用户在券商端替换挂单 | "continuity=anchor realigned, EMA20 27.50→27.55" |
| **锚点失效** | 切换到不同的关键点位(可能是另一个 EMA、或某个静态 pivot)| "continuity=anchor switched, EMA20 broken → EMA50" |
| **mode 切换(本次更新新增)** | AI 主观判断从保守 ↔ 激进切换,target 从 S1 ↔ S2 跳。reasoning 必须解释切换依据 | "continuity=mode changed (conservative→aggressive: 5-min downtrend strengthened); switching from S1=27.70@VWAP to S2=26.80@gap" |

**关键点:这是 chart-driven 的调整,不是 currentPrice-driven 的 chase。** EMA 是平滑的(基于多根 K 线),它的移动反映的是图形结构变化,不是价格的瞬时抖动。

> **与 sell strategy 三分连续性的差异**:
> - **buy mode**: 没有 zone 概念(只有一个状态 "scanning for entry"),所以连续性元组是 `(anchorSource, orderPrice, mode)`——`mode` 加进去防止"保守 S1=X" vs "激进 S2=X"(罕见同价但语义不同)被误判重复。
> - **sell strategy**: 有 4 个 zone,连续性元组是 `(zone, anchorSource, orderPrice)`,跨区切换专门处理。
>
> 两者都通过把"主观决策维度"(buy 的 mode / sell 的 zone)加进连续性元组,避免主观判断变化被误判为"重复信号"。

---

## 不做的事(规避 scope creep)

为了保持入场策略简洁,以下事情**不**纳入买入决策:

| 不做 | 原因 |
|------|------|
| 不要求"突破放量确认" | 预测派,不是确认派 |
| 不要求"VWAP reclaim" | 关键点位触发不需要 VWAP 配合 |
| **不允许 S3+**(只能在 S1 / S2 中选) | S3+ 距离过远,成交概率剧降,长期 EV 不见得正(同 sell strategy 健康区设计原则) |
| **不允许用户参数控制保守/激进偏好** | 主观选择必须由 AI 基于证据做,不由用户预设——避免重蹈 `userContext` / `quickProfitDelta` 等已删除特性的覆辙 |
| 不分关键点位强 / 中 / 弱 | 全部平等 |
| 不硬编码百分比距离阈值(挑锚时) | AI 看图自判可达性,无 magic number;远距离场景只 reasoning 标 note + validator warning,不拒绝 |
| 不输出 `stopLossPrice` / `hardStopPrice` / `targetPrice` | **属于卖出策略,Limit filled 后由 first_exit sell 分析产生** |
| 不参考用户的任何主观偏好参数 | 全部已删除 |
| AI 主观"保守/激进"判断**只在 S1 / S2 间二选一**,不允许更复杂的"挂在 S1 和 S2 之间的中间价"或"先挂 S1 再调整到 S2"等组合 | 单一决策点 + 二元选择是为了便于 validator + 监测指标设计;复杂组合会让评估变模糊 |

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

**`prior_high $32.00` 不参与**——它在 current $30.00 **上方**,本轮属于压力候选(留给卖出策略处理,买入策略本轮不管)。

**步骤 2: S1 / S2 编号 + AI 主观判断**

排序后:
- S1 = VWAP @ $29.70(最近,差 $0.30)
- S2 = EMA20 @ $29.40(次近,差 $0.60)
- S3+ = gap $28.80, EMA50 $28.50, prior_low $27.50 等(禁止挂)

证据 checklist:
- K 线: 假设过去 5 根 K 线收盘 strictly 抬高 → 偏多
- EMA: 多头排列 → 偏多
- VWAP: current 站上 VWAP → 偏多
- 量能: 反弹根放量 → 偏多
- S1 vs S2 间距: $0.30(S1)vs $0.30(S1→S2 间距)= 1:1,**间距不悬殊**
- 大盘: 假设大盘也偏多

AI 判定 → **mode=conservative**(证据偏多,无深回踩信号)

**输出(保守):**
```json
{
  "action": "BUY_LIMIT",
  "orderPrice": "29.70",
  "anchorSource": "VWAP",
  "reasoning": "current=30.00; candidates: [S1=29.70@VWAP, S2=29.40@EMA20]; mode=conservative (default: bullish 5-bar rise, EMAs aligned, S1-S2 spread 0.30 not significant); chose=29.70@VWAP; placement=default; first round",
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
  "reasoning": "current=26.20; candidates: [prior_low=25.80, EMA200=24.00]; chose nearest=25.80@prior_low; placement=default; note: 5-min downtrend, EMAs all above current",
  "currentPrice": "26.20"
}
```

(注意 reasoning 里的 "5-min downtrend" 是给用户的中期信号提示——不影响机械挑选,但帮助用户决定要不要真去挂单)

### 例 2b:激进 mode(明显下跌中,押 S2)

**现状(在例 2 基础上演化):**
- 当前价 $26.20(全天跌势中)
- 静态点位:`prior_low @ $25.80`、`prior_high @ $32.00`、`gap @ $24.50`
- 动态点位:`EMA20 = $27.50` 等都在 current 上方,`EMA200 = $24.00`、`VWAP = $27.10` 也都在上方

**步骤 1:支撑候选**(低于 $26.20):
- prior_low $25.80 ✓
- gap $24.50 ✓
- EMA200 $24.00 ✓

**步骤 2: S1 / S2 编号:**
- S1 = prior_low @ $25.80(差 $0.40)
- S2 = gap @ $24.50(差 $1.70)
- S3 = EMA200 @ $24.00(禁止)

**证据 checklist 扫描:**
- K 线: 过去 3 根 K 线最高点 $26.80 → $26.50 → $26.30(strictly 降低,阴线为主)→ **偏空**
- 均线: current 远低于所有 EMA → **强空头排列**
- VWAP: current 在 VWAP = $27.10 下方,无 reclaim → **偏空**
- 量能: 下跌根放量 → **偏空**
- S1 vs S2 间距: S1 距 current $0.40,S1→S2 间距 $1.30,**间距 = 3.25 × S1 距离,非常悬殊**
- 大盘: 假设大盘也下跌中 → **偏空**

AI 判定 → **mode=aggressive**(多条证据一致偏空 + S1/S2 间距悬殊,深回踩到 S2 概率明显)

**输出(激进):**
```json
{
  "action": "BUY_LIMIT",
  "orderPrice": "24.50",
  "anchorSource": "gap",
  "reasoning": "current=26.20; candidates: [S1=25.80@prior_low, S2=24.50@gap]; mode=aggressive (evidence: (1) 3-bar lower highs 26.80→26.50→26.30 red bars + below all EMAs; (2) S1-S2 spread 1.30 vs S1-dist 0.40, ratio 3.25× signals deep pullback likely); chose=24.50@gap; placement=default; first round",
  "currentPrice": "26.20"
}
```

**对比例 2(保守版)**: 同样下跌环境,如果没有 S1/S2 悬殊证据,默认还是挂 S1 prior_low @ $25.80。**例 2b 展示了"AI 主观判断升级到激进"的核心场景——多条证据指向深跌,且 S2 比 S1 显著更远(成本提升明显)**,这时激进 ROI 才有意义。

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

**输出:**
```json
{
  "action": "BUY_LIMIT",
  "orderPrice": "39.30",
  "anchorSource": "VWAP",
  "reasoning": "current=40.00 (all-time high); candidates (all dynamic): [VWAP=39.30, EMA20=38.80, EMA50=37.20, ...]; chose nearest=39.30@VWAP; placement=default; note: no static support below (new high zone)",
  "currentPrice": "40.00"
}
```

(场景看着像"新高真空",但其实 EMA/VWAP 永远存在,只要价格在上方就是动态支撑——所以这个场景几乎永远有解,不需要 conservative_estimate)

---

## 与卖出策略的边界

| 决策 | 属于 | 何时产生 |
|------|------|---------|
| 要不要挂买入限价 | **买入策略** | 每轮入场分析 |
| 挂在哪个价位(S1/S2 选择) | **买入策略** | 每轮入场分析 |
| 保守 / 激进 mode 判断 | **买入策略** | 每轮入场分析(AI 主观综合判断) |
| 选用哪个锚点 + placement 微调 | **买入策略** | 每轮入场分析 |
| **`stopLossPrice` (软止损)** | **卖出策略** | **首次卖出分析(Limit filled / 已持仓声明触发);永久固定,no trailing** |
| **`hardStopPrice` (硬止损)** | **卖出策略** | **首次卖出分析;永久固定,no trailing** |
| **首个 SELL_LIMIT 价格 / 锚** | **卖出策略** | **首次卖出分析(包括健康区 R1 / 观察区走止盈 / 警戒区保守 / 必须离场 SELL_NOW 四种 case)** |
| 后续每轮 SELL_LIMIT 调整 / 跨区切换 | **卖出策略** | 每轮 exit mode 分析(stops 不变,只调整 SELL_LIMIT) |
| 观察区 / 警戒区 AI 主观判断 | **卖出策略** | 每轮 exit mode 分析(非首次) |
| 何时 SELL_NOW | **卖出策略** | 每轮 exit mode 分析(破硬止损 / force_exit / first_exit gap-down 三种触发) |

**Buy / sell 在挂单成交那一刻彻底切换。** 买入策略不预判止损止盈;卖出策略也不参与挑选买点。**stops 一旦在 first_exit 时设定就永久固定,后续 exit 只调整 SELL_LIMIT**(详见 SELL_STRATEGY.md)。

---

## v18 已落实的部分

以下在 STATE_VERSION 18 已经实现,**本次更新不重写**:
- `buildAnalysisJsonSchema` 在 entry 模式下不再要求 `stopLossPrice` / `targetPrice`
- `validateAnalysisResult` entry 模式只校验 `orderPrice < currentPrice` + `anchorSource` 必填
- `prompt-config.js` 的 entry prompt 不提 stop/target
- `markBought` 立刻触发 first-exit sell 分析,写入 `virtualPosition.stopLossPrice` / `hardStopPrice` + 首个 SELL_LIMIT
- STATE_VERSION 17 → 18 migration 清理旧 schema 的预测 stop/target 字段

## 本次更新(v19)需要落实的代码改动(与 SELL_STRATEGY.md v19 一起执行)

### 1. 关键点位池加入"盘中静态点位"(与 sell 同步)
- `chartFocusAreas` (prompt-config.js) 在 entry 模式段落显式列出 `今日 HOD/LOD`、`开盘 15 分钟区间高低 ORH/ORL`、`intraday_pivot`
- AI 在每轮 entry 分析时把盘中静态点位和原有静态 + 动态点位一起当作平等候选筛选

### 2. anchorSource enum 扩展(schema 变更,与 sell 共享)
- 新增 `intraday_high` / `intraday_low` / `opening_range_high` / `opening_range_low` / `intraday_pivot`
- entry 模式 validator 加约束:**禁止** `fixed_soft_stop` / `fixed_hard_stop` / `aggressive_recovery` / `stop_broken` / `force_exit` 出现在 BUY_LIMIT 输出里

### 3. 「微调挂在支撑位」加机械判据
- `entryModeRules` (prompt-config.js) 显式列出三种 placement(正价位 / 略高 1-3 tick / 不挂深)的 K 线判据
- AI 必须在 reasoning 里说明选了哪种 placement 及依据
- validator 加约束:placement 与正价位差异 > 3 个 tick 时拒绝

### 3.5 S1 / S2 二选一 + AI 主观判断(本次更新核心)
- `entryModeRules` 显式说明 S1 / S2 编号规则(候选按距 current 从近到远排序;S3+ 完全禁止)
- 新增 mode 概念:`mode=conservative`(默认,挂 S1)/ `mode=aggressive`(挂 S2)
- 7 维度证据 checklist 写入 prompt
- 三条结构约束:默认保守是硬规则;激进必须 ≥2 数字证据;validator 拒绝模糊词
- 短期/中期冲突时默认保守
- validator 强制改写(同 sell strategy 浮亏区):
  - aggressive 不达标 → 改回 conservative S1
  - aggressive 但 S2 不存在 → 强制 conservative S1
  - aggressive 但 S1/S2 confluence(差距 ≤ 1-2 tick)→ 合并后只剩 S1,强制 conservative

### 4. reasoning 强制格式(与 sell 对称)
- `entryModeRules` 显式要求 reasoning 必须包含:`current=X; candidates: [S1=...@..., S2=...@...]; mode=conservative | aggressive (依据); chose=Y@<anchor>; placement=...; continuity=...`
- validator sanity check:
  - reasoning 必须包含 `current=` + `candidates:` + `mode=` 三个字串
  - reasoning 里 `chose=<price>@<anchor>` 的 `<price>` 必须等于 `orderPrice` 字段(允许 placement 微调差异 1-3 tick)
  - reasoning 里的 `<anchor>` 必须等于 `anchorSource` 字段(交叉检查)
  - mode=aggressive 时 reasoning 必须含 ≥2 个独立数值参照
  - reasoning **不**应包含 `stopLossPrice` / `hardStopPrice` / `targetPrice` 字段(那是 sell strategy 的事)
- 远距离场景(`orderPrice < currentPrice × 0.95`):reasoning 应含 `note: anchor far below current (~-X%)` 警告,validator 仅 warning 不拒绝

### 5. 取消挂单工作流(`markLimitCancelled`)
- 已有 handler,但策略文档此前没说。本次更新只是文档对齐,代码无变更

### 6. UI label 新增(与 sell 对称)
- 新增 i18n key(en + zh):
  - `entryModeConservative` / `entryModeAggressive` — 入场 mode 标签(显示在 recommendation 卡片上)
- recommendation 卡片显式展示 AI 判断的 mode(保守/激进)+ 当前 S1 / S2 价格

### 7. 测试
- `llm.test.js`: entry 模式 anchorSource 黑名单测试(fixed_* / aggressive_recovery / stop_broken / force_exit 出现 → validator 拒绝)
- `llm.test.js`: entry 模式 anchorSource 新增 intraday_* enum 接受测试
- `llm.test.js`: entry reasoning 交叉检查测试(chose 价格/锚名与字段不一致 → 拒绝)
- `llm.test.js`: placement 微调测试(strong trend → tick-higher placement)
- `llm.test.js`: 远距离 warning 测试
- `llm.test.js`: S1 / S2 主观判断测试
  - mode=conservative + 任何 reasoning → 通过,orderPrice = S1
  - mode=aggressive + reasoning 含 ≥2 数字证据 → 通过,orderPrice = S2
  - mode=aggressive + reasoning 缺数字 → validator 强制改回 conservative,orderPrice = S1
  - mode=aggressive + reasoning 含模糊词(looks/feels/seems 等)无数字 → 强制改回 conservative
  - mode=aggressive 但 S2 不存在(候选池只有 1 个)→ validator 强制改回 conservative + reasoning 标注 fallback
  - mode=aggressive 但 S1/S2 confluence 差距 ≤ tick → validator 视为合并候选,强制 conservative
- `llm.test.js`: S3+ 禁止测试——AI 输出 orderPrice 对应 S3 → validator 拒绝
- 不需要 storage migration(state shape 没变,STATE_VERSION 升级与 sell strategy v19 共用 v18→v19 migration)

---

## 未来工作(明确不在 v1)

| 功能 | 为什么不在 v1 |
|------|------|
| **S1 / S2 主观判断回退到机械永远 S1** | 主观判断是本版的试验性设计(与 sell strategy 浮亏区对称)。如果运行 30-50 笔成交后,激进 S2 的成交率太低 + P&L 没显著优于保守,**回退到机械永远 S1**。回退方案就是 pre-v19 的"就近原则",路径已知 |
| **confluence 加权** | 多锚重叠时(EMA50 + prior_low 同价位)目前只是 anchorSource 优先静态 + reasoning 标注。未来可考虑给 confluence 信号一些额外权重(比如 placement 更敢挂正价位、给用户 confidence indicator),但需要实测 confluence 锚的兑现率显著高于单锚才值得加 |
| **自适应"距离过远"动作** | 目前远距离场景只在 reasoning 标 note,validator 仅 warning。未来可考虑:超过一定距离阈值(例如 -10%)自动跳过本轮,不输出 BUY_LIMIT?但这违反"永远输出 BUY_LIMIT"的原则,需要实测验证 |
| **多档同时挂单**(例如 S1 和 S2 都挂) | 单仓假设;先确认基础策略后再说。当前架构 pendingLimitOrder 只能记录一个挂单 |
| **S3+ 引入** | 已明确禁止。如果未来发现"激进升级到 S3"在某些极端市场有 EV(例如恐慌性下跌中真到 S3 都填得上),再考虑加 S3 作为第三档,但需要充分实测数据支持 |

这些都是"实测后才决定要不要做"的功能。**v1 先把 S1/S2 + AI 主观判断 + 三条结构约束跑起来,采集数据**。
