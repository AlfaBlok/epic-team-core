import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * generic persona templates, `the code repo/personas/templates/<name>.md` in the EpicSpine
 * persona file format (epicspine-skill references/personas.md: frontmatter name, template, model, host; sections
 * Remit, Reads, Writes; optional `skills:` list). The New persona dialog lists them (GET /api/persona-templates) and fills the form from one.
 * Read from PERSONA_TEMPLATES_DIR, else the release's `app/personas/templates`, else the source tree's.
 */
export interface PersonaTemplate {
  name: string;
  template: string;
  model: string;
  host: string;
  /** team skills the persona uses (`skills: [a, b]` or a `- a` block list); [] when none. */
  skills: string[];
  remit: string;
  reads: string;
  writes: string;
  /** What the persona's console remit starts as: the three sections in one text. */
  prompt: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the templates are: env first, then the release layout (app/server/src → app/personas), then the repo. */
export function templateDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.PERSONA_TEMPLATES_DIR, path.resolve(here, "../../personas/templates"), path.resolve(here, "../../../../personas/templates")].filter(
    (d): d is string => !!d,
  );
}

const section = (body: string, name: string) => {
  const m = new RegExp(`(?:^|\\n)## ${name}[ \\t]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body);
  return m ? m[1].trim() : "";
};

const unquote = (v: string) => v.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");

/** One template file → template, or undefined when it is not a valid persona file (missing key or section). */
export function parseTemplate(text: string, stem: string): PersonaTemplate | undefined {
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const front: Record<string, string> = {};
  const items: Record<string, string[]> = {};
  let key = "";
  for (const line of text.slice(3, end).split("\n")) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && key && !front[key]) (items[key] ??= []).push(unquote(item[1]));
    else {
      const i = line.indexOf(":");
      if (i > 0) front[(key = line.slice(0, i).trim().toLowerCase())] = unquote(line.slice(i + 1));
    }
  }
  const skills = /^\[.*\]$/.test(front.skills ?? "") ? front.skills.slice(1, -1).split(",").map(unquote).filter(Boolean) : (items.skills ?? []);
  const body = text.slice(end + 4);
  const remit = section(body, "Remit");
  const reads = section(body, "Reads");
  const writes = section(body, "Writes");
  if (!front.name || front.name !== stem || !front.template || !front.model || !front.host || !remit || !reads || !writes) return undefined;
  return { name: front.name, template: front.template, model: front.model, host: front.host, skills, remit, reads, writes, prompt: `${remit}\n\nReads: ${reads}\n\nWrites: ${writes}` };
}

/** Every valid template in the first directory that exists, by name. */
export function listTemplates(dirs: string[] = templateDirs()): PersonaTemplate[] {
  const dir = dirs.find((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
  if (!dir) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort()
    .flatMap((f) => parseTemplate(fs.readFileSync(path.join(dir, f), "utf8"), f.slice(0, -3)) ?? []);
}
