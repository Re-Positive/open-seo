#!/bin/bash
# Zet het grootboek en de rol van de kostenmeter op de portal-Supabase (seo-engine#16), en geeft de rol
# het wachtwoord uit Doppler. Idempotent. Draaien vanuit de root van de fork: bash aios/meter/grootboek-db.sh
#
# Twee Doppler-projecten, en het Doppler-token is per map gescoped: het wachtwoord staat in
# repositive-ai (03-repositive), de database-URL in resketch-ai (02-resketch).
set -euo pipefail
FORK="$(cd "$(dirname "$0")/../.." && pwd)"
REPOSITIVE="$(cd "$FORK/../.." && pwd)"
RESKETCH="$(cd "$REPOSITIVE/../02-resketch" && pwd)"
PSQL=/opt/homebrew/opt/libpq/bin/psql

WACHTWOORD=$(cd "$REPOSITIVE" && doppler secrets get SEO_METER_DB_WACHTWOORD --plain -p repositive-ai -c prd)
[[ "$WACHTWOORD" =~ ^[0-9a-f]{48}$ ]] || { echo "SEO_METER_DB_WACHTWOORD ontbreekt of heeft niet de vorm van de uitrol." >&2; exit 1; }

cd "$RESKETCH/OtherWorlds/ai-os-beheer"
doppler run -p resketch-ai -c prd --command "URL=\$(scripts/db-url.py \"\$CLIENT_PORTAL_DB_URL\") && $PSQL \"\$URL\" -X -q -v ON_ERROR_STOP=1 -f '$FORK/aios/meter/grootboek.sql'"
# Het wachtwoord via stdin, niet op de opdrachtregel.
printf "alter role seo_meter password '%s';\n" "$WACHTWOORD" |
  doppler run -p resketch-ai -c prd --command "URL=\$(scripts/db-url.py \"\$CLIENT_PORTAL_DB_URL\") && $PSQL \"\$URL\" -X -q -v ON_ERROR_STOP=1"
echo "Grootboek en rol seo_meter staan klaar."
