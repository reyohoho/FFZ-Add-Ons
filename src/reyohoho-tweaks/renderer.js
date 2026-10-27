// The light is rendered with WebGL 2: the video frame reaches the GPU as a texture without a CPU readback, and the
// glow with its blur is drawn at a fraction of the page size, so no CSS filter has to run over a page-sized layer on
// every frame (that made streams drop to a few fps on weaker GPUs)

// A tiny source frame is enough: the blur removes all detail
const FRAME_WIDTH = 32;
const FRAME_HEIGHT = 18;
// Skip the outermost frame pixels when extending edge colors: videos often have a dark border line
const EDGE_INSET = 1;

const VERTEX_SHADER = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

// The video downscaled through its mipmaps, so each frame pixel is the average of a whole block. Render targets keep
// row 0 at the top, like the video, and only the last pass flips the image into the canvas
const FRAME_SHADER = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform vec2 size;
out vec4 color;
void main() {
  color = vec4(texture(source, gl_FragCoord.xy / size).rgb, 1.0);
}`;

// Frame under the player, its edge colors stretched outwards, faded as (1 - d)^2.4 with d being the elliptical
// distance from the player edge. The color math matches the CSS filters saturate() brightness(1.3) contrast(0.85),
// which lift dark colors and leave bright ones almost untouched, so dim scenes still glow
const LIGHT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform vec4 inner;
uniform vec3 reach;
uniform vec2 edgeMin;
uniform vec2 edgeMax;
uniform float saturation;
out vec4 color;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec3 c = texture(source, clamp((p - inner.xy) / (inner.zw - inner.xy), edgeMin, edgeMax)).rgb;
  c = clamp(mix(vec3(dot(c, vec3(0.213, 0.715, 0.072))), c, saturation), 0.0, 1.0);
  c = clamp((min(c * 1.3, 1.0) - 0.5) * 0.85 + 0.5, 0.0, 1.0);
  float dx = max(max(inner.x - p.x, p.x - inner.z), 0.0) / reach.x;
  float dy = p.y < inner.y ? (inner.y - p.y) / reach.y : max(p.y - inner.w, 0.0) / reach.z;
  float alpha = pow(max(1.0 - length(vec2(dx, dy)), 0.0), 2.4);
  color = vec4(c * alpha, alpha);
}`;

