/*
 * Filter definitions.
 *
 * Every filter does two things on the GPU, per frame:
 *  1. Colour transfer: shifts the camera frame's Lab colour statistics
 *     (mean / std-dev) toward those of the filter's reference image, so the
 *     palette and mood match the artwork.
 *  2. Stylisation: a shader that recreates the medium of the reference
 *     (prism light, film, 90s window light).
 */

const SHADER_PRELUDE = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uRes;      // output size in px
uniform float uScale;   // resolution-independent sample step (1.0 at 540px short side)
uniform float uTime;
uniform vec3 uSrcMean;
uniform vec3 uSrcStd;
uniform vec3 uRefMean;
uniform vec3 uRefStd;

#define KR 3

uniform vec4 uCrop;      // visible part of the source: xy offset, zw size (0..1)
vec3 tex(vec2 uv) { return texture2D(uTex, uCrop.xy + clamp(uv, 0.0, 1.0) * uCrop.zw).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 sat(vec3 c, float s) { return mix(vec3(luma(c)), c, s); }
vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
vec3 rainbow(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}

/* sRGB <-> CIE Lab (D65) */
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 rgb2lab(vec3 c) {
  vec3 xyz = mat3(0.4124, 0.2126, 0.0193, 0.3576, 0.7152, 0.1192, 0.1805, 0.0722, 0.9505) * toLinear(c);
  xyz /= vec3(0.95047, 1.0, 1.08883);
  vec3 f = mix(7.787 * xyz + 16.0 / 116.0, pow(max(xyz, 0.0), vec3(1.0 / 3.0)), step(0.008856, xyz));
  return vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
}
vec3 lab2rgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0;
  vec3 f = vec3(fy + lab.y / 500.0, fy, fy - lab.z / 200.0);
  vec3 f3 = f * f * f;
  vec3 xyz = mix((f - 16.0 / 116.0) / 7.787, f3, step(0.008856, f3)) * vec3(0.95047, 1.0, 1.08883);
  return toSrgb(mat3(3.2406, -0.9689, 0.0557, -1.5372, 1.8758, -0.2040, -0.4986, 0.0415, 1.0570) * xyz);
}

/* Reinhard colour transfer toward the reference; amt = (L, a, b) strength */
vec3 transfer(vec3 c, vec3 amt) {
  vec3 lab = rgb2lab(c);
  vec3 ratio = clamp(uRefStd / max(uSrcStd, vec3(0.001)), 0.4, 2.2);
  vec3 t = (lab - uSrcMean) * ratio + uRefMean;
  return clamp(lab2rgb(mix(lab, t, amt)), 0.0, 1.0);
}

/* Weighted Kuwahara: edge-preserving smoothing that gives a painted look */
vec4 kq(vec2 uv, vec2 px, vec2 dir) {
  vec3 sum = vec3(0.0), sq = vec3(0.0);
  for (int j = 0; j <= KR; j++) {
    for (int i = 0; i <= KR; i++) {
      vec3 c = tex(uv + vec2(float(i), float(j)) * dir * px);
      sum += c; sq += c * c;
    }
  }
  float n = float((KR + 1) * (KR + 1));
  vec3 m = sum / n;
  vec3 v = abs(sq / n - m * m);
  return vec4(m, v.r + v.g + v.b);
}
vec3 kuwahara(vec2 uv, float stepPx) {
  vec2 px = stepPx / uRes;
  vec4 a = kq(uv, px, vec2(-1.0, -1.0));
  vec4 b = kq(uv, px, vec2( 1.0, -1.0));
  vec4 c = kq(uv, px, vec2(-1.0,  1.0));
  vec4 d = kq(uv, px, vec2( 1.0,  1.0));
  vec4 w = 1.0 / pow(vec4(a.w, b.w, c.w, d.w) + 0.0008, vec4(2.0));
  return (a.rgb * w.x + b.rgb * w.y + c.rgb * w.z + d.rgb * w.w) / (w.x + w.y + w.z + w.w);
}

/* Sobel edge magnitude on luminance */
float edge(vec2 uv, float stepPx) {
  vec2 px = stepPx / uRes;
  float tl = luma(tex(uv + px * vec2(-1.0, -1.0)));
  float t  = luma(tex(uv + px * vec2( 0.0, -1.0)));
  float tr = luma(tex(uv + px * vec2( 1.0, -1.0)));
  float l  = luma(tex(uv + px * vec2(-1.0,  0.0)));
  float r  = luma(tex(uv + px * vec2( 1.0,  0.0)));
  float bl = luma(tex(uv + px * vec2(-1.0,  1.0)));
  float b  = luma(tex(uv + px * vec2( 0.0,  1.0)));
  float br = luma(tex(uv + px * vec2( 1.0,  1.0)));
  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
  return length(vec2(gx, gy));
}
`;

const FILTERS = [
  {
    id: 'prism',
    name: 'Prism Light',
    image: 'assets/filters/prism.jpg',
    shader: `
