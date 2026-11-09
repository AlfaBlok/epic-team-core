# Persona templates

Generic starting points for a team's personas: [listener](listener.md), [author](author.md),
[responder](responder.md), [engager](engager.md), [gap-finder](gap-finder.md) (what the owner asked for twice and still
lacks), and the social pack's roles [scout](scout.md), [writer](writer.md), [publisher](publisher.md),
[reporter](reporter.md) (each names its role with a `Pack role: X` line in its Remit).

Each file is a persona in the EpicSpine format: front matter `name`, `template`, `model`, `host` (`local` = the
server the team runs on); sections `## Remit`, `## Reads`, `## Writes`; optional `skills:`, the team skills from
`skills/team-skills.json` that are its key tools. They say who a persona is, never what it is for: no goal, cadence or
write scope, and nothing about one campaign or product. What a persona does for a goal is its assignment, in that
epic's `## Team` table.

Creating a persona from a template copies it into the team repo's own `personas/<name>.md`. Check them with
`python3 <epic-spine skill>/scripts/personas.py personas/*.md`.
