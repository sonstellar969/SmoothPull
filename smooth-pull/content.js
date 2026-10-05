(() => {
  "use strict";

  // Firefox can leave an old content-script instance alive when a temporary
  // add-on is reloaded. A DOM marker prevents a second instance from adding a
  // second indicator and second wheel handler to the same page.
  const INSTALL_MARKER = "data-pull-to-refresh-installed";
  if (document.documentElement.hasAttribute(INSTALL_MARKER)) return;
  document.documentElement.setAttribute(INSTALL_MARKER, "");

  // Firefox exposes wheel deltas, but does not expose a dependable finger count.
  // These values intentionally favor an intentional, short trackpad gesture.
  const THRESHOLD_PX = 68;
  const MAX_PULL_PX = 150;
  const MIN_EVENTS = 2;
  const RELEASE_DELAY_MS = 110;
  const MOMENTUM_COOLDOWN_MS = 520;
  const RELOAD_GUARD_MS = 1000;
  const TOP_SETTLE_MS = 180;
  const TOP_REARM_GAP_MS = 100;
  const MAX_ARMED_MS = 1200;
  const MAX_EVENT_DELTA_PX = 120;
  const RELOAD_GUARD_KEY = "__pull_to_refresh_reload_at__";

  let indicator = null;
  let pull = 0;
  let eventCount = 0;
  let armed = false;
  let sessionStartedAt = 0;
  let releaseTimer = 0;
  let originalBodyTransform = null;
  let originalBodyTransition = null;
  let visualFrame = 0;
  let renderedPull = 0;
  let visualVelocity = 0;
  let closing = false;
  let ending = false;
  let armedAt = 0;
  let cooldownUntil = 0;
  let gestureActive = false;
  let reloadGuardUntil = 0;
  let mustSettleAtTop = false;
  let reachedTopAt = 0;
  let topNormalEventSeen = false;
  let lastTopNormalAt = 0;
  let lastWheelAt = 0;

  // sessionStorage survives a tab reload. Ignore the inertial tail of the
  // gesture in the new document so it cannot create a second pull indicator.
  try {
    const reloadAt = Number(sessionStorage.getItem(RELOAD_GUARD_KEY));
    if (Number.isFinite(reloadAt) && Date.now() - reloadAt < RELOAD_GUARD_MS) {
      reloadGuardUntil = performance.now() + RELOAD_GUARD_MS;
    } else {
      sessionStorage.removeItem(RELOAD_GUARD_KEY);
    }
  } catch {
    // Restricted documents may not expose sessionStorage.
  }

  function scrollingElement() {
    return document.scrollingElement || document.documentElement;
  }

  function pageIsAtTop() {
    return scrollingElement().scrollTop <= 0 && window.scrollY <= 0;
  }

  function isScrollableY(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const overflow = `${style.overflowY} ${style.overflow}`;
    return /(auto|scroll|overlay)/.test(overflow) &&
      element.scrollHeight > element.clientHeight + 1;
  }

  function eventIsInsideScrollableThatCanConsumeDownwardScroll(event) {
    let node = event.target instanceof Element ? event.target : null;
    while (node && node !== document.documentElement) {
      if (isScrollableY(node)) {
        const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
        // A nested scroller gets first refusal. This prevents a chat pane,
        // modal, code editor, etc. from accidentally starting page refresh.
        if (!atBottom) return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function normalizedDeltaY(event) {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * window.innerHeight;
    return event.deltaY;
  }

  function ensureIndicator() {
    if (indicator || !document.body) return indicator;
    // Reuse an indicator left by an older temporary-script instance instead
    // of creating another visible control.
    indicator = document.getElementById("ptr-indicator");
    if (indicator) return indicator;
    indicator = document.createElement("div");
    indicator.id = "ptr-indicator";
    indicator.setAttribute("aria-live", "polite");
    indicator.setAttribute("aria-hidden", "true");
    indicator.innerHTML = `
      <div class="ptr-card" role="status">
        <span class="ptr-icon" aria-hidden="true"></span>
        <span class="ptr-label">Pull to refresh</span>
      </div>`;
    // Keep the indicator outside <body> so a temporary body translation does
    // not translate the spinner along with the page content.
    document.documentElement.appendChild(indicator);
    return indicator;
  }

  function translatePage(distance) {
    // A WebExtension cannot safely translate an arbitrary site's entire
    // document. Pages such as fast.com repaint live content while measuring;
    // translating <body> at the same time causes the visible oscillation seen
    // in the recordings. Keep movement isolated to the indicator instead.
    void distance;
  }

  function restorePage() {
    if (!document.body || originalBodyTransform === null) return;
    if (originalBodyTransform === "" || originalBodyTransform === "none") {
      document.body.style.transform = originalBodyTransform;
    }
    document.body.style.transition = originalBodyTransition || "";
    originalBodyTransition = null;
    originalBodyTransform = null;
  }

  function applyVisuals() {
    if (!indicator) return;
    // Do not render raw wheel deltas. Trackpad deltas arrive in bursts; the
    // eased target makes the page follow the fingers without shaking.
    if (closing) {
      // Release is deliberately monotonic. A spring can overshoot when the
      // trackpad sends momentum events, which looks like page shaking.
      renderedPull *= 0.78;
      visualVelocity = 0;
    } else {
      const difference = pull - renderedPull;
      visualVelocity += difference * 0.11;
      visualVelocity *= 0.78;
      renderedPull += visualVelocity;
      if (Math.abs(difference) < 0.12 && Math.abs(visualVelocity) < 0.12) {
        renderedPull = pull;
        visualVelocity = 0;
      }
    }
    const progress = Math.min(1, renderedPull / THRESHOLD_PX);
    const distance = Math.min(MAX_PULL_PX, renderedPull * 0.72);
    indicator.style.setProperty("--ptr-progress", progress.toFixed(3));
    indicator.style.setProperty("--ptr-distance", `${distance.toFixed(1)}px`);
    translatePage(distance);
    if (closing && renderedPull < 0.5) {
      visualFrame = 0;
    } else if (Math.abs(pull - renderedPull) > 0.12 || Math.abs(visualVelocity) > 0.12 || pull > 0 || closing) {
      visualFrame = window.requestAnimationFrame(applyVisuals);
    } else {
      visualFrame = 0;
    }
  }

  function requestVisuals() {
    if (!visualFrame) visualFrame = window.requestAnimationFrame(applyVisuals);
  }

  function render() {
    if (!ensureIndicator()) return;
    indicator.classList.toggle("ptr-visible", pull > 0);
    indicator.classList.toggle("ptr-armed", armed);
    indicator.querySelector(".ptr-label").textContent = armed
      ? "Release to refresh"
      : "Pull to refresh";
    requestVisuals();
  }

  function hideIndicator() {
    if (!indicator) return;
    indicator.classList.remove("ptr-visible", "ptr-armed");
    indicator.style.setProperty("--ptr-progress", "0");
    indicator.style.setProperty("--ptr-distance", "0px");
    if (visualFrame) window.cancelAnimationFrame(visualFrame);
    visualFrame = 0;
    visualVelocity = 0;
    restorePage();
  }

  function clearTimers() {
    window.clearTimeout(releaseTimer);
  }

  function resetVisualState() {
    clearTimers();
    pull = 0;
    eventCount = 0;
    armed = false;
    sessionStartedAt = 0;
    armedAt = 0;
    renderedPull = 0;
    visualVelocity = 0;
    hideIndicator();
  }

  function cancelWithMomentumCooldown() {
    if (closing) return;
    resetVisualState();
    gestureActive = false;
    // Do not let the trackpad's late inertial events create a second pull.
    ending = true;
    cooldownUntil = performance.now() + MOMENTUM_COOLDOWN_MS;
  }

  function reloadAfterSmoothRelease() {
    if (closing) return;
    closing = true;
    clearTimers();
    pull = 0;
    armed = false;
    eventCount = 0;
    sessionStartedAt = 0;
    armedAt = 0;
    gestureActive = false;
    ending = true;
    cooldownUntil = performance.now() + RELOAD_GUARD_MS;
    visualVelocity = 0;
    if (indicator) {
      indicator.classList.remove("ptr-armed");
      indicator.classList.add("ptr-visible");
    }
    requestVisuals();
    window.setTimeout(() => {
      hideIndicator();
      restorePage();
      try {
        sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
      } catch {
        // The background reload still works if storage is unavailable.
      }
      browser.runtime
        .sendMessage({ type: "pull-to-refresh-reload" })
        .catch(() => window.location.reload());
    }, 180);
  }

  function finishGesture() {
    if (!pull) return;
    if (armed && eventCount >= MIN_EVENTS) {
      // Let the page and ring ease back before starting the reload.
      reloadAfterSmoothRelease();
      return;
    }
    cancelWithMomentumCooldown();
  }

  function scheduleEnd() {
    window.clearTimeout(releaseTimer);
    releaseTimer = window.setTimeout(finishGesture, RELEASE_DELAY_MS);
  }

  function onWheel(event) {
    if (closing) {
      event.preventDefault();
      return;
    }
    // With macOS natural scrolling, moving two fingers downward produces a
    // negative wheel delta in Firefox. Negate it so `pullDistance` is positive.
    const pullDistance = -normalizedDeltaY(event);

    if (ending) {
      // Swallow only the same downward inertial tail that ended this gesture.
      // A later upward scroll must remain completely normal.
      if (pullDistance > 0 && pullDistance <= MAX_EVENT_DELTA_PX &&
          performance.now() < cooldownUntil && pageIsAtTop()) {
        event.preventDefault();
        return;
      }
      if (performance.now() >= cooldownUntil || pullDistance <= 0) {
        ending = false;
      } else {
        return;
      }
    }

    if (!gestureActive && performance.now() < reloadGuardUntil) {
      if (pullDistance > 0 && pullDistance <= MAX_EVENT_DELTA_PX && pageIsAtTop()) {
        event.preventDefault();
      }
      return;
    }

    const now = performance.now();
    const previousWheelAt = lastWheelAt;
    lastWheelAt = now;

    // Reaching the top while a normal upward scroll is still in progress is
    // not a pull-to-refresh gesture. Require a short quiet period at the top
    // before accepting a new downward burst. This prevents the final inertial
    // packets of a long scroll from refreshing the page.
    if (!pageIsAtTop()) {
      mustSettleAtTop = true;
      reachedTopAt = 0;
      topNormalEventSeen = false;
      lastTopNormalAt = 0;
    } else if (mustSettleAtTop) {
      // Firefox can arrive at scrollTop=0 without delivering a separate
      // wheel packet at exactly that boundary. Start the settle clock on the
      // first event observed at the top, regardless of its direction.
      if (!reachedTopAt) reachedTopAt = now;

      if (pullDistance <= 0) {
        // This is the normal scroll that has arrived at the top. It arms the
        // boundary detector but is never itself a pull-to-refresh gesture.
        if (!reachedTopAt) reachedTopAt = now;
        topNormalEventSeen = true;
        lastTopNormalAt = now;
        return;
      }

      const quietEnough = !previousWheelAt ||
        now - previousWheelAt >= TOP_REARM_GAP_MS;
      if (now - reachedTopAt < TOP_SETTLE_MS || !quietEnough ||
          (topNormalEventSeen && now - lastTopNormalAt < TOP_REARM_GAP_MS)) {
        // Firefox may still dispatch the last packets of the scroll that
        // reached the top. Keep those packets from producing native bounce
        // or page movement; they are not the new pull gesture.
        event.preventDefault();
        return;
      }
      mustSettleAtTop = false;
      reachedTopAt = 0;
      topNormalEventSeen = false;
      lastTopNormalAt = 0;
    }

    // Upward scrolling, horizontal gestures, large mouse-wheel ticks, and
    // pages not at their top are always left completely alone.
    if (pullDistance <= 0 || Math.abs(pullDistance) > MAX_EVENT_DELTA_PX ||
        !pageIsAtTop() || eventIsInsideScrollableThatCanConsumeDownwardScroll(event)) {
      if (pull) {
        // Opposite-direction wheel momentum is the end of this gesture, not
        // a new gesture. Keep the page still and finish exactly once.
        ending = true;
        event.preventDefault();
        window.clearTimeout(releaseTimer);
        releaseTimer = window.setTimeout(finishGesture, 40);
      }
      return;
    }

    // Never restart a gesture just because wheel packets arrived with a gap.
    // Trackpad inertia can have gaps longer than a normal debounce interval;
    // restarting here was what produced a second pull in one swipe.
    if (!gestureActive) {
      gestureActive = true;
      mustSettleAtTop = false;
      reachedTopAt = 0;
      topNormalEventSeen = false;
      lastTopNormalAt = 0;
      sessionStartedAt = now;
    }

    eventCount += 1;
    // Resistance makes the interaction feel less like ordinary scrolling.
    pull = Math.min(MAX_PULL_PX, pull + pullDistance * 0.72);
    armed = eventCount >= MIN_EVENTS && pull >= THRESHOLD_PX;
    if (armed && !armedAt) armedAt = now;

    // At the top, the browser has no useful vertical movement to perform.
    // Preventing only this validated downward sequence keeps the page still
    // while the indicator is visible and does not affect ordinary scrolling.
    event.preventDefault();
    render();
    scheduleEnd();

    if (armed && now - armedAt >= MAX_ARMED_MS) finishGesture();

  }

  document.addEventListener("wheel", onWheel, { capture: true, passive: false });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureIndicator, { once: true });
  } else {
    ensureIndicator();
  }
})();
