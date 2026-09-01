/*
 * לומדת צעדים ומונים — runtime.
 *
 * Behaviour only. Every string the learner reads is already in index.html as
 * static markup, so the QA harness can count screens and read copy without
 * executing anything; this file adds navigation, answer checking, scoring and the
 * two popups.
 *
 * The Metodika QA contract (learned the hard way on לומדת כימיה 1, which was
 * finished and correct but reported "0 pages"):
 *   - this file and styles.css sit at the repo ROOT, not under js/ and css/
 *   - `goTo`, `TOTAL_SCREENS` and `lomdaState` are top-level globals, NOT wrapped
 *     in an IIFE — the harness reads them off `window`
 *   - screens are 1-based: <section class="screen" data-screen="1..N">
 *   - it posts LOMDA_SCREEN_CHANGED and LOMDA_COMPLETE to window.parent
 *   - no SCORM
 * Do not "tidy" any of that into a module.
 */

/* global window, document */

var TOTAL_SCREENS = 0;
var currentScreen = 1;

var lomdaState = {
  screen: 1,
  score: 0,
  answers: {},        // slug -> {correct, given, scored}
  attempts: {},       // slug -> count
  started: false,
  complete: false
};

// Marks available per top-level question. Eight questions, equal weight; שאלה 1
// splits three ways across א/ב/ג and שאלה 2 two ways, so a sub-part carries a
// fraction of one question's marks. Slide 34: 70 and above reports success.
var MARKS_PER_QUESTION = 100 / 8;
var PASS_SCORE = 70;

var screens = [];
var byQuestion = {};


/* ------------------------------------------------------------------ helpers */

function $(sel, root) {
  return (root || document).querySelector(sel);
}

function $$(sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
}

/*
 * Scale the 1920x1080 stage to fit the viewport.
 *
 * This has to happen in JS: the stylesheet can centre the stage but cannot know
 * the viewport ratio. Without it the stage overflows at any size below 1920 wide,
 * `overflow: hidden` clips the rest, and the learner sees the top-left corner with
 * the navigation arrows off-screen — which looks exactly like "only the first
 * screen works".
 */
function fitStage() {
  var app = document.getElementById('app');
  if (!app) return;
  var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  app.style.transform = 'scale(' + scale + ')';
}

function post(type, extra) {
  var msg = {
    type: type,
    screen: currentScreen,
    total: TOTAL_SCREENS,
    score: Math.round(lomdaState.score)
  };
  if (extra) {
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
    }
  }
  try {
    if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
  } catch (e) { /* cross-origin parent: nothing to do */ }
}

/* Numbers arrive as "6,000" or " 200 " or "0.6"; compare by value, not by text. */
function toNumber(raw) {
  if (raw === null || raw === undefined) return NaN;
  var s = String(raw).replace(/[\s, ]/g, '');
  if (s === '') return NaN;
  return Number(s);
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  var x = a.slice().sort(), y = b.slice().sort();
  for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}


/* --------------------------------------------------------------- navigation */

function goTo(n) {
  n = Math.max(1, Math.min(TOTAL_SCREENS, Number(n) || 1));
  var sections = $$('#app > .screen');
  for (var i = 0; i < sections.length; i++) {
    var on = Number(sections[i].getAttribute('data-screen')) === n;
    if (on) sections[i].classList.add('active');
    else sections[i].classList.remove('active');
  }
  currentScreen = n;
  lomdaState.screen = n;
  lomdaState.started = true;

  closePopups();
  syncIndicator(n);
  var sec = sectionFor(n);
  if (sec) {
    layoutOptions(sec);
    placeSubmitBelowContent(sec);
    // Re-apply a recorded result: stepping back to an answered question must show
    // it exactly as the learner left it, not reset to a blank field.
    showResult(sec);
    if (sec.getAttribute('data-question')) updateSubmitVisibility(sec);
    // The narration bubble floats in on every screen it appears on. A real
    // <video> (video1) reveals it once play is pressed -- see initVideo(). Every
    // other screen -- story, closing, and the placeholder video screens whose
    // footage has not been delivered, where the play button does not actually
    // play anything yet -- has nothing to wait for, so it floats in as soon as
    // the screen is shown, matching what the design's own static renders show.
    //
    // Adding .in in the exact same tick as `.active` (display:none -> block,
    // just above) gave the browser nothing to transition from: it had never
    // committed the resting opacity:0 state, so it just rendered the end state
    // directly and the "float in" was invisible -- the section only ever looked
    // static. A `requestAnimationFrame` fix worked in a real browser but hung
    // this same code under headless Chrome's --virtual-time-budget, which does
    // not reliably run rAF callbacks without a real compositor -- the standard,
    // synchronous fix is to force a layout flush between the two class changes
    // (reading a layout property makes the browser commit styles up to that
    // point right then, before the next line moves them) rather than waiting
    // for a future frame at all.
    var bub = $('.ribbon-bubble', sec);
    var revealBub = bub && !$('.video-el', sec);
    // A question screen's own text/options float in the same way, but has no
    // bubble to piggyback the reflow on -- read layout on the SECTION itself
    // instead, which forces the same commit-then-transition sequence (see the
    // long comment above) whether or not this screen has a bubble at all.
    var floatEls = $$('.q-label, .q-stem, .opt, .answer', sec);
    if (revealBub || floatEls.length) {
      void sec.offsetWidth;
      if (revealBub) bub.classList.add('in');
      floatEls.forEach(function (el) { el.classList.add('in'); });
    }
    var focusable = $('.q-input, .opt input, .btn-check, .nav-fwd', sec);
    if (focusable) { try { focusable.focus({ preventScroll: true }); } catch (e) {} }
  }
  post('LOMDA_SCREEN_CHANGED');
}

function sectionFor(n) {
  return $('#app > .screen[data-screen="' + n + '"]');
}

function next() { goTo(currentScreen + 1); }
function prev() { goTo(currentScreen - 1); }

/* The indicator lives once per screen; light the step this screen belongs to. */
/* The progress strip is now a per-step PNG baked into each screen, so there is
   nothing to toggle. Kept for the CSS-drawn fallback and harmless without it. */
