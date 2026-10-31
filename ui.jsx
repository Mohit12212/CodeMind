import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { tokenize } from "./highlight.js";
import {
  IconCheck, IconCopy, IconX, IconInfo, IconAlert, IconSparkles, IconBug,
} from "./icons.jsx";

/* ───────────── hooks ───────────── */

export function useLocalStorage(key, initial) {
  const [val, setVal] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage disabled */ }
  }, [key, val]);
  return [val, setVal];
}

function useOutsideClose(ref, open, close) {
  useEffect(() => {
    if (!open) return;
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) close(); };
    const key = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open, close, ref]);
}

/* ───────────── small primitives ───────────── */

export const Kbd = ({ children }) => <kbd className="kbd">{children}</kbd>;

export function Segmented({ value, onChange, options, label, size }) {
  return (
    <div className={"seg " + (size || "")} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? "on" : ""}
          aria-pressed={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ size = 14 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

/* ───────────── menu / popover ───────────── */

/**
 * <Menu button={({open, toggle}) => <button .../>} items={[...]} align="left|right" up />
 * item: { label, icon, kbd, onClick, checked, danger, disabled, divider, heading }
 */
export function Menu({ button, items, align = "left", up = false, width }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(ref, open, close);

  const onKey = (e) => {
    if (!open) return;
    const els = [...ref.current.querySelectorAll("[role=menuitem]:not([disabled])")];
    const i = els.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
  };

  return (
    <div className="menu-wrap" ref={ref} onKeyDown={onKey}>
      {button({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className={`menu ${align} ${up ? "up" : ""}`}
          role="menu"
          style={width ? { minWidth: width } : undefined}
        >
          {items.map((it, i) =>
            it.divider ? (
              <div key={i} className="menu-div" role="separator" />
            ) : it.heading ? (
              <div key={i} className="menu-heading">{it.heading}</div>
            ) : (
              <button
                key={i}
                role="menuitem"
                type="button"
                disabled={it.disabled}
                className={"menu-item " + (it.danger ? "danger" : "") + (it.checked ? " checked" : "")}
                onClick={() => { setOpen(false); it.onClick?.(); }}
              >
                <span className="mi-ico">{it.checked ? <IconCheck size={14} /> : it.icon}</span>
                <span className="mi-label">{it.label}</span>
                {it.kbd && <span className="mi-kbd">{it.kbd}</span>}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────── dialog ───────────── */

export function Dialog({ title, onClose, children, footer, width = 560, icon }) {
  const box = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", key);
    const t = setTimeout(() => {
      const f = box.current?.querySelector("[data-autofocus], input, textarea, select, button.primary");
      (f || box.current)?.focus();
    }, 20);
    return () => {
      document.removeEventListener("keydown", key);
      clearTimeout(t);
      prev?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: width }} ref={box} tabIndex={-1}>
        <div className="dialog-head">
          {icon}
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog"><IconX size={16} /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = "Confirm", danger, onConfirm, onClose }) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className={"btn " + (danger ? "danger" : "primary")}
            onClick={() => { onClose(); onConfirm(); }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="dim">{message}</p>
    </Dialog>
  );
}

/* ───────────── splitter ───────────── */

/** dir="v": a vertical bar that resizes horizontally. dir="h": a horizontal bar that resizes vertically. */
export function Splitter({ dir = "v", onDrag, onDoubleClick, label }) {
  const last = useRef(0);
  const [active, setActive] = useState(false);

  const down = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    last.current = dir === "v" ? e.clientX : e.clientY;
    setActive(true);
    document.body.classList.add(dir === "v" ? "resizing-x" : "resizing-y");
  };
  const move = (e) => {
    if (!active) return;
    const cur = dir === "v" ? e.clientX : e.clientY;
    onDrag(cur - last.current);
    last.current = cur;
  };
  const up = () => {
    setActive(false);
    document.body.classList.remove("resizing-x", "resizing-y");
  };
  const key = (e) => {
    const step = e.shiftKey ? 48 : 16;
    if (dir === "v" && e.key === "ArrowLeft") { e.preventDefault(); onDrag(-step); }
    if (dir === "v" && e.key === "ArrowRight") { e.preventDefault(); onDrag(step); }
    if (dir === "h" && e.key === "ArrowUp") { e.preventDefault(); onDrag(-step); }
    if (dir === "h" && e.key === "ArrowDown") { e.preventDefault(); onDrag(step); }
  };

  return (
    <div
      className={`splitter ${dir} ${active ? "active" : ""}`}
      role="separator"
      aria-orientation={dir === "v" ? "vertical" : "horizontal"}
      aria-label={label}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={onDoubleClick}
      onKeyDown={key}
    />
  );
}

/* ───────────── code rendering ───────────── */

export function Highlighted({ code, lang }) {
  const toks = tokenize(code, lang);
  return toks.map((t, i) => (t.t ? <span key={i} className={"tk-" + t.t}>{t.s}</span> : t.s));
}

export function CodeBlock({ code, lang = "python", title, actions = [], maxHeight, onCopied, className = "" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); } catch { /* clipboard blocked */ }
    setCopied(true);
    onCopied?.();
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className={"codeblock " + className}>
      <div className="codeblock-head">
        <span className="codeblock-title">{title || lang}</span>
        <span className="grow" />
        {actions.map((a, i) => (
          <button key={i} className={"btn xs " + (a.primary ? "primary" : "ghost")} onClick={a.onClick} disabled={a.disabled}>
            {a.icon}{a.label}
          </button>
        ))}
        <button className="btn xs ghost" onClick={copy} aria-label="Copy code">
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="codeblock-pre" style={maxHeight ? { maxHeight } : undefined}>
        <code><Highlighted code={code} lang={lang} /></code>
      </pre>
    </div>
  );
}

/* ───────────── markdown (safe: builds React nodes, never raw HTML) ───────────── */

function inline(text, keyBase) {
  const out = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g;
  let last = 0, m, n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code key={keyBase + "c" + n++} className="ic">{m[1].slice(1, -1)}</code>);
    else out.push(<strong key={keyBase + "b" + n++}>{m[2].slice(2, -2)}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, lang = "python", codeActions }) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const nodes = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const code = buf.join("\n");
      nodes.push(
        <CodeBlock key={k++} code={code} lang={fence[1] || lang} actions={codeActions ? codeActions(code) : []} maxHeight={320} />
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      const L = Math.min(h[1].length + 1, 4);
      const Tag = "h" + L;
      nodes.push(<Tag key={k++}>{inline(h[2], "h" + k)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      nodes.push(<Tag key={k++}>{items.map((t, j) => <li key={j}>{inline(t, "l" + j)}</li>)}</Tag>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|([-*]|\d+\.)\s)/.test(lines[i])) buf.push(lines[i++]);
    nodes.push(<p key={k++}>{inline(buf.join(" "), "p" + k)}</p>);
  }
  return <div className="md">{nodes}</div>;
}

/* ───────────── toasts ───────────── */

export function Toasts({ toasts, dismiss }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={"toast " + t.type} role="status">
          <span className="toast-ico">
            {t.type === "success" ? <IconCheck size={15} /> : t.type === "error" ? <IconBug size={15} /> : t.type === "warn" ? <IconAlert size={15} /> : <IconInfo size={15} />}
          </span>
          <span className="toast-msg">{t.message}</span>
          {t.action && (
            <button className="toast-act" onClick={() => { t.action.run(); dismiss(t.id); }}>{t.action.label}</button>
          )}
          <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss"><IconX size={13} /></button>
        </div>
      ))}
    </div>
  );
}

/* ───────────── misc helpers ───────────── */

export const scoreTone = (s) => (s >= 80 ? "ok" : s >= 50 ? "medium" : "critical");

export function timeAgo(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return "";
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return Math.floor(sec / 60) + " min ago";
  if (sec < 86400) return Math.floor(sec / 3600) + " h ago";
  if (sec < 172800) return "yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export { useLayoutEffect, IconSparkles };
