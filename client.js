// Client UI half of @local/dsh-end-timestamp.
//
// Inlines the concrete local wall-clock end time AND the model that served a
// turn into DSH's "已完成，用时 X分X秒" / "已停止" / "处理失败" reply line by
// DOM-patching the turn-process button's label (which has no slot). The
// turn-tail slot occupant is kept as a no-op carrier so the DOM patch runs
// with turn data.
//
// WHY v1.2: the host only derives turn-tail.tokenUsage.routes (the model) for
// turns that finish normally. Interrupted ("已停止") and failed ("处理失败")
// turns have no tokenUsage, so their reply line showed the end time but no
// model. The host half now folds the raw session event stream into a per-turn
// model summary; this client half fetches it ONCE per session and uses it ONLY
// as a fallback when turn-tail has no model, plus a best-effort badge for the
// rare failed turn that has no reply button at all.
//
// WHY v1.3: DSH renders the elapsed duration ("用时") only for turns that
// complete normally; for aborted/interrupted ("已停止") and failed ("处理
// 失败") turns it deliberately suppresses it. DSH puts the duration INSIDE
// the reply label, right after the state word ("已完成，用时 X秒"), as spans
// inside the same label element. This half computes the same duration from
// turn.start.time / turn.end.time (the very values DSH's own
// TurnProcessNodeView reads) and injects "，用时 <时长>" into that label in
// the same position, so a stopped/failed run reads
// 时常读作 "处理失败，用时 X秒（结束于 ... ｜ model）"，格式完全复刻 DSH 的 formatRunDuration。
// formatRunDuration (小时/分/秒).
//
// SAFETY: every new path is strictly additive and fully guarded. If the host
// endpoint is unavailable, this behaves exactly like v1.1.0 (timestamps only).
// A fold entry is accepted only when its end time matches this turn's end
// time, so a wrong sessionId can never attach another run's model here.
// The plugin NEVER registers conversation.chat.flow (host-exclusive single
// slot); it only occupies conversation.chat.turnTail.
window.__ModuleLoader__.load({
  id: '@local/dsh-end-timestamp',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const pad = (n) => String(n).padStart(2, '0');

    function formatLocalTime(ms) {
      const d = new Date(ms);
      const y = d.getFullYear();
      const mo = pad(d.getMonth() + 1);
      const da = pad(d.getDate());
      const hh = pad(d.getHours());
      const mm = pad(d.getMinutes());
      const ss = pad(d.getSeconds());
      return y + '-' + mo + '-' + da + ' ' + hh + ':' + mm + ':' + ss;
    }

    // The per-turn model lives in the turn's location data store under the
    // "turn-tail" key, as tokenUsage.routes[] = { provider, model }.
    const TURN_TAIL_KEY = 'turn-tail';
    // The host registers the same read-only handler on two routers (verified
    // live): webServer (Node req/res) and connection.fetch (Fetch-style).
    // Try the @local-proven webServer path first, then the /api/ one.
    const FOLD_PATHS = [
      '/dsh-end-timestamp/turns',
      '/api/dsh-end-timestamp/turns',
    ];
    const STAMP_ATTR = 'data-end-timestamp-inline';
    const BADGE_ATTR = 'data-end-timestamp-badge';
    const DURATION_ATTR = 'data-end-timestamp-duration';

    function readTurnTailData(turn) {
      try {
        const store = turn && turn.data;
        if (!store || typeof store.get !== 'function') return null;
        return store.get(TURN_TAIL_KEY) || null;
      } catch (e) {
        return null;
      }
    }

    function formatModels(turn) {
      const tail = readTurnTailData(turn);
      const usage = tail && tail.tokenUsage;
      const routes = usage && usage.routes;
      if (!Array.isArray(routes) || routes.length === 0) return '';
      const labels = [];
      for (const route of routes) {
        if (!route || typeof route.model !== 'string' || !route.model) continue;
        labels.push(
          typeof route.provider === 'string' && route.provider
            ? route.provider + '/' + route.model
            : route.model
        );
      }
      const seen = new Set();
      const unique = [];
      for (const label of labels) {
        if (seen.has(label)) continue;
        seen.add(label);
        unique.push(label);
      }
      return unique.join(', ');
    }

    // ---- Host fold cache (best-effort, never required) --------------------
    // foldCache.byTurn: Map<number, { turn, endTime, kind, models: string[] }>
    let foldCache = { sessionId: '', status: 'idle', byTurn: null };
    // Mounted closed turns, so a late-arriving fold can re-patch them.
    const mounted = new Map();

    // Resolve the owning sessionId without assuming any single source.
    function findSessionId(props, turnId) {
      try {
        if (props && typeof props.sessionId === 'string' && props.sessionId) {
          return props.sessionId;
        }
      } catch (e) {}
      // Selected sidebar row carries data-row-key="session:<uuid>".
      try {
        if (typeof document !== 'undefined' && document.querySelectorAll) {
          const rows = document.querySelectorAll('[data-row-key^="session:"]');
          for (const r of rows) {
            if (r.getAttribute && r.getAttribute('aria-selected') === 'true') {
              const key = r.getAttribute('data-row-key');
              if (key && key.indexOf('session:') === 0) return key.slice(8);
            }
          }
        }
      } catch (e) {}
      // Climb this turn's button fiber; every chat-flow ancestor carries the
      // owning sessionId (verified by CDP probe: TurnProcessNodeView @hop 1).
      try {
        if (typeof document !== 'undefined') {
          const btn = document.querySelector(
            '[data-turn-process="' + String(turnId) + '"]'
          );
          if (btn && typeof Object.keys === 'function') {
            const fk = Object.keys(btn).find(
              (k) => k.indexOf('__reactFiber$') === 0
            );
            let f = fk ? btn[fk] : null;
            let hops = 0;
            while (f && hops < 40) {
              const mp = f.memoizedProps;
              if (
                mp &&
                typeof mp.sessionId === 'string' &&
                mp.sessionId.indexOf('session-') === 0
              ) {
                return mp.sessionId;
              }
              f = f.return;
              hops++;
            }
          }
        }
      } catch (e) {}
      // Last resort: a single unambiguous data-session-id in the DOM.
      try {
        if (typeof document !== 'undefined' && document.querySelectorAll) {
          const els = document.querySelectorAll('[data-session-id]');
          const ids = new Set();
          for (const e of els) {
            const v = e.getAttribute('data-session-id');
            if (v && v.indexOf('session-') === 0) ids.add(v.split('/')[0]);
          }
          if (ids.size === 1) return Array.from(ids)[0];
        }
      } catch (e) {}
      return '';
    }

    // Fold model fallback, accepted ONLY when the end time matches this turn.
    function foldModelsFor(turn, sessionId) {
      try {
        if (
          foldCache.status !== 'ready' ||
          foldCache.sessionId !== sessionId ||
          !foldCache.byTurn
        ) {
          return '';
        }
        const entry = foldCache.byTurn.get(Number(turn.turn));
        if (!entry) return '';
        if (
          typeof entry.endTime === 'number' &&
          typeof turn.end.time === 'number' &&
          Math.abs(entry.endTime - turn.end.time) > 300000
        ) {
          return '';
        }
        if (!Array.isArray(entry.models) || entry.models.length === 0) return '';
        const seen = new Set();
        const out = [];
        for (const l of entry.models) {
          if (typeof l !== 'string' || !l || seen.has(l)) continue;
          seen.add(l);
          out.push(l);
        }
        return out.join(', ');
      } catch (e) {
        return '';
      }
    }

    function repatch(sessionId) {
      for (const entry of mounted.values()) {
        try {
          if (entry.sessionId === sessionId) entry.patch();
        } catch (e) {}
      }
    }

    // Fetch the fold from the first path that answers with a usable payload.
    // Both paths serve the same handler; one of them may be the only live
    // router depending on which services this plugin's context resolves.
    function tryPath(path, sessionId) {
      const opts = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId }),
      };
      return Promise.resolve(fetch(path, opts)).then((r) => {
        if (!r || (typeof r.ok === 'boolean' && !r.ok)) return null;
        if (typeof r.json !== 'function') return null;
        return Promise.resolve(r.json()).then((data) => {
          if (data && data.ok && Array.isArray(data.turns)) return data;
          return null;
        });
      });
    }

    function loadFold(sessionId) {
      if (!sessionId || typeof fetch !== 'function') return;
      if (foldCache.sessionId === sessionId && foldCache.status !== 'idle') return;
      foldCache = { sessionId: sessionId, status: 'loading', byTurn: null };

      const attempt = (i) => {
        if (i >= FOLD_PATHS.length) {
          foldCache = { sessionId: sessionId, status: 'failed', byTurn: null };
          return;
        }
        let p;
        try {
          p = tryPath(FOLD_PATHS[i], sessionId);
        } catch (e) {
          p = Promise.resolve(null);
        }
        Promise.resolve(p)
          .then((data) => {
            if (!data) return attempt(i + 1);
            const byTurn = new Map();
            for (const t of data.turns) {
              if (t && typeof t.turn === 'number') byTurn.set(t.turn, t);
            }
            foldCache = {
              sessionId: sessionId,
              status: 'ready',
              byTurn: byTurn,
            };
            repatch(sessionId);
          })
          .catch(() => attempt(i + 1));
      };
      attempt(0);
    }

    // ---- v1.3 elapsed-duration helpers ------------------------------------
    // The turn object is the same one DSH's own TurnProcessNodeView reads
    // (turn.start.time / turn.end.time), so the elapsed time is computed
    // client-side. The host fold's startTime is only a fallback for the rare
    // case where turn.start is absent.

    function turnReasonKind(turn) {
      try {
        const reason = turn && turn.end && turn.end.data && turn.end.data.reason;
        const kind = reason && reason.kind;
        return typeof kind === 'string' ? kind : null;
      } catch (e) {
        return null;
      }
    }

    // Duration in ms, or null when it cannot be determined. Clamps to DSH's
    // minimum of 1s and rejects non-finite / negative spans.
    function turnDurationMs(turn, sessionId) {
      try {
        const end = turn && turn.end && typeof turn.end.time === 'number'
          ? turn.end.time : null;
        if (end === null) return null;
        let start = turn && turn.start && typeof turn.start.time === 'number'
          ? turn.start.time : null;
        if (start === null) {
          // Fallback: the host fold recorded turn/start.time.
          if (foldCache.status === 'ready' && foldCache.sessionId === sessionId
            && foldCache.byTurn) {
            const entry = foldCache.byTurn.get(Number(turn.turn));
            if (entry && typeof entry.startTime === 'number') start = entry.startTime;
          }
        }
        if (start === null) return null;
        const delta = end - start;
        if (!Number.isFinite(delta)) return null;
        // Match DSH exactly: Math.max(1e3, end.time - start.time).
        return Math.max(1000, delta);
      } catch (e) {
        return null;
      }
    }

    // Mirrors DSH's compiled formatRunDuration(ms, t) exactly: hours only when
    // present, minutes only when total >= 60, seconds always. Units are the
    // same as DSH's zh locale (小时 / 分 / 秒).
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
      const total = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor(total / 60) % 60;
      const seconds = total % 60;
      let out = '';
      if (hours > 0) out += hours + '小时';
      if (total >= 60) out += minutes + '分';
      out += seconds + '秒';
      return out;
    }

    // elapsed-duration text for the turns where DSH suppresses it, or null.
    // Placed in the label right after the state word -- the same position as
    // DSH's own "已完成，用时 X秒" -- never inside the timestamp/model stamp.
    function durationTextFor(turn, sessionId) {
      const kind = turnReasonKind(turn);
      const stopped = kind === 'aborted' || kind === 'interrupted';
      if (!stopped && kind !== 'error') return null;
      const ms = turnDurationMs(turn, sessionId);
      if (ms === null) return null;
      return formatDuration(ms) || null;
    }

    // Timestamp + model stamp only. The duration is a SEPARATE node placed
    // in front of this stamp (see ensureStamp), so it occupies the exact
    // position DSH reserves for "用时" inside the reply label.
    function buildStamp(turn, sessionId) {
      let stamp = '（结束于 ' + formatLocalTime(turn.end.time);
      const models =
        formatModels(turn) || (sessionId ? foldModelsFor(turn, sessionId) : '');
      if (models) stamp += ' ｜ ' + models;
      return stamp + '）';
    }

    // Idempotently (re)build the inline timestamp/model stamp and, when the
    // turn is one DSH hides the duration on, the "，用时 <时长>" node placed
    // immediately BEFORE the stamp -- the same slot DSH reserves for the
    // duration of a "已完成，用时 X秒" reply. Never touches the state label
    // text itself, so the model stamp is never displaced.
    function ensureStamp(btn, stamp, duration) {
      if (!btn || btn.nodeType !== 1) return;
      const label = btn.querySelector(':scope > span');
      if (!label) return;
      let span = label.querySelector('[' + STAMP_ATTR + ']');
      if (!span) {
        span = document.createElement('span');
        span.setAttribute(STAMP_ATTR, 'true');
        span.style.cssText =
          'margin-left:6px;opacity:.72;font-size:12px;white-space:nowrap;';
        label.appendChild(span);
      }

      // Duration node goes between the state label and the stamp.
      let dur = label.querySelector('[' + DURATION_ATTR + ']');
      if (duration) {
        if (!dur) {
          dur = document.createElement('span');
          dur.setAttribute(DURATION_ATTR, 'true');
          dur.style.cssText = 'opacity:.72;font-size:12px;white-space:nowrap;';
        }
        // Only reposition the node when it is NOT already in the right slot.
        // insertBefore() on an already-positioned node STILL emits a childList
        // mutation, which re-triggers our MutationObserver(patch) forever:
        // an endless microtask loop that starves the renderer main thread and
        // freezes the whole GUI (the v1.3 regression). Keep patch() idempotent.
        if (dur.parentNode !== label || dur.nextSibling !== span) {
          if (label.contains(span)) label.insertBefore(dur, span);
          else label.appendChild(dur);
        }
        const want = '，用时 ' + duration;
        if (dur.textContent !== want) dur.textContent = want;
      } else if (dur && dur.parentNode) {
        dur.parentNode.removeChild(dur);
      }

      if (span.textContent !== stamp) span.textContent = stamp;
    }

    function turnAnchors(turnIdStr) {
      const n = String(turnIdStr);
      return [
        '[data-chat-turn="' + n + '"]',
        '[data-turn="' + n + '"]',
        '[data-turn-id="' + n + '"]',
      ];
    }

    function removeBadge(turnIdStr) {
      try {
        if (typeof document === 'undefined' || !document.querySelectorAll) return;
        for (const sel of turnAnchors(turnIdStr)) {
          let els;
          try { els = document.querySelectorAll(sel); } catch (e) { continue; }
          if (!els) continue;
          for (const el of els) {
            try {
              const b = el.querySelector('[' + BADGE_ATTR + ']');
              if (b && b.parentNode) b.parentNode.removeChild(b);
            } catch (e) {}
          }
        }
      } catch (e) {}
    }

    // Best-effort badge for a failed turn that has NO reply button. Appends one
    // small span to a turn-scoped DOM anchor; if none exists, does nothing.
    // Never removes/replaces anything, and is fully guarded.
    function injectBadge(turnIdStr, stamp) {
      try {
        if (typeof document === 'undefined' || !document.querySelectorAll) return;
        if (
          document.querySelector(
            '[data-turn-process="' + String(turnIdStr) + '"]'
          )
        ) {
          return;
        }
        let anchor = null;
        for (const sel of turnAnchors(turnIdStr)) {
          let els;
          try { els = document.querySelectorAll(sel); } catch (e) { continue; }
          if (els && els.length) {
            anchor = els[els.length - 1];
            break;
          }
        }
        if (!anchor) return;
        let badge = anchor.querySelector('[' + BADGE_ATTR + ']');
        if (!badge) {
          badge = document.createElement('span');
          badge.setAttribute(BADGE_ATTR, 'true');
          badge.style.cssText =
            'display:inline-block;margin:2px 0 2px 8px;opacity:.72;font-size:12px;white-space:nowrap;';
          anchor.appendChild(badge);
        }
        if (badge.textContent !== stamp) badge.textContent = stamp;
      } catch (e) {}
    }

    function EndTimestampTail(props) {
      const turn = props && props.turn;
      const closed = !!(
        turn &&
        turn.status === 'closed' &&
        turn.end &&
        typeof turn.end.time === 'number'
      );

      if (typeof React.useEffect === 'function') {
        React.useEffect(() => {
          if (!closed || !turn || typeof document === 'undefined') return;
          const turnId = String(turn.turn);
          const selector = '[data-turn-process="' + turnId + '"]';
          const sessionId = findSessionId(props, turnId);
          const mountedKey = sessionId + '/' + turnId;

          const patch = () => {
            const btn = document.querySelector(selector);
            if (btn) {
              removeBadge(turnId);
              const duration = durationTextFor(turn, sessionId);
              ensureStamp(
                btn,
                buildStamp(turn, sessionId),
                duration
              );
            } else if (
              foldCache.status === 'ready' &&
              foldCache.sessionId === sessionId
            ) {
              injectBadge(turnId, buildStamp(turn, sessionId));
            }
          };
          patch();

          const disposers = [];
          mounted.set(mountedKey, {
            turn: turn,
            sessionId: sessionId,
            patch: patch,
          });
          disposers.push(() => mounted.delete(mountedKey));

          const btn = document.querySelector(selector);
          if (btn && typeof MutationObserver !== 'undefined') {
            // Belt-and-suspenders against a MutationObserver feedback loop:
            // disconnect while patch() runs so its OWN DOM writes are never
            // recorded, then re-observe. Delivered as microtasks, patch()'s
            // writes would otherwise retrigger the observer endlessly and
            // starve the renderer (the v1.3 "GUI 全部卡死" regression).
            let observer = null;
            const onMutate = () => {
              if (!observer) { patch(); return; }
              observer.disconnect();
              try { patch(); } finally {
                try { observer.observe(btn, { childList: true, subtree: true }); }
                catch (e) {}
              }
            };
            observer = new MutationObserver(onMutate);
            observer.observe(btn, { childList: true, subtree: true });
            disposers.push(() => observer && observer.disconnect());
          }
          try {
            const store = turn.data;
            if (store && typeof store.source === 'function') {
              const source = store.source(TURN_TAIL_KEY);
              if (source && typeof source.subscribe === 'function') {
                disposers.push(source.subscribe(patch));
              }
            }
          } catch (e) {}

          if (sessionId) loadFold(sessionId);

          return () => {
            for (const dispose of disposers) {
              try { dispose(); } catch (e) {}
            }
          };
        }, [closed, turn && turn.turn, turn && turn.end && turn.end.time]);
      }

      if (!closed) return null;
      return null;
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: '@local/dsh-end-timestamp',
              order: 100,
              locale: 'chat',
            },
            EndTimestampTail
          )
        );
      },
    };
  },
});
