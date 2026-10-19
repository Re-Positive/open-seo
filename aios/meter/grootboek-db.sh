#!/bin/bash
# Geeft de rol seo_meter van de kostenmeter (seo-engine#16) in het project AI OS het wachtwoord uit Doppler.
# Het grootboek (platform.usage_events), het budget en de rol zelf staan in de migraties van
# Re-Positive/seo-engine (db/platform, db/seo); dit script zet die eerst, zodat alles klaarstaat.
# Idempotent. Draaien vanuit de root van de fork: bash aios/meter/grootboek-db.sh
#
# Twee Doppler-projecten, en het Doppler-token is per map gescoped: het wachtwoord staat in
# repositive-ai (03-repositive), de database-URL in resketch-ai (02-resketch).
set -euo pipefail
FORK="$(cd "$(dirname "$0")/../.." && pwd)"
REPOSITIVE="$(cd "$FORK/../.." && pwd)"
RESKETCH="$(cd "$REPOSITIVE/../02-resketch" && pwd)"
SEO_ENGINE="$REPOSITIVE/OtherWorlds/seo-engine"
PSQL=/opt/homebrew/opt/libpq/bin/psql

WACHTWOORD=$(cd "$REPOSITIVE" && doppler secrets get SEO_METER_DB_WACHTWOORD --plain -p repositive-ai -c prd)
[[ "$WACHTWOORD" =~ ^[0-9a-f]{48}$ ]] || { echo "SEO_METER_DB_WACHTWOORD ontbreekt of heeft niet de vorm van de uitrol." >&2; exit 1; }

cd "$RESKETCH"
doppler run -p resketch-ai -c prd --only-secrets AI_OS_PLATFORM_DB_URL --command "DB_URL=\"\$AI_OS_PLATFORM_DB_URL\" '$SEO_ENGINE/db/migreer.py' platform seo"
# Het wachtwoord via stdin, niet op de opdrachtregel.
printf "alter role seo_meter password '%s';\n" "$WACHTWOORD" |
  doppler run -p resketch-ai -c prd --only-secrets AI_OS_PLATFORM_DB_URL --command "$PSQL \"\$AI_OS_PLATFORM_DB_URL\" -X -q -v ON_ERROR_STOP=1"
echo "Grootboek en rol seo_meter staan klaar in AI OS."
