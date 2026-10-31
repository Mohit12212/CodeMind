import { useEffect, useRef, useState } from "react";
import { CodeBlock, Markdown, Segmented, Spinner, scoreTone } from "./ui.jsx";
import {
  IconShield, IconBug, IconSparkles, IconTest, IconBook, IconCheck, IconCopy,
  IconDownload, IconGitCommit, IconPlay, IconSend, IconSearch, IconTarget,
  IconZap, IconMessage, IconX, IconUndo, IconAlert, IconChevronRight,
} from "./icons.jsx";

export const SEVERITIES = ["critical", "high", "medium", "low"];

/* ───────────── health gauge ───────────── */

export function Gauge({ score, size = 72 }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const tone = scoreTone(score);
  return (
    <div className={"gauge " + tone} style={{ width: size, height: size }} title={`Health score ${score} out of 100`}>
      <svg viewBox="0 0 72 72">
        <circle className="gauge-track" cx="36" cy="36" r={r} />
        <circle
          className="gauge-arc"
          cx="36" cy="36" r={r}
          strokeDasharray={c}
          strokeDashoffset={c - (Math.max(0, Math.min(100, score)) / 100) * c}
        />
      </svg>
      <span className="gauge-num">{score}</span>
    </div>
  );
}

/* ───────────── summary header ───────────── */

export function Summary({ review, code, counts, filterSev, setFilterSev, onFix, busy, stale, info, goSettings }) {
  const m = review.metrics || {};
  const total = SEVERITIES.reduce((a, k) => a + counts[k], 0);
  return (
    <div className="summary">
      <div className="summary-top">
        <Gauge score={review.score} />
        <div className="summary-main">
          <div className="summary-title">
            {total === 0 ? "No findings" : `${total} finding${total === 1 ? "" : "s"}`}
          </div>
          <div className="sev-row" role="group" aria-label="Filter findings by severity">
            {SEVERITIES.map((k) => (
              <button
                key={k}
                className={`sev-chip ${k} ${filterSev === k ? "on" : ""}`}
                disabled={counts[k] === 0}
                aria-pressed={filterSev === k}
                onClick={() => setFilterSev(filterSev === k ? null : k)}
                title={`Show only ${k} findings`}
              >
                <b>{counts[k]}</b> {k}
              </button>
            ))}
          </div>
        </div>
        <button className="btn primary" onClick={onFix} disabled={!!busy} title="Rewrite the whole file to resolve the findings">
          {busy === "refactor" ? <Spinner /> : <IconSparkles size={15} />}
          {busy === "refactor" ? "Fixing…" : "Fix whole file"}
        </button>
      </div>

      <dl className="metrics">
        {m.complexity != null && (
          <div>
            <dt>Complexity</dt>
            <dd>{m.complexity}<small>{m.complexity <= 5 ? "low" : m.complexity <= 10 ? "moderate" : "high"}</small></dd>
          </div>
        )}
        {m.maintainability != null && (
          <div><dt>Maintainability</dt><dd>{m.maintainability}<small>/100</small></dd></div>
        )}
        <div><dt>Lines</dt><dd>{m.loc || code.split("\n").length}</dd></div>
        <div><dt>Audit time</dt><dd>{review.seconds > 0.1 ? review.seconds : "<0.1"}<small>s</small></dd></div>
      </dl>

      {stale && (
        <div className="note warn">
          <IconAlert size={15} />
          <span>The code changed after this review. Press <b>Ctrl+Enter</b> to refresh the results.</span>
        </div>
      )}
      {review.ai_status === "offline" && (
        <div className="note warn">
          <IconAlert size={15} />
          <span>The AI model is offline, so only static analysis ran.</span>
          <button className="link" onClick={goSettings}>Configure model</button>
        </div>
      )}
      {info && <div className="note info"><span>{info}</span></div>}
    </div>
  );
}

/* ───────────── findings ───────────── */

const sourceLabel = (s = []) =>
  s.includes("model") && s.includes("static") ? "Static + AI"
    : s.includes("static") ? "Static rule"
    : s.includes("custom") ? "Custom rule"
    : "AI inspector";

