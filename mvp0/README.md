# New8bitPC Windows MVP 1-A / 1-B / 1-C / 1-D / 1-E

This isolated prototype keeps each entered page's source text unchanged and
derives line analysis and executable statements from committed pages. It
supports string-literal `PRINT`, argument-less `CLS` to clear only the program
output area, numeric-line `GOTO`, `REM` as a no-op, and `END` to stop execution.
`CLS` is logged as one execution step and does not clear the execution log, step
history, stop-policy state, or input controls. `CLS` with arguments is
uninterpreted and not executed. Numeric variables and expressions can be
assigned with `LET A=expression` or `A=expression`. Other commands are reported
as uninterpreted and skipped. It is not a full N88-BASIC emulator.
Compact forms such as `10PRINT"A"` and `10GOTO100` are accepted when the
command/argument boundary is clear. Ambiguous forms such as `10PRINTA` remain
uninterpreted. These are MVP input rules, not claims about N88-BASIC hardware.

The expression subset supports numeric literals, unary minus,
parentheses, `+`, `-`, `*`, `/`, and comparisons (`=`, `<>`, `<`, `<=`, `>`,
`>=`). The numeric function `INT(expression)` returns the greatest integer less
than or equal to its argument (equivalent to `Math.floor`), including within
larger expressions and `IF` conditions. Expression depth is limited to 64.
`RND(1)` returns a random value greater than or equal to `0` and less than `1`.
`RANDOMIZE expression` uses the expression rounded down to an integer as the
seed. `RANDOMIZE` without an argument uses a newly acquired seed for each run
and records that seed in the execution log, allowing the same sequence to be
replayed by passing the recorded seed to `RANDOMIZE`. Reproducing the original
N88-BASIC random sequence is not a goal.
Variable names start with an ASCII letter and are case-insensitive. Comparison
results use `-1` for true and `0` for false. Division by zero and references to
undefined variables stop that statement with a runtime error. Malformed
expressions are parse errors; expressions containing unknown functions remain
uninterpreted and are not partially executed. The supported IF forms are
`IF expression THEN line-number`, `IF expression THEN PRINT "string"`,
`IF expression THEN assignment`, `IF expression THEN CLS`, and
`IF expression THEN END`. A true inline PRINT, assignment, or CLS executes as
part of the IF statement's single step; CLS clears only the program output
area. A true inline END ends execution in that same single step. A false
condition skips the THEN statement and advances to the next row. `THEN CLS 0`,
`THEN END EXTRA`, `THEN GOTO`, `THEN REM`, colon-separated statements, `ELSE`,
and other THEN forms are not executable; unsupported forms remain
uninterpreted, while malformed conditions and extra END text keep the existing
error classification from `parseStatement`.
`FOR...NEXT`, `GOSUB...RETURN`, and `PRINT` expressions remain outside this MVP
subset.

MVP 1-D supports one numeric variable input in `INPUT A` or
`INPUT "prompt";A` form. It pauses the worker for a dedicated input dialog,
stores a validated decimal or negative integer/decimal value, then resumes at
the next command. Invalid text keeps the dialog open without changing variables.
Cancel stops execution without changing the variable. Exponential notation,
full-width symbols, string variables, multiple inputs, and file input remain
uninterpreted.

## Run

Install Node.js 20 or newer, then run these commands from this directory:

```powershell
node server.mjs
```

Open `http://127.0.0.1:4173` in a browser. The page starts with the accepted
two-line sample in the next-page editor. Press **区切り** to commit and analyze
that page. Enter another page and commit it to resolve references across page
boundaries. Press **完成** to commit any remaining input and turn unresolved
jump targets into errors. Typing or correcting source returns analysis to the
incomplete state.

## UI copy

The footer summarizes supported categories; detailed syntax and limitations
are described here. In particular, the THEN part of `IF` supports a line number,
a single `PRINT`, assignment, `CLS`, or `END`. Supported statements are not generated
from parser logic because the parser has no shared capability metadata.

The follow-up stage labels after MVP 1-E (`mvp1e-closed`) are 1-F (`df235b7`,
UI/operational consistency), 1-G (`5fe1483`, `IF ... THEN CLS`), and 1-H
(`a755650`, `IF ... THEN END`). This CLS stop-policy adjustment is 1-I.