function syncIndicator(n) {
  var sec = sectionFor(n);
  if (!sec) return;
  var step = Number(sec.getAttribute('data-step')) || 0;
  $$('.indicator', sec).forEach(function (ind) {
    $$('.step', ind).forEach(function (el) {
      var s = Number(el.getAttribute('data-step'));
      el.classList.toggle('current', s === step);
      el.classList.toggle('done', s < step);
    });
  });
}


/* ------------------------------------------------------------------ popups */

function closePopups() {
  $$('.popup.open').forEach(function (p) {
    p.classList.remove('open');
    // Reset the bubble so the NEXT open floats it in again -- unlike a narration
    // bubble (shown once per screen), a popup can be opened and closed repeatedly.
    var pb = $('.ribbon-bubble', p);
    if (pb) pb.classList.remove('in');
  });
  $$('.screen.popup-open').forEach(function (s) { s.classList.remove('popup-open'); });
  $$('[aria-expanded="true"]').forEach(function (b) {
    b.setAttribute('aria-expanded', 'false');
  });
  $$('.zoom-overlay.open').forEach(function (z) { z.classList.remove('open'); });
}

function togglePopup(btn) {
  var sec = btn.closest('.screen');
  var target = $('.popup[data-popup="' + btn.getAttribute('data-opens') + '"]', sec);
  if (!target) return;
  var isOpen = target.classList.contains('open');
  closePopups();
  if (!isOpen) {
    target.classList.add('open');
    if (sec) sec.classList.add('popup-open');
    btn.setAttribute('aria-expanded', 'true');
    // The step-ruler applet is an iframe; load it on first open, not on page load,
    // so 16 screens do not each fetch it up front.
    var frame = $('iframe[data-src]', target);
    if (frame && !frame.getAttribute('src')) {
      frame.setAttribute('src', frame.getAttribute('data-src'));
    }
    fitHelpText(target);
    // Floats in like every other narration bubble. The reflow-then-add pairing
    // is the same fix as goTo()'s immediate reveal -- .popup.open just switched
    // this from display:none to block in the line above, so without forcing a
    // layout flush first, .in would have nothing to transition from.
    var tb = $('.ribbon-bubble', target);
    if (tb) { void tb.offsetWidth; tb.classList.add('in'); }
    var close = $('.popup-close', target);
    if (close) { try { close.focus({ preventScroll: true }); } catch (e) {} }
  }
}

/*
 * The help bubble now wraps its own text (see design.py HELP_BOX_MAX_W and the
 * .help-box CSS) instead of the other way around, so it needs no per-open sizing
 * at all -- the eight help texts range from one line to five, and each just gets
 * a box shaped for its own length, at the same 36px as the question text.
 *
 * The one thing that still needs a runtime check: a box tall enough to run past
 * the frame. None of the eight actually do, but the box is content-sized rather
 * than fixed, so a future help text could be long enough to -- this is the same
 * shrink-as-a-last-resort fallback every other auto-sized box in the unit uses
 * (the feedback panel, the wrapped option column), not a routine step.
 */
var HELP_FS_MIN = 24;      // design.py HELP_FS_MIN

function fitHelpText(popup) {
  var box = $('.help-box', popup);
  var el = $('.help-text', popup);
  if (!box || !el) return;
  var maxH = Number(popup.getAttribute('data-help-max-h')) || 1e9;
  var fs = Number(getComputedStyle(el).fontSize.replace('px', ''));
  for (; fs >= HELP_FS_MIN; fs--) {
    el.style.fontSize = fs + 'px';
    if (box.offsetHeight <= maxH) return;
  }
}


/* ------------------------------------------------------- answer collection */

function readAnswer(sec) {
  var kind = sec.getAttribute('data-kind');
  if (kind === 'input') {
    var field = $('.q-input', sec);
    return field ? field.value : '';
  }
  if (kind === 'choice') {
    var picked = $$('.opt input:checked', sec).map(function (i) {
      return Number(i.getAttribute('data-index'));
    });
    return picked;
  }
  if (kind === 'drag') {
    return $$('.slot', sec).map(function (s) {
      return s.getAttribute('data-filled') || '';
    });
  }
  return null;
}

function isAnswered(sec) {
  var given = readAnswer(sec);
  var kind = sec.getAttribute('data-kind');
  if (kind === 'input') return String(given).trim() !== '';
  if (kind === 'choice') return given.length > 0;
  if (kind === 'drag') {
    return given.length > 0 && given.every(function (v) { return v !== ''; });
  }
  return true;
}

// The submit button only appears once there is something to submit -- see
// .screen.has-answer .btn-check in styles.tmpl.css. Reuses isAnswered() rather
// than re-deriving "is this question answered", so the two can never disagree.
function updateSubmitVisibility(sec) {
  sec.classList.toggle('has-answer', isAnswered(sec));
}

function grade(sec, given) {
  var raw = sec.getAttribute('data-answer');
  if (!raw) return null;
  var key = JSON.parse(raw);
  if (key.kind === 'number') return toNumber(given) === toNumber(key.value);
  if (key.kind === 'single') return given.length === 1 && given[0] === key.value;
  if (key.kind === 'multi') return sameSet(given, key.value);
  if (key.kind === 'drag') {
    if (given.length !== key.value.length) return false;
    for (var i = 0; i < key.value.length; i++) {
      if (toNumber(given[i]) !== toNumber(key.value[i])) return false;
    }
    return true;
  }
  return null;
}


/* --------------------------------------------------------------- checking */

function check(sec) {
  var slug = sec.getAttribute('data-question');
  if (!isAnswered(sec)) {
    flash(sec, 'בחרו תשובה לפני הבדיקה');
    return;
  }
  var given = readAnswer(sec);
  var correct = grade(sec, given);

  lomdaState.attempts[slug] = (lomdaState.attempts[slug] || 0) + 1;

  // Marks are awarded on the first check only, so revisiting a screen cannot
  // farm score. The learner may still change their answer and see the feedback
  // again; only the recorded mark is frozen.
  var already = lomdaState.answers[slug];
  var scored = already ? already.scored : null;
  if (scored === null || scored === undefined) {
    var weight = Number(sec.getAttribute('data-weight')) || 0;
    scored = correct ? MARKS_PER_QUESTION * weight : 0;
    lomdaState.score = Math.round((lomdaState.score + scored) * 100) / 100;
  }
  lomdaState.answers[slug] = { correct: correct, given: given, scored: scored };

  showResult(sec);
}