export function Findings({ issues, total, onLocate, onFix, onAsk, busy, resetFilters, filtered }) {
  if (issues.length === 0) {
    return (
      <div className="empty compact">
        <div className="empty-ico ok"><IconCheck size={22} /></div>
        <h3>{filtered ? "No findings match this filter" : "No problems found"}</h3>
        <p>{filtered ? "Try another severity or clear the search." : "This file passed every static check and the AI inspection."}</p>
        {filtered && <button className="btn" onClick={resetFilters}>Clear filters</button>}
      </div>
    );
  }
  return (
    <ul className="issues">
      {issues.map((i) => (
        <li key={i.id} className={"issue " + i.severity}>
          <div className="issue-head">
            <span className={"sev-tag " + i.severity}>{i.severity}</span>
            <h4>{i.title}</h4>
          </div>
          <div className="issue-meta">
            <button className="loc" onClick={() => onLocate(i.line)} title="Jump to this line in the editor">
              <IconTarget size={13} /> Line {i.line}
            </button>
            <span>{sourceLabel(i.sources)}</span>
            {i.standards?.map((s) => <span key={s} className="std">{s}</span>)}
          </div>
          <p className="issue-detail">{i.detail}</p>
          {i.evidence && <code className="evidence">{i.evidence}</code>}
          {i.suggestion && (
            <div className="remedy"><b>How to fix</b><span>{i.suggestion}</span></div>
          )}
          <div className="issue-actions">
            <button className="btn primary xs" onClick={() => onFix(i)} disabled={!!busy}>
              {busy === "fix:" + i.id ? <Spinner size={12} /> : <IconSparkles size={13} />}
              {busy === "fix:" + i.id ? "Fixing…" : "Quick fix"}
            </button>
            <button className="btn ghost xs" onClick={() => onAsk(i)}>
              <IconMessage size={13} /> Ask Copilot
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ───────────── compliance ───────────── */

export function Compliance({ review }) {
  if (!review.compliance) {
    return (
      <div className="empty compact">
        <div className="empty-ico"><IconShield size={22} /></div>
        <h3>Compliance matrix needs Python</h3>
        <p>OWASP and CWE checks are available for Python files.</p>
      </div>
    );
  }
  const { percent, rows } = review.compliance;
  return (
    <div className="compliance">
      <div className="comp-head">
        <div>
          <h3>OWASP and CWE checks</h3>
          <p className="dim small">{rows.filter((r) => r.status === "pass").length} of {rows.length} categories pass</p>
        </div>
        <div className={"comp-pct " + scoreTone(percent)}>{percent}%</div>
      </div>
      <div className="comp-bar"><i className={scoreTone(percent)} style={{ width: percent + "%" }} /></div>
      <ul className="comp-list">
        {rows.map((r) => (
          <li key={r.name} className={r.status}>
            <span className="comp-ico">{r.status === "pass" ? <IconCheck size={14} /> : <IconX size={14} />}</span>
            <div className="comp-text">
              <b>{r.name}</b>
              <span>{r.cwe}{r.count ? `, ${r.count} violation${r.count > 1 ? "s" : ""}` : ""}</span>
            </div>
            <span className="comp-badge">{r.status === "pass" ? "Pass" : "Fail"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────── refactor + diff ───────────── */

function Delta({ label, a, b, lowerBetter }) {
  if (a == null || b == null) return null;
  const better = lowerBetter ? b < a : b > a;
  const same = a === b;
  return (
    <div className="delta">
      <span>{label}</span>
      <b>{a}<IconChevronRight size={12} /><em className={same ? "" : better ? "good" : "bad"}>{b}</em></b>
    </div>
  );
}

function Diff({ rows, mode }) {
  if (mode === "split") {
    return (
      <div className="diff split">
        {rows.map((r, i) => (
          <div className="drow" key={i}>
            <span className="dn">{r.ln ?? ""}</span>
            <code className={r.l !== null && r.t !== "same" ? "del" : ""}>{r.l ?? ""}</code>
            <span className="dn">{r.rn ?? ""}</span>
            <code className={r.r !== null && r.t !== "same" ? "add" : ""}>{r.r ?? ""}</code>
          </div>
        ))}
      </div>
    );
  }
  const out = [];
  rows.forEach((r, i) => {
    if (r.t === "same") out.push({ k: i + "s", sign: " ", n: r.rn ?? r.ln, text: r.r ?? r.l ?? "", cls: "" });
    else {
      if (r.l !== null) out.push({ k: i + "d", sign: "−", n: r.ln, text: r.l, cls: "del" });
      if (r.r !== null) out.push({ k: i + "a", sign: "+", n: r.rn, text: r.r, cls: "add" });
    }
  });
  return (
    <div className="diff unified">
      {out.map((o) => (
        <div className={"urow " + o.cls} key={o.k}>
          <span className="dn">{o.n ?? ""}</span>
          <span className="sign">{o.sign}</span>
          <code>{o.text}</code>
        </div>
      ))}
    </div>
  );
}

export function RefactorPanel({
  refactor, review, language, busy, onRun, onApply, onCommit, commitData, onCopy, onDownload, diffMode, setDiffMode,
}) {
  if (!refactor) {
    return (
      <div className="empty">
        <div className="empty-ico"><IconSparkles size={22} /></div>
        <h3>Rewrite the whole file</h3>
        <p>Resolve every finding at once, then check the result with AST-Guard before you apply it.</p>
        <button className="btn primary" onClick={onRun} disabled={!!busy || !review}>
          {busy === "refactor" ? <Spinner /> : <IconSparkles size={15} />}
          {busy === "refactor" ? "Refactoring…" : "Refactor file"}
        </button>
        {!review && <p className="dim small">Run a review first so the refactor knows what to fix.</p>}
      </div>
    );
  }
  const cleanCode = refactor.rows.filter((r) => r.r !== null).map((r) => r.r).join("\n");
  return (
    <div className="stack">
      <div className="bar">
        <Segmented
          value={diffMode}
          onChange={setDiffMode}
          label="Diff view"
          options={[
            { value: "unified", label: "Changes" },
            { value: "split", label: "Side by side" },
            { value: "clean", label: "Result" },
          ]}
        />
        <span className="grow" />
        <button className="btn ghost xs" onClick={onCommit} disabled={!!busy} title="Generate a conventional commit message">
          {busy === "commit" ? <Spinner size={12} /> : <IconGitCommit size={13} />} Commit message
        </button>
        <button className="btn ghost xs" onClick={() => onCopy(refactor.code)}><IconCopy size={13} /> Copy</button>
        <button className="btn ghost xs" onClick={onDownload}><IconDownload size={13} /> Save</button>
        <button className="btn primary" onClick={onApply}><IconCheck size={15} /> Apply to editor</button>
      </div>

      <div className="deltas">
        <div className="delta">
          <span>AST-Guard</span>
          <b><em className={refactor.ast_guard === "valid" ? "good" : ""}>{refactor.ast_guard === "valid" ? "Passed" : "Skipped"}</em></b>
        </div>
        {refactor.before && (
          <>
            <Delta label="Health" a={refactor.score_before} b={refactor.score_after} />
            <Delta label="Complexity" a={refactor.before.complexity} b={refactor.after.complexity} lowerBetter />
            <Delta label="Maintainability" a={refactor.before.maintainability} b={refactor.after.maintainability} />
            <Delta label="Defects" a={refactor.before.issues} b={refactor.after.issues} lowerBetter />
          </>
        )}
      </div>

      {commitData && (
        <CodeBlock
          title="Commit message"
          lang="text"
          code={commitData.commit_message}
          onCopied={() => {}}
        />
      )}

      {refactor.changes?.length > 0 && (
        <ul className="changes">
          {refactor.changes.map((c) => <li key={c}><IconCheck size={13} />{c}</li>)}
        </ul>
      )}

      {refactor.remaining?.length > 0 && (
        <div className="note warn block">
          <IconAlert size={15} />
          <div>
            <b>Still needs your attention</b>
            <ul>{refactor.remaining.map((r) => <li key={r.id}>Line {r.line}: {r.title}</li>)}</ul>
          </div>
        </div>
      )}

      {diffMode === "clean"
        ? <CodeBlock code={cleanCode} lang={language} title="Refactored file" maxHeight="none" />
        : <Diff rows={refactor.rows} mode={diffMode} />}
    </div>
  );
}

/* ───────────── tests ───────────── */

export function TestsPanel({ tests, language, busy, onGenerate, onRun, result, onDownload, canRun }) {
  return (
    <div className="stack">
      <div className="bar">
        <h3>Unit tests</h3>
        <span className="grow" />
        {tests && canRun && (
          <button className="btn xs" onClick={onRun} disabled={!!busy}>
            {busy === "run_tests" ? <Spinner size={12} /> : <IconPlay size={12} />} Run tests
          </button>
        )}
        <button className={"btn xs " + (tests ? "ghost" : "primary")} onClick={onGenerate} disabled={!!busy}>
          {busy === "tests" ? <Spinner size={12} /> : <IconTest size={13} />}
          {busy === "tests" ? "Generating…" : tests ? "Regenerate" : "Generate tests"}
        </button>
      </div>

      {result && (
        <div className={"test-result " + (result.passed ? "pass" : "fail")}>
          <div className="tr-head">
            {result.passed ? <IconCheck size={15} /> : <IconX size={15} />}
            <b>{result.passed ? "All tests passed" : "Some tests failed"}</b>
            <span className="grow" />
            <span className="dim small">{result.duration_ms} ms</span>
          </div>
          {result.output && <pre>{result.output}</pre>}
        </div>
      )}

      {!tests ? (
        <div className="empty compact">
          <div className="empty-ico"><IconTest size={22} /></div>
          <h3>No tests yet</h3>
          <p>Generate a suite covering normal input, edge cases, boundaries and expected errors.</p>
        </div>
      ) : (
        <CodeBlock
          code={tests}
          lang={language}
          title="Generated tests"
          maxHeight="none"
          actions={[{ label: "Save", icon: <IconDownload size={13} />, onClick: onDownload }]}
        />
      )}
    </div>
  );
}

/* ───────────── threat model ───────────── */

export function ThreatPanel({ explanation, busy, onRun }) {
  return (
    <div className="stack">
      <div className="bar">
        <h3>Threat model</h3>
        <span className="grow" />
        <button className={"btn xs " + (explanation ? "ghost" : "primary")} onClick={onRun} disabled={!!busy}>
          {busy === "explain" ? <Spinner size={12} /> : <IconBook size={13} />}
          {busy === "explain" ? "Analyzing…" : explanation ? "Regenerate" : "Analyze code"}
        </button>
      </div>
      {!explanation ? (
        <div className="empty compact">
          <div className="empty-ico"><IconBook size={22} /></div>
          <h3>Understand the attack surface</h3>
          <p>Get an architecture breakdown, data flow, threat vectors and scaling advice for this file.</p>
        </div>
      ) : (
        <Markdown text={explanation} />
      )}
    </div>
  );
}

/* ───────────── copilot ───────────── */

const STARTERS = [
  { icon: <IconZap size={16} />, title: "Optimize", text: "Optimize this code for execution speed and lower memory.", desc: "Faster and leaner" },
  { icon: <IconShield size={16} />, title: "Show an exploit", text: "Demonstrate an exploit or attack payload that abuses the bugs here.", desc: "See how it breaks" },
  { icon: <IconBook size={16} />, title: "Add types and docs", text: "Add strict type hints and complete docstrings.", desc: "Readable and checked" },
  { icon: <IconUndo size={16} />, title: "Make it async", text: "Convert this synchronous code to idiomatic async/await.", desc: "Non-blocking I/O" },
];

export function CopilotPanel({ messages, busy, onSend, onApply, onClear, language, model }) {
  const [draft, setDraft] = useState("");
  const end = useRef(null);
  const box = useRef(null);

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages, busy]);
  useEffect(() => { box.current?.focus(); }, []);

  const resize = (el) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  };
  const send = (text) => {
    const t = (text ?? draft).trim();
    if (!t || busy) return;
    onSend(t);
    setDraft("");
    if (box.current) box.current.style.height = "auto";
  };

  return (
    <div className="copilot">
      <div className="copilot-scroll">
        {messages.length === 0 ? (
          <div className="copilot-empty">
            <div className="empty-ico accent"><IconSparkles size={22} /></div>
            <h3>Ask about this file</h3>
            <p>Copilot reads your current file and its findings. Start with a suggestion or type your own question.</p>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s.title} className="starter" onClick={() => send(s.text)} disabled={!!busy}>
                  <span className="starter-ico">{s.icon}</span>
                  <span className="starter-title">{s.title}</span>
                  <span className="starter-desc">{s.desc}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="thread">
            {messages.map((m, i) => (
              <div key={i} className={"msg " + m.role + (m.error ? " error" : "")}>
                {m.role === "user" ? (
                  <div className="bubble">{m.text}</div>
                ) : (
                  <div className="reply">
                    <Markdown
                      text={m.text}
                      lang={language}
                      codeActions={(code) => [
                        { label: "Apply to editor", icon: <IconCheck size={13} />, primary: true, onClick: () => onApply(code) },
                      ]}
                    />
                  </div>
                )}
              </div>
            ))}
            {busy === "copilot" && (
              <div className="msg assistant"><div className="reply typing"><Spinner size={13} /> Thinking…</div></div>
            )}
            <div ref={end} />
          </div>
        )}
      </div>

      <div className="composer">
        {messages.length > 0 && (
          <div className="chips-row">
            {STARTERS.map((s) => (
              <button key={s.title} className="chip" onClick={() => send(s.text)} disabled={!!busy}>{s.title}</button>
            ))}
            <span className="grow" />
            <button className="chip ghost" onClick={onClear}>Clear chat</button>
          </div>
        )}
        <div className="composer-box">
          <textarea
            ref={box}
            rows={1}
            value={draft}
            placeholder="Ask a question about this code"
            aria-label="Message Copilot"
            onChange={(e) => { setDraft(e.target.value); resize(e.target); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
          />
          <button className="send" onClick={() => send()} disabled={!!busy || !draft.trim()} aria-label="Send message">
            <IconSend size={16} />
          </button>
        </div>
        <div className="composer-hint">
          <span><kbd className="kbd">Enter</kbd> send <kbd className="kbd">Shift</kbd><kbd className="kbd">Enter</kbd> new line</span>
          {model && <span className="model-hint">{model}</span>}
        </div>
      </div>
    </div>
  );
}

export { IconSearch, IconBug };
