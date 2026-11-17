// ==UserScript==
// @name              YouTube Stop Autoplay
// @name:ko           YouTube 자동 재생 중지
// @name:ja           YouTube 自動再生停止
// @name:zh-CN        YouTube 停止自动播放
// @name:zh-TW        YouTube 停止自動播放
// @name:es           Detener la reproducción automática de YouTube
// @name:fr           Arrêter la lecture automatique sur YouTube
// @name:de           YouTube-Autowiedergabe stoppen
// @name:pt-BR        Parar a reprodução automática do YouTube
// @name:ru           Остановка автовоспроизведения YouTube
// @namespace         https://github.com/csjune
// @version           1.0
// @description       Prevents automatic playback when opening videos, live streams, or Shorts. Play them yourself when ready.
// @description:ko    동영상, 라이브, 쇼츠를 열 때 자동 재생을 막습니다. 직접 재생하면 그대로 재생됩니다.
// @description:ja    動画、ライブ配信、ショートを開いたときの自動再生を停止します。手動で再生できます。
// @description:zh-CN 打开视频、直播或 Shorts 时阻止自动播放。手动播放后不再干预。
// @description:zh-TW 開啟影片、直播或 Shorts 時阻止自動播放。手動播放後不再干預。
// @description:es    Evita la reproducción automática al abrir vídeos, directos o Shorts. Puedes reproducirlos manualmente.
// @description:fr    Empêche la lecture automatique à l’ouverture des vidéos, des directs et des Shorts. Vous pouvez lancer la lecture manuellement.
// @description:de    Verhindert die automatische Wiedergabe beim Öffnen von Videos, Livestreams und Shorts. Du kannst sie manuell starten.
// @description:pt-BR Impede a reprodução automática ao abrir vídeos, transmissões ao vivo e Shorts. Você pode iniciar a reprodução manualmente.
// @description:ru    Предотвращает автовоспроизведение при открытии видео, трансляций и Shorts. Воспроизведение можно начать вручную.
// @author            csjune
// @license           MIT
// @homepageURL       https://github.com/csjune/yt-userscripts/tree/main/stop-autoplay
// @supportURL        https://github.com/csjune/yt-userscripts/issues
// @match             https://www.youtube.com/*
// @run-at            document-start
// @early-start
// @inject-into       page
// @sandbox           raw
// @grant             none
// @noframes
// ==/UserScript==

