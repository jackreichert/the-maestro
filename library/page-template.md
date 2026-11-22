---
title: "<System, feature, subsystem, or plan>"
repo: "<repo>"
aliases: []
source_paths: []
symbols: []
verified_at: null
verified_revision: null
status: draft
tickets: []
---

Copy one shape. Architecture and feature pages start with the code outline. A plan does not. Omit unused sections. One feature keeps one page.

# Code outline

Use this as the first section of an architecture page and of a feature page.

- Entry points:
- Files and symbols:
- Callers:
- Calls:
- Read first:

Point at the code. Do not paste code. Do not list the tree.

# Architecture

# <System or boundary>

Read when: <You need the system, its edges, or where to start.>

## Code outline

<Entry points, files and symbols, callers, calls, and reading order.>

## What the system is

<Purpose and edges.>

## How the parts connect

<Main parts, what this exposes, what it calls, and where the data sits.>

## Run and test

<Links only. Do not copy commands.>

## Related

- <Canonical docs, library pages, and decisions.>

# Feature

# <Feature or subsystem>

Read when: <The question or task this page answers.>

## Code outline

<Entry points, files and symbols, callers, calls, and reading order.>

## What it does

<What a person can do, plus vocabulary and responsibilities.>

## How it works

<Flow from entry to effect, invariants, boundaries, and where a change usually lands.>

## Working with it

<Links to setup, build, test, and runbooks. Do not copy commands or policy.>

## Pitfalls

<Verified non-obvious behavior, not guesses.>

## Verification

<Checks, evidence and source revision, and stale sections.>

## Related

- <Canonical docs, library pages, plans, and decisions.>

# Plan

# <Plan>

Read when: <You need the goal, the decision, or the acceptance criteria.>

## Goal

<What this change is for.>

## Decision

<The choice.>

## Acceptance

<Checkable outcomes.>

## Code

<Files and symbols. Point at the code. Do not paste code.>

Link this page from the feature page it changes.