// One direction of a separable gaussian blur over premultiplied colors
const BLUR_SHADER = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform vec2 size;
uniform vec2 direction;
uniform float sigma;
uniform float flip;
out vec4 color;
void main() {
  vec2 p = gl_FragCoord.xy;
  if (flip > 0.5) {
    p.y = size.y - p.y;
  }
  int radius = int(ceil(sigma * 3.0));
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -radius; i <= radius; i++) {
    float weight = exp(-0.5 * float(i * i) / (sigma * sigma));
    sum += texture(source, (p + direction * float(i)) / size) * weight;
    total += weight;
  }
  color = sum / total;
}`;

function createProgram(gl, fragmentSource) {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX_SHADER],
    [gl.FRAGMENT_SHADER, fragmentSource],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    gl.attachShader(program, shader);
  }
  gl.bindAttribLocation(program, 0, 'position');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }

  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const {name} = gl.getActiveUniform(program, i);
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return {program, uniforms};
}

function createTexture(gl, minFilter) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function createTarget(gl, width, height) {
  const texture = createTexture(gl, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  return {texture, framebuffer, width, height};
}

function deleteTarget(gl, target) {
  gl.deleteTexture(target.texture);
  gl.deleteFramebuffer(target.framebuffer);
}

// failIfMajorPerformanceCaveat alone is not enough: Chrome still hands out SwiftShader contexts with it, and Edge on
// Windows renders with WARP ("Microsoft Basic Render Driver") when hardware acceleration is turned off
const SOFTWARE_RENDERER_REGEX = /swiftshader|basic render|llvmpipe|softpipe|software/i;

// Null without WebGL 2 or with only a software implementation of it: the light would then slow the stream and other
// videos down
function getHardwareContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    failIfMajorPerformanceCaveat: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (gl == null) {
    return null;
  }

  const info = gl.getExtension('WEBGL_debug_renderer_info');
  if (SOFTWARE_RENDERER_REGEX.test(gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER))) {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  }
  return gl;
}

export default class LightRenderer {
  static isSupported() {
    const gl = getHardwareContext(document.createElement('canvas'));
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl != null;
  }

  // Null when not supported, see getHardwareContext
  static create(canvas) {
    const gl = getHardwareContext(canvas);
    if (gl == null) {
      return null;
    }

    try {
      return new LightRenderer(gl);
    } catch (error) {
      console.error('RTE: Ambilight renderer failed', error);
      return null;
    }
  }

  constructor(gl) {
    this.gl = gl;
    this.frameProgram = createProgram(gl, FRAME_SHADER);
    this.lightProgram = createProgram(gl, LIGHT_SHADER);
    this.blurProgram = createProgram(gl, BLUR_SHADER);
    this.videoTexture = createTexture(gl, gl.LINEAR_MIPMAP_LINEAR);
    this.frame = createTarget(gl, FRAME_WIDTH, FRAME_HEIGHT);
    this.light = null;
    this.blurred = null;

    // One triangle covering the whole target; the shaders work from gl_FragCoord
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  // Light size in canvas pixels
  resize(width, height) {
    const {gl} = this;
    gl.canvas.width = width;
    gl.canvas.height = height;
    if (this.light != null) {
      deleteTarget(gl, this.light);
      deleteTarget(gl, this.blurred);
    }
    this.light = createTarget(gl, width, height);
    this.blurred = createTarget(gl, width, height);
  }

  pass({program, uniforms}, source, target, values) {
    const {gl} = this;
    gl.useProgram(program);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    gl.viewport(0, 0, target?.width ?? gl.canvas.width, target?.height ?? gl.canvas.height);
    for (const [name, value] of Object.entries(values)) {
      const vector = typeof value === 'number' ? [value] : value;
      gl[`uniform${vector.length}fv`](uniforms[name], vector);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Without a video only the light is redrawn from the last frame, e.g. after a resize or a settings change while
  // the stream is paused. inner is the player box (left, top, right, bottom) and reach the falloff distance
  // (sideways, up, down), both in canvas pixels; one canvas pixel covers `scale` CSS pixels
  render(video, {inner, reach, scale}, {blur, saturation, smoothness}) {
    const {gl} = this;

    if (video != null) {
      gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.generateMipmap(gl.TEXTURE_2D);

      // Each frame is blended over the previous one so colors shift smoothly instead of flickering
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
      gl.blendColor(0, 0, 0, 1 - smoothness / 100);
      this.pass(this.frameProgram, this.videoTexture, this.frame, {size: [FRAME_WIDTH, FRAME_HEIGHT]});
      gl.disable(gl.BLEND);
    }

    this.pass(this.lightProgram, this.frame.texture, this.light, {
      inner,
      reach,
      edgeMin: [(EDGE_INSET + 0.5) / FRAME_WIDTH, (EDGE_INSET + 0.5) / FRAME_HEIGHT],
      edgeMax: [1 - (EDGE_INSET + 0.5) / FRAME_WIDTH, 1 - (EDGE_INSET + 0.5) / FRAME_HEIGHT],
      saturation: saturation / 100,
    });

    const size = [gl.canvas.width, gl.canvas.height];
    const sigma = Math.max(blur / scale, 0.5);
    this.pass(this.blurProgram, this.light.texture, this.blurred, {size, sigma, direction: [1, 0], flip: 0});
    this.pass(this.blurProgram, this.blurred.texture, null, {size, sigma, direction: [0, 1], flip: 1});
  }
}