/*
 * Put the feedback panel somewhere it can actually be read.
 *
 * One fixed rect served all eleven questions, and it does not fit them: שאלה 1ג's
 * explanation ran out through the bottom of the white frame, and שאלה 3's ran off
 * the screen while also covering the artwork. The text extents only exist once the
 * text is laid out, so the box is chosen here rather than in the generator.
 *
 * The design's own position is tried first and kept whenever the text fits there,
 * so screens the designer drew still match her drawing. Otherwise the panel moves
 * to the largest empty rectangle inside the frame and its font shrinks to fit --
 * which is how it ends up widened to the right on שאלה 1ג and in the empty column
 * on שאלה 3, both of which is what the design intends.
 */
var FB_OCCUPIED = '.q-label, .q-stem, .opt, .graphic, .applet-inline, .answer,' +
                  ' .btn-check, .cell, .video-slot, img.art';
// Art below this z-index is the full-bleed background, which is not something the
// panel can avoid -- treating it as occupied would leave nowhere to go at all.
var FB_ART_MIN_Z = 11;
var FB_GRID = 8;

// Matches every .screen.graded[data-slug="..."] {.applet-inline,.graphic}
// {scale(...)} rule (top-left anchored) in styles.tmpl.css -- the element is
// still there once graded, just smaller, and boxOf() (which reads
// offsetWidth/Height, not affected by a CSS transform) needs telling how big
// it actually ended up. Keep this in sync with those rules. q2b's own graded
// rule is display:none instead, which already drops out via the
// offsetWidth/Height checks below -- no entry needed there. q2a's applet no
// longer shrinks once graded, so it no longer needs an entry either.
var GRADED_SHRINK = {
  q5: {sel: '.graphic', scale: 0.55},
  q7: {sel: '.graphic', scale: 0.85},
};

// Mirrors BANK_GRADED_X/BANK_GRADED_Y0/BANK_GRADED_PITCH in design.py -- q4's
// leftover-token animation target once graded (see showResult()'s drag
// branch). Keep the two in sync.
var GRADED_BANK_COL = {x: 190, y0: 330, pitch: 101 + 14};

function boxOf(el, sec) {
  var l = 0, t = 0, n = el;
  while (n && n !== sec) { l += n.offsetLeft; t += n.offsetTop; n = n.offsetParent; }
  var w = el.offsetWidth, h = el.offsetHeight;
  var shrink = GRADED_SHRINK[sec.getAttribute('data-slug')];
  if (shrink && el.classList.contains(shrink.sel.slice(1)) && sec.classList.contains('graded')) {
    w *= shrink.scale;
    h *= shrink.scale;
  }
  return {l: l, t: t, r: l + w, b: t + h};
}

function visibleBoxes(sec, panel) {
  var out = [];
  var graded = sec.classList.contains('graded');
  $$(FB_OCCUPIED, sec).forEach(function (el) {
    if (el === panel || panel.contains(el)) return;
    // Once graded, a leftover .cell.token is mid-animation to
    // GRADED_BANK_COL (see showResult()'s drag branch), out of the panel's
    // way on purpose -- and offsetLeft/offsetTop on a property under an
    // active CSS transition reflects the CURRENT INTERPOLATED value, not the
    // animation's target, so measuring it here is unreliable (it read the
    // pre-move position entirely, not even a mid-flight one, when checked:
    // querying it in the same tick as the style change that starts the
    // transition raced the transition itself, same class of bug the reveal
    // animation in goTo() already has a long comment about). Skip it rather
    // than measure a value that cannot be trusted either way.
    if (graded && el.classList.contains('token')) return;
    if (!el.offsetWidth || !el.offsetHeight) return;      // display:none
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden') return;
    if (el.tagName === 'IMG' && el.classList.contains('art') &&
        (Number(cs.zIndex) || 0) < FB_ART_MIN_Z) return;
    out.push(boxOf(el, sec));
  });
  return out;
}

function overlaps(a, b) {
  return a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
}

/* Largest all-free rectangle over a coarse occupancy grid. Standard
   largest-rectangle-in-histogram, run once per row. */
function largestFreeRect(inner, taken) {
  var cols = Math.floor((inner.r - inner.l) / FB_GRID);
  var rows = Math.floor((inner.b - inner.t) / FB_GRID);
  if (cols < 4 || rows < 3) return null;
  var free = new Uint8Array(cols * rows);
  for (var y = 0; y < rows; y++) {
    for (var x = 0; x < cols; x++) {
      var cell = {l: inner.l + x * FB_GRID, t: inner.t + y * FB_GRID,
                  r: inner.l + (x + 1) * FB_GRID, b: inner.t + (y + 1) * FB_GRID};
      var busy = false;
      for (var k = 0; k < taken.length; k++) {
        if (overlaps(cell, taken[k])) { busy = true; break; }
      }
      free[y * cols + x] = busy ? 0 : 1;
    }
  }
  var height = new Int32Array(cols), found = [];
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      height[c] = free[r * cols + c] ? height[c] + 1 : 0;
    }
    var stack = [];
    for (var i = 0; i <= cols; i++) {
      var h = (i === cols) ? 0 : height[i];
      while (stack.length && height[stack[stack.length - 1]] >= h) {
        var top = stack.pop();
        var left = stack.length ? stack[stack.length - 1] + 1 : 0;
        var w = i - left, hh = height[top];
        // prefer wide over tall at equal area: a wide block reads better
        var score = w * hh * (w >= hh ? 1.15 : 1);
        if (hh >= 3 && w >= 4) {
          found.push({score: score,
                      l: inner.l + left * FB_GRID, t: inner.t + (r - hh + 1) * FB_GRID,
                      r: inner.l + i * FB_GRID, b: inner.t + (r + 1) * FB_GRID});
        }
      }
      stack.push(i);
    }
  }
  // Every candidate, best first -- not just the single biggest. The biggest block
  // can be too SHORT for the text, and forcing the panel into it and then clamping
  // it back inside the frame is what put שאלה 5's panel on top of the map.
  found.sort(function (a, b) { return b.score - a.score; });
  return found;
}

