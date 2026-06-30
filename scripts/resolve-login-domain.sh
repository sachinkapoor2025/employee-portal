#!/usr/bin/env bash
# Resolves Route53 zone + ACM cert (us-east-1) that covers login.mydgv.com for CloudFront.
set -euo pipefail

DOMAIN="${1:-login.mydgv.com}"
AWS_REGION="${AWS_REGION:-ap-south-1}"
ACM_REGION="us-east-1"

if [ -n "${LOGIN_MYDGV_ACM_CERT_ARN:-}" ]; then
  CERT_ARN="$LOGIN_MYDGV_ACM_CERT_ARN"
  aws acm describe-certificate --region "$ACM_REGION" --certificate-arn "$CERT_ARN" >/dev/null
  echo "Using certificate from LOGIN_MYDGV_ACM_CERT_ARN: $CERT_ARN" >&2
else
  cert_covers_domain() {
    local arn="$1"
    local target="$2"
    local info primary sans
    info=$(aws acm describe-certificate --region "$ACM_REGION" --certificate-arn "$arn" --output json)
    primary=$(echo "$info" | jq -r '.Certificate.DomainName')
    sans=$(echo "$info" | jq -r '.Certificate.SubjectAlternativeNames[]?')

    if [ "$primary" = "$target" ]; then
      return 0
    fi
    if echo "$sans" | grep -Fxq "$target"; then
      return 0
    fi
    if [ "$primary" = "*.mydgv.com" ]; then
      case "$target" in
        *.mydgv.com)
          local sub="${target%.mydgv.com}"
          sub="${sub%.}"
          if [ -n "$sub" ] && [[ "$sub" != *.* ]]; then
            return 0
          fi
          ;;
      esac
    fi
    return 1
  }

  CERT_ARN=""
  EXACT_ARN=""
  WILDCARD_ARN=""

  for arn in $(aws acm list-certificates --region "$ACM_REGION" --certificate-statuses ISSUED \
    --query 'CertificateSummaryList[].CertificateArn' --output text); do
    primary=$(aws acm describe-certificate --region "$ACM_REGION" --certificate-arn "$arn" \
      --query 'Certificate.DomainName' --output text)

    if cert_covers_domain "$arn" "$DOMAIN"; then
      if [ "$primary" = "$DOMAIN" ]; then
        EXACT_ARN="$arn"
        break
      fi
      if [ "$primary" = "*.mydgv.com" ] && [ -z "$WILDCARD_ARN" ]; then
        WILDCARD_ARN="$arn"
      fi
    fi
  done

  CERT_ARN="${EXACT_ARN:-$WILDCARD_ARN}"

  if [ -z "$CERT_ARN" ]; then
    echo "ERROR: No issued ACM certificate in us-east-1 covers $DOMAIN." >&2
    echo "Create one in AWS Certificate Manager (region: us-east-1) for:" >&2
    echo "  - $DOMAIN  (recommended), or" >&2
    echo "  - *.mydgv.com" >&2
    echo "Then validate via DNS and re-run deploy." >&2
    echo "" >&2
    echo "Issued certificates in us-east-1:" >&2
    aws acm list-certificates --region "$ACM_REGION" --certificate-statuses ISSUED \
      --query 'CertificateSummaryList[].{Domain:DomainName,Arn:CertificateArn}' --output table >&2 || true
    exit 1
  fi

  echo "Selected certificate for $DOMAIN: $CERT_ARN" >&2
fi

ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name mydgv.com \
  --query 'HostedZones[0].Id' --output text | sed 's|/hostedzone/||')

if [ -z "$ZONE_ID" ] || [ "$ZONE_ID" = "None" ]; then
  echo "ERROR: Route53 hosted zone for mydgv.com not found" >&2
  exit 1
fi

echo "zone_id=$ZONE_ID"
echo "cert_arn=$CERT_ARN"
