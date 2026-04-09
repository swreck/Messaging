#!/bin/bash
# ─── Start Maria Locally ─────────────────────────────
# Double-click this file to start Maria on your Mac.
# Access from iPad/iPhone using the Network URL printed below.
# Close this window (or press Ctrl+C) to stop everything.
# ──────────────────────────────────────────────────────

cd "$(dirname "$0")"

echo ""
echo "  Starting Maria locally..."
echo ""

# Start backend on port 3002 (3001 may be used by other projects)
(cd backend && PORT=3002 npx tsx src/index.ts 2>&1) &
BACKEND_PID=$!

# Give backend a moment to start
sleep 3

# Start frontend on port 5174 (avoid conflicts with other projects)
(cd frontend && npx vite --host --port 5174 2>&1) &
FRONTEND_PID=$!

# Give frontend a moment to print its URLs
sleep 3

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │  Maria is running locally.                       │"
echo "  │                                                  │"
echo "  │  Use the Local and Network URLs shown above.     │"
echo "  │  (Vite may pick a different port if 5173 is busy)│"
echo "  │                                                  │"
echo "  │  Close this window to stop everything.           │"
echo "  └─────────────────────────────────────────────────┘"
echo ""

# Clean up both processes when this window closes
cleanup() {
  echo ""
  echo "  Stopping Maria..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
  wait $BACKEND_PID $FRONTEND_PID 2>/dev/null
  echo "  Done."
  exit 0
}

trap cleanup INT TERM EXIT

# Keep the window open
wait