function fitPanel(panel, body, w, maxH, fsMin) {
  panel.style.width = w + 'px';
  // Starts at the same size as the question text itself (--fb-fs / STEM_FS in
  // design.py, both 36) -- "same size as the question" is the rule; shrinking
  // only kicks in when a screen genuinely has no room at that size.
  for (var fs = 36; fs >= fsMin; fs--) {
    body.style.fontSize = fs + 'px';
    if (panel.offsetHeight <= maxH) return true;
  }
  return false;
}

/*
 * Stack a wrapped option column from measured heights.
 *
 * The fixed 51px pitch is right for one-line options and wrong for wrapped ones --
 * they would overlap each other. Shrinks the column's font only if the stack would
 * otherwise run out of the frame.
 */
function layoutOptions(sec) {
  var opts = $$('.opt', sec);
  if (!opts.length) return;
  var fr = (sec.getAttribute('data-frame') || '').split(',').map(Number);
  if (fr.length !== 4) return;
  var gap = Number(sec.getAttribute('data-opt-gap')) || 16;
  var fsMin = Number(sec.getAttribute('data-opt-fs-min')) || 24;
  var limit = fr[1] + fr[3] - 22;
  var wrapped = opts[0].classList.contains('wrap');

  // The design's own y for the column, remembered before anything moves it, so
  // repeated calls stay idempotent.
  if (!opts[0].hasAttribute('data-top0')) {
    opts.forEach(function (o) { o.setAttribute('data-top0', parseFloat(o.style.top) || 0); });
  }
  var top0 = Number(opts[0].getAttribute('data-top0')) || 0;

  // Start below the question text. The stem's height depends on the width it wraps
  // at, so this cannot be a constant: narrowing the column to keep the stem off the
  // artwork turned שאלה 2א's one-line stem into three, and the first option then sat
  // on top of the last line.
  var stem = $('.q-stem', sec);
  var start = top0;
  if (stem && stem.offsetHeight) {
    start = Math.max(top0, stem.offsetTop + stem.offsetHeight + 20);
  }

  if (!wrapped) {
    // single-line options keep the design's pitch, only shifted down as needed
    var shift = start - top0;
    if (shift <= 0) return;
    opts.forEach(function (o) {
      o.style.top = (Number(o.getAttribute('data-top0')) + shift) + 'px';
    });
    return;
  }

  for (var fs = 34; fs >= fsMin; fs--) {
    opts.forEach(function (o) { o.style.fontSize = fs + 'px'; o.style.top = ''; });
    var y = start;
    for (var i = 0; i < opts.length; i++) {
      opts[i].style.top = y + 'px';
      y += opts[i].offsetHeight + gap;
    }
    if (y - gap <= limit) return;
  }
}

/* The submit ("צדקתי") button sits under the applet on every other question,
   but on a screen with an INLINE applet (שאלה 2א and 2ב) the applet fills the
   whole left column now (see .applet-inline in styles.tmpl.css), so that spot
   is gone -- data-submit-follows marks these screens to move the button under
   the question TEXT/options column instead, centred under whichever of the
   two is actually there. Horizontal centring is always computed from rendered
   geometry (layoutOptions() may already have shifted the options down to
   clear a taller-than-default stem, so it cannot be a fixed number); the
   vertical position is too UNLESS the screen sets data-submit-top, which
   pins it regardless of content height (q2b wants a fixed y). data-submit-left
   is the same idea horizontally (q2b again): pins x instead of centring. */
function placeSubmitBelowContent(sec) {
  if (!sec.hasAttribute('data-submit-follows')) return;
  var btn = $('.btn-check', sec);
  if (!btn) return;
  var stem = $('.q-stem', sec);
  var opts = $$('.opt', sec);
  var blocks = opts.length ? opts : (stem ? [stem] : []);
  if (!blocks.length) return;
  var left = Infinity, right = -Infinity, bottom = -Infinity;
  blocks.forEach(function (el) {
    left = Math.min(left, el.offsetLeft);
    right = Math.max(right, el.offsetLeft + el.offsetWidth);
    bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
  });
  var fixedTop = sec.getAttribute('data-submit-top');
  var fixedLeft = sec.getAttribute('data-submit-left');
  btn.style.left = (fixedLeft !== null ? Number(fixedLeft)
    : Math.round(left + (right - left - btn.offsetWidth) / 2)) + 'px';
  btn.style.top = (fixedTop !== null ? Number(fixedTop) : Math.round(bottom + 30)) + 'px';
}

