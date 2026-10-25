/*
 * Instagram's classic feed filters, appended to FILTERS.
 *
 * Instagram's own looks are proprietary LUTs; these are recreations. Most follow
 * CSSgram's breakdown: overlay layers blended onto the frame (::before, then ::after),
 * then a chain of CSS filters applied to the composite. The rest (Juno, Crema, Ludwig,
 * Hefe, Sierra, Sutro, Vesper, Ginza, Skyline, Dogpatch, Helena, Ashby, Charmes) are
 * hand-tuned to match the published look. Pure grades: no colour transfer, no
 * reference image; their carousel thumbnails are rendered from the live camera.
 */

const IG_PRELUDE = `
vec3 rgb(float r, float g, float b) { return vec3(r, g, b) / 255.0; }

/* CSS filter functions (each clamps, like the browser does between filters) */
vec3 brightness(vec3 c, float k) { return clamp(c * k, 0.0, 1.0); }
vec3 contrast(vec3 c, float k) { return clamp((c - 0.5) * k + 0.5, 0.0, 1.0); }
vec3 saturation(vec3 c, float k) { return clamp(mix(vec3(dot(c, vec3(0.213, 0.715, 0.072))), c, k), 0.0, 1.0); }
vec3 grayscale(vec3 c, float k) { return mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), k); }
vec3 sepia(vec3 c, float k) {
  vec3 s = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
  return clamp(mix(c, s, k), 0.0, 1.0);
}
vec3 hueRotate(vec3 c, float deg) {
  float a = radians(deg), co = cos(a), si = sin(a);
  mat3 m = mat3(
    0.213 + co * 0.787 - si * 0.213, 0.213 - co * 0.213 + si * 0.143, 0.213 - co * 0.213 - si * 0.787,
    0.715 - co * 0.715 - si * 0.715, 0.715 + co * 0.285 + si * 0.140, 0.715 - co * 0.715 + si * 0.715,
    0.072 - co * 0.072 + si * 0.928, 0.072 - co * 0.072 - si * 0.283, 0.072 + co * 0.928 + si * 0.072);
  return clamp(m * c, 0.0, 1.0);
}

/* Blend modes (W3C compositing spec): b = backdrop, s = layer */
vec3 multiply(vec3 b, vec3 s) { return b * s; }
vec3 lighten(vec3 b, vec3 s) { return max(b, s); }
vec3 darken(vec3 b, vec3 s) { return min(b, s); }
vec3 exclusion(vec3 b, vec3 s) { return b + s - 2.0 * b * s; }
vec3 overlay(vec3 b, vec3 s) { return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b)); }
vec3 softLight(vec3 b, vec3 s) {
  vec3 d = mix(((16.0 * b - 12.0) * b + 4.0) * b, sqrt(b), step(0.25, b));
  return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (d - b), step(0.5, s));
}
vec3 colorDodge(vec3 b, vec3 s) { return mix(min(vec3(1.0), b / max(1.0 - s, 0.0001)), vec3(1.0), step(1.0, s)) * step(0.0001, b); }
vec3 colorBurn(vec3 b, vec3 s) { return mix(1.0 - min(vec3(1.0), (1.0 - b) / max(s, 0.0001)), vec3(1.0), step(0.9999, b)); }

/* Non-separable modes: hue and color */
float lum3(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum3(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 0.0001);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 0.0001);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum3(c))); }
vec3 setSat(vec3 c, float s) {
  float n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  return x > n ? (c - n) * s / (x - n) : vec3(0.0);
}
vec3 blendHue(vec3 b, vec3 s) { return setLum(setSat(s, max(max(b.r, b.g), b.b) - min(min(b.r, b.g), b.b)), lum3(b)); }
vec3 blendColor(vec3 b, vec3 s) { return setLum(s, lum3(b)); }

/* CSS radial-gradient(circle at center): 0 at center, 1 at the farthest corner */
float radial(vec2 center) {
  return length((vUv - center) * uRes) / length(max(center, 1.0 - center) * uRes);
}
/* position of d between two gradient stops */
float stops(float d, float a, float b) { return clamp((d - a) / (b - a), 0.0, 1.0); }

vec3 vignette(vec3 c, float from, float to, float amt) { return c * (1.0 - stops(radial(vec2(0.5)), from, to) * amt); }
`;

