import { h } from "preact";
import { data, getProgress, getFileCoverage } from "../../state";
import { getActionItems } from "../../keyboard";
import { ActionPanel } from "../ActionPanel";
import { Header } from "../Header";
import { ProgressBar } from "../ProgressBar";
import { CoverageBar } from "../CoverageBar";
import { ReviewsSummary } from "../ReviewsSummary";
import { CommitTimeline } from "../CommitTimeline";
import { TOC } from "../TOC";
import { Overview } from "../Overview";
import { Section } from "../Section";
import { RemainingChanges } from "../RemainingChanges";
import { OrphanedComments } from "../OrphanedComments";
import { ReviewCompleteBanner } from "../ReviewCompleteBanner";
import { FileMap } from "../FileMap";
import { Footer } from "../Footer";
import { Minimap } from "../Minimap";
import { BottomBar } from "../BottomBar";
import { ReviewModal } from "../ReviewModal";

export function EditorialLayout({ callbacks }) {
  const d = data.value;
  const wt = d.walkthrough;
  const progress = getProgress();
  const coverage = getFileCoverage(wt);
  const items = getActionItems(callbacks);
  const sections = wt.sections || [];

  return (
    <div>
      <ActionPanel items={items} />
      <div class="page-container">
        <Header />
        <ProgressBar progress={progress} />
        <CoverageBar coverage={coverage} />
        <ReviewsSummary />
        <CommitTimeline />
        <TOC />
        <Overview />
        {sections.map((section, index) => (
          <Section key={section.id} section={section} index={index} />
        ))}
        <RemainingChanges coverage={coverage} />
        <OrphanedComments coverage={coverage} />
        <ReviewCompleteBanner />
        <FileMap />
        <Footer />
      </div>
      <Minimap />
      <BottomBar />
      <ReviewModal />
    </div>
  );
}
