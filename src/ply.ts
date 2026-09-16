// Read only bounded Blob slices. No whole-file arrayBuffer, text or 32-bit byte offsets.
export type Property = { name: string; type: string; offset: number; bytes: number };
export type PlyHeader = { format: string; count: number; offset: number; stride: number; properties: Property[] };
export type Columns = Record<string, Float32Array>;
const sizes: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8
};
const getters: Record<string, (d: DataView, o: number, le: boolean) => number> = {
  char: (d,o) => d.getInt8(o), int8: (d,o) => d.getInt8(o), uchar: (d,o) => d.getUint8(o), uint8: (d,o) => d.getUint8(o),
  short: (d,o,l) => d.getInt16(o,l), int16: (d,o,l) => d.getInt16(o,l), ushort: (d,o,l) => d.getUint16(o,l), uint16: (d,o,l) => d.getUint16(o,l),
  int: (d,o,l) => d.getInt32(o,l), int32: (d,o,l) => d.getInt32(o,l), uint: (d,o,l) => d.getUint32(o,l), uint32: (d,o,l) => d.getUint32(o,l),
  float: (d,o,l) => d.getFloat32(o,l), float32: (d,o,l) => d.getFloat32(o,l), double: (d,o,l) => d.getFloat64(o,l), float64: (d,o,l) => d.getFloat64(o,l)
};
export const required = ['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
export async function readHeader(file: Blob): Promise<PlyHeader> {
  const raw = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
  const s = new TextDecoder('ascii').decode(raw);
  const end = /(?:^|\n)end_header\r?\n/.exec(s);
  if (!s.startsWith('ply\n') && !s.startsWith('ply\r\n')) throw new Error('这不是 PLY 文件：缺少 ply 文件头。');
  if (!end) throw new Error('PLY 文件头缺失 end_header，或超过 1 MB。');
  // Header is ASCII; decode byte positions directly, avoiding Unicode comment offsets.
  const marker = new TextEncoder().encode('end_header');
  let offset = 0;
  for (let i = 0; i < raw.length - marker.length; i++) {
    if ((i === 0 || raw[i - 1] === 10) && marker.every((v,j) => raw[i+j] === v)) {
      const p = i + marker.length;
      if (raw[p] === 10) { offset = p + 1; break; }
      if (raw[p] === 13 && raw[p+1] === 10) { offset = p + 2; break; }
    }
  }
  let format = '', count = -1, active = false, stride = 0;
  const properties: Property[] = [];
  for (const line of new TextDecoder().decode(raw.subarray(0, offset)).split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'format') format = p[1];
    if (p[0] === 'element') {
      if (count < 0 && p[1] !== 'vertex' && Number(p[2]) > 0) throw new Error('需要 vertex 为首个非空元素的标准 3DGS PLY；暂不支持 compressed PLY。');
      active = p[1] === 'vertex';
      if (active) { if (count >= 0) throw new Error('PLY 重复 vertex 元素。'); count = Number(p[2]); }
    }
    if (p[0] === 'property' && active) {
      if (!sizes[p[1]] || p[1] === 'list') throw new Error(`不支持的 PLY vertex 属性：${p.slice(1).join(' ')}`);
      if (properties.some(v => v.name === p[2])) throw new Error(`PLY 属性重复：${p[2]}`);
      properties.push({ name: p[2], type: p[1], offset: stride, bytes: sizes[p[1]] }); stride += sizes[p[1]];
    }
  }
  if (!['ascii','binary_little_endian','binary_big_endian'].includes(format)) throw new Error(`不支持的 PLY 编码：${format}`);
  if (!Number.isSafeInteger(count) || count <= 0 || count > 1e9 || stride > 4096) throw new Error('PLY 点数或属性数量无效。');
  const missing = required.filter(n => !properties.some(p => p.name === n));
  if (missing.length) throw new Error(`需要 Gaussian PLY（含颜色、透明度、尺度和旋转）。缺少：${missing.join(', ')}`);
  if (format !== 'ascii' && offset + count * stride > file.size) throw new Error('PLY 文件被截断：文件大小小于文件头声明的点数据。');
  return { format, count, offset, stride, properties };
}
export async function* readChunks(file: Blob, h: PlyHeader, chunkSize = 32768, names?: string[]): AsyncGenerator<{ columns: Columns; start: number; count: number }> {
  const props = names ? h.properties.filter(p => names.includes(p.name)) : h.properties.filter(p => required.includes(p.name) || /^f_rest_\d+$/.test(p.name));
  if (h.format !== 'ascii') {
    chunkSize=Math.max(1,Math.min(chunkSize,Math.floor(8*1024*1024/h.stride)));
    for (let start = 0; start < h.count; start += chunkSize) {
      const count = Math.min(chunkSize, h.count - start);
      const offset = h.offset + start * h.stride;
      const data = new DataView(await file.slice(offset, offset + count * h.stride).arrayBuffer());
      if (data.byteLength !== count * h.stride) throw new Error(`PLY 读取中断，点位置 ${start}。`);
      const columns: Columns = {};
      for (const p of props) {
        const a = columns[p.name] = new Float32Array(count), get = getters[p.type];
        for (let i = 0; i < count; i++) a[i] = get(data, i * h.stride + p.offset, h.format === 'binary_little_endian');
      }
      yield { columns, start, count };
    }
    return;
  }
  let leftover = '', count = 0, start = 0;
  let columns: Columns = Object.fromEntries(props.map(p => [p.name, new Float32Array(chunkSize)]));
  const indices = props.map(p => h.properties.findIndex(v => v.name === p.name));
  for (let pos = h.offset; pos < file.size && start < h.count; pos += 1024 * 1024) {
    leftover += await file.slice(pos, pos + 1024 * 1024).text();
    const last = leftover.lastIndexOf('\n');
    if(last<0 && pos+1024*1024<file.size) {
      if(leftover.length>1024*1024)throw new Error('ASCII PLY 单行过长。');
      continue;
    }
    const lines = (pos + 1024 * 1024 >= file.size ? leftover : leftover.slice(0,last)).split('\n');
    leftover = pos + 1024 * 1024 >= file.size ? '' : leftover.slice(last+1);
    if (leftover.length > 1024 * 1024) throw new Error('ASCII PLY 单行过长。');
    for (const line of lines) {
      if (!line.trim()) continue;
      const vals = line.trim().split(/\s+/);
      if (vals.length < h.properties.length) throw new Error(`ASCII PLY 第 ${start + count + 1} 点属性不完整。`);
      props.forEach((p,j) => { columns[p.name][count] = Number(vals[indices[j]]); });
      count++;
      if (count === chunkSize || start + count === h.count) {
        if (count < chunkSize) for (const name in columns) columns[name] = columns[name].slice(0,count);
        yield { columns, start, count };
        start += count; count = 0;
        if (start >= h.count) break;
        columns = Object.fromEntries(props.map(p => [p.name, new Float32Array(chunkSize)]));
      }
    }
  }
  if (start !== h.count) throw new Error('ASCII PLY 文件被截断。');
}
