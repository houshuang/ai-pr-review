import { h } from "preact";
import { data, parsedFiles, reviewState, getProgress, getFileCoverage } from "../../state";
import { esc, groupFilesByDirectory, getFileStats } from "../../utils";
import { getActionItems } from "../../keyboard";
import { ActionPanel } from "../ActionPanel";
import { ProgressBar } from "../ProgressBar";
import { CoverageBar } from "../CoverageBar";
import { ReviewsSummary } from "../ReviewsSummary";
import { TOC } from "../TOC";
import { Overview } from "../Overview";
import { Section } from "../Section";
import { RemainingChanges } from "../RemainingChanges";
import { OrphanedComments } from "../OrphanedComments";
import { FileMap } from "../FileMap";
import { Footer } from "../Footer";
import { BottomBar } from "../BottomBar";
import { ReviewModal } from "../ReviewModal";

function SidebarFileTree({ coverage }) {
  if (!coverage) return null;
  const pf = parsedFiles.value;
  const rs = reviewState.value;
  const allFiles = [...(coverage.covered || []), ...(coverage.uncovered || [])].sort();
  const groups = groupFilesByDirectory(allFiles);

  return (
    <div class="sidebar-files">
      <div class="sidebar-section-title">Files</div>
      {groups.map(([dir, files]) => (
        <div key={dir}>
          <div class="sidebar-dir">{esc(dir || "(root)")}/</div>
          {files.map((f) => {
            const isCovered = coverage.covered?.includes(f);
            const isReviewed = rs[`file:${f}`]?.reviewed;
            const dotClass = isReviewed ? "reviewed" : isCovered ? "covered" : "uncovered";
            const name = f.split("/").pop();
            const file = pf[f];
            const stats = file ? getFileStats(file) : null;
            return (
              <div key={f} class="sidebar-file">
                <span class={`sidebar-dot ${dotClass}`}></span>
                <span class="sidebar-fname">{esc(name)}</span>
                {stats ? <span class="sidebar-fstats">+{stats.additions} -{stats.deletions}</span> : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function SidebarLayout({ callbacks }) {
  const d = data.value;
  const wt = d.walkthrough;
  const meta = d.meta;
  const progress = getProgress();
  const coverage = getFileCoverage(wt);
  const items = getActionItems(callbacks);
  const sections = wt.sections || [];

  return (
    <div>
      <ActionPanel items={items} />
      <div class="layout-sidebar">
        <aside class="sidebar-panel">
          <div class="sidebar-header-block">
            <div class="kicker">Review</div>
            <h3 style="font-family:var(--display);font-weight:400;font-size:1rem;margin:0.25rem 0">{esc(wt.title)}</h3>
            <div class="meta" style="margin-top:0.5rem">{meta.headBranch} &rarr; {meta.baseBranch}</div>
          </div>
          <ProgressBar progress={progress} />
          <TOC />
          <SidebarFileTree coverage={coverage} />
        </aside>
        <div class="sidebar-main">
          <div class="page-container" style="max-width:none">
            <CoverageBar coverage={coverage} />
            <ReviewsSummary />
            <Overview />
            {sections.map((section, index) => (
              <Section key={section.id} section={section} index={index} />
            ))}
            <RemainingChanges coverage={coverage} />
            <OrphanedComments coverage={coverage} />
            <FileMap />
            <Footer />
          </div>
        </div>
      </div>
      <BottomBar />
      <ReviewModal />
    </div>
  );
}