function placeFeedback(sec) {
  var panel = $('.fb-panel', sec);
  if (!panel) return;
  var body = $('.fb-body', panel);
  var fr = (sec.getAttribute('data-frame') || '').split(',').map(Number);
  if (fr.length !== 4) return;
  var pad = Number(sec.getAttribute('data-fb-pad')) || 22;
  var fsMin = Number(sec.getAttribute('data-fb-fs-min')) || 19;
  var inner = {l: fr[0] + pad, t: fr[1] + pad,
               r: fr[0] + fr[2] - pad, b: fr[1] + fr[3] - pad};

  panel.style.minHeight = '';
  body.style.fontSize = '';

  // Stage 1 of the drag reveal (see showResult()'s drag branch) reads its
  // OWN box (data-prompt-box, set in feedback() in build_lomda.py only when
  // that stage's prompt is shorter/positioned differently than stage 2's
  // full explanation) instead of data-design-box while .needs-reveal is set.
  var boxAttr = panel.classList.contains('needs-reveal') && panel.hasAttribute('data-prompt-box')
    ? 'data-prompt-box' : 'data-design-box';
  var d = (panel.getAttribute(boxAttr) || '').split(',').map(Number);
  var taken = visibleBoxes(sec, panel);

  // 1. the design's own box, if the text fits there and it covers nothing
  if (d.length === 3) {
    panel.style.left = d[0] + 'px';
    panel.style.top = d[1] + 'px';
    panel.style.width = d[2] + 'px';
    var box = {l: d[0], t: d[1], r: d[0] + d[2], b: d[1] + panel.offsetHeight};
    var clean = box.b <= inner.b && box.l >= inner.l && box.r <= inner.r &&
                !taken.some(function (t) { return overlaps(box, t); });
    if (clean) return;
  }

  // 2. otherwise the best empty rectangle the text actually FITS in.
  var cands = largestFreeRect(inner, taken);
  if (!cands || !cands.length) return;

  // Distinct blocks only. The histogram yields thousands of near-identical
  // variants of the same band, and taking the top N by area meant the first N
  // were all one block a few pixels apart -- a genuinely different, taller block
  // further down the list was never reached.
  var seen = {}, blocks = [];
  for (var i = 0; i < cands.length && blocks.length < 24; i++) {
    var c0 = cands[i];
    var key = [Math.round(c0.l / 40), Math.round(c0.t / 40),
               Math.round((c0.r - c0.l) / 40), Math.round((c0.b - c0.t) / 40)].join(',');
    if (seen[key]) continue;
    seen[key] = 1;
    blocks.push(c0);
  }

  function tryBlocks() {
    for (var bi = 0; bi < blocks.length; bi++) {
      var rc = blocks[bi];
      var full = rc.r - rc.l, maxH = rc.b - rc.t;
      var widths = [Math.min(full, 1200)];
      if (full > widths[0]) widths.push(full);
      for (var wi = 0; wi < widths.length; wi++) {
        if (fitPanel(panel, body, widths[wi], maxH, fsMin)) {
          return {rect: rc, w: widths[wi]};
        }
      }
    }
    return null;
  }

  // one line per deck line first, because it reads better; then reflowed
  body.classList.remove('reflow');
  var hit = tryBlocks();
  if (!hit) {
    body.classList.add('reflow');
    hit = tryBlocks();
  }
  if (!hit) {
    // Nothing can hold it even reflowed. Take the biggest block at the smallest
    // size: staying inside it matters more than the text being comfortable,
    // because overflowing would cover the question.
    hit = {rect: blocks[0], w: blocks[0].r - blocks[0].l};
    fitPanel(panel, body, hit.w, hit.rect.b - hit.rect.t, fsMin);
  }
  // RTL: sit against the right edge of the chosen block
  panel.style.left = (hit.rect.r - hit.w) + 'px';
  panel.style.top = hit.rect.t + 'px';
}

function flash(sec, text) {
  var el = $('.nudge', sec);
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  window.setTimeout(function () { el.classList.remove('show'); }, 2200);
}


/* ------------------------------------------------------------------- video */
/*
 * A real <video>: center play button, burned-in captions (from the deck's own
 * .srt, parsed at build time into `.vcap-src [data-t]` spans), a custom control
 * bar, and the forward arrow held back until the video has played through once.
 *
 * Captions show the LAST cue whose start time has passed and clear once the
 * final cue's own end time (`data-clear-after`) is reached -- every cue in this
 * project's captions runs right up to the next one, so "last cue reached" is a
 * correct stand-in for "still within its span".
 */
function initVideo(sec) {
  var v = $('.video-el', sec);
  if (!v) return;
  var playBtn = $('.video-play', sec);
  var cap = $('.video-cap', sec);
  var capSrc = $('.vcap-src', sec);
  var CAPS = capSrc ? $$('[data-t]', capSrc).map(function (n) {
    return { t: parseFloat(n.getAttribute('data-t')), text: n.textContent };
  }) : [];
  var CLEAR_AFTER = capSrc ? parseFloat(capSrc.getAttribute('data-clear-after')) : 1e9;
  var ppBtn = $('[data-play]', sec), seek = $('[data-seek]', sec);
  var curEl = $('[data-cur]', sec), durEl = $('[data-dur]', sec);
  var muteBtn = $('[data-mute]', sec), volEl = $('[data-vol]', sec);
  var fullBtn = $('[data-full]', sec);
  var navFwd = $('.nav-fwd', sec);
  var raf = null, seeking = false, PLAY = '▶', PAUSE = '❚❚';

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function setCap(t) {
    var text = '';
    for (var i = 0; i < CAPS.length; i++) { if (t >= CAPS[i].t) text = CAPS[i].text; }
    if (t >= CLEAR_AFTER) text = '';
    if (cap && cap.textContent !== text) cap.textContent = text;
  }
  function syncBar() {
    if (curEl) curEl.textContent = fmt(v.currentTime);
    if (!seeking && seek && v.duration) {
      seek.value = String(Math.round(v.currentTime / v.duration * 1000));
    }
  }
  function tick() {
    setCap(v.currentTime);
    syncBar();
    if (!v.paused && !v.ended && sec.classList.contains('active')) {
      raf = requestAnimationFrame(tick);
    }
  }
  function play() {
    var p = v.play();
    if (p && p.catch) p.catch(function () {});
  }

  if (playBtn) playBtn.addEventListener('click', play);
  if (ppBtn) ppBtn.addEventListener('click', function () { if (v.paused) play(); else v.pause(); });
  if (seek) {
    seek.addEventListener('input', function () {
      seeking = true;
      if (v.duration) {
        v.currentTime = seek.value / 1000 * v.duration;
        setCap(v.currentTime);
        if (curEl) curEl.textContent = fmt(v.currentTime);
      }
    });
    seek.addEventListener('change', function () { seeking = false; });
  }
  if (volEl) volEl.addEventListener('input', function () {
    v.volume = volEl.value / 100;
    v.muted = (v.volume === 0);
    if (muteBtn) muteBtn.textContent = v.muted ? '🔇' : '🔊';
  });
  if (muteBtn) muteBtn.addEventListener('click', function () {
    v.muted = !v.muted;
    muteBtn.textContent = v.muted ? '🔇' : '🔊';
    if (volEl) volEl.value = v.muted ? 0 : Math.round(v.volume * 100);
  });
  if (fullBtn) fullBtn.addEventListener('click', function () {
    var el = $('.videoscreen', sec) || v;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen();
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
  });

  v.addEventListener('loadedmetadata', function () { if (durEl) durEl.textContent = fmt(v.duration); });
  var bubble = $('.ribbon-bubble', sec);
  v.addEventListener('play', function () {
    if (playBtn) playBtn.classList.add('hidden');
    if (ppBtn) ppBtn.textContent = PAUSE;
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    // floats in on first play; classList.add is a no-op on a later resume, so no
    // "first play only" guard is needed. The reflow-then-add pairing matches the
    // immediate-reveal path in goTo() -- see the comment there.
    if (bubble) { void bubble.offsetWidth; bubble.classList.add('in'); }
  });
  v.addEventListener('pause', function () { if (ppBtn) ppBtn.textContent = PLAY; });
  v.addEventListener('ended', function () {
    if (ppBtn) ppBtn.textContent = PLAY;
    setCap(1e9);
    sec._videoDone = true;
    // lift the gate: visible and usable, on THIS screen's own forward arrow
    if (navFwd) {
      navFwd.classList.remove('is-gated');
      navFwd.disabled = false;
    }
  });
  v.addEventListener('seeked', function () { setCap(v.currentTime); });
  v.addEventListener('timeupdate', function () { if (v.paused) syncBar(); });
}


