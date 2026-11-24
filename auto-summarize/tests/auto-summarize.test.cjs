const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createContext, runInContext } = require("node:vm");

const source = readFileSync(resolve(__dirname, "../yt-auto-summarize-multilang.user.js"), "utf8");
const A = "aaaaaaaaaaa", B = "bbbbbbbbbbb";

function continuationFor(type, sourceKind) {
  const padding = new Array(28).fill(0x08);
  const innerBytes = Buffer.from([...padding, 0x2a, 0x06, 0x08, 0x01, 0x10, type, 0x28, sourceKind]);
  const inner = innerBytes.toString("base64url");
  return Buffer.from(`\x0a(${inner}`, "latin1").toString("base64url");
}

function makeButton({ label = "", ariaLabel, visible = true, continuation, onTap, parentData, classes = [], role, clicks = [] } = {}) {
  const el = {
    textContent: label,
    classList: { contains: name => classes.includes(name) },
    getAttribute: name => name === "aria-label" ? (ariaLabel ?? null) : name === "role" ? (role ?? null) : null,
    getClientRects: () => visible ? [{ width: 10, height: 10 }] : [],
    closest: selector => selector === "button-view-model.you-chat-entrypoint-button" && classes.includes("you-chat-entrypoint-button") ? el : null,
    click() { clicks.push(this); },
    parentElement: parentData ? { data: parentData, parentElement: null } : null,
    data: continuation ? { continuation } : onTap ? { onTap } : undefined,
  };
  return el;
}

function fixture({ url = `/watch?v=${A}`, videoId = A, readableData = true, actionsVisible: initialActionsVisible = true } = {}) {
  const listeners = new Map();
  const observers = new Set();
  const timers = new Set();
  const askClicks = [];
  const chipClicks = [];

  let currentWatchId = videoId;
  let actionsVisible = initialActionsVisible;
  let askButton = null;
  let panelChips = [];
  let panelOtherControls = [];
  let panelPresent = false;

  const panelEl = {
    querySelectorAll(selector) {
      if (!panelPresent) return [];
      if (selector === "you-chat-item-view-model button") return panelChips;
      if (selector === "button, [role='button']") return [...panelChips, ...panelOtherControls];
      return [];
    },
    querySelector(selector) {
      if (!panelPresent) return null;
      if (selector === "you-chat-chips-data button") return panelChips[0] || null;
      return null;
    },
  };

  function makeMenuEl() {
    if (!readableData) return {};
    return {
      data: {
        flexibleItems: askButton ? [{
          menuFlexibleItemRenderer: {
            topLevelButton: {
              buttonViewModel: {
                onTap: { innertubeCommand: { showEngagementPanelEndpoint: { panelIdentifier: "PAyouchat" } } },
              },
            },
          },
        }] : [],
      },
    };
  }

  const actionsRowEl = {
    querySelectorAll(selector) {
      if (selector !== "button") return [];
      return actionsVisible ? [makeButton({ label: "Like", visible: true })] : [];
    },
  };

  const metadataEl = {
    querySelector(selector) {
      if (selector === "#actions ytd-menu-renderer") return makeMenuEl();
      if (selector === "#top-level-buttons-computed") return actionsRowEl;
      if (selector.includes("yt-video-description-youchat-section-view-model")) return null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "#flexible-item-buttons button, #top-level-buttons-computed button") {
        return askButton ? [askButton] : [];
      }
      return [];
    },
  };

  const watchFlexyEl = {
    getAttribute: name => name === "video-id" ? currentWatchId : null,
  };

  const ctx = createContext({
    location: new URL(url, "https://www.youtube.com"),
    URLSearchParams,
    atob,
    console: { debug() {} },
    getComputedStyle: () => ({ visibility: "visible" }),
    setTimeout(fn) {
      const id = { fn, cleared: false };
      timers.add(id);
      return id;
    },
    clearTimeout(id) {
      if (id) id.cleared = true;
      timers.delete(id);
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    document: {
      hidden: false,
      body: {},
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type);
        if (list) listeners.set(type, list.filter(item => item !== fn));
      },
      querySelector(selector) {
        if (selector === "ytd-watch-flexy") return watchFlexyEl;
        if (selector === "ytd-watch-metadata") return metadataEl;
        if (selector === "ytd-engagement-panel-section-list-renderer[target-id='PAyouchat']") {
          return panelPresent ? panelEl : null;
        }
        return null;
      },
      querySelectorAll: () => [],
    },
  });

  function setAskAvailable(enabled = true) {
    askButton = enabled ? makeButton({
      label: "Ask",
      classes: ["you-chat-entrypoint-button"],
      onTap: readableData ? { innertubeCommand: { showEngagementPanelEndpoint: { panelIdentifier: "PAyouchat" } } } : undefined,
      clicks: askClicks,
    }) : null;
    if (askButton) {
      const origClick = askButton.click.bind(askButton);
      askButton.click = () => {
        origClick();
        panelPresent = true;
      };
    }
  }

  function setChips(specs) {
    panelPresent = true;
    panelChips = specs.map(spec => makeButton({
      label: spec.label,
      visible: spec.visible ?? true,
      continuation: spec.continuation,
      clicks: chipClicks,
    }));
  }

  function setOtherControls(specs) {
    panelPresent = true;
    panelOtherControls = specs.map(spec => makeButton({
      label: spec.label,
      role: spec.role,
      visible: spec.visible ?? true,
      clicks: chipClicks,
    }));
  }

  async function flush() {
    for (let i = 0; i < 6; i++) {
      for (const observer of [...observers]) observer.cb();
      await Promise.resolve();
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    }
  }

  function navigate(nextUrl, nextVideoId = new URL(nextUrl, "https://www.youtube.com").searchParams.get("v")) {
    ctx.location.href = new URL(nextUrl, ctx.location).href;
    currentWatchId = nextVideoId;
    for (const fn of listeners.get("yt-navigate-finish") || []) fn();
  }

  function expireTimers() {
    for (const timer of [...timers]) {
      timers.delete(timer);
      if (!timer.cleared) timer.fn();
    }
  }

  setAskAvailable(true);
  runInContext(source, ctx);

  return {
    askClicks,
    chipClicks,
    observers,
    setAskAvailable,
    setChips,
    setOtherControls,
    setActionsVisible(v) { actionsVisible = v; },
    setPanelPresent(v) { panelPresent = v; },
    flush,
    navigate,
    expireTimers,
  };
}

