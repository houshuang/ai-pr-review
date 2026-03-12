import { h } from "preact";
import { md } from "../utils";

export function Callout({ type, label, text }) {
  return (
    <div className={`callout ${type}`}>
      <span className="callout-label">{label}</span>
      <span dangerouslySetInnerHTML={{ __html: md(text) }} />
    </div>
  );
}
