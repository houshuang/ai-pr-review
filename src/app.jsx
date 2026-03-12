import { render } from "preact";
import "diff2html/bundles/css/diff2html.min.css";
import "./styles.css";
import { App } from "./components/App";

render(<App />, document.getElementById("app"));