test("readable chip data ignores generated questions even with summarize wording until real summarize chip appears", async () => {
  const f = fixture({ readableData: true });
  await f.flush();
  assert.equal(f.askClicks.length, 1);

  f.setChips([
    { label: "How does the speaker summarize the findings?", continuation: continuationFor(1, 6) },
    { label: "Summarize the video", continuation: continuationFor(1, 6) },
  ]);
  await f.flush();
  assert.equal(f.chipClicks.length, 0);

  f.setChips([
    { label: "How does the speaker summarize the findings?", continuation: continuationFor(1, 6) },
    { label: "Summarize the video", continuation: continuationFor(1, 1) },
  ]);
  await f.flush();
  assert.equal(f.chipClicks.length, 1);
  assert.equal(f.chipClicks[0].textContent, "Summarize the video");
});

test("DOM label fallback rejects English generated questions but accepts Summarize/Summarise video chips", async () => {
  for (const label of ["How does the speaker summarize the findings?", "Summarization ideas"]) {
    const f = fixture({ readableData: false });
    await f.flush();
    f.setOtherControls([{ label, role: "button" }]);
    await f.flush();
    assert.equal(f.chipClicks.length, 0);
  }

  for (const label of ["Summarize the video", "Summarise the video", "동영상을 요약해 줘"]) {
    const f = fixture({ readableData: false });
    await f.flush();
    f.setOtherControls([{ label, role: "button" }]);
    await f.flush();
    assert.equal(f.chipClicks.length, 1);
    assert.equal(f.chipClicks[0].textContent, label);
  }
});

test("leaving to Home and returning to the same video summarizes again, while duplicate navigation skips", async () => {
  const f = fixture();
  f.setChips([{ label: "Summarize the video", continuation: continuationFor(1, 1) }]);
  await f.flush();
  assert.equal(f.askClicks.length, 1);
  assert.equal(f.chipClicks.length, 1);

  f.navigate(`/watch?v=${A}`, A);
  await f.flush();
  assert.equal(f.askClicks.length, 1);
  assert.equal(f.chipClicks.length, 1);

  f.navigate("/", null);
  await f.flush();
  f.setPanelPresent(false);
  f.navigate(`/watch?v=${A}`, A);
  await f.flush();
  f.setChips([{ label: "Summarize the video", continuation: continuationFor(1, 1) }]);
  await f.flush();
  assert.equal(f.askClicks.length, 2);
  assert.equal(f.chipClicks.length, 2);
});

test("leaving /watch while waiting cancels in-flight observers so late DOM changes do not click", async () => {
  const f = fixture({ actionsVisible: false });
  await f.flush();
  assert.equal(f.observers.size, 1);

  f.navigate("/", null);
  await f.flush();
  assert.equal(f.observers.size, 0);

  f.setActionsVisible(true);
  f.setChips([{ label: "Summarize the video", continuation: continuationFor(1, 1) }]);
  await f.flush();
  assert.equal(f.askClicks.length, 0);
  assert.equal(f.chipClicks.length, 0);
});
