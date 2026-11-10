import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export interface EditorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  disabled?: boolean;
}
const colors = HighlightStyle.define([
  { tag: tags.heading, color: "#075d79", fontWeight: "700" },
  { tag: tags.strong, color: "#74358a", fontWeight: "700" },
  { tag: tags.emphasis, color: "#74358a", fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: "#176c4c", textDecoration: "underline" },
  { tag: [tags.monospace, tags.processingInstruction], color: "#9a3a14" },
  { tag: [tags.meta, tags.punctuation], color: "#68718a" },
  { tag: tags.quote, color: "#59637d", fontStyle: "italic" },
]);
export default function MarkdownEditor(props: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const editable = useRef(new Compartment());
  useEffect(() => {
    const initial = latest.current;
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial.value,
        extensions: [
          markdown(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          syntaxHighlighting(colors),
          EditorView.lineWrapping,
          // Preserve existing line endings when the user edits a stored document.
          EditorState.lineSeparator.of(
            initial.value.includes("\r\n") ? "\r\n" : "\n",
          ),
          EditorView.contentAttributes.of({
            "aria-label": initial.label,
            "aria-multiline": "true",
            role: "textbox",
            spellcheck: "true",
          }),
          editable.current.of(EditorState.readOnly.of(!!initial.disabled)),
          EditorState.transactionFilter.of((tr) =>
            tr.newDoc.length > latest.current.maxLength && tr.docChanged
              ? []
              : tr,
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              latest.current.onChange(update.state.sliceDoc());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      view.current = undefined;
      editor.destroy();
    };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.sliceDoc() !== props.value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: props.value },
      });
  }, [props.value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(
        EditorState.readOnly.of(!!props.disabled),
      ),
    });
  }, [props.disabled]);
  return <div className="markdown-editor" ref={host} />;
}
