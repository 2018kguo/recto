// wasm-split moves functions into parts, but every constant table stays in recto.wasm's data, which reading text
// downloads. This moves each read-only table whose readers are all in parts into those parts, as data a part writes
// into the shared memory when it's instantiated, before any of its functions runs. Nothing else changes: the bytes go
// to the same addresses, and only code that can't run before its part is loaded can read them.
//
// Which code reads what comes from two places. The linker's relocations (`--emit-relocs`) say where each table is,
// which tables point at which, and how far from a table its readers' addresses can be. The finished modules say which
// addresses each one's code holds: every reference to a table is a constant in the code, as an `i32.const` or a load's
// offset, within that distance of the table. A constant that happens to fall near a table keeps it; that's the only
// error, and it costs bytes, never a result.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** How far outside a table a reference may point, at most; the build fails if one points further. */
const MARGIN = 256;
/** Kept bytes between two moved runs closer than this join them, so the data isn't split into thousands of pieces. */
const JOIN = 64;

function reader(bytes, at = 0) {
  const r = {
    at,
    u8: () => bytes[r.at++],
    leb() {
      let value = 0;
      let shift = 0;
      let byte;
      do {
        byte = bytes[r.at++];
        value += (byte & 127) * 2 ** shift;
        shift += 7;
      } while (byte & 128);
      return value;
    },
    sleb() {
      let value = 0;
      let shift = 0;
      let byte;
      do {
        byte = bytes[r.at++];
        value |= (byte & 127) << shift;
        shift += 7;
      } while (byte & 128);
      return shift < 32 && byte & 64 ? value | (-1 << shift) : value;
    },
    string() {
      const length = r.leb();
      r.at += length;
      return Buffer.from(bytes.buffer, bytes.byteOffset + r.at - length, length).toString("utf8");
    },
  };
  return r;
}

/** A module's sections: id, custom name, where the payload starts (after a custom section's name) and ends. */
function sections(bytes) {
  const out = [];
  const r = reader(bytes, 8);
  while (r.at < bytes.length) {
    const start = r.at;
    const id = r.u8();
    const end = r.leb() + r.at;
    const name = id === 0 ? r.string() : "";
    out.push({ id, name, start, payload: r.at, end });
    r.at = end;
  }
  return out;
}

/** Active data segments: their address, and their bytes. */
function dataSegments(bytes) {
  const section = sections(bytes).find((s) => s.id === 11);
  if (!section) {
    return [];
  }
  const r = reader(bytes, section.payload);
  const segments = [];
  for (let count = r.leb(); count > 0; count--) {
    const flags = r.leb();
    if (flags !== 0) {
      throw new Error(`a data segment with flags ${flags}; only active segments in memory 0 are expected`);
    }
    if (r.u8() !== 0x41) {
      throw new Error("a data segment whose offset isn't an i32.const");
    }
    const address = r.sleb();
    if (r.u8() !== 0x0b) {
      throw new Error("a data segment's offset expression goes on");
    }
    const size = r.leb();
    segments.push({ address, bytes: bytes.subarray(r.at, r.at + size), payload: r.at - section.payload });
    r.at += size;
  }
  return segments;
}

// Relocation types that hold a memory address, and those that also carry an addend (tool-conventions, Linking.md).
const MEMORY = new Set([3, 4, 5, 11, 14, 15, 16, 17, 21, 23, 25]);
const ADDEND = new Set([3, 4, 5, 8, 9, 11, 14, 15, 16, 17, 21, 22, 23, 25]);

/**
 * From the linker's output with `--emit-relocs`: the read-only data's range, each data symbol's place, which point
 * at which, and the check that every reference from code lands within MARGIN of what it refers to.
 */