void main() {
  vec2 uv = vUv;
  vec2 px = uScale / uRes;

  // slight chromatic split
  vec3 base = vec3(tex(uv + vec2(px.x * 1.5, 0.0)).r, tex(uv).g, tex(uv - vec2(px.x * 1.5, 0.0)).b);

  vec3 blur = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5236;
    blur += tex(uv + vec2(cos(a), sin(a)) * px * 6.0);
  }
  blur /= 12.0;

  vec3 c = transfer(mix(base, blur, 0.3), vec3(0.4, 0.65, 0.65));
  c = screen(c, max(blur - 0.55, 0.0) * 1.6);
  c = mix(vec3(0.12, 0.12, 0.16), vec3(0.98, 0.96, 0.98), c);
  c = clamp(sat(c, 0.9), 0.0, 1.0);

  // refracted rainbow light leaks
  float a = uv.x - 0.3 * uv.y;
  float c1 = 0.72 + 0.05 * sin(uTime * 0.4);
  float c2 = 0.18 + 0.04 * sin(uTime * 0.3 + 1.7);
  float w1 = exp(-pow((a - c1) / 0.07, 2.0));
  float w2 = exp(-pow((a - c2) / 0.05, 2.0)) * smoothstep(0.55, 1.0, uv.y);
  float ripple = 0.6 + 0.8 * fbm(vec2(a * 20.0, uv.y * 3.0 + uTime * 0.1));
  vec3 leak = rainbow((a - c1) / 0.14 + 0.5) * w1 + rainbow((a - c2) / 0.1 + 0.5) * w2;
  c = screen(c, leak * ripple * 0.5 * (0.4 + luma(c)));

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
  },
  {
    id: 'film',
    name: 'Golden Hour Film',
    image: 'assets/filters/film.jpg',
    shader: `
void main() {
  vec2 uv = vUv;
  vec2 px = uScale / uRes;

  vec3 c = vec3(tex(uv + vec2(px.x * 0.8, 0.0)).r, tex(uv).g, tex(uv - vec2(px.x * 0.8, 0.0)).b);

  // halation around highlights
  vec3 h = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785;
    h += tex(uv + vec2(cos(a), sin(a)) * px * 10.0);
  }
  float hl = smoothstep(0.6, 1.0, luma(h / 8.0));

  c = transfer(c, vec3(0.5, 0.85, 0.85));
  c = c * c * (3.0 - 2.0 * c) * 0.5 + c * 0.5;
  c = mix(vec3(0.07, 0.045, 0.03), vec3(1.0, 0.95, 0.86), c);
  c += vec3(1.0, 0.45, 0.2) * hl * 0.35;
  c *= vec3(1.04, 1.0, 0.92);

  // grain + vignette
  c += (hash(floor(vUv * uRes / max(uScale, 1.0)) + fract(uTime * 13.0) * 97.0) - 0.5) * 0.07;
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * 0.9;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
  },
  {
    id: 'nineties',
    name: '90s Light',
    image: 'assets/filters/nineties.jpg',
    shader: `
void main() {
  vec2 uv = vUv;
  vec2 px = uScale / uRes;

  // faint chromatic split (kept small so detail stays sharp)
  vec3 c = vec3(tex(uv + vec2(px.x * 0.5, 0.0)).r, tex(uv).g, tex(uv - vec2(px.x * 0.5, 0.0)).b);
  vec3 b = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785;
    b += tex(uv + vec2(cos(a), sin(a)) * px * 7.0);
  }
  b /= 8.0;

  c = transfer(c, vec3(0.45, 0.8, 0.8));

  // late-afternoon sun shafts through a window, broken by frame and curtain folds
  float d = uv.x * 0.8 + uv.y * 0.6;
  float shafts = smoothstep(0.35, 0.75, 0.5 + 0.5 * sin(d * 9.0 + 0.6));
  float folds = 0.75 + 0.25 * sin(uv.x * 70.0 + fbm(uv * 6.0) * 4.0);
  float flicker = 0.9 + 0.1 * sin(uTime * 0.5);
  float sun = shafts * folds * flicker * (1.0 - smoothstep(0.3, 1.3, d));
  c *= 0.78 + 0.5 * sun * vec3(1.0, 0.72, 0.45);

  // bloom around highlights, tinted amber
  float hl = smoothstep(0.55, 1.0, luma(b));
  c = screen(c, vec3(1.0, 0.55, 0.25) * hl * 0.3);

  // faded print: warm highlights, lifted teal-brown shadows
  float l = luma(c);
  c = mix(c, c * vec3(0.8, 0.95, 1.05), (1.0 - l) * 0.35);
  c = mix(vec3(0.1, 0.07, 0.07), vec3(1.0, 0.93, 0.82), c);
  c = clamp(sat(c, 1.1), 0.0, 1.0);

  // coarse grain + dust + vignette
  vec2 g = floor(vUv * uRes / max(uScale, 1.0));
  c += (hash(g + fract(uTime * 11.0) * 71.0) - 0.5) * 0.05;
  c -= step(0.9993, hash(g * 0.37 + floor(uTime * 8.0))) * 0.25;
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * 1.1;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
  },
  {
    id: 'splitlight',
    name: 'Split Light',
    image: 'assets/filters/splitlight.jpg',
    shader: `
void main() {
  vec2 uv = vUv;
  vec2 px = uScale / uRes;

  vec3 c = tex(uv);
  vec3 b = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785;
    b += tex(uv + vec2(cos(a), sin(a)) * px * 9.0);
  }
  b /= 8.0;

  c = transfer(c, vec3(0.3, 0.5, 0.5));
  float l = luma(c);

  // two coloured lamps: hot orange from the left, cool teal shadow on the right,
  // meeting along a soft diagonal edge that drifts slowly
  float edgeX = 0.52 + 0.28 * (uv.y - 0.35) + 0.02 * sin(uTime * 0.35);
  float warm = smoothstep(edgeX + 0.14, edgeX - 0.1, uv.x);
  vec3 orange = vec3(1.0, 0.42, 0.06);
  vec3 teal = vec3(0.16, 0.36, 0.44);
  vec3 lamp = mix(teal, orange, warm);

  // light the scene with the lamps (multiply), keep highlights hot (screen)
  c = mix(vec3(l), c, 0.55) * lamp * 1.75;
  c = screen(c, orange * warm * pow(l, 2.0) * 0.35);

  // glowing screens: bright areas bloom in saturated yellow-green
  float hl = smoothstep(0.62, 0.95, luma(b));
  vec3 glow = mix(vec3(0.55, 0.95, 0.75), vec3(1.0, 0.92, 0.2), warm * 0.6 + 0.4);
  c = screen(c, glow * hl * 0.35);

  // warm spill across the floor, crushed coloured blacks
  c += orange * smoothstep(0.65, 1.0, uv.y) * warm * 0.12;
  c = mix(mix(vec3(0.1, 0.05, 0.02), vec3(0.03, 0.07, 0.09), 1.0 - warm), vec3(1.0), c);
  c = clamp(sat(c, 1.2), 0.0, 1.0);

  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * 0.8;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
  },
  {
    id: 'summer',
    name: 'Warm Cinematic Summer',
    image: 'assets/filters/summer.jpg',
    // Pure colour grade: no colour transfer toward the thumbnail, no blur, no added light.
    // Adapts to the scene via uSrcMean (smoothed Lab stats of the live camera frame).
    shader: `
void main() {
  vec3 c = tex(vUv);
  vec3 lab = rgb2lab(c);

  // adaptive white balance: neutralise part of the scene's colour cast so
  // sun, shade and indoor light all land on the same warm grade
  lab.yz -= clamp(uSrcMean.yz, vec2(-12.0), vec2(12.0)) * 0.45;

  // exposure (+0.1) with mild auto-levelling toward a mid-key scene
  lab.x += 3.0 + clamp((52.0 - uSrcMean.x) * 0.12, -3.0, 5.0);

  // skin mask: warm hues with moderate chroma (a > 0, b > 0, hue ~20-70 deg)
  float hue = atan(lab.z, lab.y);
  float chroma = length(lab.yz);
  float skin = smoothstep(0.25, 0.5, hue) * (1.0 - smoothstep(1.05, 1.3, hue))
             * smoothstep(6.0, 12.0, chroma) * (1.0 - smoothstep(40.0, 55.0, chroma));

  // temperature +10 / tint +2, held back on skin so it stays natural
  float warmAmt = 1.0 - skin * 0.6;
  lab.z += 6.5 * warmAmt;
  lab.y += 1.2 * warmAmt;

  // foliage -> olive: greens lose chroma and lean yellow
  float green = smoothstep(-4.0, -12.0, lab.y) * step(0.0, lab.z);
  lab.y *= 1.0 - 0.2 * green;
  lab.z += 3.0 * green;

  // skies -> muted cyan-blue
  float blue = smoothstep(-6.0, -18.0, lab.z);
  lab.z *= 1.0 - 0.3 * blue;
  lab.y -= 2.5 * blue;

  // reds / oranges stay warm but muted
  lab.y *= 1.0 - 0.1 * smoothstep(12.0, 30.0, lab.y) * (1.0 - skin);

  c = clamp(lab2rgb(lab), 0.0, 1.0);

  // contrast -12
  c = mix(vec3(0.46), c, 0.88);
  // shadows +12, highlights -15 (soft film shoulder)
  c += 0.14 * c * (1.0 - c) * (1.0 - c);
  c -= 0.12 * c * c * (1.0 - c);
  // blacks +8, whites -7 with a faint warm bias
  c = mix(vec3(0.035, 0.034, 0.028), vec3(0.965, 0.95, 0.915), c);

  // saturation -8
  c = clamp(sat(c, 0.92), 0.0, 1.0);

  // split tone: subtle amber highlights, faint olive-cyan shadows
  float l = luma(c);
  float hi = smoothstep(0.5, 1.0, l);
  c = mix(c, c * vec3(1.035, 1.0, 0.9), hi * 0.55 * (1.0 - skin * 0.5));
  float sh = 1.0 - smoothstep(0.0, 0.45, l);
  c += vec3(-0.006, 0.01, 0.004) * sh;

  // grain ~3%, strongest in midtones
  vec2 g = floor(vUv * uRes / max(uScale, 1.0));
  c += (hash(g + fract(uTime * 11.0) * 71.0) - 0.5) * 0.02 * (0.5 + l * (1.0 - l) * 2.0);

  // vignette ~4% at the corners
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * 0.09;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
  },
  {
    id: 'mono',
    name: 'Black & White',
    image: 'assets/filters/mono.jpg',
    // Classic monochrome film: red-leaning channel mix (flattering skin, darker skies),
    // auto-levelled to the scene, S-curve, fine grain and a soft vignette.
    shader: `
void main() {
  vec3 c = tex(vUv);
  float l = dot(c, vec3(0.4, 0.45, 0.15));

  // auto-level toward a mid-key exposure via gamma, so whites never clip
  // (uSrcMean.x is scene lightness 0-100)
  l = pow(clamp(l, 0.0, 1.0), clamp(uSrcMean.x / 50.0, 0.75, 1.25));

  // film S-curve: rich blacks, clean whites, open midtones
  l = mix(l, l * l * (3.0 - 2.0 * l), 0.5);
  l = mix(0.03, 0.97, l);

  // fine grain, strongest in midtones
  vec2 g = floor(vUv * uRes / max(uScale, 1.0));
  l += (hash(g + fract(uTime * 11.0) * 71.0) - 0.5) * 0.05 * (0.4 + l * (1.0 - l) * 2.4);

  vec2 q = vUv - 0.5;
  l *= 1.0 - dot(q, q) * 0.35;
  gl_FragColor = vec4(vec3(clamp(l, 0.0, 1.0)), 1.0);
}`,
  },
  {
    id: 'vintage',
    name: 'Vintage',
    image: 'assets/filters/vintage.jpg',
    // Disposable-camera print: faded, low-contrast grade with a soft sepia undertone,
    // lifted blacks, rolled-off highlights, fine grain and a faint vignette.
    // Pure grade (no colour transfer); sepia is held back on skin so faces stay natural.
    shader: `
void main() {
  vec2 px = uScale / uRes;

  // slightly soft consumer lens
  vec3 c = tex(vUv);
  vec3 b = (tex(vUv + vec2(px.x, 0.0)) + tex(vUv - vec2(px.x, 0.0))
          + tex(vUv + vec2(0.0, px.y)) + tex(vUv - vec2(0.0, px.y))) * 0.25;
  c = mix(c, b, 0.35);

  vec3 lab = rgb2lab(c);

  // mild auto-exposure toward a mid-key scene
  lab.x += clamp((52.0 - uSrcMean.x) * 0.1, -3.0, 4.0);

  // skin mask: warm hues with moderate chroma
  float hue = atan(lab.z, lab.y);
  float chroma = length(lab.yz);
  float skin = smoothstep(0.25, 0.5, hue) * (1.0 - smoothstep(1.05, 1.3, hue))
             * smoothstep(6.0, 12.0, chroma) * (1.0 - smoothstep(40.0, 55.0, chroma));

  // faded colour: pull chroma down (less on skin so faces don't go grey)
  lab.yz *= 0.72 + 0.1 * skin;
  // warm sepia-brown undertone, lighter on skin to avoid orange faces
  float warm = 1.0 - skin * 0.55;
  lab.z += 5.0 * warm;
  lab.y += 1.5 * warm;

  c = clamp(lab2rgb(lab), 0.0, 1.0);

  // reduced contrast, soft highlight shoulder
  c = mix(vec3(0.48), c, 0.86);
  c -= 0.1 * c * c * (1.0 - c);
  // lifted brown blacks, warm faded whites
  c = mix(vec3(0.075, 0.058, 0.048), vec3(0.955, 0.925, 0.86), c);

  // subtle sepia blend in the shadows and mids
  float l = luma(c);
  vec3 sepia = vec3(l * 1.07 + 0.02, l * 0.96 + 0.01, l * 0.8);
  c = mix(c, sepia, 0.14 * (1.0 - skin * 0.6) * (1.0 - smoothstep(0.6, 1.0, l)));

  // fine film grain, strongest in midtones
  vec2 g = floor(vUv * uRes / max(uScale, 1.0));
  c += (hash(g + fract(uTime * 11.0) * 71.0) - 0.5) * 0.04 * (0.5 + l * (1.0 - l) * 2.0);

  // very light vignette
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * 0.3;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
  },
  {
    id: 'portrait',
    name: 'Studio Portrait',
    image: 'assets/filters/portrait.jpg',
    // Soft studio monochrome: red-weighted mix for luminous skin, gentle contrast,
    // matte blacks, a faint diffusion glow in the highlights and a dark-edged falloff.
    shader: `
void main() {
  vec2 px = uScale / uRes;
  vec3 c = tex(vUv);
  vec3 b = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785;
    b += tex(vUv + vec2(cos(a), sin(a)) * px * 5.0);
  }
  b /= 8.0;

  vec3 w = vec3(0.5, 0.4, 0.1);
  float l = dot(c, w);
  float lb = dot(b, w);

  // auto-level toward a bright mid-key (gamma, so whites never clip)
  l = pow(clamp(l, 0.0, 1.0), clamp(uSrcMean.x / 55.0, 0.75, 1.25));
  lb = pow(clamp(lb, 0.0, 1.0), clamp(uSrcMean.x / 55.0, 0.75, 1.25));

  // soft diffusion: highlights bleed gently into their surroundings
  l = mix(l, max(l, lb), 0.3 * smoothstep(0.45, 0.85, lb));

  // gentle contrast, lifted matte blacks, rolled-off whites
  l = mix(l, l * l * (3.0 - 2.0 * l), 0.35);
  l += 0.06 * l * (1.0 - l);
  l = mix(0.06, 0.94, l);

  // very fine grain
  vec2 g = floor(vUv * uRes / max(uScale, 1.0));
  l += (hash(g + fract(uTime * 11.0) * 71.0) - 0.5) * 0.025;

  // studio falloff: edges drop into shadow
  vec2 q = vUv - 0.5;
  l *= 1.0 - smoothstep(0.12, 0.5, dot(q, q)) * 0.4;

  // faintly cool neutral tone
  gl_FragColor = vec4(clamp(vec3(l) * vec3(0.985, 1.0, 1.02), 0.0, 1.0), 1.0);
}`,
  },
  {
    id: 'editorial',
    name: 'Editorial',
    image: 'assets/filters/editorial.jpg',
    // Clean beauty-magazine look: bright high-key exposure, porcelain skin with gentle
    // edge-aware smoothing, soft peach-pink skin tones, creamy warm-neutral whites,
    // low contrast with rich (not crushed) blacks and slightly muted colour.
    shader: `
void main() {
  vec2 px = uScale / uRes;
  vec3 c = tex(vUv);

  // edge-aware smoothing (bilateral): averages only similar neighbours, so
  // skin softens while eyes, brows and hair stay sharp
  vec3 sum = c;
  float wsum = 1.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5236;
    vec2 d = vec2(cos(a), sin(a));
    vec3 s1 = tex(vUv + d * px * 3.0);
    vec3 s2 = tex(vUv + d * px * 6.5);
    float w1 = exp(-dot(s1 - c, s1 - c) * 180.0);
    float w2 = exp(-dot(s2 - c, s2 - c) * 180.0) * 0.7;
    sum += s1 * w1 + s2 * w2;
    wsum += w1 + w2;
  }
  vec3 smooth_ = sum / wsum;

  vec3 lab = rgb2lab(c);
  float hue = atan(lab.z, lab.y);
  float chroma = length(lab.yz);
  float skin = smoothstep(0.2, 0.5, hue) * (1.0 - smoothstep(1.1, 1.35, hue))
             * smoothstep(5.0, 10.0, chroma) * (1.0 - smoothstep(38.0, 52.0, chroma));

  c = mix(c, smooth_, 0.35 + 0.4 * skin);
  lab = rgb2lab(c);

  // high-key exposure with auto-levelling toward a bright scene
  lab.x += 4.0 + clamp((60.0 - uSrcMean.x) * 0.15, -3.0, 7.0);

  // neutralise part of the scene's colour cast, then settle on a soft warm-neutral
  lab.yz -= clamp(uSrcMean.yz, vec2(-12.0), vec2(12.0)) * 0.4;
  lab.z += 2.0;

  // muted colour overall; skin keeps a gentle peach-pink (a bit more red, less yellow)
  lab.yz *= 0.85 + 0.1 * skin;
  lab.y += 2.5 * skin;
  lab.z -= 2.0 * skin;
  // extra luminance on skin for a porcelain glow
  lab.x += 3.0 * skin;

  c = clamp(lab2rgb(lab), 0.0, 1.0);

  // low contrast, soft highlight shoulder, clean deep blacks
  c = mix(vec3(0.5), c, 0.9);
  c -= 0.1 * c * c * (1.0 - c);
  c = mix(vec3(0.03, 0.028, 0.027), vec3(0.985, 0.975, 0.955), c);

  // soft glow in the highlights
  float hl = smoothstep(0.6, 1.0, luma(smooth_));
  c = screen(c, vec3(1.0, 0.97, 0.94) * hl * 0.08);

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
  },
  {
    id: 'airy',
    name: 'High-Key B&W',
    image: 'assets/filters/airy.jpg',
    // Bright fashion monochrome: red-weighted mix for luminous skin, lifted exposure,
    // low contrast with soft greys, clean airy whites, a gentle highlight bloom and
    // a faint lightening toward the edges instead of a dark vignette.
    shader: `
void main() {
  vec2 px = uScale / uRes;
  vec3 w = vec3(0.45, 0.43, 0.12);
  float l = dot(tex(vUv), w);
  float b = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785;
    b += dot(tex(vUv + vec2(cos(a), sin(a)) * px * 6.0), w);
  }
  b /= 8.0;

  // auto-exposure toward a bright high-key scene (gamma, so whites never clip)
  float gm = clamp(uSrcMean.x / 68.0, 0.55, 1.0);
  l = pow(clamp(l, 0.0, 1.0), gm);
  b = pow(clamp(b, 0.0, 1.0), gm);

  // soft bloom: bright areas glow into their surroundings
  l = mix(l, max(l, b), 0.35 * smoothstep(0.5, 0.9, b));

  // low contrast: open shadows, soft grey mids, rolled-off whites
  l += 0.12 * l * (1.0 - l) * (1.0 - l);
  l -= 0.08 * l * l * (1.0 - l);
  l = mix(0.1, 0.975, l);

  // very fine grain
  vec2 g = floor(vUv * uRes / max(uScale, 1.0));
  l += (hash(g + fract(uTime * 11.0) * 71.0) - 0.5) * 0.02;

  // airy edges: faint lift instead of darkening
  vec2 q = vUv - 0.5;
  l = mix(l, 1.0, smoothstep(0.1, 0.5, dot(q, q)) * 0.12);

  // faintly warm paper white
  gl_FragColor = vec4(clamp(vec3(l) * vec3(1.0, 0.995, 0.985), 0.0, 1.0), 1.0);
}`,
  },
  {
    id: 'goldenhaze',
    name: 'Golden Hour Nostalgia',
    image: 'assets/filters/goldenhaze.jpg',
    sharpen: 0.15, // soft vintage lens: barely any post-sharpening
    // Vintage diffusion lens + warm faded film. Colour/tone only: bloom and halation are
    // extracted from light already in the frame, no added flares, rays or leaks.
    shader: `
vec3 ring(vec2 uv, float r) {
  vec2 px = r * uScale / uRes;
  vec3 s = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    float a = float(i) * 0.6283 + r;
    s += tex(uv + vec2(cos(a), sin(a)) * px);
  }
  return s / 10.0;
}

void main() {
  vec2 uv = vUv;
  vec3 orig = tex(uv);
  vec3 near = ring(uv, 2.5);
  vec3 mid = ring(uv, 7.0);
  vec3 far = (ring(uv, 15.0) + ring(uv, 26.0)) * 0.5;

  // 1. dreamy soft focus: edges stay recognisable, fine detail goes hazy
  vec3 c = mix(orig, near, 0.5);

  // 2. exposure + adaptive white balance, then golden-hour temperature/tint
  vec3 lab = rgb2lab(c);
  lab.yz -= clamp(uSrcMean.yz, vec2(-12.0), vec2(12.0)) * 0.4;
  lab.x += 3.5 + clamp((52.0 - uSrcMean.x) * 0.12, -3.0, 5.0);

  float hue = atan(lab.z, lab.y);
  float chroma = length(lab.yz);
  float skin = smoothstep(0.25, 0.5, hue) * (1.0 - smoothstep(1.05, 1.3, hue))
             * smoothstep(6.0, 12.0, chroma) * (1.0 - smoothstep(40.0, 55.0, chroma));
  lab.z += 11.0 * (1.0 - skin * 0.55);          // temperature ~+16, skin held back from orange
  lab.y += 2.0 * (1.0 - skin * 0.5);            // tint ~+3

  float green = smoothstep(-4.0, -12.0, lab.y) * step(0.0, lab.z);
  lab.y *= 1.0 - 0.3 * green;                   // foliage -> olive
  lab.z += 3.0 * green;
  lab.z *= 1.0 - 0.35 * smoothstep(-6.0, -18.0, lab.z); // no strong blues
  c = clamp(lab2rgb(lab), 0.0, 1.0);

  // 3. faded film tone curve: contrast -20, shadows +15, highlights -15,
  //    blacks lifted to a brown matte, whites pulled down warm
  c = mix(vec3(0.46), c, 0.8);
  c += 0.18 * c * (1.0 - c) * (1.0 - c);
  c -= 0.13 * c * c * (1.0 - c);
  c = mix(vec3(0.075, 0.06, 0.04), vec3(0.95, 0.925, 0.86), c);

  // 4. saturation -12
  c = clamp(sat(c, 0.86), 0.0, 1.0);

  // 5. warm yellow/amber highlights, soft brown-olive shadows
  float l = luma(c);
  c = mix(c, c * vec3(1.05, 1.0, 0.8), smoothstep(0.5, 1.0, l) * 0.6 * (1.0 - skin * 0.4));
  c += vec3(0.012, 0.01, -0.004) * (1.0 - smoothstep(0.0, 0.45, l));

  // 6. bloom from the scene's own bright areas, spreading warm into the surroundings
  float bm = smoothstep(0.5, 0.95, luma(mid));
  float bf = smoothstep(0.45, 0.95, luma(far));
  vec3 bloom = (mid * bm * 0.55 + far * bf * 0.6) * vec3(1.0, 0.86, 0.62);
  c = screen(c, bloom * 0.5);

  // 7. very subtle halation: warm fringe just outside bright, high-contrast edges
  float halo = smoothstep(0.6, 0.95, luma(mid)) * smoothstep(0.02, 0.25, luma(mid) - luma(orig));
  c = screen(c, vec3(1.0, 0.5, 0.25) * halo * 0.18);

  // 8. warm atmospheric veil, a touch denser where the light is
  c = mix(c, vec3(0.92, 0.84, 0.68), 0.05 + 0.06 * luma(far));

  // 9. fine organic grain (~4.5%): two scales, varied per frame
  vec2 g = vUv * uRes / max(uScale, 1.0);
  float t = fract(uTime * 11.0) * 71.0;
  float n = hash(floor(g) + t) * 0.65 + hash(floor(g * 0.5) + t * 1.3) * 0.35;
  l = luma(c);
  c += (n - 0.5) * 0.045 * (0.45 + l * (1.0 - l) * 2.2);

  // 10. near-imperceptible warm vignette (~5%)
  vec2 q = vUv - 0.5;
  float v = dot(q, q);
  c *= 1.0 - v * 0.1;
  c = mix(c, c * vec3(1.02, 0.97, 0.88), v * 0.4);

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
  },
  {
    id: 'eveningfilm',
    name: 'Late Evening Film',
    image: 'assets/filters/eveningfilm.jpg',
    sharpen: 0.5, // analog softness, detail still intact
    // Late-sun cinematic film grade. Warmth is driven by luminance: amber-gold highlights,
    // warm lifted mids, deep neutral-brown shadows. Glow comes only from light already
    // in the frame (no overlays, leaks or flares).
    shader: `
vec3 ring(vec2 uv, float r) {
  vec2 px = r * uScale / uRes;
  vec3 s = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    float a = float(i) * 0.6283 + r;
    s += tex(uv + vec2(cos(a), sin(a)) * px);
  }
  return s / 10.0;
}

