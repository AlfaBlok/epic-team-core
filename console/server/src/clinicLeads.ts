import fs from "node:fs";
import path from "node:path";
import type { FileWrite } from "./clinicFollowUp.js";
import { repoFileWriter } from "./clinicFollowUp.js";

/**
 * Each call qualifies the lead (the owner's live call 27 Nov, call_065c7b6e: "estar listo para hacer
 * esta promo concreta para esta audiencia concreta"; his 13:02Z words: "capture requirements ... look at all of it in
 * aggregate").
 *
 *   a posted letter's code ──▶ the call page ?c=<code> ──▶ a call with the rep ──▶ qualify_lead (who answered, what
 *        they ask, what they need, their answer) ──▶ one lead row in the objective's Dental clinics table
 *        (docs/trackers/voice-clinic/dental-clinics.csv), the row whose Code is the letter's
 *
 * A call with a code always lands: when the rep never called qualify_lead, the call's end writes what the caller asked
 * from the transcript and "no lo dijo" for who answered. A call without a code lands only when the rep qualified a
 * clinic, as a new row with status `inbound` (never one of the letters' rows). The table holds the business and the role
 * of who answered, never a person's phone or email: those stay in the console's call record.
 */

export const LEAD_COLUMNS = [
  "Name",
  "Status",
  "Code",
  "City",
  "Postal address",
  "Company or sole trader",
  "Robinson checked",
  "Source",
  "Posted",
  "Scanned",
  "Called",
  "Who answered",
  "Questions",
  "Needs",
  "Answer",
];
/** statuses a lead row never loses to a call (the test clinic stays a test, a clinic that said no stays no). */
const KEEP = new Set(["test", "no"]);
export const LEAD_FILE = "docs/trackers/voice-clinic/dental-clinics.csv";

export interface Lead {
  call: string;
  /** the letter's code the call page was opened with. */
  code?: string;
  clinic?: string;
  city?: string;
  /** dueño, recepcionista, otra persona (with the role said), no lo dijo. */
  who: string;
  asks: string;
  needs: string;
  /** sí, quizá, no, or what the caller said. */
  answer: string;
  /** AAAA-MM-DD of the call. */
  day: string;
}