export function readLayout(bytes) {
  const all = sections(bytes);
  const custom = (name) => all.find((s) => s.id === 0 && s.name === name);
  const linking = custom("linking");
  if (!linking) {
    throw new Error("the wasm has no linking section: build it with -C link-arg=--emit-relocs");
  }
  const segments = dataSegments(bytes);
  const r = reader(bytes, linking.payload);
  if (r.leb() !== 2) {
    throw new Error("unexpected linking section version");
  }
  const symbols = [];
  const segmentNames = [];
  while (r.at < linking.end) {
    const type = r.u8();
    const end = r.leb() + r.at;
    if (type === 8) {
      for (let count = r.leb(); count > 0; count--) {
        const kind = r.u8();
        const flags = r.leb();
        const symbol = { kind };
        if (kind === 0 || kind === 2 || kind === 4 || kind === 5) {
          r.leb();
          if (!(flags & 0x10) || flags & 0x40) r.string();
        } else if (kind === 1) {
          r.string();
          if (!(flags & 0x10)) {
            symbol.segment = r.leb();
            symbol.address = segments[symbol.segment].address + r.leb();
            symbol.size = r.leb();
          }
        } else if (kind === 3) {
          r.leb();
        }
        symbols.push(symbol);
      }
    } else if (type === 5) {
      for (let count = r.leb(); count > 0; count--) {
        segmentNames.push(r.string());
        r.leb();
        r.leb();
      }
    }
    r.at = end;
  }
  const rodata = segmentNames.indexOf(".rodata");
  if (rodata < 0) {
    throw new Error("no .rodata segment");
  }
  const relocations = (name) => {
    const section = custom(name);
    const out = [];
    if (!section) {
      return out;
    }
    const s = reader(bytes, section.payload);
    s.leb();
    for (let count = s.leb(); count > 0; count--) {
      const type = s.u8();
      const offset = s.leb();
      const index = s.leb();
      const addend = ADDEND.has(type) ? s.sleb() : 0;
      if (MEMORY.has(type) && symbols[index]?.address !== undefined) out.push({ offset, symbol: symbols[index], addend });
    }
    return out;
  };
  for (const { symbol, addend } of relocations("reloc.CODE")) {
    if (addend < -MARGIN || addend > symbol.size + MARGIN) {
      throw new Error(`code refers to data ${addend} bytes from a symbol of ${symbol.size}; raise MARGIN in scripts/wasm-data.mjs`);
    }
  }
  const addressAt = (offset) => {
    for (const segment of segments) {
      const at = offset - segment.payload;
      if (at >= 0 && at < segment.bytes.length) return segment.address + at;
    }
    throw new Error("a data relocation outside every segment");
  };
  const defined = symbols.filter((s) => s.address !== undefined);
  return {
    rodata: { address: segments[rodata].address, size: segments[rodata].bytes.length },
    symbols: defined.map((s) => [s.address, s.size, s.segment === rodata ? 1 : 0]),
    // [where the pointer is, the address it points at]: a table that holds another's address needs it.
    pointers: relocations("reloc.DATA").map(({ offset, symbol, addend }) => [
      addressAt(offset),
      symbol.address + Math.max(0, Math.min(addend, symbol.size - 1)),
    ]),
  };
}

/** The module without the linker's relocations and symbols, which nothing after this step reads. */
export function withoutLinking(bytes) {
  const keep = [bytes.subarray(0, 8)];
  for (const s of sections(bytes)) {
    if (!(s.id === 0 && (s.name === "linking" || s.name.startsWith("reloc.")))) keep.push(bytes.subarray(s.start, s.end));
  }
  return Buffer.concat(keep);
}

const FEATURES = ["simd", "bulk-memory", "nontrapping-float-to-int", "sign-ext", "multivalue", "reference-types", "mutable-globals"].map((f) => `--enable-${f}`);

/** Every address-sized constant in a module's code and globals: `i32.const` operands and load and store offsets. */
function constants(file) {
  const text = execFileSync(process.env.WASM_DIS ?? "wasm-dis", [...FEATURES, file], { encoding: "utf8", maxBuffer: 1 << 30 });
  const values = new Set();
  for (const match of text.matchAll(/i32\.const (-?\d+)|offset=(\d+)/gu)) {
    values.add(Number(match[1] ?? match[2]) >>> 0);
  }
  return values;
}

const uleb = (value) => {
  const out = [];
  do {
    let byte = value & 127;
    value = Math.floor(value / 128);
    if (value) byte |= 128;
    out.push(byte);
  } while (value);
  return out;
};
const sleb = (value) => {
  const out = [];
  for (;;) {
    const byte = value & 127;
    value >>= 7;
    if ((value === 0 && !(byte & 64)) || (value === -1 && byte & 64)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 128);
  }
};
const section = (id, payload) => Buffer.concat([Buffer.from([id, ...uleb(payload.length)]), payload]);
const dataSection = (runs) =>
  section(
    11,
    Buffer.concat([
      Buffer.from(uleb(runs.length)),
      ...runs.flatMap(({ address, bytes }) => [Buffer.from([0, 0x41, ...sleb(address), 0x0b, ...uleb(bytes.length)]), bytes]),
    ]),
  );

/** Byte ranges [start, end) where `wanted` is set, joining those less than JOIN apart. */
function runs(wanted, base, image) {
  const out = [];
  let i = 0;
  while (i < wanted.length) {
    if (!wanted[i]) {
      i++;
      continue;
    }
    let end = i;
    let last = i;
    while (end < wanted.length && end - last <= JOIN) {
      if (wanted[end]) last = end;
      end++;
    }
    out.push({ address: base + i, bytes: image.subarray(i, last + 1) });
    i = last + 1;
  }
  return out;
}

