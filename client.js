// Client UI half of @local/dsh-end-timestamp.
// Inlines the concrete local wall-clock end time AND the model that served
// this turn into DSH's "已完成，用时 X分X秒" reply line by DOM-patching the
// turn-process button's label (which has no slot). The turn-tail slot
// occupant is kept as a no-op carrier so the DOM patch runs with turn data.
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
    // "turn-tail" key, as tokenUsage.routes[] = { provider, model } — the same
    // data the built-in TurnUsagePanel renders as "provider / model". Returns a
    // deduped "provider/model" list, or '' when it cannot be proven.
    const TURN_TAIL_KEY = 'turn-tail';

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
      // Dedupe (retries can repeat the same route) while keeping order.
      const seen = new Set();
      const unique = [];
      for (const label of labels) {
        if (seen.has(label)) continue;
        seen.add(label);
        unique.push(label);
      }
      return unique.join(', ');
    }

    // Build the full inline stamp: end time, plus the model when known.
    function buildStamp(turn) {
      let stamp = '（结束于 ' + formatLocalTime(turn.end.time);
      const models = formatModels(turn);
      if (models) stamp += ' ｜ ' + models;
      return stamp + '）';
    }

    // Attribute marking our inline stamp so we never double-insert.
    const STAMP_ATTR = 'data-end-timestamp-inline';

    // Idempotently append (or refresh) the inline stamp on a turn-process
    // button's label. Refreshing textContent lets a late-arriving model update
    // an already-inserted stamp without duplicating it.
    function ensureStamp(btn, stamp) {
      if (!btn || btn.nodeType !== 1) return;
      const label = btn.querySelector(':scope > span');
      if (!label) return;
      let span = label.querySelector('[' + STAMP_ATTR + ']');
      if (!span) {
        span = document.createElement('span');
        span.setAttribute(STAMP_ATTR, 'true');
        span.style.cssText = 'margin-left:6px;opacity:.72;font-size:12px;white-space:nowrap;';
        label.appendChild(span);
      }
      if (span.textContent !== stamp) span.textContent = stamp;
    }

    function EndTimestampTail(props) {
      const turn = props && props.turn;
      const closed = !!(
        turn &&
        turn.status === 'closed' &&
        turn.end &&
        typeof turn.end.time === 'number'
      );

      // Patch the "已完成" line inline. TurnProcessNodeView has no slot for
      // its label, so we DOM-patch the button (data-turn-process matches
      // turn.turn) and re-patch via MutationObserver after React re-renders,
      // plus a subscription to the turn's data store so a model that resolves
      // slightly after the stamp first lands still gets patched in.
      // The tail itself is no longer rendered (timestamp lives inline only).
      if (typeof React.useEffect === 'function') {
        React.useEffect(() => {
          if (!closed || !turn || typeof document === 'undefined') return;
          const turnId = String(turn.turn);
          const selector = '[data-turn-process="' + turnId + '"]';

          const patch = () => {
            const btn = document.querySelector(selector);
            if (btn) ensureStamp(btn, buildStamp(turn));
          };
          patch();

          const disposers = [];
          const btn = document.querySelector(selector);
          if (btn && typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver(patch);
            observer.observe(btn, { childList: true, subtree: true });
            disposers.push(() => observer.disconnect());
          }
          try {
            const store = turn.data;
            if (store && typeof store.source === 'function') {
              const source = store.source(TURN_TAIL_KEY);
              if (source && typeof source.subscribe === 'function') {
                disposers.push(source.subscribe(patch));
              }
            }
          } catch (e) {
            // Model info is best-effort; never break the timestamp.
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch (e) {}
            }
          };
        }, [closed, turn && turn.turn, turn && turn.end && turn.end.time]);
      }

      if (!closed) return null;

      // Tail removed: timestamp + model now live only inline in the "已完成" line.
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
