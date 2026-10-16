# Lauri's shared skills

Skill packages reusable across projects. Each skill is a directory with a
`SKILL.md` whose YAML frontmatter has a `name` and a `description`, and whose body
is the procedure. This is the Claude Code skill format; if another harness wants
a different shape (a single Markdown file, a different frontmatter key), the
content is the portable part and the wrapper is easy to reshape.

## Skills here

| Skill | Use it when |
| --- | --- |
| [verify-generated-artifact](verify-generated-artifact/SKILL.md) | A build produced a file something else will load, and you are about to say it works |

## How to make one available

- Claude Code, one project: copy or symlink the skill directory into that
  project's `.claude/skills/`.
- Claude Code, every project: symlink it into `~/.claude/skills/`.
- The scripts a skill refers to are in `../scripts/`; a skill should name the path
  it expects rather than duplicating the code.

## Writing one that is worth keeping

A skill earns its place if it encodes a **procedure you would otherwise re-derive**
— an ordered set of checks, a decision rule, a trap to avoid — and if it names the
concrete evidence the work must produce. A skill that restates general advice
("be careful", "write good code") is noise in the context window of every future
session, which is a real cost. Keep the body short, the steps ordered, and the
exit condition explicit.