The header's normal/attention/warning label describes analysis state. Rows that
are uninterpreted or erroneous are skipped during execution; those states do
not immediately mean a runtime error or that execution has stopped, though the
stop policy may ask for confirmation. The stop-confirmation dialog waits for a
continue-or-stop decision and is distinct from a runtime error.

The empty execution-log message means that there are no log entries displayed
for the current run; it is not a saved run history. Starting a new run clears
the log, while **表示を消去** does not change the cumulative step count. The
monitor remains blank when there is no program output so explanatory text is
not mixed into program output.

Committed source pages are shown separately and are not rewritten by analysis
or execution. Expand a committed page and choose **このRawを編集** to load it
into the editor. **このページを更新して再解析** replaces that same page,
then rebuilds analysis from Raw. The pending next-page text is preserved while
an earlier page is being edited. **訂正** on a parsed row remains available
for a single-line correction.

The correction history records timestamp, page, input-line position, and the
before/after line text and change source (`human` or `ai(承認つき)`); it is
kept separately from Raw. Initial input is not a correction-history entry.
Multi-line page edits match unchanged lines so insertions and deletions do not
incorrectly mark following unchanged lines as edited. Added or removed lines
have an empty before or after value.

The project is automatically saved in this browser's IndexedDB. Use **JSONを
書き出す** and **JSONを読み込む** for a portable UTF-8 project file. The JSON
includes `formatVersion` and stores Raw page strings, pending input, completion
state, and correction history; analysis results and display-only values such
as counts or border color are recomputed and are not saved. Import checks the
format version and asks before replacing the current project.

Browser storage is scoped to the page origin, including its port. The normal
server URL uses port `4173`; changing ports opens a separate browser storage
area. Export JSON before switching ports and import it at the new URL.
Undo/redo is not included.

The monitor displays program output. `CLS` clears only this output area. The
execution log is separate, retains each CLS step, and shows visited lines, step
numbers, and skipped-row reasons.

## Execution safeguards (temporary MVP settings)

Execution pauses when at least half of the last 20 counted steps were skipped,
after a minimum of 10 steps, or after 500 consecutive steps without `PRINT`
output or an INPUT wait. `CLS` clears the monitor but does not clear the
no-output counter; only `PRINT` output and an INPUT wait clear it. Reaching an
INPUT row counts once as a non-skipped step. Input completion continues that
same step; no automatic stop check runs while waiting. Unresolved references
are excluded until **完成**. Choosing **続ける** doubles the next check
interval, up to 160 steps for skipped rows and 4,000 steps without output. At
the cap, the prompt can be suppressed for that reason for the current run only.
**停止** remains available while the worker runs; during an INPUT wait, use
**停止** in the input dialog.

On **区切り**, a page with at least five rows and a majority of uninterpreted
rows, or a page where every row is uninterpreted, gets a non-blocking notice.
The profile mismatch is presented as a possibility, not a diagnosis. These
thresholds and rules are provisional and may change as supported statements
are added.

## Automated tests

```powershell
node --test
```

## Manual checks

1. Press **区切り** on the default sample, then run it. Confirm `HELLO` repeats
   and the step count rises. Press **停止**; confirm the count stops and the
   other controls respond.
2. Enter `30 FOO` as another page and press **区切り**. Confirm its page count
   reports one uninterpreted row and execution logs it as skipped.
3. Enter `10 GOTO 100` on a page and commit it. Confirm **参照待ち**; enter
   `100 PRINT "FOUND"` on another page and commit it to resolve the reference.
   For an unresolved target, press **完成** and confirm it becomes **誤り**.
4. Enter `20 GOTO 10` followed by `10 PRINT "HELLO"` in one page. Confirm the
   Raw order is unchanged and execution starts at BASIC line 10.
5. Enter two different statements with line number 10. Confirm both source
   positions are named in the analysis and each execution visit says
   **重複のため実行対象外**.
6. Confirm `10PRINT"A"` and `10GOTO100` are understood while `10PRINTA` is
   uninterpreted. Expand a committed page, edit its Raw, and update it. Confirm
   the page number stays the same, analysis refreshes, the pending next-page
   text remains, and changed lines appear in correction history.
