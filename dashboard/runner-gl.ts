/**
 * Draws the runners page's balls with WebGL: every ball in one draw call, a
 * square of two triangles for each, which its fragment shader cuts to a
 * circle with a smooth edge, and, for a ball in a heap, to the rounded box of
 * its pool, so that a board of thousands of balls takes a fraction of a
 * frame. Where WebGL 2 is not available, or cannot be set up, it draws the
 * same balls with a 2D context, a path for each color.
 *
 * Everything here runs in the browser, handed to it by name by
 * runners-page.ts, so the class uses only its own members.
 */

/** A rounded box a ball is clipped to, in pixels on the canvas. */
export interface Clip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

/**
 * Draws circles on a canvas: `add()` each, then `draw()` them all, which
 * clears what was drawn before. A WebGL context lost while the page is open
 * is set up again when the browser restores it.
 */
export class BallRenderer {
  #canvas: HTMLCanvasElement;
  #gl: WebGL2RenderingContext | null = null;
  #program: WebGLProgram | null = null;
  #buffer: WebGLBuffer | null = null;
  #viewport: WebGLUniformLocation | null = null;
  #scale: WebGLUniformLocation | null = null;
  #data = new Float32Array(12 * 256);
  #count = 0;
  #colors = new Map<string, readonly [number, number, number]>();
  #fallback: { x: number; y: number; r: number; color: string; clip: Clip | null }[] = [];

  /** Constructs an instance that draws on `canvas`. */
  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (gl === null) return;
    if (!gl.isContextLost()) {
      try {
        this.#prepare(gl);
      } catch (error) {
        // WebGL that cannot draw, as when a driver refuses the shaders, gives
        // way to the 2D context, on a canvas of its own, since a canvas
        // keeps the context it first gave.
        console.error("runners page: drawing with WebGL failed:", error);
        const fresh = document.createElement("canvas");
        for (const { name, value } of canvas.attributes) fresh.setAttribute(name, value);
        canvas.replaceWith(fresh);
        this.#canvas = fresh;
        return;
      }
    }
    this.#gl = gl;
    // A context the browser takes away, as after the GPU resets, is asked
    // back, and set up again once it is restored.
    canvas.addEventListener("webglcontextlost", (event) => event.preventDefault());
    canvas.addEventListener("webglcontextrestored", () => this.#prepare(gl));
  }

  /** Whether it draws with WebGL. */
  get accelerated(): boolean {
    return this.#gl !== null;
  }

