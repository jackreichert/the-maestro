#!/usr/bin/env zsh
# walkthrough.zsh: walk a human through steps only they can do, one at a time.
# Usage: walkthrough.zsh <steps-file>
# The steps file is sourced; its contract is in playbooks/walkthrough.md.
# Exit codes: 0 every step passed, 1 a step failed (the run stops there), 2 bad usage or steps file.
# Never prints a check command's output or a variable's value: only pass/fail, names, and plan counts.

emulate -L zsh
setopt no_unset pipe_fail

die_usage() {
  print -r -u2 -- "walkthrough: $1"
  exit 2
}

pause() {
  local reply
  print -n -r -- "  Press Enter when done (q to stop): "
  if ! read -r reply; then
    print -r -- ""
    print -r -- "  Input ended. Stopping."
    exit 1
  fi
  if [[ $reply == q ]]; then
    print -r -- "  Stopped by you."
    exit 1
  fi
}

check_needs() {
  local id=$1 var_name=$2 name
  local -a needs
  (( $+parameters[$var_name] )) && needs=(${(P)var_name})
  local missing=0
  for name in $needs; do
    if [[ -n ${(P)name:-} ]]; then
      print -r -- "  needs $name: set"
    else
      print -r -- "  needs $name: MISSING"
      missing=1
    fi
  done
  return $missing
}

parse_plan_line() {
  local out=$1 line
  local -a lines
  lines=("${(@f)out}")
  line=${lines[(r)PLAN *]:-}
  [[ -n $line ]] || return 1
  PLAN_ADD=${${(M)${(z)line}:#add=*}#add=}
  PLAN_CHANGE=${${(M)${(z)line}:#change=*}#change=}
  PLAN_DESTROY=${${(M)${(z)line}:#destroy=*}#destroy=}
  PLAN_REPLACE=${${(M)${(z)line}:#replace=*}#replace=}
  [[ $PLAN_ADD == <-> && $PLAN_CHANGE == <-> && $PLAN_DESTROY == <-> && $PLAN_REPLACE == <-> ]]
}

fail_step() {
  print -r -- "  FAIL: $1"
  print -r -- ""
  print -r -- "Stopped at step $2 of $3. Fix it and run the walkthrough again."
  exit 1
}

run_step() {
  local id=$1 n=$2 total=$3
  local title_var="${id}_TITLE" kind_var="${id}_KIND" needs_var="${id}_NEEDS"
  local kind=${(P)kind_var:-action}
  local title=${(P)title_var:-$id}

  print -r -- ""
  print -r -- "Step $n of $total: $title"
  print -r -- ""
  "${id}_say"
  print -r -- ""

  if [[ $kind == apply ]]; then
    [[ $LAST_PLAN_OK == 1 ]] || fail_step "apply step needs a passed plan step before it" $n $total
    print -r -- "  Plan counts: add=$PLAN_ADD change=$PLAN_CHANGE destroy=$PLAN_DESTROY replace=$PLAN_REPLACE"
  fi

  pause
  check_needs $id $needs_var || fail_step "a required variable is not set (names above)" $n $total

  local out
  if out=$("${id}_check" 2>&1); then
    :
  else
    fail_step "check did not pass" $n $total
  fi

  if [[ $kind == plan ]]; then
    LAST_PLAN_OK=0
    parse_plan_line "$out" || fail_step "plan step printed no valid PLAN add=N change=N destroy=N replace=N line" $n $total
    print -r -- "  Plan counts: add=$PLAN_ADD change=$PLAN_CHANGE destroy=$PLAN_DESTROY replace=$PLAN_REPLACE"
    if (( PLAN_DESTROY > 0 || PLAN_REPLACE > 0 )); then
      fail_step "plan destroys or replaces resources; do not apply" $n $total
    fi
    LAST_PLAN_OK=1
  else
    LAST_PLAN_OK=0
  fi

  print -r -- "  PASS"
}

main() {
  (( $# == 1 )) || die_usage "usage: walkthrough.zsh <steps-file>"
  [[ -r $1 ]] || die_usage "cannot read steps file: $1"

  typeset -g LAST_PLAN_OK=0 PLAN_ADD=0 PLAN_CHANGE=0 PLAN_DESTROY=0 PLAN_REPLACE=0
  typeset -ga WALK_STEPS
  typeset -g WALK_TITLE=""
  source "$1"

  (( ${#WALK_STEPS} > 0 )) || die_usage "steps file defines no WALK_STEPS"
  local id
  for id in $WALK_STEPS; do
    (( $+functions[${id}_say] )) || die_usage "step $id has no ${id}_say function"
    (( $+functions[${id}_check] )) || die_usage "step $id has no ${id}_check function"
  done

  print -r -- "${WALK_TITLE:-Walkthrough} (${#WALK_STEPS} steps)"
  local n=0
  for id in $WALK_STEPS; do
    n=$(( n + 1 ))
    run_step $id $n ${#WALK_STEPS}
  done
  print -r -- ""
  print -r -- "All ${#WALK_STEPS} steps passed."
}

main "$@"
