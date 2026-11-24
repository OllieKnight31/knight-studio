#!/usr/bin/env bash
# Creates a stable self-signed code-signing identity for Knight Studio.
#
# Why this exists: with no Developer ID, the app is ad-hoc signed, and an ad-hoc
# signature changes every single rebuild. macOS pins privacy grants (Camera,
# Microphone, Screen Recording, Accessibility) to the signature, so every rebuild
# would silently revoke them and prompt again. Signing with one fixed self-signed
# certificate keeps the app's identity constant, so the permissions you grant once
# stay granted.
set -euo pipefail

NAME="Knight Studio Code Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NAME" >/dev/null 2>&1; then
  echo "identity already exists: $NAME"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/openssl.cnf" <<'CNF'
[ req ]
distinguished_name = dn
x509_extensions    = ext
prompt             = no
[ dn ]
CN = Knight Studio Code Signing
[ ext ]
basicConstraints       = critical,CA:false
keyUsage               = critical,digitalSignature
extendedKeyUsage       = critical,codeSigning
subjectKeyIdentifier   = hash
CNF

openssl req -x509 -newkey rsa:2048 -sha256 -days 7300 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/openssl.cnf" 2>/dev/null

openssl pkcs12 -export -legacy -out "$TMP/identity.p12" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" -passout pass:knightstudio 2>/dev/null \
  || openssl pkcs12 -export -out "$TMP/identity.p12" \
       -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" -passout pass:knightstudio 2>/dev/null

# -A lets codesign use the key without prompting on every single build.
security import "$TMP/identity.p12" -k "$KEYCHAIN" -P knightstudio \
  -T /usr/bin/codesign -T /usr/bin/security -A >/dev/null

# Mark it trusted for code signing in the user's own trust domain.
security add-trusted-cert -r trustAsRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem" 2>/dev/null \
  || echo "note: could not set trust automatically — see the message below"

echo "created identity: $NAME"
security find-identity -v -p codesigning | tail -3
