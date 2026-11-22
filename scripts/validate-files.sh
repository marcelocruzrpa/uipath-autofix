#!/usr/bin/env bash
# Check the files a patch changed before they are published: XML must be well-formed and
# carry no DTD, JSON must parse. Run from the project checkout, by the `claude` job (early
# feedback) and again by `publish` (the verdict that counts).
#   usage: validate-files.sh <NUL-delimited file list>
#   exit 0 = ok, 1 = failed (reasons on stdout)
set -uo pipefail
LIST="${1:?usage: validate-files.sh <NUL-delimited file list>}"

fail=0
while IFS= read -r -d '' f; do
  [[ -f "$f" ]] || continue  # deleted file
  case "${f,,}" in
    *.xaml|*.xml|*.config)
      # XAML never carries a DTD; refusing DOCTYPE/ENTITY rules out entity-expansion
      # (billion laughs) and external-entity tricks. The grep gives a clear message for the
      # plain case; the parser hooks below refuse the same thing whatever the file's
      # encoding (a UTF-16 file would slip past an ASCII grep).
      if grep -qiE '<!(DOCTYPE|ENTITY)' -- "$f"; then
        echo "DTD/entity declarations are not allowed: $f"; fail=1; continue
      fi
      if ! python3 -c '
import sys
from xml.parsers import expat

def forbid(*_):
    raise ValueError("DTD/entity declarations are not allowed")

p = expat.ParserCreate(namespace_separator="}")  # namespace-aware: unbound prefixes fail
p.StartDoctypeDeclHandler = forbid
p.EntityDeclHandler = forbid
try:
    with open(sys.argv[1], "rb") as f:
        p.ParseFile(f)
except Exception as e:
    print(e)
    sys.exit(1)
' "$f" 2>&1; then
        echo "not well-formed XML: $f"; fail=1
      fi ;;
    *.json)
      if ! node -e '
        try { JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^﻿/, "")); }
        catch (e) { console.log(e.message); process.exit(1); }
      ' "$f" 2>&1; then
        echo "invalid JSON: $f"; fail=1
      fi ;;
  esac
done < "$LIST"
exit $fail
