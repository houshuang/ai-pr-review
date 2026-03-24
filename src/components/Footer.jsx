import { h } from "preact";
import { data } from "../state";
import  from "../utils";

export function Footer() {
  const d = data.value;
  if (!d) return null;
  const meta = d.meta;

  return (
    <footer className="page-footer">
      <p>Generated {meta.generatedAt ? new Date(meta.generatedAt).toLocaleString() : "just now"}</p>
      {meta.url && (
        <p><a href={meta.url} target="_blank">View on GitHub &#x2197;</a></p>
      )}
    </footer>
  );
}
