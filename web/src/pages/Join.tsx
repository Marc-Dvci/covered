import { useEffect, useRef, useState } from "react";
import { dollars, LANG_NAMES, WEEK_DAYS, type Lang } from "../../../shared/domain.ts";
import { ORDINANCE_FIELDS, type Agreement } from "../../../shared/agreement.ts";
import { api } from "../api.ts";

interface Draft {
  id: string;
  agreement: Agreement;
  missing: { field: string; label: string; question: string }[];
  readback: { language: Lang; text: string; source: string }[];
  transcript: string | null;
  source: string;
  notes: string[];
}

const LANGS: Lang[] = ["en", "ko", "es", "pt", "pl", "vi", "zh", "fr", "ru", "so", "it"];

export function JoinPage() {
  const [areas, setAreas] = useState<string[]>([]);
  const [form, setForm] = useState({
    householdName: "The Parks", area: "Capitol Hill", language: "ko" as Lang,
    jobText: "Two-bedroom apartment, a cat, two kids. Kitchen, bathrooms, floors and changing sheets. Every Saturday morning at 10, about three hours. We'd like the same cleaner each time.",
    memberLanguage: "pt" as Lang,
    memberText: "Cobro 38 dólares por hora. Se cancelarem com menos de 24 horas, cobro metade.",
  });
  const [audio, setAudio] = useState<{ mimeType: string; data: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api<string[]>("/api/signup/areas").then(setAreas), []);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async () => {
    setBusy("draft");
    setError(null);
    try {
      setDraft(await api<Draft>("/api/agreements/draft", { ...form, memberText: audio ? undefined : form.memberText, memberAudio: audio ?? undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const sign = async () => {
    if (!draft) return;
    setBusy("sign");
    try {
      const r = await api<{ approveUrl: string }>(`/api/agreements/${draft.id}/sign`, {});
      window.location.href = r.approveUrl;
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="stack">
        <h1>A new household joins</h1>
        <p className="lede">The household describes the job; the member says their terms in their own language. The assistant drafts the agreement, and the cooperative's checklist decides whether it can be signed.</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "2rem" }}>
        <section className="stack" aria-label="Household">
          <h2>The household</h2>
          <label>Name<input value={form.householdName} onChange={set("householdName")} /></label>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <label style={{ flex: 1 }}>Neighborhood<select value={form.area} onChange={set("area")}>{areas.map((a) => <option key={a}>{a}</option>)}</select></label>
            <label style={{ flex: 1 }}>Language<select value={form.language} onChange={set("language")}>{LANGS.map((l) => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}</select></label>
          </div>
          <label>The job, in their words<textarea value={form.jobText} onChange={set("jobText")} rows={6} /></label>
        </section>
        <section className="stack" aria-label="Member">
          <h2>The member's terms</h2>
          <label>Member's language<select value={form.memberLanguage} onChange={set("memberLanguage")}>{(["pt", "pl", "es", "en", "fr", "zh", "ru"] as Lang[]).map((l) => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}</select></label>
          <label>Said or typed in their language<textarea value={form.memberText} onChange={set("memberText")} rows={4} disabled={!!audio} /></label>
          <Recorder onAudio={setAudio} hasAudio={!!audio} />
        </section>
      </div>
      <div className="row">
        <button className="btn" disabled={!!busy} onClick={submit}>{busy === "draft" ? "Drafting…" : "Draft the agreement"}</button>
        {busy === "draft" && <span className="working"><span className="spinner" /> Gemini is reading both sides.</span>}
      </div>
      {error && <p className="reason" role="alert">{error}</p>}
      {draft && <DraftView draft={draft} onChange={setDraft} onSign={sign} busy={busy === "sign"} />}
    </div>
  );
}

function Recorder({ onAudio, hasAudio }: { onAudio: (a: { mimeType: string; data: string } | null) => void; hasAudio: boolean }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => chunks.current.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: r.mimeType.split(";")[0] || "audio/webm" });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        const b64 = btoa(bin);
        onAudio({ mimeType: blob.type, data: b64 });
      };
      r.start();
      setRec(r);
    } catch {
      alert("The microphone is not available in this browser.");
    }
  };
  return (
    <div className="row">
      {rec ? <button className="btn danger small" onClick={() => { rec.stop(); setRec(null); }}>Stop recording</button>
        : <button className="btn secondary small" onClick={start}>Record a voice note instead</button>}
      {!hasAudio && !rec && <button className="btn quiet small" onClick={async () => {
        const buf = new Uint8Array(await (await fetch("/samples/teresa-terms-pt.mp3")).arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        onAudio({ mimeType: "audio/mp3", data: btoa(bin) });
      }}>Use the sample voice note (Portuguese)</button>}
      {hasAudio && <><span className="chip s-held">voice note ready</span><button className="btn quiet small" onClick={() => onAudio(null)}>Use the text</button></>}
    </div>
  );
}

function DraftView({ draft, onChange, onSign, busy }: { draft: Draft; onChange: (d: Draft) => void; onSign: () => void; busy: boolean }) {
  const a = draft.agreement;
  const [rate, setRate] = useState(String((a.rateCentsPerHour ?? 0) / 100));
  const missing = new Set(draft.missing.map((m) => m.field));
  const update = async (patch: Partial<Agreement>) => onChange(await api<Draft>(`/api/agreements/${draft.id}/update`, patch));
  return (
    <section className="stack" aria-label="Draft agreement" style={{ borderTop: "3px solid var(--ink)", paddingTop: "1rem" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>Draft agreement</h2>
        <small>{draft.source === "form" ? "filled by hand" : `drafted (${draft.source})`}</small>
      </div>
      {draft.transcript && <p className="muted">Member said: <span lang="pt">“{draft.transcript}”</span>{a.memberTerms ? ` (${a.memberTerms})` : ""}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "2rem" }}>
        <div className="stack">
          <h3>Seattle ordinance checklist</h3>
          {ORDINANCE_FIELDS.map((f) => (
            <div className="check" key={f.field}>
              <span className={missing.has(f.field) ? "miss" : "tick"} aria-hidden="true">{missing.has(f.field) ? "✕" : "✓"}</span>
              <span>{f.label}{missing.has(f.field) && <><br /><small className="reason">{f.question}</small></>}</span>
            </div>
          ))}
          <small className="muted">A template following Seattle's Domestic Workers Ordinance, not legal advice.</small>
        </div>
        <div className="stack">
          <h3>Terms</h3>
          <dl className="kv">
            <dt>When</dt><dd>{a.schedule.weekday !== null ? `${WEEK_DAYS[a.schedule.weekday]} ${a.schedule.start ?? "?"}, ${(a.schedule.minutes ?? 0) / 60} h, ${a.schedule.frequency ?? "?"}` : "to be agreed"}</dd>
            <dt>Work</dt><dd>{a.scope.join("; ") || "to be agreed"}</dd>
            <dt>Needs</dt><dd>{a.needs.join(", ") || "none"}{a.sameCleaner ? ", same cleaner" : ""}</dd>
            <dt>Rate</dt><dd className="row" style={{ flexWrap: "nowrap" }}>$<input aria-label="Hourly rate in dollars" value={rate} onChange={(e) => setRate(e.target.value)} style={{ width: "6rem" }} /> /h <button className="btn quiet small" onClick={() => update({ rateCentsPerHour: Math.round(Number(rate) * 100) })}>Update</button></dd>
            <dt>Cancel</dt><dd>{a.cancellation.noticeHours} h notice, {a.cancellation.lateCancelPct}% fee inside it, {a.cancellation.lockoutPct}% if locked out</dd>
          </dl>
          {draft.notes.map((n) => <p key={n} className="reason">{n}</p>)}
          {(missing.has("scope") || missing.has("schedule") || missing.has("location")) && <ManualFields a={a} update={update} />}
        </div>
      </div>
      {draft.readback.length > 0 && (
        <div className="stack">
          <h3>Read-back</h3>
          {draft.readback.map((r) => <div className="msg" key={r.language}><span className="who">{LANG_NAMES[r.language]}</span><span lang={r.language}>{r.text}</span></div>)}
        </div>
      )}
      <div className="row">
        <button className="btn" disabled={draft.missing.length > 0 || busy} onClick={onSign}>{busy ? "Opening PayPal…" : "Sign and save PayPal"}</button>
        {draft.missing.length > 0 ? <span className="reason">{draft.missing.length} item{draft.missing.length > 1 ? "s" : ""} missing before signing</span>
          : <small className="muted">PayPal opens to save the household's account once. Each visit is held {a.cancellation.noticeHours} hours before: {a.rateCentsPerHour && a.schedule.minutes ? dollars(Math.round((a.rateCentsPerHour * (a.schedule.minutes + a.extraAllowanceMinutes)) / 60)) : ""}.</small>}
      </div>
    </section>
  );
}

function ManualFields({ a, update }: { a: Agreement; update: (p: Partial<Agreement>) => Promise<void> }) {
  const [scope, setScope] = useState(a.scope.join("; "));
  const [weekday, setWeekday] = useState(String(a.schedule.weekday ?? 5));
  const [start, setStart] = useState(a.schedule.start ?? "10:00");
  const [hours, setHours] = useState(String((a.schedule.minutes ?? 180) / 60));
  return (
    <div className="stack" aria-label="Fill in by hand">
      <h3>Fill in by hand</h3>
      <label>Work on each visit<input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="kitchen; bathrooms; floors" /></label>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <label style={{ flex: 1 }}>Day<select value={weekday} onChange={(e) => setWeekday(e.target.value)}>{WEEK_DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
        <label style={{ flex: 1 }}>Start<input value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label style={{ flex: 1 }}>Hours<input value={hours} onChange={(e) => setHours(e.target.value)} /></label>
      </div>
      <button className="btn secondary" onClick={() => update({
        scope: scope.split(";").map((x) => x.trim()).filter(Boolean), location: a.location || a.area,
        schedule: { weekday: Number(weekday), start, minutes: Math.round(Number(hours) * 60), frequency: "weekly" },
      })}>Apply</button>
    </div>
  );
}
