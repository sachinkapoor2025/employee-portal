#!/usr/bin/env bash
# UPSERT Route53 A alias for login.mydgv.com -> CloudFront (replaces existing record safely).
set -euo pipefail

ZONE_ID="${1:?hosted zone id required}"
DOMAIN="${2:-login.mydgv.com}"
CF_DOMAIN="${3:?cloudfront domain required}"

if [[ "$CF_DOMAIN" != *. ]]; then
  CF_DOMAIN="${CF_DOMAIN}."
fi

CHANGE_BATCH=$(mktemp)
trap 'rm -f "$CHANGE_BATCH"' EXIT

cat > "$CHANGE_BATCH" <<EOF
{
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${DOMAIN}",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "${CF_DOMAIN}",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
EOF

aws route53 change-resource-record-sets \
  --hosted-zone-id "$ZONE_ID" \
  --change-batch "file://${CHANGE_BATCH}"

echo "UPSERTed ${DOMAIN} -> ${CF_DOMAIN}" >&2
