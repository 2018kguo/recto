#!/bin/sh
# Builds what the npm package ships into js/wasm. Needs
# `rustup target add wasm32-unknown-unknown` and
# `cargo install wasm-bindgen-cli --version 0.2.129`.
set -eu
cd "$(dirname "$0")/.."
# Panic messages embed source paths; keep the build machine's out of the shipped file.
export RUSTFLAGS="-C target-feature=+simd128 --remap-path-prefix=$HOME=~ --remap-path-prefix=$PWD=."
cargo build --release -p recto --lib --no-default-features --features wasm,render \
  --target wasm32-unknown-unknown
# recto-text.wasm: everything but the rasterizer and image decoders, loaded first.
cargo build --profile text -p recto --lib --no-default-features --features wasm \
  --target wasm32-unknown-unknown
# --remove-name-section: about 0.3 MB; a trap reports wasm-function[N]. Not Cargo's
# `strip`, which would also drop target_features, and wasm-bindgen then falls back to a
# slower return-pointer ABI.
# --omit-default-module-path: the glue's default `new URL("recto_bg.wasm", import.meta.url)`
# names a file that is not shipped, and bundlers fail on it. src/assets.ts finds the wasm.
# wasm-opt -O3 saves 4% raw and nothing after brotli, so it is not run.
"${WASM_BINDGEN:-wasm-bindgen}" target/wasm32-unknown-unknown/release/recto.wasm \
  --remove-name-section --omit-default-module-path --target web \
  --out-dir target/wasm-bindgen --out-name recto
"${WASM_BINDGEN:-wasm-bindgen}" target/wasm32-unknown-unknown/text/recto.wasm \
  --remove-name-section --omit-default-module-path --target web \
  --out-dir target/wasm-bindgen-text --out-name recto
node scripts/package-wasm.mjs
