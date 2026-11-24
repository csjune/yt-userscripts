const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createContext, runInContext } = require("node:vm");

const source = readFileSync(resolve(__dirname, "../yt-hide-live-chat.user.js"), "utf8");
const A = "aaaaaaaaaaa";

function fixture({ url = `/watch?v=${A}`, videoId = A } = {}) {
  let now = 1_700_000_000_000;
  let nextTimerId = 1;
  const timers = new Map();
  const listeners = new Map();
  const observers = new Set();
  const closeClicks = [];

  let currentWatchId = videoId;
  let chatPresent = false;
  let chatCollapsed = true;
  let iframeCloseReady = false;
  let hideButtonReady = false;

  class FakeElement {
    constructor({ selectors = [] } = {}) {
      this.selectors = selectors;
    }
    closest(selector) {
      return this.selectors.includes(selector) ? this : null;
    }
  }

  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }

  const closeButton = {
    click() {
      closeClicks.push({ time: now, via: "close" });
      chatCollapsed = true;
    },
  };
  const hideButton = {
    click() {
      closeClicks.push({ time: now, via: "hide" });
      chatCollapsed = true;
    },
  };

  const chatFrameEl = {
    hasAttribute: name => name === "collapsed" ? chatCollapsed : false,
    querySelector(selector) {
      if (selector === "#chatframe") {
        return {
          contentDocument: {
            querySelector: inner => inner === "yt-live-chat-header-renderer #close-button button" && iframeCloseReady ? closeButton : null,
          },
        };
      }
      if (selector === "#show-hide-button:not([hidden]) button") {
        return hideButtonReady ? hideButton : null;
      }
      return null;
    },
  };

  const watchFlexyEl = {
    getAttribute: name => name === "video-id" ? currentWatchId : null,
  };

  const ctx = createContext({
    location: new URL(url, "https://www.youtube.com"),
    URLSearchParams,
    Date: FakeDate,
    Element: FakeElement,
    console: { debug() {} },
    setTimeout(fn, delay = 0) {
      const id = nextTimerId++;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    document: {
      hidden: false,
      body: new FakeElement(),
      documentElement: new FakeElement(),
      addEventListener(type, fn, capture) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push({ fn, capture });
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type);
        if (list) listeners.set(type, list.filter(item => item.fn !== fn));
      },
      querySelector(selector) {
        if (selector === "ytd-watch-flexy") return currentWatchId ? watchFlexyEl : null;
        if (selector === "ytd-live-chat-frame#chat") return chatPresent ? chatFrameEl : null;
        return null;
      },
    },
  });

  async function settle() {
    for (let i = 0; i < 6; i++) {
      for (const observer of [...observers]) observer.cb();
      await Promise.resolve();
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    }
  }

  async function advance(ms) {
    const target = now + ms;
    while (true) {
      let nextId = null;
      let nextEntry = null;
      for (const [id, entry] of timers.entries()) {
        if (entry.at <= target && (!nextEntry || entry.at < nextEntry.at)) {
          nextId = id;
          nextEntry = entry;
        }
      }
      if (!nextEntry) break;
      now = Math.max(now, nextEntry.at);
      timers.delete(nextId);
      nextEntry.fn();
      await settle();
    }
    now = target;
    await settle();
  }

  function emitInput(type, target, extra = {}) {
    const event = { type, target, isTrusted: true, ...extra };
    for (const { fn } of listeners.get(type) || []) fn(event);
  }

  function navigate(nextUrl, nextVideoId = new URL(nextUrl, "https://www.youtube.com").searchParams.get("v")) {
    ctx.location.href = new URL(nextUrl, ctx.location).href;
    currentWatchId = nextVideoId;
    for (const { fn } of listeners.get("yt-navigate-finish") || []) fn();
  }

  runInContext(source, ctx);

  return {
    ctx,
    FakeElement,
    closeClicks,
    timers,
    setChat({ present = chatPresent, collapsed = chatCollapsed, closeReady = iframeCloseReady, hideReady = hideButtonReady } = {}) {
      chatPresent = present;
      chatCollapsed = collapsed;
      iframeCloseReady = closeReady;
      hideButtonReady = hideReady;
    },
    settle,
    advance,
    emitInput,
    navigate,
  };
}

test("closes auto-opened chat even if user clicks outside while close button is still loading", async () => {
  const f = fixture();
  f.setChat({ present: true, collapsed: false, closeReady: false });
  await f.settle();
  assert.equal(f.closeClicks.length, 0);

  await f.advance(50);
  f.emitInput("click", new f.FakeElement());

  f.setChat({ closeReady: true });
  await f.advance(250);
  assert.equal(f.closeClicks.length, 1);
});

test("ignores video player click and Space on body before chat opens", async () => {
  const f = fixture();
  await f.settle();

  await f.advance(50);
  f.emitInput("click", new f.FakeElement({ selectors: ["#movie_player"] }));
  f.emitInput("keydown", f.ctx.document.body, { key: " " });

  await f.advance(250);
  f.setChat({ present: true, collapsed: false, closeReady: true });
  await f.advance(250);
  assert.equal(f.closeClicks.length, 1);
});

test("leaves chat open when user reopens it after closing, even within click cooldown", async () => {
  const f = fixture();
  f.setChat({ present: true, collapsed: false, closeReady: true });
  await f.settle();
  assert.equal(f.closeClicks.length, 1);

  await f.advance(300);
  f.emitInput("click", new f.FakeElement());
  f.setChat({ collapsed: false });
  await f.advance(1500);
  assert.equal(f.closeClicks.length, 1);
});

test("leaves chat open when user clicks inside ytd-live-chat-frame", async () => {
  const f = fixture();
  f.setChat({ present: true, collapsed: true, closeReady: true });
  await f.settle();

  await f.advance(100);
  f.emitInput("click", new f.FakeElement({ selectors: ["ytd-live-chat-frame"] }));
  f.setChat({ collapsed: false });
  await f.advance(500);
  assert.equal(f.closeClicks.length, 0);
});

test("resets on leaving watch page so returning to the same video closes chat again", async () => {
  const f = fixture();
  f.setChat({ present: true, collapsed: false, closeReady: true });
  await f.settle();
  assert.equal(f.closeClicks.length, 1);

  f.navigate("/", null);
  await f.settle();
  f.setChat({ present: false, collapsed: true, closeReady: false });

  f.navigate(`/watch?v=${A}`, A);
  f.setChat({ present: true, collapsed: false, closeReady: true });
  await f.settle();
  assert.equal(f.closeClicks.length, 2);
});
