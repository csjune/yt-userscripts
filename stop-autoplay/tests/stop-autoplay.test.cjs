const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createContext, runInContext } = require("node:vm");

const source = readFileSync(resolve(__dirname, "../yt-stop-autoplay.user.js"), "utf8");
const A = "aaaaaaaaaaa", B = "bbbbbbbbbbb", AD = "advert00001";
const WATCH = "WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH";
const SHORTS = "WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_SHORTS";

function response(id = A, extra = {}) {
  return { videoDetails: { videoId: id }, playerConfig: { playbackStartConfig: { startPaused: false, ...extra } } };
}
const start = value => value.playerConfig.playbackStartConfig.startPaused;

function fixture({ url = `/watch?v=${A}`, initial, data, frozenConfig = false, noResponse = false, playerConstructor } = {}) {
  const handlers = new Map();
  function addEventListener(type, handler, capture) {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push({ handler, capture });
  }
  class FakeResponse {
    constructor(body, error) { this.body = body; this.error = error; }
    json() { return this.error ? Promise.reject(this.error) : Promise.resolve(this.body); }
  }
  const mediaCalls = [];
  class Media {
    play() { mediaCalls.push("play"); }
    pause() { mediaCalls.push("pause"); }
  }
  const originalPlay = Media.prototype.play;
  const originalPause = Media.prototype.pause;
  let shortsElement, playerElement, watchPlayerElement, mutationCallback;
  const elements = new Map(playerConstructor ? [["ytd-player", playerConstructor]] : []);
  const ctx = createContext({
    location: new URL(url, "https://www.youtube.com"), URLSearchParams,
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    Response: noResponse ? undefined : FakeResponse,
    HTMLMediaElement: Media,
    customElements: {
      get: name => elements.get(name),
      define(name, constructor) { elements.set(name, constructor); return "defined"; },
    },
    document: {
      body: {}, documentElement: {},
      addEventListener,
      querySelector: selector => selector === "ytd-shorts" ? shortsElement : selector === "#movie_player" ? watchPlayerElement : null,
      querySelectorAll: () => playerElement ? [playerElement] : [],
    }, addEventListener,
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe() {}
    },
    ytInitialPlayerResponse: initial,
    console,
  });
  ctx.window = ctx;
  function config(values = {}) {
    const result = { data_: values, calls: 0, set(...args) {
      this.calls++;
      if (args.length > 1) this.data_[args[0]] = args[1];
      else Object.assign(this.data_, args[0]);
      return "set-result";
    } };
    return result;
  }
  if (data) ctx.ytcfg = frozenConfig ? Object.freeze(config(data)) : config(data);
  runInContext(source, ctx);
  function emit(type, target = {}, extra = {}) {
    const event = { type, target, ...extra };
    for (const { handler } of handlers.get(type) || []) handler(event);
    return event;
  }
  function navigate(url) {
    ctx.location.href = new URL(url, ctx.location).href;
    emit("yt-navigate-finish");
  }
  function play(id = A, main = true) {
    const watch = { getAttribute: key => key === "video-id" ? id : null };
    const player = {};
    emit("play", { closest: selector => selector === "ytd-watch-flexy" ? watch : selector === "#movie_player" && main ? player : null });
  }
  function mountShorts(id = A) {
    let state = 5, playerId = id;
    const loads = [], moved = [];
    const api = {
      getPlayerState: () => state,
      getVideoData: () => ({ video_id: playerId }),
      playVideo() {
        state = 1;
        mediaCalls.push("play");
        emit("play", { closest: selector => selector === "#shorts-player" ? api : null });
        return "played";
      },
      pauseVideo() { state = 2; mediaCalls.push("pause"); },
    };
    const controller = {
      player: api, playerData: response(id), index: 0, currentPlayerIndex: 0,
      playerInPosition: true, isPlayerPaused: false, toggles: 0,
      movePlayerToVideo(index) { moved.push(index); this.currentPlayerIndex = index; this.playerInPosition = true; },
      togglePlayPauseVideo() {
        this.toggles++;
        if (state === 1) api.pauseVideo();
        else if (state === 2) return api.playVideo();
      },
    };
    playerElement = {
      context: SHORTS,
      loadVideoWithPlayerResponse(value, ...args) {
        playerId = value.videoDetails.videoId;
        const paused = start(value);
        loads.push({ value, args, receiver: this, paused });
        state = 5;
        if (!paused) api.playVideo();
        return "loaded";
      },
    };
    shortsElement = { polymerController: controller };
    mutationCallback();
    return { element: playerElement, controller, api, loads, moved, mutate: () => mutationCallback() };
  }
  function mountWatchPlayer({ id = A, state = 5, locked = false, attach = "mutate" } = {}) {
    let currentState = state;
    let currentId = id;
    const calls = [];
    function loadVideoById(...args) {
      calls.push({ args, receiver: this });
      currentState = 1;
      return "loaded";
    }
    const element = {
      getPlayerState: () => currentState,
      getVideoData: () => ({ video_id: currentId }),
    };
    if (locked) {
      Object.defineProperty(element, "loadVideoById", {
        value: loadVideoById,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    } else {
      element.loadVideoById = loadVideoById;
    }
    watchPlayerElement = element;
    if (attach === "mutate") mutationCallback();
    else if (attach === "domcontentloaded") emit("DOMContentLoaded");
    return {
      element,
      calls,
      setState(next) { currentState = next; },
      setVideoId(next) { currentId = next; },
      mutate: () => mutationCallback(),
    };
  }
  return { ctx, config, emit, navigate, play, handlers, Media, originalPlay, originalPause, mediaCalls, mountShorts, mountWatchPlayer };
}

test("initial response selects cue before a player requests playback", () => {
  const f = fixture();
  f.ctx.ytInitialPlayerResponse = response();
  let played = false, cued = false;
  const player = { load() { played = true; }, cue() { cued = true; } };
  const data = f.ctx.ytInitialPlayerResponse;
  if (start(data)) player.cue(); else player.load();
  assert.equal(cued, true);
  assert.equal(played, false);
  assert.equal(start(JSON.parse(JSON.stringify(data))), true);
});

test("also prepares data and configuration that already exist", () => {
  const initial = response();
  const data = { WEB_PLAYER_CONTEXT_CONFIGS: { [WATCH]: { serializedClientExperimentFlags: "17=false" } }, EXPERIMENT_FLAGS: {} };
  fixture({ initial, data });
  assert.equal(start(initial), true);
  assert.equal(new URLSearchParams(data.WEB_PLAYER_CONTEXT_CONFIGS[WATCH].serializedClientExperimentFlags).get("45872076"), "true");
  assert.equal(data.EXPERIMENT_FLAGS.main_app_preserve_cued_bootstrap_player, true);
});

test("patches bootstrap configuration before set consumes it and preserves its contract", () => {
  const f = fixture();
  const inline = { serializedClientExperimentFlags: "99=false" };
  f.ctx.ytcfg = f.config();
  const values = { WEB_PLAYER_CONTEXT_CONFIGS: {
    [WATCH]: { serializedClientExperimentFlags: "17=false&45872076=false&caption=a%2Bb" },
    WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_INLINE_PREVIEW: inline,
  }, EXPERIMENT_FLAGS: { untouched: false } };
  assert.equal(f.ctx.ytcfg.set(values), "set-result");
  const flags = new URLSearchParams(values.WEB_PLAYER_CONTEXT_CONFIGS[WATCH].serializedClientExperimentFlags);
  assert.equal(flags.get("45872076"), "true");
  assert.equal(flags.get("17"), "false");
  assert.equal(flags.get("caption"), "a+b");
  assert.equal(inline.serializedClientExperimentFlags, "99=false");
  assert.equal(values.EXPERIMENT_FLAGS.main_app_preserve_cued_bootstrap_player, true);
  assert.equal(values.EXPERIMENT_FLAGS.web_fix_bootstrap_player_play_unstarted, true);
  assert.equal(values.EXPERIMENT_FLAGS.untouched, false);
  assert.equal(f.ctx.ytcfg.calls, 1);
  const replacement = {};
  f.ctx.ytcfg.set("EXPERIMENT_FLAGS", replacement);
  assert.equal(replacement.main_app_preserve_cued_bootstrap_player, true);
});

test("does not call ytcfg.get before its global assignment finishes", () => {
  const f = fixture();
  const cfg = f.config();
  cfg.get = () => { throw new Error("ytcfg is not assigned yet"); };
  assert.doesNotThrow(() => { f.ctx.ytcfg = cfg; });
  f.ctx.ytcfg.set("EXPERIMENT_FLAGS", {});
  assert.equal(cfg.calls, 1);
});

test("handles reassignment without stacking config.set wrappers", () => {
  const f = fixture();
  const cfg = f.config();
  f.ctx.ytcfg = cfg;
  const wrapper = cfg.set;
  f.ctx.ytcfg = cfg;
  assert.equal(cfg.set, wrapper);
  cfg.set("EXPERIMENT_FLAGS", {});
  assert.equal(cfg.calls, 1);
});

test("prepares JSON and fetch response bodies, including watch response wrappers", async () => {
  const f = fixture();
  for (const key of ["playerResponse", "player_response", "raw_player_response", "response", "data"]) {
    const value = f.ctx.JSON.parse(JSON.stringify([{ [key]: response() }]));
    assert.equal(start(value[0][key]), true);
  }
  const fetched = await new f.ctx.Response({ playerResponse: response() }).json();
  assert.equal(start(fetched.playerResponse), true);
});

test("preserves JSON revivers, parse errors, fetch rejection, and object identity", async () => {
  const f = fixture();
  const parsed = f.ctx.JSON.parse('{"n":1}', (key, value) => key === "n" ? value + 1 : value);
  assert.deepEqual(parsed, { n: 2 });
  assert.throws(() => f.ctx.JSON.parse("invalid"), SyntaxError);
  const error = new Error("network body failed");
  await assert.rejects(new f.ctx.Response(null, error).json(), error);
  const body = response();
  assert.equal(await new f.ctx.Response(body).json(), body);
});

test("a prefetched response changes only when its video becomes the watch target", () => {
  const f = fixture({ url: "/results?search_query=test" });
  const prefetched = f.ctx.JSON.parse(JSON.stringify(response(B)));
  assert.equal(start(prefetched), false);
  f.navigate(`/watch?v=${A}`);
  assert.equal(start(prefetched), false);
  f.navigate(`/watch?v=${B}`);
  assert.equal(start(prefetched), true);
});

test("manual playback releases the visit, including future responses and ad transitions", async () => {
  const f = fixture({ initial: response() });
  f.play();
  assert.equal(start(f.ctx.ytInitialPlayerResponse), false);
  assert.equal(start(await new f.ctx.Response(response()).json()), false);
  assert.equal(start(f.ctx.JSON.parse(JSON.stringify(response(AD)))), false);
  assert.equal(f.handlers.get("play")[0].capture, true);
  assert.equal(f.Media.prototype.play, f.originalPlay);
  assert.equal(f.Media.prototype.pause, f.originalPause);
  new f.Media().play();
  assert.deepEqual(f.mediaCalls, ["play"]);
});

test("outgoing media and previews cannot release the next watch visit", () => {
  const f = fixture({ initial: response(B), url: `/watch?v=${B}` });
  f.play(A);
  f.play(B, false);
  assert.equal(start(f.ctx.ytInitialPlayerResponse), true);
  f.play(B);
  assert.equal(start(f.ctx.ytInitialPlayerResponse), false);
});

test("keeps one visit across timestamps and playlist parameters, but resets on next video", () => {
  const f = fixture({ initial: response() });
  f.play();
  f.navigate(`/watch?v=${A}&t=60&list=LIST`);
  assert.equal(start(f.ctx.ytInitialPlayerResponse), false);
  f.navigate(`/watch?v=${B}`);
  const next = f.ctx.JSON.parse(JSON.stringify(response(B)));
  assert.equal(start(next), true);
  f.play(B);
  assert.equal(start(next), false);
});

test("rearms after leaving and returning, including back navigation", () => {
  const f = fixture({ initial: response() });
  f.play();
  f.navigate("/");
  f.ctx.location.href = `https://www.youtube.com/watch?v=${A}`;
  f.emit("popstate");
  assert.equal(start(f.ctx.ytInitialPlayerResponse), true);
});

test("supports live URLs and their watch redirect without releasing a new visit", () => {
  const initial = response(A, { startSeconds: 42, liveUtcStartSeconds: 100 });
  const f = fixture({ url: `/live/${A}`, initial });
  assert.equal(start(initial), true);
  f.play();
  f.navigate(`/watch?v=${A}`);
  assert.equal(start(initial), false);
  assert.equal(initial.playerConfig.playbackStartConfig.startSeconds, 42);
  assert.equal(initial.playerConfig.playbackStartConfig.liveUtcStartSeconds, 100);
});

test("leaves previews, watch-page ads, and non-player JSON unchanged", () => {
  for (const url of ["/", "/embed/aaaaaaaaaaa"]) {
    const f = fixture({ url, initial: response() });
    assert.equal(start(f.ctx.ytInitialPlayerResponse), false);
  }
  const f = fixture();
  const ad = f.ctx.JSON.parse(JSON.stringify(response(AD)));
  const placeholder = f.ctx.JSON.parse(JSON.stringify(response("ux")));
  assert.equal(start(ad), false);
  assert.equal(start(placeholder), false);
  assert.deepEqual(f.ctx.JSON.parse('{"startPaused":false,"x":null}'), { startPaused: false, x: null });
});

test("prepares explicit and seedless Shorts entry with the same bootstrap gate", () => {
  for (const url of [`/shorts/${A}`, "/shorts", "/shorts/"]) {
    const initial = response();
    const data = { WEB_PLAYER_CONTEXT_CONFIGS: { [SHORTS]: {} } };
    fixture({ url, initial, data });
    assert.equal(start(initial), true);
    assert.equal(new URLSearchParams(data.WEB_PLAYER_CONTEXT_CONFIGS[SHORTS].serializedClientExperimentFlags).get("45872076"), "true");
  }
});

test("seedless Shorts cues its first real response after a placeholder bootstrap", () => {
  const f = fixture({ url: "/shorts/", initial: response("ux") });
  const first = f.ctx.JSON.parse(JSON.stringify(response()));
  assert.equal(start(first), true);
  const s = f.mountShorts();
  s.api.playVideo();
  assert.equal(start(first), false);
  f.navigate(`/shorts/${A}`);
  assert.equal(start(first), false);
});

test("cues the next Short before the URL or Shorts page data changes", () => {
  const f = fixture({ url: `/shorts/${A}` });
  const s = f.mountShorts();
  const next = response(B);
  assert.equal(s.element.loadVideoWithPlayerResponse(next, { startSeconds: 12 }), "loaded");
  assert.equal(f.ctx.location.pathname, `/shorts/${A}`);
  assert.equal(s.controller.playerData.videoDetails.videoId, A);
  assert.equal(s.loads[0].paused, true);
  assert.equal(s.loads[0].receiver, s.element);
  assert.equal(s.loads[0].args[0].startSeconds, 12);
  assert.equal(s.loads[0].args[0].autoplay, "0");
  assert.deepEqual(f.mediaCalls, []);
});

test("cues a shallow-copied prefetched response after the previous Short was played", () => {
  const f = fixture({ url: `/shorts/${A}` });
  const s = f.mountShorts();
  s.element.loadVideoWithPlayerResponse(response());
  s.api.playVideo();
  const prefetched = f.ctx.JSON.parse(JSON.stringify(response(B)));
  const next = { ...prefetched };
  assert.equal(start(next), false);
  s.element.loadVideoWithPlayerResponse(next);
  assert.equal(s.loads.at(-1).paused, true);
  assert.deepEqual(f.mediaCalls, ["play"]);
  f.navigate(`/shorts/${B}`);
  s.api.playVideo();
  assert.equal(start(next), false);
});

test("hooks a new Shorts player before its first synchronous load", () => {
  for (const alreadyDefined of [false, true]) {
    let loaded;
    class Player {
      createElement() {
        this.context = SHORTS;
        this.loadVideoWithPlayerResponse = (value, vars) => { loaded = { value, vars }; return "loaded"; };
        return "created";
      }
    }
    const f = fixture({ url: "/shorts/", playerConstructor: alreadyDefined ? Player : undefined });
    if (!alreadyDefined) assert.equal(f.ctx.customElements.define("ytd-player", Player), "defined");
    const player = new Player();
    assert.equal(player.createElement(), "created");
    const vars = { startSeconds: 12, autoplay: "1" };
    assert.equal(player.loadVideoWithPlayerResponse(response(), vars), "loaded");
    assert.equal(start(loaded.value), true);
    assert.equal(loaded.vars.autoplay, "0");
    assert.equal(loaded.vars.startSeconds, 12);
    assert.equal(vars.autoplay, "1");
    player.context = WATCH;
    player.loadVideoWithPlayerResponse(response(B), vars);
    assert.equal(loaded.vars, vars);
  }
});

test("locked player methods do not break component creation or registration", () => {
  class Player {
    createElement() {
      Object.defineProperty(this, "loadVideoWithPlayerResponse", { value: () => "unchanged" });
      return "created";
    }
  }
  const f = fixture();
  assert.equal(f.ctx.customElements.define("ytd-player", Player), "defined");
  const player = new Player();
  assert.equal(player.createElement(), "created");
  assert.equal(player.loadVideoWithPlayerResponse(), "unchanged");
  class LockedFactory { createElement() { return "created"; } }
  Object.freeze(LockedFactory.prototype);
  assert.doesNotThrow(() => fixture({ playerConstructor: LockedFactory }));
});

test("shows the cued Short in the new card without starting it", () => {
  const f = fixture({ url: `/shorts/${A}` });
  const s = f.mountShorts();
  const next = response(B);
  s.element.loadVideoWithPlayerResponse(next);
  s.controller.index = 1;
  s.controller.playerInPosition = false;
  s.mutate();
  assert.deepEqual(s.moved, []); // Still holds the outgoing page data.
  s.controller.playerData = next;
  f.navigate(`/shorts/${B}`);
  s.mutate();
  assert.deepEqual(s.moved, [1]);
  assert.equal(s.controller.isPlayerPaused, true);
  assert.deepEqual(f.mediaCalls, []);
});

test("keyboard play starts a cued Short and preserves normal pause/resume and retries", () => {
  const f = fixture({ url: `/shorts/${A}` });
  const s = f.mountShorts();
  const initial = response();
  s.element.loadVideoWithPlayerResponse(initial);
  assert.equal(s.controller.togglePlayPauseVideo(), "played");
  assert.equal(s.controller.toggles, 0);
  assert.equal(start(initial), false);
  s.controller.togglePlayPauseVideo();
  s.controller.togglePlayPauseVideo();
  assert.equal(s.controller.toggles, 2);
  s.element.loadVideoWithPlayerResponse(response());
  assert.equal(s.loads.at(-1).paused, false);
  assert.deepEqual(f.mediaCalls, ["play", "pause", "play", "play"]);
});

test("Space starts only a cued Short and leaves later key handling to YouTube", () => {
  const f = fixture({ url: `/shorts/${A}` });
  const s = f.mountShorts();
  s.element.loadVideoWithPlayerResponse(response());
  const key = () => ({ code: "Space", preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  const event = f.emit("keydown", f.ctx.document.body, key());
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.deepEqual(f.mediaCalls, ["play"]);
  const playing = f.emit("keydown", f.ctx.document.body, key());
  assert.equal(playing.prevented, undefined);
  s.api.pauseVideo();
  const paused = f.emit("keydown", f.ctx.document.body, key());
  assert.equal(paused.prevented, undefined);
  assert.deepEqual(f.mediaCalls, ["play", "pause"]);
});

test("Space does not hijack other controls, typing, modifiers, or repeated keys", () => {
  const f = fixture({ url: `/shorts/${A}` });
  f.mountShorts();
  const key = { code: "Space", preventDefault() { throw new Error("must not intercept"); } };
  f.emit("keydown", {}, key); // Search/comment controls outside the player.
  for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey", "repeat", "defaultPrevented"]) {
    f.emit("keydown", f.ctx.document.body, { ...key, [modifier]: true });
  }
  const control = { classList: { contains: () => false } };
  f.emit("keydown", { closest: selector => selector === "#shorts-player" ? {} : control }, key);
  assert.deepEqual(f.mediaCalls, []);
  f.navigate(`/watch?v=${A}`);
  f.emit("keydown", f.ctx.document.body, key);
});

test("rearms the next and previous Short, including cached responses", () => {
  const f = fixture({ url: `/shorts/${A}` });
  const s = f.mountShorts();
  const first = response(), next = response(B);
  s.element.loadVideoWithPlayerResponse(first);
  s.api.playVideo();
  s.element.loadVideoWithPlayerResponse(next);
  assert.equal(s.loads.at(-1).paused, true);
  f.navigate(`/shorts/${B}`);
  s.api.playVideo();
  s.element.loadVideoWithPlayerResponse(first);
  assert.equal(s.loads.at(-1).paused, true);
  assert.equal(f.mediaCalls.length, 2);
});

test("leaving Shorts resets the visit while a duplicate navigation does not", () => {
  const f = fixture({ url: `/shorts/${A}` });
  const s = f.mountShorts();
  s.element.loadVideoWithPlayerResponse(response());
  s.api.playVideo();
  f.navigate(`/shorts/${A}`);
  s.element.loadVideoWithPlayerResponse(response());
  assert.equal(s.loads.at(-1).paused, false);
  f.navigate("/");
  s.element.loadVideoWithPlayerResponse(response());
  assert.equal(s.loads.at(-1).paused, true);
});

test("opening the same video in Shorts is a new visit after watch playback", () => {
  const initial = response();
  const f = fixture({ initial });
  f.play();
  assert.equal(start(initial), false);
  f.navigate(`/shorts/${A}`);
  assert.equal(start(initial), true);
});

test("the first Shorts load can precede leaving the watch URL", () => {
  const f = fixture();
  const s = f.mountShorts();
  s.element.loadVideoWithPlayerResponse(response(B));
  assert.equal(s.loads[0].paused, true);
  assert.deepEqual(f.mediaCalls, []);
});

test("an outgoing Shorts play event cannot release the newly loaded Short", () => {
  const f = fixture({ url: `/shorts/${A}` });
  const s = f.mountShorts();
  const next = response(B);
  s.element.loadVideoWithPlayerResponse(next);
  f.emit("play", { closest: selector => selector === "#shorts-player" ? { getVideoData: () => ({ video_id: A }) } : null });
  assert.equal(start(next), true);
});

test("a Shorts response reused on a watch page follows the watch visit", () => {
  const f = fixture({ url: `/shorts/${A}` });
  const s = f.mountShorts();
  const data = response();
  s.element.loadVideoWithPlayerResponse(data);
  s.api.playVideo();
  f.navigate(`/watch?v=${A}`);
  assert.equal(start(data), true);
  f.play();
  assert.equal(start(data), false);
});

test("retains YouTube's value after it updates startPaused or the visit is released", () => {
  const f = fixture({ initial: response() });
  const config = f.ctx.ytInitialPlayerResponse.playerConfig.playbackStartConfig;
  config.startPaused = true;
  f.play();
  assert.equal(config.startPaused, true);
  config.startPaused = false;
  assert.equal(config.startPaused, false);
});

test("ignores immutable data and cycles without breaking the page", async () => {
  const frozen = response();
  Object.freeze(frozen.playerConfig.playbackStartConfig);
  const f = fixture({ initial: frozen, data: Object.freeze({}), frozenConfig: true });
  assert.equal(start(frozen), false);
  const cycle = response();
  cycle.data = cycle;
  assert.equal(await new f.ctx.Response(cycle).json(), cycle);
  assert.equal(start(cycle), true);
  assert.doesNotThrow(() => fixture({ noResponse: true }));
});

test("ignores cued same-video loadVideoById calls on watch and live pages", () => {
  for (const url of [`/watch?v=${A}`, `/live/${A}`]) {
    const f = fixture({ url });
    const mp = f.mountWatchPlayer();
    assert.equal(mp.element.loadVideoById(A, 0), undefined);
    assert.equal(mp.element.loadVideoById({ videoId: A, startSeconds: 0 }), undefined);
    assert.deepEqual(mp.calls, []);
    assert.equal(mp.element.getPlayerState(), 5);
  }
});

test("allows loadVideoById after manual watch playback begins", () => {
  const f = fixture();
  const mp = f.mountWatchPlayer();
  f.play(A);
  assert.equal(mp.element.loadVideoById(A, 0), "loaded");
  assert.equal(mp.calls.length, 1);
  assert.deepEqual(mp.calls[0].args, [A, 0]);
  assert.equal(mp.calls[0].receiver, mp.element);
});

test("allows loadVideoById when player state is not cued", () => {
  const f = fixture();
  const mp = f.mountWatchPlayer();
  for (const state of [-1, 1, 2]) {
    mp.setState(state);
    assert.equal(mp.element.loadVideoById(A, 0), "loaded");
  }
  assert.equal(mp.calls.length, 3);
});

test("allows loadVideoById for another video id, mismatched player video, or on Shorts", () => {
  const f = fixture();
  const mp = f.mountWatchPlayer();
  assert.equal(mp.element.loadVideoById(B, 0), "loaded");
  assert.equal(mp.element.loadVideoById({ videoId: B, startSeconds: 5 }), "loaded");
  mp.setState(5);
  mp.setVideoId(B);
  assert.equal(mp.element.loadVideoById(A, 0), "loaded");
  assert.equal(mp.calls.length, 3);

  const shorts = fixture({ url: `/shorts/${A}` });
  const shortsMp = shorts.mountWatchPlayer({ id: A });
  assert.equal(shortsMp.element.loadVideoById(A, 0), "loaded");
  assert.equal(shortsMp.calls.length, 1);
});

test("does not throw when #movie_player.loadVideoById is locked read-only", () => {
  const f = fixture();
  const mp = f.mountWatchPlayer({ locked: true });
  assert.doesNotThrow(() => {
    mp.mutate();
    f.emit("DOMContentLoaded");
    f.navigate(`/watch?v=${B}`);
  });
  assert.equal(mp.element.loadVideoById(A, 0), "loaded");
  assert.equal(mp.calls.length, 1);
});

test("hooks via capture-phase DOMContentLoaded, avoids stacking, re-wraps replacement, and rearms on navigation", () => {
  const f = fixture();
  assert.equal(f.handlers.get("DOMContentLoaded")[0].capture, true);
  const mp = f.mountWatchPlayer({ attach: "domcontentloaded" });
  assert.equal(mp.element.loadVideoById(A, 0), undefined);
  assert.deepEqual(mp.calls, []);

  const wrapped = mp.element.loadVideoById;
  mp.mutate();
  f.emit("DOMContentLoaded");
  assert.equal(mp.element.loadVideoById, wrapped);

  const replacementCalls = [];
  mp.element.loadVideoById = function replacement(...args) {
    replacementCalls.push(args);
    return "replaced";
  };
  mp.mutate();
  assert.notEqual(mp.element.loadVideoById.name, "replacement");
  assert.equal(mp.element.loadVideoById(A, 0), undefined);
  assert.deepEqual(replacementCalls, []);

  f.play(A);
  assert.equal(mp.element.loadVideoById(A, 0), "replaced");
  assert.deepEqual(replacementCalls, [[A, 0]]);

  f.navigate(`/watch?v=${B}`);
  mp.setVideoId(B);
  mp.setState(5);
  assert.equal(mp.element.loadVideoById(B, 0), undefined);
  assert.equal(replacementCalls.length, 1);
});