void main() {
  vec2 uv = vUv;
  vec3 orig = tex(uv);
  vec3 near = ring(uv, 1.5);
  vec3 mid = ring(uv, 8.0);
  vec3 far = (ring(uv, 18.0) + ring(uv, 32.0)) * 0.5;

  // 1. slight analog lens softness (no clean digital edge)
  vec3 c = mix(orig, near, 0.25);

  // 2. exposure + adaptive white balance so any scene starts from neutral
  vec3 lab = rgb2lab(c);
  lab.yz -= clamp(uSrcMean.yz, vec2(-12.0), vec2(12.0)) * 0.45;
  lab.x += clamp((50.0 - uSrcMean.x) * 0.12, -3.0, 4.0);

  float L = clamp(lab.x / 100.0, 0.0, 1.0);
  float hue = atan(lab.z, lab.y);
  float chroma = length(lab.yz);
  float skin = smoothstep(0.25, 0.5, hue) * (1.0 - smoothstep(1.05, 1.3, hue))
             * smoothstep(6.0, 12.0, chroma) * (1.0 - smoothstep(40.0, 55.0, chroma));

  // 3. overall saturation down, warm hues (red -> yellow) kept rich
  float warmHue = smoothstep(-0.35, 0.1, hue) * (1.0 - smoothstep(1.35, 1.7, hue));
  lab.yz *= mix(0.72, 1.02, warmHue);

  // greens -> dry olive/amber, blues -> muted slate (the sky should glow, not be blue)
  float green = smoothstep(-4.0, -14.0, lab.y);
  lab.y *= 1.0 - 0.45 * green;
  lab.z += 2.5 * green * smoothstep(-5.0, 5.0, lab.z);
  float blue = smoothstep(-4.0, -16.0, lab.z);
  lab.z *= 1.0 - 0.55 * blue;
  lab.y *= 1.0 - 0.3 * blue;

  // 4. warmth rides the light: strongest in highlights and mids, fades out in shadows
  float wHi = smoothstep(0.2, 0.85, L);
  float wMid = exp(-pow((L - 0.5) / 0.22, 2.0));
  float warmK = 1.0 - skin * 0.7;               // skin gets glow, not orange
  lab.z += (5.0 + 17.0 * wHi) * wHi * warmK;    // golden
  lab.y += (1.5 + 5.5 * wHi) * wHi * warmK;     // amber/red bias toward the brightest light
  lab.z += 3.0 * wMid * warmK;
  // skin: soft warm glow via luminance, a whisper of peach
  lab.x += 2.5 * skin * wMid;
  lab.yz *= 1.0 - 0.1 * skin;

  // shadows: pull chroma out, then add a faint brown-red so they stay moody not orange
  float sh = 1.0 - smoothstep(0.05, 0.4, L);
  lab.yz *= 1.0 - 0.45 * sh;
  float shTint = sh * smoothstep(0.0, 0.08, L);  // pure black stays black
  lab.y += 2.2 * shTint;
  lab.z += 1.6 * shTint;

  c = clamp(lab2rgb(lab), 0.0, 1.0);

  // 5. tone: deep rich blacks, gentle contrast, lifted warm mids, soft highlight knee
  c = pow(c, vec3(1.1));                         // sink the shadows
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.3);      // cinematic contrast
  c += 0.1 * c * (1.0 - c) * (1.0 - c) * mix(vec3(1.08, 1.0, 0.8), vec3(1.0), skin * 0.7); // nostalgic warm mid lift
  vec3 x = max(c - 0.7, 0.0);
  c = min(c, 0.7) + x / (1.0 + x * 0.37);        // highlight roll-off: bright light never clips hard
  c = mix(vec3(0.012, 0.008, 0.006), mix(vec3(0.99, 0.945, 0.83), vec3(0.985, 0.96, 0.92), skin * 0.7), c);

  // 6. separation: glowing amber highlights, neutral-brown shadows
  float l = luma(c);
  c = mix(c, c * vec3(1.08, 0.95, 0.7), smoothstep(0.35, 0.8, l) * (1.0 - 0.45 * smoothstep(0.85, 1.0, l)) * 0.6 * (1.0 - skin * 0.7));
  c = mix(c, vec3(l) * vec3(1.05, 0.97, 0.9), (1.0 - smoothstep(0.0, 0.3, l)) * 0.35);

  // 7. bloom: the scene's own bright light diffuses outward, golden-amber
  float bm = smoothstep(0.62, 0.97, luma(mid));
  float bf = smoothstep(0.58, 0.97, luma(far));
  vec3 bloom = (mid * bm * 0.45 + far * bf * 0.6) * vec3(1.0, 0.66, 0.32);
  c = screen(c, bloom * 0.38);

  // 8. halation: a faint red-orange fringe just outside bright edges
  float halo = smoothstep(0.62, 0.95, luma(mid)) * smoothstep(0.03, 0.25, luma(mid) - luma(orig));
  c = screen(c, vec3(1.0, 0.38, 0.14) * halo * 0.2);

  // 9. atmospheric haze where the light is, keeps it dreamy without lifting blacks
  c = mix(c, vec3(0.96, 0.74, 0.5), 0.05 * smoothstep(0.45, 0.95, luma(far)));

  // 10. analog grain (~3.5%): two scales, strongest in mids, per-frame
  vec2 g = vUv * uRes / max(uScale, 1.0);
  float t = fract(uTime * 11.0) * 71.0;
  float n = hash(floor(g) + t) * 0.6 + hash(floor(g * 0.5) + t * 1.7) * 0.4;
  l = luma(c);
  c += (n - 0.5) * 0.035 * (0.35 + l * (1.0 - l) * 2.4);

  // 11. very subtle vignette with a warm-brown falloff
  vec2 q = vUv - 0.5;
  float v = dot(q, q);
  c *= 1.0 - smoothstep(0.08, 0.5, v) * 0.22;
  c = mix(c, c * vec3(1.0, 0.94, 0.86), v * 0.35);

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
  },
];

/* Index of the filter selected on launch (the one inside the ring in the design) */
const DEFAULT_FILTER = 0;