/* --------------------------------------------------------------- feedback
 *
 * Feedback is a STATE of the question screen, not a screen of its own: the panel,
 * the graded pill, the option marks and the worked-answer diagram all live in the
 * same section and are revealed by the `graded` class. So the learner's answer
 * stays exactly where they typed it, and there is no navigation step between
 * answering and being told.
 */

function showResult(sec) {
  var slug = sec.getAttribute('data-question');
  if (!slug) return;
  var res = lomdaState.answers[slug];
  var box = $('.fb-panel', sec);
  if (!box) return;

  // Ungraded: leave the question in its live state and show nothing. Re-enabling
  // here matters as much as disabling below -- without it a screen whose recorded
  // answer is cleared keeps the controls locked, so the state stops being a pure
  // function of lomdaState and the question becomes unanswerable.
  //
  // The forward arrow is gated the same way a video's is (see nav(gate=...) in
  // build_lomda.py and the 'ended' handler above): hidden and disabled until
  // there is feedback to move on from, so a learner cannot skip past a question
  // without answering it. Re-gating here (not just lifting the gate once graded)
  // matters for the same reason re-enabling the inputs above does: stepping back
  // to a since-cleared answer must put the arrow back the way it started.
  var navFwd = $('.nav-fwd', sec);
  if (!res) {
    sec.classList.remove('graded');
    $$('.q-input, .opt input, .cell.token, .cell.slot-cell', sec)
      .forEach(function (el) { el.disabled = false; });
    if (navFwd && navFwd.hasAttribute('data-gate')) {
      navFwd.classList.add('is-gated');
      navFwd.disabled = true;
    }
    return;
  }
  sec.classList.add('graded');
  if (navFwd && navFwd.hasAttribute('data-gate')) {
    navFwd.classList.remove('is-gated');
    navFwd.disabled = false;
  }

  // The design's feedback state has no צדקתי button and shows the answer as a
  // filled pill rather than an open field, so grading locks the question. The
  // mark is frozen on the first check anyway, so nothing is lost by locking.
  $$('.q-input, .opt input', sec).forEach(function (el) { el.disabled = true; });
  $$('.cell.token, .cell.slot-cell', sec).forEach(function (el) { el.disabled = true; });

  var head = $('.fb-head', sec);
  if (head) {
    head.textContent = res.correct ? 'צדקת!' : 'זו טעות';
  }
  box.classList.remove('is-neutral');
  box.classList.toggle('is-correct', !!res.correct);
  box.classList.toggle('is-wrong', !res.correct);

  // Mirror the learner's own answer back into the pill — their answer, not the
  // model one, so a wrong attempt is shown in red rather than silently corrected.
  var row = $('.answer', sec);
  var pill = $('.answer .pill', sec);
  if (pill) {
    var fallback = pill.getAttribute('data-shown') || '';
    var typed = (res && res.given !== undefined && res.given !== null)
      ? String(res.given).trim() : '';
    pill.textContent = typed || fallback;
  }
  if (row) {
    row.classList.toggle('is-correct', !!res.correct);
    row.classList.toggle('is-wrong', res.correct === false);
  }

  // Per-slot marks/colouring for a drag question (per request), plus the
  // two-stage reveal: a wrong answer marks the learner's own layout right/
  // wrong in place and shows only the short .fb-reveal prompt (the full
  // explanation's <p>s hidden via .needs-reveal, see styles.tmpl.css); res.revealed
  // (set by the .fb-reveal-link click handler below) is what snaps the
  // correct values into every slot and switches to the full explanation.
  // Runs before placeFeedback() below since it changes what's visible in the
  // panel, which placeFeedback() needs to measure correctly.
  if (sec.getAttribute('data-kind') === 'drag') {
    var dkey = JSON.parse(sec.getAttribute('data-answer') || '{}');
    var dright = Array.isArray(dkey.value) ? dkey.value : [];
    var dslots = $$('.slot-cell', sec);
    var showFull = !!res.correct || !!res.revealed;
    box.classList.toggle('needs-reveal', !showFull);
    if (res.revealed) {
      dslots.forEach(function (slot, i) {
        var want = dright[i] !== undefined ? String(dright[i]) : '';
        slot.setAttribute('data-filled', want);
        var vs = valOf(slot);
        if (vs) vs.textContent = want;
      });
    }
    dslots.forEach(function (slot, i) {
      if (!showFull && !res.correct) {
        var given = slot.getAttribute('data-filled') || '';
        var want = dright[i] !== undefined ? String(dright[i]) : '';
        var ok = toNumber(given) === toNumber(want);
        slot.classList.toggle('is-correct', ok);
        slot.classList.toggle('is-wrong', !ok);
      } else {
        slot.classList.add('is-correct');
        slot.classList.remove('is-wrong');
      }
    });
    // Per request: the tokens never dragged into a slot animate up to a
    // column out of the feedback panel's way (BANK_GRADED_X/Y0/PITCH in
    // design.py -- mirrored here as GRADED_BANK_COL, same as GRADED_SHRINK
    // above mirrors a design.py constant). Packed in order among only the
    // ones actually left (not one fixed slot per token), so two leftovers
    // land adjacent with no gap between them regardless of which two of the
    // five they are.
    $$('.cell.token', sec).filter(function (t) { return !t.classList.contains('used'); })
      .forEach(function (t, i) {
        t.style.left = GRADED_BANK_COL.x + 'px';
        t.style.top = (GRADED_BANK_COL.y0 + i * GRADED_BANK_COL.pitch) + 'px';
      });
  }

  // Placed LAST, once the heading, the pill and the marks are all written: the
  // panel is sized from its own content, and measuring it before the heading went
  // in made every panel 45px short of what it needed.
  placeFeedback(sec);

  // Echo the choice the learner made, and mark which options were right.
  if (Array.isArray(res.given)) {
    var key = JSON.parse(sec.getAttribute('data-answer') || '{}');
    var right = Array.isArray(key.value) ? key.value : [key.value];
    $$('.opt', sec).forEach(function (opt) {
      var idx = Number(opt.getAttribute('data-index'));
      opt.classList.toggle('was-picked', res.given.indexOf(idx) !== -1);
      opt.classList.toggle('was-right', right.indexOf(idx) !== -1);
    });
  }
}


