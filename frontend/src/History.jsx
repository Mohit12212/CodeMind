import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { ConfirmDialog, Menu, scoreTone, timeAgo } from "./ui.jsx";
import {
  IconHistory, IconDownload, IconTrash, IconSearch, IconShield, IconCode, IconBook, IconMore, IconX,
} from "./icons.jsx";

const dayLabel = (ts) => {
  const d = new Date(ts);
  if (isNaN(d)) return "Earlier";
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
};

function save(content, name, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function History({ patchFile, open, notify }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState(null);

  const load = () => api.history().then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const restore = async (id) => {
    try {
      const d = await api.historyItem(id);
      patchFile({ code: d.code, language: d.language, review: d.review, refactor: d.refactor, reviewedCode: d.code });
      notify("Restored into the workspace", "success");
      open();
    } catch (e) { notify(e.message, "error"); }
  };

  const remove = async (id) => {
    try { await api.deleteHistory(id); notify("Record deleted", "info"); load(); }
    catch (e) { notify(e.message, "error"); }
  };

  const clearAll = async () => {
    try { await api.clearHistory(); notify("History cleared", "info"); load(); }
    catch (e) { notify(e.message, "error"); }
  };

  const exportMd = async (id) => {
    try { save(await api.report(id), `codemind-audit-${id}.md`, "text/markdown"); notify("Markdown report saved", "success"); }
    catch (e) { notify(e.message, "error"); }
  };
  const exportSarif = async (id) => {
    try {
      const j = await api.sarifReport(id);
      save(typeof j === "string" ? j : JSON.stringify(j, null, 2), `codemind-audit-${id}.sarif.json`, "application/json");
      notify("SARIF report saved", "success");
    } catch (e) { notify(e.message, "error"); }
  };

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => ((r.preview || "") + " " + (r.language || "") + " " + (r.model || "")).toLowerCase().includes(q));
  }, [rows, search]);

  const groups = useMemo(() => {
    const g = [];
    filtered.forEach((r) => {
      const label = dayLabel(r.ts);
      const last = g[g.length - 1];
      if (last && last.label === label) last.items.push(r);
      else g.push({ label, items: [r] });
    });
    return g;
  }, [filtered]);

  const stats = useMemo(() => {
    if (!rows?.length) return null;
    return {
      total: rows.length,
      avg: Math.round(rows.reduce((a, r) => a + (r.score_before || 0), 0) / rows.length),
      fixed: rows.filter((r) => r.score_after != null).length,
    };
  }, [rows]);

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>History</h1>
          <p className="dim">Every review and refactor is stored on this computer only.</p>
        </div>
        {rows?.length > 0 && (
          <button className="btn danger-ghost" onClick={() => setConfirm("all")}>
            <IconTrash size={14} /> Clear all
          </button>
        )}
      </header>

      {stats && (
        <dl className="stat-strip">
          <div><dt>Audits</dt><dd>{stats.total}</dd></div>
          <div><dt>Average first score</dt><dd className={scoreTone(stats.avg)}>{stats.avg}<small>/100</small></dd></div>
          <div><dt>Refactored</dt><dd>{stats.fixed}</dd></div>
        </dl>
      )}

      {rows?.length > 0 && (
        <div className="search-row big">
          <IconSearch size={15} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by code, language or model" aria-label="Search history" />
          {search && <button className="icon-btn sm" onClick={() => setSearch("")} aria-label="Clear search"><IconX size={14} /></button>}
        </div>
      )}

      {err && <div className="note bad">{err}</div>}

      {rows === null && !err && <div className="skeleton-list">{[0, 1, 2].map((i) => <div key={i} className="skeleton" />)}</div>}

      {rows?.length === 0 && (
        <div className="empty">
          <div className="empty-ico"><IconHistory size={24} /></div>
          <h3>No audits yet</h3>
          <p>Run a review in the workspace and it will be saved here.</p>
          <button className="btn primary" onClick={open}>Go to workspace</button>
        </div>
      )}

      {rows?.length > 0 && filtered.length === 0 && (
        <div className="empty compact"><h3>No results for “{search}”</h3></div>
      )}

      {groups.map((g) => (
        <div key={g.label} className="hist-group">
          <h2 className="group-label">{g.label}</h2>
          <ul className="hist-list">
            {g.items.map((r) => (
              <li key={r.id} className="hist-row">
                <button className="hist-main" onClick={() => restore(r.id)} title="Restore into the workspace">
                  <code className="hist-code">{(r.preview || "(empty snippet)").trim()}</code>
                  <span className="hist-meta">
                    <span className="lang-chip">{r.language}</span>
                    <span>{r.model || "Static analysis"}</span>
                    <span>{r.issues} finding{r.issues === 1 ? "" : "s"}</span>
                    <span title={new Date(r.ts).toLocaleString()}>{timeAgo(r.ts)}</span>
                  </span>
                </button>

                <div className="hist-score" title="Health score before and after refactoring">
                  <b className={scoreTone(r.score_before)}>{r.score_before}</b>
                  {r.score_after != null && (
                    <>
                      <span className="arrow">→</span>
                      <b className={scoreTone(r.score_after)}>{r.score_after}</b>
                    </>
                  )}
                </div>

                <button className="btn xs" onClick={() => restore(r.id)}><IconCode size={13} /> Restore</button>
                <Menu
                  align="right"
                  width={230}
                  button={({ toggle, open: o }) => (
                    <button className="icon-btn" onClick={toggle} aria-haspopup="menu" aria-expanded={o} aria-label="More actions">
                      <IconMore size={17} />
                    </button>
                  )}
                  items={[
                    { label: "Open HTML report", icon: <IconBook size={14} />, onClick: () => window.open(api.htmlReportUrl(r.id), "_blank") },
                    { label: "Download Markdown", icon: <IconDownload size={14} />, onClick: () => exportMd(r.id) },
                    { label: "Download SARIF for CI", icon: <IconShield size={14} />, onClick: () => exportSarif(r.id) },
                    { divider: true },
                    { label: "Delete record", icon: <IconTrash size={14} />, danger: true, onClick: () => setConfirm(r.id) },
                  ]}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}

      {confirm && (
        <ConfirmDialog
          title={confirm === "all" ? "Clear all history?" : "Delete this record?"}
          message={confirm === "all" ? "Every saved audit will be permanently removed from this computer." : "This audit will be permanently removed."}
          confirmLabel={confirm === "all" ? "Clear all" : "Delete"}
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => (confirm === "all" ? clearAll() : remove(confirm))}
        />
      )}
    </section>
  );
}
