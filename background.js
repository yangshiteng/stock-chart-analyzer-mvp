import {
  ALARM_MINUTES,
  ALARM_NAME,
  INTENT_OPTIONS,
  MAX_RESULTS,
  MODE,
  STATUS,
  createDefaultState
} from "./lib/constants.js";
import { validateStockChartByKeywords } from "./lib/chart-validator.js";
import { analyzeChartCapture } from "./lib/llm.js";
import { getSettings, getState, patchState, saveState } from "./lib/storage.js";

const ICON_PATH = "assets/icon-128.png";

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function notifyUser(title, message) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: ICON_PATH,
      title,
      message
    });
  } catch (error) {
    console.warn("Notification failed:", error);
  }
}

async function clearMonitoringAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (!tab?.windowId) {
    throw new Error("No active tab was found. Focus a chart tab and try again.");
  }

  return tab;
}

async function captureActiveTab() {
  const tab = await getActiveTab();
  const imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png"
  });

  return {
    tabId: tab.id ?? null,
    windowId: tab.windowId,
    pageTitle: tab.title || "Untitled tab",
    pageUrl: tab.url || "",
    imageDataUrl
  };
}

function buildValidationRecord(validation, capture) {
  return {
    ...validation,
    pageTitle: capture.pageTitle,
    pageUrl: capture.pageUrl,
    checkedAt: new Date().toISOString()
  };
}

async function ensureApiKeyConfigured() {
  const settings = await getSettings();

  if (!settings.openaiApiKey) {
    throw new Error("Save your OpenAI API key in the side panel before choosing Buy or Sell.");
  }
}