/* ------------------------------------------------------------------- score */

function finalScore() {
  return Math.round(lomdaState.score);
}

function showScore() {
  var sec = sectionFor(currentScreen);
  var overlay = $('.score-overlay', sec) || $('.score-overlay');
  var score = finalScore();
  $$('.score-value').forEach(function (el) { el.textContent = String(score); });
  $$('.score-verdict').forEach(function (el) {
    el.textContent = score >= PASS_SCORE ? 'בוצע בהצלחה' : 'לא הושלם';
  });
  if (overlay) overlay.classList.add('open');
  lomdaState.complete = true;
  post('LOMDA_COMPLETE', { score: score, passed: score >= PASS_SCORE });
}


/* ------------------------------------------------------------------- drag */

var dragSelection = null;

/* The cell's artwork is a child <img>, so the text goes in a .val span rather
   than replacing the cell's contents. */
function valOf(el) {
  return el.querySelector('.val') || el;
}

function selectToken(token) {
  if (token.getAttribute('data-used') === '1') return;
  if (dragSelection === token) {
    token.classList.remove('picked');
    dragSelection = null;
    return;
  }
  if (dragSelection) dragSelection.classList.remove('picked');
  dragSelection = token;
  token.classList.add('picked');
}

function placeInSlot(slot) {
  // Clicking a filled slot returns its token to the bank.
  if (slot.getAttribute('data-filled')) {
    releaseSlot(slot);
    return;
  }
  if (!dragSelection) return;
  slot.setAttribute('data-filled', dragSelection.getAttribute('data-value'));
  valOf(slot).textContent = valOf(dragSelection).textContent;
  slot.classList.add('filled');
  slot.setAttribute('data-token-id', dragSelection.getAttribute('data-token-id'));
  dragSelection.setAttribute('data-used', '1');
  dragSelection.classList.add('used');
  dragSelection.classList.remove('picked');
  dragSelection = null;
}

function releaseSlot(slot) {
  var id = slot.getAttribute('data-token-id');
  var sec = slot.closest('.screen');
  var token = id ? $('.token[data-token-id="' + id + '"]', sec) : null;
  if (token) {
    token.removeAttribute('data-used');
    token.classList.remove('used');
  }
  slot.removeAttribute('data-filled');
  slot.removeAttribute('data-token-id');
  valOf(slot).textContent = '';
  slot.classList.remove('filled');
}


/* -------------------------------------------------------------------- wire */