/**
 * After the split: each part gets the read-only data its code can reach and recto.wasm's can't, and recto.wasm
 * drops it. Returns what moved, in bytes.
 */
export function placeData(outDir, layout) {
  const names = ["recto", "recto-render", "recto-more", "recto-rare"];
  const files = Object.fromEntries(names.map((name) => [name, path.join(outDir, `${name}.wasm`)]));
  const symbols = layout.symbols.map(([address, size, readOnly]) => ({ address, size, readOnly }));
  symbols.sort((a, b) => a.address - b.address);
  const near = (value) => {
    const out = [];
    let lo = 0;
    let hi = symbols.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (symbols[mid].address < value - MARGIN - (1 << 20)) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < symbols.length && symbols[i].address <= value + MARGIN; i++) {
      const s = symbols[i];
      if (value >= s.address - MARGIN && value <= s.address + s.size + MARGIN) out.push(s);
    }
    return out;
  };
  const containing = (address) => near(address).filter((s) => address >= s.address && address < s.address + Math.max(s.size, 1));
  const pointsAt = new Map();
  for (const [from, to] of layout.pointers) {
    for (const holder of containing(from)) {
      if (!pointsAt.has(holder)) pointsAt.set(holder, []);
      pointsAt.get(holder).push(...containing(to));
    }
  }
  const reach = (start) => {
    const seen = new Set(start);
    const stack = [...start];
    while (stack.length) {
      for (const next of pointsAt.get(stack.pop()) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return seen;
  };
  const reached = {};
  for (const name of names) {
    const start = [];
    for (const value of constants(files[name])) start.push(...near(value));
    // What writable data points at is reachable from wherever that data is read: keep it with recto.wasm.
    if (name === "recto") start.push(...symbols.filter((s) => !s.readOnly));
    reached[name] = reach(start);
  }

  const { address: base, size } = layout.rodata;
  const primary = fs.readFileSync(files.recto);
  const segments = dataSegments(primary);
  const image = segments.find((s) => s.address === base && s.bytes.length === size)?.bytes;
  if (!image) {
    throw new Error("recto.wasm's read-only data isn't where the linker put it");
  }
  // Moved: bytes of read-only symbols recto.wasm's code can't reach, and no reachable symbol shares.
  const moved = new Uint8Array(size);
  for (const s of symbols) if (s.readOnly && !reached.recto.has(s)) moved.fill(1, s.address - base, s.address - base + s.size);
  for (const s of symbols) if (reached.recto.has(s) && s.readOnly) moved.fill(0, s.address - base, s.address - base + s.size);
  const kept = moved.map((m) => 1 - m);
  const others = segments.filter((s) => s.bytes !== image && s.bytes.some((b) => b !== 0));
  rewrite(files.recto, [...runs(kept, base, image), ...others]);
  for (const name of names.slice(1)) {
    const wanted = new Uint8Array(size);
    for (const s of reached[name]) {
      if (s.readOnly) {
        for (let i = s.address - base; i < s.address - base + s.size; i++) wanted[i] = moved[i];
      }
    }
    rewrite(files[name], runs(wanted, base, image));
  }
  return moved.reduce((sum, m) => sum + m, 0);
}

/** Replaces a module's data (and its count), or adds data after its code. */
function rewrite(file, segments) {
  const bytes = fs.readFileSync(file);
  const out = [bytes.subarray(0, 8)];
  let placed = false;
  for (const s of sections(bytes)) {
    if (s.id === 12) {
      out.push(section(12, Buffer.from(uleb(segments.length))));
    } else if (s.id === 11) {
      out.push(dataSection(segments));
      placed = true;
    } else {
      out.push(bytes.subarray(s.start, s.end));
      if (s.id === 10 && !sections(bytes).some((t) => t.id === 11) && segments.length) {
        out.push(dataSection(segments));
        placed = true;
      }
    }
  }
  if (!placed && segments.length) {
    throw new Error(`${file} has no code to put data after`);
  }
  fs.writeFileSync(file, Buffer.concat(out));
}

// node scripts/wasm-data.mjs <linked.wasm> <layout.json> <out.wasm>: the layout, and the module bindgen takes.
if (process.argv[1] === import.meta.filename) {
  const [input, layoutFile, output] = process.argv.slice(2);
  const bytes = fs.readFileSync(input);
  fs.writeFileSync(layoutFile, JSON.stringify(readLayout(bytes)));
  fs.writeFileSync(output, withoutLinking(bytes));
}
