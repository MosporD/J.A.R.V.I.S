import * as THREE from 'three';
import { Component } from '../core/component.js';
import { store, MODE } from '../core/store.js';
import { bus } from '../core/bus.js';
import { palette } from '../core/theme.js';
import { telemetry } from '../core/telemetry.js';
import { prefersReducedMotion } from '../core/ticker.js';
import { approach, clamp } from '../core/format.js';

const TAU = Math.PI * 2;

/**
 * The reactor core in three dimensions.
 *
 * This is the flat core's drawing list, rebuilt as geometry: the same tick
 * ring, the same four unequal arc segments, the same dashed ring, brackets,
 * data arcs, orbiters and layered centre, at the same radii and in the same
 * order. The 2D renderer is the reference — if the two disagree about what the
 * instrument looks like, this file is the one that is wrong.
 *
 * Two techniques carry the look across:
 *
 * Glow is a wide translucent pass beneath a thin bright one, exactly as on the
 * canvas. In 2D that is cheaper than `shadowBlur`; here it is cheaper than a
 * post-processing bloom chain, and it is what stops the lines reading as bare
 * wireframe.
 *
 * Every material is `MeshBasicMaterial` with additive blending, no depth test,
 * and an explicit `renderOrder`. Additive light does not occlude, so depth
 * testing buys nothing and only introduces sorting artefacts; depth reads from
 * perspective and parallax instead. Instanced batches carry per-instance
 * brightness as a greyscale `instanceColor`, which the material colour
 * multiplies — so a mode change re-tints 120 ticks by writing one colour.
 */

/** Radii, as fractions of the outer radius — the 2D core's proportions. */
const R = 2.5;
const RADIUS = {
  tick: R * 1.0,
  segment: R * 0.92,
  dash: R * 0.85,
  bracket: R * 0.79,
  cpu: R * 0.7,
  mem: R * 0.62,
  orbit: R * 0.85,
  core: R * 0.42,
};

/**
 * Canvas pixels -> world units.
 *
 * Measured against the flat core at its real size: the panel is 26rem wide
 * less its padding, so the 2D renderer works with an outer radius near 190
 * CSS pixels. Every stroke width below is quoted in those pixels, which is
 * what keeps a 1px hairline here a 1px hairline there.
 */
const PX = R / 190;

/** Ripple stroke width, held constant as the ripple grows. */
const RIPPLE_TUBE = 1.5 * PX / 2;

/** The four arc segments: [start, length] in turns. The signature motion. */
const SEGMENTS = [
  [0.0, 0.42],
  [0.5, 0.16],
  [0.7, 0.1],
  [0.86, 0.08],
];

/**
 * Camera distance, chosen so the outer radius lands where the flat core's does.
 *
 * At a 38 degree vertical field of view the visible half-height at the origin
 * is `z * tan(19 deg)`. The 2D core draws to `min(w, h) / 2 - 6`, roughly 97%
 * of the half-height, so z is solved for that rather than picked by eye — a
 * camera set further back renders the same geometry smaller inside the same
 * panel, which is indistinguishable from a weaker instrument.
 */
const CAMERA_Z = R / 0.97 / Math.tan((38 / 2) * (Math.PI / 180));

/** Scratch maths, reused across frames — only one frame is ever in flight. */
const SCRATCH = {
  matrix: new THREE.Matrix4(),
  position: new THREE.Vector3(),
  scale: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  euler: new THREE.Euler(),
  color: new THREE.Color(),
};

const ORDER = {
  ambient: -20,
  motes: -10,
  ring: 0,
  data: 5,
  orbiter: 8,
  ripple: 10,
  bloom: 15,
  core: 20,
};