const IG_FILTERS = [
  ['normal', 'Normal', `
void main() {
  gl_FragColor = vec4(tex(vUv), 1.0);
}`],
  ['clarendon', 'Clarendon', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, overlay(c, rgb(127.0, 187.0, 227.0)), 0.2);
  c = contrast(c, 1.2);
  c = saturation(c, 1.35);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['gingham', 'Gingham', `
void main() {
  vec3 c = tex(vUv);
  c = softLight(c, rgb(230.0, 230.0, 250.0));
  c = brightness(c, 1.05);
  c = hueRotate(c, -10.0);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['moon', 'Moon', `
void main() {
  vec3 c = tex(vUv);
  c = softLight(c, rgb(160.0, 160.0, 160.0));
  c = lighten(c, rgb(56.0, 56.0, 56.0));
  c = grayscale(c, 1.0);
  c = contrast(c, 1.1);
  c = brightness(c, 1.1);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['lark', 'Lark', `
void main() {
  vec3 c = tex(vUv);
  c = colorDodge(c, rgb(34.0, 37.0, 63.0));
  c = mix(c, darken(c, rgb(242.0, 242.0, 242.0)), 0.8);
  c = contrast(c, 0.9);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['reyes', 'Reyes', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, softLight(c, rgb(239.0, 205.0, 173.0)), 0.5);
  c = sepia(c, 0.22);
  c = brightness(c, 1.1);
  c = contrast(c, 0.85);
  c = saturation(c, 0.75);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['juno', 'Juno', `
void main() {
  vec3 c = tex(vUv);
  // reds and yellows pop, cool tones lean slightly green, whites glow
  float warm = smoothstep(0.04, 0.3, c.r - c.b);
  c = contrast(c, 1.12);
  c = saturation(c, 1.12 + 0.35 * warm);
  c = mix(c, softLight(c, rgb(60.0, 150.0, 130.0)), 0.18 * (1.0 - warm));
  c = screen(c, rgb(255.0, 248.0, 230.0) * smoothstep(0.7, 1.0, luma(c)) * 0.15);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`],
  ['slumber', 'Slumber', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, lighten(c, rgb(69.0, 41.0, 12.0)), 0.4);
  c = mix(c, softLight(c, rgb(125.0, 105.0, 24.0)), 0.5);
  c = saturation(c, 0.66);
  c = brightness(c, 1.05);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['crema', 'Crema', `
void main() {
  vec3 c = tex(vUv);
  // creamy, desaturated, matte
  c = mix(c, softLight(c, rgb(250.0, 230.0, 200.0)), 0.35);
  c = saturation(c, 0.78);
  c = contrast(c, 0.9);
  c = mix(rgb(22.0, 18.0, 18.0), rgb(248.0, 243.0, 235.0), c);
  c = brightness(c, 1.03);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['ludwig', 'Ludwig', `
void main() {
  vec3 c = tex(vUv);
  // muted colour except reds, a little extra light
  float red = smoothstep(0.08, 0.3, c.r - max(c.g, c.b));
  c = saturation(c, 0.72 + 0.45 * red);
  c = contrast(c, 1.05);
  c = brightness(c, 1.06);
  c = mix(c, c * vec3(1.03, 1.0, 0.96), smoothstep(0.5, 1.0, luma(c)));
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`],
  ['aden', 'Aden', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, darken(c, rgb(66.0, 10.0, 14.0)), 0.2 * (1.0 - vUv.x));
  c = hueRotate(c, -20.0);
  c = contrast(c, 0.9);
  c = saturation(c, 0.85);
  c = brightness(c, 1.2);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['perpetua', 'Perpetua', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, softLight(c, mix(rgb(0.0, 91.0, 154.0), rgb(230.0, 193.0, 61.0), vUv.y)), 0.5);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['amaro', 'Amaro', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, overlay(c, rgb(125.0, 105.0, 24.0)), 0.2);
  c = hueRotate(c, -10.0);
  c = contrast(c, 0.9);
  c = brightness(c, 1.1);
  c = saturation(c, 1.5);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['mayfair', 'Mayfair', `
void main() {
  vec3 c = tex(vUv);
  float d = radial(vec2(0.4));
  vec3 g = mix(mix(vec3(1.0), rgb(255.0, 200.0, 200.0), stops(d, 0.0, 0.3)), rgb(17.0, 17.0, 17.0), stops(d, 0.3, 0.6));
  float a = mix(mix(0.8, 0.6, stops(d, 0.0, 0.3)), 1.0, stops(d, 0.3, 0.6));
  c = mix(c, overlay(c, g), a * 0.4);
  c = contrast(c, 1.1);
  c = saturation(c, 1.1);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['rise', 'Rise', `
void main() {
  vec3 c = tex(vUv);
  float d = radial(vec2(0.5));
  float t = stops(d, 0.55, 1.0);
  c = mix(c, multiply(c, mix(rgb(236.0, 205.0, 169.0), rgb(50.0, 30.0, 7.0), t)), mix(0.15, 0.4, t));
  c = mix(c, overlay(c, rgb(232.0, 197.0, 152.0)), 0.8 * (1.0 - stops(d, 0.0, 0.9)) * 0.6);
  c = brightness(c, 1.05);
  c = sepia(c, 0.2);
  c = contrast(c, 0.9);
  c = saturation(c, 0.9);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['hudson', 'Hudson', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, multiply(c, mix(rgb(166.0, 177.0, 255.0), rgb(52.0, 33.0, 52.0), stops(radial(vec2(0.5)), 0.5, 1.0))), 0.5);
  c = brightness(c, 1.2);
  c = contrast(c, 0.9);
  c = saturation(c, 1.1);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['valencia', 'Valencia', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, exclusion(c, rgb(58.0, 3.0, 57.0)), 0.5);
  c = contrast(c, 1.08);
  c = brightness(c, 1.08);
  c = sepia(c, 0.08);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['xpro2', 'X-Pro II', `
void main() {
  vec3 c = tex(vUv);
  float t = stops(radial(vec2(0.5)), 0.4, 1.1);
  c = mix(c, colorBurn(c, mix(rgb(230.0, 231.0, 224.0), rgb(43.0, 42.0, 161.0), t)), mix(1.0, 0.6, t));
  c = sepia(c, 0.3);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['sierra', 'Sierra', `
void main() {
  vec3 c = tex(vUv);
  // faded, soft and warm with a gentle edge falloff
  c = mix(c, softLight(c, rgb(240.0, 200.0, 150.0)), 0.3);
  c = mix(c, multiply(c, rgb(60.0, 40.0, 30.0)), 0.35 * stops(radial(vec2(0.5)), 0.6, 1.2));
  c = contrast(c, 0.8);
  c = saturation(c, 0.85);
  c = mix(rgb(30.0, 24.0, 22.0), vec3(1.0), c);
  c = brightness(c, 1.05);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['willow', 'Willow', `
void main() {
  vec3 c = tex(vUv);
  float t = stops(radial(vec2(0.5)), 0.55, 1.5);
  c = overlay(c, mix(rgb(212.0, 169.0, 175.0), vec3(0.0), t));
  c = blendColor(c, rgb(216.0, 205.0, 203.0));
  c = grayscale(c, 0.5);
  c = contrast(c, 0.95);
  c = brightness(c, 0.9);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`],
  ['lofi', 'Lo-Fi', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, multiply(c, rgb(34.0, 34.0, 34.0)), stops(radial(vec2(0.5)), 0.7, 1.5));
  c = saturation(c, 1.1);
  c = contrast(c, 1.5);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['inkwell', 'Inkwell', `
void main() {
  vec3 c = tex(vUv);
  c = sepia(c, 0.3);
  c = contrast(c, 1.1);
  c = brightness(c, 1.1);
  c = grayscale(c, 1.0);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['hefe', 'Hefe', `
void main() {
  vec3 c = tex(vUv);
  // punchy and warm, gold cast, dark edges
  c = mix(c, softLight(c, rgb(225.0, 150.0, 60.0)), 0.3);
  c = contrast(c, 1.3);
  c = saturation(c, 1.3);
  c = vignette(c, 0.5, 1.3, 0.55);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['nashville', 'Nashville', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, darken(c, rgb(247.0, 176.0, 153.0)), 0.56);
  c = mix(c, lighten(c, rgb(0.0, 70.0, 150.0)), 0.4);
  c = sepia(c, 0.2);
  c = contrast(c, 1.2);
  c = brightness(c, 1.05);
  c = saturation(c, 1.2);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['stinson', 'Stinson', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, softLight(c, rgb(240.0, 149.0, 128.0)), 0.2);
  c = contrast(c, 0.75);
  c = saturation(c, 0.85);
  c = brightness(c, 1.15);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['vesper', 'Vesper', `
void main() {
  vec3 c = tex(vUv);
  // soft peach-yellow tint, slightly faded
  c = mix(c, softLight(c, rgb(255.0, 220.0, 170.0)), 0.45);
  c = contrast(c, 0.9);
  c = saturation(c, 0.9);
  c = mix(rgb(18.0, 14.0, 10.0), vec3(1.0), c);
  c = brightness(c, 1.08);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['earlybird', 'Earlybird', `
void main() {
  vec3 c = tex(vUv);
  float d = radial(vec2(0.5));
  vec3 g = mix(mix(rgb(208.0, 186.0, 142.0), rgb(54.0, 3.0, 9.0), stops(d, 0.2, 0.85)), rgb(29.0, 2.0, 16.0), stops(d, 0.85, 1.0));
  c = overlay(c, g);
  c = contrast(c, 0.9);
  c = sepia(c, 0.2);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['brannan', 'Brannan', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, lighten(c, rgb(161.0, 44.0, 199.0)), 0.31);
  c = sepia(c, 0.5);
  c = contrast(c, 1.4);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['sutro', 'Sutro', `
void main() {
  vec3 c = tex(vUv);
  // muted purple-brown, burned edges
  c = mix(c, multiply(c, rgb(150.0, 110.0, 130.0)), 0.35);
  c = saturation(c, 0.6);
  c = contrast(c, 1.15);
  c = brightness(c, 0.92);
  c = vignette(c, 0.35, 1.1, 0.75);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['toaster', 'Toaster', `
void main() {
  vec3 c = tex(vUv);
  c = screen(c, mix(rgb(128.0, 78.0, 15.0), rgb(59.0, 0.0, 59.0), radial(vec2(0.5))));
  c = contrast(c, 1.5);
  c = brightness(c, 0.9);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['walden', 'Walden', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, screen(c, rgb(0.0, 68.0, 204.0)), 0.3);
  c = brightness(c, 1.1);
  c = hueRotate(c, -10.0);
  c = sepia(c, 0.3);
  c = saturation(c, 1.6);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['1977', '1977', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, screen(c, rgb(243.0, 106.0, 188.0)), 0.3);
  c = contrast(c, 1.1);
  c = brightness(c, 1.1);
  c = saturation(c, 1.3);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['kelvin', 'Kelvin', `
void main() {
  vec3 c = tex(vUv);
  c = colorDodge(c, rgb(56.0, 44.0, 52.0));
  c = overlay(c, rgb(183.0, 125.0, 33.0));
  gl_FragColor = vec4(c, 1.0);
}`],
  ['maven', 'Maven', `
void main() {
  vec3 c = tex(vUv);
  c = mix(c, clamp(blendHue(c, rgb(3.0, 230.0, 26.0)), 0.0, 1.0), 0.2);
  c = sepia(c, 0.25);
  c = brightness(c, 0.95);
  c = contrast(c, 0.95);
  c = saturation(c, 1.5);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['ginza', 'Ginza', `
void main() {
  vec3 c = tex(vUv);
  // bright and warm with a slight vintage fade
  c = mix(c, softLight(c, rgb(255.0, 200.0, 140.0)), 0.3);
  c = contrast(c, 0.9);
  c = saturation(c, 1.05);
  c = mix(rgb(16.0, 12.0, 12.0), vec3(1.0), c);
  c = brightness(c, 1.1);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['skyline', 'Skyline', `
void main() {
  vec3 c = tex(vUv);
  // bright, saturated, crisp blues
  c = mix(c, softLight(c, rgb(160.0, 200.0, 255.0)), 0.2);
  c = contrast(c, 1.05);
  c = saturation(c, 1.3);
  c = brightness(c, 1.12);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['dogpatch', 'Dogpatch', `
void main() {
  vec3 c = tex(vUv);
  // hard contrast, washed-out highlights, cool and muted
  c = mix(c, softLight(c, rgb(140.0, 170.0, 200.0)), 0.25);
  c = contrast(c, 1.4);
  c = saturation(c, 0.75);
  c = brightness(c, 1.05);
  c = mix(c, vec3(0.93), smoothstep(0.75, 1.0, luma(c)) * 0.5);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['brooklyn', 'Brooklyn', `
void main() {
  vec3 c = tex(vUv);
  float t = stops(radial(vec2(0.5)), 0.7, 1.0);
  c = mix(c, overlay(c, mix(rgb(168.0, 223.0, 193.0), rgb(183.0, 196.0, 201.0), t)), mix(0.4, 1.0, t));
  c = contrast(c, 0.9);
  c = brightness(c, 1.1);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['helena', 'Helena', `
void main() {
  vec3 c = tex(vUv);
  // orange-peach highlights against teal shadows
  float l = luma(c);
  c = mix(c, softLight(c, rgb(40.0, 130.0, 140.0)), 0.35 * (1.0 - smoothstep(0.2, 0.6, l)));
  c = mix(c, softLight(c, rgb(255.0, 170.0, 120.0)), 0.35 * smoothstep(0.35, 0.9, l));
  c = contrast(c, 1.1);
  c = saturation(c, 1.1);
  c = brightness(c, 1.03);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['ashby', 'Ashby', `
void main() {
  vec3 c = tex(vUv);
  // toned-down golden vintage
  c = mix(c, softLight(c, rgb(230.0, 180.0, 90.0)), 0.35);
  c = sepia(c, 0.2);
  c = contrast(c, 1.05);
  c = saturation(c, 0.9);
  c = brightness(c, 1.05);
  gl_FragColor = vec4(c, 1.0);
}`],
  ['charmes', 'Charmes', `
void main() {
  vec3 c = tex(vUv);
  // warm red cast, high contrast, cool shadows
  c = mix(c, softLight(c, rgb(230.0, 110.0, 80.0)), 0.3);
  c = mix(c, softLight(c, rgb(60.0, 110.0, 130.0)), 0.25 * (1.0 - smoothstep(0.1, 0.5, luma(c))));
  c = contrast(c, 1.2);
  c = saturation(c, 1.25);
  gl_FragColor = vec4(c, 1.0);
}`],
];

FILTERS.push(...IG_FILTERS.map(([id, name, shader]) => ({ id: `ig-${id}`, name, shader: IG_PRELUDE + shader })));