(() => {
  "use strict";

  const SHORTS_CONTEXT = "WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_SHORTS";
  const PLAYER_CONTEXTS = ["WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH", SHORTS_CONTEXT];
  const prepared = new WeakSet();
  const attached = new WeakSet();
  const shortsConfigs = new WeakSet();
  const shortsPlayers = new WeakSet();
  const shortsControllers = new WeakSet();
  const playerFactories = new WeakSet();
  let visitKey = null;
  let started = false;
  let shortsId = null;
  let shortsStarted = false;
  let shortsLoadDepth = 0;

  function isShortsPage() {
    return /^\/shorts(?:\/|$)/.test(location.pathname);
  }

  function currentVideoId() {
    if (location.pathname === "/watch") {
      return new URLSearchParams(location.search).get("v");
    }
    if (/^\/shorts\/?$/.test(location.pathname)) {
      return window.ytInitialPlayerResponse?.videoDetails?.videoId || null;
    }
    return location.pathname.match(/^\/(?:live|shorts)\/([^/]+)\/?$/)?.[1] || null;
  }

  function updateVisit() {
    const id = currentVideoId();
    const key = id ? `${isShortsPage() ? "shorts" : "watch"}:${id}` : null;
    if (key !== visitKey) {
      visitKey = key;
      started = false;
    }
    return id;
  }

  function prepare(response) {
    const id = response.videoDetails?.videoId;
    if (typeof id !== "string" || !/^[\w-]{11}$/.test(id) || !response.playerConfig) return;
    const config = response.playerConfig.playbackStartConfig ||= {};
    if (prepared.has(config)) return;
    let original = config.startPaused;
    // YouTube selects cueVideoByPlayerVars instead of loadVideoByPlayerVars.
    // Read the current route at consumption time, including prefetched responses.
    Object.defineProperty(config, "startPaused", {
      configurable: true,
      enumerable: true,
      get() {
        if (isShortsPage() && shortsId === id && shortsStarted) return original;
        // A seedless /shorts/ entry starts with a placeholder player response.
        if (/^\/shorts\/?$/.test(location.pathname)) return true;
        // Shorts loads the next response before updating the URL or page data.
        if (shortsConfigs.has(config) && (isShortsPage() || shortsLoadDepth)) {
          return shortsId === id && !shortsStarted ? true : original;
        }
        return updateVisit() === id && !started ? true : original;
      },
      set(value) { original = value; },
    });
    prepared.add(config);
  }

  function inspect(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    try {
      prepare(value);
      if (Array.isArray(value)) {
        for (const item of value) inspect(item, seen);
      } else {
        for (const key of ["playerResponse", "player_response", "raw_player_response", "response", "data"]) {
          inspect(value[key], seen);
        }
      }
    } catch {
      // A frozen response or another extension's accessor must not break parsing.
    }
    return value;
  }

  function observe(owner, key, transform) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    let value = transform(owner[key]);
    if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) return;
    Object.defineProperty(owner, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get() { return value; },
      set(next) { value = transform(next); },
    });
  }

  function configure(key, value) {
    if (!value || typeof value !== "object") return;
    try {
      if (key === "WEB_PLAYER_CONTEXT_CONFIGS") {
        for (const context of PLAYER_CONTEXTS) {
          const player = value[context];
          if (!player) continue;
          // The initial bootstrap player honors startPaused only with this flag.
          // YouTube player 53caf627: oL -> JPa (45872076).
          const flags = new URLSearchParams(player.serializedClientExperimentFlags);
          flags.set("45872076", "true");
          player.serializedClientExperimentFlags = flags.toString();
        }
      } else if (key === "EXPERIMENT_FLAGS") {
        // Keep the cued bootstrap player idle when the watch page adopts it.
        value.main_app_preserve_cued_bootstrap_player = true;
        value.web_fix_bootstrap_player_play_unstarted = true;
      }
    } catch {
      // Leave immutable configuration alone.
    }
  }

  function attach(config) {
    if (!config || typeof config !== "object" || attached.has(config) || typeof config.set !== "function") return config;
    // Do not call config.get here: during global assignment it refers to ytcfg
    // before the assignment has completed.
    const data = window.yt?.config_ || config.data_;
    for (const key of ["WEB_PLAYER_CONTEXT_CONFIGS", "EXPERIMENT_FLAGS"]) configure(key, data?.[key]);
    const original = config.set;
    try {
      config.set = new Proxy(original, {
        apply(target, receiver, args) {
          if (args.length > 1) configure(args[0], args[1]);
          else if (args[0] && typeof args[0] === "object") {
            for (const key of ["WEB_PLAYER_CONTEXT_CONFIGS", "EXPERIMENT_FLAGS"]) configure(key, args[0][key]);
          }
          return Reflect.apply(target, receiver, args);
        },
      });
      attached.add(config);
    } catch {
      // Another extension may have made set read-only.
    }
    return config;
  }

  function attachShortsPlayer(element) {
    if (shortsPlayers.has(element) || typeof element.loadVideoWithPlayerResponse !== "function") return;
    const original = element.loadVideoWithPlayerResponse;
    const wrapped = function(response, ...args) {
      if (element.context !== SHORTS_CONTEXT) return Reflect.apply(original, this, [response, ...args]);
      const id = response?.videoDetails?.videoId;
      if (typeof id === "string" && /^[\w-]{11}$/.test(id)) {
        if (id !== shortsId) {
          shortsId = id;
          shortsStarted = false;
        }
        inspect(response);
        // Prefetch can copy the response while sharing its playback config.
        const config = response.playerConfig?.playbackStartConfig;
        if (config && typeof config === "object") shortsConfigs.add(config);
        // A newly constructed unified player selects cue from args.autoplay.
        if (!shortsStarted) args[0] = { ...args[0], autoplay: "0" };
      }
      shortsLoadDepth++;
      try {
        return Reflect.apply(original, this, [response, ...args]);
      } finally {
        shortsLoadDepth--;
      }
    };
    try {
      element.loadVideoWithPlayerResponse = wrapped;
      shortsPlayers.add(element);
    } catch {
      // A read-only method must not break YouTube's component creation.
    }
  }

  function attachPlayerFactory(constructor) {
    const prototype = constructor?.prototype;
    if (!prototype || playerFactories.has(prototype) || typeof prototype.createElement !== "function") return;
    const original = prototype.createElement;
    const wrapped = function(...args) {
      const result = Reflect.apply(original, this, args);
      attachShortsPlayer(this);
      return result;
    };
    try {
      prototype.createElement = wrapped;
      playerFactories.add(prototype);
    } catch {
      // Keep custom element registration working if another extension locks it.
    }
  }

  // A first Shorts load can run synchronously, before a DOM observer sees it.
  if (typeof customElements !== "undefined") {
    attachPlayerFactory(customElements.get("ytd-player"));
    try {
      customElements.define = new Proxy(customElements.define, {
        apply(target, receiver, args) {
          if (args[0] === "ytd-player") attachPlayerFactory(args[1]);
          return Reflect.apply(target, receiver, args);
        },
      });
    } catch {
      // The DOM observer can still handle already mounted players.
    }
  }

  function refreshShorts() {
    for (const element of document.querySelectorAll(`ytd-player[context="${SHORTS_CONTEXT}"]`)) {
      attachShortsPlayer(element);
    }

    const controller = document.querySelector("ytd-shorts")?.polymerController;
    if (!controller) return;
    if (!shortsControllers.has(controller) && typeof controller.togglePlayPauseVideo === "function") {
      const original = controller.togglePlayPauseVideo;
      controller.togglePlayPauseVideo = function(...args) {
        // YouTube's keyboard handler normally resumes only state 2 (paused).
        if (this.player?.getPlayerState?.() === 5) return this.player.playVideo();
        return Reflect.apply(original, this, args);
      };
      shortsControllers.add(controller);
    }

    const player = controller.player;
    if (!isShortsPage() || player?.getPlayerState?.() !== 5) return;
    const id = player.getVideoData?.()?.video_id;
    if (!id || controller.playerData?.videoDetails?.videoId !== id) return;
    // Normally Shorts moves the player into the new card only after playback.
    if (controller.currentPlayerIndex !== controller.index || !controller.playerInPosition) {
      controller.movePlayerToVideo?.(controller.index);
    }
    if (!controller.isPlayerPaused) controller.isPlayerPaused = true;
  }

  function onNavigate() {
    updateVisit();
    if (!isShortsPage()) {
      shortsId = null;
      shortsStarted = false;
    }
    refreshShorts();
  }

  observe(window, "ytInitialPlayerResponse", inspect);
  observe(window, "ytcfg", attach);
  JSON.parse = new Proxy(JSON.parse, {
    apply(target, receiver, args) { return inspect(Reflect.apply(target, receiver, args)); },
  });
  if (typeof Response !== "undefined") {
    Response.prototype.json = new Proxy(Response.prototype.json, {
      apply(target, receiver, args) {
        return Reflect.apply(target, receiver, args).then(value => inspect(value));
      },
    });
  }

  // Once playback starts, leave that visit alone, including ads and recovery.
  document.addEventListener("play", event => {
    const id = updateVisit();
    const shortsPlayer = event.target.closest?.("#shorts-player");
    if (shortsPlayer && isShortsPage()) {
      const playingId = shortsPlayer.getVideoData?.()?.video_id || id;
      if (shortsId && playingId !== shortsId) return;
      shortsId = playingId;
      shortsStarted = true;
      if (shortsId === id) started = true;
      return;
    }
    const watch = event.target.closest?.("ytd-watch-flexy");
    if (id && watch?.getAttribute("video-id") === id && event.target.closest("#movie_player")) started = true;
  }, true);
  document.addEventListener("keydown", event => {
    if (!isShortsPage() || event.code !== "Space" || event.defaultPrevented ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
    const target = event.target;
    if (target !== document.body && target !== document.documentElement && !target.closest?.("#shorts-player")) return;
    const control = target.closest?.("button, a, input, textarea, select, [contenteditable], [role='button']");
    if (control && !control.classList?.contains("ytp-large-play-button")) return;
    const player = document.querySelector("ytd-shorts")?.polymerController?.player;
    if (player?.getPlayerState?.() !== 5) return;
    // The native player swallows Space in state 5 before Shorts can handle it.
    event.preventDefault();
    event.stopImmediatePropagation();
    player.playVideo();
  }, true);
  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);
  new MutationObserver(refreshShorts).observe(document, { childList: true, subtree: true });
  refreshShorts();
})();
