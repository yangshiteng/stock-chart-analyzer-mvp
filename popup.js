import { STATUS } from "./lib/constants.js";
import { getState } from "./lib/storage.js";

const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const statusText = document.getElementById("statusText");
const detailText = document.getElementById("detailText");

function formatStatus(state) {
  if (state.status === STATUS.VALIDATING) {
    return {
      title: "Validating the current tab...",
      detail: "The extension is capturing the active tab and checking whether it looks like a stock chart."
    };
  }

  if (state.status === STATUS.AWAITING_MODE) {
    return {
      title: "Chart detected. Choose Buy or Sell in the side panel.",
      detail: state.lastValidation?.reason || "Validation passed."
    };
  }

  if (state.status === STATUS.AWAITING_CONTEXT) {
    return {
      title: `Fill in the ${state.mode?.toUpperCase()} setup form in the side panel.`,
      detail: "Enter your current shares, average cost, and intent before monitoring starts."
    };
  }

  if (state.status === STATUS.RUNNING) {
    return {
      title: `Monitoring in ${state.mode?.toUpperCase()} mode.`,
      detail: `Round ${state.roundCount} of ${state.maxRounds}. The extension will run again every 5 minutes.`
    };
  }

  return {
    title: "Idle",
    detail: state.lastError || state.stopReason || "Click Start to validate the current tab."
  };
}

async function render() {
  const state = await getState();
  const view = formatStatus(state);

  statusText.textContent = view.title;
  detailText.textContent = view.detail;

  startButton.disabled = state.status === STATUS.VALIDATING;
  stopButton.disabled = state.status === STATUS.IDLE && !state.lastValidation && !state.stopReason;
}

async function openSidePanel() {
  const currentWindow = await chrome.windows.getCurrent();

  await chrome.sidePanel.open({
    windowId: currentWindow.id
  });
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  statusText.textContent = "Validating the current tab...";

  const response = await chrome.runtime.sendMessage({
    type: "start-validation"
  });

  if (response?.ok && response.state?.status === STATUS.AWAITING_MODE) {
    await openSidePanel();
  }

  await render();
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;

  await chrome.runtime.sendMessage({
    type: "stop-monitoring"
  });

  await render();
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === "local" && changes.monitorState) {
    await render();
  }
});

void render();
