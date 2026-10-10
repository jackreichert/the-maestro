# Playbook: turn a decision you cannot answer into a questionnaire for someone else

Use this when the orchestrator or the user is stuck on a decision whose answer lives in another person's head: a colleague, a client, an outside partner. The shape (ask the user about the send, then write questions that target the gap) is borrowed from the `to-questionnaire` skill in [mattpocock/skills](https://github.com/mattpocock/skills); this version is our own. A cheap runner can follow it once the user has answered step 1.

Existing mechanism, and why this adds something: an `ask` on the board puts a question to the user. It does not help when the user cannot answer it. This produces a document the user can send on, that the recipient can answer without us in the room.

## 1. Ask the user about the send, not the subject

One exchange, two answers:

- Who receives it: their role, what they know that we do not, and their relationship to the user. This sets tone and how much context to carry.
- What the user needs back: the decisions or facts they cannot settle alone. Done when that is a concrete list.

If the user already said both in the request, do not ask again.

## 2. Write the questionnaire

Write markdown to a scratch path the user names (default: the scripts scratch folder, never `/tmp`), copy-ready for email or chat. Rules:

- **Self-contained.** The recipient has not seen this conversation. No ledger ids, ticket ids, vault notes, internal tool names or agent talk. Say what a system is for, not what we call it.
- **Most important question first.** A reply may arrive only once.
- **One idea per question**, never compound. Group under headings once there are more than five.
- **Every question carries context** (one or two sentences on why we ask) **and a suggested default** ("If we hear nothing, we will assume X"), so a partial answer still unblocks work. Mark each default as a default, not a fact.
- **An answer stub under each question**: a line starting with `>`.
- **No secrets, no personal data.** Counts and ids only; no names of patients, caregivers or customers.
- Close with "Anything else we should know?".

Template:

```markdown
# <Title>

**Purpose:** <why this exists and the decision riding on it>
**From:** <sender role>  **To:** <recipient role>  **Please reply by:** <date>

## Context

<One short paragraph for someone who was not here.>

## How to answer

Short answers are fine. "I don't know" is a useful answer. If you are unsure, say so rather than skipping.

## <Theme>

### 1. <One question, one idea?>

Context: <why we ask>
Suggested default: <what we will do if we hear nothing>

>

## Anything else?

>
```

## 3. Check and hand back

Before reporting, reread the file as the recipient: any word they could not look up, any id, any reference to "earlier"? Remove it. Report the file path and the list of the user's needs, each mapped to the question number that covers it. Do not send it: sending is the user's act.

## Fictional example

Situation: the team cannot decide whether to retire an old nightly export, and the only person who knows who uses it is a partner's operations lead.

```markdown
# Nightly export: who still depends on it?

**Purpose:** We want to switch off the old nightly file export on 1 December and need to know nothing you rely on will break.
**From:** Product lead, Fernwood Tools  **To:** Operations lead, Harbor Lane Supplies  **Please reply by:** 12 November

## Context

Since spring we have offered a live feed alongside the nightly file. Keeping both costs us time. Before we retire the file we want to hear whether your side still reads it.

## How to answer

Short answers are fine. "I don't know" is useful, and so is a name of someone who does.

## Usage

### 1. Does anything on your side still read the nightly file?

Context: our logs show it is downloaded most days, but not by whom.
Suggested default: we assume yes, one script, owned by your finance team.

>

### 2. If it were switched off on 1 December, what is the latest date that would still be safe for you?

Context: this fixes our plan, and a late date costs us little.
Suggested default: 1 January.

>

## Anything else?

>
```
