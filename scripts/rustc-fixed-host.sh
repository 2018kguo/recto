#!/bin/sh
# Cargo hashes what `rustc -vV` says into every crate's symbols, host line included, and the order of
# those symbols decides the wasm's bytes. The wasm is for one target whichever machine builds it, so
# build-wasm.sh has every machine say the same thing.
if [ "$*" = "-vV" ]; then
  rustc -vV | sed 's/^host: .*/host: x86_64-unknown-linux-gnu/'
else
  exec rustc "$@"
fi