  /**
   * Adds a circle centered at `x`, `y` on the canvas with radius `r`, in
   * `color`, as `#rrggbb`, cut to `clip` when given.
   */
  add(x: number, y: number, r: number, color: string, clip: Clip | null): void {
    if (this.#gl === null) {
      this.#fallback.push({ x, y, r, color, clip });
      return;
    }
    if ((this.#count + 1) * 12 > this.#data.length) {
      const grown = new Float32Array(this.#data.length * 2);
      grown.set(this.#data);
      this.#data = grown;
    }
    let rgb = this.#colors.get(color);
    if (rgb === undefined) {
      const value = parseInt(color.slice(1), 16);
      rgb = [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
      this.#colors.set(color, rgb);
    }
    const data = this.#data;
    const at = this.#count * 12;
    data[at] = x;
    data[at + 1] = y;
    data[at + 2] = r;
    data[at + 3] = rgb[0];
    data[at + 4] = rgb[1];
    data[at + 5] = rgb[2];
    data[at + 6] = clip ? clip.x : -1e6;
    data[at + 7] = clip ? clip.y : -1e6;
    data[at + 8] = clip ? clip.x + clip.width : 1e6;
    data[at + 9] = clip ? clip.y + clip.height : 1e6;
    data[at + 10] = clip ? clip.radius : 0;
    data[at + 11] = 0;
    this.#count++;
  }

  /**
   * Clears the canvas, sized to `width` by `height` pixels at `scale` device
   * pixels a pixel, and draws every circle added since the last call.
   */
  draw(width: number, height: number, scale: number): void {
    const canvas = this.#canvas;
    const pixelsWide = Math.round(width * scale);
    const pixelsHigh = Math.round(height * scale);
    if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
      canvas.width = pixelsWide;
      canvas.height = pixelsHigh;
    }
    const gl = this.#gl;
    if (gl === null) {
      this.#drawFallback(width, height, scale);
      return;
    }
    gl.viewport(0, 0, pixelsWide, pixelsHigh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.#count > 0 && this.#program !== null) {
      gl.useProgram(this.#program);
      gl.uniform2f(this.#viewport, width, height);
      gl.uniform1f(this.#scale, scale);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.#data.subarray(0, this.#count * 12), gl.STREAM_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.#count);
    }
    this.#count = 0;
  }

  /** Helper for `draw()`, which draws the circles with the 2D context. */
  #drawFallback(width: number, height: number, scale: number): void {
    const context = this.#canvas.getContext("2d")!;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    const groups = new Map<Clip | null, Map<string, Path2D>>();
    for (const ball of this.#fallback) {
      let colors = groups.get(ball.clip);
      if (colors === undefined) {
        colors = new Map();
        groups.set(ball.clip, colors);
      }
      let path = colors.get(ball.color);
      if (path === undefined) {
        path = new Path2D();
        colors.set(ball.color, path);
      }
      path.moveTo(ball.x + ball.r, ball.y);
      path.arc(ball.x, ball.y, ball.r, 0, 2 * Math.PI);
    }
    for (const [clip, colors] of groups) {
      context.save();
      if (clip) {
        context.beginPath();
        context.roundRect(clip.x, clip.y, clip.width, clip.height, clip.radius);
        context.clip();
      }
      for (const [color, path] of colors) {
        context.fillStyle = color;
        context.fill(path);
      }
      context.restore();
    }
    this.#fallback = [];
  }

  /**
   * Helper for the constructor, which compiles the shaders and describes
   * each circle's twelve numbers to them: where its center is, its radius,
   * its color, and its clip's edges and corner radius.
   */
  #prepare(gl: WebGL2RenderingContext): void {
    const vertex = `#version 300 es
      layout(location = 0) in vec3 circle;
      layout(location = 1) in vec3 color;
      layout(location = 2) in vec4 clipEdges;
      layout(location = 3) in vec2 clipRadius;
      uniform vec2 viewport;
      uniform float scale;
      out vec2 local;
      out vec2 page;
      out float radius;
      out vec3 tint;
      out vec4 edges;
      out float corner;
      void main() {
        vec2 corners[4] = vec2[](vec2(-1, -1), vec2(1, -1), vec2(-1, 1), vec2(1, 1));
        vec2 offset = corners[gl_VertexID] * (circle.z + 1.0 / scale);
        page = circle.xy + offset;
        local = offset;
        radius = circle.z;
        tint = color;
        edges = clipEdges;
        corner = clipRadius.x;
        gl_Position = vec4(page / viewport * vec2(2, -2) + vec2(-1, 1), 0, 1);
      }`;
    const fragment = `#version 300 es
      precision highp float;
      uniform float scale;
      in vec2 local;
      in vec2 page;
      in float radius;
      in vec3 tint;
      in vec4 edges;
      in float corner;
      out vec4 result;
      void main() {
        float inside = clamp((radius - length(local)) * scale + 0.5, 0.0, 1.0);
        vec2 middle = (edges.xy + edges.zw) * 0.5;
        vec2 extent = (edges.zw - edges.xy) * 0.5 - vec2(corner);
        vec2 beyond = abs(page - middle) - extent;
        float outside = length(max(beyond, 0.0)) + min(max(beyond.x, beyond.y), 0.0) - corner;
        float clipped = clamp(0.5 - outside * scale, 0.0, 1.0);
        float alpha = inside * clipped;
        if (alpha <= 0.0) discard;
        result = vec4(tint * alpha, alpha);
      }`;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`a runner board shader did not compile: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`the runner board's shaders did not link: ${gl.getProgramInfoLog(program)}`);
    }
    this.#program = program;
    this.#viewport = gl.getUniformLocation(program, "viewport");
    this.#scale = gl.getUniformLocation(program, "scale");
    this.#buffer = gl.createBuffer();
    const vertexArray = gl.createVertexArray();
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    const stride = 12 * 4;
    const attribute = (location: number, size: number, offset: number) => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * 4);
      gl.vertexAttribDivisor(location, 1);
    };
    attribute(0, 3, 0);
    attribute(1, 3, 3);
    attribute(2, 4, 6);
    attribute(3, 2, 10);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
}
