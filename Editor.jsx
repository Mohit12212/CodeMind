import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Highlighted } from "./ui.jsx";

const LH = 20;      // line height in px (must match --code-lh in CSS)
const PAD_TOP = 12; // must match .code-pad in CSS

function lineStartOffset(value, line) {
  let idx = 0;
  for (let i = 1; i < line; i++) {
    const n = value.indexOf("\n", idx);
    if (n === -1) return value.length;
    idx = n + 1;
  }
  return idx;
}

const Editor = forwardRef(function Editor({ code, language, setCode, marks, onLineClick, onCursor }, ref) {
  const ta = useRef(null);
  const layer = useRef(null);
  const gutter = useRef(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [flash, setFlash] = useState(null);

  const count = useMemo(() => code.split("\n").length, [code]);

  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    focusLine: (n) => {
      const el = ta.current;
      if (!el) return;
      const start = lineStartOffset(el.value, n);
      const nl = el.value.indexOf("\n", start);
      const end = nl === -1 ? el.value.length : nl;
      el.focus({ preventScroll: true });
      el.setSelectionRange(start, end);
      el.scrollTop = Math.max(0, PAD_TOP + (n - 1) * LH - el.clientHeight / 2);
      setFlash(n);
      setTimeout(() => setFlash((f) => (f === n ? null : f)), 1800);
      syncCursor();
    },
  }));

  const syncScroll = () => {
    const el = ta.current;
    if (!el) return;
    if (layer.current) { layer.current.scrollTop = el.scrollTop; layer.current.scrollLeft = el.scrollLeft; }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  };

  const syncCursor = () => {
    const el = ta.current;
    if (!el) return;
    const upTo = el.value.slice(0, el.selectionStart);
    const line = upTo.split("\n").length;
    const col = el.selectionStart - (upTo.lastIndexOf("\n") + 1) + 1;
    setCursor((c) => (c.line === line && c.col === col ? c : { line, col }));
    onCursor?.({ line, col });
  };

  /* execCommand keeps the browser's native undo stack intact; fall back if unsupported. */
  const insert = (text) => {
    const el = ta.current;
    el.focus();
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch { ok = false; }
    if (!ok) {
      el.setRangeText(text, el.selectionStart, el.selectionEnd, "end");
      setCode(el.value);
    }
  };

  const onKeyDown = (e) => {
    const el = ta.current;
    const { value, selectionStart: s, selectionEnd: en } = el;

    if (e.key === "Tab") {
      e.preventDefault();
      const multi = value.slice(s, en).includes("\n");
      if (multi || e.shiftKey) {
        const ls = value.lastIndexOf("\n", s - 1) + 1;
        const block = value.slice(ls, en);
        const next = block
          .split("\n")
          .map((l) => (e.shiftKey ? l.replace(/^( {1,4}|\t)/, "") : "    " + l))
          .join("\n");
        el.setSelectionRange(ls, en);
        insert(next);
        el.setSelectionRange(ls, ls + next.length);
      } else {
        insert("    ");
      }
      return;
    }

    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const ls = value.lastIndexOf("\n", s - 1) + 1;
      const before = value.slice(ls, s);
      const indent = before.match(/^[ \t]*/)[0];
      const trimmed = before.trim();
      const opens = /[:{\[(]\s*$/.test(before) && !trimmed.startsWith("#") && !trimmed.startsWith("//");
      e.preventDefault();
      insert("\n" + indent + (opens ? "    " : ""));
    }
  };

  const bands = Object.entries(marks || {});

  return (
    <div className="editor">
      <div className="gutter" ref={gutter} aria-hidden="true">
        <div className="gutter-inner">
          {Array.from({ length: count }, (_, i) => {
            const n = i + 1;
            const sev = marks?.[n];
            return (
              <div
                key={n}
                className={"ln " + (sev || "") + (cursor.line === n ? " cur" : "")}
                onClick={() => onLineClick?.(n)}
                title={sev ? `Line ${n}: ${sev} finding` : undefined}
              >
                <i />
                {n}
              </div>
            );
          })}
        </div>
      </div>

      <div className="code-area">
        <div className="hl-layer" ref={layer} aria-hidden="true">
          <div className="hl-inner">
            <div
              className="band cur"
              style={{ top: PAD_TOP + (cursor.line - 1) * LH }}
            />
            {bands.map(([n, sev]) => (
              <div key={n} className={`band ${sev}`} style={{ top: PAD_TOP + (n - 1) * LH }} />
            ))}
            {flash && <div className="band flash" style={{ top: PAD_TOP + (flash - 1) * LH }} />}
            <pre className="code-pad hl-pre">
              <Highlighted code={code} lang={language} />
              {"\n"}
            </pre>
          </div>
        </div>

        <textarea
          ref={ta}
          className="code-pad code-input"
          value={code}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Source code"
          placeholder="Paste or write code here, then press Ctrl+Enter to review."
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          onKeyUp={syncCursor}
          onClick={syncCursor}
          onSelect={syncCursor}
        />
      </div>
    </div>
  );
});

export default Editor;
