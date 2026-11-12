import fs from "node:fs";
import path from "node:path";

/**
 * where the installed skill's social schema puts the message-house and directions sections. Skill 2026.11.03.7
 * folded both into `data/brief.md`; an older skill keeps `data/message-house.md` / `data/directions.md`. Tests that assert
 * a written path read it from the schema, so they pass on either release while hosts sync.
 */
export function socialPaths(skillDir: string | undefined): { house: string; directions: string } {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(skillDir ?? "", "packs", "social", "schema.json"), "utf8"));
    return { house: s.files.brief.sections.feedback_log.path ?? s.files.brief.path, directions: s.files.directions.sections.week.path ?? s.files.directions.path };
  } catch {
    return { house: "data/message-house.md", directions: "data/directions.md" };
  }
}