export class ArcCore3D extends Component {
  render() {
    this.canvas = this.$('canvas');
    this.reduced = prefersReducedMotion;
    this.spin = 0;
    this.counterSpin = 0;
    this.energy = 0.4;
    this.pulse = 0;
    this.tilt = { x: 0, y: 0 };
    this.target = { x: 0, y: 0 };
    this.ripples = [];
    this.mode = MODE.IDLE;
    this.lost = false;

    // Scratch colours, so a frame allocates nothing.
    this._key = new THREE.Color();
    this._accent = new THREE.Color();

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'low-power',
    });
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.camera.position.set(0, 0, CAMERA_Z);

    this.assembly = new THREE.Group();
    this.scene.add(this.assembly);

    this.buildAmbient();
    this.buildTickRing();
    this.buildSegments();
    this.buildDashedRing();
    this.buildBrackets();
    this.buildDataArcs();
    this.buildOrbiters();
    this.buildMotes();
    this.buildCore();

    // A lost context is not hypothetical on a laptop that sleeps or switches
    // GPUs. Fall back rather than leaving a black square where the core was.
    this.listen(this.canvas, 'webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
      bus.emit('log', {
        level: 'warn',
        tag: 'core',
        text: 'Reactor render context lost — falling back to the flat core.',
      });
      bus.emit('core:fallback');
    });

    this.listen(this.canvas, 'pointerdown', () => bus.emit('core:pulse', { strength: 1 }));
    this.listen(this.el, 'pointermove', (event) => {
      const box = this.el.getBoundingClientRect();
      this.target.y = ((event.clientX - box.left) / box.width - 0.5) * 0.5;
      this.target.x = ((event.clientY - box.top) / box.height - 0.5) * 0.4;
    });
    this.listen(this.el, 'pointerleave', () => { this.target.x = 0; this.target.y = 0; });

    this.watch('mode', (mode) => {
      this.mode = mode;
      this.ripples.push({ scale: 0.22 * R, life: 1 });
    });
    this.on('core:pulse', ({ strength = 1 }) => {
      this.pulse = Math.min(1, this.pulse + strength * 0.6);
      this.ripples.push({ scale: 0.18 * R, life: 1 });
    });

    const observer = new ResizeObserver(() => this.resize());
    observer.observe(this.el);
    this.track(() => observer.disconnect());
    this.resize();

    this.animate((dt, elapsed) => this.frame(dt, elapsed));
    this.track(() => this.dispose());
  }

  /** Register a geometry/material for disposal without a separate bookkeeping pass. */
  own(object) {
    (this._owned ||= []).push(object);
    return object;
  }

  /**
   * The one material shape used throughout: additive, unlit, unsorted.
   *
   * Front faces only. A torus or a sphere drawn `DoubleSide` rasterises its
   * far side as well, and additive blending adds both — so every closed shape
   * rendered at roughly twice its nominal brightness. On the bright passes
   * that pushed the result past what the framebuffer can hold, clipping the
   * saturated cyan towards white; the flat core's arcs are visibly more
   * saturated than the 3D ones were. Drawing one side costs half the
   * fragments and puts the colour back.
   *
   * Flat geometry — the bloom planes and the triangle's face — never had a
   * far side to draw, so their values are unchanged.
   */
  glowMaterial(opacity, color = 0xffffff) {
    return this.own(new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.FrontSide,
    }));
  }

  /**
   * An arc of tube around the origin, starting at `start` turns.
   *
   * `TorusGeometry`'s arc runs from zero, so the start angle is a rotation of
   * the mesh rather than a parameter — which also keeps the geometry static
   * when only the phase changes.
   */
  arcMesh(radius, tube, startTurns, lengthTurns, material, segments = 96) {
    const mesh = new THREE.Mesh(
      this.own(new THREE.TorusGeometry(radius, tube, 6, segments, lengthTurns * TAU)),
      material,
    );
    mesh.rotation.z = startTurns * TAU;
    return mesh;
  }

  /**
   * A batch of identical boxes placed around a circle, each with its own
   * brightness. Brightness rides on `instanceColor` as greyscale so the
   * material colour can re-tint the whole batch in one write per frame.
   */
  radialBatch(count, place, material) {
    const mesh = new THREE.InstancedMesh(
      this.own(new THREE.BoxGeometry(1, 1, 0.012)),
      material,
      count,
    );
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();
    const shade = new THREE.Color();

    for (let i = 0; i < count; i += 1) {
      const { angle, radius, length, thickness, intensity } = place(i);
      euler.set(0, 0, angle);
      quaternion.setFromEuler(euler);
      position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
      scale.set(length, thickness, 1);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, shade.setScalar(intensity));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    return mesh;
  }

  /** Soft radial bloom behind everything — the 2D core's `drawAmbient`. */
  buildAmbient() {
    this.ambient = new THREE.Mesh(
      this.own(new THREE.PlaneGeometry(R * 2.3, R * 2.3)),
      this.own(new THREE.MeshBasicMaterial({
        map: this.own(glowTexture(AMBIENT_STOPS)),
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      })),
    );
    this.ambient.position.z = -0.6;
    this.ambient.renderOrder = ORDER.ambient;
    this.scene.add(this.ambient);
  }

  /** 120 ticks, every tenth major — the calibrated edge of the instrument. */
  buildTickRing() {
    this.tickMaterial = this.glowMaterial(1);
    this.ticks = this.radialBatch(120, (i) => {
      const major = i % 10 === 0;
      const length = major ? 9 * PX : 4 * PX;
      return {
        angle: (i / 120) * TAU,
        radius: RADIUS.tick - length / 2,
        length,
        thickness: major ? 1.4 * PX : 1 * PX,
        intensity: major ? 0.9 : 0.3,
      };
    }, this.tickMaterial);
    this.ticks.renderOrder = ORDER.ring;
    this.assembly.add(this.ticks);
  }

  /**
   * The four unequal arc segments, each drawn twice: a wide dim pass for the
   * glow and a thin bright one for the line. They sit on slightly separated
   * planes with a slight lean, which is the whole of what 3D adds here — the
   * silhouette stays the one the flat core draws.
   */
  buildSegments() {
    this.segmentGlow = this.glowMaterial(0.13);
    this.segmentHalo = this.glowMaterial(0.18);
    this.segmentLine = this.glowMaterial(0.85);
    this.segments = [];

    SEGMENTS.forEach(([start, length], i) => {
      const group = new THREE.Group();
      group.add(this.arcMesh(RADIUS.segment, 7 * PX / 2, start, length, this.segmentGlow, 120));
      group.add(this.arcMesh(RADIUS.segment, 4 * PX / 2, start, length, this.segmentHalo, 120));
      group.add(this.arcMesh(RADIUS.segment, 1.6 * PX / 2, start, length, this.segmentLine, 120));
      // Just enough separation to parallax; any more and the four segments
      // stop reading as one broken ring the way they do on the canvas.
      group.position.z = (i - 1.5) * 0.03;
      group.rotation.x = (i - 1.5) * 0.03;
      group.renderOrder = ORDER.ring;
      this.assembly.add(group);
      this.segments.push(group);
    });
  }

  /** The counter-spinning dashed ring — `setLineDash([2, 9])`, as geometry. */
  buildDashedRing() {
    const count = 45;
    const circumference = TAU * RADIUS.dash;
    const dash = (2 / 11) * (circumference / count);
    this.dashMaterial = this.glowMaterial(0.7);
    this.dashes = this.radialBatch(count, (i) => ({
      angle: (i / count) * TAU,
      radius: RADIUS.dash,
      length: 1 * PX,
      thickness: dash,
      intensity: 1,
    }), this.dashMaterial);
    this.dashes.position.z = -0.05;
    this.dashes.renderOrder = ORDER.ring;
    this.assembly.add(this.dashes);
  }

  /** Four brackets that hold their angle against the spin, with end ticks. */
  buildBrackets() {
    this.bracketMaterial = this.glowMaterial(0.9);
    this.brackets = new THREE.Group();

    const half = 0.09;
    for (let i = 0; i < 4; i += 1) {
      const base = (i / 4) * TAU;
      this.brackets.add(this.arcMesh(
        RADIUS.bracket,
        1.4 * PX / 2,
        (base - half) / TAU,
        (half * 2) / TAU,
        this.bracketMaterial,
        16,
      ));
    }

    // A radial tick at each end of each bracket, reaching outward.
    const ends = [];
    for (let i = 0; i < 4; i += 1) {
      const base = (i / 4) * TAU;
      ends.push(base - half, base + half);
    }
    const length = 6 * PX;
    this.brackets.add(this.radialBatch(ends.length, (i) => ({
      angle: ends[i],
      radius: RADIUS.bracket + length / 2,
      length,
      thickness: 1.4 * PX,
      intensity: 1,
    }), this.bracketMaterial));

    this.brackets.rotation.z = Math.PI / 4;
    this.brackets.renderOrder = ORDER.ring;
    this.assembly.add(this.brackets);
  }

  /**
   * The two live metric arcs. Each is a dim full-span track, a wide glow and a
   * thin bright line over the filled portion, and a marker at the leading
   * edge — the flat core's `drawDataArc`, part for part.
   */
  buildDataArcs() {
    const specs = [
      { key: 'cpu', radius: RADIUS.cpu, start: -0.75 * Math.PI, z: 0.12 },
      { key: 'mem', radius: RADIUS.mem, start: 0.35 * Math.PI, z: -0.12 },
    ];
    this.dataArcs = specs.map(({ key, radius, start, z }) => {
      const group = new THREE.Group();
      group.rotation.z = start;
      group.position.z = z;
      group.renderOrder = ORDER.data;

      const track = this.glowMaterial(0.22);
      const glow = this.glowMaterial(0.32);
      const line = this.glowMaterial(0.95);

      group.add(this.arcMesh(radius, 3 * PX / 2, 0, 1.1 / 2, track, 96));

      const sweep = new THREE.Group();
      const glowMesh = this.arcMesh(radius, 8 * PX / 2, 0, 0.01, glow, 96);
      const lineMesh = this.arcMesh(radius, 2.4 * PX / 2, 0, 0.01, line, 96);
      sweep.add(glowMesh, lineMesh);
      group.add(sweep);

      const marker = new THREE.Mesh(
        this.own(new THREE.SphereGeometry(2.4 * PX, 12, 8)),
        line,
      );
      group.add(marker);

      this.assembly.add(group);
      return { key, radius, group, glowMesh, lineMesh, marker, track, glow, line, theta: -1 };
    });
  }

  /**
   * Three nodes with trailing tails. The flat core fakes inclined orbits by
   * squashing the ellipse; here they are actually inclined, which is the one
   * place the extra dimension buys something the canvas cannot do.
   *
   * All 18 tail nodes are a single batch — brightness per node rides on
   * `instanceColor`, so the fade ladder costs no extra draw calls.
   */
  buildOrbiters() {
    this.orbitMaterial = this.glowMaterial(1);
    this.orbiters = [0, 1, 2].map((i) => {
      const group = new THREE.Group();
      // The squash the 2D core applies becomes a real inclination.
      group.rotation.x = Math.acos(clamp(0.42 + i * 0.2, 0, 1));
      group.rotation.z = (i * Math.PI) / 3;
      group.renderOrder = ORDER.orbiter;
      this.assembly.add(group);

      const mesh = new THREE.InstancedMesh(
        this.own(new THREE.SphereGeometry(1, 8, 6)),
        this.orbitMaterial,
        6,
      );
      const shade = new THREE.Color();
      for (let tail = 0; tail < 6; tail += 1) {
        mesh.setColorAt(tail, shade.setScalar(1 - tail / 6));
      }
      mesh.instanceColor.needsUpdate = true;
      mesh.renderOrder = ORDER.orbiter;
      group.add(mesh);

      return { group, mesh, speed: 0.35 + i * 0.18, phase: (i * TAU) / 3 };
    });
  }

  /** Drifting motes, so the housing sits in a volume rather than a vacuum. */
  buildMotes() {
    const count = 260;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const r = 1.4 + Math.random() * 2.4;
      const theta = Math.random() * TAU;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
      positions[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * r;
      positions[i * 3 + 2] = Math.cos(phi) * r * 0.5;
    }
    const geo = this.own(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.motes = new THREE.Points(
      geo,
      this.own(new THREE.PointsMaterial({
        size: 0.028,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      })),
    );
    this.motes.renderOrder = ORDER.motes;
    this.assembly.add(this.motes);
  }

  /**
   * The centre: bloom, three containment rings, the counter-rotating reactor
   * triangle and a hot white heart. The flat core nests its rings as concentric
   * circles; three planes make the same nesting read as a housing from any
   * angle the assembly leans to.
   */
  buildCore() {
    const r = RADIUS.core;
    this.core = new THREE.Group();
    this.core.renderOrder = ORDER.core;
    this.assembly.add(this.core);

    this.bloom = new THREE.Mesh(
      this.own(new THREE.PlaneGeometry(r * 3.2, r * 3.2)),
      this.own(new THREE.MeshBasicMaterial({
        map: this.own(glowTexture()),
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      })),
    );
    this.bloom.renderOrder = ORDER.bloom;
    this.core.add(this.bloom);

    // Containment rings — the flat core's three concentric circles.
    //
    // An earlier pass turned each one onto its own axis to make the nesting
    // read as a cage. Edge-on to the camera a torus is a straight line, so
    // two of the three became strokes through the middle of the reactor.
    // They stay concentric; a few degrees of lean and a little separation in
    // depth is all that is needed to tell them apart in 3D.
    this.containment = [[1, 1.8, 1], [0.72, 1.2, 0.85], [0.45, 1, 0.6]]
      .map(([scale, width, opacity], i) => {
        const mesh = new THREE.Mesh(
          this.own(new THREE.TorusGeometry(r * scale, width * PX / 2, 6, 96)),
          this.glowMaterial(opacity, 0xeaffff),
        );
        mesh.position.z = i * 0.04;
        mesh.rotation.x = (i - 1) * 0.1;
        mesh.rotation.y = (i - 1) * 0.08;
        mesh.renderOrder = ORDER.core;
        this.core.add(mesh);
        return mesh;
      });

    // The reactor triangle: a filled face under a bright outline.
    this.triangle = new THREE.Group();
    this.triangleFill = this.glowMaterial(0.25);
    this.triangle.add(new THREE.Mesh(
      this.own(new THREE.CircleGeometry(r * 0.58, 3)),
      this.triangleFill,
    ));
    this.triangle.add(new THREE.Mesh(
      this.own(new THREE.TorusGeometry(r * 0.58, 1.4 * PX / 2, 6, 3)),
      this.glowMaterial(0.75),
    ));
    this.triangle.rotation.z = Math.PI / 2;
    this.triangle.position.z = 0.02;
    this.triangle.renderOrder = ORDER.core;
    this.core.add(this.triangle);

    this.heart = new THREE.Mesh(
      this.own(new THREE.SphereGeometry(r * 0.16, 24, 16)),
      this.glowMaterial(0.85),
    );
    this.heart.renderOrder = ORDER.core;
    this.core.add(this.heart);
  }

  resize() {
    const box = this.el.getBoundingClientRect();
    const w = Math.max(1, Math.round(box.width));
    const h = Math.max(1, Math.round(box.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === this._w && h === this._h && dpr === this._dpr) return;
    this._w = w;
    this._h = h;
    this._dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the instrument framed the way the flat core is, whatever the aspect.
    // Moving the camera does not touch the projection, so the matrix is
    // rebuilt once, after both have been set.
    this.camera.position.z = w < h ? CAMERA_Z / this.camera.aspect : CAMERA_Z;
    this.camera.updateProjectionMatrix();
  }

  /** Hue and rotation rate for the current state — the 2D core's rules, in 3D. */
  get scheme() {
    if (store.get('threat') === 'critical') return { key: palette.alert, speed: 2.4 };
    switch (this.mode) {
      case MODE.LISTENING: return { key: palette.hud, speed: 1.1 };
      case MODE.PROCESSING: return { key: palette.arc, speed: 3.1 };
      case MODE.SPEAKING: return { key: palette.hud, speed: 1.6 };
      default: return { key: palette.hud, speed: 0.55 };
    }
  }

  frame(dt, elapsed) {
    if (this.lost) return;
    const { scheme } = this;
    const amplitude = store.get('amplitude');

    this.energy = approach(
      this.energy,
      clamp(0.32 + amplitude * 0.85 + (this.mode === MODE.PROCESSING ? 0.35 : 0), 0, 1.4),
      dt,
      8,
    );
    this.pulse = approach(this.pulse, amplitude * 0.7, dt, 4);

    const rate = this.reduced ? 0.15 : 1;
    this.spin += dt * scheme.speed * 0.32 * rate;
    this.counterSpin -= dt * scheme.speed * 0.19 * rate;

    const key = this._key.set(scheme.key);
    const accent = this._accent.set(palette.arc);

    this.paintRings(key);
    this.paintData(key, accent);
    this.paintOrbiters(elapsed, key);
    this.paintCore(elapsed, amplitude, key);

    // Lean towards the pointer.
    this.tilt.x = approach(this.tilt.x, this.target.x, dt, 4);
    this.tilt.y = approach(this.tilt.y, this.target.y, dt, 4);
    this.assembly.rotation.x = this.tilt.x;
    this.assembly.rotation.y = this.tilt.y;

    this.motes.rotation.z += dt * 0.06 * rate;
    this.motes.material.color.copy(key);
    this.motes.material.opacity = 0.35 + this.energy * 0.3;

    this.ambient.material.color.copy(key);
    this.ambient.material.opacity = 0.16 + this.energy * 0.16;

    this.stepRipples(dt, key);
    this.renderer.render(this.scene, this.camera);
  }

  paintRings(key) {
    this.ticks.rotation.z = this.spin * 0.25;
    this.tickMaterial.color.copy(key);

    for (const group of this.segments) group.rotation.z = this.spin;
    this.segmentGlow.color.copy(key);
    this.segmentGlow.opacity = 0.09 + this.energy * 0.07;
    this.segmentHalo.color.copy(key);
    this.segmentHalo.opacity = 0.13 + this.energy * 0.09;
    this.segmentLine.color.copy(key);

    this.dashes.rotation.z = this.counterSpin;
    this.dashMaterial.color.copy(key);

    this.brackets.rotation.z = this.counterSpin * 0.6 + Math.PI / 4;
    this.bracketMaterial.color.copy(key);
  }

  paintData(key, accent) {
    const values = {
      cpu: (telemetry.get('cpu')?.value ?? 40) / 100,
      mem: (telemetry.get('mem')?.value ?? 55) / 100,
    };
    this.dataArcs.forEach((arc, i) => {
      const color = i ? accent : key;
      arc.track.color.copy(color);
      arc.glow.color.copy(color);
      arc.line.color.copy(color);

      const turns = clamp(values[arc.key], 0, 1) * 1.1 / 2;
      arc.marker.position.set(
        Math.cos(turns * TAU) * arc.radius,
        Math.sin(turns * TAU) * arc.radius,
        0,
      );
      this.sweep(arc, turns);
    });
  }

  /**
   * Rewrite an arc's swept length. Rebuilding the geometry is cheaper than it
   * looks at this segment count, but only worth doing when the value has
   * actually moved — telemetry updates far more slowly than the frame rate.
   */
  sweep(arc, turns) {
    if (Math.abs(arc.theta - turns) < 0.002) return;
    arc.theta = turns;
    const span = Math.max(turns, 0.004) * TAU;
    for (const [mesh, tube] of [[arc.glowMesh, 8 * PX / 2], [arc.lineMesh, 2.4 * PX / 2]]) {
      mesh.geometry.dispose();
      mesh.geometry = new THREE.TorusGeometry(arc.radius, tube, 6, 96, span);
    }
  }

  paintOrbiters(elapsed, key) {
    this.orbitMaterial.color.copy(key);
    const { matrix, position, scale, quaternion } = SCRATCH;

    for (const orbiter of this.orbiters) {
      orbiter.group.rotation.z = orbiter.phase + this.counterSpin * 0.3;
      const angle = elapsed * orbiter.speed;
      for (let tail = 0; tail < 6; tail += 1) {
        const a = angle - tail * 0.05;
        const size = (2.6 - tail * 0.32) * PX;
        position.set(Math.cos(a) * RADIUS.orbit, Math.sin(a) * RADIUS.orbit, 0);
        scale.setScalar(size);
        matrix.compose(position, quaternion, scale);
        orbiter.mesh.setMatrixAt(tail, matrix);
      }
      orbiter.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  paintCore(elapsed, amplitude, key) {
    const swell = 1 + this.pulse * 0.16 + Math.sin(elapsed * 1.6) * 0.012;
    this.core.scale.setScalar(swell);

    for (const ring of this.containment) ring.rotation.z = this.spin * 0.15;

    this.triangle.rotation.z = -this.spin * 0.7 + Math.PI / 2;
    this.triangleFill.color.copy(key);
    this.triangleFill.opacity = 0.25 + amplitude * 0.3;

    this.heart.scale.setScalar(1 + amplitude * 0.5);
    this.heart.material.opacity = 0.85;

    this.bloom.material.color.copy(key);
    this.bloom.material.opacity = 0.3 + this.energy * 0.35 + this.pulse * 0.25;
  }

  stepRipples(dt, key) {
    this._ripplePool ||= [];
    for (const ripple of this.ripples) {
      ripple.scale += dt * 0.55 * R;
      ripple.life -= dt * 1.15;
    }
    this.ripples = this.ripples.filter((r) => r.life > 0).slice(-6);

    while (this._ripplePool.length < this.ripples.length) {
      const mesh = new THREE.Mesh(
        this.own(new THREE.TorusGeometry(1, RIPPLE_TUBE, 4, 64)),
        this.glowMaterial(0.75),
      );
      mesh.renderOrder = ORDER.ripple;
      mesh.userData.radius = 1;
      this.assembly.add(mesh);
      this._ripplePool.push(mesh);
    }
    this._ripplePool.forEach((mesh, i) => {
      const ripple = this.ripples[i];
      mesh.visible = Boolean(ripple);
      if (!ripple) return;
      // Grow the geometry rather than the mesh: scaling a torus scales its
      // tube too, which would thicken the stroke as the ripple expands. The
      // radius moves every frame, so only rebuild once it has moved enough
      // to see.
      if (Math.abs(mesh.userData.radius - ripple.scale) / ripple.scale > 0.02) {
        mesh.userData.radius = ripple.scale;
        mesh.geometry.dispose();
        mesh.geometry = new THREE.TorusGeometry(ripple.scale, RIPPLE_TUBE, 4, 64);
      }
      mesh.material.opacity = ripple.life * 0.75;
      mesh.material.color.copy(key);
    });
  }

  /**
   * Walk the scene rather than trusting the ownership list alone: `sweep()`
   * replaces an arc's geometry as telemetry moves, so the geometry that is
   * live at teardown is generally not the one that was registered at build
   * time. `InstancedMesh` needs its own `dispose()` for the instance buffers.
   */
  dispose() {
    this.scene?.traverse((object) => {
      object.geometry?.dispose?.();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        material?.map?.dispose?.();
        material?.dispose?.();
      }
      if (object.isInstancedMesh) object.dispose();
    });
    (this._owned || []).forEach((object) => object.dispose?.());
    this._owned = [];
    // `dispose()` frees the renderer's own resources but leaves the context
    // alive. The core is swapped out and back on a context loss, and a page
    // may only hold so many contexts before the oldest is killed.
    this.renderer?.forceContextLoss?.();
    this.renderer?.dispose();
  }
}

/**
 * A radial falloff, generated rather than shipped as an image.
 *
 * The stops are the flat core's own gradients, normalised to 1 — the material
 * opacity supplies the overall strength. Guessing a curve here is what made an
 * earlier pass read as a hot spot in a dark box rather than a lit instrument.
 */
const AMBIENT_STOPS = [[0, 1], [0.45, 0.31], [1, 0]];
const BLOOM_STOPS = [[0, 1], [0.28, 0.9], [0.6, 0.2], [1, 0]];

function glowTexture(stops = BLOOM_STOPS, size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [offset, a] of stops) gradient.addColorStop(offset, `rgba(255,255,255,${a})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