function normalizeDecimal(value, label) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number.`);
  }

  return Number(parsed.toFixed(4));
}

function buildMonitoringProfile({ mode, currentShares, averageCost, intent }) {
  if (![MODE.BUY, MODE.SELL].includes(mode)) {
    throw new Error("Mode must be either buy or sell.");
  }

  const allowedIntents = (INTENT_OPTIONS[mode] || []).map((option) => option.value);

  if (!allowedIntents.includes(intent)) {
    throw new Error("Choose a valid trading intent.");
  }

  const normalizedShares = normalizeDecimal(currentShares, "Current shares");

  if (normalizedShares < 0) {
    throw new Error("Current shares must be 0 or greater.");
  }

  const normalizedAverageCost = averageCost === "" || averageCost === null || averageCost === undefined
    ? null
    : normalizeDecimal(averageCost, "Average cost");

  if (normalizedAverageCost !== null && normalizedAverageCost <= 0) {
    throw new Error("Average cost must be greater than 0.");
  }

  const requiresExistingPosition = mode === MODE.SELL || intent !== "new_position";

  if (requiresExistingPosition && normalizedShares <= 0) {
    throw new Error("This setup requires an existing position with shares greater than 0.");
  }

  if (requiresExistingPosition && normalizedAverageCost === null) {
    throw new Error("Average cost is required for this setup.");
  }

  return {
    mode,
    intent,
    positionContext: {
      currentShares: normalizedShares,
      averageCost: normalizedShares > 0 ? normalizedAverageCost : null
    }
  };
}

async function stopMonitoring(reason = null) {
  await clearMonitoringAlarm();

  return patchState({
    status: STATUS.IDLE,
    mode: null,
    monitoringProfile: null,
    stopReason: reason,
    lastError: null
  });
}

async function beginMonitoringSetup(mode) {
  await ensureApiKeyConfigured();

  if (![MODE.BUY, MODE.SELL].includes(mode)) {
    throw new Error("Mode must be either buy or sell.");
  }

  return patchState({
    status: STATUS.AWAITING_CONTEXT,
    mode,
    monitoringProfile: null,
    stopReason: null,
    lastError: null
  });
}

async function returnToModeSelection() {
  return patchState({
    status: STATUS.AWAITING_MODE,
    mode: null,
    monitoringProfile: null,
    stopReason: null,
    lastError: null
  });
}

async function runValidationPreflight() {
  await clearMonitoringAlarm();

  await saveState({
    ...createDefaultState(),
    status: STATUS.VALIDATING
  });

  try {
    const capture = await captureActiveTab();
    const validation = validateStockChartByKeywords(capture);
    const validationRecord = buildValidationRecord(validation, capture);

    if (!validation.isStockChart) {
      const state = await saveState({
        ...createDefaultState(),
        lastValidation: validationRecord,
        stopReason: "Validation failed because the current tab does not look like a stock chart."
      });

      await notifyUser("Stock chart not detected", "Monitoring stopped because the current tab is not recognized as a stock chart.");

      return {
        ok: false,
        state
      };
    }

    const state = await saveState({
      ...createDefaultState(),
      status: STATUS.AWAITING_MODE,
      lastValidation: validationRecord
    });

    return {
      ok: true,
      state
    };
  } catch (error) {
    const state = await saveState({
      ...createDefaultState(),
      lastError: error.message,
      stopReason: "Validation failed because the tab could not be captured."
    });

    await notifyUser("Capture failed", error.message);

    return {
      ok: false,
      error: error.message,
      state
    };
  }
}

async function runMonitoringRound(modeOverride = null) {
  const currentState = await getState();
  const mode = modeOverride || currentState.mode;
  const monitoringProfile = currentState.monitoringProfile;

  if (!mode) {
    throw new Error("Choose Buy or Sell mode first.");
  }

  if (!monitoringProfile) {
    throw new Error("Fill in the position form before starting monitoring.");
  }

  if (currentState.roundCount >= currentState.maxRounds) {
    const state = await stopMonitoring(`Reached ${currentState.maxRounds} rounds.`);
    return { ok: false, state };
  }

  try {
    const capture = await captureActiveTab();
    const validation = validateStockChartByKeywords(capture);
    const validationRecord = buildValidationRecord(validation, capture);

    if (!validation.isStockChart) {
      const state = await patchState({
        status: STATUS.IDLE,
        mode: null,
        monitoringProfile: null,
        lastValidation: validationRecord,
        stopReason: "Monitoring stopped because the current tab is no longer recognized as a stock chart.",
        lastError: null
      });

      await clearMonitoringAlarm();
      await notifyUser("Monitoring stopped", "The current tab is no longer recognized as a stock chart.");

      return {
        ok: false,
        state
      };
    }

    const analysis = await analyzeChartCapture({
      ...capture,
      mode,
      intent: monitoringProfile.intent,
      positionContext: monitoringProfile.positionContext
    });

    const round = currentState.roundCount + 1;
    const result = {
      id: createId(),
      round,
      mode,
      capturedAt: new Date().toISOString(),
      pageTitle: capture.pageTitle,
      pageUrl: capture.pageUrl,
      monitoringProfile,
      validation: validationRecord,
      analysis
    };

    let state = await saveState({
      ...currentState,
      status: STATUS.RUNNING,
      mode,
      roundCount: round,
      lastValidation: validationRecord,
      lastResult: result,
      results: [result, ...currentState.results].slice(0, MAX_RESULTS),
      stopReason: null,
      lastError: null
    });

    if (round >= state.maxRounds) {
      await clearMonitoringAlarm();
      state = await saveState({
        ...state,
        status: STATUS.IDLE,
        mode: null,
        monitoringProfile: null,
        stopReason: `Reached ${state.maxRounds} rounds.`
      });

      await notifyUser("Monitoring finished", `Stopped after ${state.maxRounds} rounds.`);
    }

    return {
      ok: true,
      state,
      result
    };
  } catch (error) {
    const state = await saveState({
      ...currentState,
      status: STATUS.IDLE,
      mode: null,
      monitoringProfile: null,
      lastError: error.message,
      stopReason: "Monitoring stopped because the current tab could not be analyzed."
    });

    await clearMonitoringAlarm();
    await notifyUser("Monitoring stopped", error.message);

    return {
      ok: false,
      error: error.message,
      state
    };
  }
}

async function startMonitoring(payload) {
  await ensureApiKeyConfigured();

  const monitoringProfile = buildMonitoringProfile(payload);

  await patchState({
    status: STATUS.RUNNING,
    mode: monitoringProfile.mode,
    monitoringProfile,
    stopReason: null,
    lastError: null
  });

  const roundResult = await runMonitoringRound(monitoringProfile.mode);

  if (!roundResult.ok) {
    return roundResult;
  }

  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: ALARM_MINUTES,
    periodInMinutes: ALARM_MINUTES
  });

  return {
    ok: true,
    state: await getState()
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  await saveState(createDefaultState());
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();

  if (!state.updatedAt) {
    await saveState(createDefaultState());
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  const state = await getState();

  if (state.status !== STATUS.RUNNING || !state.mode) {
    await clearMonitoringAlarm();
    return;
  }

  await runMonitoringRound();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void sender;

  (async () => {
    if (message?.type === "get-state") {
      sendResponse({ ok: true, state: await getState() });
      return;
    }

    if (message?.type === "start-validation") {
      sendResponse(await runValidationPreflight());
      return;
    }

    if (message?.type === "choose-mode") {
      sendResponse({
        ok: true,
        state: await beginMonitoringSetup(message.mode)
      });
      return;
    }

    if (message?.type === "back-to-mode-selection") {
      sendResponse({
        ok: true,
        state: await returnToModeSelection()
      });
      return;
    }

    if (message?.type === "start-monitoring") {
      sendResponse(await startMonitoring(message));
      return;
    }

    if (message?.type === "stop-monitoring") {
      sendResponse({
        ok: true,
        state: await stopMonitoring("Monitoring stopped by the user.")
      });
      return;
    }

    sendResponse({
      ok: false,
      error: "Unknown message type."
    });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error.message
    });
  });

  return true;
});
