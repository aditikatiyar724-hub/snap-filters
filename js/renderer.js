/* WebGL renderer: draws a video/image source through one of the FILTERS shaders,
 * then a light sharpening pass so the result stays crisp. */

const VERTEX_SHADER = `
attribute vec2 aPos;
uniform float uMirror;
varying vec2 vUv;
void main() {
  vec2 uv = aPos * 0.5 + 0.5;
  uv.y = 1.0 - uv.y;
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  vUv = uv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const SHARPEN_VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/* Unsharp mask with a clamped delta, so edges crispen without bright halos */
const SHARPEN_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uAmount;
void main() {
  vec2 px = 1.0 / uRes;
  vec3 c = texture2D(uTex, vUv).rgb;
  vec3 n = (texture2D(uTex, vUv + vec2(px.x, 0.0)).rgb + texture2D(uTex, vUv - vec2(px.x, 0.0)).rgb
          + texture2D(uTex, vUv + vec2(0.0, px.y)).rgb + texture2D(uTex, vUv - vec2(0.0, px.y)).rgb) * 0.25;
  vec2 q = px * 2.0;
  vec3 w = (texture2D(uTex, vUv + q).rgb + texture2D(uTex, vUv - q).rgb
          + texture2D(uTex, vUv + vec2(q.x, -q.y)).rgb + texture2D(uTex, vUv + vec2(-q.x, q.y)).rgb) * 0.25;
  // fine detail (1px) + medium detail (2px) for clearer eyes, hair and edges
  vec3 d = clamp(c - n, -0.1, 0.1) * 1.0 + clamp(c - w, -0.08, 0.08) * 0.5;
  gl_FragColor = vec4(clamp(c + d * uAmount, 0.0, 1.0), 1.0);
}`;

const SHARPEN_AMOUNT = 1.2;

/* Every filter's main() is wrapped so its output can be blended back toward the
 * untouched camera frame: uIntensity 0 = original, 1 = full filter. */
function wrapFilter(shader) {
  return shader.replace(/void\s+main\s*\(\s*\)/, 'void filterMain()') + `
uniform float uIntensity;
void main() {
  filterMain();
  gl_FragColor = vec4(mix(tex(vUv), gl_FragColor.rgb, uIntensity), 1.0);
}`;
}

class Renderer {
  constructor(canvas, { preserve = false } = {}) {
    this.canvas = canvas;
    const opts = { alpha: false, antialias: false, preserveDrawingBuffer: preserve };
    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) throw new Error('WebGL is not supported on this device.');
    this.gl = gl;
    this.programs = new Map();

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.texture = this.makeTexture();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // Offscreen target for the filter pass; the sharpen pass reads from it
    this.fbTexture = this.makeTexture();
    this.framebuffer = gl.createFramebuffer();
    this.fbSize = [0, 0];

