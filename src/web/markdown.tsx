import { lazy, Suspense, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { EditorProps } from "./markdown-editor.js";
const Editor = lazy(() => import("./markdown-editor.js"));
export function Content({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml>
        {children}
      </Markdown>
    </div>
  );
}
export function MarkdownField(props: EditorProps) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="markdown-field">
      <div className="editor-toolbar">
        <span>{props.label} · Markdown</span>
        <button
          type="button"
          className="quiet"
          aria-label={`${preview ? "Edit" : "Preview"} ${props.label.toLowerCase()}`}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "Edit source" : "Preview"}
        </button>
      </div>
      {preview ? (
        <Content>{props.value || "*Nothing to preview yet.*"}</Content>
      ) : (
        <Suspense fallback={<p>Loading editor…</p>}>
          <Editor {...props} />
        </Suspense>
      )}
      <small className="muted">
        {props.value.length.toLocaleString()} /{" "}
        {props.maxLength.toLocaleString()} characters
      </small>
    </div>
  );
}
