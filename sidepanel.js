import { AUTO_STOP_OPTIONS, RISK_STYLE_OPTIONS, STATUS } from "./lib/constants.js";
import { getLanguage, t } from "./lib/i18n.js";
import { getSettings, getState, patchSettings } from "./lib/storage.js";

const heroEyebrow = document.getElementById("heroEyebrow");
const heroTitle = document.getElementById("heroTitle");
const statusBadge = document.getElementById("statusBadge");
const summaryText = document.getElementById("summaryText");
const apiSetupSection = document.getElementById("apiSetupSection");
const stopMonitorButton = document.getElementById("stopMonitorButton");
const continueMonitorButton = document.getElementById("continueMonitorButton");
const restartMonitorButton = document.getElementById("restartMonitorButton");
const exitMonitorButton = document.getElementById("exitMonitorButton");
const apiSetupTitle = document.getElementById("apiSetupTitle");
const apiSetupCopy = document.getElementById("apiSetupCopy");
const apiKeyLabel = document.getElementById("apiKeyLabel");
const apiKeyInput = document.getElementById("apiKeyInput");
const saveApiKeyButton = document.getElementById("saveApiKeyButton");
const clearApiKeyButton = document.getElementById("clearApiKeyButton");
const apiKeyStatus = document.getElementById("apiKeyStatus");
const contextSection = document.getElementById("contextSection");
const contextTitle = document.getElementById("contextTitle");
const contextDescription = document.getElementById("contextDescription");
const contextForm = document.getElementById("contextForm");
const positionSectionTitle = document.getElementById("positionSectionTitle");
const positionSectionCopy = document.getElementById("positionSectionCopy");
const currentSharesLabel = document.getElementById("currentSharesLabel");
const averageCostLabel = document.getElementById("averageCostLabel");
const availableCashLabel = document.getElementById("availableCashLabel");
const allowAveragingDownLabel = document.getElementById("allowAveragingDownLabel");
const allowReducingPositionLabel = document.getElementById("allowReducingPositionLabel");
const rulesSectionTitle = document.getElementById("rulesSectionTitle");
const rulesSectionCopy = document.getElementById("rulesSectionCopy");
const buyRiskStyleLabel = document.getElementById("buyRiskStyleLabel");
const sellRiskStyleLabel = document.getElementById("sellRiskStyleLabel");
const autoStopLabel = document.getElementById("autoStopLabel");
const currentSharesInput = document.getElementById("currentSharesInput");
const averageCostInput = document.getElementById("averageCostInput");
const availableCashInput = document.getElementById("availableCashInput");
const allowAveragingDownSelect = document.getElementById("allowAveragingDownSelect");
const allowReducingPositionSelect = document.getElementById("allowReducingPositionSelect");
const buyRiskStyleSelect = document.getElementById("buyRiskStyleSelect");
const sellRiskStyleSelect = document.getElementById("sellRiskStyleSelect");
const autoStopSelect = document.getElementById("autoStopSelect");
const formHint = document.getElementById("formHint");
const formError = document.getElementById("formError");
const confirmButton = document.getElementById("confirmButton");
const recommendationTitle = document.getElementById("recommendationTitle");
const analysisCard = document.getElementById("analysisCard");

let isStartingMonitoring = false;

