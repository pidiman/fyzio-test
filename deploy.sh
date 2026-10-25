#!/bin/sh
# Nasadenie na serveri: stiahne posledný commit, prebuduje a reštartuje kontajner.
# Spúšťa ho GitHub Actions cez SSH (.github/workflows/deploy.yml), dá sa spustiť aj ručne.
set -eu
cd "$(dirname "$0")"

git fetch --quiet origin main
git reset --hard origin/main
docker compose build web
# migrácia v jednorazovom kontajneri z nového image (podľa depends_on najprv naštartuje db);
# ak zlyhá, skript skončí a ďalej beží stará verzia
docker compose run --rm web node migrate.js
docker compose up -d --remove-orphans
docker image prune -f >/dev/null

# počkať, kým web odpovedá
for i in $(seq 1 30); do
  if curl -fs -o /dev/null http://127.0.0.1:8092/api/info; then
    echo "Nasadené: $(git log -1 --format='%h %s')"
    exit 0
  fi
  sleep 2
done
echo "Web po nasadení neodpovedá" >&2
docker compose logs --tail=50 web >&2
exit 1
