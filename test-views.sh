#!/bin/bash
# Screenshot all views in light and dark mode for visual comparison
# Usage: ./test-views.sh [port]
PORT=${1:-5200}
URL="http://localhost:$PORT/?pr=facebook-react-35893"
OUT="/tmp/review-views"
mkdir -p "$OUT"

VIEWS=("editorial" "sidebar" "focus" "split" "developer" "dashboard")
MODES=("light" "dark")

# Wait for page to fully render
agent-browser open "$URL" && agent-browser wait --load networkidle && agent-browser wait 2000

for mode in "${MODES[@]}"; do
  if [ "$mode" = "dark" ]; then
    agent-browser eval "document.documentElement.classList.add('dark')"
  else
    agent-browser eval "document.documentElement.classList.remove('dark')"
  fi

  for view in "${VIEWS[@]}"; do
    echo "📸 ${mode}/${view}..."
    agent-browser eval "document.documentElement.className = document.documentElement.className.replace(/\bview-\w+\b/g, '').trim(); document.documentElement.classList.add('view-${view}')"
    # Switch the actual Preact state too
    agent-browser eval "window.__setView && window.__setView('${view}')"
    agent-browser wait 500

    # Screenshot top (header/overview area)
    agent-browser eval "window.scrollTo(0, 0)"
    agent-browser wait 300
    agent-browser screenshot "${OUT}/${mode}-${view}-top.png"

    # Screenshot diff area (scroll to first diff)
    agent-browser eval "const d = document.querySelector('.hunk-group, .hunk-diff, .d2h-wrapper'); if(d) d.scrollIntoView({block:'start'})"
    agent-browser wait 300
    agent-browser screenshot "${OUT}/${mode}-${view}-diff.png"
  done
done

echo ""
echo "✅ Screenshots saved to ${OUT}/"
echo "Files:"
ls -la "${OUT}/"
