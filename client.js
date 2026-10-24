// Client UI half of @local/dsh-end-timestamp.
// Inlines the concrete local wall-clock end time into DSH's
// "已完成，用时 X分X秒" reply line by DOM-patching the turn-process
// button's label (which has no slot). The turn-tail slot occupant is
// kept as a no-op carrier so the DOM patch runs with turn data.
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

    // Attribute marking our inline stamp so we never double-insert.
    const STAMP_ATTR = 'data-end-timestamp-inline';

    // Idempotently append the inline stamp to a turn-process button's label.
    function ensureStamp(btn, stamp) {
      if (!btn || btn.nodeType !== 1) return;
      const label = btn.querySelector(':scope > span');
      if (!label) return;
      if (label.querySelector('[' + STAMP_ATTR + ']')) return;
      const span = document.createElement('span');
      span.setAttribute(STAMP_ATTR, 'true');
      span.style.cssText = 'margin-left:6px;opacity:.72;font-size:12px;white-space:nowrap;';
      span.textContent = stamp;
      label.appendChild(span);
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
      // turn.turn) and re-patch via MutationObserver after React re-renders.
      // The tail itself is no longer rendered (timestamp lives inline only).
      if (typeof React.useEffect === 'function') {
        React.useEffect(() => {
          if (!closed || !turn || typeof document === 'undefined') return;
          const turnId = String(turn.turn);
          const selector = '[data-turn-process="' + turnId + '"]';
          const stamp = '（结束于 ' + formatLocalTime(turn.end.time) + '）';

          const patch = () => {
            const btn = document.querySelector(selector);
            if (btn) ensureStamp(btn, stamp);
          };
          patch();

          const btn = document.querySelector(selector);
          if (btn && typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver(patch);
            observer.observe(btn, { childList: true, subtree: true });
            return () => observer.disconnect();
          }
        }, [closed, turn && turn.turn, turn && turn.end && turn.end.time]);
      }

      if (!closed) return null;

      // Tail removed: timestamp now lives only inline in the "已完成" line.
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