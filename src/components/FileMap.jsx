import { h } from "preact";
import { data } from "../state";

export function FileMap() {
  const d = data.value;
  if (!d?.walkthrough?.file_map?.length) return null;
  const fileMap = d.walkthrough.file_map;

  return (
    <section id="section-file-map">
      <span className="section-number">Appendix</span>
      <h2>File Map</h2>
      <div className="file-tree">
        {fileMap.map((f, i) => (
          <div key={i} className={`indent ${f.is_new ? "new-file" : "file"}`}>
            {f.path} &mdash; {f.description}
          </div>
        ))}
      </div>
    </section>
  );
}