function wire() {
  screens = $$('#app > .screen');
  TOTAL_SCREENS = screens.length;
  window.TOTAL_SCREENS = TOTAL_SCREENS;

  screens.forEach(function (sec) {
    var slug = sec.getAttribute('data-question');
    if (slug) byQuestion[slug] = sec;
    if ($('.video-el', sec)) initVideo(sec);
  });

  document.addEventListener('click', function (ev) {
    var t = ev.target;

    var navFwd = t.closest('.nav-fwd');
    if (navFwd) {
      ev.preventDefault();
      if (!navFwd.disabled) next();
      return;
    }

    var navBack = t.closest('.nav-back');
    if (navBack) { ev.preventDefault(); prev(); return; }

    var startBtn = t.closest('.start-btn');
    if (startBtn) { ev.preventDefault(); next(); return; }

    var opener = t.closest('[data-opens]');
    if (opener) { ev.preventDefault(); togglePopup(opener); return; }

    var closer = t.closest('.popup-close');
    if (closer) { ev.preventDefault(); closePopups(); return; }

    var checkBtn = t.closest('.btn-check');
    if (checkBtn) {
      ev.preventDefault();
      check(checkBtn.closest('.screen'));
      return;
    }

    // Stage 2 of the drag reveal (per request): snaps the correct answers in
    // and swaps the short prompt for the full explanation. See the drag
    // branch in showResult() for what res.revealed actually changes.
    var revealLink = t.closest('.fb-reveal-link');
    if (revealLink) {
      ev.preventDefault();
      var revealSec = revealLink.closest('.screen');
      var revealSlug = revealSec && revealSec.getAttribute('data-question');
      var revealRes = revealSlug && lomdaState.answers[revealSlug];
      if (revealRes) { revealRes.revealed = true; showResult(revealSec); }
      return;
    }

    var finish = t.closest('.btn-finish');
    if (finish) { ev.preventDefault(); showScore(); return; }

    var scoreClose = t.closest('.score-close');
    if (scoreClose) {
      ev.preventDefault();
      $$('.score-overlay.open').forEach(function (o) { o.classList.remove('open'); });
      return;
    }

    var zoom = t.closest('.btn-zoom');
    if (zoom) {
      ev.preventDefault();
      var sec2 = zoom.closest('.screen');
      var ov = $('.zoom-overlay', sec2);
      if (ov) ov.classList.toggle('open');
      return;
    }

    var zoomCloseBtn = t.closest('.zoom-close');
    if (zoomCloseBtn) {
      ev.preventDefault();
      var ovz = zoomCloseBtn.closest('.zoom-overlay');
      if (ovz) ovz.classList.remove('open');
      return;
    }

    var zoomClose = t.closest('.zoom-overlay');
    if (zoomClose && t === zoomClose) { zoomClose.classList.remove('open'); return; }

    var token = t.closest('.token');
    if (token) { ev.preventDefault(); selectToken(token); return; }

    var slot = t.closest('.slot');
    if (slot) {
      ev.preventDefault();
      placeInSlot(slot);
      updateSubmitVisibility(slot.closest('.screen'));
      return;
    }
  });

  // Real HTML5 drag-and-drop for the token bank, alongside (not instead of)
  // the click-to-pick/click-to-place pair above -- reuses the exact same
  // dragSelection/placeInSlot() the click path uses, so a token dropped onto
  // a slot is indistinguishable from one clicked into it.
  document.addEventListener('dragstart', function (ev) {
    var token = ev.target.closest && ev.target.closest('.token');
    if (!token || token.getAttribute('data-used') === '1') { ev.preventDefault(); return; }
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', token.getAttribute('data-token-id') || '');
    }
    if (dragSelection && dragSelection !== token) dragSelection.classList.remove('picked');
    dragSelection = token;
    token.classList.add('picked');
  });
  document.addEventListener('dragover', function (ev) {
    if (ev.target.closest && ev.target.closest('.slot')) ev.preventDefault();
  });
  document.addEventListener('drop', function (ev) {
    var slot = ev.target.closest && ev.target.closest('.slot');
    if (!slot) return;
    ev.preventDefault();
    if (!slot.getAttribute('data-filled')) placeInSlot(slot);
    updateSubmitVisibility(slot.closest('.screen'));
  });
  document.addEventListener('dragend', function () {
    if (dragSelection) dragSelection.classList.remove('picked');
  });

  // .opt input is a radio/checkbox (fires 'change'); .q-input is text (fires
  // 'input' as the learner types). Both need the submit button re-evaluated
  // live, not just on the next goTo().
  document.addEventListener('change', function (ev) {
    if (ev.target.matches && ev.target.matches('.opt input')) {
      updateSubmitVisibility(ev.target.closest('.screen'));
    }
  });
  document.addEventListener('input', function (ev) {
    if (ev.target.matches && ev.target.matches('.q-input')) {
      updateSubmitVisibility(ev.target.closest('.screen'));
    }
  });

  // Enter in a numeric field checks the answer, which is what a learner expects.
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { closePopups(); return; }
    if (ev.key === 'Enter' && ev.target.classList.contains('q-input')) {
      ev.preventDefault();
      check(ev.target.closest('.screen'));
    }
  });

  window.addEventListener('message', function (ev) {
    var d = ev.data || {};
    if (d.type === 'LOMDA_GOTO' && d.screen) goTo(d.screen);
    if (d.type === 'LOMDA_PING') post('LOMDA_READY', { total: TOTAL_SCREENS });
  });

  fitStage();
  window.addEventListener('resize', fitStage);

  // index.html#7 opens screen 7, and #7/help or #3/fb opens that screen in one of
  // its states. Handy for QA and for reviewing one screen without clicking through,
  // and it is what lets the design check screenshot a state at all: a state is not
  // a URL of its own any more, so without this there would be no way to ask for one.
  function fromHash() {
    var raw = String(window.location.hash).replace('#', '').split('/');
    var n = parseInt(raw[0], 10);
    return {
      screen: (n >= 1 && n <= TOTAL_SCREENS) ? n : 1,
      state: (raw[1] || '').toLowerCase()
    };
  }

  function applyState(state) {
    var sec = sectionFor(currentScreen);
    if (!sec || !state) return;
    if (state === 'help' || state === 'ruler') {
      var btn = $('.btn-' + state, sec);
      if (btn) togglePopup(btn);
      return;
    }
    if (state === 'fb') {
      // Show the graded state as the design draws it: the answer correct. The value
      // is the deck's own pre-filled figure where it has one, otherwise the key.
      var slug = sec.getAttribute('data-question');
      if (!slug) return;
      var key = JSON.parse(sec.getAttribute('data-answer') || '{}');
      var pill = $('.answer .pill', sec);
      var shown = pill && pill.getAttribute('data-shown');
      lomdaState.answers[slug] = {
        correct: true,
        given: (key.kind === 'number') ? (shown || key.value) : key.value,
        scored: 0
      };
      showResult(sec);
    }
  }

  function route() {
    var h = fromHash();
    goTo(h.screen);                     // paints immediately -- never blocked on fonts
    if (!h.state) return;
    // A state that OPENS something (help/ruler/fb) measures text width or height
    // to size a box (the help bubble shrink-to-fits its own content; the wrapped
    // options and feedback panel measure similarly). That measurement is only
    // meaningful once the real web font is in: "Assistant" loads with
    // font-display:swap, so a deep link straight to a state -- #5/help, exactly
    // what check_design.py and a shared link both do -- used to size the help
    // box against the FALLBACK font on first paint, then Assistant swapped in
    // moments later with wider glyphs than the box was sized for, clipping the
    // tail of the text. Screen navigation itself has no such measurement and
    // stays instant; only opening the state waits.
    document.fonts.ready.then(function () { applyState(h.state); });
  }

  window.addEventListener('hashchange', route);

  route();
  post('LOMDA_READY', { total: TOTAL_SCREENS });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire);
} else {
  wire();
}

/* The QA harness reads these off window; keep them global. */
window.goTo = goTo;
window.lomdaState = lomdaState;
window.next = next;
window.prev = prev;
