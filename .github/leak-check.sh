#!/usr/bin/env bash
# Fails when the unzipped share holds anything personal: Robert's own docs, his workflow's names, Windows machine
# paths, or a link to the private repo. INSTALL.md and README.md belong only at the top (the shared ones).
# Usage: leak-check.sh <unzipped dir>
set -u
dir="$1"
fail=0

leak () {
    echo "LEAK: $1"
    fail=1
}

[ -f "$dir/INSTALL.md" ] && [ -f "$dir/README.md" ] && [ -f "$dir/tabby-remote/index.js" ] || leak 'the zip must hold INSTALL.md, README.md and tabby-remote/'
for name in BRIEF.md .git .github share; do
    find "$dir" -name "$name" | grep -q . && leak "$name is in the zip"
done
for name in INSTALL.md README.md; do
    [ -e "$dir/tabby-remote/$name" ] && leak "the repo's own $name is in the plugin folder"
done

check () {
    local hits
    hits=$(grep -rIl -i -E "$1" "$dir")
    [ -n "$hits" ] && leak "'$2' found in: $(echo $hits)"
}
check 'claude-sessions' 'claude-sessions'
check 'workflow' 'workflow'
check '[A-Za-z]:\\\\[A-Za-z]' 'a C:\ path'
check '[A-Za-z]:\\[A-Za-z]' 'a C:\ path'
check 'robw0ng/' 'robw0ng/ (a repo link)'

[ "$fail" = 0 ] && echo 'leak check: clean'
exit "$fail"