7. Delimit a page with five or more mostly uninterpreted rows and confirm the
   profile caution appears without stopping input. Confirm a page with all rows
   uninterpreted also gets the notice, even when it has fewer than five rows.
8. Run `10 REM COMMENT` followed by `20 PRINT "HELLO"` and confirm the Raw
   comment is preserved, logged as a no-op step, and does not suppress `HELLO`.
   Run `10 PRINT "BEFORE"`, `20 END`, and `30 PRINT "AFTER"` and confirm only
   `BEFORE` is output and execution finishes at `END`.
9. Run `LET A=-5`, `B=(A*-2)+(10-3)`, and `C=B>=10` and confirm the variable
   values are `-5`, `17`, and `-1`. Confirm `LET D=B/0` and `LET E=UNKNOWN+1`
   are reported as runtime errors and do not change the variable table.
10. Verify IF jumps to a line number, then test `IF A=1 THEN PRINT "OK"`,
    `IF A=1 THEN A=A+1`, `IF A=1 THEN CLS`, and `IF A=1 THEN END`: a true
    condition runs the inline PRINT, assignment, or CLS within the IF's single
    step, or ends execution for END; a false
    condition skips it and advances to the next row. Confirm `THEN CLS 0`,
    `THEN END EXTRA`, `THEN GOTO`, `THEN REM`, colon-separated statements, `ELSE`, and
    unknown THEN forms leave the whole IF row uninterpreted and non-executable.
    Malformed supported statements retain the parser's existing
    error/uninterpreted classification. Unresolved line targets wait before
    completion and become errors after completion.
11. Run string-variable, multiple-input, multiple-prompt, file-input, and
    `LINE INPUT` samples. Confirm that all unsupported forms remain uninterpreted,
    are logged with reasons, and do not execute or infer values.
12. Run `PRINT "BEFORE"`, `CLS`, `PRINT "AFTER"`, and `END`. Confirm the monitor
    shows only `AFTER`, while the execution log retains all commands and step
    numbers. Confirm `CLS 0` remains uninterpreted and is not executed.

## MVP 1-B browser acceptance record

- Date: 2026-11-20
- Commit: `2fda42d`
- Automated tests: 32 passed
- Browser status: confirmed OK

Confirmed cases:

1. `10 LET A=1`, `20 LET A=A+1`, `30 GOTO 20` stopped normally at the cumulative
   500-step safeguard and reported the latest assignment `A = 251`.
2. Unary minus, parentheses, arithmetic, fraction division, comparisons, mixed
   case variable names, existing `PRINT`, and `END` produced `A=-5`, `B=-10`,
   `C=0.5`, `D=-1`, `E=0`, output `OK`, and cumulative 7 steps for normal exit.
3. `10 LET X=Y+1` was parsed as understood and stopped at step 1 with
   `変数Yは未定義です。`.

4. `10 LET A=1/0` stopped at step 1 with a division-by-zero runtime error.
5. `10   a = ( 1 + 2 )` preserved its exact Raw text. Full-width `＋`, string
   variables, colon-separated statements, empty expressions, and unmatched
   parentheses were not inferred or executed but were reported as errors or
   uninterpreted rows with reasons.
6. After assigning `A=10`, rerunning the program initialized variables anew;
   references to `A` then stopped with `変数Aは未定義です。`.

- Implementation commit: `2fda42d`
- Documentation commit: `c6c6195`

## MVP 1-C implementation record

- Implementation commit: `acd68d8`
- Unresolved-target fix: `869f3df`
- Fix documentation: `69f4300`
- Automated tests: 37 passed
- Browser manual confirmation: confirmed OK
- Implemented scope: `IF expression THEN line-number`, true jumps, false continues,
  unresolved targets follow GOTO reference handling, and runtime errors stop
  execution. Unsupported THEN forms remain uninterpreted.

### MVP 1-C browser acceptance record

- Date: 2026-11-20
- Automated tests: 37 passed
- Browser manual confirmation: confirmed OK

Confirmed cases:

