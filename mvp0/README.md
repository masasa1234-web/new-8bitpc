# New8bitPC Windows MVP 1-A

This isolated prototype keeps each entered page's source text unchanged and
derives line analysis and executable statements from committed pages. It
supports string-literal `PRINT`, numeric-line `GOTO`, `REM` as a no-op, and
`END` to stop execution. Other commands are reported as uninterpreted and
skipped. It is not a full N88-BASIC emulator.
Compact forms such as `10PRINT"A"` and `10GOTO100` are accepted when the
command/argument boundary is clear. Ambiguous forms such as `10PRINTA` remain
uninterpreted. These are MVP input rules, not claims about N88-BASIC hardware.

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

The monitor displays only program output from `PRINT`. The execution log is
separate and shows visited lines, step numbers, and skipped-row reasons.

## Execution safeguards (temporary MVP settings)

Execution pauses when at least half of the last 20 counted steps were skipped,
after a minimum of 10 steps, or after 500 consecutive steps without `PRINT`
output. Unresolved references are excluded until **完成**. Choosing **続ける**
doubles the next check interval, up to 160 steps for skipped rows and 4,000
steps without output. At the cap, the prompt can be suppressed for that reason
for the current run only. **停止** remains available while the worker runs.

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
   text remains, and changed lines appear in temporary correction history.
7. Delimit a page with five or more mostly uninterpreted rows and confirm the
   profile caution appears without stopping input. Confirm a page with all rows
   uninterpreted also gets the notice, even when it has fewer than five rows.
8. Run `10 REM COMMENT` followed by `20 PRINT "HELLO"` and confirm the Raw
   comment is preserved, logged as a no-op step, and does not suppress `HELLO`.
   Run `10 PRINT "BEFORE"`, `20 END`, and `30 PRINT "AFTER"` and confirm only
   `BEFORE` is output and execution finishes at `END`.
