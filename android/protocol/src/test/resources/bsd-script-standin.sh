#!/bin/sh
# A stand-in for BSD script(1), for SshTestHostTest on a machine that only has util-linux's.
# It follows BSD's argument grammar, `script [-aeFkqr] [-t time] [file [command ...]]`: no -c and no
# --version (an unknown option prints the usage and exits 1), and the command is the argv after the
# typescript file. The pty itself is borrowed from util-linux, so that argv is quoted back into one line.
while getopts aeFkqrt: o; do
  if [ "$o" = '?' ]; then
    echo 'usage: script [-aeFkqr] [-t time] [file [command ...]]' >&2
    exit 1
  fi
done
shift $((OPTIND - 1))
file=$1
shift
line=''
for a in "$@"; do
  line="$line '$(printf '%s' "$a" | sed "s/'/'\\\\''/g")'"
done
exec script -qec "$line" "$file"
