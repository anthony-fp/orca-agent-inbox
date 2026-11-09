# Goal line

Status: design agreed 2026-11-09. Build after the row buttons ([row-buttons-spec.md](row-buttons-spec.md)).

## Goal

Each agent's section in the Agent Inbox panel shows one line under the agent's title: the overall goal of its work. A person who runs several agents can see what each one is for without reading its rows.

## Source

- The line is the text of the first `## ` heading in the agent's plan file, the same file the panel reads for plan tasks.
- The panel does not change the heading text. It drops the `## ` and trims spaces.
- No model call makes the line, and no text a model reads changes.

## Drawing

- The goal, in the muted text style, under the agent's title and above its first section.
- The line wraps to as many lines as it needs. No text is cut off.
- No plan file, or a plan file with no `## ` heading: no line, and no empty space.
- The line updates when the plan file changes, as plan tasks do now.

## Out of scope

- A goal for an agent with no plan.
- Any change to the plan guidance agents read.
- The inbox mod (cero) and its four looks.
