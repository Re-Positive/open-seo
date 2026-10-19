#!/bin/bash
# Zet het zoekdatabudget per maand van een klant (seo-engine#17) in het project AI OS. Draaien vanuit de root van de fork:
#   bash aios/meter/budget.sh <client_id> <bedrag in dollar>     bv. bash aios/meter/budget.sh 86c7h8f96 20
# Zonder budget gaat er voor die klant geen betaalde zoekactie door. De klant moet in platform.klanten staan.
set -euo pipefail
[[ "${1:-}" =~ ^[A-Za-z0-9_]+$ && "${2:-}" =~ ^[0-9]+(\.[0-9]{1,2})?$ ]] || { echo "Gebruik: budget.sh <client_id> <bedrag>" >&2; exit 2; }
FORK="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$FORK/../../../02-resketch"
doppler run -p resketch-ai -c prd --only-secrets AI_OS_PLATFORM_DB_URL --command "/opt/homebrew/opt/libpq/bin/psql \"\$AI_OS_PLATFORM_DB_URL\" -X -q -At -v ON_ERROR_STOP=1 -c \"insert into seo.budget (client_id, maandbedrag) values ('$1', $2) on conflict (client_id) do update set maandbedrag = excluded.maandbedrag, gewijzigd_op = now() returning client_id || ': ' || maandbedrag\""
