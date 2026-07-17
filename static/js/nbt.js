// Generic NBT (Named Binary Tag) reader — big-endian, all 12 tag types.
// Used to parse Minecraft .schem/.schematic files after gzip/zlib
// decompression (see inflate.js). Unknown/irrelevant compound entries
// (Metadata, BlockEntities, Entities, DataVersion, ...) just come through
// as plain JS values — only the schematic loader cares which keys matter.

const TAG = {
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
  ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11,
  LongArray: 12,
};

class Cursor {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }
  u8() { const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  i8() { const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  u16() { const v = this.view.getUint16(this.pos, false); this.pos += 2; return v; }
  i16() { const v = this.view.getInt16(this.pos, false); this.pos += 2; return v; }
  i32() { const v = this.view.getInt32(this.pos, false); this.pos += 4; return v; }
  i64() { const v = this.view.getBigInt64(this.pos, false); this.pos += 8; return v; }
  f32() { const v = this.view.getFloat32(this.pos, false); this.pos += 4; return v; }
  f64() { const v = this.view.getFloat64(this.pos, false); this.pos += 8; return v; }
  bytesRaw(n) {
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  string() {
    const len = this.u16();
    return new TextDecoder('utf-8').decode(this.bytesRaw(len));
  }
}

function readPayload(c, type) {
  switch (type) {
    case TAG.Byte: return c.i8();
    case TAG.Short: return c.i16();
    case TAG.Int: return c.i32();
    case TAG.Long: return c.i64();
    case TAG.Float: return c.f32();
    case TAG.Double: return c.f64();
    case TAG.ByteArray: {
      const n = c.i32();
      return new Int8Array(c.bytesRaw(n));
    }
    case TAG.String: return c.string();
    case TAG.List: {
      const elemType = c.u8();
      const n = c.i32();
      const arr = new Array(Math.max(0, n));
      for (let i = 0; i < n; i++) arr[i] = readPayload(c, elemType);
      return arr;
    }
    case TAG.Compound: {
      const obj = {};
      for (;;) {
        const t = c.u8();
        if (t === TAG.End) break;
        const name = c.string();
        obj[name] = readPayload(c, t);
      }
      return obj;
    }
    case TAG.IntArray: {
      const n = c.i32();
      const arr = new Int32Array(n);
      for (let i = 0; i < n; i++) arr[i] = c.i32();
      return arr;
    }
    case TAG.LongArray: {
      const n = c.i32();
      const arr = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = c.i64();
      return arr;
    }
    default:
      throw new Error(`nbt: unknown tag type ${type}`);
  }
}

/** Parse a full NBT byte stream (already decompressed) into a plain JS
 * object tree. The root tag must be a named Compound (standard for both
 * schematic formats); its name is discarded. */
export function parseNbt(bytes) {
  const c = new Cursor(bytes);
  const rootType = c.u8();
  if (rootType !== TAG.Compound) {
    throw new Error('nbt: root tag is not a compound');
  }
  c.string(); // root name, usually empty
  return readPayload(c, TAG.Compound);
}

export { TAG };
