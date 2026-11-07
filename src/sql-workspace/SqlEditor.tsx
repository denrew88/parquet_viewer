import { useEffect, useImperativeHandle, useRef, type RefObject } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, placeholder, showTooltip } from "@codemirror/view";
import {
  autocompletion,
  acceptCompletion,
  closeCompletion,
  completionKeymap,
  completionStatus,
  startCompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  insertNewlineKeepIndent,
  isolateHistory,
} from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { SQLDialect } from "@codemirror/lang-sql";
import { search, searchKeymap } from "@codemirror/search";
import {
  sqlCompletions,
  sqlCompletionContext,
  sqlFunctionHint,
  sqlStatementAtCursor,
} from "./completionModel";
import type { SqlTable } from "./model";
import type { SqlCompletionMode } from "../settings/model";

export interface SqlEditorHandle {
  focus(): void;
  insertText(text: string): void;
}
interface Props {
  value: string;
  tables: readonly SqlTable[];
  completionMode?: SqlCompletionMode;
  onChange(value: string): void;
  onRun(statement: string, draft: string): void;
  editorRef: RefObject<SqlEditorHandle | null>;
}
const dialect = SQLDialect.define({
  keywords:
    "select from where group by having order limit offset join left right inner outer full cross on as distinct union all intersect except with recursive case when then else end and or not null is in between like ilike asc desc nulls first last over partition rows range filter qualify",
  types: "bigint integer smallint double float decimal varchar boolean date timestamp interval",
  identifierQuotes: '"',
});
export function SqlEditor({
  value,
  tables,
  completionMode = "contextual",
  onChange,
  onRun,
  editorRef,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({ value, tables, completionMode, onChange, onRun });
  latest.current = { value, tables, completionMode, onChange, onRun };
  const suppressedFrom = useRef<number | null>(null);
  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => viewRef.current?.focus(),
      insertText: (text) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch(view.state.replaceSelection(text), {
          scrollIntoView: true,
          userEvent: "input",
          annotations: isolateHistory.of("full"),
        });
        view.focus();
      },
    }),
    [],
  );
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          lineNumbers(),
          history(),
          search(),
          dialect.extension,
          syntaxHighlighting(defaultHighlightStyle),
          bracketMatching(),
          closeBrackets(),
          placeholder("Write a SELECT query, or insert an example →"),
          EditorView.contentAttributes.of({
            "aria-label": "SQL editor",
            "aria-multiline": "true",
            role: "textbox",
            spellcheck: "false",
          }),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (event) => {
                if (
                  event.isComposing &&
                  (event.key === "Enter" || event.key === "Tab" || event.code === "Space")
                )
                  return true;
                return false;
              },
              compositionstart: (_event, editor) => {
                closeCompletion(editor);
                return false;
              },
            }),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
          autocompletion({
            override: [
              (context) => {
                if (context.view?.composing) return null;
                const doc = context.state.doc.toString();
                const scope = sqlCompletionContext(doc, context.pos, latest.current.tables);
                if (context.explicit) {
                  suppressedFrom.current = null;
                } else {
                  if (suppressedFrom.current !== null) {
                    if (scope.tokenFrom === suppressedFrom.current) return null;
                    suppressedFrom.current = null;
                  }
                  const contextual =
                    scope.kind === "dot" ||
                    scope.kind === "join" ||
                    scope.kind === "table" ||
                    scope.kind === "having";
                  if (
                    latest.current.completionMode === "manual" ||
                    (!contextual &&
                      (latest.current.completionMode !== "automatic" ||
                        scope.prefixLength < 2 ||
                        scope.kind !== "expression"))
                  )
                    return null;
                }
                const result = sqlCompletions(doc, context.pos, latest.current.tables);
                const options = result?.options.filter(
                  (option) => context.explicit || !option.manualOnly,
                );
                return result && options?.length
                  ? {
                      ...result,
                      filter: false,
                      options: options.map(({ insertText, infoDetails, ...option }) => ({
                        ...option,
                        info: infoDetails
                          ? () => {
                              const document = context.view?.dom.ownerDocument ?? window.document;
                              const content = document.createElement("div");
                              content.className = "sql-completion-info";
                              const note = content.appendChild(document.createElement("p"));
                              note.textContent = option.info ?? "";
                              const details = content.appendChild(
                                document.createElement("details"),
                              );
                              const summary = details.appendChild(
                                document.createElement("summary"),
                              );
                              summary.textContent = "Why this JOIN?";
                              const explanation = details.appendChild(document.createElement("p"));
                              explanation.textContent = infoDetails;
                              return content;
                            }
                          : option.info,
                        apply: insertText,
                      })),
                    }
                  : null;
              },
            ],
            defaultKeymap: false,
            activateOnTyping: true,
            activateOnTypingDelay: 80,
            interactionDelay: 0,
            maxRenderedOptions: 40,
          }),
          showTooltip.compute(["doc", "selection"], (state) => {
            if (!state.selection.main.empty) return null;
            const hint = sqlFunctionHint(state.doc.toString(), state.selection.main.head);
            return hint
              ? {
                  pos: hint.from,
                  end: hint.to,
                  above: true,
                  create: () => {
                    const dom = document.createElement("div");
                    dom.className = "sql-function-hint";
                    dom.setAttribute("role", "tooltip");
                    dom.setAttribute("aria-label", "SQL function signature");
                    const signature = document.createElement("strong");
                    signature.textContent = hint.signature;
                    const description = document.createElement("div");
                    description.textContent = `Argument ${hint.argumentIndex} · ${hint.description}`;
                    dom.append(signature, description);
                    return { dom };
                  },
                }
              : null;
          }),
          Prec.highest(
            keymap.of([
              {
                key: "Ctrl-Enter",
                mac: "Cmd-Enter",
                run: (editor) => {
                  if (!editor.composing) {
                    const draft = editor.state.doc.toString();
                    const statement = sqlStatementAtCursor(draft, editor.state.selection.main.head);
                    if (statement !== null) latest.current.onRun(statement, draft);
                  }
                  return true;
                },
                preventDefault: true,
                stopPropagation: true,
              },
              {
                key: "Ctrl-Space",
                run: (editor) => {
                  if (editor.composing) return false;
                  suppressedFrom.current = null;
                  return startCompletion(editor);
                },
              },
              {
                key: "Enter",
                run: (editor) => {
                  if (editor.composing) return false;
                  if (completionStatus(editor.state) === "active" && acceptCompletion(editor))
                    return true;
                  return insertNewlineKeepIndent(editor);
                },
              },
              {
                key: "Shift-Enter",
                run: (editor) => {
                  if (editor.composing) return false;
                  closeCompletion(editor);
                  return insertNewlineKeepIndent(editor);
                },
              },
              {
                key: "Escape",
                run: (editor) => {
                  if (editor.composing || completionStatus(editor.state) === null) return false;
                  const scope = sqlCompletionContext(
                    editor.state.doc.toString(),
                    editor.state.selection.main.head,
                    latest.current.tables,
                  );
                  suppressedFrom.current = scope.tokenFrom;
                  return closeCompletion(editor);
                },
              },
              {
                key: "Tab",
                run: (editor) =>
                  editor.composing
                    ? false
                    : completionStatus(editor.state) === "active"
                      ? acceptCompletion(editor)
                      : indentWithTab.run!(editor),
              },
              ...completionKeymap
                .filter(
                  (binding) =>
                    !["Ctrl-Space", "Enter", "Tab", "Escape"].includes(binding.key ?? ""),
                )
                .map((binding) => ({
                  ...binding,
                  run: binding.run
                    ? (editor: EditorView) => !editor.composing && binding.run!(editor)
                    : undefined,
                })),
            ]),
          ),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);
  useEffect(() => {
    const view = viewRef.current;
    if (view && value !== view.state.doc.toString()) {
      const anchor = Math.min(view.state.selection.main.anchor, value.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor },
        userEvent: "input",
        annotations: isolateHistory.of("full"),
      });
    }
  }, [value]);
  useEffect(() => {
    suppressedFrom.current = null;
    if (viewRef.current) closeCompletion(viewRef.current);
  }, [tables, completionMode]);
  return <div className="sql-code-editor" ref={host} />;
}
