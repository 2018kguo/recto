#!/bin/sh
# Builds what the npm package ships into js/wasm. Needs
# `rustup target add wasm32-unknown-unknown` and
# `cargo install wasm-bindgen-cli --version 0.2.129`, and `wasm-split` from binaryen version_133.
set -eu
cd "$(dirname "$0")/.."
# Panic messages embed source paths; keep the build machine's out of the shipped file.
# v0 mangling: a function's name says which generic instance it is, so scripts/wasm-parts stays
# meaningful from build to build. Names leave with the split.
export RUSTFLAGS="-C target-feature=+simd128 -C symbol-mangling-version=v0 --remap-path-prefix=$HOME=~ --remap-path-prefix=$PWD=."
cargo build --release -p recto --lib --no-default-features --features wasm \
  --target wasm32-unknown-unknown
# --omit-default-module-path: the glue's default `new URL("recto_bg.wasm", import.meta.url)`
# names a file that is not shipped, and bundlers fail on it. src/assets.ts finds the wasm.
# wasm-opt isn't run: larger after brotli, and no faster.
"${WASM_BINDGEN:-wasm-bindgen}" target/wasm32-unknown-unknown/release/recto.wasm \
  --omit-default-module-path --target web \
  --out-dir target/wasm-bindgen --out-name recto
node scripts/package-wasm.mjs