    const prog = gl.createProgram();
    gl.attachShader(prog, this.compile(gl.VERTEX_SHADER, SHARPEN_VERTEX));
    gl.attachShader(prog, this.compile(gl.FRAGMENT_SHADER, SHARPEN_FRAGMENT));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
    }
    this.sharpen = {
      prog,
      aPos: gl.getAttribLocation(prog, 'aPos'),
      uTex: gl.getUniformLocation(prog, 'uTex'),
      uRes: gl.getUniformLocation(prog, 'uRes'),
      uAmount: gl.getUniformLocation(prog, 'uAmount'),
    };
  }

  makeTexture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader compile failed: ' + log);
    }
    return sh;
  }

  program(filter) {
    if (this.programs.has(filter.id)) return this.programs.get(filter.id);
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, this.compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(prog, this.compile(gl.FRAGMENT_SHADER, SHADER_PRELUDE + wrapFilter(filter.shader)));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
    }
    const u = (n) => gl.getUniformLocation(prog, n);
    const entry = {
      prog,
      aPos: gl.getAttribLocation(prog, 'aPos'),
      uTex: u('uTex'), uRes: u('uRes'), uScale: u('uScale'), uTime: u('uTime'), uMirror: u('uMirror'),
      uCrop: u('uCrop'), uIntensity: u('uIntensity'),
      uSrcMean: u('uSrcMean'), uSrcStd: u('uSrcStd'), uRefMean: u('uRefMean'), uRefStd: u('uRefStd'),
    };
    this.programs.set(filter.id, entry);
    return entry;
  }

  /** Compile every filter up front so switching is instant. */
  warm(filters) { filters.forEach((f) => this.program(f)); }

  setSize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  ensureFramebuffer(w, h) {
    const gl = this.gl;
    if (this.fbSize[0] === w && this.fbSize[1] === h) return;
    gl.bindTexture(gl.TEXTURE_2D, this.fbTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fbTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fbSize = [w, h];
  }

  drawQuad(aPos) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * crop = [x, y, w, h] in 0..1 source coordinates: only that part of the source is
   * rendered, at the canvas's full resolution (no browser upscaling afterwards).
   * intensity = 0..1 blend from the original frame to the full filter.
   */
  render(source, filter, { src, ref, time = 0, mirror = false, crop = [0, 0, 1, 1], intensity = 1 }) {
    const gl = this.gl;
    const p = this.program(filter);
    const w = this.canvas.width, h = this.canvas.height;

    // Pass 1: filter -> offscreen texture
    this.ensureFramebuffer(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, w, h);
    gl.useProgram(p.prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);

    gl.uniform1i(p.uTex, 0);
    gl.uniform2f(p.uRes, w, h);
    gl.uniform1f(p.uScale, Math.max(Math.min(w, h) / 540, 0.5));
    gl.uniform1f(p.uTime, time);
    gl.uniform1f(p.uMirror, mirror ? 1 : 0);
    gl.uniform4fv(p.uCrop, crop);
    gl.uniform1f(p.uIntensity, intensity);
    gl.uniform3fv(p.uSrcMean, src.mean);
    gl.uniform3fv(p.uSrcStd, src.std);
    gl.uniform3fv(p.uRefMean, ref.mean);
    gl.uniform3fv(p.uRefStd, ref.std);
    this.drawQuad(p.aPos);

    // Pass 2: sharpen -> canvas
    const s = this.sharpen;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(s.prog);
    gl.bindTexture(gl.TEXTURE_2D, this.fbTexture);
    gl.uniform1i(s.uTex, 0);
    gl.uniform2f(s.uRes, w, h);
    // soft-focus filters can ask for less sharpening; scales with intensity
    const sharp = filter.sharpen ?? SHARPEN_AMOUNT;
    gl.uniform1f(s.uAmount, SHARPEN_AMOUNT + (sharp - SHARPEN_AMOUNT) * intensity);
    this.drawQuad(s.aPos);
  }
}

/* ---------- Lab colour statistics (CPU side, on a small downsample) ---------- */

const ColorStats = (() => {
  const canvas = document.createElement('canvas');
  const SIZE = 48;
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

  function rgbToLab(r, g, b) {
    r = lin(r / 255); g = lin(g / 255); b = lin(b / 255);
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  /** Mean / std-dev of Lab channels for any drawable source. */
  function measure(source, sw, sh) {
    ctx.drawImage(source, 0, 0, sw, sh, 0, 0, SIZE, SIZE);
    const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const sum = [0, 0, 0], sq = [0, 0, 0];
    const n = SIZE * SIZE;
    for (let i = 0; i < data.length; i += 4) {
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      for (let k = 0; k < 3; k++) { sum[k] += lab[k]; sq[k] += lab[k] * lab[k]; }
    }
    const mean = sum.map((s) => s / n);
    const std = sq.map((s, k) => Math.sqrt(Math.max(s / n - mean[k] * mean[k], 1e-4)));
    return { mean: new Float32Array(mean), std: new Float32Array(std) };
  }

  /** Exponential smoothing so the live grade doesn't flicker. */
  function blend(prev, next, k) {
    if (!prev) return next;
    const mix = (a, b) => a.map((v, i) => v + (b[i] - v) * k);
    return { mean: mix(prev.mean, next.mean), std: mix(prev.std, next.std) };
  }

  return { measure, blend };
})();