function escapeHtml(value) {
  return `${value}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPrice(value) {
  return value && value !== "N/A" ? value : null;
}

function formatActionLabel(language, action) {
  return action ? t(language, `action_${action}`) : t(language, "unknown");
}

function formatBooleanLabel(language, value) {
  return value ? t(language, "yes") : t(language, "no");
}

function formatRiskStyleLabel(language, value) {
  return value ? t(language, `riskStyle_${value}`) : t(language, "notProvided");
}

function getBuyRiskStyleLabel(language) {
  return language === "zh" ? "买入风险偏好" : "Buy Risk Style";
}

function getSellRiskStyleLabel(language) {
  return language === "zh" ? "卖出风险偏好" : "Sell Risk Style";
}

function getSellSideActionsLabel(language) {
  return language === "zh" ? "允许卖出类动作" : "Allow Sell-Side Actions";
}

function getCurrentPriceLabel(language) {
  return language === "zh" ? "现在价格" : "Current Price";
}

function getLimitBuyPriceLabel(language) {
  return language === "zh" ? "当前挂买单价格" : "Current Limit Buy Price";
}

function getLimitBuySharesLabel(language) {
  return language === "zh" ? "当前挂买单股数" : "Current Limit Buy Shares";
}

function getLimitSellPriceLabel(language) {
  return language === "zh" ? "当前挂卖单价格" : "Current Limit Sell Price";
}

function getLimitSellSharesLabel(language) {
  return language === "zh" ? "当前挂卖单股数" : "Current Limit Sell Shares";
}

function getPendingOrderLabel(language, side) {
  if (side === "buy") {
    return language === "zh" ? "当前挂买单" : "Current Limit Buy Order";
  }

  return language === "zh" ? "当前挂卖单" : "Current Limit Sell Order";
}

function getOrderGuidanceLabel(language, side) {
  if (side === "buy") {
    return language === "zh" ? "买单指导" : "Limit Buy Guidance";
  }

  return language === "zh" ? "卖单指导" : "Limit Sell Guidance";
}

function getOrderGuidanceDecisionLabel(language, decision) {
  const labels = {
    KEEP: language === "zh" ? "保留" : "Keep",
    PLACE: language === "zh" ? "新挂" : "Place",
    ADJUST: language === "zh" ? "调整" : "Adjust",
    CANCEL: language === "zh" ? "撤单" : "Cancel",
    NONE: language === "zh" ? "无操作" : "None"
  };

  return labels[decision] || decision || t(language, "unknown");
}

function getOrderGuidanceMetaLabel(language, key) {
  const labels = {
    currentOrder: language === "zh" ? "当前挂单" : "Current Order",
    price: language === "zh" ? "价格" : "Price",
    shares: language === "zh" ? "股数" : "Shares",
    reason: language === "zh" ? "原因" : "Reason"
  };

  return labels[key] || key;
}

function normalizeAutoStopRule(value) {
  return AUTO_STOP_OPTIONS.some((option) => option.value === value) ? value : "30m";
}

function formatAutoStopLabel(language, value) {
  return t(language, `autoStop_${normalizeAutoStopRule(value)}`);
}

function getMonitoringDetailCopy(language, round) {
  if (language === "zh") {
    return `当前第 ${round} 轮。扩展会每 5 分钟自动运行一次。`;
  }

  return `Current round: ${round}. The extension will run again every 5 minutes.`;
}

function getClarityLabel(language, value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return t(language, "clarityUnknown");
  }

  if (value < 35) {
    return t(language, "clarityLow");
  }

  if (value < 70) {
    return t(language, "clarityMedium");
  }

  return t(language, "clarityHigh");
}

function getPrimaryLevel(analysis) {
  return formatPrice(analysis.levels?.entry) || formatPrice(analysis.limitPrice);
}

function getOrderPlanLabel(language, analysis) {
  if (analysis.orderType === "LIMIT" && formatPrice(analysis.limitPrice)) {
    return t(language, "orderPlanLimit", { price: analysis.limitPrice });
  }

  return t(language, "orderPlanNone");
}

function formatPendingOrderSummary(language, order) {
  const shares = Number(order?.shares ?? 0);
  const price = formatPrice(order?.price);

  if (shares > 0 && price) {
    return language === "zh" ? `${shares} 股 @ ${price}` : `${shares} shares @ ${price}`;
  }

  return language === "zh" ? "当前没有挂单" : "No active order";
}

function renderOrderGuidanceCard(language, side, guidance) {
  const normalizedGuidance = guidance || {};

  return `
    <article class="metric-card order-guidance-card full-span">
      <div class="order-guidance-header">
        <p class="metric-label">${escapeHtml(getPlainOrderTitle(language, side))}</p>
        <span class="order-guidance-badge">${escapeHtml(getStaticOrderBadgeLabel(language))}</span>
      </div>
      <div class="order-guidance-grid">
        <div>
          <p class="metric-label">${escapeHtml(getPlainOrderMetaLabel(language, "price"))}</p>
          <p class="metric-value">${escapeHtml(normalizedGuidance.price || t(language, "nA"))}</p>
        </div>
        <div>
          <p class="metric-label">${escapeHtml(getPlainOrderMetaLabel(language, "shares"))}</p>
          <p class="metric-value">${escapeHtml(normalizedGuidance.shares || t(language, "nA"))}</p>
        </div>
      </div>
      <div class="order-guidance-reason">
        <p class="metric-label">${escapeHtml(getPlainOrderReasonLabel(language))}</p>
        <p class="metric-value">${escapeHtml(normalizedGuidance.reason || t(language, "nA"))}</p>
      </div>
    </article>
  `;
}

function getStaticOrderBadgeLabel(language) {
  return language === "zh" ? "仅供参考" : "Reference";
}

function getPlainOrderTitle(language, side) {
  if (side === "buy") {
    return language === "zh" ? "买入参考" : "Buy Reference";
  }

  return language === "zh" ? "卖出参考" : "Sell Reference";
}

function getPlainOrderMetaLabel(language, key) {
  const labels = {
    price: language === "zh" ? "参考价格" : "Reference Price",
    shares: language === "zh" ? "参考股数" : "Reference Shares"
  };

  return labels[key] || key;
}

function getWhatToDoNowCopy(language, analysis) {
  if (analysis.whatToDoNow) {
    return analysis.whatToDoNow;
  }

  return buildActionCopy(language, analysis);
}

function buildActionCopy(language, analysis) {
  const level = getPrimaryLevel(analysis);

  if (analysis.action === "OPEN") {
    return level ? t(language, "openActionCopy", { price: level }) : t(language, "openActionNoPrice");
  }

  if (analysis.action === "ADD") {
    return level ? t(language, "addActionCopy", { price: level }) : t(language, "addActionNoPrice");
  }

  if (analysis.action === "HOLD") {
    return level ? t(language, "holdActionCopy", { price: level }) : t(language, "holdActionNoPrice");
  }

  if (analysis.action === "REDUCE") {
    return level ? t(language, "reduceActionCopy", { price: level }) : t(language, "reduceActionNoPrice");
  }

  if (analysis.action === "EXIT") {
    return level ? t(language, "exitActionCopy", { price: level }) : t(language, "exitActionNoPrice");
  }

  return level ? t(language, "waitActionCopy", { price: level }) : t(language, "waitActionNoPrice");
}

function getPlainResultLabel(language, key) {
  const labels = {
    supportLevels: language === "zh" ? "当前支撑位" : "Current Support",
    resistanceLevels: language === "zh" ? "当前压力位" : "Current Resistance",
    watchLevel: language === "zh" ? "可以留意的价格" : "Price to Watch",
    target: language === "zh" ? "可能卖出价" : "Possible Sell Price",
    riskTrigger: language === "zh" ? "如果跌到这里要小心" : "Caution Price",
    why: language === "zh" ? "简单说明" : "Simple Why",
    riskNote: language === "zh" ? "需要注意" : "Watch Out"
  };

  return labels[key] || t(language, key);
}

function getPlainOrderReasonLabel(language) {
  return language === "zh" ? "简单说明" : "Simple Why";
}

function getActionTone(action) {
  if (action === "OPEN" || action === "ADD") {
    return "buy";
  }

  if (action === "REDUCE" || action === "EXIT") {
    return "sell";
  }

  if (action === "WAIT") {
    return "wait";
  }

  return "no-trade";
}

function renderMetricCard(language, label, value, fullSpan = false) {
  return `
    <article class="metric-card${fullSpan ? " full-span" : ""}">
      <p class="metric-label">${escapeHtml(label)}</p>
      <p class="metric-value">${escapeHtml(value || t(language, "nA"))}</p>
    </article>
  `;
}

function renderGuidanceCard(label, value) {
  return `
    <article class="guidance-card">
      <p class="metric-label">${escapeHtml(label)}</p>
      <p class="guidance-value">${escapeHtml(value)}</p>
    </article>
  `;
}

function renderAnalysisCard(state, language) {
  const result = state.lastResult;
  const analysis = result?.analysis;
  const profile = result?.monitoringProfile;

  if (isStartingMonitoring || state.isRoundInFlight || (state.status === STATUS.RUNNING && state.roundCount === 0 && !analysis)) {
    analysisCard.className = "analysis-card";
    analysisCard.innerHTML = `
      <section class="loading-card">
        <div class="loading-spinner" aria-hidden="true"></div>
        <p class="loading-title">${escapeHtml(t(language, "analyzingTitle"))}</p>
        <p class="loading-copy">${escapeHtml(t(language, "analyzingCopy"))}</p>
      </section>
    `;
    return;
  }

  if (!analysis) {
    analysisCard.className = "analysis-card empty-analysis";
    analysisCard.innerHTML = `<p class="empty-state">${escapeHtml(t(language, "emptyRecommendation"))}</p>`;
    return;
  }

  const tone = getActionTone(analysis.action);
  const levels = analysis.levels || {};
  const action = formatActionLabel(language, analysis.action);
  const orderPlan = getOrderPlanLabel(language, analysis);

  analysisCard.className = "analysis-card";
  analysisCard.innerHTML = `
    <section class="signal-banner ${tone}">
      <div class="signal-topline">
        <div>
          <p class="signal-label">${escapeHtml(t(language, "actionNow"))}</p>
          <h3 class="signal-value">${escapeHtml(action)}</h3>
        </div>
        <span class="pill">${escapeHtml(orderPlan)}</span>
      </div>
      <div class="guidance-grid">
        ${renderGuidanceCard(t(language, "whatToDoNow"), getWhatToDoNowCopy(language, analysis))}
      </div>
    </section>
    <div class="analysis-grid">
      ${renderMetricCard(language, getSafeCurrentPriceLabel(language), analysis.currentPrice || t(language, "nA"))}
      ${renderMetricCard(language, getPlainResultLabel(language, "supportLevels"), analysis.supportLevels || levels.entry || t(language, "nA"))}
      ${renderMetricCard(language, getPlainResultLabel(language, "resistanceLevels"), analysis.resistanceLevels || levels.target || t(language, "nA"))}
      ${renderMetricCard(language, getPlainResultLabel(language, "riskTrigger"), levels.invalidation || t(language, "nA"))}
      ${renderMetricCard(language, t(language, "suggestedSize"), analysis.sizeSuggestion || t(language, "nA"))}
      ${renderOrderGuidanceCard(language, "buy", analysis.buyOrderGuidance)}
      ${renderOrderGuidanceCard(language, "sell", analysis.sellOrderGuidance)}
      ${renderMetricCard(language, getPlainResultLabel(language, "riskNote"), analysis.riskNote || t(language, "nA"), true)}
    </div>
  `;
}

function getCompactOrderInputMetaLabel(language, key) {
  const labels = {
    price: language === "zh" ? "浠锋牸" : "Price",
    shares: language === "zh" ? "鑲℃暟" : "Shares"
  };

  return labels[key] || key;
}

function getCompactLimitBuyPriceLabel(language) {
  return getCompactOrderInputMetaLabel(language, "price");
}

function getCompactLimitBuySharesLabel(language) {
  return getCompactOrderInputMetaLabel(language, "shares");
}

function getCompactLimitSellPriceLabel(language) {
  return getCompactOrderInputMetaLabel(language, "price");
}

function getCompactLimitSellSharesLabel(language) {
  return getCompactOrderInputMetaLabel(language, "shares");
}

function getSafeCompactOrderInputLabel(language, key) {
  const labels = {
    price: language === "zh" ? "价格" : "Price",
    shares: language === "zh" ? "股数" : "Shares"
  };

  return labels[key] || key;
}

function getSafeCompactLimitBuyPriceLabel(language) {
  return getSafeCompactOrderInputLabel(language, "price");
}

function getSafeCompactLimitBuySharesLabel(language) {
  return getSafeCompactOrderInputLabel(language, "shares");
}

function getSafeCompactLimitSellPriceLabel(language) {
  return getSafeCompactOrderInputLabel(language, "price");
}

function getSafeCompactLimitSellSharesLabel(language) {
  return getSafeCompactOrderInputLabel(language, "shares");
}

function getSafeFormSectionTitle(language, section) {
  const labels = {
    position: language === "zh" ? "持仓与资金状态" : "Position & Capital Status",
    rules: language === "zh" ? "执行约束" : "Execution Rules"
  };

  return labels[section] || section;
}

function getSafeFormSectionCopy(language, section) {
  const labels = {
    position: language === "zh"
      ? "填写当前持仓、可用资金，以及你已经挂着的买单和卖单。"
      : "Enter your current holdings, available cash, and any working buy or sell orders.",
    rules: language === "zh"
      ? "设置 AI 必须遵守的执行边界，再决定是否下单或调整挂单。"
      : "Set the execution boundaries the assistant must respect before placing or adjusting orders."
  };

  return labels[section] || "";
}

function getSafeSellSideActionsLabel(language) {
  return language === "zh" ? "允许卖出类动作" : "Allow Sell-Side Actions";
}

function getSafeCurrentPriceLabel(language) {
  return language === "zh" ? "现在价格" : "Current Price";
}

function getSafePendingOrderLabel(language, side) {
  if (side === "buy") {
    return language === "zh" ? "当前挂买单" : "Current Limit Buy Order";
  }

  return language === "zh" ? "当前挂卖单" : "Current Limit Sell Order";
}

function getSafeOrderGuidanceLabel(language, side) {
  if (side === "buy") {
    return language === "zh" ? "买单指导" : "Limit Buy Guidance";
  }

  return language === "zh" ? "卖单指导" : "Limit Sell Guidance";
}

function getSafeOrderGuidanceDecisionLabel(language, decision) {
  const labels = {
    KEEP: language === "zh" ? "保留" : "Keep",
    PLACE: language === "zh" ? "新挂" : "Place",
    ADJUST: language === "zh" ? "调整" : "Adjust",
    CANCEL: language === "zh" ? "撤单" : "Cancel",
    NONE: language === "zh" ? "无操作" : "None"
  };

  return labels[decision] || decision || t(language, "unknown");
}

function getSafeOrderGuidanceMetaLabel(language, key) {
  const labels = {
    currentOrder: language === "zh" ? "当前挂单" : "Current Order",
    price: language === "zh" ? "价格" : "Price",
    shares: language === "zh" ? "股数" : "Shares",
    reason: language === "zh" ? "原因" : "Reason"
  };

  return labels[key] || key;
}

function formatSafePendingOrderSummary(language, order) {
  const shares = Number(order?.shares ?? 0);
  const price = formatPrice(order?.price);

  if (shares > 0 && price) {
    return language === "zh" ? `${shares} 股 @ ${price}` : `${shares} shares @ ${price}`;
  }

  return language === "zh" ? "当前没有挂单" : "No active order";
}

function getSuggestedOrderGuidanceLabel(language, side) {
  if (side === "buy") {
    return language === "zh" ? "限价买入建议" : "Limit Buy Idea";
  }

  return language === "zh" ? "限价卖出建议" : "Limit Sell Idea";
}

function getSuggestedOrderDecisionLabel(language, decision) {
  const labels = {
    KEEP: language === "zh" ? "保留" : "Keep",
    PLACE: language === "zh" ? "建议挂单" : "Place Idea",
    ADJUST: language === "zh" ? "调整" : "Adjust",
    CANCEL: language === "zh" ? "撤单" : "Cancel",
    NONE: language === "zh" ? "仅供参考" : "Reference"
  };

  return labels[decision] || decision || t(language, "unknown");
}

function getSuggestedOrderBadgeLabel(language, decision, action) {
  if ((action === "HOLD" || action === "WAIT") && decision === "PLACE") {
    return language === "zh" ? "参考位" : "Reference";
  }

  return getSuggestedOrderDecisionLabel(language, decision);
}

function getSuggestedOrderMetaLabel(language, key) {
  const labels = {
    price: language === "zh" ? "价格" : "Price",
    shares: language === "zh" ? "股数" : "Shares",
    reason: language === "zh" ? "原因" : "Reason"
  };

  return labels[key] || key;
}

function getPanelSectionTitle(language, section) {
  const labels = {
    position: language === "zh" ? "持仓与资金状态" : "Position & Capital Status",
    rules: language === "zh" ? "执行约束" : "Execution Constraints"
  };

  return labels[section] || section;
}

function getPanelSectionCopy(language, section) {
  const labels = {
    position: language === "zh"
      ? "先填写当前持仓、平均成本和可用资金，助手会据此推导买入和卖出的限价参考位。"
      : "Enter your current holdings, average cost, and available cash so the assistant can derive fresh limit-buy and limit-sell ideas.",
    rules: language === "zh"
      ? "再设置 AI 必须遵守的执行约束，比如是否允许摊低成本、卖出和自动停止。"
      : "Set the guardrails the assistant must respect before placing or adjusting orders."
  };

  return labels[section] || "";
}

function getContextCardTitle(language) {
  return language === "zh" ? "交易设置" : "Trading Setup";
}

function getContextCardCopy(language) {
  return language === "zh"
    ? "填写当前持仓、资金状态和执行约束，助手会据此给出更具体的操作建议，以及买入和卖出的限价参考位。"
    : "Share your current position, cash status, and execution rules so the assistant can give more precise actions plus fresh limit-buy and limit-sell ideas.";
}

function updateStaticText(language, settings) {
  heroEyebrow.textContent = t(language, "liveAnalysis");
  heroTitle.textContent = t(language, "appTitle");
  saveApiKeyButton.textContent = t(language, "saveKey");
  clearApiKeyButton.textContent = t(language, "clearKey");
  stopMonitorButton.textContent = t(language, "stop");
  continueMonitorButton.textContent = t(language, "continue");
  restartMonitorButton.textContent = t(language, "restart");
  exitMonitorButton.textContent = t(language, "exit");
  apiSetupTitle.textContent = t(language, "openAiSetup");
  apiSetupCopy.innerHTML = `${escapeHtml(t(language, "setupCopy"))}`;
  apiKeyLabel.textContent = t(language, "openAiApiKey");
  contextTitle.textContent = getContextCardTitle(language);
  contextDescription.textContent = getContextCardCopy(language);
  positionSectionTitle.textContent = getPanelSectionTitle(language, "position");
  positionSectionCopy.textContent = getPanelSectionCopy(language, "position");
  currentSharesLabel.textContent = t(language, "currentShares");
  averageCostLabel.textContent = t(language, "averageCost");
  availableCashLabel.textContent = t(language, "availableCash");
  rulesSectionTitle.textContent = getPanelSectionTitle(language, "rules");
  rulesSectionCopy.textContent = getPanelSectionCopy(language, "rules");
  allowAveragingDownLabel.textContent = t(language, "allowAveragingDown");
  allowReducingPositionLabel.textContent = getSafeSellSideActionsLabel(language);
  buyRiskStyleLabel.textContent = getBuyRiskStyleLabel(language);
  sellRiskStyleLabel.textContent = getSellRiskStyleLabel(language);
  autoStopLabel.textContent = t(language, "autoStop");
  confirmButton.textContent = t(language, "start");
  recommendationTitle.textContent = t(language, "latestRecommendation");
  apiKeyStatus.textContent = settings.openaiApiKey
    ? t(language, "apiKeySaved", { model: settings.model })
    : t(language, "noApiKeySaved");
}

function getSummary(state, language) {
  if (state.status === STATUS.VALIDATING) {
    return t(language, "validatingDetail");
  }

  if (state.status === STATUS.AWAITING_CONTEXT) {
    return t(language, "fillSetupDetail");
  }

  if (state.status === STATUS.RUNNING && state.isRoundInFlight) {
    return t(language, "analyzingCopy");
  }

  if (state.status === STATUS.RUNNING) {
    const base = getMonitoringDetailCopy(language, state.roundCount);
    const autoStopRule = normalizeAutoStopRule(
      state.monitoringProfile?.rules?.autoStopRule || state.lastMonitoringProfile?.rules?.autoStopRule
    );

    return `${base} ${t(language, "autoStop")}: ${formatAutoStopLabel(language, autoStopRule)}.`;
  }

  return state.lastError || state.stopReason || t(language, "clickStart");
}

function hasApiKey(settings) {
  return Boolean(settings.openaiApiKey);
}

function hasSavedMonitoringSession(state) {
  return Boolean(state.monitoringProfile || state.lastMonitoringProfile);
}

function getStatusBadgeLabel(language, status) {
  if (!status || status === STATUS.IDLE) {
    return t(language, "idle");
  }

  return t(language, `status_${status}`);
}

function populateBooleanSelect(select, language, selectedValue) {
  select.innerHTML = `
    <option value="yes">${escapeHtml(t(language, "yes"))}</option>
    <option value="no">${escapeHtml(t(language, "no"))}</option>
  `;
  select.value = selectedValue ? "yes" : "no";
}

function populateRiskStyleOptions(select, language, selectedValue = "conservative") {
  select.innerHTML = RISK_STYLE_OPTIONS
    .map((option) => `<option value="${option.value}">${escapeHtml(t(language, `riskStyle_${option.value}`))}</option>`)
    .join("");
  select.value = selectedValue;
}

function populateAutoStopOptions(language, selectedValue = "30m") {
  autoStopSelect.innerHTML = AUTO_STOP_OPTIONS
    .map((option) => `<option value="${option.value}">${escapeHtml(t(language, `autoStop_${option.value}`))}</option>`)
    .join("");
  autoStopSelect.value = normalizeAutoStopRule(selectedValue);
}

function updateFormGuidance(language) {
  const currentShares = Number(currentSharesInput.value || 0);
  const hasPosition = Number.isFinite(currentShares) && currentShares > 0;

  averageCostInput.required = hasPosition;
  formHint.textContent = t(language, "constraintsHint");
}

function populateContextForm(state, language) {
  const profile = state.monitoringProfile || state.lastMonitoringProfile;
  const storedRiskStyle = profile?.rules?.riskStyle || "conservative";

  currentSharesInput.value = profile?.positionContext?.currentShares ?? "";
  averageCostInput.value = profile?.positionContext?.averageCost ?? "";
  availableCashInput.value = profile?.capitalContext?.availableCash ?? "";
  populateBooleanSelect(allowAveragingDownSelect, language, Boolean(profile?.rules?.allowAveragingDown));
  populateBooleanSelect(allowReducingPositionSelect, language, profile?.rules?.allowReducingPosition !== false);
  populateRiskStyleOptions(buyRiskStyleSelect, language, profile?.rules?.buyRiskStyle || storedRiskStyle);
  populateRiskStyleOptions(sellRiskStyleSelect, language, profile?.rules?.sellRiskStyle || storedRiskStyle);
  populateAutoStopOptions(language, normalizeAutoStopRule(profile?.rules?.autoStopRule));
  updateFormGuidance(language);
}

async function render() {
  const state = await getState();
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const apiReady = hasApiKey(settings);

  updateStaticText(language, settings);
  statusBadge.textContent = getStatusBadgeLabel(language, state.status);
  summaryText.textContent = getSummary(state, language);
  apiKeyInput.value = "";
  renderAnalysisCard(state, language);
  apiSetupSection.classList.toggle("hidden", apiReady);

  const hasSavedSession = hasSavedMonitoringSession(state);
  const isBusy = state.status === STATUS.RUNNING || state.status === STATUS.VALIDATING || isStartingMonitoring;

  stopMonitorButton.disabled = !isBusy;
  continueMonitorButton.disabled = !apiReady || state.status === STATUS.RUNNING || !hasSavedSession;
  restartMonitorButton.disabled = !apiReady || !hasSavedSession;
  exitMonitorButton.disabled = isStartingMonitoring;
  confirmButton.disabled = isStartingMonitoring;

  contextSection.classList.toggle("hidden", state.status !== STATUS.AWAITING_CONTEXT);
  saveApiKeyButton.disabled = false;
  clearApiKeyButton.disabled = false;

  if (state.status === STATUS.AWAITING_CONTEXT) {
    populateContextForm(state, language);
  }

  if (state.status === STATUS.AWAITING_CONTEXT && !apiReady) {
    summaryText.textContent = t(language, "saveKeyFirst");
  }

  formError.textContent = "";
  formError.classList.add("hidden");
}

stopMonitorButton.addEventListener("click", async () => {
  stopMonitorButton.disabled = true;

  await chrome.runtime.sendMessage({
    type: "stop-monitoring"
  });

  await render();
});

continueMonitorButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  continueMonitorButton.disabled = true;
  restartMonitorButton.disabled = true;
  summaryText.textContent = t(language, "continuingSession");
  isStartingMonitoring = true;

  const state = await getState();
  renderAnalysisCard({
    ...state,
    status: STATUS.RUNNING
  }, language);

  let response;

  try {
    response = await chrome.runtime.sendMessage({
      type: "continue-monitoring"
    });
  } finally {
    isStartingMonitoring = false;
  }

  if (!response?.ok) {
    summaryText.textContent = response?.error || t(language, "couldNotContinue");
  }

  await render();
});

restartMonitorButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  continueMonitorButton.disabled = true;
  restartMonitorButton.disabled = true;
  summaryText.textContent = t(language, "restartingSession");
  isStartingMonitoring = true;

  const state = await getState();
  renderAnalysisCard({
    ...state,
    status: STATUS.RUNNING,
    roundCount: 0,
    lastResult: null
  }, language);

  let response;

  try {
    response = await chrome.runtime.sendMessage({
      type: "restart-monitoring"
    });
  } finally {
    isStartingMonitoring = false;
  }

  if (!response?.ok) {
    summaryText.textContent = response?.error || t(language, "couldNotRestart");
  }

  await render();
});

exitMonitorButton.addEventListener("click", async () => {
  exitMonitorButton.disabled = true;

  await chrome.runtime.sendMessage({
    type: "exit-monitoring"
  });

  window.close();
});

saveApiKeyButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const nextKey = apiKeyInput.value.trim();

  if (!nextKey) {
    apiKeyStatus.textContent = t(language, "enterApiKeyFirst");
    return;
  }

  saveApiKeyButton.disabled = true;
  clearApiKeyButton.disabled = true;

  await patchSettings({
    openaiApiKey: nextKey,
    model: "gpt-5.4"
  });

  apiKeyStatus.textContent = t(language, "apiKeyReady");
  apiKeyInput.value = "";
  await render();
});

clearApiKeyButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  saveApiKeyButton.disabled = true;
  clearApiKeyButton.disabled = true;

  await patchSettings({
    openaiApiKey: "",
    model: "gpt-5.4"
  });

  apiKeyStatus.textContent = t(language, "apiKeyCleared");
  apiKeyInput.value = "";
  await render();
});

currentSharesInput.addEventListener("input", async () => {
  const settings = await getSettings();
  updateFormGuidance(getLanguage(settings.language));
});

contextForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const settings = await getSettings();
  const language = getLanguage(settings.language);

  if (!hasApiKey(settings)) {
    formError.textContent = t(language, "saveApiKeyBeforeMonitoring");
    formError.classList.remove("hidden");
    return;
  }

  updateFormGuidance(language);

  if (!contextForm.reportValidity()) {
    return;
  }

  confirmButton.disabled = true;
  formError.textContent = "";
  formError.classList.add("hidden");
  summaryText.textContent = t(language, "startMonitoringProgress");
  isStartingMonitoring = true;

  const state = await getState();
  renderAnalysisCard({
    ...state,
    status: STATUS.RUNNING
  }, language);

  let response;

  try {
    response = await chrome.runtime.sendMessage({
      type: "start-monitoring",
      currentShares: currentSharesInput.value,
      averageCost: averageCostInput.value,
      availableCash: availableCashInput.value,
      allowAveragingDown: allowAveragingDownSelect.value === "yes",
      allowReducingPosition: allowReducingPositionSelect.value === "yes",
      buyRiskStyle: buyRiskStyleSelect.value,
      sellRiskStyle: sellRiskStyleSelect.value,
      autoStopRule: autoStopSelect.value
    });
  } finally {
    isStartingMonitoring = false;
  }

  if (!response?.ok) {
    formError.textContent = response?.error || t(language, "couldNotStart");
    formError.classList.remove("hidden");
    confirmButton.disabled = false;
    return;
  }

  await render();
});

chrome.storage.onChanged.addListener(async () => {
  await render();
});

void render();
