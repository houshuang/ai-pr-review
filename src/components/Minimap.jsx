import { h } from "preact";
import { useCallback } from "preact/hooks";
import { data, reviewState } from "../state";

export function Minimap() {
  const d = data.value;
  if (!d?.walkthrough?.sections?.length) return null;
  const rs = reviewState.value;
  const sections = d.walkthrough.sections;

  const handleClick = useCallback((e, id) => {
    e.preventDefault();
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return (
    <div className="minimap">
      {sections.map((s) => {
        const reviewed = rs[s.id]?.reviewed;
        return (
          <a
            key={s.id}
            href={`#section-${s.id}`}
            className={`minimap-item ${reviewed ? "reviewed" : ""}`}
            title={s.title}
            onClick={(e) => handleClick(e, `section-${s.id}`)}
          />
        );
      })}
    </div>
  );
}