/** one cell: one line, no markup, at most `n` characters (a caller's words are data, never markup). */
export const leadCell = (s: unknown, n = 300) =>
  String(s ?? "")
    .replace(/[\r\n\t`<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

const plain = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** who answered, in the table's three words (the owner's): dueño, recepcionista or otra persona (its role kept). */
export function whoAnswered(said: string): string {
  const t = plain(said);
  if (!t) return "no lo dijo";
  if (/\b(duen|propietari|director|directora|gerente|socio|socia|owner|titular)/.test(t)) return "dueño";
  if (/\b(recepcion|recepcionista|receptionist|secretari)/.test(t)) return "recepcionista";
  if (/no lo (dijo|se)|desconocid/.test(t)) return "no lo dijo";
  return `otra persona: ${leadCell(said, 60)}`;
}

/** the caller's questions from a call's text: their lines that ask something, joined. */
export function questionsIn(transcript: { who: string; text: string }[]): string {
  const asks = transcript
    .filter((l) => l.who !== "voice")
    .map((l) => leadCell(l.text, 200))
    .filter((t) => /[?¿]/.test(t) || /^(cu[aá]nto|c[oó]mo|qu[eé]|d[oó]nde|cu[aá]ndo|puede|se puede|tiene)\b/i.test(t));
  return leadCell(asks.join(" / "), 600);
}

// ---------- the table as csv (the same dialect scripts/trackers.py writes: Python's csv, \n line ends) ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        f += '"';
        i++;
      } else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(f);
      f = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else f += ch;
  }
  if (f !== "" || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export const toCsv = (rows: string[][]) => rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";

/** the table with this call's lead in it: the row of its code, else the row of its clinic's name, else a new row. */
export function withLead(text: string | undefined, lead: Lead): { text: string; row: string; made: boolean } {
  const all = text ? parseCsv(text) : [];
  const head = all[0]?.length ? all[0] : [...LEAD_COLUMNS];
  for (const c of LEAD_COLUMNS) if (!head.includes(c)) head.push(c);
  const rows = all.slice(1).map((r) => head.map((_, i) => r[i] ?? ""));
  const at = (c: string) => head.indexOf(c);
  const eq = (a: string, b: string) => plain(a) === plain(b) && plain(a) !== "";
  let i = lead.code ? rows.findIndex((r) => eq(r[at("Code")], lead.code!)) : -1;
  if (i < 0 && !lead.code && lead.clinic) i = rows.findIndex((r) => eq(r[at("Name")], lead.clinic!));
  let made = false;
  if (i < 0) {
    const r = head.map(() => "");
    r[at("Name")] = leadCell(lead.clinic, 120) || `Sin nombre (${lead.call})`;
    r[at("Status")] = "inbound";
    r[at("Code")] = leadCell(lead.code, 20);
    r[at("City")] = leadCell(lead.city, 80);
    r[at("Source")] = lead.code ? `llamada ${lead.call}, código sin fila` : `llamada ${lead.call}`;
    rows.push(r);
    i = rows.length - 1;
    made = true;
  }
  const r = rows[i];
  if (!KEEP.has(plain(r[at("Status")])) && plain(r[at("Status")]) !== "inbound") r[at("Status")] = "lead";
  if (!r[at("City")] && lead.city) r[at("City")] = leadCell(lead.city, 80);
  r[at("Called")] = `${lead.day} ${lead.call}`;
  r[at("Who answered")] = leadCell(lead.who, 80) || "no lo dijo";
  r[at("Questions")] = leadCell(lead.asks, 600);
  r[at("Needs")] = leadCell(lead.needs, 600);
  r[at("Answer")] = leadCell(lead.answer, 120);
  return { text: toCsv([head, ...rows]), row: r[at("Name")], made };
}

export interface LeadsDeps {
  /** the checkout the table lives in (the home repo); undefined = no table, the lead stays in the console only. */
  repoDir: () => string | undefined;
  /** the table's path in that checkout (default LEAD_FILE; tests point it elsewhere). */
  rel?: string;
  write?: FileWrite;
  log?: (m: string) => void;
}

export function createLeads(d: LeadsDeps) {
  const write = d.write ?? repoFileWriter();
  const log = d.log ?? ((m: string) => console.warn(m));
  const rel = d.rel ?? LEAD_FILE;
  return {
    /** the table's rows (the console's view and the tests). */
    rows(): Record<string, string>[] {
      const repo = d.repoDir();
      if (!repo) return [];
      try {
        const [head, ...rest] = parseCsv(fs.readFileSync(path.join(repo, rel), "utf8"));
        return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
      } catch {
        return [];
      }
    },
    /** one call's lead into the table (committed and pushed, one at a time); resolves with what was written. */
    land(lead: Lead): Promise<{ state: string; row?: string }> {
      const repo = d.repoDir();
      if (!repo) return Promise.resolve({ state: "no_table" });
      let row: string | undefined;
      return write(
        repo,
        rel,
        (cur) => {
          const w = withLead(cur, lead);
          row = w.row;
          return w.text;
        },
        `Clinic lead from call ${lead.call}${lead.code ? ` (code ${leadCell(lead.code, 20)})` : ""} in the Dental clinics table (via console)`,
      )
        .then((w) => {
          if (w.state === "failed") log(`clinic lead ${lead.call}: ${w.detail}`);
          return { state: w.state, row };
        })
        .catch((e) => {
          log(`clinic lead ${lead.call}: ${(e as Error).message}`);
          return { state: "failed" };
        });
    },
  };
}
export type Leads = ReturnType<typeof createLeads>;
