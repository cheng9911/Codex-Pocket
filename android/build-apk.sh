#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [[ -z "$sdk" ]]; then
  printf '%s\n' 'Set ANDROID_HOME to an SDK containing Android 35 and Build Tools 35.0.0.' >&2
  exit 1
fi
tools="$sdk/build-tools/35.0.0"
platform="$sdk/platforms/android-35/android.jar"
output=${1:-"$root/artifacts/android/Codex-Pocket-0.1.0-test.apk"}
signing=${POCKET_ANDROID_SIGNING_DIR:-"$HOME/.local/share/codex-pocket/android-signing"}
if [[ -n ${JAVA_HOME:-} ]]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
for tool in "$tools/aapt2" "$tools/d8" "$tools/zipalign" "$tools/apksigner"; do
  if [[ ! -x "$tool" ]]; then printf 'Android tool missing: %s\n' "$tool" >&2; exit 1; fi
done
if [[ ! -r "$platform" ]]; then printf 'Android platform missing: %s\n' "$platform" >&2; exit 1; fi

build=$(mktemp -d)
trap 'rm -r -- "$build"' EXIT
mkdir -p -- "$build/generated" "$build/classes" "$build/dex"
"$tools/aapt2" compile --dir "$root/android/res" -o "$build/resources.zip"
"$tools/aapt2" link -I "$platform" --manifest "$root/android/AndroidManifest.xml" \
  --java "$build/generated" -o "$build/unsigned.apk" "$build/resources.zip"
javac --release 8 -encoding UTF-8 -cp "$platform" -d "$build/classes" \
  "$build/generated/cc/jcsun/codexpocket/R.java" \
  "$root/android/src/cc/jcsun/codexpocket/MainActivity.java"
jar cf "$build/classes.jar" -C "$build/classes" .
"$tools/d8" --lib "$platform" --min-api 26 --output "$build/dex" "$build/classes.jar"
zip -q -j "$build/unsigned.apk" "$build/dex/classes.dex"
"$tools/zipalign" -f 4 "$build/unsigned.apk" "$build/aligned.apk"

(
  umask 077
  mkdir -p -- "$signing"
  chmod 700 -- "$signing"
  exec 9>"$signing/.lock"
  flock -x 9
  key="$signing/pocket-test.p12"
  pass="$signing/password"
  if [[ ! -s "$pass" ]]; then
    if [[ -e "$key" ]]; then
      printf '%s\n' 'Signing password missing. Restore the original password file.' >&2
      exit 1
    fi
    openssl rand -base64 36 > "$pass"
  fi
  if [[ ! -e "$key" ]]; then
    keytool -genkeypair -storetype PKCS12 -keystore "$key" -storepass:file "$pass" \
      -alias codex-pocket -keyalg RSA -keysize 3072 -validity 10000 \
      -dname 'CN=Codex Pocket Test Builds'
  fi
  "$tools/apksigner" sign --ks "$key" --ks-key-alias codex-pocket --ks-pass "file:$pass" \
    --out "$build/signed.apk" "$build/aligned.apk"
)

"$tools/zipalign" -c 4 "$build/signed.apk"
"$tools/apksigner" verify "$build/signed.apk"
mkdir -p -- "$(dirname -- "$output")"
install -m 0644 "$build/signed.apk" "$output"
printf 'Signed APK: %s\n' "$output"
