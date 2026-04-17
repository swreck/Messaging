#!/bin/sh
# Retry prisma migrate deploy up to 5 times with 3-second delays.
# Neon's free tier sometimes rejects connections during cold-start.
MAX_RETRIES=5
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
  npx prisma migrate deploy && break
  RETRY=$((RETRY + 1))
  echo "[start.sh] prisma migrate deploy failed (attempt $RETRY/$MAX_RETRIES). Retrying in 3s..."
  sleep 3
done

if [ $RETRY -eq $MAX_RETRIES ]; then
  echo "[start.sh] WARNING: prisma migrate deploy failed after $MAX_RETRIES attempts. Starting server anyway."
fi

exec node dist/index.js
