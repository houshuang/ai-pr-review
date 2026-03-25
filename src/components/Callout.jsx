import { h } from "preact";
import { md, linkFileRefs } from "../utils";

export function Callout({ type, label, text }) {
  return (
    <div className={`callout ${type}`}>
      <span className="callout-label">{label}</span>
      <span dangerouslySetInnerHTML={{ __html: linkFileRefs(md(text)) }} />
    </div>
  );
}