1. True IF jumped to line 100 and ended normally at cumulative step 4. PRINT,
   END, Raw preservation, and execution logs showed no regressions.
2. False IF continued to the next row, output `NEXT`, and ended normally at
   cumulative step 4. The log recorded assignment, false IF evaluation, PRINT,
   and END.
3. An unresolved target remained `参照待ち` before completion and was skipped
   without speculative jump or true/false evaluation in the execution log.
4. With line 100 defined, an undefined variable stopped at step 1 with
   `変数Yは未定義です。` and did not reach line 100.
5. With line 100 defined, division by zero stopped at step 1 with
   `0で除算することはできません。` and did not execute lines 20 or 100.
6. Unsupported IF forms were not inferred, and PRINT, END, GOTO, and the existing
   stop policy showed no regressions.

### MVP 1-C unresolved-target correction

Before completion, an unresolved IF target is executed as a skipped
`参照待ち` row. It does not evaluate or print a false/true jump result and does
not move to the THEN line by speculation. After completion, the IF row becomes
an error because the target line does not exist.

## MVP 1-D implementation record

- Automated tests: 43 passed
- Browser manual confirmation: confirmed OK
- Scope: `INPUT A`, `INPUT "prompt";A`, numeric validation, dedicated input
  dialog, cancel, and variable initialization on rerun
- Excluded: string variables, multiple inputs, multiple prompts, file input,
  `LINE INPUT`, exponent notation, and full-width symbols

### MVP 1-D browser acceptance record

- Date: 2026-11-20
- Automated tests: 43 passed
- Browser manual confirmation: confirmed OK

1. Accepted integer `42`, negative value `-7`, and decimal `3.14`. The prompted
   input displayed `予想` and its target variable; all four inputs reached END.
2. Rejected `abc` while keeping the dialog open with a validation message, then
   accepted `7` on retry and finished normally.
3. Cancelled while waiting for input; execution stopped at step 1 with no input
   completion event or variable update.
4. The first run set `A=99`. On rerun, a branch skipped that assignment and
   referencing `A` produced the expected undefined-variable runtime error,
   confirming that variables are initialized for each run.

### MVP 1-D unsupported INPUT browser confirmation

- Date: 2026-11-20

The following five rows were not inferred or executed:

```basic
10 INPUT A$
20 INPUT A,B
30 INPUT "A";A,"B";B
40 INPUT #1,A
50 LINE INPUT A
```

Each row was reported as uninterpreted with a reason. The log reached cumulative
step 5, produced no program output, and ended normally.

### MVP 1-D additional browser acceptance

- Date: 2026-11-20
- Automated tests: 43 passed
- Browser manual confirmation: confirmed OK

1. Waiting at `10 INPUT A` for more than five seconds did not trigger the
   no-change stop. An INPUT/GOTO loop also remained waiting after five inputs.
   The comparison assignment/GOTO loop reached the stop decision at cumulative
   step 500.
2. Pressing **停止** in the input dialog closed it and stopped at step 1. The
   Run button became available again; rerunning showed exactly one pending
   input dialog, with no stale wait request.
3. Ran `10 INPUT A`, `20 INPUT B`, `30 INPUT C`, `40 LET D=A*B+C`, and
   `50 END`, twice with inputs `5`, `7`, `bad`, `9`. Invalid text kept the
   dialog open with a numeric validation error. Both runs produced the same
   input-completion, assignment, and end log, with `D=44` and normal completion
   at cumulative step 5.
4. Removed “temporary” from the correction-history label to match its persisted
   storage behavior.

## MVP 1-E implementation and browser acceptance record

- Date: 2026-11-22
- Scope: argument-less `CLS` clears only the program output area; execution logs
  and step history remain. CLS forms with arguments are uninterpreted.
- Number-guessing game: with `RANDOMIZE 2468`, `A=INT(RND(1)*100)+1` generated
  the target 16. Inputs `50`, `25`, `12`, `18`, and `16` exercised comparisons,
  CLS screen updates, GOTO input loops, IF target branching, and END.
- Browser confirmation: completed with monitor output `CORRECT` at 32 steps.
  The 37-entry execution log retained all five CLS events while the output area
  contained only the final message.
- Automated tests: 63 passed
