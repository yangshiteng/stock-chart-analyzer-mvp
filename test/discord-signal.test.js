import { test } from "node:test";
import assert from "node:assert/strict";
import { getDiscordNotificationReason } from "../lib/discord-signal.js";

test("discord notification reason: first signal notifies", () => {
  assert.equal(
    getDiscordNotificationReason(null, { action: "WAIT", orderPrice: null }),
    "first_signal"
  );
});

test("discord notification reason: action changes notify", () => {
  assert.equal(
    getDiscordNotificationReason(
      { action: "WAIT", orderPrice: null },
      { action: "BUY_LIMIT", orderPrice: "27.68" }
    ),
    "action_changed"
  );
});

test("discord notification reason: same limit action with changed orderPrice notifies", () => {
  assert.equal(
    getDiscordNotificationReason(
      { action: "BUY_LIMIT", orderPrice: "27.68" },
      { action: "BUY_LIMIT", orderPrice: "28.89" }
    ),
    "order_price_changed"
  );

  assert.equal(
    getDiscordNotificationReason(
      { action: "SELL_LIMIT", orderPrice: "27.68" },
      { action: "SELL_LIMIT", orderPrice: "28.89" }
    ),
    "order_price_changed"
  );
});

test("discord notification reason: same limit action and same numeric price does not notify", () => {
  assert.equal(
    getDiscordNotificationReason(
      { action: "BUY_LIMIT", orderPrice: "28.90" },
      { action: "BUY_LIMIT", orderPrice: "28.9" }
    ),
    null
  );
});

test("discord notification reason: same WAIT or HOLD does not notify", () => {
  assert.equal(
    getDiscordNotificationReason(
      { action: "WAIT", orderPrice: null },
      { action: "WAIT", orderPrice: null }
    ),
    null
  );
  assert.equal(
    getDiscordNotificationReason(
      { action: "HOLD", orderPrice: null },
      { action: "HOLD", orderPrice: null }
    ),
    null
  );
});
