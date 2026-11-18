# New8bitPC Windows MVP 1-A

This isolated prototype keeps each entered page's source text unchanged and
derives line analysis and executable statements from committed pages. It
supports string-literal `PRINT` and numeric-line `GOTO`; other commands are
reported as uninterpreted and skipped. It is not a full N88-BASIC emulator.
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
before/after line text in memory only; it is not part of Raw and is lost when
the page reloads. Multi-line page edits match unchanged lines so insertions
and deletions do not incorrectly mark following unchanged lines as edited.
Added or removed lines have an empty before or after value. Undo/redo and
persistent storage are not included.

The monitor displays only program output from `PRINT`. The execution log is
separate and shows visited lines, step numbers, and skipped-row reasons.

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
